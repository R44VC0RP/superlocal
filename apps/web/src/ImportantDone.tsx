import { useEffect, useRef, useState } from "react";
import { Modal } from "./components";
import type { InboxStore } from "./inbox";
import { ImportantDoneRun } from "./important-done";

export function ImportantDone({ store, account, accountLabel, onClose, onDone }: {
  store: InboxStore; account: string; accountLabel: string; onClose: () => void;
  onDone: (count: number, changed: number, undo: () => Promise<void>, unfinished?: boolean) => void;
}) {
  const operation = useRef(new ImportantDoneRun(store, account)).current;
  const [reviewing, setReviewing] = useState(false);
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [attempt, setAttempt] = useState(0);
  const [, redraw] = useState(0);
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const started = Date.now();
    async function prepare() {
      try {
        const done = await operation.prepare();
        if (stopped) return;
        if (done) setReady(true);
        else if (Date.now() - started < 30_000) timer = setTimeout(prepare, 500);
        else setError("Important is still loading. Try again shortly.");
      } catch (cause) { if (!stopped) setError(cause instanceof Error ? cause.message : "Could not capture Important."); }
    }
    setError(""); void prepare();
    return () => { stopped = true; clearTimeout(timer); };
  }, [operation, attempt]);
  async function confirm() {
    setReviewing(false); setBusy(true); setError("");
    try {
      await operation.run(() => redraw(value => value + 1));
      onDone(operation.completed, operation.changed, () => operation.undo());
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not confirm Done. Retry the existing request."); }
    finally { setBusy(false); }
  }
  function close() {
    if (busy) return;
    if (operation.hasChanges) onDone(operation.completed, operation.changed, () => operation.undo(), true);
    else onClose();
  }
  return <>
    <section className="important-done-status" aria-label="Get me to zero progress">
      <strong>Get me to zero</strong>
      <p className="important-done-scope">{accountLabel}</p>
      <p role="status">{(busy || operation.completed > 0) ? `${operation.completed.toLocaleString()} marked Done${busy ? "…" : ""}` : ready ? `${operation.selection!.count!.toLocaleString()} Important conversations ready` : "Preparing Important…"}</p>
      {error && <p role="alert">{error}</p>}
      <div className="important-done-actions">
        {ready && !busy ? <button type="button" className="text-button" disabled={operation.selection?.count === 0} onClick={() => setReviewing(true)}>{error ? "Review and retry" : "Review"}</button>
          : error && !busy && <button type="button" className="text-button" onClick={() => setAttempt(value => value + 1)}>Try again</button>}
        <button type="button" className="text-button" disabled={busy} onClick={close}>Cancel</button>
      </div>
    </section>
    {reviewing && <Modal label="Mark Important as Done" className="app-modal" onClose={() => setReviewing(false)}>
      <div className="simple-modal-header"><h2>Get me to zero</h2></div>
      <div className="simple-form">
        <p>Mark all {operation.selection!.count!.toLocaleString()} Important conversations as Done?</p>
        <p>Includes read and unread mail in {accountLabel}. Other and later arrivals stay untouched. You can Undo.</p>
        <div className="label-edit-actions">
          <button type="button" className="primary-button" onClick={() => void confirm()}>{error ? "Retry existing request" : "Mark all as Done"}</button>
          <button type="button" className="text-button" onClick={() => setReviewing(false)}>Back</button>
        </div>
      </div>
    </Modal>}
  </>;
}
