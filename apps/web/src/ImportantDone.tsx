import { useEffect, useRef, useState } from "react";
import { Modal } from "./components";
import type { InboxStore } from "./inbox";
import { ImportantDoneRun } from "./important-done";

export function ImportantDone({ store, account, onClose, onDone }: {
  store: InboxStore; account: string; onClose: () => void;
  onDone: (count: number, changed: number, undo: () => Promise<void>, unfinished?: boolean) => void;
}) {
  const operation = useRef(new ImportantDoneRun(store, account)).current;
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
    setBusy(true); setError("");
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
  return <Modal label="Mark Important as Done" className="app-modal" onClose={close}>
    <div className="simple-modal-header"><h2>Get me to zero</h2></div>
    <div className="simple-form">
    <p>{ready ? `Mark all ${operation.selection!.count!.toLocaleString()} Important conversations as Done?` : "Preparing Important…"}</p>
    <p>Includes read and unread mail in the current mailbox view. Other and later arrivals stay untouched. You can Undo.</p>
    {operation.completed > 0 && <p role="status">{operation.completed.toLocaleString()} marked Done.</p>}
    {error && <p role="alert">{error}</p>}
    <div className="label-edit-actions">
      {ready ? <button type="button" className="primary-button" disabled={busy || operation.selection?.count === 0} onClick={() => void confirm()}>{busy ? "Marking Done…" : error ? "Retry existing request" : "Mark all as Done"}</button>
        : error && <button type="button" className="primary-button" onClick={() => setAttempt(value => value + 1)}>Try again</button>}
      <button type="button" className="text-button" disabled={busy} onClick={close}>Cancel</button>
    </div>
    </div>
  </Modal>;
}
