import { projectMailboxMail } from "../../shared/mail-projection";
import { INBOX_FIRST_PAGE_LIMIT, INBOX_PAGE_LIMIT, INBOX_AUTO_PREFETCH_LIMIT, INBOX_WINDOW_LIMIT, INBOX_WINDOW_BYTE_LIMIT, INBOX_LOOKUP_LIMIT,
  type InboxWindowPage, type InboxWindowRow, type InboxWindowState, type InboxTotals, type InboxViewQuery, type InboxSelection, type InboxActionReceiptReference, type InboxSenderInput } from "../../shared/inbox-window";
import { createInboxWindowTransport } from "./host";
import { ApiError, createInboxClient, type InboxClient } from "inbox-sdk/client";
import { measurePerformance, measureRequest, measureWork } from "./browser-logs";
import type {
  Account, BlobInfo, ChangeEvent, Changes, Draft as SdkDraft, DraftInput, Folder, Label,
  Mailbox, MailboxMembership, MailboxMessageSummary, MailboxStateTarget, Message as SdkMessage, MutationInput, Operation, Participant, Policy,
} from "inbox-sdk/types";
import type { Attachment, Draft, LoadSendingIdentities, Mail, MailboxOption, Message } from "./data";
import { escapeHTML, plainText } from "./mail-text";
import { getApplicationStorage } from "./storage";
import { createScopedFetch } from "./application-auth";
import { getApplicationScope } from "./application-scope";
import { matchesSearch } from "./mail-search";
import { readHostConfiguration, readInboxViewPreferences, writeInboxViewPreferences, createAiTriageClient, type HostConfiguration, type InboxViewPreferences, createCategoryTransport, CategoryRequestError } from "./host";
import { readSplitPreferences, writeSplitPreferences, readAttentionFeedback, recordAttentionFeedback, retractAttentionFeedback, InboxViewPreferencesError,
  type SavedSplitPreferences, type AttentionFeedback, type AttentionFeedbackTarget } from "./host";
import { UNIFIED_ACCOUNT, unifiedMail, unifiedThreadId, currentAiDecision, currentCategoryOverride } from "./mail-model";
import type { SenderHistoryMessage } from "./sender-context";
import { classifyAttention, conversationAttention } from "../../shared/mail-attention";
import { normalizeSplits, type SplitPreferences } from "../../shared/splits";
import type { AiTriageActions, AiTriageState, AiDecision, AiDecisionPage } from "../../shared/ai-triage";

import { CATEGORY_BATCH_LIMIT, CATEGORY_MEMBERSHIP_LIMIT, CATEGORY_BODY_LIMIT, categoryKey, categoryErrorMessages, isCategoryContext, isCategoryCommand, type AttentionCategory, type CategoryContext, type CategoryEntry, type CategoryCommand, type CategoryReceipt, type CategoryErrorCode } from "../../shared/attention-overrides";

type Edit = { draft: Draft; revision: number; version: number; error?: string; errorKind?: "recipients" };
class DraftRecipientError extends Error {}
type SendReference = { id: string; draftId: string; accountId: string; mailboxId: string };
type Sending = { ref: SendReference; operation: Operation; draft: SdkDraft };
type Flag = "isRead" | "isStarred";
type FlagTarget = { sourceId: string; mailboxId: string; messageId: string; threadId: string; revision: number; before: boolean };
type FlagIntent = { sequence: number; field: Flag; value: boolean; target: FlagTarget; write: FlagWrite; retired?: boolean };
type FlagWrite = {
  action: string; field: Flag; value: boolean; targets: FlagTarget[]; intents: FlagIntent[];
  input?: MutationInput; operation?: Operation; accepted?: number; terminal?: number;
  promise?: Promise<void>; reported?: boolean;
};
/** Already shown by the store; callers must not add a second toast. */
export class InboxActionError extends Error {}
export class InboxClassificationError extends InboxActionError {
  constructor(readonly code: CategoryErrorCode, readonly completed: number, readonly remaining: number,
    readonly retry?: () => Promise<() => Promise<void>>, readonly undoCompleted?: () => Promise<void>) {
    super(categoryErrorMessages[code]);
    this.name = "InboxClassificationError";
  }
}
/** A coalesced background problem. Repeats of the same key update one issue instead of adding another notice. */
export type InboxIssue = {
  key: string;
  scope: "snapshot" | "live" | "thread" | "action" | "draft" | "storage";
  code: string;
  title: string;
  detail?: string;
  /** Whether the generic Retry (refresh and reconnect, never a resend) applies. */
  retry: boolean;
  count: number;
  since: number;
  updatedAt: number;
  dismissed: boolean;
};
type RecoveryStatus = "prepared" | "uncertain" | "accepted" | "rejected" | "retracted";
type RecoveryScope = { version: 1; owner: string | null; sources: Array<{ sourceId: string; generation: number; mailboxIds: string[] }> };
/** Frozen command data only. No projected mail, content, addresses or drafts. */
export type InboxCommandRecovery = RecoveryScope & (
  | { kind: "category"; groups: Array<{ input: CategoryCommand; status: RecoveryStatus }> }
  | { kind: "attention-feedback"; input: { id: string; targets: AttentionFeedbackTarget[] }; status: RecoveryStatus; undoStatus?: RecoveryStatus }
  | { kind: "mailbox-state"; input: Parameters<InboxClient["setMailboxStates"]>[0]; status: RecoveryStatus;
      before: MailboxMembership[]; accepted: MailboxMembership[]; undoStatus?: RecoveryStatus }
);
export type InboxRecoverySink = (plan: InboxCommandRecovery) => void;
export type InboxUndo = (() => Promise<void>) & { receipts?: InboxActionReceiptReference[]; inverseReceipts?: InboxActionReceiptReference[]; recovery?: InboxCommandRecovery };
class InboxRecoveryStorageError extends InboxActionError {}
export class InboxRecoveryRejected extends InboxActionError {}
const recoveryBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
/** Strict field validation also prevents accidentally persisting a Mail graph. */
export function validInboxCommandRecovery(value: unknown): value is InboxCommandRecovery {
  const object = (v: any, keys: string[]) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).every(key => keys.includes(key));
  const id = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 1024;
  const revision = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 1;
  const status = (v: unknown) => ["prepared", "uncertain", "accepted", "rejected", "retracted"].includes(v as string);
  const target = (v: any) => object(v, ["mailboxId", "messageId", "revision"]) && id(v.mailboxId) && id(v.messageId) && revision(v.revision);
  const state = (v: any) => object(v, ["mailboxId", "messageId", "revision", "done", "snoozedUntil"]) && id(v.mailboxId) && id(v.messageId) && revision(v.revision) && typeof v.done === "boolean" && (v.snoozedUntil === null || typeof v.snoozedUntil === "string" && v.snoozedUntil.length <= 100 && Number.isFinite(Date.parse(v.snoozedUntil)));
  const p = value as InboxCommandRecovery;
  if (!object(p, ["version", "owner", "sources", "kind", "groups", "input", "status", "before", "accepted", "undoStatus"]) || p.version !== 1 || !(p.owner === null || typeof p.owner === "string" && /^[a-f0-9]{64}$/.test(p.owner)) || !Array.isArray(p.sources) || !p.sources.length || p.sources.length > 500 || !p.sources.every(s => object(s, ["sourceId", "generation", "mailboxIds"]) && id(s.sourceId) && revision(s.generation) && Array.isArray(s.mailboxIds) && s.mailboxIds.length > 0 && s.mailboxIds.length <= 500 && s.mailboxIds.every(id)) || recoveryBytes(p) > 768 * 1024) return false;
  if (p.kind === "category") return object(p, ["version", "owner", "sources", "kind", "groups"]) && Array.isArray(p.groups) && p.groups.length > 0 && p.groups.length <= 100 && p.groups.every(g => object(g, ["input", "status"]) && status(g.status) && isCategoryCommand(g.input) && recoveryBytes(g.input) <= CATEGORY_BODY_LIMIT && g.input.targets.every(t => p.sources.some(s => s.sourceId === t.context.sourceId && s.generation === t.context.sourceGeneration && t.context.mailboxIds.every(id => s.mailboxIds.includes(id)))));
  if (p.kind === "attention-feedback") return object(p, ["version", "owner", "sources", "kind", "input", "status", "undoStatus"]) && object(p.input, ["id", "targets"]) && /^[a-zA-Z0-9-]{16,80}$/.test(p.input.id) && status(p.status) && (p.undoStatus === undefined || status(p.undoStatus)) && Array.isArray(p.input.targets) && p.input.targets.length > 0 && p.input.targets.length <= 500 && recoveryBytes(p.input) <= 64 * 1024 && p.input.targets.every(t => object(t, ["sourceId", "mailboxId", "messageId", "revision", "messageRevision"]) && id(t.sourceId) && id(t.mailboxId) && id(t.messageId) && revision(t.revision) && revision(t.messageRevision) && p.sources.some(s => s.sourceId === t.sourceId && s.mailboxIds.includes(t.mailboxId)));
  if (p.kind !== "mailbox-state" || !object(p, ["version", "owner", "sources", "kind", "input", "status", "before", "accepted", "undoStatus"]) || !object(p.input, ["id", "targets", "done", "snoozedUntil"]) || !id(p.input.id) || !status(p.status) || p.undoStatus !== undefined && !status(p.undoStatus) || !Array.isArray(p.input.targets) || !p.input.targets.length || p.input.targets.length > 500 || !p.input.targets.every(t => target(t) && p.sources.some(s => s.mailboxIds.includes(t.mailboxId))) || recoveryBytes(p.input) > 64 * 1024 || p.input.done === undefined && p.input.snoozedUntil === undefined || p.input.done !== undefined && typeof p.input.done !== "boolean" || p.input.snoozedUntil !== undefined && p.input.snoozedUntil !== null && !(typeof p.input.snoozedUntil === "string" && p.input.snoozedUntil.length <= 100 && Number.isFinite(Date.parse(p.input.snoozedUntil)))) return false;
  return [p.before, p.accepted].every(states => Array.isArray(states) && states.length <= 500 && states.every(s => state(s) && p.input.targets.some(t => t.mailboxId === s.mailboxId && t.messageId === s.messageId)));
}
export type InboxActiveWindow = {
  query: InboxViewQuery; state: InboxWindowState; keys: string[]; totals: InboxTotals;
  nextCursor: string | null; exhausted: boolean; paging: boolean; residentBytes: number; hasNewer: boolean;
};
export type InboxSnapshot = {
  window: InboxActiveWindow | null;
  accounts: MailboxOption[];
  mailboxes: Mailbox[];
  sources: Account[];
  viewPreferences: InboxViewPreferences | null;
  splitPreferences: SavedSplitPreferences | null;
  attentionFeedback: AttentionFeedback[];
  mail: Mail[];
  senderHistory: SenderHistoryMessage[];
  drafts: Draft[];
  labels: Record<string, string[]>;
  loading: boolean;
  /** A snapshot has loaded at least once; later failures keep the cached mail. */
  loaded: boolean;
  refreshing: boolean;
  pending: number;
  unsaved: boolean;
  /** The latest snapshot (connect/refresh) failure, or null once a refresh succeeds. */
  error: string | null;
  issues: InboxIssue[];
  live: "connecting" | "live" | "polling";
  policy: Policy | null;
  host: HostConfiguration | null;
  ai: AiTriageState | null;
  aiError: string | null;
  operations: Readonly<Record<string, Operation>>;
};

const initial: InboxSnapshot = { window: null, accounts: [], mailboxes: [], sources: [], viewPreferences: null, splitPreferences: null, attentionFeedback: [], mail: [], senderHistory: [], drafts: [], labels: {}, loading: true, loaded: false, refreshing: false, pending: 0, unsaved: false, error: null, issues: [], live: "connecting", policy: null, host: null, ai: null, aiError: null, operations: {} };
const MAX_ISSUES = 4;
/** A problem stays visible until its recovery has held this long, so ready/error flapping never re-announces. */
const RESOLVE_HOLD_MS = 10_000;
/** A dismissed problem that recurs within this window starts hidden instead of reopening. */
const DISMISSAL_MEMORY_MS = 5 * 60_000;
/** Change-history polling cadence while the event stream is unavailable. */
const POLL_MS = 30_000;
const MAX_BACKOFF_MS = 60_000;
const nativeKey = (sourceId: string, messageId: string) => `${sourceId}\0${messageId}`;
const membershipKey = (sourceId: string, state: Pick<MailboxMembership, "messageId" | "mailboxId">) => `${nativeKey(sourceId, state.messageId)}\0${state.mailboxId}`;
const flagKey = (target: FlagTarget, field: Flag) => `${nativeKey(target.sourceId, target.messageId)}\0${field}`;
const definitive = (error: unknown) => error instanceof ApiError && error.status >= 400 && error.status < 500 && ![408, 425, 429].includes(error.status);
/** A stream counts as healthy only after staying open this long; ready/close flapping neither refreshes nor recovers. */
const STREAM_HEALTHY_MS = 5000;
const recoveryKey = "sdk-draft-recovery";
const outboxKey = "sdk-outbox-references";
const formatAddress = (person: Participant) => person.name && person.name !== person.email
  ? `${person.name.includes(",") ? JSON.stringify(person.name) : person.name} <${person.email}>` : person.email;
const addresses = (people: Participant[]) => people.map(formatAddress).join(", ");
const recipients = (value: string): Participant[] => (value.match(/(?:"[^"]*"|[^,;\n])+/g) ?? []).map(value => {
  const match = value.trim().match(/^(.*?)\s*<([^>]+)>$/);
  const email = (match?.[2] ?? value).trim();
  return { name: match?.[1]?.trim().replace(/^"|"$/g, "") || email, email };
}).filter(person => person.email);
const completeRecipients = (draft: Draft) => [draft.to, draft.cc, draft.bcc].every(value => recipients(value).every(person => /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(person.email)));
const contentKey = (draft: Draft) => JSON.stringify([draft.account, draft.from, draft.mode, draft.to, draft.cc, draft.bcc, draft.subject, draft.body, draft.attachments]);
const viewThreadId = (box: string, thread: string) => `${box}:${thread}`;
const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const abort = () => { clearTimeout(timer); reject(new DOMException("Request cancelled", "AbortError")); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
  if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
});
const failureCode = (error: unknown) => error instanceof ApiError ? error.code : error instanceof TypeError ? "NETWORK" : "ERROR";
// API problems carry only the server's generic wording; a fetch TypeError would leak browser phrasing.
const failureMessage = (error: unknown) => error instanceof ApiError ? error.message : error instanceof Error && !(error instanceof TypeError) ? error.message : "The inbox could not be reached.";
const retryAfter = (error: unknown) => {
  const hint = error instanceof ApiError ? error.retryAfterMs : undefined;
  return typeof hint === "number" && Number.isFinite(hint) && hint > 0 ? Math.min(hint, 2147483647) : 0;
};
const liveDetail = (code: string) => code === "STREAM_LIMIT"
  ? "Too many open connections. Checking for new mail every 30 seconds."
  : code === "UNAUTHENTICATED" ? "Sign in through the host application to resume live updates."
  : "Reconnecting automatically. Checking for new mail every 30 seconds.";

// Message reads are sanitized by the SDK. Drafts are editable input, so constrain their HTML separately.
function draftHtml(value: string): string {
  const template = document.createElement("template");
  template.innerHTML = value;
  const allowed = new Set(["P", "DIV", "BR", "SPAN", "STRONG", "B", "EM", "I", "U", "S", "STRIKE", "BLOCKQUOTE", "UL", "OL", "LI", "PRE", "CODE", "A", "HR", "TABLE", "TBODY", "THEAD", "TR", "TD", "TH", "IMG"]);
  for (const node of Array.from(template.content.querySelectorAll("*"))) {
    if (["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "SVG", "MATH", "TEMPLATE", "LINK", "META", "INPUT", "BUTTON", "TEXTAREA"].includes(node.tagName)) { node.remove(); continue; }
    if (!allowed.has(node.tagName)) { node.replaceWith(...node.childNodes); continue; }
    const href = node.getAttribute("href"), src = node.getAttribute("src"), alt = node.getAttribute("alt");
    const styles = node instanceof HTMLElement ? ["color", "background-color", "font-weight", "font-style", "text-decoration", "text-align"].flatMap(property => {
      const value = node.style.getPropertyValue(property);
      return value && !/url|expression|var\(/i.test(value) ? [[property, value]] : [];
    }) : [];
    for (const attribute of Array.from(node.attributes)) node.removeAttribute(attribute.name);
    if (node instanceof HTMLElement) for (const [property, value] of styles) node.style.setProperty(property, value);
    if (node.tagName === "A" && href && /^(https?:|mailto:)/i.test(href)) {
      node.setAttribute("href", href); node.setAttribute("target", "_blank"); node.setAttribute("rel", "noopener noreferrer");
    }
    if (node.tagName === "IMG") {
      if (!src || !/^(\/v1\/blobs\/[A-Za-z0-9_-]+|data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+)$/.test(src)) node.remove();
      else { node.setAttribute("src", src); if (alt) node.setAttribute("alt", alt); }
    }
  }
  return template.innerHTML;
}

function displayTimes() {
  // One pass gets consistent calendar boundaries/default locale/timezone.
  // Recreate on the next pass, so midnight or a timezone change cannot leave
  // a long-lived cached Today/Yesterday label behind.
  const today = new Date(), todayLabel = today.toDateString();
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const yesterdayLabel = yesterday.toDateString();
  const clock = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" });
  const date = new Intl.DateTimeFormat([], { month: "short", day: "numeric" });
  const month = new Intl.DateTimeFormat([], { month: "long" });
  const year = new Intl.DateTimeFormat([], { month: "long", year: "numeric" });
  const values = new Map<string, { date: string; group: string }>();
  const locale = clock.resolvedOptions();
  return { key: `${locale.locale}\0${locale.timeZone}\0${todayLabel}`, format: (value: string) => {
    const cached = values.get(value); if (cached) return cached;
    const time = new Date(value), day = time.toDateString(), sameDay = day === todayLabel;
    const formatted = { date: sameDay ? clock.format(time) : date.format(time),
      group: sameDay ? "Today" : day === yesterdayLabel ? "Yesterday" : (time.getFullYear() !== today.getFullYear() ? year : month).format(time) };
    values.set(value, formatted); return formatted;
  } };
}

export class InboxStore {
  private readonly applicationScope = getApplicationScope();
  private readonly storage = getApplicationStorage();
  private readonly transport = createScopedFetch(this.applicationScope);
  private state: InboxSnapshot = initial;
  private listeners = new Set<() => void>();
  private controller = new AbortController();
  private generation = 0;
  private started = false;
  private refreshPromise?: Promise<void>;
  private updatesPromise?: Promise<void>;
  private updateAgain = false;
  private metadataPending = false;
  private mailboxCursor?: { state: string; scopeState: string; mailboxIds: string[] };
  private catchingUp = false;
  private actionQueue: Promise<unknown> = Promise.resolve();
  private flagQueues = new Map<string, Promise<unknown>>();
  private flagSequence = 0;
  private flagEpoch = 0;
  private flagIntents = new Map<string, FlagIntent>();
  private flagVersions = new Map<string, number>();
  private flagRevisions = new Map<string, Map<number, number>>();
  private flagWrites = new Set<FlagWrite>();
  private flagReconciler?: Promise<void>;
  private membershipReceipts = new Map<string, { sourceId: string; state: MailboxMembership }>();
  private feedbackEpoch = 0;
  private calendarKey?: string;
  private draftEpoch = 0;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private sourceAccounts: Account[] = [];
  private boxes: Mailbox[] = [];
  private summaries = new Map<string, MailboxMessageSummary[]>();
  private messageRows = new Map<string, MailboxMessageSummary>();
  private summaryFences = new Map<string, { epoch: number; revision: number; removed?: "deleted" | "unselected" | "absent" }>();
  private details = new Map<string, SdkMessage>();
  private bodyEpoch = 0;
  private blobInfo = new Map<string, BlobInfo>();
  private folders = new Map<string, Folder[]>();
  private folderDiscovery?: Promise<void>;
  private discoveredFolders = new Set<string>();
  private labels: Label[] = [];
  private rawDrafts = new Map<string, SdkDraft>();
  private draftParents = new Map<string, { sourceMessageId: string; threadId: string }>();
  private edits = new Map<string, Edit>();
  private popouts = new Map<string, boolean>();
  private sendErrors = new Map<string, NonNullable<Draft["sendError"]>>();
  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private saves = new Map<string, Promise<SdkDraft>>();
  private uploads = new WeakMap<Attachment, Map<string, Promise<BlobInfo>>>();
  private sending = new Map<string, Sending>();
  private operations = new Map<string, Operation>();
  private submissions = new Map<string, { idempotencyKey: string; revision: number; sendAt?: string }>();
  private loadingThreads = new Map<string, Promise<void>>();
  private recovery = this.storage.readSaved<Record<string, { draft: Draft; revision: number }>>(recoveryKey, {});
  private references = this.storage.readSaved<SendReference[]>(outboxKey, []).filter(ref => ref && [ref.id, ref.draftId, ref.accountId, ref.mailboxId].every(value => typeof value === "string"));
  private issueHolds = new Map<string, ReturnType<typeof setTimeout>>();
  private dismissals = new Map<string, number>();
  private following = false;
  private wake?: () => void;
  private aiDecisions = new Map<string, AiDecision>();
  private aiCursor = 0;
  private aiEpoch = 0;
  private aiInitialLoaded = false;
  private aiStateAt = 0;
  private aiPollTimer?: ReturnType<typeof setTimeout>;
  private aiPollPromise?: Promise<void>;
  private aiHoldTimer?: ReturnType<typeof setTimeout>;
  private aiHolds = new Map<string, { until: number; latestMessageId: string }>();
  private aiRebuildTimer?: ReturnType<typeof setTimeout>;
  private aiRebuildThreads = new Set<string>();
  private aiRebuildAfter = 0;
  private knownThreads = new Set<string>();
  private categories = new Map<string, CategoryEntry>();
  private categoryCursor = 0;
  private categoryEpoch = 0;
  private categoryReads?: Promise<void>;
  private readonly categoryTransport = createCategoryTransport(() => AbortSignal.any([this.controller.signal, this.applicationScope.signal]), (input, init) => this.fetch(input, init));
  private readonly aiTransport = createAiTriageClient(() => AbortSignal.any([this.controller.signal, this.applicationScope.signal]), (input, init) => this.fetch(input, init));
  readonly client: InboxClient;
  readonly windowTransport = createInboxWindowTransport(() => AbortSignal.any([this.controller.signal, this.applicationScope.signal]), (input, init) => this.fetch(input, init));
  private windowQuery: InboxViewQuery = (() => {
    // Capture deep-link scope before bootstrap starts, not after the first render.
    const params = new URLSearchParams(location.hash.replace(/^#\/?/, ""));
    return { account: params.get("account") || UNIFIED_ACCOUNT, folder: params.get("folder") || "Inbox", split: params.get("split") || "Important", search: false, query: "", filter: null };
  })();
  private windowEpoch = 0;
  private windowController = new AbortController();
  private windowRows = new Map<string, InboxWindowRow>();
  private windowBoundaryCursors = new Map<string, string>();
  private windowLocalRemoved = new Map<string, string>();
  private windowRemovalFences = new Map<string, { revision: number; removed: boolean }>();
  private windowPins = new Map<string, Set<string>>();
  private windowPinnedBytes = new Map<string, number>();
  private windowLoading?: Promise<void>;
  private windowPaging?: Promise<void>;
  private windowAutoDone = false;
  private windowSenderEpoch = 0;
  private windowChanges?: Promise<void>;
  private windowMetadataEvents: ChangeEvent[] = [];
  private windowDetails = new Map<string, { contextVersion: string; summaries: MailboxMessageSummary[]; cursor: string | null; exhausted: boolean }>();
  private initialThread = new URLSearchParams(location.hash.replace(/^#\/?/, "")).get("thread");

  readonly ai: AiTriageActions = {
    ...this.aiTransport,
    state: async () => {
      const generation = this.generation;
      const value = await this.aiTransport.state();
      if (generation === this.generation) this.receiveAiState(value);
      return value;
    },
    configure: async input => {
      const generation = this.generation;
      const value = await this.aiTransport.configure(input);
      if (generation === this.generation) { this.receiveAiState(value); this.scheduleAi(0); }
      return value;
    },
    process: async input => { const job = await this.aiTransport.process(input); this.aiStateAt = 0; this.scheduleAi(0); return job; },
    control: async (id, action) => { const job = await this.aiTransport.control(id, action); this.aiStateAt = 0; this.scheduleAi(0); return job; },
    lookup: async keys => {
      const epoch = this.aiEpoch, generation = this.generation;
      const page = await this.aiTransport.lookup(keys);
      if (epoch === this.aiEpoch && generation === this.generation) this.receiveAiPage(page);
      return page;
    },
    results: async after => {
      const epoch = this.aiEpoch, generation = this.generation;
      const page = await this.aiTransport.results(after);
      if (epoch === this.aiEpoch && generation === this.generation) this.receiveAiPage(page);
      return page;
    },
    feedback: async input => {
      const epoch = this.aiEpoch, generation = this.generation;
      const decision = await this.aiTransport.feedback(input);
      if (epoch === this.aiEpoch && generation === this.generation) this.receiveAiPage({ decisions: [decision], removed: [], cursor: this.aiCursor, hasMore: false, resetRequired: false });
      this.aiStateAt = 0; this.scheduleAi(0);
      return decision;
    },
    clearReading: async () => { await this.aiTransport.clearReading(); this.aiStateAt = 0; this.scheduleAi(0); },
  };

  setWindowQuery = (query: InboxViewQuery): Promise<void> => {
    if (JSON.stringify(query) === JSON.stringify(this.windowQuery)) return this.windowLoading ?? Promise.resolve();
    this.windowQuery = { ...query };
    this.windowEpoch++; this.windowController.abort(); this.windowController = new AbortController();
    return this.state.host?.inboxWindow ? this.openWindow() : Promise.resolve();
  };
  private windowCheck(epoch: number, generation: number) {
    this.controller.signal.throwIfAborted(); this.applicationScope.signal.throwIfAborted();
    if (epoch !== this.windowEpoch || generation !== this.generation) throw new DOMException("Inbox view changed", "AbortError");
  }
  private pinnedWindowKeys() { return new Set([...this.windowPins.values()].flatMap(ids => [...ids])); }
  pinWindow = (owner: string, ids: readonly string[], projections: readonly Mail[] = []) => {
    if (ids.length > INBOX_LOOKUP_LIMIT) throw new Error("Too many conversations are pinned. Finish the current action first.");
    if (ids.length) {
      this.windowPins.set(owner, new Set(ids));
      this.windowPinnedBytes.set(owner, new TextEncoder().encode(JSON.stringify(projections)).length * 2);
    } else { this.windowPins.delete(owner); this.windowPinnedBytes.delete(owner); }
    if (projections.length && this.state.window && this.windowBytes() > INBOX_WINDOW_BYTE_LIMIT) {
      const keys = this.trimWindow(this.state.window.keys);
      this.publish({ window: { ...this.state.window, keys, residentBytes: this.windowBytes() } }); this.rebuild();
    }
  };
  private windowBytes() {
    // Account for raw DTOs, materialized projections and UTF-16 strings, including pinned rows and body caches.
    const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length * 2;
    const resident = new Map(this.state.mail.filter(mail => this.windowRows.has(mail.id)).map(mail => [mail.id, mail]));
    for (const row of this.windowRows.values()) if (!resident.has(row.key)) resident.set(row.key, row.mail);
    return size([...this.windowRows.values()]) + size([...resident.values()]) + size([...this.windowDetails.values()]) + size([...this.details.values()]) + [...this.windowPinnedBytes.values()].reduce((sum, value) => sum + value, 0);
  }
  private trimWindow(keys: string[], evict: "start" | "end" = "start"): string[] {
    const pins = this.pinnedWindowKeys();
    const active = new Set(keys);
    for (const id of this.windowRows.keys()) if (!active.has(id) && !pins.has(id)) { this.windowRows.delete(id); this.windowDetails.delete(id); }
    // Body eviction is not metadata deletion and never drops command intent/fences.
    while (this.details.size && this.windowBytes() > INBOX_WINDOW_BYTE_LIMIT / 2) this.details.delete(this.details.keys().next().value!);
    while (this.windowRows.size > INBOX_WINDOW_LIMIT || this.windowBytes() > INBOX_WINDOW_BYTE_LIMIT) {
      const candidates = evict === "start" ? keys : [...keys].reverse();
      const id = candidates.find(id => active.has(id) && this.windowRows.has(id));
      if (!id) throw new Error("Pinned conversations exceed the safe window size. Close a reader before loading more.");
      active.delete(id);
      if (!pins.has(id)) { this.windowRows.delete(id); this.windowDetails.delete(id); }
    }
    for (const key of this.windowBoundaryCursors.keys()) if (!this.windowRows.has(key)) this.windowBoundaryCursors.delete(key);
    this.knownThreads = new Set([...this.windowRows.values()].map(row => nativeKey(row.sourceId, row.threadId)));
    for (const key of this.categories.keys()) if (!this.knownThreads.has(key)) this.categories.delete(key);
    for (const key of this.aiDecisions.keys()) if (!this.knownThreads.has(key)) this.aiDecisions.delete(key);
    return keys.filter(id => active.has(id) && this.windowRows.has(id));
  }
  private receiveWindowRows(rows: InboxWindowRow[], epoch = this.flagEpoch) {
    if (rows.length > INBOX_PAGE_LIMIT) throw new Error("The host returned an oversized inbox page.");
    for (const row of rows) {
      const previous = this.windowRows.get(row.key);
      const fence = this.windowRemovalFences.get(row.key);
      if (fence?.removed && row.revision <= fence.revision) continue;
      if (previous && previous.sourceGeneration === row.sourceGeneration && previous.revision > row.revision) continue;
      if (previous && previous.sourceGeneration !== row.sourceGeneration) {
        for (const summary of previous.summaries) this.details.delete(summary.id);
        this.bodyEpoch++;
      }
      if (this.windowDetails.get(row.key)?.contextVersion !== row.contextVersion) this.windowDetails.delete(row.key);
      this.windowRows.set(row.key, row);
      for (const summary of row.summaries) {
        const key = nativeKey(summary.sourceId, summary.id), old = this.messageRows.get(key);
        if (!old || summary.revision >= old.revision) this.summaryFences.set(key, { epoch, revision: summary.revision });
        for (const state of summary.memberships) {
          const receiptKey = membershipKey(summary.sourceId, state), receipt = this.membershipReceipts.get(receiptKey);
          if (receipt && state.revision >= receipt.state.revision) this.membershipReceipts.delete(receiptKey);
        }
      }
    }
  }
  private applyWindowPage(page: InboxWindowPage, append: boolean, query: InboxViewQuery, flagEpoch: number) {
    const previous = this.state.window;
    if (append && previous && (page.state.queryId !== previous.state.queryId || page.state.scopeState !== previous.state.scopeState || page.state.queryGeneration !== previous.state.queryGeneration)) throw new Error("The inbox query changed. Reload this view.");
    this.receiveWindowRows(page.rows, flagEpoch);
    for (const row of page.rows) if (page.nextCursor) this.windowBoundaryCursors.set(row.key, page.nextCursor);
    const combined = [...new Set([...(append ? previous?.keys ?? [] : []), ...page.rows.filter(row => row.revision > (this.windowRemovalFences.get(row.key)?.revision ?? -1)).map(row => row.key)])];
    const keys = this.trimWindow(combined);
    const stale = append && previous && previous.state.indexRevision > page.state.indexRevision;
    const state = stale ? previous.state : page.state, totals = stale ? previous.totals : page.totals;
    const exhausted = stale ? false : page.exhausted;
    const usable = keys.length > 0 || exhausted && !state.indexing;
    this.publish({ window: { query, state, keys, totals, nextCursor: page.nextCursor ?? (stale ? previous.nextCursor : null), exhausted, paging: false, residentBytes: this.windowBytes(), hasNewer: append && (previous?.hasNewer === true || combined[0] !== keys[0]) }, loading: !usable, loaded: usable, refreshing: false, error: null });
    this.rebuild(); this.resolve("snapshot");
  }
  private openWindow = (): Promise<void> => {
    const query = { ...this.windowQuery }, epoch = ++this.windowEpoch, generation = this.generation;
    this.windowController.abort(); this.windowController = new AbortController();
    this.windowPaging = undefined; this.windowChanges = undefined; this.windowBoundaryCursors.clear(); this.windowLocalRemoved.clear(); this.windowRemovalFences.clear(); this.windowAutoDone = false;
    const signal = AbortSignal.any([this.windowController.signal, this.controller.signal]);
    const transport = createInboxWindowTransport(() => signal, (input, init) => this.fetch(input, init));
    this.publish({ window: null, loading: true, loaded: false, refreshing: true });
    const work = (async () => {
      const flagEpoch = this.flagEpoch;
      const page = await transport.query({ ...query, limit: INBOX_FIRST_PAGE_LIMIT });
      this.windowCheck(epoch, generation); this.applyWindowPage(page, false, query, flagEpoch);
      if (page.state.indexing) this.scheduleRefresh();
      if (this.initialThread) {
        const id = this.initialThread; this.initialThread = null;
        this.pinWindow("reader", [id]); void this.lookupWindow([id]).catch(error => this.fail(error, "load-thread"));
      }
      // Publish the first usable page before continuing in the background. Never prefetch beyond 300.
      void this.prefetchWindow(epoch, generation).catch(error => { if (!(error instanceof DOMException && error.name === "AbortError")) this.fail(error, "refresh"); });
    })().catch(error => { if (epoch === this.windowEpoch && generation === this.generation) this.fail(error, "refresh"); throw error; })
      .finally(() => { if (this.windowLoading === work) this.windowLoading = undefined; });
    this.windowLoading = work; return work;
  };
  private async prefetchWindow(epoch: number, generation: number) {
    while (!this.windowAutoDone && this.state.window?.nextCursor && this.state.window.keys.length < INBOX_AUTO_PREFETCH_LIMIT) {
      this.windowCheck(epoch, generation);
      const before = this.state.window.keys.length;
      await this.loadMoreWindow(Math.min(INBOX_PAGE_LIMIT, INBOX_AUTO_PREFETCH_LIMIT - before));
      if ((this.state.window?.keys.length ?? 0) <= before) break;
    }
    this.windowCheck(epoch, generation);
    this.windowAutoDone ||= (this.state.window?.keys.length ?? 0) >= INBOX_AUTO_PREFETCH_LIMIT;
  }
  loadMoreWindow = (limit = INBOX_PAGE_LIMIT): Promise<void> => {
    if (this.windowPaging) return this.windowPaging;
    const current = this.state.window, epoch = this.windowEpoch, generation = this.generation;
    if (!current?.nextCursor) return Promise.resolve();
    this.publish({ window: { ...current, paging: true } });
    const work = (async () => {
      const flagEpoch = this.flagEpoch;
      const page = await this.windowTransport.page({ queryId: current.state.queryId, cursor: current.nextCursor!, limit });
      this.windowCheck(epoch, generation); this.applyWindowPage(page, true, current.query, flagEpoch);
    })().finally(() => {
      if (this.windowPaging !== work) return;
      this.windowPaging = undefined;
      if (epoch === this.windowEpoch && this.state.window?.paging) this.publish({ window: { ...this.state.window, paging: false } });
    });
    this.windowPaging = work; return work;
  };
  seekWindow = async (seek: "start" | "end"): Promise<void> => {
    const current = this.state.window, epoch = this.windowEpoch, generation = this.generation;
    if (!current) return;
    const flagEpoch = this.flagEpoch; this.windowAutoDone = true;
    const page = await this.windowTransport.page({ queryId: current.state.queryId, seek, limit: 100 });
    this.windowCheck(epoch, generation); this.applyWindowPage(page, false, current.query, flagEpoch);
    if (seek === "end") this.publish({ window: { ...this.state.window!, hasNewer: !page.exhausted, exhausted: true, nextCursor: null } });
  };
  loadNewerWindow = async (): Promise<void> => {
    const current = this.state.window, epoch = this.windowEpoch, generation = this.generation;
    if (!current?.hasNewer || current.paging) return;
    const cursor = this.windowBoundaryCursors.get(current.keys[0]);
    if (!cursor) return this.seekWindow("start");
    this.publish({ window: { ...current, paging: true } });
    try {
      const flagEpoch = this.flagEpoch;
      const page = await this.windowTransport.page({ queryId: current.state.queryId, cursor, direction: "newer", limit: 100 });
      this.windowCheck(epoch, generation); this.receiveWindowRows(page.rows, flagEpoch);
      for (const row of page.rows) if (page.nextCursor) this.windowBoundaryCursors.set(row.key, page.nextCursor);
      const combined = [...new Set([...page.rows.map(row => row.key), ...current.keys])];
      const keys = this.trimWindow(combined, "end");
      this.publish({ window: { ...current, keys, state: page.state, totals: page.totals, hasNewer: !page.exhausted, paging: false,
        nextCursor: combined.at(-1) !== keys.at(-1) ? this.windowBoundaryCursors.get(keys.at(-1)!) ?? null : current.nextCursor,
        exhausted: combined.at(-1) === keys.at(-1) && current.exhausted } });
      this.rebuild();
    } finally { if (epoch === this.windowEpoch && this.state.window) this.publish({ window: { ...this.state.window, paging: false } }); }
  };
  lookupWindow = async (ids: readonly string[], account = this.windowQuery.account): Promise<Mail[]> => {
    const unique = [...new Set(ids)], epoch = this.windowEpoch, generation = this.generation;
    if (unique.length > INBOX_LOOKUP_LIMIT) throw new Error("Load at most 100 captured conversations at once.");
    if (!this.state.host?.inboxWindow) return this.state.mail.filter(mail => unique.includes(mail.id));
    const flagEpoch = this.flagEpoch;
    const result = await this.windowTransport.lookup({ account, ids: unique });
    this.windowCheck(epoch, generation);
    const scope = this.state.window?.state.scopeState;
    if (scope && result.state.scopeState !== scope) throw new Error("The receiving scope changed. Reload this view.");
    if (result.entries.some(entry => entry.status === "unknown")) throw new Error("Some conversations are still being indexed. Retry when indexing finishes.");
    this.receiveWindowRows(result.entries.flatMap(entry => entry.status === "found" ? [entry.row] : []), flagEpoch);
    // The caller's pin controls lifetime. Lookup must not add rows to the active view.
    this.pinWindow("lookup", unique);
    try {
      const keys = this.trimWindow(this.state.window?.keys ?? []);
      if (this.state.window) this.publish({ window: { ...this.state.window, keys } });
      this.rebuild();
    } finally { this.pinWindow("lookup", []); }
    return unique.flatMap(id => { const mail = this.state.mail.find(mail => mail.id === id); return mail ? [mail] : []; });
  };
  clearSenderWindow = () => { this.windowSenderEpoch++; this.pinWindow("sender", []); };
  senderWindow = async (input: InboxSenderInput) => {
    const request = ++this.windowSenderEpoch, epoch = this.windowEpoch, generation = this.generation, flagEpoch = this.flagEpoch;
    const result = await this.windowTransport.sender(input);
    this.windowCheck(epoch, generation);
    if (request !== this.windowSenderEpoch) throw new DOMException("Sender changed", "AbortError");
    this.receiveWindowRows(result.recent, flagEpoch);
    this.pinWindow("sender", result.recent.map(row => row.key));
    this.windowPinnedBytes.set("sender", new TextEncoder().encode(JSON.stringify(result.recent)).length * 2);
    if (this.state.window) {
      const keys = this.trimWindow(this.state.window.keys);
      this.publish({ window: { ...this.state.window, keys, residentBytes: this.windowBytes() } }); this.rebuild();
    }
    return result;
  };
  createWindowSelection = () => {
    const window = this.state.window;
    if (!window) throw new Error("The current view is still loading.");
    return this.windowTransport.selectionCreate({ id: crypto.randomUUID(), account: window.query.account, queryId: window.state.queryId, allMatching: true });
  };
  resolveWindowSelection = async (selection: InboxSelection): Promise<Mail[]> => {
    if (selection.count !== null && selection.count > 500) throw new Error("This selection exceeds 500 conversations. Choose a smaller selection before making changes.");
    const found: Mail[] = []; let cursor: string | undefined;
    do {
      const page = await this.windowTransport.selectionPage({ selectionId: selection.id, cursor, limit: INBOX_PAGE_LIMIT });
      if (!page.selection.captureComplete || page.selection.count === null) throw new Error("The selection is still being captured. Try again shortly.");
      if (page.selection.count > 500) throw new Error("This selection exceeds 500 conversations. No mail was changed.");
      if (page.entries.some(entry => entry.status !== "found")) throw new Error("The captured selection changed or is still indexing. No mail was changed.");
      for (const entry of page.entries) if (entry.status === "found") found.push({ ...entry.row.mail, window: this.rowProvenance(entry.row) });
      if (found.reduce((sum, mail) => sum + (mail.window?.targets.length ?? 0), 0) > 500 || found.some(mail => !mail.window?.targetsComplete)) throw new Error("This selection exceeds 500 message memberships. No mail was changed.");
      if (page.exhausted) break;
      if (!page.nextCursor) throw new Error("The selection is still being captured. No mail was changed.");
      cursor = page.nextCursor;
    } while (cursor);
    return found;
  };
  private rowProvenance(row: InboxWindowRow): NonNullable<Mail["window"]> {
    const targets = row.targets.map(target => {
      const receipt = this.membershipReceipts.get(`${row.sourceId}\0${target.messageId}\0${target.mailboxId}`)?.state;
      return receipt && receipt.revision > target.revision ? { ...target, revision: receipt.revision } : target;
    });
    return { counts: row.counts, messagesComplete: row.messagesComplete, targets, targetsComplete: row.targetsComplete, actionContextComplete: row.actionContextComplete, contextVersion: row.contextVersion };
  }
  private readWindowChanges = (metadata = false): Promise<void> => {
    this.metadataPending ||= metadata;
    if (this.windowLoading) return this.windowLoading.then(() => { this.scheduleRefresh(); }, error => {
      if (!(error instanceof DOMException && error.name === "AbortError")) throw error;
    });
    if (this.windowChanges) { this.updateAgain = true; return this.windowChanges; }
    this.updateAgain = false;
    const epoch = this.windowEpoch, generation = this.generation;
    const work = (async () => {
      const events = this.windowMetadataEvents.splice(0), force = metadata || this.metadataPending; this.metadataPending = false;
      if (force || events.length) {
        const meta = await this.updateMetadata(events, this.controller.signal, force); this.windowCheck(epoch, generation);
        if (meta.reset) { await this.bootstrap(); return; }
      }
      const current = this.state.window;
      if (!current) { await this.openWindow(); return; }
      let cursor: string | undefined;
      do {
        const flagEpoch = this.flagEpoch;
        const page = await this.windowTransport.changes({ queryId: current.state.queryId, sinceRevision: current.state.indexRevision,
          residentKeys: current.keys, pinnedKeys: [...this.pinnedWindowKeys()], cursor, limit: INBOX_PAGE_LIMIT });
        this.windowCheck(epoch, generation);
        if (page.resetReason) { await this.openWindow(); return; }
        if (page.state.scopeState !== current.state.scopeState) { await this.openWindow(); return; }
        this.receiveWindowRows([...page.upserts, ...page.newHead], flagEpoch);
        const removed = new Set(page.removed.map(row => row.key));
        for (const row of page.removed) this.windowRemovalFences.set(row.key, { revision: page.throughRevision, removed: row.reason !== "not-matching" });
        while (this.windowRemovalFences.size > INBOX_WINDOW_LIMIT) this.windowRemovalFences.delete(this.windowRemovalFences.keys().next().value!);
        for (const item of page.removed) if (item.reason === "deleted" || item.reason === "unselected") { this.windowRows.delete(item.key); this.windowDetails.delete(item.key); }
        const latest = this.state.window!;
        const keys = this.trimWindow([...new Set([...page.newHead.map(row => row.key), ...latest.keys.filter(key => !removed.has(key))])]);
        this.publish({ window: { ...latest, keys, state: page.nextCursor ? latest.state : { ...page.state, indexRevision: page.throughRevision }, totals: page.totals },
          ...(keys.length ? { loading: false, loaded: true, error: null } : {}) });
        this.reconcileFlags(); this.rebuild();
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      if (this.state.window?.state.indexing) {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => void this.readWindowChanges().catch(error => this.fail(error, "refresh")), 500);
      }
      await this.prefetchWindow(epoch, generation);
    })().finally(() => {
      if (this.windowChanges !== work) return;
      this.windowChanges = undefined;
      if (this.updateAgain && epoch === this.windowEpoch && generation === this.generation) this.scheduleRefresh();
    });
    this.windowChanges = work; return work;
  };

  private receiveCategories(entries: CategoryEntry[]) {
    const threads = new Set<string>();
    for (const entry of entries) {
      const key = categoryKey(entry), previous = this.categories.get(key);
      if (this.state.host?.inboxWindow && !this.knownThreads.has(key)) continue;
      if (previous && previous.revision >= entry.revision) continue;
      if (!previous && this.categories.size >= 100_000) throw new CategoryRequestError("HOST_CATEGORY_TOO_LARGE", 413);
      this.categories.set(key, entry);
      if (this.knownThreads.has(key)) threads.add(key);
    }
    if (threads.size) this.rebuild(threads);
  }

  /** Sparse saved choices only. Cross-tab changes catch up on mail events/focus/Retry,
   * not a new poller. Receipts reconcile immediately; no SDK inventory is restarted. */
  private readCategories(): Promise<void> {
    if (this.categoryReads) return this.categoryReads;
    if (this.state.host?.inboxWindow || !this.state.host?.attentionOverrides || this.controller.signal.aborted) return Promise.resolve();
    const signal = this.controller.signal, generation = this.generation, epoch = this.categoryEpoch;
    const work = (async () => {
      let resets = 0;
      for (let pages = 0; pages < 2001; pages++) {
        while (this.state.pending) await pause(25, signal);
        const page = await this.categoryTransport.changes(this.categoryCursor);
        signal.throwIfAborted();
        if (generation !== this.generation || epoch !== this.categoryEpoch) return;
        if (page.resetRequired) {
          if (resets++) throw new CategoryRequestError("HOST_CATEGORY_UNAVAILABLE", 503);
          const threads = new Set(this.categories.keys()); this.categories.clear(); this.categoryCursor = 0;
          if (threads.size) this.rebuild(threads);
          continue;
        }
        if (page.cursor < this.categoryCursor || page.hasMore && page.cursor === this.categoryCursor) throw new CategoryRequestError("HOST_CATEGORY_UNAVAILABLE", 503);
        this.receiveCategories(page.entries); this.categoryCursor = page.cursor;
        if (!page.hasMore) {
          if (this.state.issues.some(issue => issue.key === "storage:categories")) this.publish({ issues: this.state.issues.filter(issue => issue.key !== "storage:categories") });
          return;
        }
        await pause(0, signal);
      }
      throw new CategoryRequestError("HOST_CATEGORY_TOO_LARGE", 413);
    })().catch(() => {
      if (!signal.aborted && generation === this.generation) this.raise({ key: "storage:categories", scope: "storage", code: "HOST_CATEGORY_UNAVAILABLE", title: "Couldn't load saved categories", detail: "Retry to check saved choices. Existing mail remains available.", retry: true });
    }).finally(() => {
      if (this.categoryReads !== work) return;
      this.categoryReads = undefined;
      if (!signal.aborted && generation === this.generation && epoch !== this.categoryEpoch) void this.readCategories();
    });
    this.categoryReads = work;
    return work;
  }

  private receiveAiState(value: AiTriageState) {
    if (this.controller.signal.aborted || this.applicationScope.signal.aborted || !value?.settings || !Number.isSafeInteger(value.settings.revision) || !Number.isSafeInteger(value.cursor)) return;
    const previous = this.state.ai;
    if (previous && value.settings.revision < previous.settings.revision) return;
    const changed = JSON.stringify(previous?.settings) !== JSON.stringify(value.settings) || previous?.configured !== value.configured;
    this.aiStateAt = Date.now();
    if (JSON.stringify(previous) !== JSON.stringify(value) || this.state.aiError) this.publish({ ai: value, aiError: null });
    if (changed) {
      clearTimeout(this.aiRebuildTimer); this.aiRebuildTimer = undefined; this.aiRebuildThreads.clear();
      this.aiEpoch++; this.aiInitialLoaded = false;
      const threads = new Set([...this.aiDecisions.keys(), ...this.aiHolds.keys()]);
      if (!previous || previous.configured !== value.configured || previous.settings.enabled !== value.settings.enabled || previous.settings.model !== value.settings.model || JSON.stringify(previous.settings.mailboxIds) !== JSON.stringify(value.settings.mailboxIds)) this.aiDecisions.clear();
      if (!value.configured || !value.settings.enabled || value.settings.mode !== "apply") this.aiHolds.clear();
      if (this.state.loaded && threads.size) this.rebuild(threads);
    }
    if (!this.aiPollPromise) this.scheduleAi(0);
  }

  private receiveAiPage(page: AiDecisionPage, background = false) {
    if (this.controller.signal.aborted || this.applicationScope.signal.aborted) return;
    if (!Array.isArray(page.decisions) || page.decisions.length > 1000 || !Array.isArray(page.removed) || page.removed.length > 1000 || !Number.isSafeInteger(page.cursor) || page.cursor < 0) throw new Error("Invalid AI triage page.");
    const threads = new Set<string>(), releasedHolds = new Set<string>();
    for (const value of page.removed) {
      const key = nativeKey(value.sourceId, value.threadId);
      if (this.aiDecisions.delete(key)) threads.add(key);
      if (this.aiHolds.delete(key)) { threads.add(key); releasedHolds.add(key); }
    }
    for (const decision of page.decisions) {
      if (!decision || typeof decision.sourceId !== "string" || typeof decision.threadId !== "string" || !Number.isSafeInteger(decision.revision) || !Array.isArray(decision.contextVersions) || decision.contextVersions.length > 8) throw new Error("Invalid AI triage decision.");
      const key = nativeKey(decision.sourceId, decision.threadId), previous = this.aiDecisions.get(key);
      if (this.state.host?.inboxWindow && !this.knownThreads.has(key)) continue;
      if (previous && previous.revision > decision.revision || previous && JSON.stringify(previous) === JSON.stringify(decision)) continue;
      if (!previous && this.aiDecisions.size >= 100_000) throw new Error("AI triage cache capacity reached.");
      this.aiDecisions.set(key, decision); threads.add(key);
      const hold = this.aiHolds.get(key);
      if (hold && decision.latestMessageId === hold.latestMessageId && ["ready", "failed"].includes(decision.state)) { this.aiHolds.delete(key); releasedHolds.add(key); }
    }
    if (this.state.loaded && releasedHolds.size) {
      for (const key of releasedHolds) { threads.delete(key); this.aiRebuildThreads.delete(key); }
      this.rebuild(releasedHolds);
    }
    // The initial SDK model exists before catch-up marks it loaded. Retain
    // these invalidations: an unchanged catch-up will not rebuild it for us.
    if (threads.size) {
      if (background) {
        for (const key of threads) {
          if (!this.aiRebuildThreads.has(key) && this.aiRebuildThreads.size >= 100_000) throw new Error("AI triage reconciliation capacity reached.");
          this.aiRebuildThreads.add(key);
        }
        this.scheduleAiRebuild();
      } else this.rebuild(threads);
    }
  }

  private scheduleAiRebuild() {
    if (this.aiRebuildTimer || !this.aiRebuildThreads.size || this.controller.signal.aborted || this.applicationScope.signal.aborted) return;
    this.aiRebuildTimer = setTimeout(() => {
      this.aiRebuildTimer = undefined;
      if (this.controller.signal.aborted || this.applicationScope.signal.aborted) { this.aiRebuildThreads.clear(); return; }
      // Historical pages must not compete with a durable mail receipt or its next frame.
      // Arrival hold expiry and explicit feedback still reconcile immediately.
      if (!this.state.pending && Date.now() >= this.aiRebuildAfter) {
        const threads = new Set<string>();
        for (const key of this.aiRebuildThreads) {
          threads.add(key); this.aiRebuildThreads.delete(key);
          if (threads.size >= 500) break;
        }
        if (threads.size) this.rebuild(threads);
      }
      this.scheduleAiRebuild();
    }, 100);
  }

  private scheduleAi(delay = 1000) {
    clearTimeout(this.aiPollTimer);
    if (!this.started || this.controller.signal.aborted || !(this.state.host?.aiTriage || this.state.ai?.configured)) return;
    this.aiPollTimer = setTimeout(() => void this.pollAi(), delay);
  }

  private pollAi(): Promise<void> {
    if (this.aiPollPromise) return this.aiPollPromise;
    const signal = this.controller.signal, generation = this.generation;
    const work = (async () => {
      if (!this.state.ai || Date.now() - this.aiStateAt > 15_000) await this.ai.state();
      if (signal.aborted || generation !== this.generation || !this.state.ai?.configured || !this.state.ai.settings.enabled) return;
      if (this.state.host?.inboxWindow) return; // Row provenance comes from the bounded host index, not AI history drains.
      const epoch = this.aiEpoch;
      if (!this.aiInitialLoaded) {
        const baseline = this.state.ai.cursor;
        let after: number | undefined;
        for (let pages = 0; pages < 1000; pages++) {
          const page = await this.aiTransport.results(after);
          if (signal.aborted || generation !== this.generation || epoch !== this.aiEpoch) return;
          this.receiveAiPage(page, true);
          if (!page.hasMore) { this.aiCursor = baseline; this.aiInitialLoaded = true; break; }
          if (page.cursor <= (after ?? -1)) throw new Error("AI triage cursor did not advance.");
          after = page.cursor;
          await pause(0, signal);
        }
        if (!this.aiInitialLoaded) throw new Error("AI triage result inventory exceeds the limit.");
      }
      for (let pages = 0; pages < 20; pages++) {
        const page = await this.aiTransport.changes(this.aiCursor);
        if (signal.aborted || generation !== this.generation || epoch !== this.aiEpoch) return;
        if (page.resetRequired) {
          clearTimeout(this.aiRebuildTimer); this.aiRebuildTimer = undefined; this.aiRebuildThreads.clear();
          this.aiInitialLoaded = false;
          const threads = new Set(this.aiDecisions.keys()); this.aiDecisions.clear();
          if (threads.size) this.rebuild(threads);
          return;
        }
        this.receiveAiPage(page, true);
        if (page.cursor < this.aiCursor || page.hasMore && page.cursor === this.aiCursor) throw new Error("AI triage cursor did not advance.");
        this.aiCursor = page.cursor;
        if (!page.hasMore) break;
        await pause(0, signal);
      }
      if (this.state.aiError) this.publish({ aiError: null });
    })().catch(() => {
      if (!signal.aborted && generation === this.generation) this.publish({ aiError: "AI triage is temporarily unavailable. Existing mail and sorting remain usable." });
    }).finally(() => {
      if (this.aiPollPromise !== work) return;
      this.aiPollPromise = undefined;
      this.scheduleAi(this.state.aiError ? 5000 : this.state.ai?.settings.enabled ? 1000 : 15_000);
    });
    this.aiPollPromise = work; return work;
  }

  private releaseAiHolds() {
    clearTimeout(this.aiHoldTimer);
    const now = Date.now(), threads = new Set<string>();
    for (const [key, hold] of this.aiHolds) if (hold.until <= now) { this.aiHolds.delete(key); threads.add(key); }
    if (threads.size) this.rebuild(threads);
    const next = Math.min(...[...this.aiHolds.values()].map(hold => hold.until));
    if (Number.isFinite(next)) this.aiHoldTimer = setTimeout(() => this.releaseAiHolds(), Math.max(0, next - Date.now()));
  }

  constructor() {
    this.client = createInboxClient({ baseUrl: location.origin, fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const start = performance.now();
      const path = new URL(input instanceof Request ? input.url : String(input), location.origin).pathname;
      const finish = measureRequest(path, init?.method ?? "GET");
      try {
        const response = await this.fetch(input, init);
        finish(response.status);
        console.info({ event: "inbox.request", method: init?.method ?? "GET", path, status: response.status, durationMs: Math.round(performance.now() - start), requestId: response.headers.get("x-request-id") });
        return response;
      } catch (error) {
        finish(0);
        if (!(error instanceof DOMException && error.name === "AbortError")) console.warn({ event: "inbox.request", method: init?.method ?? "GET", path, code: "NETWORK" });
        throw error;
      }
    }) as typeof fetch });
  }

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    return this.transport(input, { ...init, signal: signal ? AbortSignal.any([this.controller.signal, signal]) : this.controller.signal });
  }
  private publish(patch: Partial<InboxSnapshot> = {}) {
    if (this.controller.signal.aborted || this.applicationScope.signal.aborted) return;
    this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener());
  }
  private requestOptions() { return { signal: this.controller.signal }; }
  private fail(error: unknown, action: string, key?: string) {
    if (this.controller.signal.aborted || error instanceof DOMException && error.name === "AbortError") return;
    const code = failureCode(error);
    console.warn({ event: "inbox.action", action, code });
    const detail = failureMessage(error);
    if (action === "connect" || action === "refresh" || action === "retry") {
      this.publish({ loading: false, refreshing: false, error: detail });
      this.raise({ scope: "snapshot", code, title: this.state.loaded ? "Couldn't refresh the inbox" : "Couldn't open the inbox", detail, retry: true });
    } else if (action === "load-thread") this.raise({ scope: "thread", code, title: "Couldn't load this conversation", detail, retry: true });
    else if (action === "save-draft") this.raise({ key, scope: "draft", code, title: "Draft not saved", detail, retry: false });
    // Other actions are user-initiated: their caller shows the failure once, so no persistent notice is added.
  }
  private raise(issue: Pick<InboxIssue, "scope" | "code" | "title" | "retry"> & { key?: string; detail?: string }) {
    if (this.controller.signal.aborted) return;
    // One slot per problem: live updates, the snapshot, the open conversation, and each draft stay a single notice whatever the code.
    const key = issue.key ?? (issue.scope === "storage" ? `storage:${issue.code}` : issue.scope), now = Date.now();
    clearTimeout(this.issueHolds.get(key)); this.issueHolds.delete(key);
    const existing = this.state.issues.find(item => item.key === key);
    if (existing) {
      this.publish({ issues: this.state.issues.map(item => item.key === key ? { ...item, code: issue.code, title: issue.title, detail: issue.detail, retry: issue.retry, count: item.count + 1, updatedAt: now } : item) });
      return;
    }
    const dismissedAt = this.dismissals.get(key);
    const next: InboxIssue = { key, scope: issue.scope, code: issue.code, title: issue.title, detail: issue.detail, retry: issue.retry, count: 1, since: now, updatedAt: now,
      dismissed: dismissedAt !== undefined && now - dismissedAt < DISMISSAL_MEMORY_MS };
    this.publish({ issues: [...this.state.issues, next].slice(-MAX_ISSUES) });
  }
  /** Marks a scope recovered. Its notices leave only after the recovery holds, so a quick relapse keeps the same quiet notice. */
  private resolve(scope: InboxIssue["scope"]) {
    for (const issue of this.state.issues) if (issue.scope === scope && !this.issueHolds.has(issue.key)) {
      this.issueHolds.set(issue.key, setTimeout(() => {
        this.issueHolds.delete(issue.key);
        if (this.state.issues.some(item => item.key === issue.key)) this.publish({ issues: this.state.issues.filter(item => item.key !== issue.key) });
      }, RESOLVE_HOLD_MS));
    }
  }
  dismissIssue = (key: string) => {
    this.dismissals.set(key, Date.now());
    this.publish({ issues: this.state.issues.map(issue => issue.key === key ? { ...issue, dismissed: true } : issue) });
  };
  private account(boxId: string) {
    const box = this.boxes.find(box => box.id === boxId);
    const source = this.sourceAccounts.find(account => account.id === box?.sourceId);
    if (!box || !source) throw new Error("Select a connected mailbox first.");
    return { box, source };
  }
  sendingIdentities: LoadSendingIdentities = async (mailboxId, input = {}) => {
    const { source } = this.account(mailboxId);
    const generation = this.generation, signal = this.controller.signal;
    const assertCurrent = () => {
      signal.throwIfAborted();
      this.applicationScope.signal.throwIfAborted();
      const current = this.sourceAccounts.find(account => account.id === source.id);
      if (generation !== this.generation || current?.generation !== source.generation || current?.status !== source.status
        || !this.boxes.some(box => box.id === mailboxId && box.sourceId === source.id)) {
        throw new DOMException("The sending mailbox changed. Retry to load its senders.", "AbortError");
      }
    };
    // Cache hits must obey the same owner and generation fences as network reads.
    assertCurrent();
    const result = await this.client.sendingIdentities(source.id, input, { signal }).catch(error => { assertCurrent(); throw error; });
    assertCurrent();
    if (result.sourceId !== source.id) throw new Error("The sending mailbox changed. Retry to load its senders.");
    return result;
  };
  unifiedMailboxIds(): string[] {
    const available = this.boxes.map(box => box.id);
    const preferences = this.state.viewPreferences;
    if (!preferences) return [];
    return preferences.unifiedMode === "all" ? available : available.filter(id => preferences.includedMailboxIds.includes(id));
  }
  defaultMailbox(boxId = UNIFIED_ACCOUNT, mail?: Mail, messageId?: string): MailboxOption | undefined {
    if (boxId !== UNIFIED_ACCOUNT) return this.state.accounts.find(account => account.id === boxId);
    const message = messageId ? mail?.messages.find(message => message.id === messageId) : mail?.messages.filter(message => !message.pending).at(-1);
    const ids = message?.memberships?.length ? message.memberships.map(state => state.mailboxId) : mail?.mailboxIds ?? this.unifiedMailboxIds();
    const pins = this.state.viewPreferences?.pinnedMailboxIds ?? [];
    const specificity = { all: 0, domain: 1, address: 2 };
    return this.state.accounts.filter(account => ids.includes(account.id) && (!mail?.sourceId || mail.sourceId === account.sourceId)).sort((a, b) =>
      Number(b.canSend) - Number(a.canSend)
      || (mail ? specificity[b.selectorKind ?? "all"] - specificity[a.selectorKind ?? "all"] : 0)
      || (pins.includes(a.id) ? pins.indexOf(a.id) : 1000) - (pins.includes(b.id) ? pins.indexOf(b.id) : 1000))[0];
  }
  supports(action: string, boxId: string): boolean {
    if (boxId === UNIFIED_ACCOUNT) {
      if (action === "send" || action === "reply") {
        const box = this.defaultMailbox();
        return !!box && this.supports(action, box.id);
      }
      const ids = this.unifiedMailboxIds();
      return ids.length > 0 && ids.every(id => this.supports(action, id));
    }
    try {
      const { source } = this.account(boxId);
      if (["done", "not-important", "inbox", "remind", "label", "cancel"].includes(action)) return true;
      if (source.status !== "connected") return false;
      if (!this.state.host?.allowProviderWrites) return false;
      if (action === "read") return source.capabilities.markRead;
      if (action === "send") return source.capabilities.send;
      if (action === "reply") return source.capabilities.reply && source.capabilities.send;
      if (action === "unread") return source.capabilities.markRead && source.capabilities.markUnread;
      if (action === "star") return source.capabilities.star;
      if (action === "trash") return source.capabilities.trash;
      if (["spam", "inbox"].includes(action)) return source.capabilities.folders;
      return false;
    } catch { return false; }
  }

  async search(boxId: string, query: string, signal: AbortSignal): Promise<Set<string>> {
    if (this.state.host?.inboxWindow) {
      signal.throwIfAborted(); await this.setWindowQuery({ ...this.windowQuery, account: boxId, search: true, query }); signal.throwIfAborted();
      return new Set(this.state.window?.keys ?? []);
    }
    const options = { signal: AbortSignal.any([signal, this.controller.signal]) };
    const scope = boxId === UNIFIED_ACCOUNT ? this.unifiedMailboxIds() : [this.account(boxId).box.id];
    if (!scope.length) return new Set();
    let selected = new Set(this.state.mail.filter(mail => mail.account === boxId && !mail.operationId).map(mail => mail.id));
    for (const raw of query.match(/(?:[^\s"]|"[^"]*")+/g) ?? []) {
      const negative = raw.startsWith("-");
      let term = negative ? raw.slice(1) : raw;
      const match = term.match(/^([a-z_]+):(.*)$/i);
      const filter: Parameters<InboxClient["mailboxMessages"]>[0] = { mailboxIds: scope, limit: 100 };
      let filters = [filter];
      if (match?.[1] === "older_than" || match?.[1] === "newer_than") {
        const age = match[2].match(/^(\d+)([dmy])$/);
        if (!age) throw new Error("Use an age such as 3d, 1m, or 1y.");
        const date = new Date(Date.now() - Number(age[1]) * ({ d: 1, m: 30, y: 365 }[age[2] as "d" | "m" | "y"] * 86_400_000)).toISOString();
        if (match[1] === "older_than") filter.before = date; else filter.after = date;
        term = "";
      } else if (match?.[1] === "in") {
        const folder = match[2].replaceAll('"', "").toLowerCase().replaceAll(/\s/g, "");
        if (folder === "done") filter.done = true;
        else if (["reminders", "snoozed"].includes(folder)) filter.snoozed = true;
        else if (["all", "allmail"].includes(folder)) { /* No additional receiving-scope filter. */ }
        else {
          filter.folder = folder === "autoarchived" ? "archive" : folder;
          if (folder === "inbox") { filter.done = false; filter.snoozed = false; }
        }
        term = "";
      } else if (match?.[1] === "label") {
        const name = match[2].replaceAll('"', "");
        const groups = new Map<string, string[]>();
        for (const id of scope) {
          const sourceId = this.account(id).source.id;
          const ids = groups.get(sourceId) ?? []; ids.push(id); groups.set(sourceId, ids);
        }
        filters = [...groups].map(([sourceId, mailboxIds]) => {
          const local = this.labels.find(label => label.accountId === sourceId && label.name.toLowerCase() === name.toLowerCase());
          const native = this.folders.get(sourceId)?.find(folder => folder.kind === "label" && folder.name.toLowerCase() === name.toLowerCase());
          return { mailboxIds, limit: 100, ...(local ? { labelId: local.id } : native ? { folder: native.id } : { search: term }) };
        });
        term = "";
      }
      if (term) filter.search = term;
      const matched = new Set<string>();
      for (const selection of filters) for (let offset = 0; offset < selection.mailboxIds.length; offset += 50) {
        const mailboxIds = selection.mailboxIds.slice(offset, offset + 50);
        for (let attempt = 0; ; attempt++) {
          try {
            const batch = new Set<string>(); let cursor: string | undefined;
            do {
              const page = await this.client.mailboxMessages({ ...selection, mailboxIds, ...(cursor ? { cursor } : {}) }, options);
              page.items.forEach(message => batch.add(boxId === UNIFIED_ACCOUNT ? unifiedThreadId(message.sourceId, message.threadId) : viewThreadId(boxId, message.threadId)));
              cursor = page.nextCursor ?? undefined;
            } while (cursor);
            for (const id of batch) matched.add(id);
            break;
          } catch (error) { if (!(error instanceof ApiError) || error.code !== "STALE_CURSOR" || attempt >= 2) throw error; }
        }
      }
      selected = new Set([...selected].filter(id => negative ? !matched.has(id) : matched.has(id)));
    }
    for (const mail of this.state.mail.filter(mail => mail.account === boxId && mail.operationId)) if (matchesSearch(mail, query)) selected.add(mail.id);
    return selected;
  }

  start = () => {
    this.applicationScope.signal.throwIfAborted();
    this.controller = new AbortController(); this.started = true;
    const generation = ++this.generation;
    const options = this.requestOptions();
    // Strict-mode remounts resume accepted IDs or the same unacknowledged
    // payload; stopping a view never cancels the durable SDK operation.
    this.flagQueues.clear(); this.flagReconciler = undefined;
    for (const write of this.flagWrites) if (!write.operation) void this.queueFlags(write).catch(() => {});
    this.watchFlags();
    const onFocus = () => { if (this.started && !this.state.loading && generation === this.generation) void this.retry(); };
    window.addEventListener("focus", onFocus);
    void (async () => {
      try {
        try { await this.client.accounts(options); }
        catch (error) {
          if (options.signal.aborted || generation !== this.generation) return;
          if (!(error instanceof ApiError) || error.status !== 401) throw error;
          const response = await this.fetch("/session", { method: "POST", credentials: "include", headers: { "X-Superlocal": "1" }, signal: options.signal });
          if (!response.ok) throw new Error("Sign in through the host application before opening this inbox.");
          this.client.clearCache();
        }
        if (generation !== this.generation) return;
        await this.refresh();
        if (generation === this.generation) { void this.follow(generation); this.scheduleAi(0); }
      } catch (error) { if (generation === this.generation) this.fail(error, "connect"); }
    })();
    return () => {
      window.removeEventListener("focus", onFocus);
      this.started = false; this.generation++; this.controller.abort();
      this.client.clearCache();
      clearTimeout(this.refreshTimer);
      clearTimeout(this.aiPollTimer); clearTimeout(this.aiHoldTimer); this.aiPollPromise = undefined; this.aiHolds.clear();
      clearTimeout(this.aiRebuildTimer); this.aiRebuildTimer = undefined; this.aiRebuildThreads.clear();
      for (const timer of this.saveTimers.values()) clearTimeout(timer);
      for (const timer of this.issueHolds.values()) clearTimeout(timer);
      this.saveTimers.clear(); this.issueHolds.clear(); this.loadingThreads.clear(); this.refreshPromise = undefined; this.updatesPromise = undefined; this.folderDiscovery = undefined;
      this.categoryReads = undefined;
      this.wake?.();
    };
  };

  /**
   * One event-stream loop per store. A rejected or dropped stream backs off with
   * jitter (bounded by MAX_BACKOFF_MS, never below the server's Retry-After) and
   * polls durable change history meanwhile, instead of refreshing the whole
   * snapshot every two seconds. Retry wakes the wait; ready resolves the notice.
   */
  private async follow(generation: number) {
    if (this.following) return;
    this.following = true;
    let attempt = 0, lastPoll = 0;
    let cursor: string | undefined;
    let healthy: ReturnType<typeof setTimeout> | undefined;
    try {
      while (this.started && generation === this.generation) {
        const openedAt = Date.now();
        let failure: unknown, failed = false;
        try {
          for await (const event of this.client.events({ ...this.requestOptions(), reconnect: false, ...(cursor ? { since: cursor } : {}) })) {
            if (generation !== this.generation) return;
            if (event.type === "ready") {
              const firstBaseline = cursor === undefined;
              cursor = event.state;
              clearTimeout(healthy);
              healthy = setTimeout(() => {
                if (generation !== this.generation) return;
                // Catch up once after a real interruption; a stream resumed from its cursor replays the rest itself.
                if (attempt > 0 || firstBaseline) this.scheduleRefresh();
                attempt = 0;
                if (this.state.live !== "live") this.publish({ live: "live" });
                this.resolve("live");
              }, STREAM_HEALTHY_MS);
            } else if ("state" in event) { cursor = event.state; this.scheduleRefresh(); }
            else {
              if (this.state.host?.inboxWindow && ["account.updated", "mailbox.updated", "connection.updated", "draft.updated", "operation.updated", "label.updated", "policy.updated"].includes(event.type)) {
                if (this.windowMetadataEvents.length < 100) this.windowMetadataEvents.push(event); else this.metadataPending = true;
              }
              cursor = event.id; this.scheduleRefresh();
            }
          }
        } catch (error) { failure = error; failed = true; }
        finally { clearTimeout(healthy); }
        if (!this.started || generation !== this.generation || this.controller.signal.aborted) return;
        // Streams rotate after five minutes; a stream that stayed healthy ends its incident, an error or immediate close backs off.
        const lived = Date.now() - openedAt;
        if (lived > STREAM_HEALTHY_MS) attempt = 0;
        if (!failed && lived > STREAM_HEALTHY_MS) continue;
        attempt++;
        const code = failed ? failureCode(failure) : "STREAM_CLOSED";
        const serverWait = retryAfter(failure);
        const delay = Math.max(serverWait, Math.round(Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempt - 1, 6) * (0.5 + Math.random()))));
        console.warn({ event: "inbox.action", action: "events", code, attempt, delayMs: delay });
        if (this.state.live !== "polling") this.publish({ live: "polling" });
        this.raise({ scope: "live", code, title: "Live updates paused", detail: liveDetail(code), retry: true });
        if (!lastPoll) lastPoll = Date.now();
        const notBefore = Date.now() + serverWait;
        const until = Date.now() + delay;
        while (Date.now() < until) {
          // A focus/Retry wake may shorten our own backoff, never the server's minimum wait.
          if (await this.sleep(Math.min(until - Date.now(), 5000)) && Date.now() >= notBefore) break;
          if (!this.started || generation !== this.generation) return;
          if (Date.now() - lastPoll >= POLL_MS && document.visibilityState === "visible") {
            lastPoll = Date.now();
            try { cursor = await this.pollChanges(cursor); }
            catch { /* The paused-stream notice already covers connectivity; polling stays quiet. */ }
          }
        }
      }
    } finally { this.following = false; }
  }
  /** Resolves true when Retry or focus asks for an immediate reconnect. */
  private sleep(ms: number): Promise<boolean> {
    return new Promise(resolve => {
      const done = (woken: boolean) => { clearTimeout(timer); this.controller.signal.removeEventListener("abort", abort); this.wake = undefined; resolve(woken); };
      const timer = setTimeout(() => done(false), ms);
      const abort = () => done(false);
      this.controller.signal.addEventListener("abort", abort, { once: true });
      this.wake = () => done(true);
    });
  }
  private async pollChanges(cursor?: string): Promise<string | undefined> {
    const page = await this.client.changes({ ...(cursor ? { since: cursor } : {}), limit: 100 }, this.requestOptions());
    // Without a cursor, changes() only returns a new baseline. Refresh once so
    // arrivals between the original snapshot and this baseline cannot be lost.
    if (!cursor || page.resetRequired || page.events.length) this.scheduleRefresh();
    return page.resetRequired || !page.hasMore ? page.state : page.events.at(-1)?.id ?? page.state;
  }
  private scheduleRefresh() {
    clearTimeout(this.refreshTimer);
    this.updateAgain = true;
    this.refreshTimer = setTimeout(() => void this.readUpdates().catch(error => this.fail(error, "refresh")), 100);
  }

  /** One coalesced owner of the scoped summary cursor; SSE only wakes it. */
  private readUpdates = (metadata = false): Promise<void> => {
    if (this.state.host?.inboxWindow) return this.readWindowChanges(metadata);
    this.metadataPending ||= metadata;
    if (this.updatesPromise) { this.updateAgain = true; return this.updatesPromise; }
    const signal = this.controller.signal, generation = this.generation;
    const work = (async () => {
      if (this.refreshPromise) await this.refreshPromise;
      if (!this.mailboxCursor) await this.bootstrap();
      let resets = 0;
      const timing = measurePerformance({ kind: "refresh", full: false });
      let pages = 0, messages = 0;
      try {
        do {
          this.updateAgain = false;
          const baseline = this.mailboxCursor;
          if (!baseline || signal.aborted || generation !== this.generation) break;
          const epoch = this.flagEpoch;
          const page = await this.client.mailboxChanges({ mailboxIds: baseline.mailboxIds, since: baseline.state, scopeState: baseline.scopeState, limit: 500 }, { signal });
          signal.throwIfAborted(); pages++; messages += page.upserts.length;
          if (this.mailboxCursor !== baseline) { this.updateAgain = true; continue; }
          if (page.resetRequired) {
            if (resets++) await pause(Math.min(30_000, resets * 1000), signal);
            await this.bootstrap(); this.updateAgain = true; continue;
          }
          const metadata = this.metadataPending; this.metadataPending = false;
          const meta = await this.updateMetadata(page.events, signal, metadata);
          if (generation !== this.generation || this.mailboxCursor !== baseline) { this.updateAgain = true; continue; }
          if (meta.reset) { await this.bootstrap(); this.updateAgain = true; continue; }
          const changed = new Map<string, MailboxMessageSummary | null>(), threads = meta.threads;
          const arrivals = new Set(page.events.filter(event => event.type === "mail.changed" && event.change === "created" && event.reason === "arrival" && event.accountId).map(event => nativeKey(event.accountId!, event.entityId)));
          let historyChanged = false;
          const historyFacts = (row?: MailboxMessageSummary) => row && [row.threadId, row.from, row.to, row.cc, row.subject, row.receivedAt, row.folder, row.memberships.map(state => state.mailboxId)];
          for (const received of page.upserts) {
            const key = nativeKey(received.sourceId, received.id), previous = this.messageRows.get(key), fence = this.summaryFences.get(key);
            if (!previous && fence?.removed === "deleted" && received.revision <= fence.revision) continue;
            const memberships = new Map(received.memberships.map(state => [state.mailboxId, state]));
            for (const state of previous?.memberships ?? []) {
              const incoming = memberships.get(state.mailboxId);
              if (incoming && incoming.revision < state.revision || !incoming && previous!.revision > received.revision) memberships.set(state.mailboxId, state);
            }
            const row = { ...(previous && previous.revision > received.revision ? previous : received), memberships: [...memberships.values()] };
            // Canonical and membership revisions are independent. An older
            // message cannot regress native fields, but may carry a newer
            // membership; neither kind of stale input advances a flag fence.
            if (!previous || received.revision >= previous.revision) this.summaryFences.set(key, { epoch, revision: received.revision });
            for (const state of received.memberships) {
              const receiptKey = membershipKey(row.sourceId, state), receipt = this.membershipReceipts.get(receiptKey);
              if (receipt && state.revision >= receipt.state.revision) this.membershipReceipts.delete(receiptKey);
            }
            if (previous && JSON.stringify(previous) === JSON.stringify(row)) continue;
            const threadKey = nativeKey(row.sourceId, row.threadId);
            if (!previous && arrivals.has(key) && !this.knownThreads.has(threadKey) && this.aiHolds.size < 256 && row.folder === "inbox" && !row.folderIds.includes("sent")
              && this.state.ai?.configured && this.state.ai.settings.enabled && this.state.ai.settings.mode === "apply"
              && (this.state.ai.settings.mailboxIds === null || row.memberships.some(member => this.state.ai!.settings.mailboxIds!.includes(member.mailboxId)))) {
              // Only genuinely new conversations get a small presentation hold.
              // Cached mail, history imports, existing readers and send receipts never wait.
              this.aiHolds.set(threadKey, { until: Date.now() + 1500, latestMessageId: row.id });
            }
            this.knownThreads.add(threadKey);
            historyChanged ||= JSON.stringify(historyFacts(previous)) !== JSON.stringify(historyFacts(row));
            if (previous) threads.add(nativeKey(previous.sourceId, previous.threadId));
            threads.add(nativeKey(row.sourceId, row.threadId)); changed.set(key, row); this.messageRows.set(key, row);
          }
          for (const removed of page.removed) {
            const key = nativeKey(removed.sourceId, removed.messageId), previous = this.messageRows.get(key);
            const fence = this.summaryFences.get(key);
            if (removed.reason === "deleted" && removed.revision !== null && removed.revision < (previous?.revision ?? fence?.revision ?? 0)) continue;
            this.summaryFences.set(key, { epoch, revision: removed.reason === "deleted" ? removed.revision ?? previous?.revision ?? 0 : 0, removed: removed.reason });
            if (previous) { historyChanged = true; threads.add(nativeKey(previous.sourceId, previous.threadId)); changed.set(key, null); this.messageRows.delete(key); }
            // Unselection removes only this receiving scope, not the source's
            // immutable body cache or another source with a similar message.
            if (removed.reason === "deleted") this.details.delete(removed.messageId);
            for (const [receiptKey, receipt] of this.membershipReceipts) if (receipt.sourceId === removed.sourceId && receipt.state.messageId === removed.messageId && baseline.mailboxIds.includes(receipt.state.mailboxId)) this.membershipReceipts.delete(receiptKey);
          }
          if (changed.size) for (const box of this.boxes) {
            const seen = new Set<string>(), rows: MailboxMessageSummary[] = [];
            for (const old of this.summaries.get(box.id) ?? []) {
              const key = nativeKey(old.sourceId, old.id), next = changed.has(key) ? changed.get(key) : old;
              if (next?.memberships.some(state => state.mailboxId === box.id)) { rows.push(next); seen.add(key); }
            }
            for (const [key, row] of changed) if (row && !seen.has(key) && row.memberships.some(state => state.mailboxId === box.id)) rows.push(row);
            this.summaries.set(box.id, rows);
          }
          for (const thread of this.reconcileFlags()) threads.add(thread);
          if (threads.size || meta.sending) this.rebuild(threads, changed.size > 0, meta.sending, historyChanged);
          else if (this.calendarKey !== displayTimes().key) this.rebuild();
          if (this.aiHolds.size) { this.releaseAiHolds(); this.scheduleAi(0); }
          this.mailboxCursor = { ...baseline, state: page.state };
          this.updateAgain ||= page.hasMore;
          this.resolve("snapshot");
          if (!this.updateAgain && this.catchingUp) {
            this.catchingUp = false; this.publish({ loading: false, loaded: true, refreshing: false, error: null });
          } else if (this.state.error) this.publish({ error: null });
        } while (this.updateAgain && !signal.aborted);
        timing({ pages, messages });
        void this.readCategories();
      } catch (error) { timing({ pages, messages, outcome: "error" }); throw error; }
    })().finally(() => {
      if (this.updatesPromise !== work) return;
      this.updatesPromise = undefined;
      if (this.updateAgain && !signal.aborted && generation === this.generation) this.scheduleRefresh();
    });
    this.updatesPromise = work; return work;
  };

  private async updateMetadata(events: ChangeEvent[], signal: AbortSignal, force: boolean) {
    const types = new Set(events.map(event => event.type)), threads = new Set<string>();
    const affectedSources = new Set<string>();
    const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
    const epoch = this.draftEpoch, bodyEpoch = this.bodyEpoch, feedbackEpoch = this.feedbackEpoch;
    let sendingChanged = false;
    if (force || ["account.updated", "mailbox.updated", "connection.updated"].some(type => types.has(type as ChangeEvent["type"]))) {
      const [accounts, boxes] = await Promise.all([this.client.accounts({ signal }), this.client.mailboxes({ signal })]);
      const previousAccounts = this.sourceAccounts;
      const selected = boxes.filter(box => box.status !== "detached");
      if (!same(selected.map(box => [box.id, box.sourceId, box.selector, box.status]), this.boxes.map(box => [box.id, box.sourceId, box.selector, box.status]))) return { reset: true, threads, sending: false };
      const presentation = (account?: Account) => account && { email: account.email, name: account.name, status: account.status, capabilities: account.capabilities, features: account.features, generation: account.generation };
      for (const account of accounts) if (!same(presentation(account), presentation(previousAccounts.find(previous => previous.id === account.id)))) affectedSources.add(account.id);
      for (const box of selected) if (!same(box, this.boxes.find(previous => previous.id === box.id))) affectedSources.add(box.sourceId);
      this.sourceAccounts = accounts; this.boxes = selected;
      if (!same(accounts, this.state.sources) || !same(selected, this.state.mailboxes)) this.publish({ sources: accounts, mailboxes: selected });
      const folderSources = new Set(events.filter(event => event.type === "account.updated" && event.accountId).map(event => event.accountId!));
      for (const id of folderSources) if (accounts.some(account => account.id === id && account.status === "connected")) {
        // Import progress changes sync/revision, not the folder catalog. A
        // catalog-only account event leaves account data equal, so still reads.
        if (this.folders.has(id) && !affectedSources.has(id) && !same(accounts.find(account => account.id === id), previousAccounts.find(account => account.id === id))) continue;
        const folders = await this.client.cachedFolders(id, { signal });
        if (!same(folders, this.folders.get(id))) { this.folders.set(id, folders); affectedSources.add(id); }
      }
    }
    if (force || types.has("label.updated")) {
      const labels = await this.client.labels(undefined, { signal });
      if (!same(labels, this.labels)) { for (const label of [...labels, ...this.labels]) affectedSources.add(label.accountId); this.labels = labels; }
    }
    if (force || types.has("policy.updated")) {
      const policy = await this.client.policy({ signal });
      if (bodyEpoch === this.bodyEpoch && !same(policy, this.state.policy)) {
        if (this.state.policy?.remoteImages !== policy.remoteImages) {
          for (const detail of this.details.values()) { const row = this.messageRows.get(nativeKey(detail.accountId, detail.id)); if (row) threads.add(nativeKey(row.sourceId, row.threadId)); }
          this.bodyEpoch++; this.details.clear();
        }
        this.publish({ policy });
      }
    }
    if (force) {
      const [host, preferences] = await Promise.all([readHostConfiguration(signal), readInboxViewPreferences(signal)]);
      if (host.preferenceScope !== this.state.host?.preferenceScope) return { reset: true, threads, sending: false };
      const [splitPreferences, feedback] = host.preferenceScope ? await Promise.all([readSplitPreferences(signal), readAttentionFeedback(signal)]) : [null, []];
      const patch: Partial<InboxSnapshot> = {};
      if (!same(host, this.state.host)) { patch.host = host; for (const source of this.sourceAccounts) affectedSources.add(source.id); }
      if (preferences.revision >= (this.state.viewPreferences?.revision ?? 0) && !same(preferences, this.state.viewPreferences)) {
        patch.viewPreferences = preferences; for (const source of this.sourceAccounts) affectedSources.add(source.id);
      }
      if (!same(splitPreferences, this.state.splitPreferences) && (splitPreferences?.revision ?? 0) >= (this.state.splitPreferences?.revision ?? 0)) patch.splitPreferences = splitPreferences;
      if (feedbackEpoch === this.feedbackEpoch && !same(feedback, this.state.attentionFeedback)) patch.attentionFeedback = feedback;
      if (Object.keys(patch).length) this.publish(patch);
      this.scheduleAi(0);
    }
    const drafts = new Map(this.rawDrafts);
    if (force) { const current = await this.client.drafts(undefined, { signal }); drafts.clear(); for (const draft of current) drafts.set(draft.id, draft); }
    else for (const id of new Set(events.filter(event => event.type === "draft.updated").map(event => event.entityId))) {
      try { const draft = await this.client.draft(id, { signal }); if (draft.status === "active") drafts.set(id, draft); else drafts.delete(id); }
      catch (error) { if (error instanceof ApiError && error.status === 404) drafts.delete(id); else throw error; }
    }
    const trackedSources = new Set(this.sourceAccounts.map(account => account.id));
    const changedOperations = new Set(events.filter(event => event.type === "operation.updated").map(event => event.entityId));
    for (const ref of this.references.filter(ref => trackedSources.has(ref.accountId) && (force || changedOperations.has(ref.id)))) {
      try {
        const before = this.operations.get(ref.id);
        const operation = await this.client.operation(ref.id, { signal });
        if (operation.accountId !== ref.accountId || this.operations.get(ref.id) !== before) continue;
        if (same(operation, this.operations.get(ref.id))) continue;
        const previous = this.sending.get(ref.id);
        for (const id of [previous?.draft.sourceMessageId, ...operation.results.map(result => result.messageId)]) {
          const row = id && this.messageRows.get(nativeKey(ref.accountId, id)); if (row) threads.add(nativeKey(row.sourceId, row.threadId));
        }
        let pending: Sending | undefined;
        if (operation.type === "send" && ["pending", "processing", "failed", "uncertain"].includes(operation.status)) {
          const draft = await this.client.draft(ref.draftId, { signal });
          if (draft.accountId === ref.accountId) pending = { ref, operation, draft };
        }
        if (this.operations.get(ref.id) !== before) continue;
        this.operations.set(ref.id, operation); this.sending.delete(ref.id); if (pending) this.sending.set(ref.id, pending); sendingChanged = true;
      } catch (error) { if (!(error instanceof ApiError) || error.status !== 404) throw error; }
    }
    if (epoch === this.draftEpoch && !same([...drafts], [...this.rawDrafts])) {
      for (const raw of drafts.values()) for (const id of raw.attachmentIds) if (!this.blobInfo.has(id)) {
        const response = await this.fetch(`/v1/blobs/${encodeURIComponent(id)}`, { method: "HEAD", credentials: "include", signal });
        if (!response.ok) throw new Error("Could not read draft attachment metadata.");
        const info = JSON.parse(decodeURIComponent(response.headers.get("x-inbox-blob-info") || "")) as BlobInfo;
        if (info.id !== id || info.accountId !== raw.accountId) throw new Error("The attachment metadata belongs to another source.");
        this.blobInfo.set(id, info);
      }
      if (epoch !== this.draftEpoch) return { reset: false, threads, sending: sendingChanged };
      this.rawDrafts = drafts;
      this.publish({ drafts: [...drafts.values()].map(raw => {
        const edit = this.edits.get(raw.id);
        return { ...(edit?.draft ?? this.uiDraft(raw)), popOut: this.popouts.get(raw.id) ?? edit?.draft.popOut ?? false,
          saving: this.saves.has(raw.id) || !!edit && !edit.error && completeRecipients(edit.draft), dirty: !!edit, saveError: edit?.error, sendError: this.sendErrors.get(raw.id) };
      }) });
    }
    for (const row of this.messageRows.values()) if (affectedSources.has(row.sourceId)) threads.add(nativeKey(row.sourceId, row.threadId));
    if (force) void this.discoverFolders();
    return { reset: false, threads, sending: sendingChanged };
  }

  private discoverFolders(): Promise<void> {
    if (this.folderDiscovery) return this.folderDiscovery;
    const signal = this.controller.signal, generation = this.generation;
    const work = (async () => {
      for (const account of this.sourceAccounts) {
        const key = `${account.id}\0${account.generation}`;
        if (account.status !== "connected" || this.discoveredFolders.has(key)) continue;
        this.discoveredFolders.add(key);
        try {
          const folders = (await this.client.folders(account.id, { signal })).sort((a, b) => a.id.localeCompare(b.id));
          if (signal.aborted || generation !== this.generation) return;
          if (this.sourceAccounts.find(current => current.id === account.id)?.generation !== account.generation) continue;
          if (JSON.stringify(folders) === JSON.stringify([...(this.folders.get(account.id) ?? [])].sort((a, b) => a.id.localeCompare(b.id)))) continue;
          this.folders.set(account.id, folders);
          const threads = new Set([...this.messageRows.values()].filter(row => row.sourceId === account.id).map(row => nativeKey(row.sourceId, row.threadId)));
          this.rebuild(threads.size ? threads : undefined);
        } catch (error) {
          this.discoveredFolders.delete(key);
          if (!signal.aborted) this.fail(error, "refresh");
        }
      }
    })().finally(() => { if (this.folderDiscovery === work) this.folderDiscovery = undefined; });
    this.folderDiscovery = work; return work;
  }

  refresh = (force = false): Promise<void> => this.updatesPromise ? this.updatesPromise.then(() => this.bootstrap(force)) : this.bootstrap(force);
  private bootstrap = (force = false): Promise<void> => {
    if (this.refreshPromise) return force ? this.refreshPromise.then(() => this.bootstrap()) : this.refreshPromise;
    const timing = measurePerformance({ kind: "refresh", full: true });
    let pages = 0, messages = 0, networkMs = 0;
    const generation = this.generation, options = this.requestOptions();
    const draftEpoch = this.draftEpoch;
    const flagEpoch = this.flagEpoch;
    const feedbackEpoch = this.feedbackEpoch;
    const policyAtStart = this.state.policy;
    this.publish({ refreshing: true });
    const load = async () => {
      // Fence metadata before reading it, not only the later mail inventory.
      // Catch-up can then refresh actual intervening metadata events without
      // repeating every bootstrap read on the path to the first usable inbox.
      const metadataBaseline = await this.client.changes({}, options);
      const [accounts, boxes, labels, drafts, policy, host, viewPreferences] = await Promise.all([
        this.client.accounts(options), this.client.mailboxes(options), this.client.labels(undefined, options), this.client.drafts(undefined, options), this.client.policy(options),
        readHostConfiguration(options.signal),
        readInboxViewPreferences(options.signal),
      ]);
      // A running host may lag a hot-reloaded web bundle. Keep cached mail
      // available, but do not simulate durable settings/feedback on an old host.
      const [savedSplits, attentionFeedback]: [SavedSplitPreferences | null, AttentionFeedback[]] = host.preferenceScope
        ? await Promise.all([readSplitPreferences(options.signal), readAttentionFeedback(options.signal)]) : [null, []];
      let splitPreferences = savedSplits;
      if (host.preferenceScope && !splitPreferences) {
        // Legacy browser preferences have no owner. Bind their one-time import
        // to this host identity; never copy them into a later, unrelated owner.
        const scope = host.preferenceScope;
        const bound = this.storage.readSaved<string | null>("legacy-split-owner", null);
        const importLegacy = this.applicationScope.scope === null && !!scope && (!bound || bound === scope);
        if (importLegacy && !this.storage.writeSaved("legacy-split-owner", scope)) throw new Error("Your existing splits could not be bound to this inbox. Browser storage must be available before importing them.");
        const legacy = importLegacy ? this.storage.readSaved<Record<string, unknown>>("preferences", {}) : {};
        try { splitPreferences = await writeSplitPreferences({ ...normalizeSplits({ ...legacy, version: undefined }), revision: 0 }, options.signal); }
        catch (error) {
          if (!(error instanceof InboxViewPreferencesError) || error.status !== 412) throw error;
          splitPreferences = await readSplitPreferences(options.signal);
          if (!splitPreferences) throw error;
        }
      }
      const selected = boxes.filter(box => box.status !== "detached");
      const summaries = new Map<string, MailboxMessageSummary[]>(selected.map(box => [box.id, []]));
      const mailboxIds = selected.map(box => box.id);
      let baseline: typeof this.mailboxCursor;
      // The fixed ID inventory finishes even while imports append mail. Its
      // scope is separate from the SSE cursor. Catch-up uses its signed scope
      // and the earlier metadata baseline, covering both reads after the last
      // page, never a newly sampled global ready token.
      if (host.inboxWindow) {
        // New hosts always use app-view windows. Errors never fall through to inventory.
      } else if (mailboxIds.length && mailboxIds.length <= 1000) {
          const items: MailboxMessageSummary[] = [];
          const snapshot = this.client.mailboxSnapshotPages({ mailboxIds, limit: 500 }, options);
          try {
            for (;;) {
              const started = performance.now();
              const result = await snapshot.next();
              networkMs += performance.now() - started;
              if (result.done) break;
              const page = result.value; pages++; messages += page.items.length;
              baseline = { state: metadataBaseline.state, scopeState: page.scopeState, mailboxIds };
              items.push(...page.items);
            }
          } finally { await snapshot.return?.(); }
          for (const item of items) for (const membership of item.memberships) summaries.get(membership.mailboxId)?.push(item);
      } else if (mailboxIds.length) {
        // Preserve the older >1000-view capability. This exceptional scope
        // keeps its legacy scans rather than pretending an unsupported shared
        // inventory/delta cursor can represent every mailbox.
        for (let offset = 0; offset < mailboxIds.length; offset += 50) {
          let cursor: string | undefined;
          do {
            const page = await this.client.mailboxMessages({ mailboxIds: mailboxIds.slice(offset, offset + 50), limit: 100, ...(cursor ? { cursor } : {}) }, options);
            pages++; messages += page.items.length;
            for (const item of page.items) for (const membership of item.memberships) summaries.get(membership.mailboxId)?.push(item);
            cursor = page.nextCursor ?? undefined;
          } while (cursor);
        }
      }
      for (const account of accounts) if (!this.folders.has(account.id) && account.status === "connected") {
        this.folders.set(account.id, await this.client.cachedFolders(account.id, options));
      }
      for (const draft of drafts) for (const id of draft.attachmentIds) if (!this.blobInfo.has(id)) {
        const response = await this.fetch(`/v1/blobs/${encodeURIComponent(id)}`, { method: "HEAD", credentials: "include", signal: options.signal });
        if (!response.ok) throw new Error("Could not read draft attachment metadata.");
        const info = JSON.parse(decodeURIComponent(response.headers.get("x-inbox-blob-info") || "")) as BlobInfo;
        if (info.id !== id || info.accountId !== draft.accountId) throw new Error("The attachment metadata belongs to another source.");
        this.blobInfo.set(id, info);
      }
      const sending = new Map<string, Sending>();
      const operations = new Map<string, Operation>();
      for (const ref of this.references.filter(ref => accounts.some(account => account.id === ref.accountId))) {
        try {
          const operation = await this.client.operation(ref.id, options);
          if (operation.accountId !== ref.accountId) continue;
          operations.set(operation.id, operation);
          if (operation.type === "send" && ["pending", "processing", "failed", "uncertain"].includes(operation.status)) {
            const draft = await this.client.draft(ref.draftId, options);
            if (draft.accountId === ref.accountId) sending.set(ref.id, { ref, operation, draft });
          }
          const previous = this.operations.get(operation.id);
          if (previous && ["pending", "processing", "uncertain"].includes(previous.status) && ["succeeded", "partial"].includes(operation.status)) {
            const rows = summaries.get(ref.mailboxId);
            if (rows) for (const result of operation.results.filter(result => result.status === "succeeded")) {
              try {
                const message = await this.client.mailboxMessage(ref.mailboxId, result.messageId, options);
                if (message.accountId !== ref.accountId) throw new Error("The send result belongs to another source.");
                this.details.set(message.id, message);
                const index = rows.findIndex(row => row.id === message.id);
                if (index === -1) rows.push(message); else rows[index] = message;
              } catch (error) { if (!(error instanceof ApiError) || error.status !== 404) throw error; }
            }
          }
        } catch (error) { if (!(error instanceof ApiError) || error.status !== 404) throw error; }
      }
      if (generation !== this.generation) return;
      if (this.draftEpoch !== draftEpoch) for (const [id, operation] of this.operations) if (!operations.has(id)) {
        operations.set(id, operation);
        const pending = this.sending.get(id); if (pending) sending.set(id, pending);
      }
      this.operations = operations;
      this.sourceAccounts = accounts; this.boxes = selected; this.labels = labels; this.summaries = summaries; this.sending = sending;
      if (!host.inboxWindow) {
      this.messageRows = new Map([...summaries.values()].flat().map(row => [nativeKey(row.sourceId, row.id), row]));
      this.summaryFences = new Map([...this.messageRows].map(([key, row]) => [key, { epoch: flagEpoch, revision: row.revision }]));
      for (const write of this.flagWrites) for (const target of write.targets) if (!this.messageRows.has(nativeKey(target.sourceId, target.messageId))) {
        this.summaryFences.set(nativeKey(target.sourceId, target.messageId), { epoch: flagEpoch, revision: 0, removed: "absent" });
      }
      if (this.mailboxCursor && this.mailboxCursor.scopeState !== baseline?.scopeState) { this.bodyEpoch++; this.details.clear(); this.categoryCursor = 0; this.categoryEpoch++; }
      this.mailboxCursor = baseline;
      this.reconcileFlags();
      for (const [key, receipt] of this.membershipReceipts) {
        const row = summaries.get(receipt.state.mailboxId)?.find(row => row.sourceId === receipt.sourceId && row.id === receipt.state.messageId);
        const state = row?.memberships.find(state => state.mailboxId === receipt.state.mailboxId);
        if (!state || state.revision >= receipt.state.revision) this.membershipReceipts.delete(key);
      }
      }
      if (this.draftEpoch === draftEpoch) this.rawDrafts = new Map(drafts.map(draft => [draft.id, draft]));
      else this.scheduleRefresh();
      for (const raw of drafts) {
        const recovered = this.recovery[raw.id];
        if (recovered && !this.edits.has(raw.id) && recovered.draft?.sourceId === raw.accountId) {
          this.edits.set(raw.id, { draft: recovered.draft, revision: recovered.revision, version: 1,
            ...(raw.revision !== recovered.revision ? { error: "This draft changed elsewhere. Your local writing has been kept; reload the draft before replacing it." } : {}) });
          if (raw.revision === recovered.revision && completeRecipients(recovered.draft)) this.saveTimers.set(raw.id, setTimeout(() => void this.flushDraft(raw.id).catch(() => {}), 450));
        }
      }
      const currentPolicy = this.state.policy !== policyAtStart && this.state.policy ? this.state.policy : policy;
      if (this.state.policy && this.state.policy.remoteImages !== currentPolicy.remoteImages) {
        this.bodyEpoch++;
        this.details.clear();
      }
      if (host.inboxWindow) {
        this.publish({ policy: currentPolicy, host, viewPreferences, splitPreferences, attentionFeedback: this.feedbackEpoch === feedbackEpoch ? attentionFeedback : this.state.attentionFeedback, mailboxes: selected, sources: accounts });
        this.rebuildWindow();
        await this.openWindow();
        void this.discoverFolders();
        return;
      }
      this.catchingUp = !!baseline;
      this.publish({ policy: currentPolicy, host, viewPreferences, splitPreferences, attentionFeedback: this.feedbackEpoch === feedbackEpoch ? attentionFeedback : this.state.attentionFeedback, mailboxes: selected, sources: accounts,
        loading: !this.state.loaded && this.catchingUp, loaded: this.state.loaded || !this.catchingUp, refreshing: this.catchingUp, error: null }); this.rebuild();
      this.resolve("snapshot");
      if (baseline) this.scheduleRefresh();
      void this.readCategories();
      void this.discoverFolders();
    };
    const work = (async () => {
      for (let attempt = 0; ; attempt++) {
        try { await load(); return; }
        catch (error) {
          if (!(error instanceof ApiError) || !["SNAPSHOT_EXPIRED", "SNAPSHOT_SCOPE_CHANGED", "NOT_FOUND", "STALE_CURSOR"].includes(error.code) || attempt >= 1) throw error;
          // Re-read authorized mailbox metadata before restarting; never retry
          // a detached or foreign old selection on its own.
        }
      }
    })();
    this.refreshPromise = work.then(() => { timing({ pages, messages, networkMs, conversations: this.state.mail.length }); }, error => {
      timing({ pages, messages, networkMs, outcome: "error" }); throw error;
    }).finally(() => { if (this.refreshPromise === finished) this.refreshPromise = undefined; });
    const finished = this.refreshPromise;
    return finished;
  };

  private file(info: BlobInfo): Attachment {
    this.blobInfo.set(info.id, info);
    return { name: info.filename, size: info.size, type: info.contentType, blobId: info.id, sourceId: info.accountId, data: `/v1/blobs/${encodeURIComponent(info.id)}` };
  }
  loadDraftParent = async (id: string, account = this.windowQuery.account) => {
    const draft = this.rawDrafts.get(id), generation = this.generation;
    if (!this.state.host?.inboxWindow || !draft?.sourceMessageId || !draft.mailboxId) return;
    const summary = await this.client.mailboxMessageSummary(draft.mailboxId, draft.sourceMessageId, this.requestOptions());
    if (generation !== this.generation || this.rawDrafts.get(id)?.sourceMessageId !== draft.sourceMessageId) return;
    if (summary.sourceId !== draft.accountId) throw new Error("The draft parent belongs to a different source.");
    const threadId = account === UNIFIED_ACCOUNT ? unifiedThreadId(summary.sourceId, summary.threadId) : viewThreadId(account, summary.threadId);
    this.draftParents.set(id, { sourceMessageId: draft.sourceMessageId, threadId });
    this.pinWindow(`draft:${id}`, [threadId]); await this.lookupWindow([threadId], account);
  };
  private uiDraft(raw: SdkDraft): Draft {
    const box = this.boxes.find(box => box.id === raw.mailboxId) ?? this.boxes.find(box => box.sourceId === raw.accountId);
    const parent = raw.sourceMessageId && [...this.summaries.values()].flat().find(message => message.id === raw.sourceMessageId);
    const known = [...this.blobInfo.values(), ...[...this.details.values()].flatMap(message => message.attachments)];
    return {
      id: raw.id, account: box?.id ?? "", sourceId: raw.accountId, from: raw.from,
      sourceMessageId: raw.sourceMessageId, revision: raw.revision,
      mode: raw.mode === "compose" ? "new" : raw.mode,
      threadId: parent && box ? viewThreadId(box.id, parent.threadId) : this.draftParents.get(raw.id)?.threadId,
      popOut: this.popouts.get(raw.id) ?? false, to: addresses(raw.to), cc: addresses(raw.cc), bcc: addresses(raw.bcc), subject: raw.subject,
      body: draftHtml(raw.bodyHtml || `<div>${escapeHTML(raw.bodyText).replaceAll("\n", "<br>")}</div>`),
      attachments: raw.attachmentIds.map(id => { const info = known.find(info => info.id === id); return info ? this.file(info) : { name: "Attachment", size: 0, type: "application/octet-stream", blobId: id, sourceId: raw.accountId, data: `/v1/blobs/${encodeURIComponent(id)}` }; }),
      updated: Date.parse(raw.updatedAt),
    };
  }
  private rebuildWindow() {
    const calendar = displayTimes(); this.calendarKey = calendar.key;
    const rows = [...this.windowRows.values()];
    const summaries = new Map<string, MailboxMessageSummary>();
    for (const row of rows) for (const summary of this.windowDetails.get(row.key)?.summaries ?? row.summaries) {
      const key = nativeKey(summary.sourceId, summary.id), previous = summaries.get(key);
      const memberships = new Map([...(previous?.memberships ?? []), ...summary.memberships].map(state => [state.mailboxId, state]));
      summaries.set(key, { ...(previous && previous.revision > summary.revision ? previous : summary), memberships: [...memberships.values()] });
    }
    this.messageRows = summaries;
    const attachmentIds = new Set([...this.rawDrafts.values()].flatMap(draft => draft.attachmentIds));
    for (const detail of this.details.values()) for (const attachment of detail.attachments) attachmentIds.add(attachment.id);
    for (const edit of this.edits.values()) for (const attachment of edit.draft.attachments) if (attachment.blobId) attachmentIds.add(attachment.blobId);
    for (const id of this.blobInfo.keys()) if (!attachmentIds.has(id)) this.blobInfo.delete(id);
    const pendingKeys = new Set([...this.flagWrites].flatMap(write => write.targets.map(target => nativeKey(target.sourceId, target.messageId))));
    for (const key of this.summaryFences.keys()) if (!summaries.has(key) && !pendingKeys.has(key)) this.summaryFences.delete(key);
    this.summaries = new Map(this.boxes.map(box => [box.id, [...summaries.values()].filter(row => row.memberships.some(state => state.mailboxId === box.id))]));
    const projected = projectMailboxMail({ sources: this.sourceAccounts, mailboxes: this.boxes, summaries: [...summaries.values()].map(row => this.projectFlags(row)),
      labels: this.labels, folders: this.folders, includedMailboxIds: this.unifiedMailboxIds(), allowProviderWrites: this.state.host?.allowProviderWrites === true,
      now: Date.now(), displayTime: calendar.format, decorateMessage: (message, summary) => {
        const detail = this.cachedDetail(summary);
        return detail ? { ...message, bcc: addresses(detail.bcc), body: detail.bodyHtml, bodyText: detail.bodyText,
          bodyFormat: detail.bodyFormat, bodyDocument: detail.bodyDocument, loaded: true, attachments: detail.attachments.map(info => this.file(info)) } : message;
      } });
    const byId = new Map(projected.mail.map(mail => [mail.id, mail])), previous = new Map(this.state.mail.map(mail => [mail.id, mail]));
    const mail = rows.map(row => {
      const local = byId.get(row.key), detail = this.windowDetails.get(row.key), provenance = this.rowProvenance(row);
      if (detail?.exhausted && row.counts.messages === detail.summaries.length) { provenance.messagesComplete = true; provenance.actionContextComplete = row.targetsComplete; }
      // Whole-conversation aggregate/provenance always wins over partial projected metadata.
      const time = Number.isFinite(row.mail.receivedAt) ? calendar.format(new Date(row.mail.receivedAt!).toISOString()) : { date: row.mail.date, group: row.mail.group };
      let next: Mail = { ...row.mail, ...time, messages: local?.messages ?? row.mail.messages, window: provenance,
        hasAttachments: row.mail.hasAttachments ?? (row.messagesComplete ? row.mail.messages.some(message => message.hasAttachments) : undefined), historyExhausted: detail?.exhausted ?? row.messagesComplete };
      const overlay = row.summaries.some(summary => this.projectFlags(summary) !== summary);
      if (overlay && local) {
        if (provenance.messagesComplete) next = { ...next, unread: local.unread, starred: local.starred, folder: local.folder, locations: local.locations, reminder: local.reminder, reminderAt: local.reminderAt };
        else {
          const intents = row.summaries.flatMap(summary => [this.flagIntents.get(`${nativeKey(summary.sourceId, summary.id)}\0isRead`), this.flagIntents.get(`${nativeKey(summary.sourceId, summary.id)}\0isStarred`)]).filter(Boolean);
          if (intents.some(intent => intent!.field === "isRead" && !intent!.value)) next.unread = true;
          if (intents.some(intent => intent!.field === "isStarred" && intent!.value)) next.starred = true;
          const states = provenance.targets.map(target => this.membershipReceipts.get(`${row.sourceId}\0${target.messageId}\0${target.mailboxId}`)?.state);
          if (provenance.targetsComplete && states.length && states.every(state => state?.done)) { next.folder = "Done"; next.locations = ["Done"]; }
        }
      }
      const category = this.categories.get(nativeKey(row.sourceId, row.threadId));
      if (category && provenance.actionContextComplete && currentCategoryOverride(next, category.override)) {
        next = { ...next, attentionOverride: category }; next.split = conversationAttention(next);
      }
      const old = previous.get(row.key);
      return old && JSON.stringify(old) === JSON.stringify(next) ? old : next;
    });
    // Queued sends are local draft state, never credited as received indexed conversations.
    for (const { ref, operation, draft } of this.sending.values()) {
      if (!["pending", "processing", "uncertain"].includes(operation.status)) continue;
      const parent = mail.find(mail => mail.sourceId === draft.accountId && mail.messages.some(message => message.id === draft.sourceMessageId));
      const pending: Message = { id: `pending:${operation.id}`, operationId: operation.id, sendStatus: operation.status, pending: true,
        from: draft.from, email: draft.from, to: addresses(draft.to), cc: addresses(draft.cc), date: "Queued", body: draftHtml(draft.bodyHtml || escapeHTML(draft.bodyText)), loaded: true, outgoing: true };
      if (parent) { const i = mail.indexOf(parent); mail[i] = { ...parent, messages: [...parent.messages, pending] }; }
      else if (this.windowQuery.folder === "Scheduled" && operation.status !== "uncertain" && (this.windowQuery.account === ref.mailboxId || this.windowQuery.account === UNIFIED_ACCOUNT && this.unifiedMailboxIds().includes(ref.mailboxId))) mail.push({ id: `operation:${operation.id}`, operationId: operation.id, account: this.windowQuery.account, mailboxId: ref.mailboxId,
        sourceId: operation.accountId, from: draft.from, email: draft.from, to: addresses(draft.to), subject: draft.subject, snippet: draft.bodyText,
        ...displayTimes().format(operation.sendAt || operation.createdAt), folder: "Scheduled", split: "Important", unread: false, starred: false, labels: [], messages: [pending] });
    }
    const drafts = [...this.rawDrafts.values()].map(raw => {
      const edit = this.edits.get(raw.id);
      return { ...(edit?.draft ?? this.uiDraft(raw)), popOut: this.popouts.get(raw.id) ?? edit?.draft.popOut ?? false,
        saving: this.saves.has(raw.id) || !!edit && !edit.error && completeRecipients(edit.draft), dirty: !!edit, saveError: edit?.error, sendError: this.sendErrors.get(raw.id) };
    });
    const window = this.state.window;
    let keys = window?.keys;
    if (window && !window.query.search && window.query.folder === "Inbox") {
      const visible = new Map(mail.map(mail => [mail.id, mail]));
      keys = window.keys.filter(key => {
        const item = visible.get(key), source = this.windowRows.get(key);
        const removed = item && source && source.mail.locations?.includes("Inbox") && !item.locations?.includes("Inbox");
        if (removed) this.windowLocalRemoved.set(key, window.state.queryId);
        return !removed;
      });
      for (const [key, queryId] of this.windowLocalRemoved) if (queryId === window.state.queryId && visible.get(key)?.locations?.includes("Inbox")) {
        keys.push(key); this.windowLocalRemoved.delete(key);
      }
      keys = [...new Set(keys)].sort((a, b) => (visible.get(b)?.receivedAt ?? 0) - (visible.get(a)?.receivedAt ?? 0) || a.localeCompare(b));
    }
    this.publish({ mail, ...(window && keys ? { window: { ...window, keys } } : {}), accounts: JSON.stringify(projected.accounts) === JSON.stringify(this.state.accounts) ? this.state.accounts : projected.accounts,
      labels: projected.labels, senderHistory: [], drafts, unsaved: this.edits.size > 0 || this.saves.size > 0, operations: Object.fromEntries(this.operations) });
  }

  private rebuild(onlyThreads?: Set<string>, summariesChanged = false, sendingChanged = false, historyChanged = summariesChanged) {
    if (this.state.host?.inboxWindow) { this.rebuildWindow(); return; }
    if (onlyThreads && !onlyThreads.size && !sendingChanged) return;
    const calendar = displayTimes(), displayTime = calendar.format;
    if (this.calendarKey !== undefined && this.calendarKey !== calendar.key) onlyThreads = undefined;
    this.calendarKey = calendar.key;
    const timing = measurePerformance({ kind: "rebuild", full: !onlyThreads });
    const accounts: MailboxOption[] = this.boxes.map(box => {
      const source = this.sourceAccounts.find(account => account.id === box.sourceId)!;
      return { id: box.id, sourceId: source.id, sourceGeneration: source.generation, name: box.name || source.name, email: box.defaultSender || source.email, selectorKind: box.selector.kind,
        canSend: this.state.host?.allowProviderWrites === true && source.status === "connected" && box.status === "active" && source.capabilities.send && !!box.defaultSender };
    });
    const mail: Mail[] = [], labelNames: Record<string, string[]> = {};
    const senderHistory = new Map<string, SenderHistoryMessage>();
    const sentMessages = new Map<string, Operation>();
    for (const operation of this.operations.values()) if (operation.type === "send") {
      for (const result of operation.results) if (result.status === "succeeded") sentMessages.set(result.messageId, operation);
    }
    for (const box of this.boxes) {
      const source = this.sourceAccounts.find(account => account.id === box.sourceId)!;
      const nativeFolders = this.folders.get(source.id) ?? [];
      const labels = this.labels.filter(label => label.accountId === source.id);
      labelNames[box.id] = [...new Set([...labels.map(label => label.name), ...nativeFolders.filter(folder => folder.kind === "label").map(folder => folder.name)])];
      const groups = new Map<string, MailboxMessageSummary[]>();
      for (const summary of this.summaries.get(box.id) ?? []) {
        if (onlyThreads && !onlyThreads.has(nativeKey(source.id, summary.threadId))) continue;
        // Only the changed native fields are local. Fresh subjects, bodies,
        // memberships and arrivals continue to come from the SDK snapshot.
        const row = this.projectFlags(summary);
        // Reuse normalized, body-free SDK facts. Overlapping views contribute
        // memberships, never extra exchanges; different sources stay separate.
        const key = `${source.id}\0${row.id}`, previous = senderHistory.get(key);
        const mailboxIds = [...new Set([...(previous?.mailboxIds ?? []), box.id])];
        senderHistory.set(key, previous && previous.revision > row.revision ? { ...previous, mailboxIds } : {
          id: row.id, sourceId: source.id, threadId: row.threadId, revision: row.revision,
          from: row.from, to: row.to, cc: row.cc, subject: row.subject, receivedAt: row.receivedAt, folder: row.folder,
          outgoing: row.folder === "sent" || row.folderIds.includes("sent") || sentMessages.get(row.id)?.accountId === source.id,
          mailboxIds,
        });
        const group = groups.get(row.threadId) ?? []; group.push(row); groups.set(row.threadId, group);
      }
      for (const [thread, rows] of groups) {
        rows.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id));
        const latest = rows.at(-1)!;
        const states = rows.map(row => row.memberships.find(state => state.mailboxId === box.id)!);
        const hidden = rows.every(row => row.folder === "trash") ? "Trash" : rows.every(row => row.folder === "spam") ? "Spam" : undefined;
        const done = states.every(state => state.done);
        const reminders = states.map(state => state.snoozedUntil).filter((value): value is string => !!value && Date.parse(value) > Date.now()).sort();
        const locations: string[] = [];
        if (hidden) locations.push(hidden);
        else {
          if (rows.some((row, index) => row.folder === "inbox" && !states[index].done && (!states[index].snoozedUntil || Date.parse(states[index].snoozedUntil!) <= Date.now()))) locations.push("Inbox");
          if (rows.some(row => row.folder === "sent")) locations.push("Sent");
          if (done) locations.push("Done");
          if (reminders.length) locations.push("Reminders");
          if (rows.every(row => row.folder === "archive" || row.folder === "sent") && rows.some(row => row.folder === "archive")) locations.push("Auto Archived");
        }
        const names = [...new Set(rows.flatMap(row => [
          ...row.labelIds.flatMap(id => labels.filter(label => label.id === id).map(label => label.name)),
          ...nativeFolders.filter(folder => folder.kind === "label" && row.folderIds.includes(folder.id)).map(folder => folder.name),
        ]))];
        const messages: Message[] = rows.map(row => {
          const detail = this.cachedDetail(row);
          const operation = sentMessages.get(row.id);
          return { id: row.id, revision: row.revision, bodyRevision: row.bodyRevision, from: row.from.name || row.from.email, email: row.from.email, to: addresses(row.to), cc: addresses(row.cc),
            bcc: detail ? addresses(detail.bcc) : undefined, date: displayTime(row.receivedAt).date, receivedAt: row.receivedAt,
            body: detail?.bodyHtml ?? "", loaded: !!detail, outgoing: row.folder === "sent", hasAttachments: row.hasAttachments, attention: classifyAttention(row),
             bodyText: detail?.bodyText, bodyFormat: detail?.bodyFormat, bodyDocument: detail?.bodyDocument,
             nativeFolder: row.folder, isRead: row.isRead, isStarred: row.isStarred, memberships: row.memberships.filter(state => state.mailboxId === box.id),
            ...(operation?.accountId === source.id ? { operationId: operation.id, sendStatus: operation.status } : {}),
            attachments: detail?.attachments.map(info => this.file(info)), };
        });
        mail.push({ id: viewThreadId(box.id, thread), account: box.id, sourceId: source.id, sourceGeneration: source.generation, mailboxId: box.id, sdkThreadId: thread, accountEmail: source.email,
          from: latest.from.name || latest.from.email, email: latest.from.email, to: addresses(latest.to), toAddresses: latest.to.map(person => person.email), subject: rows[0].subject,
          snippet: latest.preview, ...displayTime(latest.receivedAt), receivedAt: Date.parse(latest.receivedAt), split: "Important",
          folder: hidden ?? (locations.includes("Inbox") ? "Inbox" : done ? "Done" : reminders.length ? "Reminders" : locations[0] ?? "Auto Archived"), locations, unread: rows.some(row => !row.isRead), starred: rows.some(row => row.isStarred), labels: names, messages,
          ...(reminders.length ? { reminder: reminders[0], reminderAt: Date.parse(reminders[0]) } : {}),
        });
      }
    }
    for (const { ref, operation, draft } of this.sending.values()) {
      if (!["pending", "processing", "uncertain"].includes(operation.status) || !accounts.some(account => account.id === ref.mailboxId)) continue;
      const date = operation.sendAt || operation.createdAt;
      const pendingMessage: Message = {
        id: `pending:${operation.id}`, operationId: operation.id, sendStatus: operation.status, pending: true,
        from: draft.from, email: draft.from, to: addresses(draft.to), cc: addresses(draft.cc), bcc: addresses(draft.bcc),
        date: operation.status === "uncertain" ? "Delivery unconfirmed" : operation.status === "processing" ? "Sending…" : `Queued · ${new Date(date).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`,
        body: draftHtml(draft.bodyHtml || `<div>${escapeHTML(draft.bodyText).replaceAll("\n", "<br>")}</div>`), loaded: true, outgoing: true,
        hasAttachments: draft.attachmentIds.length > 0,
        attachments: draft.attachmentIds.flatMap(id => { const info = this.blobInfo.get(id); return info ? [this.file(info)] : []; }),
      };
      if (["reply", "replyAll"].includes(draft.mode)) {
        const conversation = mail.find(mail => mail.account === ref.mailboxId && mail.sourceId === draft.accountId && mail.messages.some(message => message.id === draft.sourceMessageId));
        if (conversation && !conversation.messages.some(message => message.operationId === operation.id)) conversation.messages.push(pendingMessage);
      }
      if (operation.status === "uncertain") continue;
      if (onlyThreads && !sendingChanged) continue;
      mail.push({ id: `operation:${operation.id}`, operationId: operation.id, sourceId: operation.accountId, mailboxId: ref.mailboxId, account: ref.mailboxId,
        accountEmail: draft.from, from: draft.from, email: draft.from, to: addresses(draft.to), toAddresses: draft.to.map(person => person.email), subject: draft.subject, snippet: draft.bodyText,
        ...displayTime(date), receivedAt: Date.parse(date), split: "Important", folder: "Scheduled", locations: ["Scheduled"], unread: false, starred: false, labels: [], scheduled: date,
        messages: [{ ...pendingMessage, scheduledAt: date }],
      });
    }
    const included = this.unifiedMailboxIds();
    labelNames[UNIFIED_ACCOUNT] = [...new Set(included.flatMap(id => labelNames[id] ?? []))];
    mail.push(...unifiedMail(mail, included, accounts));
    if (!onlyThreads) this.knownThreads.clear();
    const ai = this.state.ai;
    const connectedSources = new Set(this.sourceAccounts.filter(source => source.status === "connected").map(source => source.id));
    for (const conversation of mail) {
      if (conversation.sourceId && conversation.sdkThreadId && !conversation.operationId) {
        const key = nativeKey(conversation.sourceId, conversation.sdkThreadId);
        this.knownThreads.add(key);
        if (connectedSources.has(conversation.sourceId)) {
          const entry = this.categories.get(key);
          if (currentCategoryOverride(conversation, entry?.override)) conversation.attentionOverride = entry;
        }
        if (ai?.configured && ai.settings.enabled) {
          const triage = currentAiDecision(conversation, this.aiDecisions.get(key), ai.settings.model);
          if (triage) {
            conversation.triage = triage;
            if (ai.settings.mode === "apply" && triage.state === "ready" && triage.score) conversation.attentionCategory = triage.score.category;
          }
          const hold = this.aiHolds.get(key);
          if (hold && hold.until > Date.now() && ai.settings.mode === "apply" && triage?.state !== "ready") conversation.aiHoldUntil = hold.until;
        }
      }
      if (conversation.attentionOverride?.override) conversation.aiHoldUntil = undefined;
      conversation.split = conversationAttention(conversation);
    }
    if (onlyThreads) {
      const updated = new Map(mail.map(conversation => [conversation.id, conversation]));
      let next: Mail[];
      if (summariesChanged || sendingChanged) {
        // A delta can introduce/remove the last row of a thread or move it in
        // time. Merge two ordered lists instead of sorting/recreating 50k rows.
        const stable = this.state.mail.filter(conversation => !(sendingChanged && conversation.operationId)
          && !(conversation.sourceId && conversation.sdkThreadId && onlyThreads.has(nativeKey(conversation.sourceId, conversation.sdkThreadId))));
        const compare = (a: Mail, b: Mail) => (b.receivedAt ?? 0) - (a.receivedAt ?? 0) || a.id.localeCompare(b.id);
        mail.sort(compare); next = [];
        let left = 0, right = 0;
        while (left < stable.length || right < mail.length) {
          if (right >= mail.length || left < stable.length && compare(stable[left], mail[right]) <= 0) next.push(stable[left++]);
          else next.push(mail[right++]);
        }
      } else next = this.state.mail.map(conversation => updated.get(conversation.id) ?? conversation);
      this.publish({ mail: next,
        ...(historyChanged ? { senderHistory: [...this.state.senderHistory.filter(row => !onlyThreads.has(nativeKey(row.sourceId, row.threadId))), ...senderHistory.values()] } : {}),
        ...(sendingChanged ? { operations: Object.fromEntries(this.operations) } : {}),
        accounts: JSON.stringify(accounts) === JSON.stringify(this.state.accounts) ? this.state.accounts : accounts,
        labels: JSON.stringify(labelNames) === JSON.stringify(this.state.labels) ? this.state.labels : labelNames });
      timing({ conversations: updated.size });
      return;
    }
    mail.sort((a, b) => (b.receivedAt ?? 0) - (a.receivedAt ?? 0) || a.id.localeCompare(b.id));
    for (const id of this.sendErrors.keys()) if (!this.rawDrafts.has(id)) this.sendErrors.delete(id);
    const drafts = [...this.rawDrafts.values()].map(raw => {
      const edit = this.edits.get(raw.id);
      return { ...(edit?.draft ?? this.uiDraft(raw)), popOut: this.popouts.get(raw.id) ?? edit?.draft.popOut ?? false,
        saving: this.saves.has(raw.id) || !!edit && !edit.error && completeRecipients(edit.draft), dirty: !!edit, saveError: edit?.error, sendError: this.sendErrors.get(raw.id) };
    });
    this.publish({ accounts, mail, senderHistory: [...senderHistory.values()], drafts, labels: labelNames, unsaved: this.edits.size > 0 || this.saves.size > 0, operations: Object.fromEntries(this.operations) });
    timing({ conversations: mail.length });
  }

  private cachedDetail(row: MailboxMessageSummary): SdkMessage | undefined {
    const detail = this.details.get(row.id);
    if (detail?.accountId !== row.sourceId) return;
    // The opaque SDK body identity includes attachments/envelope metadata, not
    // flags or memberships. A body read newer than our summary is also safe;
    // insisting on equality there would refetch forever until a scan catches up.
    if (row.bodyRevision && detail.bodyRevision) return row.bodyRevision === detail.bodyRevision || detail.revision > row.revision ? detail : undefined;
    return detail.revision >= row.revision ? detail : undefined;
  }

  loadMoreMessages = async (id: string): Promise<void> => {
    const row = this.windowRows.get(id);
    if (!row || row.messagesComplete || this.windowDetails.get(id)?.exhausted) return;
    const epoch = this.windowEpoch, generation = this.generation, previous = this.windowDetails.get(id);
    const page = await this.windowTransport.messages({ account: row.mail.account, id, cursor: previous?.cursor ?? undefined, limit: 100 });
    this.windowCheck(epoch, generation);
    if (page.contextVersion !== row.contextVersion) throw new Error("The conversation changed. Reload before loading more messages.");
    const summaries = [...new Map([...(previous?.summaries ?? row.summaries), ...page.summaries].map(summary => [summary.id, summary])).values()];
    // Long history is a moving detail window, not an accidental 100k-message graph.
    this.windowDetails.set(id, { contextVersion: page.contextVersion, summaries: summaries.slice(-500), cursor: page.nextCursor,
      exhausted: page.exhausted });
    if (this.windowBytes() > INBOX_WINDOW_BYTE_LIMIT) { this.windowDetails.delete(id); throw new Error("This conversation exceeds the safe detail window size."); }
    this.rebuild();
  };
  prepareActionContext = (mails: Mail[]) => this.completeActionContext(mails);
  private completeActionContext = async (mails: Mail[]): Promise<Mail[]> => {
    const completed: Mail[] = [];
    for (const captured of mails) {
      if (!captured.window || captured.window.actionContextComplete) { completed.push(captured); continue; }
      if (!captured.window.targetsComplete || captured.window.counts.memberships === null || captured.window.counts.memberships > 500) throw new Error("This conversation exceeds 500 message memberships. No mail was changed.");
      this.pinWindow("action-context", [captured.id]);
      try {
        if (!this.windowRows.has(captured.id)) await this.lookupWindow([captured.id], captured.account);
        const current = this.windowRows.get(captured.id);
        if (!current || current.contextVersion !== captured.window.contextVersion) throw new Error("The captured conversation changed. Review it before making changes.");
        while (!this.windowDetails.get(captured.id)?.exhausted) {
          await this.loadMoreMessages(captured.id);
          if (!this.windowDetails.get(captured.id)?.cursor && !this.windowDetails.get(captured.id)?.exhausted) throw new Error("Conversation context is still incomplete. No mail was changed.");
        }
        const mail = this.state.mail.find(mail => mail.id === captured.id)!;
        if (mail.window?.contextVersion !== captured.window.contextVersion || !mail.window.actionContextComplete) throw new Error("The captured conversation changed. No mail was changed.");
        completed.push(mail);
      } finally { this.pinWindow("action-context", []); }
    }
    return completed;
  };

  loadThread = (id: string, messageId?: string): Promise<void> => {
    const mail = this.state.mail.find(mail => mail.id === id);
    if (!mail || mail.operationId) return Promise.resolve();
    const key = nativeKey(mail.sourceId!, mail.sdkThreadId!) + (mail.window ? `\0${messageId ?? mail.messages.at(-1)?.id}` : "");
    const pending = this.loadingThreads.get(key); if (pending) return pending;
    const generation = this.generation;
    const bodyEpoch = this.bodyEpoch;
    const timing = measurePerformance({ kind: "thread", messages: mail.messages.length });
    const work = (async () => {
      const changed = new Set<string>();
      let fetched = 0;
      for (const message of mail.messages) if (!message.pending && (!mail.window || message.id === (messageId ?? mail.messages.at(-1)?.id))) {
        const mailboxId = message.memberships?.[0]?.mailboxId ?? mail.mailboxId!;
        const row = this.summaries.get(mailboxId)?.find(row => row.sourceId === mail.sourceId && row.id === message.id);
        if (!row || this.cachedDetail(row)) continue;
        const detail = await this.client.mailboxMessage(mailboxId, message.id, this.requestOptions());
        fetched++;
        if (generation !== this.generation || bodyEpoch !== this.bodyEpoch) return;
        if (detail.accountId !== row.sourceId) throw new Error("The conversation body belongs to another source.");
        const previous = this.details.get(message.id);
        if (previous && previous.revision >= detail.revision) continue;
        this.details.set(message.id, detail);
        if (mail.window) {
          const bytes = () => new TextEncoder().encode(JSON.stringify([...this.details.values()])).length * 2;
          while (this.details.size > 1 && bytes() > 8 * 1024 * 1024) this.details.delete(this.details.keys().next().value!);
          if (bytes() > 8 * 1024 * 1024) { this.details.delete(message.id); throw new Error("This message exceeds the safe body cache size."); }
        }
        changed.add(nativeKey(row.sourceId, row.threadId));
      }
      if (changed.size) this.rebuild(changed);
      else if (this.calendarKey !== displayTimes().key) this.rebuild();
      this.resolve("thread"); timing({ pages: fetched, conversations: changed.size });
    })().catch(error => { timing({ outcome: "error" }); this.fail(error, "load-thread"); throw error; }).finally(() => {
      if (this.loadingThreads.get(key) === work) this.loadingThreads.delete(key);
      if (generation === this.generation && bodyEpoch !== this.bodyEpoch) void this.loadThread(id).catch(() => {});
    });
    this.loadingThreads.set(key, work); return work;
  };

  private retireDraftIssue(id: string, issue: InboxIssue | undefined) {
    // An authoritative recovery retires only its captured incident, never a newer failure or pending writing.
    if (!issue || issue.key !== `draft:${id}` || this.edits.has(id) || this.saves.has(id) || !this.state.issues.includes(issue)) return;
    clearTimeout(this.issueHolds.get(issue.key)); this.issueHolds.delete(issue.key);
    this.publish({ issues: this.state.issues.filter(item => item !== issue) });
  }
  private saveRecovery() {
    const recovery = Object.fromEntries([...this.edits].map(([id, edit]) => [id, { draft: edit.draft, revision: edit.revision }]));
    this.recovery = recovery;
    if (!this.storage.writeSaved(recoveryKey, recovery)) this.raise({ scope: "storage", code: "RECOVERY", title: "Browser storage is full", detail: "Keep this draft open until it is saved to the inbox.", retry: false });
    else this.resolve("storage");
  }
  editDraft = (draft: Draft) => {
    const old = this.state.drafts.find(value => value.id === draft.id), raw = this.rawDrafts.get(draft.id);
    if (!raw) return;
    this.popouts.set(draft.id, draft.popOut ?? false);
    if (old && (old.from !== draft.from || old.account !== draft.account)) this.sendErrors.delete(draft.id);
    if (old && contentKey(old) === contentKey(draft)) { this.rebuild(); return; }
    const previous = this.edits.get(draft.id), complete = completeRecipients(draft);
    const error = previous?.error && !(previous.errorKind === "recipients" && complete) ? { error: previous.error, errorKind: previous.errorKind } : {};
    this.edits.set(draft.id, { draft: { ...draft, updated: Date.now() }, revision: previous?.revision ?? raw.revision, version: (previous?.version ?? 0) + 1, ...error });
    this.saveRecovery(); this.rebuild(); clearTimeout(this.saveTimers.get(draft.id));
    if (complete && !error.error) this.saveTimers.set(draft.id, setTimeout(() => void this.flushDraft(draft.id).catch(() => {}), 450));
  };

  private async uploadFile(file: Attachment, sourceId: string): Promise<BlobInfo> {
    if (file.blobId && file.sourceId === sourceId) return { id: file.blobId, accountId: sourceId, filename: file.name, contentType: file.type, size: file.size };
    let uploads = this.uploads.get(file); if (!uploads) { uploads = new Map(); this.uploads.set(file, uploads); }
    let upload = uploads.get(sourceId);
    if (!upload) {
      upload = (async () => {
        let content: Uint8Array;
        if (file.blobId) content = (await this.client.download(file.blobId, this.requestOptions())).content;
        else if (file.data?.startsWith("data:") && file.data.includes(";base64,")) {
          const raw = atob(file.data.slice(file.data.indexOf(",") + 1)); content = Uint8Array.from(raw, character => character.charCodeAt(0));
        } else throw new Error("This attachment has no available bytes. Remove it or choose the file again.");
        return this.client.upload(sourceId, { filename: file.name, contentType: file.type, content }, this.requestOptions());
      })(); uploads.set(sourceId, upload);
      void upload.catch(() => uploads!.delete(sourceId));
    }
    return upload;
  }
  private async draftInput(draft: Draft, sourceId: string): Promise<Partial<DraftInput>> {
    const uploaded = await Promise.all(draft.attachments.map(file => this.uploadFile(file, sourceId)));
    return { from: draft.from || this.account(draft.account).box.defaultSender || undefined, to: recipients(draft.to), cc: recipients(draft.cc), bcc: recipients(draft.bcc), subject: draft.subject,
      bodyHtml: draftHtml(draft.body), bodyText: plainText(draft.body), attachmentIds: uploaded.map(file => file.id) };
  }
  flushDraft = (id: string): Promise<SdkDraft> => {
    const existing = this.saves.get(id); if (existing) return existing.then(() => this.edits.has(id) ? this.flushDraft(id) : this.rawDrafts.get(id)!);
    clearTimeout(this.saveTimers.get(id)); this.saveTimers.delete(id);
    const issue = this.state.issues.find(issue => issue.key === `draft:${id}`);
    let recovered = false;
    const work = (async () => {
      while (this.edits.has(id)) {
        const edit = this.edits.get(id)!;
        if (edit.error && edit.errorKind !== "recipients") throw new Error(edit.error);
        if (!completeRecipients(edit.draft)) throw new DraftRecipientError("Complete the recipient address before saving this draft.");
        const raw = this.rawDrafts.get(id); if (!raw) throw new Error("This draft is no longer active.");
        const input = await this.draftInput(edit.draft, raw.accountId);
        const saved = await this.client.updateDraft(id, input, edit.revision, this.requestOptions());
        this.draftEpoch++;
        this.rawDrafts.set(id, saved);
        const current = this.edits.get(id);
        if (current?.version === edit.version) this.edits.delete(id);
        else if (current) current.revision = saved.revision;
        this.saveRecovery(); this.rebuild(); recovered = true;
      }
      const saved = this.rawDrafts.get(id); if (!saved) throw new Error("This draft is no longer active."); return saved;
    })().catch(error => {
      const edit = this.edits.get(id);
      if (edit) {
        edit.error = error instanceof ApiError && error.status === 412 ? "This draft changed elsewhere. Your writing has been kept; reload or copy it before replacing the newer draft." : error instanceof Error ? error.message : "Draft save failed.";
        edit.errorKind = error instanceof DraftRecipientError ? "recipients" : undefined;
      }
      this.fail(error, "save-draft", `draft:${id}`); this.rebuild(); throw error;
    }).finally(() => { this.saves.delete(id); this.rebuild(); }).then(saved => {
      if (recovered) this.retireDraftIssue(id, issue);
      return saved;
    });
    this.saves.set(id, work); this.rebuild(); return work;
  };

  newDraft = async (boxId: string, input: { subject?: string; body?: string; popOut?: boolean; to?: string; mode?: Draft["mode"]; mail?: Mail; sourceMessageId?: string } = {}): Promise<Draft> => {
    if (boxId === UNIFIED_ACCOUNT) boxId = this.defaultMailbox(boxId, input.mail, input.sourceMessageId)?.id ?? "";
    const { box, source } = this.account(boxId);
    if (!this.state.accounts.find(account => account.id === boxId)?.canSend) throw new Error("This mailbox cannot send messages.");
    if (input.mode && input.mode !== "new" && input.mode !== "forward" && !source.capabilities.reply) throw new Error("This source cannot send replies.");
    if (input.mail) await this.loadThread(input.mail.id);
    if (input.sourceMessageId && !input.mail?.messages.some(message => message.id === input.sourceMessageId)) throw new Error("The selected message no longer belongs to this conversation.");
    const parent = input.sourceMessageId ?? input.mail?.messages.filter(message => !message.pending).at(-1)?.id;
    if (input.mail?.messages.find(message => message.id === parent)?.pending) throw new Error("Wait for the queued message to finish sending before replying to it.");
    const implicitReply = !!parent && (input.mode === "reply" || input.mode === "replyAll");
    const raw = await this.client.createDraft({ accountId: source.id, mailboxId: box.id, ...(!implicitReply ? { from: box.defaultSender! } : {}),
      mode: input.mode === "new" || !input.mode ? "compose" : input.mode, ...(parent ? { sourceMessageId: parent } : {}),
      ...(input.subject !== undefined ? { subject: input.subject } : {}), ...(input.body !== undefined ? { bodyHtml: draftHtml(input.body), bodyText: plainText(input.body) } : {}),
      ...(input.to !== undefined ? { to: recipients(input.to) } : {}),
    }, this.requestOptions());
    this.draftEpoch++; this.popouts.set(raw.id, input.popOut ?? false); this.rawDrafts.set(raw.id, raw); this.rebuild();
    return this.state.drafts.find(draft => draft.id === raw.id)!;
  };
  moveDraft = async (id: string, boxId: string): Promise<Draft> => {
    const raw = await this.flushDraft(id), current = this.state.drafts.find(draft => draft.id === id)!;
    const { source, box } = this.account(boxId);
    if (!this.state.accounts.find(account => account.id === boxId)?.canSend) throw new Error("This mailbox cannot send messages.");
    const input = await this.draftInput({ ...current, account: boxId, from: box.defaultSender! }, source.id);
    let saved: SdkDraft;
    if (source.id === raw.accountId) saved = await this.client.updateDraft(id, { ...input, mailboxId: boxId }, raw.revision, this.requestOptions());
    else {
      saved = await this.client.createDraft({ ...input, accountId: source.id, mailboxId: boxId, mode: "compose" }, this.requestOptions());
      await this.client.deleteDraft(id, raw.revision, this.requestOptions()); this.rawDrafts.delete(id);
    }
    this.draftEpoch++; this.popouts.set(saved.id, current.popOut ?? false); this.rawDrafts.set(saved.id, saved); this.rebuild();
    return this.state.drafts.find(draft => draft.id === saved.id)!;
  };
  discardDraft = async (id: string) => {
    clearTimeout(this.saveTimers.get(id)); this.saveTimers.delete(id);
    await this.saves.get(id)?.catch(() => {});
    const raw = this.rawDrafts.get(id); if (!raw) throw new Error("This draft is no longer active.");
    await this.client.deleteDraft(id, raw.revision, this.requestOptions()); this.draftEpoch++; this.rawDrafts.delete(id); this.edits.delete(id); this.saveRecovery(); this.rebuild();
  };
  reloadDraft = async (id: string) => {
    const issue = this.state.issues.find(issue => issue.key === `draft:${id}`);
    const raw = await this.client.draft(id, this.requestOptions()); this.draftEpoch++; this.edits.delete(id); this.sendErrors.delete(id); this.rawDrafts.set(id, raw); this.saveRecovery(); this.rebuild();
    this.retireDraftIssue(id, issue);
  };

  submit = async (draft: Draft, sendAt?: string): Promise<Operation> => {
    if (!this.state.host?.allowProviderWrites) throw new Error("Sending is disabled by this read-only host.");
    const issue = this.state.issues.find(issue => issue.key === `draft:${draft.id}`);
    this.editDraft(draft); const raw = await this.flushDraft(draft.id);
    const previous = this.references.filter(ref => ref.draftId === draft.id).at(-1);
    const previousStatus = previous && this.operations.get(previous.id)?.status;
    if (previousStatus === "cancelled" || previousStatus === "failed") this.submissions.delete(draft.id);
    let intent = this.submissions.get(draft.id);
    if (!intent) { intent = { idempotencyKey: crypto.randomUUID(), revision: raw.revision, ...(sendAt ? { sendAt } : {}) }; this.submissions.set(draft.id, intent); }
    let operation: Operation;
    const generation = this.generation;
    this.sendErrors.delete(draft.id);
    try { operation = await this.client.submit(draft.id, intent, this.requestOptions()); }
    catch (error) {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) this.submissions.delete(draft.id);
      const current = this.state.drafts.find(value => value.id === draft.id);
      if (generation === this.generation && !this.controller.signal.aborted && !this.applicationScope.signal.aborted
        && current?.account === draft.account && current.from === draft.from) {
        this.sendErrors.set(draft.id, { message: failureMessage(error), code: failureCode(error) });
        this.rebuild();
      }
      throw error;
    }
    const ref = { id: operation.id, draftId: raw.id, accountId: raw.accountId, mailboxId: raw.mailboxId || draft.account };
    this.references = [...this.references.filter(item => item.id !== ref.id), ref].slice(-200);
    if (!this.storage.writeSaved(outboxKey, this.references)) this.raise({ scope: "storage", code: "OUTBOX", title: "Browser storage is full", detail: "The send is queued, but this browser could not save its operation reference.", retry: false });
    this.draftEpoch++; this.rawDrafts.delete(raw.id); this.edits.delete(raw.id); this.saveRecovery();
    this.operations.set(operation.id, operation);
    this.sending.set(operation.id, { ref, operation, draft: raw }); this.rebuild(); this.scheduleRefresh();
    this.retireDraftIssue(raw.id, issue);
    return operation;
  };

  private async settled(operation: Operation): Promise<Operation> {
    let delay = 200;
    while (["pending", "processing"].includes(operation.status)) {
      await pause(delay, this.controller.signal);
      try { operation = await this.client.operation(operation.id, this.requestOptions()); }
      catch (error) { if (this.controller.signal.aborted || definitive(error)) throw error; }
      delay = Math.min(2000, delay * 2);
    }
    if (operation.status !== "succeeded") throw new Error(operation.problem?.message || `The SDK operation ${operation.status}.`);
    return operation;
  }
  private async mutation(boxId: string, ids: string[], changes: Changes): Promise<Operation> {
    if (!this.state.host?.allowProviderWrites && Object.keys(changes).some(key => !["addLabelIds", "removeLabelIds", "snoozedUntil"].includes(key))) {
      throw new Error("Provider changes are disabled by this read-only host.");
    }
    const rows = await Promise.all(ids.map(id => this.state.host?.inboxWindow ? this.client.mailboxMessageSummary(boxId, id, this.requestOptions()) : this.client.mailboxMessage(boxId, id, this.requestOptions())));
    const operation = await this.client.mutate({ messageIds: ids, viaMailboxId: boxId, changes, ifRevisions: Object.fromEntries(rows.map(row => [row.id, row.revision])), idempotencyKey: crypto.randomUUID() }, this.requestOptions());
    this.scheduleRefresh(); return this.settled(operation);
  }
  private projectFlags(row: MailboxMessageSummary): MailboxMessageSummary {
    const key = nativeKey(row.sourceId, row.id);
    const read = this.flagIntents.get(`${key}\0isRead`), star = this.flagIntents.get(`${key}\0isStarred`);
    let changed = false;
    const memberships = row.memberships.map(state => {
      const receipt = this.membershipReceipts.get(membershipKey(row.sourceId, state));
      if (!receipt || receipt.state.revision <= state.revision) return state;
      changed = true; return receipt.state;
    });
    return read || star || changed ? { ...row, ...(read ? { isRead: read.value } : {}), ...(star ? { isStarred: star.value } : {}), ...(changed ? { memberships } : {}) } : row;
  }
  private receiveMemberships(states: MailboxMembership[]) {
    const threads = new Set<string>();
    for (const state of states) {
      const sourceId = this.boxes.find(box => box.id === state.mailboxId)?.sourceId;
      if (!sourceId) continue;
      const row = this.summaries.get(state.mailboxId)?.find(row => row.sourceId === sourceId && row.id === state.messageId);
      const current = row?.memberships.find(current => current.mailboxId === state.mailboxId);
      if ((!row || !current) && !this.state.host?.inboxWindow || current && state.revision <= current.revision) continue;
      const key = membershipKey(sourceId, state), previous = this.membershipReceipts.get(key);
      if (previous && previous.state.revision >= state.revision) continue;
      this.membershipReceipts.set(key, { sourceId, state });
      if (row) threads.add(nativeKey(sourceId, row.threadId));
      else for (const item of this.windowRows.values()) if (item.sourceId === sourceId && item.targets.some(target => target.messageId === state.messageId)) threads.add(nativeKey(sourceId, item.threadId));
    }
    if (threads.size) this.rebuild(threads);
    if (this.state.host?.inboxWindow) this.scheduleRefresh();
  }
  private async receiveFeedback(event: AttentionFeedback) {
    this.feedbackEpoch++;
    this.publish({ attentionFeedback: [event, ...this.state.attentionFeedback.filter(previous => previous.id !== event.id)].slice(0, 20) });
    if (event.states) this.receiveMemberships(event.states);
    else if (event.problem) this.scheduleRefresh();
    else {
      // An older host has no authoritative membership receipt. Keep its old
      // confirmed view until a real reread, rather than inventing Done/Undo.
      await this.refresh(true).catch(error => this.fail(error, "refresh"));
    }
  }
  private flagSummary(target: Pick<FlagTarget, "sourceId" | "mailboxId" | "messageId">): MailboxMessageSummary {
    const row = this.summaries.get(target.mailboxId)?.find(row => row.id === target.messageId && row.sourceId === target.sourceId);
    if (!row) throw new Error("This message is no longer in the selected mailbox. Refresh before trying again.");
    return row;
  }
  private flagThreads(targets: FlagTarget[]): Set<string> {
    const threads = new Set<string>();
    for (const target of targets) {
      threads.add(nativeKey(target.sourceId, target.threadId));
      const current = this.summaries.get(target.mailboxId)?.find(row => row.sourceId === target.sourceId && row.id === target.messageId);
      if (current) threads.add(nativeKey(current.sourceId, current.threadId));
    }
    return threads;
  }
  private clearFlagIntents(write: FlagWrite) {
    for (const intent of write.intents) this.retireFlagIntent(intent);
  }
  private retireFlagIntent(intent: FlagIntent) {
      intent.retired = true;
      const key = flagKey(intent.target, intent.field);
      if (this.flagIntents.get(key) !== intent) return;
      // A rejected newer opposite must reveal the previous intent until ITS
      // acknowledgement has reached a snapshot, not the stale raw flag.
      const previous = [...this.flagWrites].flatMap(write => write.intents).filter(other => !other.retired && flagKey(other.target, other.field) === key)
        .sort((a, b) => b.sequence - a.sequence)[0];
      if (previous) this.flagIntents.set(key, previous); else this.flagIntents.delete(key);
  }
  private flagProblem(write: Pick<FlagWrite, "action" | "value" | "field">, error: unknown): InboxActionError {
    const verb = write.field === "isStarred" ? (write.value ? "star" : "unstar") : (write.value ? "mark read" : "mark unread");
    this.raise({ scope: "action", code: failureCode(error), title: `Couldn't ${verb}`, detail: failureMessage(error), retry: true });
    return new InboxActionError(failureMessage(error));
  }
  private reconcileFlags(): Set<string> {
    const threads = new Set<string>();
    for (const write of this.flagWrites) {
      let terminalReflected = write.terminal !== undefined;
      for (const intent of write.intents) {
        const fence = this.summaryFences.get(nativeKey(intent.target.sourceId, intent.target.messageId));
        const revisions = (write.operation?.mutationRevisions ?? []).filter(edge => edge.messageId === intent.target.messageId).map(edge => edge.after);
        const latest = revisions.length ? Math.max(...revisions) : Infinity;
        // Sparse operation-only pages do NOT advance this target's fence.
        // A newer receipt can prove an already-read row reflected settlement,
        // but only through that operation's exact canonical revision edges.
        const accepted = write.accepted !== undefined && fence && (this.state.host?.inboxWindow
          ? fence.removed === "deleted" || fence.revision >= latest
          : fence.epoch >= write.accepted || fence.removed || fence.revision >= latest);
        if (accepted && !intent.retired) { this.retireFlagIntent(intent); threads.add(nativeKey(intent.target.sourceId, intent.target.threadId)); }
        terminalReflected &&= !!fence && (this.state.host?.inboxWindow
          ? fence.removed === "deleted" || fence.revision >= latest
          : fence.epoch >= write.terminal! || !!fence.removed || revisions.length > 1 && latest > Math.min(...revisions) && fence.revision >= latest);
      }
      if (terminalReflected) this.flagWrites.delete(write);
    }
    if (!this.flagWrites.size) this.flagRevisions.clear();
    return threads;
  }
  private acceptFlagRevisions(write: FlagWrite, operation: Operation) {
    if (operation.type !== "mutation" || operation.accountId !== write.targets[0].sourceId) return;
    for (const edge of operation.mutationRevisions ?? []) {
      if (!write.targets.some(target => target.messageId === edge.messageId) || edge.after <= edge.before) continue;
      const key = nativeKey(operation.accountId, edge.messageId);
      const links = this.flagRevisions.get(key) ?? new Map<number, number>();
      links.set(edge.before, edge.after); this.flagRevisions.set(key, links);
    }
  }
  private observeFlags(write: FlagWrite, operation: Operation): InboxActionError | undefined {
    write.operation = operation; this.acceptFlagRevisions(write, operation);
    if (["pending", "processing"].includes(operation.status) || write.terminal !== undefined) return;
    write.terminal = ++this.flagEpoch;
    if (operation.status === "succeeded") return;
    write.reported = true;
    return this.flagProblem(write, new Error(operation.problem?.message || (operation.status === "partial"
      ? "Some messages could not be changed. Successful changes were kept. Refresh and check the selection."
      : operation.status === "uncertain" ? "The result is unconfirmed. Refresh and check the messages before trying again."
      : operation.status === "cancelled" ? "The change was cancelled. Check the current message state." : "The change was rejected. Refresh and try again.")));
  }
  private flagPreconditions(write: FlagWrite): Record<string, number> {
    const revisions: Record<string, number> = {};
    for (const target of write.targets) {
      let revision = target.revision;
      const links = this.flagRevisions.get(nativeKey(target.sourceId, target.messageId));
      while (links?.has(revision)) revision = links.get(revision)!;
      revisions[target.messageId] = revision;
    }
    return revisions;
  }
  private async submitFlags(write: FlagWrite, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!write.input) {
      write.input = { messageIds: write.targets.map(target => target.messageId), viaMailboxId: write.targets[0].mailboxId,
        changes: { [write.field]: write.value }, ifRevisions: this.flagPreconditions(write), idempotencyKey: crypto.randomUUID() };
    }
    let attempt = 0, conflicts = 0;
    for (;;) {
      try {
        // Never create a new key or rebase this payload after a lost response.
        const operation = await this.client.mutate(write.input, { signal });
        signal.throwIfAborted();
        write.accepted = ++this.flagEpoch;
        if (write.reported && this.state.issues.some(issue => issue.scope === "action" && issue.code === "ACKNOWLEDGEMENT_PENDING")) this.resolve("action");
        const failure = this.observeFlags(write, operation);
        this.watchFlags(); this.scheduleRefresh();
        if (failure) throw failure;
        return;
      } catch (error) {
        if (signal.aborted) throw error;
        if (error instanceof InboxActionError) throw error;
        if (!attempt && conflicts++ < 3 && error instanceof ApiError && error.code === "PRECONDITION_FAILED") {
          // An explicit rejection can race our preceding operation's own
          // settlement. Only its durable revision edges authorize advancing.
          // Once any response was lost, however, the payload stays frozen.
          for (const previous of this.flagWrites) if (previous !== write && previous.operation && previous.targets[0].sourceId === write.targets[0].sourceId) {
            try { this.acceptFlagRevisions(previous, await this.client.operation(previous.operation.id, { signal })); }
            catch { signal.throwIfAborted(); }
          }
          const revisions = this.flagPreconditions(write);
          if (write.targets.some(target => revisions[target.messageId] !== write.input!.ifRevisions![target.messageId])) {
            write.input = { ...write.input, ifRevisions: revisions, idempotencyKey: crypto.randomUUID() }; continue;
          }
        }
        // Authentication/authorization failures after a lost response do not
        // establish whether the ORIGINAL request was accepted. Keep its exact
        // identity until the SDK can replay it or definitively reject input.
        if (definitive(error) && (!attempt || error instanceof ApiError && ["PRECONDITION_FAILED", "VALIDATION", "INVALID_INPUT"].includes(error.code))) {
          this.clearFlagIntents(write); this.flagWrites.delete(write); this.rebuild(this.flagThreads(write.targets));
          throw this.flagProblem(write, error);
        }
        // Transport failure is not rejection. The one frozen SDK request is
        // replayed automatically; generic Retry remains strictly read-only.
        if (++attempt === 2) {
          write.reported = true;
          this.raise({ scope: "action", code: "ACKNOWLEDGEMENT_PENDING", title: "Checking the mail change", detail: "The connection was interrupted. Checking the existing request automatically; do not repeat it.", retry: true });
        }
        await pause(Math.max(retryAfter(error), Math.min(30_000, 500 * 2 ** Math.min(attempt - 1, 6))), signal);
      }
    }
  }
  private queueFlags(write: FlagWrite): Promise<void> {
    const sourceId = write.targets[0].sourceId, signal = this.controller.signal;
    const previous = this.flagQueues.get(sourceId) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(() => this.submitFlags(write, signal));
    this.flagQueues.set(sourceId, work); write.promise = work;
    void work.finally(() => { if (this.flagQueues.get(sourceId) === work) this.flagQueues.delete(sourceId); }).catch(() => {});
    return work;
  }
  private watchFlags() {
    if (this.flagReconciler || this.controller.signal.aborted) return;
    const signal = this.controller.signal, generation = this.generation;
    const work = (async () => {
      let delay = 250;
      while (!signal.aborted && [...this.flagWrites].some(write => write.operation)) {
        let refresh = false;
        for (const write of this.flagWrites) {
          if (!write.operation) continue;
          if (write.terminal !== undefined) { refresh = true; continue; }
          try {
            const operation = await this.client.operation(write.operation.id, { signal });
            signal.throwIfAborted();
            this.observeFlags(write, operation);
            if (write.terminal !== undefined) refresh = true;
          } catch (error) {
            if (signal.aborted) return;
            // Polling only reads the durable operation. Network loss cannot
            // roll back a write or cause a second provider job.
            if (definitive(error) && !write.reported) {
              write.reported = true;
              this.raise({ scope: "action", code: failureCode(error), title: "Couldn't check the mail change", detail: "Refresh and check the messages before trying the action again.", retry: true });
            }
            if (error instanceof ApiError && error.status === 404) { write.terminal = ++this.flagEpoch; refresh = true; }
          }
        }
        if (refresh && !signal.aborted) await this.readUpdates().catch(error => this.fail(error, "refresh"));
        if (![...this.flagWrites].some(write => write.operation)) break;
        await pause(delay, signal); delay = Math.min(5000, delay * 2);
      }
    })().catch(error => { if (!signal.aborted) this.fail(error, "refresh"); }).finally(() => {
      if (this.flagReconciler !== work) return;
      this.flagReconciler = undefined;
      // Acceptance can land between the loop's last check and this finalizer.
      // Do not strand that operation, or resurrect a stopped generation.
      if (!signal.aborted && generation === this.generation && [...this.flagWrites].some(write => write.operation)) this.watchFlags();
    });
    this.flagReconciler = work;
  }
  private flagAction(selected: Mail[], action: string): Promise<() => Promise<void>> {
    const field: Flag = action === "star" ? "isStarred" : "isRead";
    const value = action === "star" ? selected.some(mail => !mail.starred) : action === "read" || !selected.some(mail => !mail.unread);
    try {
      const targets = new Map<string, FlagTarget>();
      for (const mail of selected) {
        if (mail.operationId) throw new Error("Cancel the queued send before changing it.");
        for (const [mailboxId, ids] of this.mailboxTargets(mail)) {
          const { source } = this.account(mailboxId);
          if (!this.supports(field === "isStarred" ? "star" : value ? "read" : "unread", mailboxId)) throw new Error(`A selected source does not support ${action}.`);
          for (const messageId of ids) {
            if (mail.window) {
              const message = mail.messages.find(message => message.id === messageId);
              if (!message?.revision || typeof message[field] !== "boolean") throw new Error("The captured flag context is incomplete.");
              targets.set(nativeKey(source.id, messageId), { sourceId: source.id, mailboxId, messageId, threadId: mail.sdkThreadId!, revision: message.revision, before: message[field]! });
            } else {
              const row = this.flagSummary({ sourceId: source.id, mailboxId, messageId });
              const projected = this.projectFlags(row);
              targets.set(nativeKey(source.id, messageId), { sourceId: source.id, mailboxId, messageId, threadId: row.threadId, revision: row.revision, before: projected[field] });
            }
          }
        }
      }
      return this.changeFlags([...targets.values()], action, field, value);
    } catch (error) { return Promise.reject(this.flagProblem({ action, field, value }, error)); }
  }
  private changeFlags(targets: FlagTarget[], action: string, field: Flag, value: boolean): Promise<() => Promise<void>> {
    const writes = new Map<string, FlagWrite>(), batches: FlagWrite[] = [], duplicates = new Set<Promise<void>>();
    for (const target of targets) {
      const current = this.flagIntents.get(flagKey(target, field));
      if (current?.value === value) { if (current.write.promise) duplicates.add(current.write.promise); continue; }
      if (target.before === value) continue;
      // SDK mutations have one source and one receiving scope per request.
      const key = `${target.sourceId}\0${target.mailboxId}`;
      let write = writes.get(key);
      if (!write || write.targets.length === 500) {
        write = { action, field, value, targets: [], intents: [] };
        batches.push(write); writes.set(key, write);
      }
      const intent: FlagIntent = { sequence: ++this.flagSequence, field, value, target, write };
      write.targets.push(target); write.intents.push(intent);
      this.flagIntents.set(flagKey(target, field), intent); this.flagVersions.set(flagKey(target, field), intent.sequence);
    }
    for (const write of batches) this.flagWrites.add(write);
    // This publish happens before queueing, before the first await and before
    // App navigates. All individual and overlapping Unified views rebuild.
    if (batches.length) this.rebuild(this.flagThreads(batches.flatMap(write => write.targets)));
    return Promise.allSettled([...batches.map(write => this.queueFlags(write)), ...duplicates]).then(results => {
      const failed = results.find(result => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      return async () => {
        for (const write of batches) for (const intent of write.intents) {
          if (this.flagVersions.get(flagKey(intent.target, field)) !== intent.sequence) throw new Error("A newer change prevents this undo. Check the current message state.");
        }
        // Undo is another conditional flag intent, so it works while the
        // original provider command is still processing, without blind cancel.
        const groups = new Map<boolean, FlagTarget[]>();
        for (const write of batches) for (const intent of write.intents) {
          const row = this.messageRows.get(nativeKey(intent.target.sourceId, intent.target.messageId));
          const before = row ? this.projectFlags(row)[field] : write.value; // Eviction is not deletion; Undo uses its captured receipt edges.
          const group = groups.get(intent.target.before) ?? [];
          // Only this operation's receipt authorizes Undo's baseline. A newer
          // unrelated snapshot revision must not silently permit overwriting
          // another writer's edit, even after the local overlay has retired.
          const revision = Math.max(write.input!.ifRevisions![intent.target.messageId],
            ...(write.operation?.mutationRevisions ?? []).filter(edge => edge.messageId === intent.target.messageId).map(edge => edge.after));
          group.push({ ...intent.target, revision, before }); groups.set(intent.target.before, group);
        }
        await Promise.all([...groups].map(([restore, selected]) => this.changeFlags(selected, "undo", field, restore)));
      };
    });
  }
  private mailboxTargets(mail: Mail, allMemberships = false): Map<string, string[]> {
    const result = new Map<string, string[]>();
    const seen = new Set<string>();
    for (const message of mail.messages) {
      if (message.pending || seen.has(message.id)) continue;
      seen.add(message.id);
      const memberships = message.memberships?.map(state => state.mailboxId);
      const ids = memberships?.length ? [...new Set(memberships)] : [mail.mailboxId ?? mail.account];
      for (const id of allMemberships ? ids : ids.slice(0, 1)) {
        const source = this.account(id).source;
        if (mail.sourceId && source.id !== mail.sourceId) throw new Error("A conversation cannot span unrelated source accounts.");
        const messages = result.get(id) ?? []; messages.push(message.id); result.set(id, messages);
      }
    }
    return result;
  }
  async act<T>(action: string, work: () => Promise<T>, refresh = true): Promise<T> {
    const timing = measureWork(action), queuedAt = performance.now();
    const previous = this.actionQueue;
    let release!: () => void;
    this.actionQueue = new Promise<void>(resolve => { release = resolve; });
    this.publish({ pending: this.state.pending + 1 });
    await previous;
    const queueMs = performance.now() - queuedAt;
    try {
      const result = await work();
      // Durable work, not a whole-inbox scan, owns completion and the queue.
      // Receipt-aware local commands already published their exact changes.
      if (refresh) this.scheduleRefresh();
      timing({ queueMs });
      return result;
    }
    catch (error) { timing({ queueMs, outcome: "error" }); this.scheduleRefresh(); this.fail(error, action); throw error; }
    finally { release(); this.aiRebuildAfter = Date.now() + 50; this.publish({ pending: Math.max(0, this.state.pending - 1) }); }
  }
  private recoveryScope(selected: Mail[]): RecoveryScope {
    const sources = new Map<string, RecoveryScope["sources"][number]>();
    for (const mail of selected) {
      const source = this.sourceAccounts.find(source => source.id === mail.sourceId);
      if (!source || source.status !== "connected" || source.generation !== mail.sourceGeneration) throw new InboxRecoveryRejected("The captured source generation changed. Review this conversation again.");
      const entry = sources.get(source.id) ?? { sourceId: source.id, generation: source.generation, mailboxIds: [] };
      entry.mailboxIds = [...new Set([...entry.mailboxIds, ...mail.mailboxIds ?? [mail.mailboxId ?? mail.account]])];
      sources.set(source.id, entry);
    }
    return { version: 1, owner: this.applicationScope.scope, sources: [...sources.values()] };
  }
  private publishRecovery(plan: InboxCommandRecovery, sink?: InboxRecoverySink) {
    if (!validInboxCommandRecovery(plan)) throw new InboxRecoveryStorageError("The captured recovery plan is invalid or exceeds its bounded budget. No further command was sent.");
    try { sink?.(structuredClone(plan)); } catch { throw new InboxRecoveryStorageError("The frozen mail command could not be saved. No further command was sent."); }
  }
  private async checkRecovery(plan: InboxCommandRecovery, signal: AbortSignal, generation: number, local = false) {
    const check = () => { signal.throwIfAborted(); this.applicationScope.signal.throwIfAborted(); if (generation !== this.generation) throw new DOMException("Request cancelled", "AbortError"); };
    check();
    if (!validInboxCommandRecovery(plan) || plan.owner !== this.applicationScope.scope) throw new InboxRecoveryRejected("The captured command belongs to a different application scope.");
    for (const expected of plan.sources) {
      const source = local ? this.sourceAccounts.find(source => source.id === expected.sourceId) : await this.client.account(expected.sourceId, { signal }); check();
      if (!source || source.status !== "connected" || source.generation !== expected.generation) throw new InboxRecoveryRejected("The captured source generation changed. No command was replayed.");
      for (const id of expected.mailboxIds) {
        const box = local ? this.state.mailboxes.find(box => box.id === id) : await this.client.mailbox(id, { signal }); check();
        if (!box || box.sourceId !== expected.sourceId || box.status === "detached") throw new InboxRecoveryRejected("The captured receiving scope changed. No command was replayed.");
      }
    }
    return check;
  }
  private async applyFeedbackRecovery(plan: Extract<InboxCommandRecovery, { kind: "attention-feedback" }>, sink: InboxRecoverySink | undefined, signal: AbortSignal, check: () => void): Promise<InboxUndo> {
    if (plan.status === "rejected" || plan.status === "retracted") throw new InboxRecoveryRejected("The original feedback command is no longer active. Review this conversation before choosing another action.");
    plan.status = "uncertain"; this.publishRecovery(plan, sink); check();
    let event: AttentionFeedback;
    try { event = await recordAttentionFeedback(plan.input, signal); }
    catch (error) {
      if (error instanceof InboxViewPreferencesError && error.status < 500 && ![408, 425, 429].includes(error.status)) plan.status = "rejected";
      this.publishRecovery(plan, sink); throw error;
    }
    check();
    if (event.id !== plan.input.id) throw new Error("The feedback acknowledgement does not match the captured command.");
    if (event.status === "failed" || event.status === "retracted") {
      plan.status = event.status === "failed" ? "rejected" : "retracted"; this.publishRecovery(plan, sink);
      throw new InboxRecoveryRejected(event.problem ?? "The original feedback command is no longer active.");
    }
    if (event.status !== "active" || !event.states || event.states.length !== plan.input.targets.length || event.states.some(state => !state.done || !plan.input.targets.some(target => target.mailboxId === state.mailboxId && target.messageId === state.messageId && state.revision > target.revision))) throw new Error("The feedback receipt is not yet confirmed. Retry the original request.");
    plan.status = "accepted"; this.publishRecovery(plan, sink); await this.receiveFeedback(event);
    const reverse: InboxUndo = async () => { reverse.inverseReceipts = await this.undoCommand(plan, sink); };
    reverse.recovery = plan; reverse.receipts = [{ kind: "attention-feedback", id: event.id }];
    return reverse;
  }
  /** Called only by an explicit user Retry. Construction/restoration performs no I/O. */
  replayCommand = (saved: InboxCommandRecovery, sink?: InboxRecoverySink): Promise<InboxUndo> => this.runRecoveredCommand(saved, sink, false);
  private runRecoveredCommand = (saved: InboxCommandRecovery, sink: InboxRecoverySink | undefined, fresh: boolean): Promise<InboxUndo> => {
    if (!validInboxCommandRecovery(saved)) return Promise.reject(new InboxRecoveryRejected("Invalid captured command."));
    const plan = structuredClone(saved), signal = this.controller.signal, generation = this.generation;
    return this.act("recover-mail-command", async () => {
      const check = await this.checkRecovery(plan, signal, generation, fresh);
      if (plan.kind === "attention-feedback") return this.applyFeedbackRecovery(plan, sink, signal, check);
      const reverse: InboxUndo = async () => { reverse.inverseReceipts = await this.undoCommand(plan, sink); };
      reverse.recovery = plan;
      if (plan.kind === "mailbox-state") {
        if (plan.status === "rejected") throw new InboxRecoveryRejected("The original command was rejected. Review the captured conversation before choosing another action.");
        this.publishRecovery(plan, sink);
        let receipt;
        try {
          // An acknowledged/retracted result is read first, including after a
          // lost inverse acknowledgement. Never infer ownership from equal state.
          if (!fresh) {
            try { receipt = await this.client.mailboxStateReceipt(plan.input.id, { signal }); }
            catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error; }
          }
          if (!receipt) {
            plan.status = "uncertain"; this.publishRecovery(plan, sink);
            try { receipt = await this.client.setMailboxStates(plan.input, { signal }); }
            catch (error) {
              if (signal.aborted || definitive(error)) throw error;
              receipt = await this.client.setMailboxStates(plan.input, { signal });
            }
          }
        } catch (error) {
          if (!(error instanceof InboxRecoveryStorageError) && definitive(error)) plan.status = "rejected";
          this.publishRecovery(plan, sink); throw error;
        }
        check();
        plan.status = receipt.retracted ? "retracted" : "accepted"; plan.accepted = receipt.states;
        if (receipt.retracted) plan.undoStatus = "accepted";
        this.publishRecovery(plan, sink); this.receiveMemberships(receipt.states);
        if (receipt.retracted) throw new InboxRecoveryRejected("The original mail command was already undone. No new decision was sent.");
        reverse.receipts = [{ kind: "mailbox-state", id: receipt.id }];
      } else {
        const total = plan.groups.reduce((n, g) => n + g.input.targets.length, 0);
        try {
          for (const group of plan.groups) {
            if (["accepted", "retracted"].includes(group.status)) continue;
            if (group.status === "rejected") throw new CategoryRequestError("HOST_CATEGORY_CONFLICT", 412);
            group.status = "uncertain"; this.publishRecovery(plan, sink);
            try {
              const receipt = await this.categoryTransport.classify(group.input!);
              check();
              if (receipt.id !== group.input.id || receipt.entries.length !== group.input.targets.length) throw new CategoryRequestError("HOST_CATEGORY_ACK_PENDING", 503);
              this.receiveCategories(receipt.entries); group.status = receipt.retracted ? "retracted" : "accepted";
              this.publishRecovery(plan, sink);
            } catch (error) {
              if (error instanceof CategoryRequestError && error.status < 500 && ![408, 425, 429].includes(error.status)) group.status = "rejected";
              this.publishRecovery(plan, sink); throw error;
            }
          }
        } catch (error) {
          const completed = plan.groups.filter(g => ["accepted", "retracted"].includes(g.status)).reduce((n, g) => n + g.input.targets.length, 0);
          reverse.receipts = plan.groups.filter(g => g.status === "accepted").map(g => ({ kind: "category", id: g.input.id }));
          const retry = !plan.groups.some(g => g.status === "rejected") ? () => this.replayCommand(plan, sink) : undefined;
          throw new InboxClassificationError(error instanceof CategoryRequestError ? error.code : "HOST_CATEGORY_ACK_PENDING", completed, total - completed, retry, completed ? reverse : undefined);
        }
        reverse.receipts = plan.groups.filter(g => g.status === "accepted").map(g => ({ kind: "category", id: g.input.id }));
      }
      this.scheduleRefresh(); return reverse;
    }, false);
  };
  /** The durable server receipt owns the conditional inverse, including reminders. */
  undoCommand = (saved: InboxCommandRecovery, sink?: InboxRecoverySink): Promise<InboxActionReceiptReference[]> => {
    if (!validInboxCommandRecovery(saved)) return Promise.reject(new InboxRecoveryRejected("Invalid captured command."));
    const plan = structuredClone(saved), signal = this.controller.signal, generation = this.generation;
    return this.act("recover-mail-undo", async () => {
      const check = await this.checkRecovery(plan, signal, generation);
      const references: InboxActionReceiptReference[] = [];
      if (plan.kind === "attention-feedback") {
        if (!["accepted", "retracted"].includes(plan.status) && plan.undoStatus !== "uncertain") throw new InboxRecoveryRejected("Confirm the original feedback before Undo.");
        plan.undoStatus = "uncertain"; this.publishRecovery(plan, sink);
        const event = await retractAttentionFeedback(plan.input.id, signal); check();
        if (event.id !== plan.input.id || event.status !== "retracted") throw new Error("Feedback Undo is not yet confirmed. Retry the original request.");
        plan.status = "retracted";
        if (event.problem || !event.states || event.states.length !== plan.input.targets.length) {
          plan.undoStatus = "rejected"; this.publishRecovery(plan, sink); await this.receiveFeedback(event);
          throw new InboxRecoveryRejected(event.problem ?? "Feedback was retracted, but its conditional mail inverse was not accepted.");
        }
        plan.undoStatus = "accepted"; this.publishRecovery(plan, sink); await this.receiveFeedback(event);
        references.push({ kind: "attention-feedback", id: plan.input.id });
      } else if (plan.kind === "mailbox-state") {
        if (plan.status !== "accepted" && plan.status !== "retracted" && plan.undoStatus !== "uncertain") throw new InboxRecoveryRejected("Confirm the original mail command before Undo.");
        plan.undoStatus = "uncertain"; this.publishRecovery(plan, sink);
        let receipt;
        try { receipt = await this.client.undoMailboxStates(plan.input.id, { signal }); }
        catch (error) { if (definitive(error)) plan.undoStatus = "rejected"; this.publishRecovery(plan, sink); throw error; }
        check();
        if (!receipt.retracted) throw new Error("The mail inverse is not yet acknowledged.");
        plan.status = "retracted"; plan.undoStatus = "accepted";
        this.publishRecovery(plan, sink); this.receiveMemberships(receipt.states);
        references.push({ kind: "mailbox-state", id: plan.input.id });
      } else for (const group of [...plan.groups].reverse()) {
        if (group.status !== "accepted" && group.status !== "retracted") continue;
        this.publishRecovery(plan, sink);
        const receipt = await this.categoryTransport.undo(group.input.id);
        check();
        if (!receipt.retracted) throw new Error("The category inverse is not yet acknowledged.");
        group.status = "retracted"; this.publishRecovery(plan, sink); this.receiveCategories(receipt.entries);
        references.push({ kind: "category", id: group.input.id });
      }
      this.scheduleRefresh(); return references;
    }, false);
  };
  /** Freeze user-selected context before any queue or network await. */
  classify = (mails: Mail[], category: AttentionCategory, sink?: InboxRecoverySink): Promise<InboxUndo> => mails.some(mail => mail.window && !mail.window.actionContextComplete)
    ? this.completeActionContext(mails).then(complete => this.classifyComplete(complete, category, sink)) : this.classifyComplete(mails, category, sink);
  private classifyComplete = (mails: Mail[], category: AttentionCategory, sink?: InboxRecoverySink): Promise<InboxUndo> => {
    type Group = { id: string; targets: CategoryCommand["targets"]; input?: CategoryCommand; receipt?: CategoryReceipt; uncertain?: boolean };
    const groups: Group[] = [], signal = this.controller.signal, generation = this.generation;
    const revisionKnown = new Set<string>();
    const failure = (code: CategoryErrorCode, completed = 0, remaining = mails.length, retry?: () => Promise<() => Promise<void>>, undo?: () => Promise<void>) => {
      const error = new InboxClassificationError(code, completed, remaining, retry, undo);
      this.raise({ scope: "action", code, title: "Couldn't change category", detail: error.message, retry: false });
      return error;
    };
    try {
      if (!this.state.host?.attentionOverrides) throw new CategoryRequestError("HOST_CATEGORY_UNAVAILABLE", 503);
      if (!mails.length || !["Important", "Other"].includes(category)) throw new CategoryRequestError("HOST_CATEGORY_INVALID", 400);
      const selected = new Map<string, Mail[]>(), current = new Map(this.state.mail.map(mail => [mail.id, mail]));
      for (const mail of mails) {
        const source = this.sourceAccounts.find(source => source.id === mail.sourceId);
        if (!source || source.status !== "connected" || source.generation !== mail.sourceGeneration || !mail.sdkThreadId || mail.operationId || !mail.window && !current.has(mail.id)) throw new CategoryRequestError("HOST_CATEGORY_CONTEXT_CHANGED", 412);
        if (!mail.messages.some(message => !message.pending && !message.outgoing && message.nativeFolder === "inbox" && message.memberships?.some(state => !state.done && (!state.snoozedUntil || Date.parse(state.snoozedUntil) <= Date.now())))) throw new CategoryRequestError("HOST_CATEGORY_CONTEXT_CHANGED", 412);
        const key = nativeKey(source.id, mail.sdkThreadId), copies = selected.get(key) ?? [];
        copies.push(mail); selected.set(key, copies);
      }
      for (const [key, copies] of selected) {
        const first = copies[0], messages = new Map<string, Message>();
        for (const mail of copies) for (const message of mail.messages) {
          if (message.pending) continue;
          const previous = messages.get(message.id);
          if (previous && (previous.revision !== message.revision || previous.bodyRevision !== message.bodyRevision)) throw new CategoryRequestError("HOST_CATEGORY_CONTEXT_CHANGED", 412);
          const memberships = new Map((previous?.memberships ?? []).map(state => [state.mailboxId, state]));
          for (const state of message.memberships ?? []) {
            if (memberships.has(state.mailboxId) && memberships.get(state.mailboxId)!.revision !== state.revision) throw new CategoryRequestError("HOST_CATEGORY_CONTEXT_CHANGED", 412);
            memberships.set(state.mailboxId, state);
          }
          messages.set(message.id, { ...message, memberships: [...memberships.values()] });
        }
        const received = [...messages.values()].sort((a, b) => (a.receivedAt ?? "").localeCompare(b.receivedAt ?? "") || a.id.localeCompare(b.id));
        const context: CategoryContext = {
          sourceId: first.sourceId!, threadId: first.sdkThreadId!, sourceGeneration: first.sourceGeneration!,
          mailboxIds: [...new Set(copies.flatMap(mail => mail.mailboxIds ?? [mail.mailboxId ?? mail.account]))].sort(),
          latestMessageId: received.at(-1)?.id ?? "",
          messages: received.map(message => ({ messageId: message.id, revision: message.revision ?? 0, bodyRevision: message.bodyRevision ?? null,
            memberships: (message.memberships ?? []).map(state => ({ mailboxId: state.mailboxId, revision: state.revision })).sort((a, b) => a.mailboxId.localeCompare(b.mailboxId)) })),
        };
        const memberships = context.messages.reduce((sum, message) => sum + message.memberships.length, 0);
        if (memberships > CATEGORY_MEMBERSHIP_LIMIT) throw new CategoryRequestError("HOST_CATEGORY_TOO_LARGE", 413);
        if (!isCategoryContext(context)) throw new CategoryRequestError("HOST_CATEGORY_INVALID", 400);
        for (const mail of copies) if (!currentCategoryOverride(current.get(mail.id) ?? mail, { category, context })) throw new CategoryRequestError("HOST_CATEGORY_CONTEXT_CHANGED", 412);
        const previous = this.categories.get(key);
        if (previous) revisionKnown.add(key);
        const target = { context, ifRevision: previous?.revision ?? 0 };
        let group = groups.at(-1);
        const fits = (group: Group) => group.targets.length <= CATEGORY_BATCH_LIMIT
          && group.targets.reduce((sum, target) => sum + target.context.messages.reduce((sum, message) => sum + message.memberships.length, 0), 0) <= CATEGORY_MEMBERSHIP_LIMIT
          && new TextEncoder().encode(JSON.stringify({ id: group.id, category, targets: group.targets })).length <= CATEGORY_BODY_LIMIT - 2048;
        if (!group) { group = { id: crypto.randomUUID(), targets: [] }; groups.push(group); }
        group.targets.push(target);
        if (!fits(group)) {
          group.targets.pop();
          if (!group.targets.length) throw new CategoryRequestError("HOST_CATEGORY_TOO_LARGE", 413);
          group = { id: crypto.randomUUID(), targets: [target] }; groups.push(group);
          if (!fits(group)) throw new CategoryRequestError("HOST_CATEGORY_TOO_LARGE", 413);
        }
      }
    } catch (error) { return Promise.reject(failure(error instanceof CategoryRequestError ? error.code : "HOST_CATEGORY_INVALID")); }
    // Only preceding own flag receipts may advance canonical revisions before a
    // command is first prepared. Never re-read/rebase mail after a lost response.
    const keys = new Set(groups.flatMap(group => group.targets.flatMap(target => target.context.messages.map(message => nativeKey(target.context.sourceId, message.messageId)))));
    const flags = [...this.flagWrites].filter(write => write.targets.some(target => keys.has(nativeKey(target.sourceId, target.messageId))));
    const edges = new Map([...keys].map(key => [key, new Map(this.flagRevisions.get(key))]));
    let preparedFlags = false, retired = false, running: Promise<() => Promise<void>> | undefined;
    let recovery: Extract<InboxCommandRecovery, { kind: "category" }> | undefined;
    const publish = () => { if (recovery) this.publishRecovery(recovery, sink); };
    const total = groups.reduce((sum, group) => sum + group.targets.length, 0);
    const check = () => { signal.throwIfAborted(); this.applicationScope.signal.throwIfAborted(); if (generation !== this.generation) throw new DOMException("Request cancelled", "AbortError"); };
    const undo: InboxUndo = async () => {
      retired = true;
      await this.act("undo-category", async () => {
        let problem: unknown;
        for (const group of [...groups].reverse()) {
          if (!group.receipt || group.receipt.retracted) continue;
          try {
            check();
            let receipt: CategoryReceipt;
            try { receipt = await this.categoryTransport.undo(group.id); }
            catch (error) {
              check();
              if (error instanceof CategoryRequestError && error.status < 500 && ![408, 425, 429].includes(error.status)) throw error;
              receipt = await this.categoryTransport.undo(group.id);
            }
            check(); this.receiveCategories(receipt.entries); group.receipt = receipt;
            const captured = recovery?.groups.find(entry => entry.input.id === group.id);
            if (captured) { captured.status = "retracted"; publish(); }
            undo.inverseReceipts = [...(undo.inverseReceipts ?? []), { kind: "category", id: group.id }];
            this.scheduleRefresh();
          } catch (error) { problem ??= error; }
        }
        if (problem) {
          check();
          throw failure(problem instanceof CategoryRequestError ? problem.code : "HOST_CATEGORY_ACK_PENDING");
        }
      }, false);
    };
    const resume = (): Promise<() => Promise<void>> => {
      if (running) return running;
      const task = this.act("category", async () => {
        try {
          check();
          if (retired) throw new CategoryRequestError("HOST_CATEGORY_CONFLICT", 412);
          if (!preparedFlags) {
            await Promise.allSettled(flags.flatMap(write => write.promise ? [write.promise] : [])); check();
            for (const write of flags) for (const edge of write.operation?.mutationRevisions ?? []) {
              if (edge.after > edge.before && write.targets.some(target => target.messageId === edge.messageId)) edges.get(nativeKey(write.targets[0].sourceId, edge.messageId))?.set(edge.before, edge.after);
            }
            for (const group of groups) for (const target of group.targets) for (const message of target.context.messages) {
              const links = edges.get(nativeKey(target.context.sourceId, message.messageId));
              while (links?.has(message.revision)) message.revision = links.get(message.revision)!;
            }
            preparedFlags = true;
          }
          for (const group of groups) {
            if (group.receipt) continue;
            if (!group.input) {
              const missing = group.targets.filter(target => !revisionKnown.has(categoryKey(target.context)));
              if (missing.length) {
                const result = await this.categoryTransport.lookup(missing.map(target => ({ sourceId: target.context.sourceId, threadId: target.context.threadId }))); check();
                if (result.entries.length !== missing.length) throw new CategoryRequestError("HOST_CATEGORY_UNAVAILABLE", 503);
                const found = new Map(result.entries.map(entry => [categoryKey(entry), entry]));
                for (const target of missing) {
                  const entry = found.get(categoryKey(target.context));
                  if (!entry) throw new CategoryRequestError("HOST_CATEGORY_UNAVAILABLE", 503);
                  target.ifRevision = entry.revision;
                }
                this.receiveCategories(result.entries);
              }
              group.input = structuredClone({ id: group.id, category, targets: group.targets });
            }
          }
          // Freeze every group before the first mutation, including groups that
          // have not yet been sent when an earlier acknowledgement is lost.
          if (sink && !recovery) recovery = { ...this.recoveryScope(mails), kind: "category", groups: groups.map(group => ({ input: structuredClone(group.input!), status: "prepared" })) };
          publish();
          for (const group of groups) {
            if (group.receipt) continue;
            const captured = recovery?.groups.find(entry => entry.input.id === group.id);
            if (captured) { captured.status = "uncertain"; publish(); }
            let receipt: CategoryReceipt;
            try { receipt = await this.categoryTransport.classify(group.input!); }
            catch (error) {
              check();
              if (error instanceof CategoryRequestError && error.status < 500 && ![408, 425, 429].includes(error.status)) throw error;
              group.uncertain = true;
              receipt = await this.categoryTransport.classify(group.input!);
            }
            check();
            if (receipt.entries.length !== group.targets.length || new Set(receipt.entries.map(categoryKey)).size !== group.targets.length || receipt.entries.some(entry => !group.targets.some(target => categoryKey(target.context) === categoryKey(entry)))) throw new CategoryRequestError("HOST_CATEGORY_UNAVAILABLE", 503);
            this.receiveCategories(receipt.entries);
            if (receipt.retracted) throw new CategoryRequestError("HOST_CATEGORY_CONFLICT", 412);
            group.receipt = receipt; group.uncertain = false;
            if (captured) { captured.status = "accepted"; publish(); }
          }
          undo.recovery = recovery;
          undo.receipts = groups.filter(group => group.receipt && !group.receipt.retracted).map(group => ({ kind: "category", id: group.id }));
          this.scheduleRefresh();
          return undo;
        } catch (error) {
          check();
          undo.receipts = groups.filter(group => group.receipt && !group.receipt.retracted).map(group => ({ kind: "category", id: group.id }));
          const completed = groups.filter(group => group.receipt && !group.receipt.retracted).reduce((sum, group) => sum + group.targets.length, 0);
          const uncertain = groups.some(group => group.uncertain && !group.receipt);
          // The host checks durable IDs before capacity: storage-full explicitly
          // rejects this new command, even if an earlier transport response was lost.
          const recoverable = !retired && !(error instanceof CategoryRequestError && error.code === "HOST_CATEGORY_STORAGE_FULL")
            && (uncertain || !(error instanceof CategoryRequestError) || error.status >= 500 || [408, 425, 429].includes(error.status));
          if (!recoverable && recovery) {
            const failed = recovery.groups.find(group => group.status === "uncertain");
            if (failed) failed.status = "rejected";
            publish();
          }
          undo.recovery = recovery;
          const code = recoverable ? "HOST_CATEGORY_ACK_PENDING" : error instanceof CategoryRequestError ? error.code : "HOST_CATEGORY_UNAVAILABLE";
          throw failure(code, completed, total - completed, recoverable ? resume : undefined, completed ? undo : undefined);
        }
      }, false);
      running = task;
      void task.finally(() => { if (running === task) running = undefined; }).catch(() => {});
      return task;
    };
    return resume();
  };

  private done(selected: Mail[], done: boolean | undefined, sink?: InboxRecoverySink, snoozedUntil?: string | null): Promise<InboxUndo> {
    const targets = new Map<string, MailboxStateTarget>();
    try {
      for (const mail of selected) {
        if (mail.operationId) throw new Error("Cancel the queued send before changing it.");
        if (mail.window) {
          if (!mail.window.targetsComplete) throw new Error("This conversation exceeds 500 message memberships. No mail was changed.");
          for (const target of mail.window.targets) {
            if (this.account(target.mailboxId).source.id !== mail.sourceId) throw new Error("The receiving scope changed.");
            targets.set(`${mail.sourceId}\0${target.messageId}\0${target.mailboxId}`, { mailboxId: target.mailboxId, messageId: target.messageId, revision: target.revision });
          }
          continue;
        }
        for (const message of mail.messages) {
          if (message.pending) continue;
          if (!message.memberships?.length) throw new Error("This conversation is still loading. Try again after it refreshes.");
          for (const state of message.memberships) {
            const { source } = this.account(state.mailboxId);
            if (source.id !== mail.sourceId) throw new Error("A conversation cannot span unrelated source accounts.");
            targets.set(membershipKey(source.id, state), { mailboxId: state.mailboxId, messageId: message.id, revision: state.revision });
          }
        }
      }
      if (!targets.size || targets.size > 500) throw new Error("Select between 1 and 500 message memberships for one Done action.");
    } catch (error) { return Promise.reject(error); }
    const input = { id: crypto.randomUUID(), targets: [...targets.values()], ...(done === undefined ? { snoozedUntil: snoozedUntil ?? null } : { done }) };
    const before = new Map<string, MailboxMembership>();
    for (const mail of selected) for (const message of mail.messages) for (const state of message.memberships ?? []) {
      if (!input.targets.some(target => target.mailboxId === state.mailboxId && target.messageId === message.id)) continue;
      before.set(`${state.mailboxId}\0${message.id}`, { mailboxId: state.mailboxId, messageId: message.id, revision: state.revision, done: state.done, snoozedUntil: state.snoozedUntil });
    }
    const plan: InboxCommandRecovery = { ...this.recoveryScope(selected), kind: "mailbox-state", input, before: [...before.values()], accepted: [], status: "prepared" };
    // SDK setMailboxStates now owns snooze as well as Done: its idempotent
    // receipt stores the actual original states and conditional inverse. Never
    // fall back to non-idempotent PATCH or infer a receipt from equal state.
    this.publishRecovery(plan, sink);
    return this.runRecoveredCommand(plan, sink, true);
  }
  canRecordFeedback = (selected: Mail[]): boolean => !!this.state.host?.preferenceScope && selected.length > 0 && selected.every(mail => !mail.operationId && !!mail.sourceId && mail.messages.some(message => !message.pending && !message.outgoing && message.nativeFolder === "inbox"
    && message.memberships?.some(state => !state.done && (!state.snoozedUntil || Date.parse(state.snoozedUntil) <= Date.now()))));
  private async notImportant(selected: Mail[], sink?: InboxRecoverySink): Promise<InboxUndo> {
    if (!this.state.host?.preferenceScope) throw new Error("The local host must be updated before it can save attention feedback.");
    if (!this.canRecordFeedback(selected)) throw new Error("Select incoming inbox conversations to record not-important feedback.");
    const captured = new Map<string, AttentionFeedbackTarget>();
    for (const mail of selected) for (const message of mail.messages) {
      if (message.pending) continue;
      if (!message.revision || !message.memberships?.length) throw new Error("This conversation is still loading. Try again after it refreshes.");
      for (const state of message.memberships) {
        const key = `${mail.sourceId}\0${state.mailboxId}\0${message.id}`;
        captured.set(key, { sourceId: mail.sourceId!, mailboxId: state.mailboxId, messageId: message.id, messageRevision: message.revision, revision: state.revision });
      }
    }
    // Freeze IDs and membership revisions at the W click. Only preceding flag
    // submissions for these canonical messages may advance message revisions;
    // a later reply, mailbox change or unrelated writer is never rebased in.
    const targets = [...captured.values()], id = crypto.randomUUID(), signal = this.controller.signal;
    const recoveryScope = this.recoveryScope(selected), generation = this.generation;
    const keys = new Set(targets.map(target => nativeKey(target.sourceId, target.messageId)));
    const flags = [...this.flagWrites].filter(write => write.targets.some(target => keys.has(nativeKey(target.sourceId, target.messageId))));
    const edges = new Map([...keys].map(key => [key, new Map(this.flagRevisions.get(key))]));
    return this.act("not-important", async () => {
      // Rejection of a flag is not rejection of local feedback. Abort still
      // stops this generation, and an ambiguous flag keeps its frozen request.
      await Promise.allSettled(flags.flatMap(write => write.promise ? [write.promise] : []));
      signal.throwIfAborted();
      for (const write of flags) if (write.operation?.accountId === write.targets[0].sourceId) {
        for (const edge of write.operation.mutationRevisions ?? []) {
          const key = nativeKey(write.operation.accountId, edge.messageId);
          if (write.targets.some(target => target.messageId === edge.messageId) && edge.after > edge.before) edges.get(key)?.set(edge.before, edge.after);
        }
      }
      // This is the first and only payload preparation. The host helper may
      // replay after a lost response, always with this same ID and payload.
      const input = { id, targets: targets.map(target => {
        let messageRevision = target.messageRevision;
        const links = edges.get(nativeKey(target.sourceId, target.messageId));
        while (links?.has(messageRevision)) messageRevision = links.get(messageRevision)!;
        return { ...target, messageRevision };
      }) };
      const plan: InboxCommandRecovery = { ...recoveryScope, kind: "attention-feedback", input, status: "prepared" };
      this.publishRecovery(plan, sink);
      const check = await this.checkRecovery(plan, signal, generation, true);
      return this.applyFeedbackRecovery(plan, sink, signal, check);
    }, false);
  }
  undoFeedback = (id: string): Promise<void> => this.act("undo-feedback", async () => {
    const event = await retractAttentionFeedback(id, this.controller.signal);
    await this.receiveFeedback(event);
    if (event.problem) throw new Error(event.problem);
  }, false);
  action = (selected: Mail[], action: string, value?: string, sink?: InboxRecoverySink): Promise<InboxUndo> => {
    if (!selected.length) return Promise.reject(new Error("Select a conversation before making changes."));
    if (selected.some(mail => mail.window && !mail.window.targetsComplete)) return Promise.reject(new Error("This conversation exceeds 500 message memberships. No mail was changed."));
    if (selected.reduce((sum, mail) => sum + (mail.window?.targets.length ?? 0), 0) > 500) return Promise.reject(new Error("Select at most 500 message memberships. No mail was changed."));
    if (action !== "done" && selected.some(mail => mail.window && !mail.window.actionContextComplete)) return this.completeActionContext(selected).then(mails => this.actionComplete(mails, action, value, sink));
    return this.actionComplete(selected, action, value, sink);
  };
  private actionComplete = (selected: Mail[], action: string, value?: string, sink?: InboxRecoverySink): Promise<InboxUndo> => ["read", "unread", "star"].includes(action) ? this.flagAction(selected, action) : action === "not-important" ? this.notImportant(selected, sink)
    : action === "remind" ? this.done(selected, undefined, sink, value)
    : action === "done" || action === "inbox" && selected.every(mail => !mail.operationId && mail.messages.every(message => message.pending || ["inbox", "sent"].includes(message.nativeFolder ?? ""))) ? this.done(selected, action === "done", sink) : this.act(action, async () => {
    // Keep the clicked message/membership scope: a queued action must not absorb
    // a newly arrived reply or a later change to Unified inbox configuration.
    const undo: Array<() => Promise<unknown>> = [];
    const receipts: InboxActionReceiptReference[] = [], inverseReceipts: InboxActionReceiptReference[] = [];
    const starred = selected.some(mail => !mail.starred), unread = selected.some(mail => !mail.unread);
    const native = action === "star" ? { isStarred: starred } : action === "unread" ? { isRead: !unread } : action === "read" ? { isRead: true }
      : action === "trash" ? { folder: "trash" } : action === "spam" ? { folder: "spam" } : undefined;
    for (const mail of selected) {
      if (mail.operationId && !["trash", "cancel"].includes(action)) throw new Error("Cancel the queued send before changing it.");
      if (!mail.operationId && !native && !["done", "inbox"].includes(action)) throw new Error(`The SDK does not expose ${action}; no simulated mail change was made.`);
      if (native && !mail.operationId) for (const boxId of this.mailboxTargets(mail).keys()) {
        const capability = action === "star" ? "star" : action === "unread" && unread ? "markUnread" : ["unread", "read"].includes(action) ? "markRead" : action === "trash" ? "trash" : "folders";
        const { source } = this.account(boxId);
        if (!this.state.host?.allowProviderWrites || source.status !== "connected" || !source.capabilities[capability]) throw new Error(`A selected source does not support ${action}.`);
      }
    }
    try {
      for (const mail of selected) {
        if (mail.operationId) { await this.client.cancel(mail.operationId, this.requestOptions()); continue; }
        if (native) {
          for (const [boxId, ids] of this.mailboxTargets(mail)) {
            const operation = await this.mutation(boxId, ids, native);
            undo.push(() => this.client.undo(operation.id, this.requestOptions()).then(operation => this.settled(operation)));
          }
        } else {
          if (action === "inbox") for (const [boxId, ids] of this.mailboxTargets(mail)) {
            const rows = await Promise.all(ids.map(id => this.state.host?.inboxWindow ? this.client.mailboxMessageSummary(boxId, id, this.requestOptions()) : this.client.mailboxMessage(boxId, id, this.requestOptions())));
            const moved = rows.filter(row => !["inbox", "sent"].includes(row.folder));
            if (moved.length) {
              const operation = await this.mutation(boxId, moved.map(row => row.id), { folder: "inbox" });
              undo.push(() => this.client.undo(operation.id, this.requestOptions()).then(operation => this.settled(operation)));
            }
          }
          // Unified local actions affect only memberships represented by this view.
          for (const [boxId, ids] of this.mailboxTargets(mail, true)) for (const id of ids) {
            const captured = mail.messages.find(message => message.id === id)?.memberships?.find(state => state.mailboxId === boxId);
            const before = mail.window ? captured : (await this.client.mailboxMessage(boxId, id, this.requestOptions())).memberships.find(state => state.mailboxId === boxId);
            if (!before) throw new Error("The captured membership is incomplete. No further mail was changed.");
            const saved = await this.client.setMailboxState(boxId, id, { done: action === "done", snoozedUntil: null }, before.revision, this.requestOptions());
            this.receiveMemberships([saved]);
            receipts.push({ kind: "mailbox-membership", target: { mailboxId: boxId, messageId: id, revision: saved.revision } });
            undo.push(async () => {
              const restored = await this.client.setMailboxState(boxId, id, { done: before.done, snoozedUntil: before.snoozedUntil }, saved.revision, this.requestOptions());
              this.receiveMemberships([restored]); inverseReceipts.push({ kind: "mailbox-membership", target: { mailboxId: boxId, messageId: id, revision: restored.revision } });
            });
          }
        }
      }
    } catch (error) {
      let incomplete = false;
      for (const reverse of [...undo].reverse()) try { await reverse(); } catch { incomplete = true; }
      if (incomplete) throw new Error("The action did not finish, and some changes could not be restored. Refresh the inbox before retrying.");
      throw error;
    }
    const reverse: InboxUndo = async () => { await this.act("undo", async () => { for (const reverse of [...undo].reverse()) await reverse(); }); reverse.inverseReceipts = inverseReceipts; };
    reverse.receipts = receipts;
    return reverse;
  });

  setLabel = async (selected: Mail[], name: string, remove: boolean): Promise<() => Promise<void>> => {
    if (selected.some(mail => mail.window && !mail.window.targetsComplete) || selected.reduce((sum, mail) => sum + (mail.window?.targets.length ?? 0), 0) > 500) throw new Error("Choose at most 500 captured message memberships. No labels were changed.");
    return this.setLabelComplete(await this.completeActionContext(selected), name, remove);
  };
  private setLabelComplete = (selected: Mail[], name: string, remove: boolean) => this.act("label", async () => {
    const operations: Operation[] = [];
    const plans: Array<{ boxId: string; ids: string[]; changes: Changes }> = [];
    for (const mail of selected) {
      if (mail.operationId) throw new Error("Queued sends cannot be relabeled.");
      for (const [boxId, ids] of this.mailboxTargets(mail)) {
        const { source } = this.account(boxId);
        const local = this.labels.find(label => label.accountId === source.id && label.name === name);
        const native = this.folders.get(source.id)?.find(folder => folder.kind === "label" && folder.name === name);
        if (!local && !native) throw new Error("This label is not available in every selected source. Choose an individual mailbox to manage its labels.");
        const changes: Changes = local ? (remove ? { removeLabelIds: [local.id] } : { addLabelIds: [local.id] }) : (remove ? { removeLabels: [native!.role] } : { addLabels: [native!.role] });
        plans.push({ boxId, ids, changes });
      }
    }
    try { for (const plan of plans) operations.push(await this.mutation(plan.boxId, plan.ids, plan.changes)); }
    catch (error) {
      let incomplete = false;
      for (const operation of [...operations].reverse()) try { await this.settled(await this.client.undo(operation.id, this.requestOptions())); } catch { incomplete = true; }
      if (incomplete) throw new Error("Label changes did not finish, and some changes could not be restored. Refresh before retrying.");
      throw error;
    }
    return async () => { await this.act("undo-label", async () => { for (const operation of operations) await this.settled(await this.client.undo(operation.id, this.requestOptions())); }); };
  });
  createLabel = async (boxId: string, name: string) => { if (boxId === UNIFIED_ACCOUNT) throw new Error("Choose an individual mailbox to create a source label."); const { source } = this.account(boxId); await this.client.createLabel(source.id, name, this.requestOptions()); await this.refresh(); };
  editLabel = async (boxId: string, name: string, value?: string) => {
    if (boxId === UNIFIED_ACCOUNT) throw new Error("Choose an individual mailbox to edit a source label.");
    const { source } = this.account(boxId), label = this.labels.find(label => label.accountId === source.id && label.name === name);
    if (!label) throw new Error("The SDK can only rename or delete local labels, not provider labels.");
    if (value === undefined) await this.client.deleteLabel(label.id, this.requestOptions()); else await this.client.updateLabel(label.id, value, label.revision, this.requestOptions());
    await this.refresh();
  };
  undoSend = async (id: string) => {
    const operation = await this.client.undo(id, this.requestOptions());
    this.operations.set(id, operation);
    if (operation.status === "cancelled") {
      const ref = this.references.find(ref => ref.id === id);
      if (ref) this.submissions.delete(ref.draftId);
      this.sending.delete(id);
      this.rebuild();
    }
    await this.refresh(true);
  };
  setPolicy = async (policy: Partial<Policy>) => {
    const saved = await this.client.setPolicy(policy, this.requestOptions());
    if (this.state.policy?.remoteImages !== saved.remoteImages) {
      this.bodyEpoch++;
      this.details.clear();
    }
    this.publish({ policy: saved });
    this.rebuild();
  };
  setViewPreferences = (input: Omit<InboxViewPreferences, "revision">): Promise<void> => {
    const revision = this.state.viewPreferences?.revision;
    return this.act("inbox-preferences", async () => {
      if (revision === undefined) throw new Error("Inbox preferences are still loading.");
      const viewPreferences = await writeInboxViewPreferences({ ...input, revision }, this.controller.signal);
      this.publish({ viewPreferences }); this.rebuild();
    });
  };
  setSplitPreferences = (patch: Partial<Omit<SplitPreferences, "version">>): Promise<void> => this.act("split-preferences", async () => {
    if (!this.state.host?.preferenceScope) throw new Error("The local host must be updated before it can save split preferences.");
    const current = this.state.splitPreferences;
    if (!current) throw new Error("Split preferences are still loading.");
    const splitPreferences = await writeSplitPreferences({ ...normalizeSplits({ ...current, ...patch }), revision: current.revision }, this.controller.signal);
    this.publish({ splitPreferences });
  });
  sync = async (boxId: string) => this.act("sync", async () => {
    const ids = boxId === UNIFIED_ACCOUNT ? this.unifiedMailboxIds() : [boxId];
    const sources = new Set<string>();
    let failed = 0;
    for (const id of ids) {
      const { box } = this.account(id);
      if (box.status !== "active" || sources.has(box.sourceId)) continue;
      sources.add(box.sourceId);
      try { await this.client.syncMailbox(box.id, { folder: "inbox" }, this.requestOptions()); }
      catch (error) { if (this.controller.signal.aborted) throw error; failed++; }
    }
    if (failed) throw new Error(`${failed} ${failed === 1 ? "source could" : "sources could"} not refresh. Cached mail is still available.`);
  });
  /** Refreshes the snapshot (re-establishing the session if needed) and reconnects live updates now. Reads only; nothing is resent. */
  retry = async () => {
    const generation = this.generation;
    try { await this.readUpdates(true); }
    catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        try {
          const response = await this.fetch("/session", { method: "POST", credentials: "include", headers: { "X-Superlocal": "1" }, signal: this.controller.signal });
          if (!response.ok) throw new Error("Sign in through the host application before opening this inbox.");
          this.client.clearCache(); await this.readUpdates(true);
        } catch (next) { this.fail(next, "connect"); return; }
      } else { this.fail(error, "retry"); return; }
    }
    if (!this.started || generation !== this.generation) return;
    if (this.following) this.wake?.(); else void this.follow(generation);
  };
}
