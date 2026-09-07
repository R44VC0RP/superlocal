import type { AiTriageState } from "../../shared/ai-triage";

/** Sidebar line for AI sorting in progress: a backlog run with determinate progress, or new arrivals being assessed. Hidden when idle. */
export default function AiSortingStatus({ state, onOpen }: { state: AiTriageState | null | undefined; onOpen: () => void }) {
  if (!state?.configured || !state.settings.enabled) return null;
  const job = state.jobs.find(item => item.status === "running" || item.status === "paused");
  const working = state.queue.pending + state.queue.processing;
  if (!job && working === 0) return null;
  const done = job ? job.completed + job.failed : 0;
  const total = job ? Math.max(job.queued, done) : 0;
  const label = job
    ? job.status === "paused" ? "Sorting paused" : "Sorting older mail"
    : `Assessing ${working.toLocaleString()} conversation${working === 1 ? "" : "s"}`;
  const text = job ? `${done.toLocaleString()} of ${total ? total.toLocaleString() : "…"}` : "";
  return <section className="mail-sync-status ai-sorting-status" aria-label="AI sorting status" role="status" aria-live="polite">
    <button type="button" className="ai-sorting-row" onClick={onOpen} title="Open AI triage settings">
      <p><span className="mail-sync-name">{label}</span>{text && <span className="mail-sync-text">{text}</span>}</p>
      {job && total > 0
        ? <progress className="ai-sorting-progress" value={done} max={total} aria-label={`${label}: ${text}`} />
        : <div className={`mail-sync-progress${job?.status === "paused" ? "" : " is-active"}`} role="progressbar" aria-label={label}><span /></div>}
    </button>
  </section>;
}
