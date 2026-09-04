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
  const pending = useRef(false);
  const lastInput = useRef<AiFeedbackInput | null>(null);
  const lifetime = useRef<object | null>(null);
  const scope = decision ? JSON.stringify([decision.sourceId, decision.threadId]) : "";
  useEffect(() => {
    const token = {};
    lifetime.current = token;
    setSaved(undefined); setNote(""); setError(""); setNotice(""); setBusy(false);
    pending.current = false; lastInput.current = null;
    return () => { if (lifetime.current === token) lifetime.current = null; };
  }, [scope]);
  const current = saved && decision && decision.state === "ready" && saved.sourceId === decision.sourceId && saved.threadId === decision.threadId && saved.latestMessageId === decision.latestMessageId && saved.inputHash === decision.inputHash && saved.revision > decision.revision ? saved : decision;
  const assessment = current?.assessment;
  const score = current?.score;
  const category = current?.override?.category ?? score?.category;
  const previous = current?.state === "stale" || current?.state === "failed" || current?.state === "pending" || current?.state === "processing";
  const status = current ? aiLabel(current.state) : "Not assessed";
  const summary = current?.state === "ready" && category ? `${mode === "preview" ? "Proposed " : ""}${category}` : status;

  async function feedback(category: AiCategory | null) {
    if (!current || !onFeedback || pending.current) return;
    const token = lifetime.current;
    const input = { sourceId: current.sourceId, threadId: current.threadId, revision: current.revision, category, ...(note.trim() ? { note: note.trim() } : {}) };
    const previousInput = lastInput.current;
    const same = previousInput && previousInput.sourceId === input.sourceId && previousInput.threadId === input.threadId && previousInput.revision === input.revision && previousInput.category === input.category && previousInput.note === input.note;
    const request = { ...input, id: same ? previousInput.id : crypto.randomUUID() };
    lastInput.current = request;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const next = await onFeedback(request);
      if (lifetime.current !== token) return;
      if (next.sourceId !== request.sourceId || next.threadId !== request.threadId) {
        setError("Could not confirm this conversation’s category. Reopen the assessment and try again.");
        return;
      }
      setSaved(next); setNote(""); lastInput.current = null;
      setNotice(category ? `${category} preference saved.` : "Automatic category restored.");
    } catch {
      if (lifetime.current === token) setError("Could not save feedback. Try again; if the assessment changed, reopen it first.");
    } finally {
      if (lifetime.current === token) { pending.current = false; setBusy(false); }
    }
  }

  return <>
    <button type="button" className="conversation-triage-trigger" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} title="AI triage assessment">
      <span>AI: {summary}</span><Icon name="ChevronDown" size={12} />
    </button>
    {open && <Modal label="Conversation triage" className="settings-dialog conversation-triage-dialog" initialFocus="dialog" onClose={() => setOpen(false)}>
      <header className="settings-dialog-header"><h2>Conversation triage</h2><IconButton name="Close" title="Close conversation triage" onClick={() => setOpen(false)} /></header>
      <div className="settings-dialog-body">
        <dl className="ai-key-values">
          <dt>Status</dt><dd>{status}</dd>
          <dt>{mode === "preview" ? "Proposed category" : "Category"}</dt><dd>{category ? `${previous ? "Previous: " : ""}${category}${current?.override ? " (manual)" : ""}` : "Not available"}</dd>
          {current?.model && <><dt>Model</dt><dd>{current.model}</dd></>}
        </dl>
        {mode === "preview" && <p className="settings-note">Preview only. This proposed category has not been applied to Important / Other.</p>}
        {!current && <p className="settings-note">No assessment is available for this conversation.</p>}
        {current?.state === "pending" && <p className="settings-note">Queued for assessment. Mail remains available.</p>}
        {current?.state === "processing" && <p className="settings-note">Assessment is in progress.</p>}
        {current?.state === "stale" && <p className="settings-note">This assessment is out of date. A previous assessment below may not reflect the current conversation.</p>}
        {current?.state === "failed" && <p className="settings-note">The latest assessment failed. Any previous assessment below is not current.</p>}
        {assessment && <section className="ai-section">
          <h3>{previous ? "Previous assessment" : "Assessment"}</h3>
          <p>{assessment.reason}</p>
          <dl className="ai-key-values">
            <dt>Type</dt><dd>{aiLabel(assessment.type)}</dd>
            <dt>Response</dt><dd>{aiLabel(assessment.response)}</dd>
            <dt>Actions</dt><dd>{assessment.actions.length ? assessment.actions.map(aiLabel).join(", ") : "None identified"}</dd>
            <dt>Timing</dt><dd>{aiLabel(assessment.urgency)}{assessment.deadline ? ` · ${assessment.deadline}` : ""}</dd>
            <dt>Topics</dt><dd>{assessment.topics.length ? assessment.topics.join(", ") : "None identified"}</dd>
            <dt>Risk</dt><dd>{aiLabel(assessment.risk)}</dd>
            <dt>Certainty</dt><dd>{aiLabel(assessment.certainty)}</dd>
          </dl>
        </section>}
        {score && <details className="ai-details"><summary>Score contributors · {Number(score.score.toFixed(2))}</summary>
          <dl className="ai-key-values">{score.contributions.map((part, index) => <div className="ai-key-pair" key={`${part.name}:${index}`}><dt>{aiLabel(part.name)}</dt><dd>{part.value > 0 ? "+" : ""}{Number(part.value.toFixed(2))}</dd></div>)}</dl>
          {score.reasons.length > 0 && <ul className="ai-score-reasons">{score.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}
        </details>}
        {onFeedback && current && <form className="ai-feedback" onSubmit={event => event.preventDefault()}>
          <label className="settings-field"><span>Local feedback note (optional)</span><textarea rows={2} maxLength={1000} value={note} disabled={busy} onChange={event => setNote(event.target.value)} /></label>
          <p className="settings-note">Your note stays on the server, not with the model. Category choices can inform local sender and topic preferences; they do not mark done, spam, or delete mail.</p>
          <div className="ai-actions"><button type="button" className="settings-text-button" disabled={busy || current.state !== "ready"} onClick={() => void feedback("Important")}>Important</button><button type="button" className="settings-text-button" disabled={busy || current.state !== "ready"} onClick={() => void feedback("Other")}>Other</button><button type="button" className="settings-text-button" disabled={busy || current.state !== "ready"} onClick={() => void feedback(null)}>Use automatic</button></div>
          {error && <p className="settings-error" role="alert">{error}</p>}{notice && <p className="settings-note" role="status">{notice}</p>}
        </form>}
      </div>
    </Modal>}
  </>;
}

export default ConversationTriage;
