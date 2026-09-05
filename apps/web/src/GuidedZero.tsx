import { useEffect, useMemo, useRef, useState } from "react";
import { captureActionMail, type Mail } from "./data";
import type { InboxActionReceiptReference, InboxZeroSession, InboxZeroItem, InboxZeroProgressInput, InboxZeroProgressResult, InboxZeroUndoInput, InboxZeroUndoResult, InboxWindowTransport } from "../../shared/inbox-window";
import { createCategoryTransport } from "./host";
import { createScopedFetch } from "./application-auth";
import { getApplicationScope } from "./application-scope";
import { InboxClassificationError, validInboxCommandRecovery, type InboxCommandRecovery, type InboxRecoverySink, type InboxSnapshot, type InboxStore, type InboxUndo } from "./inbox";
import { Modal } from "./components";
import { readSaved, writeSaved } from "./storage";
import { measureAction } from "./browser-logs";
import {
  normalizeZeroSession, sameZeroScope, selectZeroQueue, zeroBatchCandidate,
  zeroEligible, zeroReviewVersion, zeroScope, zeroStorageKey,
  type ZeroSession,
} from "./mail-view";
import "./guided-zero.css";

type Offer = { mail: Mail; version: string; candidate?: InboxZeroItem };
/** Only this bounded prefix is offered for confirmation; the suffix stays queued. */
export function boundedZeroBatch(items: readonly InboxZeroItem[]): InboxZeroItem[] {
  const result: InboxZeroItem[] = [];
  let memberships = 0;
  for (const item of items) {
    if (item.eligibility !== "eligible" || item.batchEligibility !== "eligible" || !item.batchCandidate || !item.reviewVersion) continue;
    const count = item.batchCandidate.membershipCount;
    if (!Number.isSafeInteger(count) || count < 1 || count > 500) continue;
    if (result.length === 50 || memberships + count > 500) break;
    result.push(item); memberships += count;
  }
  return result;
}
export function assertZeroMembershipBudget(mails: readonly Mail[]) {
  let memberships = 0;
  for (const mail of mails) {
    if (mail.window && (!mail.window.targetsComplete || !mail.window.actionContextComplete)) throw new Error("The captured action context is incomplete. Review this conversation individually.");
    const count = mail.window ? mail.window.targets.length : new Set(mail.messages.filter(message => !message.pending).flatMap(message => (message.memberships ?? []).map(state => JSON.stringify([state.mailboxId, message.id])))).size;
    if (!count || (memberships += count) > 500) throw new Error("Choose at most 500 captured message memberships for one cleanup decision. No mail was changed.");
  }
  if (!memberships) throw new Error("Select a captured conversation before making a cleanup decision.");
}
/** Re-read the existing captured page, never recapture or append new identities. */
export async function revalidateZeroBatch(input: Parameters<InboxWindowTransport["zeroPage"]>[0], selected: readonly InboxZeroItem[], read: InboxWindowTransport["zeroPage"]) {
  if (!selected.length || selected.length > 50 || new Set(selected.map(item => item.id)).size !== selected.length || boundedZeroBatch(selected).length !== selected.length) throw new Error("This group exceeds the cleanup membership budget. No mail was changed.");
  const page = await read({ ...input, limit: 100 });
  if (page.session.id !== input.sessionId || page.session.status === "invalidated") throw new Error("The captured cleanup scope changed. No mail was changed.");
  const fresh = new Map(page.items.map(item => [item.id, item]));
  for (const item of selected) {
    const current = fresh.get(item.id);
    if (!current || current.eligibility !== "eligible" || current.batchEligibility !== "eligible" || !current.batchCandidate || current.reviewVersion !== item.reviewVersion || JSON.stringify(current.batchCandidate) !== JSON.stringify(item.batchCandidate)) throw new Error("This routine group changed or is still being checked. Review it individually; no mail was changed.");
  }
  return page;
}
type Undo = { sessionId: string; ids: string[]; reverse: () => Promise<void> };
type Options = {
  inbox: InboxSnapshot;
  store: InboxStore;
  account: string;
  mailboxIds: string[];
  accountMail: Mail[];
  currentMail?: Mail;
  visible: boolean;
  onOpen: (mail?: Mail) => void;
  onPause: () => void;
};

type CapturedDecision = Pick<InboxZeroProgressInput["decisions"][number], "id" | "decision" | "reviewVersion">;
type ProgressAttempt = { input: InboxZeroProgressInput; result?: InboxZeroProgressResult; undoInput?: InboxZeroUndoInput; undoResult?: InboxZeroUndoResult };
/** Only frozen IDs/versions, accepted receipt references and exact progress requests.
 * No mail/body graph or executable retry closure is serialized. */
export type ZeroRecoveryJournal = {
  version: 1;
  session: InboxZeroSession;
  selection: CapturedDecision[];
  completedIds: string[];
  undoneIds: string[];
  receipts: InboxActionReceiptReference[];
  inverseReceipts: InboxActionReceiptReference[];
  attempts: ProgressAttempt[];
  mailPending: boolean;
  command?: InboxCommandRecovery;
  undoRequested: boolean;
  problem: string;
};
const ZERO_RECOVERY_BYTES = 1024 * 1024;
// The old host review version embeds raw subject/snippet/address JSON. It may
// be compared in memory, but must never enter durable command recovery.
const opaqueReviewVersion = (value: string) => /^[A-Za-z0-9:_-]{1,256}$/.test(value);
const recoveryStorageKey = (session: Pick<InboxZeroSession, "account" | "id">) => `get-to-zero:v2:recovery:${session.account}:${session.id}`;
const receiptKey = (reference: InboxActionReceiptReference) => JSON.stringify(reference);
const uniqueReceipts = (values: InboxActionReceiptReference[]) => [...new Map(values.map(reference => [receiptKey(reference), reference])).values()];
const acceptedIds = (attempt: ProgressAttempt) => attempt.result?.results.filter(result => result.status === "accepted").map(result => result.id) ?? [];

export function restoreZeroRecovery(value: unknown, session: InboxZeroSession): ZeroRecoveryJournal | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const journal = value as ZeroRecoveryJournal;
  const texts = (values: unknown): values is string[] => Array.isArray(values) && values.length <= 100 && values.every(id => typeof id === "string" && id.length > 0 && id.length <= 1024);
  const receipt = (value: InboxActionReceiptReference) => value && (value.kind === "mailbox-membership"
    ? value.target && typeof value.target.mailboxId === "string" && typeof value.target.messageId === "string" && Number.isSafeInteger(value.target.revision)
    : ["category", "mailbox-state", "attention-feedback", "operation"].includes(value.kind) && typeof value.id === "string" && value.id.length > 0 && value.id.length <= 1024);
  if (journal.version !== 1 || journal.session?.id !== session.id || journal.session.account !== session.account || journal.session.scopeKey !== session.scopeKey ||
    !Array.isArray(journal.selection) || journal.selection.length > 100 || !journal.selection.every(item => item && typeof item.id === "string" && typeof item.reviewVersion === "string" && ["done", "other", "later"].includes(item.decision)) ||
    !texts(journal.completedIds) || !texts(journal.undoneIds) || !Array.isArray(journal.receipts) || !journal.receipts.every(receipt) ||
    !Array.isArray(journal.inverseReceipts) || !journal.inverseReceipts.every(receipt) || !Array.isArray(journal.attempts) || journal.attempts.length > 100 ||
    typeof journal.mailPending !== "boolean" || typeof journal.undoRequested !== "boolean" || typeof journal.problem !== "string") return null;
  if (journal.command !== undefined && !validInboxCommandRecovery(journal.command) || journal.selection.some(item => !opaqueReviewVersion(item.reviewVersion))) return null;
  const selection = new Map(journal.selection.map(item => [item.id, item]));
  if (journal.completedIds.some(id => !selection.has(id)) || journal.undoneIds.some(id => !journal.completedIds.includes(id))) return null;
  for (const attempt of journal.attempts) {
    const input = attempt?.input;
    if (!input || input.sessionId !== session.id || typeof input.id !== "string" || !Number.isSafeInteger(input.ifRevision) || !Array.isArray(input.decisions) || input.decisions.length > 100 ||
      !input.decisions.every(item => item && selection.get(item.id)?.reviewVersion === item.reviewVersion && selection.get(item.id)?.decision === item.decision && Array.isArray(item.receipts) && item.receipts.every(receipt))) return null;
    if (attempt.result && (attempt.result.session?.id !== session.id || !Array.isArray(attempt.result.results) || !attempt.result.results.every(item => input.decisions.some(decision => decision.id === item.id) && ["accepted", "pending", "rejected"].includes(item.status)))) return null;
    if (attempt.undoInput && (attempt.undoInput.reference.sessionId !== session.id || attempt.undoInput.reference.progressId !== input.id || typeof attempt.undoInput.id !== "string" || !Array.isArray(attempt.undoInput.receipts) || !attempt.undoInput.receipts.every(receipt))) return null;
  }
  if (new TextEncoder().encode(JSON.stringify(journal)).length > ZERO_RECOVERY_BYTES) return null;
  return structuredClone(journal);
}

/** Testable protocol coordinator; all writes remain the existing host/SDK operations.
 * A retry of a lost/partial progress response always sends the exact saved request. */
export class ZeroActionRecovery {
  private retryMail?: () => Promise<InboxUndo>;
  private reverse?: InboxUndo;
  private busy = false;
  constructor(readonly journal: ZeroRecoveryJournal, private readonly io: {
    transport: Pick<InboxWindowTransport, "zeroResume" | "zeroProgress" | "zeroUndo">;
    save: (journal: ZeroRecoveryJournal) => boolean;
    session: (session: InboxZeroSession) => void;
    undoMail: (references: InboxActionReceiptReference[], reverse?: InboxUndo, command?: InboxCommandRecovery, sink?: InboxRecoverySink) => Promise<InboxActionReceiptReference[]>;
    replayMail?: (command: InboxCommandRecovery, sink: InboxRecoverySink) => Promise<InboxUndo>;
  }) {}
  readonly captureCommand: InboxRecoverySink = command => {
    if (!validInboxCommandRecovery(command)) throw new Error("Invalid frozen mail command.");
    this.journal.command = structuredClone(command); this.checkpoint();
  };
  checkpoint() {
    if (this.journal.selection.some(item => !opaqueReviewVersion(item.reviewVersion))) throw new Error("This host must provide opaque cleanup review tokens before reload-safe decisions can be saved. No mail command was sent.");
    if (new TextEncoder().encode(JSON.stringify(this.journal)).length > ZERO_RECOVERY_BYTES || !this.io.save(this.journal)) throw new Error("Cleanup recovery could not be saved. Keep this session open; no new mail action was submitted.");
  }
  get canUndo() { return this.journal.completedIds.some(id => !this.journal.undoneIds.includes(id)) || this.journal.attempts.some(attempt => attempt.undoInput && attempt.undoResult?.status !== "accepted"); }
  get blocked() {
    if (this.journal.mailPending || this.journal.undoRequested) return true;
    return this.journal.completedIds.some(id => !this.journal.undoneIds.includes(id) && !this.journal.attempts.some(attempt => acceptedIds(attempt).includes(id)));
  }
  get complete() { return !this.blocked && this.journal.selection.every(item => this.journal.completedIds.includes(item.id)); }
  get problem() {
    if (this.journal.attempts.some(attempt => attempt.result?.results.some(result => result.status === "rejected"))) return "Some cleanup progress was rejected. The affected conversations remain current; Undo is available for accepted mail changes.";
    return this.journal.problem || "Accepted mail changes are still being checked. The unconfirmed conversations remain current.";
  }
  private receive(session: InboxZeroSession) {
    if (session.id !== this.journal.session.id || session.scopeKey !== this.journal.session.scopeKey) throw new Error("The captured cleanup scope changed. Recovery has been retained.");
    if (session.revision >= this.journal.session.revision) this.journal.session = session;
    this.io.session(session);
  }
  private async resume() {
    const result = await this.io.transport.zeroResume({ sessionId: this.journal.session.id, account: this.journal.session.account });
    if (result.status !== "found" || result.session.status === "invalidated") throw new Error("The captured cleanup session is not available in this scope. Recovery has been retained.");
    this.receive(result.session);
  }
  private acknowledge(count: number, reverse: InboxUndo) {
    if (!reverse.receipts?.length || count < 1 || count > this.journal.selection.length) throw new Error("The mail result did not include an accepted receipt. Progress was not credited.");
    this.reverse = reverse;
    this.journal.completedIds = [...new Set([...this.journal.completedIds, ...this.journal.selection.slice(0, count).map(item => item.id)])];
    this.journal.receipts = uniqueReceipts([...this.journal.receipts, ...reverse.receipts]);
    this.checkpoint();
  }
  private async submitMail(work: (sink: InboxRecoverySink) => Promise<InboxUndo>) {
    try {
      const reverse = await work(this.captureCommand);
      this.journal.mailPending = false; this.retryMail = undefined; this.journal.problem = "";
      this.acknowledge(this.journal.selection.length, reverse);
    } catch (cause) {
      if (!(cause instanceof InboxClassificationError)) {
        const command = this.journal.command;
        this.journal.mailPending = !(command && command.kind !== "category" && ["rejected", "retracted"].includes(command.status));
        this.journal.problem = cause instanceof Error ? cause.message : "The original mail request is unconfirmed.";
        this.checkpoint(); throw cause;
      }
      this.retryMail = cause.retry;
      this.journal.mailPending = !!cause.retry;
      this.journal.problem = cause.message;
      if (cause.completed && cause.undoCompleted) this.acknowledge(cause.completed, cause.undoCompleted as InboxUndo);
      this.checkpoint();
    }
  }
  private async flushProgress() {
    for (const attempt of this.journal.attempts) {
      if (attempt.undoResult?.status === "accepted") continue;
      if (attempt.result && attempt.input.decisions.every(item => acceptedIds(attempt).includes(item.id))) continue;
      const result = await this.io.transport.zeroProgress(attempt.input);
      attempt.result = result; this.receive(result.session); this.checkpoint();
    }
    const assigned = new Set(this.journal.attempts.flatMap(attempt => attempt.input.decisions.map(item => item.id)));
    const decisions = this.journal.selection.filter(item => this.journal.completedIds.includes(item.id) && !this.journal.undoneIds.includes(item.id) && !assigned.has(item.id));
    if (!decisions.length || this.journal.undoRequested) return;
    await this.resume();
    const attempt: ProgressAttempt = { input: { sessionId: this.journal.session.id, id: crypto.randomUUID(), ifRevision: this.journal.session.revision,
      decisions: decisions.map(item => ({ ...item, receipts: this.journal.receipts })) } };
    this.journal.attempts.push(attempt); this.checkpoint();
    attempt.result = await this.io.transport.zeroProgress(attempt.input);
    this.receive(attempt.result.session); this.checkpoint();
  }
  private async serial(work: () => Promise<void>) {
    if (this.busy) return;
    this.busy = true;
    try { await work(); } finally { this.busy = false; }
  }
  async begin(work: (sink: InboxRecoverySink) => Promise<InboxUndo>) {
    return this.serial(async () => {
      try { this.checkpoint(); } catch (cause) { this.journal.mailPending = false; throw cause; }
      await this.submitMail(work); await this.flushProgress();
    });
  }
  async retry() {
    return this.serial(async () => {
      if (this.journal.undoRequested) { await this.finishUndo(); return; }
      await this.flushProgress();
      if (this.journal.mailPending) {
        await this.resume();
        const replay = this.retryMail ?? (this.journal.command && this.io.replayMail ? () => this.io.replayMail!(this.journal.command!, this.captureCommand) : undefined);
        if (!replay) throw new Error("This older recovery has no frozen command payload. Its replay is unavailable after reload; accepted progress and Undo are preserved. Do not repeat the mail action.");
        // Original closure while live; exact stored command after reload. Neither
        // path reclassifies, changes identity or borrows the latest reply.
        await this.submitMail(replay); await this.flushProgress();
      }
    });
  }
  private async finishUndo() {
    if (!this.journal.inverseReceipts.length) {
      this.journal.inverseReceipts = await this.io.undoMail(this.journal.receipts, this.reverse, this.journal.command, this.captureCommand);
      // An inverse changes group status. A pre-Undo live classifier closure has
      // an older group ledger, so subsequent retries use the exact saved plan.
      if (this.journal.command && this.io.replayMail) this.retryMail = undefined;
      if (!this.journal.inverseReceipts.length) throw new Error("The existing mail Undo did not return accepted inverse receipts. Cleanup progress was not restored.");
      this.checkpoint();
    }
    // Resolve lost progress acknowledgements after mail Undo as well: they may
    // already have been credited, and only their original IDs can prove that.
    await this.flushProgress();
    for (const attempt of this.journal.attempts) {
      if (!attempt.result?.undo || !acceptedIds(attempt).length || attempt.undoResult?.status === "accepted") continue;
      if (!attempt.undoInput) {
        attempt.undoInput = { id: crypto.randomUUID(), reference: attempt.result.undo, receipts: this.journal.inverseReceipts };
        this.checkpoint();
      }
      attempt.undoResult = await this.io.transport.zeroUndo(attempt.undoInput);
      this.receive(attempt.undoResult.session); this.checkpoint();
      if (attempt.undoResult.status !== "accepted") throw new Error("Mail Undo is accepted; cleanup progress is still being checked. Retry the existing request.");
    }
    if (this.journal.attempts.some(attempt => attempt.result?.results.some(result => result.status === "pending"))) throw new Error("Mail Undo is accepted, but an earlier progress acknowledgement is still pending. Its original request has been kept.");
    this.journal.undoneIds = [...this.journal.completedIds];
    this.journal.undoRequested = false; this.journal.inverseReceipts = []; this.checkpoint();
  }
  async undo() {
    return this.serial(async () => {
      this.journal.undoRequested = true; this.checkpoint(); await this.finishUndo();
    });
  }
}

/** An unchecked batch member is reserved only by the exact acknowledged host request. */
export async function confirmZeroReservation(input: InboxZeroProgressInput, save: (input: InboxZeroProgressInput | null) => boolean, send: InboxWindowTransport["zeroProgress"]) {
  if (input.decisions.length || !input.reviewOnlyIds?.length || input.reviewOnlyIds.length > 100) throw new Error("Invalid captured batch reservation.");
  if (!save(input)) throw new Error("The frozen batch exclusion could not be saved. No new request was sent.");
  const result = await send(input);
  if (result.session.id !== input.sessionId) throw new Error("The batch reservation belongs to a different session.");
  if (!save(null)) throw new Error("The accepted batch reservation could not be saved locally. Retry its existing request.");
  return result;
}

/** One demand-driven page of V1 captured IDs. Neither an unknown nor a missing
 * projection changes the original saved queue or its decision count. */
export async function legacyZeroPage(ids: readonly string[], start: number, step: -1 | 1, lookup: (ids: string[]) => Promise<Mail[]>) {
  const indices: number[] = [];
  for (let index = start; index >= 0 && index < ids.length && indices.length < 100; index += step) indices.push(index);
  const requested = indices.map(index => ids[index]);
  let rows: Mail[] = [], error: unknown;
  try { rows = await lookup(requested); } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    error = cause;
  }
  const byId = new Map(rows.map(mail => [mail.id, mail]));
  return { requested, rows: requested.flatMap(id => byId.has(id) ? [byId.get(id)!] : []), next: indices.length ? indices.at(-1)! + step : start, error,
    exhausted: !indices.length || indices.at(-1)! + step < 0 || indices.at(-1)! + step >= ids.length };
}

function useGuidedZeroLegacy(options: Options) {
  const { inbox, store, account, mailboxIds, accountMail, currentMail, visible } = options;
  const scope = useMemo(() => zeroScope(account, mailboxIds, inbox.accounts), [account, mailboxIds, inbox.accounts]);
  const scopeKey = zeroStorageKey(scope);
  const [session, setSession] = useState<ZeroSession | null>(null);
  const savedKey = useRef("");
  const live = useRef(options);
  live.current = options;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const [offers, setOffers] = useState<Offer[]>([]);
  const [checked, setChecked] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [storageError, setStorageError] = useState(false);
  const [retry, setRetry] = useState<(() => Promise<void>) | null>(null);
  const recovery = useRef(new Map<string, { captured: ZeroSession; ids: string[]; work: () => Promise<() => Promise<void>>; message: string }>());
  const [undo, setUndo] = useState<Undo | null>(null);
  const outcomes = useRef(new Map<string, { session: ZeroSession; undo: Undo; error?: string }>());
  const [handling, setHandling] = useState(false);
  const later = useRef<Offer | null>(null);
  const legacyPosition = useRef(0);
  const legacyLookup = useRef(0);
  const legacyPending = useRef(false);
  const active = visible && !!session && !session.paused && sameZeroScope(session.scope, scope);
  const scoped = !!session && sameZeroScope(session.scope, scope);
  const index = useMemo(() => visible ? new Map(accountMail.map(mail => [mail.id, mail])) : null, [visible, accountMail]);
  const latestIndex = useRef(index);
  latestIndex.current = index;

  function save(next: ZeroSession) {
    sessionRef.current = next;
    setSession(next);
    // Reload is a deliberate resume, never an automatic navigation or action.
    if (!writeSaved(zeroStorageKey(next.scope), { ...next, paused: true })) setStorageError(true);
  }
  useEffect(() => {
    if (!inbox.loaded || savedKey.current === scopeKey) return;
    savedKey.current = scopeKey;
    const restored = normalizeZeroSession(readSaved<unknown>(scopeKey, null), scope);
    sessionRef.current = restored;
    setSession(restored);
    legacyLookup.current++; legacyPending.current = false;
    const position = readSaved<{ id: string; next: number } | null>(`${scopeKey}:page`, null);
    legacyPosition.current = restored && position?.id === restored.id && Number.isSafeInteger(position.next) && position.next >= 0 && position.next < restored.remainingIds.length ? position.next : 0;
    setOffers([]); setChecked([]);
    const settled = restored && outcomes.current.get(restored.id);
    setUndo(settled?.undo ?? null);
    const pending = restored && recovery.current.get(restored.id);
    setRetry(pending ? () => () => perform(pending.captured, pending.ids, pending.work) : null);
    setError(pending?.message ?? settled?.error ?? "");
  }, [inbox.loaded, scopeKey]);
  useEffect(() => {
    const current = sessionRef.current;
    if (!visible && current && !current.paused) save({ ...current, paused: true });
  }, [visible]);

  function currentScopeMatches(captured: ZeroSession) {
    const now = live.current;
    return sessionRef.current?.id === captured.id && sameZeroScope(captured.scope,
      zeroScope(now.account, now.mailboxIds, now.inbox.accounts));
  }
  function legacyEligible(mail: Mail, captured: ZeroSession) {
    if (!mail.window) return zeroEligible(mail, captured.scope);
    return mail.account === captured.scope.account && mail.locations?.includes("Inbox") && mail.split === "Important" && !mail.operationId && !mail.muted;
  }
  function nextMail(next: ZeroSession, from?: number, direction: -1 | 1 = 1) {
    const now = live.current;
    if (now.inbox.host?.inboxWindow) {
      const request = ++legacyLookup.current; legacyPending.current = true;
      save({ ...next, paused: sessionRef.current?.paused ?? next.paused });
      const start = from ?? (next.currentId ? next.remainingIds.indexOf(next.currentId) : legacyPosition.current);
      const offset = Math.max(0, Math.min(next.remainingIds.length - 1, start));
      const following = offset + direction * Math.min(100, direction > 0 ? next.remainingIds.length - offset : offset + 1);
      legacyPosition.current = following >= 0 && following < next.remainingIds.length ? following : direction > 0 ? 0 : Math.max(0, next.remainingIds.length - 1);
      if (!writeSaved(`${zeroStorageKey(next.scope)}:page`, { id: next.id, next: legacyPosition.current })) setStorageError(true);
      setError("");
      void legacyZeroPage(next.remainingIds, offset, direction, ids => {
        now.store.pinWindow("zero-legacy", ids);
        return now.store.lookupWindow(ids, next.scope.account);
      }).then(page => {
        if (request !== legacyLookup.current || !currentScopeMatches(next)) return;
        if (page.error) { setError(`${page.error instanceof Error ? page.error.message : "The captured page is unavailable."} The queue is preserved; check the next page.`); return; }
        const eligible = page.rows.find(mail => legacyEligible(mail, next));
        // The persisted V1 identities survive every unavailable/unknown page.
        const latest = sessionRef.current!;
        save({ ...latest, phase: next.phase, currentId: eligible && latest.remainingIds.includes(eligible.id) ? eligible.id : latest.currentId });
        if (eligible && live.current.visible && !sessionRef.current?.paused) live.current.onOpen(eligible);
        else if (!eligible) setError(page.exhausted ? "The end of the captured IDs is not inbox zero. Recheck the saved queue or review an earlier page." : "No captured conversation is ready in this page. Check the next captured page.");
      }).catch(cause => {
        if (request === legacyLookup.current && currentScopeMatches(next)) setError(`${cause instanceof Error ? cause.message : "Could not load this captured page."} The queue is preserved; you can check the next page.`);
      }).finally(() => { if (request === legacyLookup.current) legacyPending.current = false; });
      return;
    }
    const snapshot = now.store.getSnapshot();
    if (!snapshot.loaded) { save(next); return; }
    const rows = snapshot.mail === now.inbox.mail && now.account === next.scope.account && latestIndex.current
      ? latestIndex.current : new Map(snapshot.mail.filter(mail => mail.account === next.scope.account).map(mail => [mail.id, mail]));
    const eligible = (id: string) => { const mail = rows.get(id); return !!mail && zeroEligible(mail, next.scope, Date.now()); };
    const skipped = new Set<string>();
    let currentId = next.currentId && next.remainingIds.includes(next.currentId) && eligible(next.currentId) ? next.currentId : null;
    if (!currentId) for (const id of next.remainingIds) {
      if (eligible(id)) { currentId = id; break; }
      skipped.add(id);
    }
    const remainingIds = skipped.size ? next.remainingIds.filter(id => !skipped.has(id)) : next.remainingIds;
    const updated = { ...next, remainingIds, currentId };
    save(updated);
    if (live.current.visible && !updated.paused && currentScopeMatches(updated)) live.current.onOpen(currentId ? rows.get(currentId) : undefined);
  }
  function offerBatch(next: ZeroSession) {
    const now = live.current;
    const ids = new Set(next.remainingIds);
    const reviewOnly = new Set(next.reviewOnlyIds ?? []);
    const found: Offer[] = [];
    for (const mail of now.accountMail) {
      if (!ids.has(mail.id) || reviewOnly.has(mail.id)) continue;
      const candidate = zeroBatchCandidate(mail, next.scope, now.inbox.ai, Date.now());
      if (candidate) found.push({ mail, version: candidate.reviewVersion });
      if (found.length === 50) break;
    }
    setOffers(found); setChecked(found.map(item => item.mail.id));
  }
  function start(fresh = false) {
    if (!inbox.loaded || busyRef.current || !scope.mailboxes.length || fresh && retry) return;
    setHandling(false);
    const saved = !fresh && scoped ? session : null;
    if (recovery.current.size >= 16 && (!saved || !recovery.current.has(saved.id))) {
      setError("Resolve an earlier unconfirmed decision before starting another session."); return;
    }
    if (!saved || !recovery.current.has(saved.id)) { setError(""); setRetry(null); }
    const pending = saved && recovery.current.get(saved.id);
    const queue = saved?.remainingIds.length || pending ? null : selectZeroQueue(accountMail, scope, Date.now());
    const next: ZeroSession = queue ? {
      version: 1, id: crypto.randomUUID(), scope, startedAt: Date.now(), phase: "batches", paused: false,
      remainingIds: queue.ids, currentId: null, initialCount: queue.ids.length, decidedCount: 0, overflowCount: queue.overflowCount,
    } : { ...saved!, paused: false };
    save(next);
    if (inbox.host?.inboxWindow) { options.onOpen(); nextMail({ ...next, phase: "review" }); return; }
    if (next.phase === "batches") { offerBatch(next); options.onOpen(); }
    else {
      // Opening the entry point may precede React's route update.
      const rows = new Map(accountMail.map(mail => [mail.id, mail]));
      const remainingIds = pending ? next.remainingIds : next.remainingIds.filter(id => rows.has(id) && zeroEligible(rows.get(id)!, next.scope, Date.now()));
      const currentId = next.currentId && remainingIds.includes(next.currentId) ? next.currentId : remainingIds[0] ?? null;
      save({ ...next, remainingIds, currentId });
      options.onOpen(currentId ? rows.get(currentId) : undefined);
    }
  }
  function pause() {
    if (busyRef.current) return;
    legacyLookup.current++;
    const current = sessionRef.current;
    if (current) save({ ...current, paused: true });
    setConfirming(false); options.onPause();
  }
  function review() {
    const current = sessionRef.current;
    if (!current || busyRef.current || recovery.current.has(current.id)) return;
    setOffers([]); setChecked([]); setHandling(false);
    nextMail({ ...current, phase: "review", paused: false });
  }
  function accepted(captured: ZeroSession, ids: string[], reverse: () => Promise<void>) {
    const matching = currentScopeMatches(captured);
    const retained = matching ? null : normalizeZeroSession(readSaved<unknown>(zeroStorageKey(captured.scope), null), captured.scope);
    const current = matching ? sessionRef.current! : retained?.id === captured.id ? retained : outcomes.current.get(captured.id)?.session ?? captured;
    const removed = new Set(ids);
    const counted = current.remainingIds.filter(id => removed.has(id));
    const next = { ...current, remainingIds: current.remainingIds.filter(id => !removed.has(id)), currentId: null,
      paused: matching ? current.paused : true, decidedCount: current.decidedCount + counted.length };
    const reversed = { sessionId: current.id, ids: ids.filter(id => captured.remainingIds.includes(id)), reverse };
    outcomes.current.delete(captured.id);
    outcomes.current.set(captured.id, { session: next, undo: reversed });
    while (outcomes.current.size > 16) outcomes.current.delete(outcomes.current.keys().next().value!);
    if (!matching) {
      if (!retained || retained.id === captured.id) writeSaved(zeroStorageKey(captured.scope), { ...next, paused: true });
      return;
    }
    setUndo(reversed);
    setHandling(false); setError(""); setRetry(null); setConfirming(false);
    if (recovery.current.has(captured.id)) save(next);
    else if (next.phase === "batches") {
      save(next); offerBatch(next);
    } else nextMail(next);
  }
  async function perform(captured: ZeroSession, ids: string[], work: () => Promise<() => Promise<void>>, action = "other") {
    if (busyRef.current || !currentScopeMatches(captured)) return;
    const timing = measureAction(action, ids.length);
    legacyLookup.current++;
    busyRef.current = true; setBusy(true); setError(""); setRetry(null);
    try {
      const reverse = await work();
      timing.accepted();
      recovery.current.delete(captured.id);
      accepted(captured, ids, reverse);
      timing.finish();
    }
    catch (cause) {
      timing.finish("error");
      if (cause instanceof InboxClassificationError && cause.retry) {
        recovery.current.set(captured.id, { captured, ids, work: cause.retry, message: cause.message });
      } else recovery.current.delete(captured.id);
      if (cause instanceof InboxClassificationError) {
        // Submitted order is stable; acknowledged earlier groups are never replayed as new decisions.
        const completed = ids.slice(0, cause.completed);
        if (completed.length && cause.undoCompleted) {
          accepted(captured, completed, cause.undoCompleted);
          const settled = outcomes.current.get(captured.id);
          if (settled) settled.error = cause.message;
        }
      }
      if (!currentScopeMatches(captured)) return;
      setConfirming(false);
      if (cause instanceof InboxClassificationError) {
        if (cause.retry) {
          const recover = cause.retry;
          setRetry(() => () => perform(captured, ids, recover));
        }
        setError(cause.message);
      } else setError(cause instanceof Error ? cause.message : "The decision could not be confirmed. Check the conversation before trying again.");
    } finally { busyRef.current = false; setBusy(false); }
  }
  function decide(action: "done" | "not-important" | "other", capturedMail = currentMail) {
    const current = sessionRef.current;
    if (!active || !current || !capturedMail || current.currentId !== capturedMail.id || busyRef.current || recovery.current.has(current.id)) return;
    const latest = store.getSnapshot().mail.find(mail => mail.id === capturedMail.id && mail.account === account);
    if (!latest || !zeroEligible(latest, current.scope, Date.now()) || zeroReviewVersion(latest, current.scope) !== zeroReviewVersion(capturedMail, current.scope)) {
      setError("This conversation changed. Review it before making a decision."); return;
    }
    void perform(current, [capturedMail.id], () => action === "other" ? store.classify([latest], "Other") : store.action([latest], action), action);
  }
  function captureLater() {
    if (!active || !session || !currentMail || session.currentId !== currentMail.id || busyRef.current || recovery.current.has(session.id)) return false;
    later.current = { mail: currentMail, version: zeroReviewVersion(currentMail, session.scope) };
    return true;
  }
  async function remind(at: number) {
    const current = sessionRef.current, captured = later.current;
    if (!current || !captured || !active || !Number.isFinite(at) || at <= Date.now()) return;
    later.current = null;
    const latest = store.getSnapshot().mail.find(mail => mail.id === captured.mail.id && mail.account === account);
    if (!latest || zeroReviewVersion(latest, current.scope) !== captured.version) {
      setError("This conversation changed while choosing a reminder. Review it and choose Later again."); return;
    }
    await perform(current, [latest.id], () => store.action([latest], "remind", new Date(at).toISOString()), "remind");
  }
  function moveBatch() {
    const current = sessionRef.current;
    if (!current || !active || busyRef.current || recovery.current.has(current.id)) return;
    const selected = new Set(checked), now = store.getSnapshot();
    const rows = new Map(now.mail.filter(mail => mail.account === account).map(mail => [mail.id, mail]));
    const targets: Mail[] = [];
    for (const offer of offers) {
      if (!selected.has(offer.mail.id)) continue;
      const mail = rows.get(offer.mail.id);
      const proof = mail && zeroBatchCandidate(mail, current.scope, now.ai, Date.now());
      if (!mail || !proof || proof.reviewVersion !== offer.version) {
        setConfirming(false); setError("Some conversations changed. Review the refreshed group before confirming."); offerBatch(current); return;
      }
      targets.push(mail);
    }
    if (targets.length) void perform(current, targets.map(mail => mail.id), () => store.classify(targets, "Other"));
  }
  async function undoLast() {
    if (!undo || busyRef.current || undo.sessionId !== sessionRef.current?.id || recovery.current.has(undo.sessionId)) return;
    const captured = undo, before = sessionRef.current!;
    const timing = measureAction("undo");
    busyRef.current = true; setBusy(true); setError("");
    try {
      await captured.reverse();
      timing.accepted();
      outcomes.current.delete(captured.sessionId);
      const matching = currentScopeMatches(before);
      const retained = matching ? null : normalizeZeroSession(readSaved<unknown>(zeroStorageKey(before.scope), null), before.scope);
      const current = matching ? sessionRef.current! : retained?.id === before.id ? retained : before;
      const restored = captured.ids.filter(id => !current.remainingIds.includes(id));
      const next = { ...current, phase: "review" as const, remainingIds: [...restored, ...current.remainingIds],
        currentId: restored[0] ?? current.currentId, decidedCount: Math.max(0, current.decidedCount - restored.length) };
      if (!matching) {
        if (!retained || retained.id === before.id) writeSaved(zeroStorageKey(before.scope), { ...next, paused: true });
        timing.finish(); return;
      }
      setUndo(null); setOffers([]); setChecked([]); nextMail(next); timing.finish();
    } catch (cause) {
      timing.finish("error");
      const message = cause instanceof Error ? cause.message : "Undo could not be confirmed. Try Undo again.";
      const settled = outcomes.current.get(captured.sessionId);
      if (settled) settled.error = message;
      if (currentScopeMatches(before)) setError(message);
    }
    finally { busyRef.current = false; setBusy(false); }
  }
  // A late classification must never navigate away from the conversation being read.
  useEffect(() => {
    if (!active || !session || session.phase !== "review" || busy || retry || error || legacyPending.current || !inbox.loaded) return;
    if (!session.currentId) nextMail(session);
    else if (inbox.host?.inboxWindow && !currentMail) {
      const mail = store.getSnapshot().mail.find(mail => mail.id === session.currentId);
      if (mail) live.current.onOpen(mail);
    }
  }, [active, session?.currentId, busy, retry, inbox.loaded]);
  const currentOutside = active && session?.phase === "review" && !!session.currentId && inbox.loaded &&
    (inbox.host?.inboxWindow ? !!currentMail && !legacyEligible(currentMail, session) : !currentMail || !zeroEligible(currentMail, session.scope, Date.now()));
  const remainingNow = useMemo(() => active && !retry && session?.remainingIds.length === 0 && inbox.loaded
    ? inbox.host?.inboxWindow ? inbox.window?.totals.inbox ?? null : selectZeroQueue(accountMail, scope, Date.now()).total : null, [active, retry, session?.remainingIds.length, accountMail, scopeKey, inbox.loaded]);

  return { session, remainingCount: session?.remainingIds.length ?? null, decidedCount: session?.decidedCount ?? 0, initialCount: session?.initialCount ?? null, overflowCount: session?.overflowCount ?? 0,
    scoped, active, start, pause, review, decide, captureLater, remind, hasNextPage: !!session?.remainingIds.length,
    offers, checked, toggleChecked: (id: string, selected: boolean) => {
      const current = sessionRef.current;
      if (!current || busyRef.current || recovery.current.has(current.id)) return;
      setChecked(ids => selected ? [...ids, id] : ids.filter(value => value !== id));
      const reviewOnly = new Set(current.reviewOnlyIds ?? []);
      if (selected) reviewOnly.delete(id); else reviewOnly.add(id);
      save({ ...current, reviewOnlyIds: [...reviewOnly] });
    }, confirming, setConfirming, moveBatch, busy, error, retry,
    undo: undo?.sessionId === session?.id ? undoLast : null, undoBlocked: !!retry, storageError, remainingNow, handling, currentOutside,
    browse: (delta: number) => {
      const current = sessionRef.current;
      if (!active || !current || !current.currentId || busyRef.current || recovery.current.has(current.id)) return;
      const position = current.remainingIds.indexOf(current.currentId);
      const step = delta < 0 ? -1 : 1;
      if (live.current.inbox.host?.inboxWindow) {
        const next = position + step;
        if (next >= 0 && next < current.remainingIds.length) nextMail({ ...current, currentId: null }, next, step);
        return;
      }
      for (let i = position + step; i >= 0 && i < current.remainingIds.length; i += step) {
        const mail = latestIndex.current?.get(current.remainingIds[i]);
        if (mail && zeroEligible(mail, current.scope, Date.now())) {
          save({ ...current, currentId: mail.id }); options.onOpen(mail); return;
        }
      }
    },
    continueReview: () => {
      const current = sessionRef.current;
      if (!current || busyRef.current || recovery.current.has(current.id)) return;
      const from = error ? legacyPosition.current : current.currentId ? current.remainingIds.indexOf(current.currentId) + 1 : legacyPosition.current;
      nextMail({ ...current, currentId: null }, from < current.remainingIds.length ? from : 0);
    },
    handle: () => { setHandling(true); [...document.querySelectorAll<HTMLElement>(".thread-view .thread-message.is-expanded")].at(-1)?.focus(); },
  };
}

function useGuidedZeroWindow(options: Options) {
  const { inbox, store, account, currentMail, visible } = options;
  const key = `get-to-zero:v2:${account}`;
  const [session, setSession] = useState<InboxZeroSession | null>(null);
  const current = useRef(session); current.current = session;
  const live = useRef(options); live.current = options;
  const [items, setItems] = useState<InboxZeroItem[]>([]);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [checked, setChecked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false), busyRef = useRef(false);
  const [error, setError] = useState("");
  const [storageError, setStorageError] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [handling, setHandling] = useState(false);
  const [retry, setRetry] = useState<(() => Promise<void>) | null>(null);
  const [undo, setUndo] = useState<ZeroActionRecovery | null>(null);
  const recoveries = useRef(new Map<string, ZeroActionRecovery>());
  const reservation = useRef<InboxZeroProgressInput | null>(null);
  const owner = useMemo(() => getApplicationScope(), []);
  const categoryTransport = useMemo(() => createCategoryTransport(() => owner.signal, createScopedFetch(owner)), [owner]);
  const pageCursor = useRef<string | undefined>(undefined);
  const cursor = useRef<string | null>(null);
  const later = useRef<Offer | null>(null);
  const generation = useRef(0);
  const scoped = !!session && session.account === account && session.status !== "invalidated";
  const active = visible && scoped && !session!.paused;
  const save = (next: InboxZeroSession, preservePause = false, replace = false) => {
    const matching = current.current?.id === next.id && current.current.scopeKey === next.scopeKey && live.current.account === next.account;
    const saved = readSaved<InboxZeroSession | null>(`get-to-zero:v2:${next.account}`, null);
    if ((replace || !saved || saved.id === next.id || matching) && (saved?.id !== next.id || saved.revision <= next.revision)) {
      if (!writeSaved(`get-to-zero:v2:${next.account}`, { ...next, paused: true })) setStorageError(true);
    }
    if (next.account !== live.current.account || !replace && current.current && current.current.id !== next.id) return;
    if (current.current?.id === next.id && current.current.revision > next.revision) return;
    const value = preservePause && matching ? { ...next, paused: current.current!.paused } : next;
    current.current = value; setSession(value);
  };
  function matching(record: ZeroActionRecovery) {
    return current.current?.id === record.journal.session.id && current.current.scopeKey === record.journal.session.scopeKey && live.current.account === record.journal.session.account;
  }
  function attachRecovery(journal: ZeroRecoveryJournal) {
    const record = new ZeroActionRecovery(journal, {
      transport: store.windowTransport,
      save: value => writeSaved(recoveryStorageKey(value.session), value),
      session: next => save(next, true),
      replayMail: (command, sink) => store.replayCommand(command, sink),
      undoMail: async (references, reverse, command, sink) => {
        owner.signal.throwIfAborted();
        if (command) return store.undoCommand(command, sink);
        if (references.some(reference => reference.kind === "mailbox-membership")) {
          if (!reverse) throw new Error("This reminder Undo needs its original conditional inverse, which is unavailable after reload. Its receipts and progress are preserved; no replacement action was sent.");
          await reverse(); return reverse.inverseReceipts ?? [];
        }
        const inverses: InboxActionReceiptReference[] = [];
        for (const reference of uniqueReceipts(references)) {
          if (reference.kind === "category") {
            // Undo only acknowledged commands. Do not retire the original
            // classifier's still-unconfirmed groups by calling undoCompleted.
            const result = await categoryTransport.undo(reference.id);
            if (!result.retracted) throw new Error("Category Undo is still unconfirmed.");
          } else if (reference.kind === "mailbox-state") {
            const result = await store.client.undoMailboxStates(reference.id, { signal: owner.signal });
            if (!result.retracted) throw new Error("Done Undo is still unconfirmed.");
          } else if (reference.kind === "attention-feedback") await store.undoFeedback(reference.id);
          else throw new Error("This cleanup receipt does not support a verified inverse.");
          inverses.push(reference);
        }
        void store.retry();
        return inverses;
      },
    });
    recoveries.current.set(journal.session.id, record);
    return record;
  }
  function existingRecovery(next: InboxZeroSession) {
    const live = recoveries.current.get(next.id);
    if (live) return live;
    const saved = readSaved<unknown>(recoveryStorageKey(next), null);
    if (saved === null) return null;
    const journal = restoreZeroRecovery(saved, next);
    if (!journal) throw new Error("The saved cleanup recovery could not be read. It has not been discarded; no new decision was sent.");
    return attachRecovery(journal);
  }
  function showRecovery(record: ZeroActionRecovery | null) {
    if (record && !matching(record)) return;
    setUndo(record?.canUndo ? record : null);
    setRetry(record?.blocked ? () => () => runRecovery(record, "retry") : null);
    if (record?.blocked) setError(record.problem);
    else if (record?.journal.problem) setError(record.journal.problem);
  }
  async function runRecovery(record: ZeroActionRecovery, action: "retry" | "undo") {
    if (!matching(record)) return;
    const reader = live.current.currentMail?.id;
    await run(async () => {
      try { await record[action](); }
      finally { showRecovery(record); }
      if (!matching(record)) return;
      if (record.blocked) throw new Error(record.problem);
      if (live.current.visible && live.current.currentMail?.id === reader) {
        if (action === "undo") {
          const next = await persistProgress({ sessionId: current.current!.id, id: crypto.randomUUID(), ifRevision: current.current!.revision, decisions: [], phase: "review", currentId: record.journal.undoneIds[0] ?? null });
          await page(next.session);
        } else if (record.complete) await page(current.current!, pageCursor.current);
      }
    });
  }
  useEffect(() => {
    const epoch = ++generation.current;
    setSession(null); current.current = null; setOffers([]); setItems([]); setUndo(null); setRetry(null);
    reservation.current = null; pageCursor.current = undefined;
    if (!inbox.host?.inboxWindow) return;
    const saved = readSaved<InboxZeroSession | null>(key, null);
    if (!saved || saved.version !== 2 || typeof saved.id !== "string" || saved.account !== account) return;
    void store.windowTransport.zeroResume({ sessionId: saved.id, account }).then(result => {
      if (epoch !== generation.current) return;
      if (result.status === "found") {
        save({ ...result.session, paused: true });
        showRecovery(existingRecovery(result.session));
        const savedPage = readSaved<unknown>(`${recoveryStorageKey(result.session)}:page`, null);
        pageCursor.current = typeof savedPage === "string" && savedPage.length <= 4096 ? savedPage : undefined;
        const pending = readSaved<InboxZeroProgressInput | null>(`${recoveryStorageKey(result.session)}:reservation`, null);
        if (pending && pending.sessionId === result.session.id && Array.isArray(pending.reviewOnlyIds) && pending.reviewOnlyIds.length <= 100 && pending.decisions?.length === 0) {
          reservation.current = pending;
          setRetry(() => () => run(confirmReservation));
          setError("The saved batch exclusions still need acknowledgement. Retry their existing request before making a decision.");
        }
      } else { save({ ...saved, paused: true }); setError("The saved session is not available yet. Its reference has been preserved."); }
    }).catch(cause => { if (epoch === generation.current) { save({ ...saved, paused: true }); setError(cause instanceof Error ? cause.message : "Could not resume cleanup."); } });
  }, [account, inbox.host?.inboxWindow]);
  const persistProgress = async (input: InboxZeroProgressInput) => {
    const result = await store.windowTransport.zeroProgress(input);
    if (current.current?.id === input.sessionId) save(result.session, true);
    return result;
  };
  async function confirmReservation() {
    const input = reservation.current;
    if (!input || current.current?.id !== input.sessionId) return;
    const key = `${recoveryStorageKey(current.current)}:reservation`;
    const result = await confirmZeroReservation(input, value => writeSaved(key, value), persistProgress);
    reservation.current = null; setRetry(null);
    showRecovery(existingRecovery(result.session));
  }
  async function page(next: InboxZeroSession, continuation?: string) {
    const epoch = generation.current;
    const result = await store.windowTransport.zeroPage({ sessionId: next.id, cursor: continuation, limit: 100 });
    if (epoch !== generation.current || current.current?.id !== next.id) return;
    save(result.session, true); setItems(result.items); cursor.current = result.nextCursor; pageCursor.current = continuation;
    writeSaved(`${recoveryStorageKey(next)}:page`, continuation ?? null);
    const eligible = result.items.filter(item => item.eligibility === "eligible");
    if (result.session.phase === "batches") {
      const batch = boundedZeroBatch(eligible);
      store.pinWindow("zero", batch.map(item => item.id));
      const rows = batch.length ? await store.lookupWindow(batch.map(item => item.id), next.account) : [];
      if (epoch !== generation.current) return;
      const found = batch.flatMap(item => { const mail = rows.find(mail => mail.id === item.id); return mail ? [{ mail: captureActionMail(mail), version: item.batchCandidate!.reviewVersion, candidate: item }] : []; });
      store.pinWindow("zero", found.map(item => item.mail.id), found.map(item => item.mail));
      setOffers(found); setChecked(found.map(item => item.mail.id));
      if (!found.length && result.nextCursor) setError("No routine group in this page. Review individually or load the next captured page.");
      if (live.current.visible && current.current?.id === next.id && !current.current.paused) live.current.onOpen();
    } else {
      const held = result.items.find(item => item.id === result.session.currentId);
      if (held?.eligibility !== "eligible" && held && live.current.currentMail?.id === held.id) {
        setError(held.eligibility === "unknown" ? "This captured conversation changed or is still being checked. It remains current until you continue." : "This conversation is no longer eligible. Continue review when ready.");
        return;
      }
      const item = eligible.find(item => item.id === result.session.currentId) ?? eligible[0];
      if (!item) { setError("No ready conversation in this captured page. Nothing was removed or counted as handled."); return; }
      store.pinWindow("zero", [item.id]);
      const rows = await store.lookupWindow([item.id], next.account);
      if (epoch !== generation.current) return;
      if (!rows.length) { setError("The next captured conversation is not available yet."); return; }
      await persistProgress({ sessionId: next.id, id: crypto.randomUUID(), ifRevision: current.current!.revision, decisions: [], currentId: item.id });
      if (live.current.visible && current.current?.id === next.id && !current.current.paused) live.current.onOpen(rows[0]);
    }
  }
  async function run(work: () => Promise<void>) {
    if (busyRef.current) return;
    const epoch = generation.current;
    busyRef.current = true; setBusy(true); setError("");
    try { await work(); } catch (cause) {
      if (epoch === generation.current) setError(cause instanceof Error ? cause.message : "The cleanup request could not be confirmed.");
    }
    finally { busyRef.current = false; setBusy(false); }
  }
  function start(fresh = false) {
    if (!inbox.host?.inboxWindow || !inbox.loaded || busyRef.current) return;
    const openingEpoch = generation.current;
    void run(async () => {
      const recovery = current.current && existingRecovery(current.current);
      if ((fresh || !scoped) && (recovery?.blocked || reservation.current)) throw new Error("Resolve the existing cleanup request in its captured scope before starting a new session.");
      let next = !fresh && scoped ? current.current : null;
      if (next) {
        const result = await store.windowTransport.zeroResume({ sessionId: next.id, account });
        if (result.status !== "found" || result.session.status === "invalidated") throw new Error("The saved session is not available in this scope. Its recovery has been preserved.");
        next = result.session;
        const record = existingRecovery(next);
        if (record?.blocked || reservation.current) {
          save({ ...next, paused: false });
          if (openingEpoch !== generation.current || next.account !== live.current.account) return;
          live.current.onOpen(); showRecovery(record);
          if (reservation.current) { setRetry(() => () => run(confirmReservation)); return; }
          const credited = new Set(record!.journal.attempts.flatMap(acceptedIds));
          const id = record!.journal.selection.find(item => !credited.has(item.id) && !record!.journal.undoneIds.includes(item.id))?.id;
          if (id) {
            store.pinWindow("zero", [id]);
            const rows = await store.lookupWindow([id], next.account);
            if (current.current?.id === next.id && rows[0]) live.current.onOpen(rows[0]);
          }
          return;
        }
        const progress = await persistProgress({ sessionId: next.id, id: crypto.randomUUID(), ifRevision: next.revision, decisions: [], paused: false }); next = progress.session;
      } else {
        try { next = await store.windowTransport.zeroCreate({ id: crypto.randomUUID(), account }); }
        catch (cause) {
          if (cause && typeof cause === "object" && "status" in cause && cause.status === 503) throw new Error("Cleanup is not ready yet. No new session was started; retry when the inbox index is ready.");
          throw cause;
        }
        pageCursor.current = undefined;
      }
      save({ ...next, paused: false }, false, true);
      if (openingEpoch !== generation.current || next.account !== live.current.account) return;
      live.current.onOpen(); await page(next, pageCursor.current);
    });
  }
  function pause() {
    if (busyRef.current) return;
    const next = current.current;
    if (next) {
      save({ ...next, paused: true });
      // Do not move the server revision underneath an unacknowledged frozen
      // progress body. Pausing its UI does not cancel or recreate that request.
      if (!existingRecovery(next)?.blocked && !reservation.current) void run(async () => { await persistProgress({ sessionId: next.id, id: crypto.randomUUID(), ifRevision: next.revision, decisions: [], paused: true }); });
    }
    setConfirming(false); live.current.onPause();
  }
  function review() {
    const next = current.current; if (!next || retry) return;
    void run(async () => {
      const result = await persistProgress({ sessionId: next.id, id: crypto.randomUUID(), ifRevision: next.revision, decisions: [], phase: "review", currentId: null });
      setOffers([]); setChecked([]); await page(result.session);
    });
  }
  async function perform(captured: Offer[], decision: "done" | "other" | "later", work: (sink: InboxRecoverySink) => Promise<InboxUndo>, batch = false) {
    const before = current.current; if (!before || busyRef.current || retry) return;
    const reader = live.current.currentMail?.id;
    await run(async () => {
      if (reservation.current) { await confirmReservation(); if (reservation.current) throw new Error("Batch exclusions must be acknowledged before a decision."); }
      if (existingRecovery(before)?.blocked) throw new Error("Resolve the original cleanup request before making another decision.");
      if (recoveries.current.size >= 16 && !recoveries.current.has(before.id)) throw new Error("Resolve an earlier recovery before starting another cleanup action.");
      const scope = zeroScope(before.account, live.current.mailboxIds, live.current.inbox.accounts);
      const prepared = await store.prepareActionContext(captured.map(offer => offer.mail));
      if (prepared.some((mail, index) => zeroReviewVersion(mail, scope) !== zeroReviewVersion(captured[index].mail, scope))) throw new Error("This captured conversation changed. Review it again before making a decision.");
      assertZeroMembershipBudget(prepared);
      if (batch) {
        setConfirming(false);
        if (captured.some(offer => !offer.candidate)) throw new Error("This group has no current batch proof. Review it individually.");
        const fresh = await revalidateZeroBatch({ sessionId: before.id, cursor: pageCursor.current, limit: 100 }, captured.map(offer => offer.candidate!), store.windowTransport.zeroPage);
        if (current.current?.id !== before.id || current.current.scopeKey !== before.scopeKey || live.current.currentMail?.id !== reader || !live.current.visible || current.current.paused) return;
        save(fresh.session, true); setItems(fresh.items);
      }
      if (current.current?.id !== before.id || current.current.scopeKey !== before.scopeKey) return;
      const record = attachRecovery({ version: 1, session: current.current,
        selection: captured.map(offer => ({ id: offer.mail.id, decision, reviewVersion: offer.version })), completedIds: [], undoneIds: [],
        receipts: [], inverseReceipts: [], attempts: [], mailPending: true, undoRequested: false, problem: "" });
      try { await record.begin(work); }
      finally { showRecovery(record); }
      if (!matching(record)) return;
      setConfirming(false); setHandling(false);
      const credited = new Set(record.journal.attempts.flatMap(acceptedIds));
      setOffers(previous => previous.filter(offer => !credited.has(offer.mail.id)));
      setChecked(previous => previous.filter(id => !credited.has(id)));
      if (!record.complete) throw new Error(record.problem);
      if (live.current.visible && live.current.currentMail?.id === reader) await page(current.current!, pageCursor.current);
    });
  }
  function offer(mail?: Mail): Offer | null {
    if (!mail) return null;
    const item = items.find(item => item.id === mail.id);
    return item?.eligibility === "eligible" && item.reviewVersion ? { mail: captureActionMail(mail), version: item.reviewVersion } : null;
  }
  function decide(action: "done" | "not-important" | "other", mail = currentMail) {
    const captured = offer(mail); if (!active || !captured) return;
    void perform([captured], action === "other" ? "other" : "done", sink => action === "other" ? store.classify([captured.mail], "Other", sink) : store.action([captured.mail], action, undefined, sink));
  }
  function captureLater() { const captured = offer(currentMail); if (!active || !captured || busyRef.current || retry) return false; later.current = captured; return true; }
  async function remind(at: number) {
    const captured = later.current; later.current = null;
    if (!captured || !Number.isFinite(at) || at <= Date.now()) return;
    await perform([captured], "later", sink => store.action([captured.mail], "remind", new Date(at).toISOString(), sink));
  }
  function moveBatch() {
    const captured = offers.filter(offer => checked.includes(offer.mail.id));
    if (captured.length) void perform(captured, "other", sink => store.classify(captured.map(offer => offer.mail), "Other", sink), true);
  }
  function toggleChecked(id: string, selected: boolean) {
    const next = current.current; if (!next || busyRef.current || retry || reservation.current) return;
    if (selected) { setError("Unchecked conversations stay reserved for individual review. Choose Review individually to handle this one."); return; }
    setChecked(ids => ids.filter(value => value !== id));
    if (!selected) {
      const input: InboxZeroProgressInput = { sessionId: next.id, id: crypto.randomUUID(), ifRevision: next.revision, decisions: [], reviewOnlyIds: [id] };
      reservation.current = input;
      setRetry(() => () => run(confirmReservation));
      if (!writeSaved(`${recoveryStorageKey(next)}:reservation`, input)) { setStorageError(true); setError("The batch exclusion could not be saved. Keep this session open; no decision was sent."); return; }
      void run(async () => { await confirmReservation(); });
    }
  }
  async function undoLast() {
    if (!undo || !matching(undo) || busyRef.current || reservation.current) return;
    await runRecovery(undo, "undo");
  }
  useEffect(() => {
    if (!active || busy || retry || currentMail || offers.length || session?.status !== "capturing") return;
    const timer = setTimeout(() => { void run(() => page(session)); }, 500);
    return () => clearTimeout(timer);
  }, [active, busy, retry, currentMail?.id, offers.length, session]);
  useEffect(() => {
    if (!active || busy || currentMail || session?.phase !== "review" || !session.currentId) return;
    const mail = store.getSnapshot().mail.find(mail => mail.id === session.currentId);
    if (mail) live.current.onOpen(mail);
  }, [active, busy, currentMail?.id, session?.phase, session?.currentId]);
  const currentOutside = active && !!currentMail && items.find(item => item.id === currentMail.id)?.eligibility === "ineligible";
  return { session, scoped, active, start, pause, review, decide, captureLater, remind, offers, checked, confirming, setConfirming, busy, error, retry, storageError,
    remainingCount: session?.progress.remainingCount ?? null, decidedCount: session?.progress.decidedCount ?? 0, initialCount: session?.progress.initialCount ?? null, overflowCount: 0,
    remainingNow: !retry && !reservation.current && session?.status === "complete" && session.progress.captureComplete && session.progress.unknownCount === 0 ? inbox.window?.totals.inbox ?? null : null,
    hasNextPage: !!cursor.current,
    handling, currentOutside, toggleChecked, moveBatch, undo: undo ? undoLast : null, undoBlocked: !!reservation.current,
    browse: (delta: number) => {
      const next = current.current; if (!next || retry) return;
      const index = items.findIndex(item => item.id === next.currentId);
      const item = items[index + (delta < 0 ? -1 : 1)];
      void run(async () => {
        if (item?.eligibility === "eligible") {
          const result = await persistProgress({ sessionId: next.id, id: crypto.randomUUID(), ifRevision: next.revision, decisions: [], currentId: item.id }); await page(result.session, pageCursor.current);
        } else if (delta > 0 && cursor.current) await page(next, cursor.current);
      });
    },
    continueReview: () => {
      const next = current.current; if (!next || retry || reservation.current) return;
      void run(async () => {
        if (next.phase === "batches") { await page(next, cursor.current ?? undefined); return; }
        const index = items.findIndex(item => item.id === next.currentId);
        const following = items.slice(index + 1).find(item => item.eligibility === "eligible");
        const result = await persistProgress({ sessionId: next.id, id: crypto.randomUUID(), ifRevision: next.revision, decisions: [], currentId: following?.id ?? null });
        await page(result.session, following ? pageCursor.current : cursor.current ?? undefined);
      });
    },
    handle: () => { setHandling(true); [...document.querySelectorAll<HTMLElement>(".thread-view .thread-message.is-expanded")].at(-1)?.focus(); },
  };
}

export function useGuidedZero(options: Options) {
  const window = useGuidedZeroWindow(options);
  const legacy = useGuidedZeroLegacy({ ...options, visible: options.visible && !window.session });
  if (!options.inbox.host?.inboxWindow) return legacy;
  // Keep the original V1 storage and explicitly resume its captured IDs without inventory.
  if (!window.session && legacy.session?.remainingIds.length) return { ...legacy, start: (fresh = false) => fresh ? window.start(true) : legacy.start() };
  return window;
}

export type GuidedZeroState = ReturnType<typeof useGuidedZero>;
export function GuidedZero({ state, currentMail, onHandle, onLater }: {
  state: GuidedZeroState; currentMail?: Mail; onHandle: () => void; onLater: () => void;
}) {
  const { session, active, busy } = state;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (!currentMail) heading.current?.focus(); }, [currentMail?.id, active, session?.phase]);
  return <section className={`guided-zero ${currentMail && active ? "guided-zero-reader" : ""}`} aria-label="Get me to zero">
    <header className="zero-header">
      <div><h1 ref={heading} tabIndex={-1}>Get me to zero</h1>
        {active && session && <p role="status">{state.decidedCount.toLocaleString()} handled · {state.remainingCount === null ? "Checking remaining conversations…" : `${state.remainingCount.toLocaleString()} left in this session`}</p>}
      </div>
      <div className="zero-header-actions">
        {state.undo && <button type="button" className="text-button" disabled={busy || state.undoBlocked} onClick={() => void state.undo?.()}>Undo</button>}
        <button type="button" className="text-button" disabled={busy} onClick={state.pause}>{active ? "Pause" : "Back to inbox"}</button>
      </div>
    </header>
    {state.storageError && <p className="zero-error" role="alert">Progress could not be saved in this browser. Your mail decisions are still saved.</p>}
    {state.error && <div className="zero-error" role="alert"><p>{state.error}</p>
      {state.retry && <button type="button" className="text-button" disabled={busy} onClick={() => void state.retry?.()}>Retry existing request</button>}
    </div>}
    {!active ? <div className="zero-body"><p>Work through unhandled Important conversations, including already-read mail.</p>
      <button type="button" className="settings-button" disabled={busy} onClick={() => state.start()}>{state.scoped && (state.remainingCount !== 0 || state.retry) ? "Resume session" : "Start session"}</button>
    </div> : state.remainingNow !== null ? <div className="zero-body">
      <h2>This session is complete</h2>
      {state.remainingNow > 0 && <><p>{state.remainingNow.toLocaleString()} Important conversations remain, including any new or changed mail.</p>
        <button type="button" className="settings-button" disabled={busy} onClick={() => state.start(true)}>Review remaining conversations</button></>}
      <button type="button" className="text-button" onClick={state.pause}>Back to inbox</button>
    </div> : session?.phase === "batches" ? <div className="zero-body zero-batches">
      {state.overflowCount > 0 && <p>This session holds the first {state.initialCount?.toLocaleString()} conversations. {state.overflowCount.toLocaleString()} more will remain for another session.</p>}
      {state.offers.length ? <>
        <h2>Move routine mail to Other</h2><p>These saved assessments show no outstanding work. Uncheck anything you want to review individually.</p>
        <div className="zero-batch-list">
          {state.offers.map(({ mail }) => <label key={mail.id} className="zero-batch-row">
            <input type="checkbox" disabled={busy || !!state.retry} checked={state.checked.includes(mail.id)} onChange={event => state.toggleChecked(mail.id, event.target.checked)} />
            <span><strong>{mail.from}</strong><span>{mail.subject}</span></span>
          </label>)}
        </div>
        <div className="zero-actions"><button type="button" className="settings-button" disabled={busy || !state.checked.length || !!state.retry} onClick={() => state.setConfirming(true)}>Move {state.checked.length} to Other…</button>
          <button type="button" className="text-button" disabled={busy || !!state.retry} onClick={state.review}>Review individually</button></div>
      </> : <><p>No safely identified routine group is ready. Review the remaining conversations without running an AI scan.</p>
        {session.version === 2 && state.hasNextPage && <button type="button" className="text-button" disabled={busy || !!state.retry} onClick={state.continueReview}>Check the next captured group</button>}
        <button type="button" className="settings-button" disabled={busy || !!state.retry} onClick={state.review}>Review conversations</button></>}
    </div> : state.currentOutside && !state.retry ? <div className="zero-actions">
      <span>This conversation is no longer in active Important.</span>
      <button type="button" className="text-button" disabled={busy} onClick={state.continueReview}>Continue review</button>
    </div> : currentMail ? <>
      <div className="zero-actions">
        <button type="button" className="settings-button" disabled={busy || !!state.retry} onClick={onHandle}>Handle now</button>
        <button type="button" className="text-button" disabled={busy || !!state.retry} onClick={onLater}>Later</button>
        <button type="button" className="text-button" disabled={busy || !!state.retry} onClick={() => state.decide("done")}>Done</button>
        <button type="button" className="text-button" disabled={busy || !!state.retry} onClick={() => state.decide("other")}>Other</button>
      </div>
      {state.handling && <p className="zero-handling">Handle the request below, then choose Done. Opening or drafting does not finish it.</p>}
    </> : <div className="zero-body" role="status">{state.error ? "The captured queue is preserved." : "Loading the next conversation…"}
      {state.error && <button type="button" className="text-button" disabled={busy || !!state.retry} onClick={state.continueReview}>Check the next captured page</button>}
    </div>}
    {state.confirming && <Modal label={`Move ${state.checked.length} conversations to Other?`} className="zero-confirm" initialFocus="dialog" onClose={() => { if (!busy) state.setConfirming(false); }}>
      <h2>Move {state.checked.length} conversations to Other?</h2>
      <p>The selected conversations will stay in your inbox under Other. New replies are not included. You can Undo this decision.</p>
      <div className="zero-actions"><button type="button" className="settings-button" disabled={busy} onClick={state.moveBatch}>{busy ? "Moving…" : `Move ${state.checked.length} to Other`}</button>
        <button type="button" className="text-button" disabled={busy} onClick={() => state.setConfirming(false)}>Cancel</button></div>
    </Modal>}
  </section>;
}
