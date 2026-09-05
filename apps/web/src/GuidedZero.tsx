import { useEffect, useMemo, useRef, useState } from "react";
import type { Mail } from "./data";
import { InboxClassificationError, type InboxSnapshot, type InboxStore } from "./inbox";
import { Modal } from "./components";
import { readSaved, writeSaved } from "./storage";
import { measureAction } from "./browser-logs";
import {
  normalizeZeroSession, sameZeroScope, selectZeroQueue, zeroBatchCandidate,
  zeroEligible, zeroReviewVersion, zeroScope, zeroStorageKey,
  type ZeroSession,
} from "./mail-view";
import "./guided-zero.css";

type Offer = { mail: Mail; version: string };
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

export function useGuidedZero(options: Options) {
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
  function nextMail(next: ZeroSession) {
    const now = live.current;
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
    if (!active || !session || session.phase !== "review" || busy || retry || !inbox.loaded) return;
    if (!session.currentId) nextMail(session);
  }, [active, session?.currentId, busy, retry, inbox.loaded]);
  const currentOutside = active && session?.phase === "review" && !!session.currentId && inbox.loaded &&
    (!currentMail || !zeroEligible(currentMail, session.scope, Date.now()));
  const remainingNow = useMemo(() => active && !retry && session?.remainingIds.length === 0 && inbox.loaded
    ? selectZeroQueue(accountMail, scope, Date.now()).total : null, [active, retry, session?.remainingIds.length, accountMail, scopeKey, inbox.loaded]);

  return { session, scoped, active, start, pause, review, decide, captureLater, remind,
    offers, checked, toggleChecked: (id: string, selected: boolean) => {
      const current = sessionRef.current;
      if (!current || busyRef.current || recovery.current.has(current.id)) return;
      setChecked(ids => selected ? [...ids, id] : ids.filter(value => value !== id));
      const reviewOnly = new Set(current.reviewOnlyIds ?? []);
      if (selected) reviewOnly.delete(id); else reviewOnly.add(id);
      save({ ...current, reviewOnlyIds: [...reviewOnly] });
    }, confirming, setConfirming, moveBatch, busy, error, retry,
    undo: undo?.sessionId === session?.id ? undoLast : null, storageError, remainingNow, handling, currentOutside,
    browse: (delta: number) => {
      const current = sessionRef.current;
      if (!active || !current || !current.currentId || busyRef.current || recovery.current.has(current.id)) return;
      const position = current.remainingIds.indexOf(current.currentId);
      const step = delta < 0 ? -1 : 1;
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
      nextMail({ ...current, currentId: null });
    },
    handle: () => { setHandling(true); [...document.querySelectorAll<HTMLElement>(".thread-view .thread-message.is-expanded")].at(-1)?.focus(); },
  };
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
        {active && session && <p role="status">{session.decidedCount.toLocaleString()} handled · {session.remainingIds.length.toLocaleString()} left in this session</p>}
      </div>
      <div className="zero-header-actions">
        {state.undo && <button type="button" className="text-button" disabled={busy || !!state.retry} onClick={() => void state.undo?.()}>Undo</button>}
        <button type="button" className="text-button" disabled={busy} onClick={state.pause}>{active ? "Pause" : "Back to inbox"}</button>
      </div>
    </header>
    {state.storageError && <p className="zero-error" role="alert">Progress could not be saved in this browser. Your mail decisions are still saved.</p>}
    {state.error && <div className="zero-error" role="alert"><p>{state.error}</p>
      {state.retry && <button type="button" className="text-button" disabled={busy} onClick={() => void state.retry?.()}>Retry same decision</button>}
    </div>}
    {!active ? <div className="zero-body"><p>Work through unhandled Important conversations, including already-read mail.</p>
      <button type="button" className="settings-button" disabled={busy} onClick={() => state.start()}>{state.scoped && (session?.remainingIds.length || state.retry) ? "Resume session" : "Start session"}</button>
    </div> : state.remainingNow !== null ? <div className="zero-body">
      <h2>{state.remainingNow === 0 ? "Nothing needs your attention right now" : "This session is complete"}</h2>
      {state.remainingNow > 0 && <><p>{state.remainingNow.toLocaleString()} Important conversations remain, including any new or changed mail.</p>
        <button type="button" className="settings-button" disabled={busy} onClick={() => state.start(true)}>Review remaining conversations</button></>}
      <button type="button" className="text-button" onClick={state.pause}>Back to inbox</button>
    </div> : session?.phase === "batches" ? <div className="zero-body zero-batches">
      {session.overflowCount > 0 && <p>This session holds the first {session.initialCount.toLocaleString()} conversations. {session.overflowCount.toLocaleString()} more will remain for another session.</p>}
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
    </> : <div className="zero-body" role="status">Loading the next conversation…</div>}
    {state.confirming && <Modal label={`Move ${state.checked.length} conversations to Other?`} className="zero-confirm" initialFocus="dialog" onClose={() => { if (!busy) state.setConfirming(false); }}>
      <h2>Move {state.checked.length} conversations to Other?</h2>
      <p>The selected conversations will stay in your inbox under Other. New replies are not included. You can Undo this decision.</p>
      <div className="zero-actions"><button type="button" className="settings-button" disabled={busy} onClick={state.moveBatch}>{busy ? "Moving…" : `Move ${state.checked.length} to Other`}</button>
        <button type="button" className="text-button" disabled={busy} onClick={() => state.setConfirming(false)}>Cancel</button></div>
    </Modal>}
  </section>;
}
