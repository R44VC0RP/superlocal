import { useEffect, useRef, useState } from "react";
import { Modal } from "./components";
import { zeroSweep, type ZeroSweepPreview, type ZeroSweepRun } from "./host";

const cutoffs: Array<[number, string]> = [[1, "1 day"], [3, "3 days"], [7, "1 week"], [14, "2 weeks"], [30, "1 month"], [90, "3 months"], [0, "everything"]];
const plural = (count: number, word: string) => `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;

/** Get me to zero: mark inbox conversations older than a cutoff as Done in one step, with undo. */
export function ImportantDone({ account, accountLabel, onClose, onDone }: {
  account: string; accountLabel: string; onClose: () => void;
  onDone: (run: ZeroSweepRun, undo: () => Promise<void>) => void;
}) {
  const [days, setDays] = useState(7);
  const [keepUnread, setKeepUnread] = useState(false);
  const [keepStarred, setKeepStarred] = useState(true);
  const [preview, setPreview] = useState<ZeroSweepPreview | null>(null);
  const [counting, setCounting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [recent, setRecent] = useState<ZeroSweepRun[]>([]);
  const owner = useRef(new AbortController());
  useEffect(() => { const controller = owner.current; return () => controller.abort(); }, []);
  useEffect(() => {
    void zeroSweep<ZeroSweepRun[]>("", undefined, owner.current.signal).then(runs => setRecent(runs.filter(run => !run.undone))).catch(() => {});
  }, []);
  // Recount whenever the choices change; the token from the latest count is what Apply consumes.
  useEffect(() => {
    const controller = new AbortController();
    setCounting(true); setError(""); setPreview(null);
    const timer = setTimeout(() => {
      zeroSweep<ZeroSweepPreview>("/preview", { account, olderThanDays: days, keepUnread, keepStarred }, controller.signal)
        .then(next => { if (!controller.signal.aborted) setPreview(next); })
        .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not count conversations."); })
        .finally(() => { if (!controller.signal.aborted) setCounting(false); });
    }, 150);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [account, days, keepUnread, keepStarred]);

  async function apply() {
    if (!preview || busy) return;
    setBusy(true); setError("");
    const id = `zero-${crypto.randomUUID()}`;
    try {
      const run = await zeroSweep<ZeroSweepRun>("/apply", { token: preview.token, id }, owner.current.signal);
      onDone(run, async () => { await zeroSweep<ZeroSweepRun>("/undo", { id: run.id }, new AbortController().signal); });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not mark conversations Done."); setPreview(null); }
    finally { setBusy(false); }
  }
  async function undo(run: ZeroSweepRun) {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const next = await zeroSweep<ZeroSweepRun>("/undo", { id: run.id }, owner.current.signal);
      setRecent(items => items.filter(item => item.id !== next.id));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not undo."); }
    finally { setBusy(false); }
  }
  const ago = (at: string) => { const hours = Math.round((Date.now() - Date.parse(at)) / 3_600_000); return hours < 1 ? "just now" : hours < 48 ? plural(hours, "hour") + " ago" : plural(Math.round(hours / 24), "day") + " ago"; };
  return <Modal label="Get me to zero" className="app-modal zero-modal" onClose={busy ? () => {} : onClose} initialFocus="dialog">
    <div className="simple-modal-header"><h2>Get me to zero</h2></div>
    <div className="simple-form zero-form">
      <p className="zero-lead">Mark inbox conversations in {accountLabel} older than
        <select aria-label="Older than" value={days} disabled={busy} onChange={event => setDays(Number(event.target.value))}>{cutoffs.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        as Done. Nothing is deleted; Done mail stays searchable and comes back if someone replies.</p>
      <div className="zero-options">
        <label className="zero-check"><input type="checkbox" checked={keepUnread} disabled={busy} onChange={event => setKeepUnread(event.target.checked)} />Keep unread conversations</label>
        <label className="zero-check"><input type="checkbox" checked={keepStarred} disabled={busy} onChange={event => setKeepStarred(event.target.checked)} />Keep starred conversations</label>
      </div>
      <p className="zero-count" role="status" aria-live="polite">
        {error ? <span className="settings-error">{error}</span>
          : counting || !preview ? "Counting…"
          : preview.conversations === 0 ? "Nothing matches. Your inbox is already at zero for this range."
          : <>{plural(preview.conversations, "conversation")} ({plural(preview.messages, "message")}) will be marked Done{preview.complete ? "" : " in this pass; run again for the rest"}.</>}
      </p>
      <div className="label-edit-actions">
        <button type="button" className="primary-button" disabled={busy || counting || !preview || preview.conversations === 0} onClick={() => void apply()}>{busy ? "Marking Done…" : "Mark Done"}</button>
        <button type="button" className="text-button" disabled={busy} onClick={onClose}>Cancel</button>
      </div>
      {recent.length > 0 && <div className="zero-recent">
        {recent.map(run => <p key={run.id}><span>{plural(run.conversations, "conversation")} marked Done {ago(run.at)}.</span><button type="button" className="text-button" disabled={busy} onClick={() => void undo(run)}>Undo</button></p>)}
      </div>}
    </div>
  </Modal>;
}
