import { useEffect, useRef, useState } from "react";
import type { AiCategory, AiDecision, AiFeedbackInput } from "../../shared/ai-triage";
import { Icon, IconButton, Modal } from "./components";
import "./ai-triage.css";

export function aiLabel(value: string): string {
  const labels: Record<string, string> = {
    needed: "Reply needed", optional: "Reply optional", not_needed: "No reply needed", waiting: "Waiting for a reply",
    none_observed: "No risk observed", unsolicited: "Suspected unsolicited mail", spam_suspected: "Suspected spam", phishing_suspected: "Suspected phishing",
    payment_requested: "Payment requested", insufficient: "Insufficient context", immediate: "Time-sensitive", deadline: "Has a deadline",
  };
  return labels[value] ?? value.replaceAll("_", " ").replace(/^./, character => character.toUpperCase());
}

export function aiTaskLabel(value?: "required" | "optional" | "none" | "unknown"): string {
  return value === "required" ? "Task required" : value === "optional" ? "Optional task" : value === "none" ? "No outstanding task" : value === "unknown" ? "Task unclear" : "Not recorded in this assessment";
}

export type ConversationTriageProps = {
  decision?: AiDecision;
  mode?: "preview" | "apply";
  onFeedback?: (input: AiFeedbackInput) => Promise<AiDecision>;
};

export function ConversationTriage({ decision, mode = "preview", onFeedback }: ConversationTriageProps) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [saved, setSaved] = useState<AiDecision>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const pending = useRef(false);
  const lastInput = useRef<AiFeedbackInput | null>(null);
  const lifetime = useRef<object | null>(null);
  const scope = decision ? JSON.stringify([decision.sourceId, decision.threadId]) : "";
  useEffect(() => {
    const token = {};
    lifetime.current = token;
    setSaved(undefined); setNote(""); setError(""); setNotice(""); setBusy(false); setUncertain(false);
    pending.current = false; lastInput.current = null;
    return () => { if (lifetime.current === token) lifetime.current = null; };
  }, [scope]);
  const current = saved && decision && decision.state === "ready" && saved.sourceId === decision.sourceId && saved.threadId === decision.threadId && saved.latestMessageId === decision.latestMessageId && saved.inputHash === decision.inputHash && saved.revision > decision.revision ? saved : decision;
  const assessment = current?.assessment;
  const score = current?.score;
  const category = current?.override?.category ?? score?.category;
  const previous = current?.state === "stale" || current?.state === "failed" || current?.state === "pending" || current?.state === "processing";
  const status = current ? aiLabel(current.state) : "Not assessed";
  const needsReview = current?.state === "ready" && !current.override && assessment && (assessment.certainty !== "clear" || assessment.task === "unknown" || assessment.response === "unknown" || assessment.type === "unknown");
  const summary = current?.state === "ready" && category ? `${mode === "preview" ? "Proposed " : ""}${category}${needsReview && category === "Important" ? " · Needs review" : ""}` : status;

  async function feedback(category: AiCategory | null, retry = false) {
    if (!current || !onFeedback || pending.current || uncertain && !retry || retry && !lastInput.current) return;
    const token = lifetime.current;
    const input = { sourceId: current.sourceId, threadId: current.threadId, revision: current.revision, category, ...(note.trim() ? { note: note.trim() } : {}) };
    const previousInput = lastInput.current;
    const same = previousInput && previousInput.sourceId === input.sourceId && previousInput.threadId === input.threadId && previousInput.revision === input.revision && previousInput.category === input.category && previousInput.note === input.note;
    const request = retry && previousInput ? previousInput : { ...input, id: same ? previousInput.id : crypto.randomUUID() };
    lastInput.current = request;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const next = await onFeedback(request);
      if (lifetime.current !== token) return;
      if (next.sourceId !== request.sourceId || next.threadId !== request.threadId) {
        setUncertain(true);
        setError("Could not confirm this category change. Retry repeats the same change, not a new choice.");
        return;
      }
      setSaved(next); setNote(""); setUncertain(false); lastInput.current = null;
      setNotice(request.category ? `${request.category} preference saved.` : "Automatic category restored.");
    } catch (cause) {
      if (lifetime.current === token) {
        if (cause !== null && typeof cause === "object" && "code" in cause && cause.code === "AI_DECISION_CONFLICT") {
          lastInput.current = null; setUncertain(false); setSaved(undefined);
          setError("The assessment changed before this choice was saved. Choose again using the current assessment.");
        } else {
          setUncertain(true);
          setError("Could not confirm this category change. Retry repeats the same change, not a new choice.");
        }
      }
    } finally {
      if (lifetime.current === token) { pending.current = false; setBusy(false); }
    }
  }

  return <>
    <button type="button" className="conversation-triage-trigger" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} title="Why this category?">
      <span>{summary} · Why?</span><Icon name="ChevronDown" size={12} />
    </button>
    {open && <Modal label="Conversation triage" className="settings-dialog conversation-triage-dialog" initialFocus="dialog" onClose={() => setOpen(false)}>
      <header className="settings-dialog-header"><h2>{!previous && category ? `Why ${category}?` : "About this category"}</h2><IconButton name="Close" title="Close conversation triage" onClick={() => setOpen(false)} /></header>
      <div className="settings-dialog-body">
        {mode === "preview" && <p className="settings-note">Preview only. This proposed category has not been applied to Important / Other.</p>}
        {!current && <p className="settings-note">No assessment is available for this conversation.</p>}
        {current?.state === "pending" && <p className="settings-note">Queued for assessment. Mail remains available.</p>}
        {current?.state === "processing" && <p className="settings-note">Assessment is in progress.</p>}
        {current?.state === "stale" && <p className="settings-note">This assessment is out of date. A previous assessment below may not reflect the current conversation.</p>}
        {current?.state === "failed" && <p className="settings-note">The latest assessment failed. Any previous assessment below is not current.</p>}
        {assessment && <>
          {current?.override ? <p>You chose {current.override.category} for this conversation.</p> : <p>{assessment.reason}</p>}
          {needsReview && category === "Important" && <p className="settings-note">The next step is unclear, so this stays in Important for review.</p>}
          {assessment.task === undefined && !previous && !current?.override && <p className="settings-note">This older assessment did not separately check for outstanding tasks.</p>}
        </>}
        {onFeedback && current && <form className="ai-feedback" onSubmit={event => event.preventDefault()}>
          <div className="ai-actions">
            {uncertain ? <button type="button" className="settings-text-button" disabled={busy} onClick={() => void feedback(null, true)}>Retry category change</button> : <>
              <button type="button" className="settings-text-button" disabled={busy || current.state !== "ready"} onClick={() => void feedback(category === "Important" ? "Other" : "Important")}>{category === "Important" ? "Move to Other" : "Move to Important"}</button>
              {current.override && <button type="button" className="settings-text-button" disabled={busy || current.state !== "ready"} onClick={() => void feedback(null)}>Use automatic</button>}
            </>}
          </div>
          <details className="ai-details"><summary tabIndex={0}>Add a reason (optional)</summary>
            <label className="settings-field"><span>Local feedback note</span><textarea rows={2} maxLength={1000} value={note} disabled={busy || uncertain} onChange={event => setNote(event.target.value)} /></label>
            <p className="settings-note">Included with your next category change. Kept on the server, not sent to the model.</p>
          </details>
          {error && <p className="settings-error" role="alert">{error}</p>}{notice && <p className="settings-note" role="status">{notice}</p>}
        </form>}
        {current && <details className="ai-details"><summary tabIndex={0}>Assessment details</summary><div className="ai-disclosure-body">
          <dl className="ai-key-values">
            <dt>Status</dt><dd>{status}</dd>
            <dt>Category</dt><dd>{category ? `${previous ? "Previous: " : ""}${category}${current.override ? " (manual)" : ""}` : "Not available"}</dd>
            <dt>Model</dt><dd>{current.model}</dd>
          </dl>
          {assessment && <dl className="ai-key-values">
            <dt>Type</dt><dd>{aiLabel(assessment.type)}</dd>
            <dt>Email reply</dt><dd>{aiLabel(assessment.response)}</dd>
            <dt>Task</dt><dd>{aiTaskLabel(assessment.task)}</dd>
            <dt>Actions</dt><dd>{assessment.actions.length ? assessment.actions.map(aiLabel).join(", ") : "None identified"}</dd>
            <dt>Timing</dt><dd>{aiLabel(assessment.urgency)}{assessment.deadline ? ` · ${assessment.deadline}` : ""}</dd>
            <dt>Topics</dt><dd>{assessment.topics.length ? assessment.topics.join(", ") : "None identified"}</dd>
            <dt>Risk</dt><dd>{aiLabel(assessment.risk)}</dd>
            <dt>Certainty</dt><dd>{aiLabel(assessment.certainty)}</dd>
          </dl>}
          {current.override && assessment && <p>{assessment.reason}</p>}
        {assessment && assessment.evidence.length > 0 && <details className="ai-details"><summary tabIndex={0}>Supporting excerpts · {assessment.evidence.length}</summary>
          <div className="ai-evidence">{assessment.evidence.map((item, index) => <div key={index}>
            <span className="ai-secondary">{aiLabel(item.field)} · {item.messageRef}</span>
            <p>{item.quote}</p>
          </div>)}</div>
        </details>}
        {current && <details className="ai-details"><summary tabIndex={0}>Decision record</summary>
          <dl className="ai-key-values">
            <dt>Assessment policy</dt><dd>{current.inputPolicyVersion ?? "Not recorded"}</dd>
            <dt>Schema / scoring policy</dt><dd>{current.schemaVersion} / {score?.version ?? "Not scored"}</dd>
            <dt>Settings revision</dt><dd>{current.settingsRevision}</dd>
            <dt>Decision revision</dt><dd>{current.revision}</dd>
            <dt>Last updated</dt><dd>{new Date(current.updatedAt).toLocaleString()}</dd>
            {current.problemCode && <><dt>Problem</dt><dd>{current.problemCode}</dd></>}
          </dl>
        </details>}
        {score && <details className="ai-details"><summary tabIndex={0}>Score contributors · {Number(score.score.toFixed(2))}</summary>
          <dl className="ai-key-values">{score.contributions.map((part, index) => <div className="ai-key-pair" key={`${part.name}:${index}`}><dt>{aiLabel(part.name)}</dt><dd>{part.value > 0 ? "+" : ""}{Number(part.value.toFixed(2))}</dd></div>)}</dl>
          {score.reasons.length > 0 && <ul className="ai-score-reasons">{score.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}
        </details>}
        </div></details>}
      </div>
    </Modal>}
  </>;
}

export default ConversationTriage;
