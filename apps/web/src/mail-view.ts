import type { Mail, MailboxOption, Preferences } from "./data.ts";
import { currentAiDecision, inFolder, UNIFIED_ACCOUNT } from "./mail-model.ts";
import { compileSearch } from "./mail-search.ts";
import { ATTENTION_VERSION, conversationAttention } from "../../shared/mail-attention.ts";
import { attentionSplit } from "../../shared/splits.ts";
import type { AiTriageState } from "../../shared/ai-triage.ts";

export const ZERO_QUEUE_LIMIT = 100_000;
export type ZeroScope = Readonly<{
  account: string;
  mailboxes: ReadonlyArray<Readonly<{ id: string; sourceId: string; sourceGeneration: number | null }>>;
}>;
export type ZeroSession = {
  version: 1;
  id: string;
  scope: ZeroScope;
  startedAt: number;
  phase: "batches" | "review";
  paused: boolean;
  remainingIds: string[];
  reviewOnlyIds?: string[];
  currentId: string | null;
  initialCount: number;
  decidedCount: number;
  overflowCount: number;
};
export type ZeroQueue = { ids: string[]; total: number; overflowCount: number };
export type ZeroBatchCandidate = {
  id: string;
  basis: "no-outstanding-work" | "quiet-legacy-campaign" | "baseline-subscription";
  membershipCount: number;
  reviewVersion: string;
};
export type ZeroDecision = "done" | "later" | "other";

export function zeroScope(account: string, includedMailboxIds: readonly string[], accounts: readonly MailboxOption[]): ZeroScope {
  const boxes = new Map(accounts.map(box => [box.id, box]));
  const ids = [...new Set(account === UNIFIED_ACCOUNT ? includedMailboxIds : [account])].sort();
  // Bootstrap or removal invalidates the whole requested scope, never a partial one.
  if (ids.some(id => !boxes.has(id))) return Object.freeze({ account, mailboxes: Object.freeze([]) });
  const mailboxes = ids.map(id => {
    const box = boxes.get(id)!;
    return Object.freeze({ id, sourceId: box.sourceId, sourceGeneration: box.sourceGeneration ?? null });
  });
  return Object.freeze({ account, mailboxes: Object.freeze(mailboxes) });
}

export function zeroStorageKey(scope: ZeroScope): string {
  return `get-to-zero:v1:${JSON.stringify([scope.account, [...scope.mailboxes].sort((a, b) => a.id.localeCompare(b.id))
    .map(box => [box.id, box.sourceId, box.sourceGeneration])])}`;
}
export function sameZeroScope(a: ZeroScope, b: ZeroScope): boolean { return zeroStorageKey(a) === zeroStorageKey(b); }

function eligibleZeroMail(mail: Mail, scope: ZeroScope, boxes: ReadonlyMap<string, string>, now: number): boolean {
  if (!boxes.size || mail.account !== scope.account || !mail.sourceId || !mail.sdkThreadId || mail.operationId || mail.muted) return false;
  let awake = false;
  for (const message of mail.messages) {
    if (message.pending) continue;
    if (!message.memberships?.length) return false;
    for (const state of message.memberships) {
      if (boxes.get(state.mailboxId) !== mail.sourceId) return false;
      if (!message.outgoing && message.nativeFolder === "inbox" && !state.done &&
        (!state.snoozedUntil || Date.parse(state.snoozedUntil) <= now)) awake = true;
    }
  }
  return awake && conversationAttention(mail, now) === "Important";
}

export function zeroEligible(mail: Mail, scope: ZeroScope, now = Date.now()): boolean {
  return eligibleZeroMail(mail, scope, new Map(scope.mailboxes.map(box => [box.id, box.sourceId])), now);
}

/** Explicit session-start snapshot, never a second selector on ordinary inbox renders. */
export function selectZeroQueue(accountMail: readonly Mail[], scope: ZeroScope, now = Date.now()): ZeroQueue {
  const boxes = new Map(scope.mailboxes.map(box => [box.id, box.sourceId]));
  const seen = new Set<string>(), ids: string[] = [];
  for (const mail of accountMail) {
    if (!eligibleZeroMail(mail, scope, boxes, now)) continue;
    const key = JSON.stringify([mail.sourceId, mail.sdkThreadId]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (ids.length < ZERO_QUEUE_LIMIT) ids.push(mail.id);
  }
  return { ids, total: seen.size, overflowCount: seen.size - ids.length };
}

/** Content/receiving scope, not read/star revisions or body-loading/open state. */
export function zeroReviewVersion(mail: Mail, scope: ZeroScope): string {
  const received = mail.messages.filter(message => !message.pending);
  return JSON.stringify([zeroStorageKey(scope), mail.id, mail.sourceId, mail.sdkThreadId, mail.subject, mail.snippet,
    received.at(-1)?.id ?? null, received.map(message => [message.id, message.bodyRevision ?? null, message.nativeFolder ?? null,
      !!message.outgoing, message.email, message.to, message.cc ?? "", message.receivedAt ?? null,
      [...(message.memberships ?? [])].sort((a, b) => a.mailboxId.localeCompare(b.mailboxId))
        .map(state => [state.mailboxId, state.done, state.snoozedUntil])]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))) ]);
}

/** A matching reviewVersion never replaces this current safety/provenance check. */
export function zeroBatchCandidate(mail: Mail, scope: ZeroScope, ai: AiTriageState | null = null, now = Date.now()): ZeroBatchCandidate | null {
  if (!zeroEligible(mail, scope, now) || mail.attentionOverride?.override || mail.triage?.override || mail.messages.some(message => message.pending)) return null;
  const received = mail.messages.filter(message => !message.pending);
  const memberships = new Set(received.flatMap(message => (message.memberships ?? []).map(state => JSON.stringify([message.id, state.mailboxId]))));
  if (!memberships.size || memberships.size > 500) return null;
  let basis: ZeroBatchCandidate["basis"];
  if (mail.triage) {
    if (!ai?.configured || !ai.settings.enabled) return null;
    const decision = currentAiDecision(mail, mail.triage, ai.settings.model);
    const assessment = decision?.assessment;
    if (decision?.state !== "ready" || decision.settingsRevision !== ai.settings.revision || decision.problemCode || decision.override || !assessment ||
      assessment.certainty !== "clear" || assessment.type === "unknown" || assessment.response !== "not_needed" || assessment.actions.length ||
      assessment.urgency !== "none" || assessment.deadline !== null || assessment.risk !== "none_observed") return null;
    const context = new Map(decision.contextVersions.map(value => [value.messageId, value.bodyRevision]));
    const assessedIds = new Set(decision.messageIds);
    if (!received.length || received.some(message => !assessedIds.has(message.id) || typeof message.bodyRevision !== "string" || !message.bodyRevision || context.get(message.id) !== message.bodyRevision)) return null;
    if (assessment.task === "none") basis = "no-outstanding-work";
    else if (assessment.task === undefined && ["promotion", "newsletter", "cold_outreach"].includes(assessment.type) && assessment.evidence.some(item => item.field === "type")) basis = "quiet-legacy-campaign";
    else return null;
  } else {
    // An unexplained applied category cannot be bypassed using weaker baseline hints.
    if (mail.attentionCategory) return null;
    const incoming = received.filter(message => !message.outgoing && message.nativeFolder === "inbox" && message.memberships?.some(state => !state.done && (!state.snoozedUntil || Date.parse(state.snoozedUntil) <= now)));
    if (!incoming.length || !incoming.every(message => message.attention?.version === ATTENTION_VERSION && message.attention.category === "Other" &&
      ["native-promotions", "subscription-headers", "subscription-and-campaign"].includes(message.attention.reason))) return null;
    basis = "baseline-subscription";
  }
  return { id: mail.id, basis, membershipCount: memberships.size, reviewVersion: zeroReviewVersion(mail, scope) };
}

/** Read only the bounded session schema; never restore mail graphs or action receipts. */
export function normalizeZeroSession(value: unknown, expectedScope: ZeroScope): ZeroSession | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const saved = value as Record<string, unknown>;
  const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 1024;
  const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  if (saved.version !== 1 || !text(saved.id) || typeof saved.startedAt !== "number" || !Number.isFinite(saved.startedAt) || saved.startedAt <= 0 ||
    saved.phase !== "batches" && saved.phase !== "review" || typeof saved.paused !== "boolean" ||
    !count(saved.initialCount) || saved.initialCount > ZERO_QUEUE_LIMIT || !count(saved.decidedCount) || !count(saved.overflowCount) ||
    !Array.isArray(saved.remainingIds) || saved.remainingIds.length > ZERO_QUEUE_LIMIT || !saved.remainingIds.every(text) ||
    new Set(saved.remainingIds).size !== saved.remainingIds.length || saved.remainingIds.length + saved.decidedCount > saved.initialCount ||
    saved.currentId !== null && (!text(saved.currentId) || !saved.remainingIds.includes(saved.currentId))) return null;
  let reviewOnlyIds: string[] | undefined;
  if (Object.hasOwn(saved, "reviewOnlyIds")) {
    const ids = saved.reviewOnlyIds;
    if (!Array.isArray(ids) || ids.length > ZERO_QUEUE_LIMIT || !ids.every(text) || new Set(ids).size !== ids.length) return null;
    reviewOnlyIds = [...ids];
  }
  if (!saved.scope || typeof saved.scope !== "object" || Array.isArray(saved.scope)) return null;
  const captured = saved.scope as Record<string, unknown>;
  if (!text(captured.account) || !Array.isArray(captured.mailboxes) || captured.mailboxes.length > 1000) return null;
  const boxes: Array<{ id: string; sourceId: string; sourceGeneration: number | null }> = [];
  for (const item of captured.mailboxes) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const box = item as Record<string, unknown>;
    if (!text(box.id) || !text(box.sourceId) || box.sourceGeneration !== null && !count(box.sourceGeneration)) return null;
    boxes.push({ id: box.id, sourceId: box.sourceId, sourceGeneration: box.sourceGeneration as number | null });
  }
  if (new Set(boxes.map(box => box.id)).size !== boxes.length || !sameZeroScope({ account: captured.account, mailboxes: boxes }, expectedScope)) return null;
  return { version: 1, id: saved.id, scope: Object.freeze({ account: expectedScope.account, mailboxes: Object.freeze(expectedScope.mailboxes.map(box => Object.freeze({ ...box }))) }),
    startedAt: saved.startedAt, phase: saved.phase as ZeroSession["phase"], paused: saved.paused,
    remainingIds: [...saved.remainingIds], ...(reviewOnlyIds ? { reviewOnlyIds } : {}), currentId: saved.currentId as string | null,
    initialCount: saved.initialCount, decidedCount: saved.decidedCount, overflowCount: saved.overflowCount };
}

export type MailListEntry = {
  key: string;
  top: number;
  height: number;
  mail: Mail;
  index: number;
  group?: string;
};

export function selectMailView(
  accountMail: Mail[],
  account: string,
  folder: string,
  split: string,
  preferences: Preferences,
  search: boolean,
  query: string,
  filter: string | null,
  serverMatches?: ReadonlySet<string>,
  mobile = false,
) {
  const rules = preferences.splitRules as Record<string, string> | undefined;
  const aliases = preferences.splitAliases as
    Record<string, string> | undefined;
  const matchers = new Map([...new Set([...preferences.splits, split])].map(name => {
    const category = attentionSplit({ splitRules: rules ?? {}, splitAliases: aliases ?? {} }, name);
    const query = rules?.[name];
    return [name, { category, matches: !category && typeof query === "string" && query.trim() ? compileSearch(query, false) : undefined }] as const;
  }));
  const splitCounts = Object.fromEntries(preferences.splits.map(name => [name, 0]));
  const countedSplits = [...new Set(preferences.splits)];
  const queryMatches = search && !serverMatches ? compileSearch(query) : undefined;
  const searchHidden = /in:(trash|spam)/i.test(query);
  const visibleMail: Mail[] = [];
  const now = Date.now();
  let holdingMail = false;
  let inboxCount = 0;
  for (const message of accountMail) {
    const inbox = inFolder(message, "Inbox");
    if (!search && folder === "Inbox" && inbox && (message.aiHoldUntil ?? 0) > now) { holdingMail = true; continue; }
    const attention = inbox || filter === "Important" ? conversationAttention(message) : undefined;
    const matchesSplit = (name: string) => {
      const matcher = matchers.get(name)!;
      return matcher.category ? attention === matcher.category : matcher.matches?.(message) ?? false;
    };
    let selectedSplit = false;
    if (inbox) {
      if (attention === "Important") inboxCount++;
      for (const name of countedSplits) {
        const matches = matchesSplit(name);
        if (matches) splitCounts[name]++;
        if (name === split) selectedSplit = matches;
      }
      if (!Object.hasOwn(splitCounts, split)) selectedSplit = matchesSplit(split);
    }
    if (filter === "Unread" && !message.unread) continue;
    if (filter === "Starred" && !message.starred) continue;
    if (filter === "Important" && attention !== "Important") continue;
    if (filter === "No reply" && !(message.messages.at(-1)?.outgoing ?? message.messages.at(-1)?.email === account)) continue;
    const assessment = message.triage?.state === "ready" ? message.triage.assessment : null;
    if (filter === "Needs reply" && assessment?.response !== "needed") continue;
    if (filter === "Action requested" && !assessment?.actions.length) continue;
    if (filter === "Time-sensitive" && assessment?.urgency !== "immediate" && assessment?.urgency !== "deadline") continue;
    if (filter === "Suspicious" && assessment?.risk !== "spam_suspected" && assessment?.risk !== "phishing_suspected") continue;
    if (filter === "Unassessed" && assessment) continue;
    if (search) {
      if ((message.folder === "Trash" || message.folder === "Spam") && !searchHidden) continue;
      if (!(serverMatches ? serverMatches.has(message.id) : queryMatches!(message))) continue;
    } else if (folder === "Inbox" ? !inbox || !selectedSplit : !inFolder(message, folder)) continue;
    visibleMail.push(message);
  }
  const shownSplits = preferences.splits.filter(
    (name) =>
      !preferences.hideEmptySplits || name === split || splitCounts[name] > 0,
  );
  const rowHeight = mobile ? 44 : preferences.density === "Compact" ? 30 : 36;
  const entries: MailListEntry[] = [];
  let totalHeight = 0;
  for (const [index, message] of visibleMail.entries()) {
    if (
      folder !== "Inbox" &&
      !search &&
      index > 0 &&
      message.group &&
      message.group !== visibleMail[index - 1].group
    ) {
      entries.push({
        key: `group-${message.id}`,
        top: totalHeight,
        height: 60,
        mail: message,
        index,
        group: message.group === "August" ? "Earlier in August" : message.group,
      });
      totalHeight += 60;
    }
    entries.push({
      key: message.id,
      top: totalHeight,
      height: rowHeight,
      mail: message,
      index,
    });
    totalHeight += rowHeight;
  }
  return {
    visibleMail,
    shownSplits,
    splitCounts,
    entries,
    totalHeight,
    rowHeight,
    inboxCount,
    holdingMail,
  };
}

// Find the visible slice without scanning the entire mailbox on each scroll.
export function mailWindow(
  entries: MailListEntry[],
  top: number,
  height: number,
  rowHeight: number,
) {
  const last = entries.at(-1);
  const total = last ? last.top + last.height : 0;
  const offset = Math.max(0, Math.min(top, Math.max(0, total - height)));
  const minimum = offset - rowHeight * 6;
  const maximum = offset + height + rowHeight * 6;
  let low = 0,
    high = entries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (entries[middle].top + entries[middle].height < minimum)
      low = middle + 1;
    else high = middle;
  }
  const start = low;
  high = entries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (entries[middle].top <= maximum) low = middle + 1;
    else high = middle;
  }
  return { start, end: low };
}
