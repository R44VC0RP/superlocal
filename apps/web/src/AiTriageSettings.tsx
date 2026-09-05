import { useEffect, useRef, useState } from "react";
import type { AiDecision, AiSettings, AiTriageActions, AiTriageState, AiUsageSummary } from "../../shared/ai-triage";
import { aiLabel, aiTaskLabel } from "./ConversationTriage";
import "./ai-triage.css";

export type AiTriageSettingsProps = {
  actions?: AiTriageActions;
  mailboxes: Array<{ id: string; name: string; email?: string }>;
  onEditStateChange?: (state: { dirty: boolean; saving: boolean }) => void;
};

type Diagnostics = Awaited<ReturnType<AiTriageActions["diagnostics"]>>;
const problemLabels: Record<string, string> = {
  AI_EVIDENCE_INVALID: "Source quotation could not be verified",
  AI_EVIDENCE_REQUIRED: "Required supporting evidence was missing",
  AI_RESPONSE_REFUSED: "Provider declined the assessment",
  AI_RESPONSE_INCOMPLETE: "Provider returned an incomplete assessment",
  AI_RESPONSE_INVALID: "Provider response could not be validated",
  AI_TIMEOUT: "Provider response timed out",
  AI_RATE_LIMITED: "Provider rate limit reached",
  AI_AUTH_FAILED: "Provider credentials were rejected",
  AI_PROVIDER_UNAVAILABLE: "Provider is temporarily unavailable",
  AI_INSUFFICIENT_CONTEXT: "Not enough usable email context",
};
const activityLabels: Record<string, string> = {
  queued: "Queued", processing: "Assessing", ready: "Assessment saved", failed: "Assessment failed", stale: "Assessment outdated",
  removed: "Context removed", cache_reused: "Saved assessment reused", feedback: "Category feedback", rescored: "Preferences rescored",
  historical_no_prior: "Not admitted as new mail", inactive_membership: "No active selected membership", outgoing_no_prior: "No assessed incoming context",
  unavailable: "Message unavailable", recovery_historical: "Older mail left unchanged",
};
const number = (value: number) => value.toLocaleString();
const dollars = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 4, maximumFractionDigits: 6 }).format(value);

function Usage({ usage }: { usage: AiUsageSummary }) {
  const priced = usage.attempts > usage.unpriced;
  return <>
    <dl className="ai-key-values">
      <dt>Attempts / completed / failed</dt><dd>{number(usage.attempts)} / {number(usage.completed)} / {number(usage.failed)}</dd>
      <dt>Reused assessments</dt><dd>{number(usage.reused)}</dd>
      <dt>Unknown usage / unpriced</dt><dd>{number(usage.unknownUsage)} / {number(usage.unpriced)}</dd>
      <dt>Known input / output tokens</dt><dd>{number(usage.inputTokens)} / {number(usage.outputTokens)}</dd>
      <dt>Cached input / cache write</dt><dd>{number(usage.cachedInputTokens)} / {number(usage.cacheWriteInputTokens)}</dd>
      <dt>Reasoning tokens (within output)</dt><dd>{number(usage.reasoningOutputTokens)}</dd>
      <dt>Estimated cost (USD)</dt><dd>{priced || usage.estimatedMaximumUsd > 0 ? `${dollars(usage.estimatedMinimumUsd)} – ${dollars(usage.estimatedMaximumUsd)}` : "Not available"}</dd>
    </dl>
    <p className="settings-note">Estimate, not provider bill. {usage.unknownUsage || usage.unpriced ? "Totals are partial; unknown usage and unpriced attempts are excluded, not counted as free." : "Known token subtotals only; cached and reasoning tokens are not added twice."}</p>
  </>;
}

export function AiTriageSettings({ actions, mailboxes, onEditStateChange }: AiTriageSettingsProps) {
  const [state, setState] = useState<AiTriageState | null>(null);
  const [draft, setDraft] = useState<AiSettings | null>(null);
  const [interests, setInterests] = useState("");
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const stateRef = useRef<AiTriageState | null>(null);
  const lifetime = useRef<object | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const progressEpoch = useRef(0);
  const [reload, setReload] = useState(0);
  const [scope, setScope] = useState<"inbox" | "all">("inbox");
  const [limit, setLimit] = useState(100);
  const [results, setResults] = useState<AiDecision[] | null>(null);
  const [resultCursor, setResultCursor] = useState<number>();
  const [hasMore, setHasMore] = useState(false);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const editListener = useRef(onEditStateChange);
  editListener.current = onEditStateChange;

  useEffect(() => {
    onEditStateChange?.({ dirty, saving: busy });
  }, [dirty, busy, onEditStateChange]);
  useEffect(() => () => editListener.current?.({ dirty: false, saving: false }), []);

  function accept(next: AiTriageState, replaceDraft = false) {
    if (stateRef.current && next.settings.revision < stateRef.current.settings.revision) return;
    stateRef.current = next;
    setState(next);
    if (replaceDraft || !dirtyRef.current) {
      setDraft(next.settings);
      setInterests(next.settings.interests.join(", "));
      dirtyRef.current = false;
      setDirty(false);
    }
  }

  useEffect(() => {
    const token = {};
    lifetime.current = token;
    stateRef.current = null;
    dirtyRef.current = false;
    busyRef.current = false;
    setState(null); setDraft(null); setDirty(false); setBusy(false);
    setResults(null); setResultCursor(undefined); setHasMore(false); setDiagnostics(null);
    setLoadError(false); setError(""); setNotice("");
    if (actions) void actions.state().then(next => {
      if (lifetime.current === token) accept(next, true);
    }).catch(() => { if (lifetime.current === token) setLoadError(true); });
    return () => { if (lifetime.current === token) lifetime.current = null; };
  }, [actions, reload]);

  useEffect(() => {
    if (!actions) return;
    let ignore = false, pending = false;
    const timer = window.setInterval(() => {
      if (pending || busyRef.current || document.visibilityState !== "visible") return;
      pending = true;
      const epoch = progressEpoch.current;
      void actions.state().then(next => {
        if (!ignore && epoch === progressEpoch.current) { accept(next); setLoadError(false); }
      }).catch(() => { if (!ignore && epoch === progressEpoch.current) setLoadError(true); }).finally(() => { pending = false; });
    }, 5000);
    return () => { ignore = true; window.clearInterval(timer); };
  }, [actions, reload]);

  function change(patch: Partial<AiSettings>) {
    dirtyRef.current = true;
    setDirty(true); setNotice("");
    setDraft(previous => previous ? { ...previous, ...patch } : previous);
  }

  async function run(work: (api: AiTriageActions, alive: () => boolean) => Promise<void>, failure: string) {
    if (!actions || busyRef.current) return;
    const token = lifetime.current;
    const alive = () => token !== null && lifetime.current === token;
    progressEpoch.current++;
    busyRef.current = true; setBusy(true); setError(""); setNotice("");
    try { await work(actions, alive); }
    catch { if (alive()) setError(failure); }
    finally { if (alive()) { busyRef.current = false; setBusy(false); } }
  }

  function reset() {
    if (dirty && !window.confirm("Discard unsaved AI triage settings and load the saved settings?")) return;
    setReload(value => value + 1);
  }

  async function loadResults(more = false) {
    await run(async (api, alive) => {
      const page = await api.results(more ? resultCursor : undefined);
      if (!alive()) return;
      const entries = new Map((more && !page.resetRequired ? results ?? [] : []).map(item => [JSON.stringify([item.sourceId, item.threadId]), item]));
      for (const item of page.removed) entries.delete(JSON.stringify([item.sourceId, item.threadId]));
      for (const item of page.decisions) entries.set(JSON.stringify([item.sourceId, item.threadId]), item);
      setResults([...entries.values()].slice(0, 100));
      setResultCursor(page.cursor); setHasMore(page.hasMore);
    }, "Could not load results. Try again.");
  }

  if (!actions) return <p className="settings-note">AI triage is unavailable on this host. Your mail remains usable.</p>;
  if (!state || !draft) return <div className="ai-triage-settings">
    <p className="settings-note" role="status">{loadError ? "Could not load AI triage settings." : "Loading AI triage settings…"}</p>
    {loadError && <button type="button" className="settings-text-button" onClick={reset}>Retry</button>}
  </div>;

  const terms = interests.split(",").map(term => term.trim()).filter(Boolean);
  const invalidInterests = terms.length > 20 || terms.some(term => term.length > 60);
  const selectedModel = state.provider?.models.find(model => model.id === draft.model);
  const savedModel = state.provider?.models.find(model => model.id === state.settings.model);
  const stale = dirty && state.settings.revision !== draft.revision;
  const saved = state.settings;
  const paused = state.jobs.some(job => job.status === "paused");
  const running = state.jobs.some(job => job.status === "running");
  const status = loadError ? "Progress unavailable"
    : !state.configured ? "Not configured"
    : !saved.enabled ? "Off"
    : saved.mailboxIds?.length === 0 ? "No mailboxes selected"
    : state.queue.processing > 0 ? "Processing mail"
    : paused && !running ? "Historical processing paused"
    : state.queue.pending > 0 || running ? "Waiting to process mail"
    : "Idle — watching for new mail";
  return <div className="ai-triage-settings" aria-busy={busy}>
    <div className="ai-status" role="status" aria-live="polite" aria-atomic="true">
      <strong>{status}</strong>
      <span className="settings-note">{!state.configured ? "AI is unavailable; your normal inbox rules are in use." : !saved.enabled ? "AI sorting is off; your normal inbox rules are in use." : saved.mode === "apply" ? "Applying saved assessments to Important and Other." : "Preview only — AI suggestions do not change your inbox."}</span>
      <span className="settings-note">{loadError ? "Last reported queue: " : "Queue: "}{number(state.queue.processing)} processing · {number(state.queue.pending)} waiting · {number(state.queue.failed)} failed</span>
    </div>
    {state.queue.failed > 0 && <p className="settings-error">{number(state.queue.failed)} conversations could not be assessed. They use normal inbox rules, not a successful AI classification. Details are under Recent attempts below.</p>}
    {!state.configured && <p className="settings-note">Set up a provider, model and credentials in this host’s private configuration to use AI. Credentials never go in this page.</p>}
    {loadError && <p className="settings-error" role="alert">Could not refresh AI status. The last reported counts may be out of date.</p>}
    <button type="button" className="settings-text-button ai-refresh" disabled={busy} onClick={() => void run(async (api, alive) => {
      try {
        const next = await api.state(); if (alive()) { accept(next); setLoadError(false); }
      } catch (cause) {
        if (alive()) setLoadError(true);
        throw cause;
      }
    }, "Could not refresh AI status. Your unsaved settings have been kept.")}>Refresh status</button>
    <div className="ai-explanation">
      <p><strong>Important</strong> is for mail that needs your attention: personal requests, replies, real deadlines and important account issues. <strong>Other</strong> is for routine marketing, product updates and other non-actionable mail, unless your preferences make it important.</p>
      <p className="settings-note">AI reads selected text and recent conversation context. Superlocal combines that assessment with your explicit preferences and confirmed correspondence. Genuinely unclear mail stays Important for review; suspicious mail stays reviewable in Other. Manual category choices win.</p>
      <p className="settings-note">AI does not send replies, delete mail or move it to your provider’s Spam folder. Done (W) handles a message; it does not teach AI that you dislike the sender. Mail without a current assessment uses normal inbox rules.</p>
    </div>
    <form className="ai-settings-form" onSubmit={event => {
      event.preventDefault();
      if (invalidInterests || stale) return;
      void run(async (api, alive) => {
        const next = await api.configure({ ...draft, interests: terms });
        if (alive()) { accept(next, true); setNotice("AI triage settings saved."); }
      }, "Could not save settings. Reload saved settings before retrying; another change may have been saved.");
    }}>
      <fieldset disabled={busy}>
        <label className="settings-checkbox-row"><span>Enable AI triage</span><input type="checkbox" checked={draft.enabled} disabled={!state.configured && !draft.enabled} onChange={event => change({ enabled: event.target.checked })} /></label>
        <p className="settings-note">When enabled, selected email text and bounded thread context are sent to {state.provider?.endpointHost || "the privately configured provider"}. Personal behavior and preferences stay on the server.</p>
        <label className="settings-control-row"><span>Mode</span><select value={draft.mode} onChange={event => change({ mode: event.target.value as AiSettings["mode"] })}><option value="preview">Preview only</option><option value="apply">Apply to Important / Other</option></select></label>
        <p className="settings-note">Preview proposes categories without applying them. Save Apply mode to use saved assessments; this does not start a historical rescan.</p>
        <label className="settings-control-row"><span>Model</span><select value={draft.model} disabled={!state.provider?.models.length} onChange={event => change({ model: event.target.value })}>
          {!selectedModel && <option value={draft.model}>{draft.model || "Not configured"}</option>}
          {state.provider?.models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
        </select></label>
        <p className="settings-note">Changing the model does not automatically pay to reprocess older mail. Process historical mail below when you want new assessments.</p>
        <label className="settings-control-row"><span>Mailboxes</span><select value={draft.mailboxIds === null ? "all" : "selected"} onChange={event => change({ mailboxIds: event.target.value === "all" ? null : [] })}><option value="all">All active mailboxes</option><option value="selected">Selected mailboxes</option></select></label>
        {draft.mailboxIds !== null && <div className="ai-mailbox-options">
          {mailboxes.map(mailbox => <label className="settings-checkbox-row" key={mailbox.id}><span>{mailbox.name}{mailbox.email && <span className="settings-checkbox-note">{mailbox.email}</span>}</span><input type="checkbox" checked={draft.mailboxIds!.includes(mailbox.id)} onChange={event => change({ mailboxIds: event.target.checked ? [...draft.mailboxIds!, mailbox.id] : draft.mailboxIds!.filter(id => id !== mailbox.id) })} /></label>)}
          {!draft.mailboxIds.length && <p className="settings-note">No mailboxes selected. No email will be processed.</p>}
        </div>}
        <label className="settings-checkbox-row"><span>Personalize categories</span><input type="checkbox" checked={draft.personalization} onChange={event => change({ personalization: event.target.checked })} /></label>
        <label className="settings-field"><span>Local interests</span><input value={interests} maxLength={1220} placeholder="Comma-separated topics" onChange={event => { setInterests(event.target.value); change({}); }} aria-invalid={invalidInterests} /></label>
        <p className={invalidInterests ? "settings-error" : "settings-note"}>Up to 20 comma-separated terms, 60 characters each. Used locally, not sent to the model.</p>
        <label className="settings-checkbox-row"><span>Use estimated reading activity<span className="settings-checkbox-note">Opt-in active reading time for local personalization; no text, typing, or screenshots are collected.</span></span><input type="checkbox" checked={draft.readingSignals} onChange={event => change({ readingSignals: event.target.checked })} /></label>
      </fieldset>
      {stale && <p className="settings-error" role="alert">Settings changed elsewhere. Reload before saving.</p>}
      {dirty && <p className="settings-note" role="status">Unsaved AI changes. Status and processing still use your saved settings.</p>}
      <div className="ai-actions"><button type="submit" className="settings-button" disabled={busy || !dirty || invalidInterests || stale || draft.enabled && !state.configured}>Save AI settings</button><button type="button" className="settings-text-button" disabled={busy} onClick={reset}>{dirty ? "Discard AI changes" : "Reload saved settings"}</button></div>
    </form>
    {error && <p className="settings-error" role="alert">{error}</p>}
    {notice && <p className="settings-note" role="status">{notice}</p>}
    <section className="ai-section">
      <h3>Historical mail</h3>
      <div className="ai-actions">
        <select aria-label="Historical mail scope" value={scope} disabled={busy} onChange={event => setScope(event.target.value as "inbox" | "all")}><option value="inbox">Inbox</option><option value="all">All mail</option></select>
        <select aria-label="Maximum conversations" value={limit} disabled={busy} onChange={event => setLimit(Number(event.target.value))}>{[100, 500, 1000, 10000].map(value => <option key={value} value={value}>Up to {number(value)}</option>)}</select>
        <button type="button" className="settings-button" disabled={busy || !state.configured || !state.settings.enabled || state.settings.mailboxIds?.length === 0} onClick={() => void run(async (api, alive) => {
          await api.process({ id: crypto.randomUUID(), scope, limit });
          if (!alive()) return;
          const next = await api.state(); if (alive()) accept(next);
        }, "Could not start processing. Refresh progress before retrying.")}>Process historical mail</button>
      </div>
      <p className="settings-note">Uses saved settings and only already-synced mail, within the scope and limit above. This can incur provider charges. Current assessments are reused; missing or failed assessments and older uncertain marketing assessments are processed. Cancelling stops work, never deletes emails.</p>
      {state.jobs.length === 0 ? <p className="settings-note">No historical jobs started. Turning AI on does not mean all older mail has been processed.</p> : state.jobs.map(job => <div className="ai-job" key={job.id}>
        <div>{job.scope === "inbox" ? "Inbox" : "All mail"} · {job.status === "completed" && job.failed > 0 ? "Finished with failures" : aiLabel(job.status)} · up to {number(job.limit)}</div>
        <p className="settings-note">{number(job.completed)} assessed · {number(job.failed)} failed · {number(job.queued)} queued from {number(job.scanned)} scanned</p>
        {job.queued > 0 && <progress className="ai-job-progress" value={Math.min(job.queued, job.completed + job.failed)} max={job.queued} aria-label={`${job.scope === "inbox" ? "Inbox" : "All mail"} historical job, ${job.completed} assessed and ${job.failed} failed out of ${job.queued} queued`} />}
        {job.problemCode && <p className="settings-error">{job.problemCode}</p>}
        <div className="ai-actions">{(job.status === "running" ? ["pause", "cancel"] as const : job.status === "paused" ? ["resume", "cancel"] as const : []).map(action => <button type="button" className="settings-text-button" disabled={busy || action === "resume" && !state.settings.enabled} key={action} onClick={() => void run(async (api, alive) => {
          const next = await api.control(job.id, action);
          if (!alive()) return;
          setState(previous => previous ? { ...previous, jobs: previous.jobs.map(item => item.id === next.id ? next : item) } : previous);
        }, "Could not change this job. Refresh progress and try again.")}>{aiLabel(action)}</button>)}</div>
      </div>)}
    </section>
    <section className="ai-section">
      <h3>{state.settings.mode === "preview" ? "Preview results" : "Assessment results"}</h3>
      <p className="settings-note">{state.settings.mode === "preview" ? "Proposed categories are not applied. " : "Saved assessments. "}Loads only on request, up to 100 results.</p>
      <div className="ai-actions"><button type="button" className="settings-text-button" disabled={busy} onClick={() => void loadResults()}>{results ? "Refresh results" : "Load results"}</button>{hasMore && (results?.length ?? 0) < 100 && <button type="button" className="settings-text-button" disabled={busy} onClick={() => void loadResults(true)}>Load more</button>}</div>
      {results?.length === 0 && <p className="settings-note">No saved results returned. Pending work appears in the queue above.</p>}
      {!!results?.length && <div className="ai-table-scroll"><table className="ai-table"><thead><tr><th>{state.settings.mode === "preview" ? "Proposed category" : "Category"}</th><th>Assessment</th></tr></thead><tbody>{results.map(item => <tr key={JSON.stringify([item.sourceId, item.threadId])}><td>{item.override?.category || item.score?.category || "Not assessed"}<span className="ai-secondary">{aiLabel(item.state)}</span></td><td>{item.assessment ? <>{item.assessment.reason}<span className="ai-secondary">{aiLabel(item.assessment.type)} · {aiLabel(item.assessment.response)} · {aiTaskLabel(item.assessment.task)} · {aiLabel(item.assessment.risk)}</span></> : "Assessment not available"}</td></tr>)}</tbody></table></div>}
    </section>
    <section className="ai-section">
      <h3>Usage and estimated costs</h3>
      <Usage usage={state.usage} />
      {savedModel?.pricing ? <>
        <p className="settings-note">Reference rates for the saved model. Estimates above use the rates recorded with each attempt.</p>
        <dl className="ai-key-values">
          <dt>Input / output per million tokens</dt><dd>{dollars(savedModel.pricing.inputPerMillion)} / {dollars(savedModel.pricing.outputPerMillion)}</dd>
          <dt>Cached input / cache write</dt><dd>{savedModel.pricing.cachedInputPerMillion === null ? "Unknown" : dollars(savedModel.pricing.cachedInputPerMillion)} / {savedModel.pricing.cacheWriteInputPerMillion === null ? "Unknown" : dollars(savedModel.pricing.cacheWriteInputPerMillion)}</dd>
          <dt>Rate source</dt><dd>{savedModel.pricing.source}</dd><dt>Rate version</dt><dd>{savedModel.pricing.version}</dd>
        </dl>
      </> : <p className="settings-note">Pricing is not configured. Unknown costs are not counted as zero.</p>}
    </section>
    <section className="ai-section">
      <h3>Processing diagnostics</h3>
      <p className="settings-note">Decision grades, scoring factors and processing history. Mail excerpts stay in the private conversation assessment, not in diagnostic exports.</p>
      <div className="ai-actions"><button type="button" className="settings-text-button" disabled={busy} onClick={() => void run(async (api, alive) => { const next = await api.diagnostics(); if (alive()) setDiagnostics(next); }, "Could not load diagnostics. Try again.")}>{diagnostics ? "Refresh diagnostics" : "Load diagnostics"}</button>
        <button type="button" className="settings-text-button" disabled={busy} onClick={() => void run(async (api, alive) => {
          const next = await api.diagnostics(); if (!alive()) return;
          setDiagnostics(next);
          const url = URL.createObjectURL(new Blob([JSON.stringify(next, null, 2)], { type: "application/json" }));
          const anchor = document.createElement("a"); anchor.href = url; anchor.download = "ai-triage-diagnostics.json"; anchor.click();
          window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        }, "Could not download diagnostics. Try again.")}>Download diagnostics</button>
      </div>
      {diagnostics?.coverage && <>
        <dl className="ai-key-values">
          <dt>New-mail processing boundary</dt><dd>{diagnostics.coverage.admissionSince ? new Date(diagnostics.coverage.admissionSince).toLocaleString() : "Not established"}</dd>
          <dt>Last change check</dt><dd>{diagnostics.coverage.lastDrainAt ? new Date(diagnostics.coverage.lastDrainAt).toLocaleString() : "Not recorded"}</dd>
        </dl>
        {diagnostics.coverage.problemCode && <p className="settings-error" role="alert">Change processing needs attention: {diagnostics.coverage.problemCode}</p>}
        <details className="ai-details"><summary tabIndex={0}>Recorded event counts</summary>
          <p className="settings-note">Events can repeat for a conversation. These are not unique-message totals or a measure of classification accuracy.</p>
          <dl className="ai-key-values">{Object.entries(diagnostics.coverage.counts).map(([reason, count]) => <div className="ai-key-pair" key={reason}><dt>{activityLabels[reason] ?? aiLabel(reason)}</dt><dd>{number(count ?? 0)}</dd></div>)}</dl>
        </details>
      </>}
      {diagnostics?.activity && <>
        <h3>Recent decision activity</h3>
        <p className="settings-note">Latest {diagnostics.activity.length} events. Saved grades describe that event, not necessarily the current conversation.</p>
        {diagnostics.activity.length === 0 ? <p className="settings-note">No decision activity recorded yet.</p> : <div className="ai-table-scroll"><table className="ai-table"><thead><tr><th>Event</th><th>Decision record</th></tr></thead><tbody>{diagnostics.activity.slice(0, 50).map(item => <tr key={item.id}>
          <td>{activityLabels[item.reason] ?? aiLabel(item.reason)}<span className="ai-secondary">{new Date(item.at).toLocaleString()}</span>{item.eventReason && <span className="ai-secondary">Source event: {aiLabel(item.eventReason)}</span>}</td>
          <td>{item.category ? `${item.category}${item.manual ? " (manual)" : ""}` : "No category saved"}
            {item.assessment && <span className="ai-secondary">{aiLabel(item.assessment.type)} · {aiLabel(item.assessment.response)} · {aiTaskLabel(item.assessment.task)}</span>}
            <details className="ai-details"><summary tabIndex={0}>Inspect record</summary>
              <dl className="ai-key-values">
                <dt>Source / thread</dt><dd>{item.sourceId}<br />{item.threadId}</dd>
                <dt>State / revision</dt><dd>{item.state ? aiLabel(item.state) : "Not assessed"} / {item.revision ?? "Not recorded"}</dd>
                <dt>Model</dt><dd>{item.model ?? "No inference"}</dd>
                <dt>Assessment / score policy</dt><dd>{item.inputPolicyVersion ?? "Not recorded"} / {item.scorePolicyVersion ?? "Not scored"}</dd>
                <dt>Settings revision</dt><dd>{item.settingsRevision ?? "Not recorded"}</dd>
                {item.assessment && <><dt>Risk / certainty</dt><dd>{aiLabel(item.assessment.risk)} / {aiLabel(item.assessment.certainty)}</dd><dt>Actions</dt><dd>{item.assessment.actions.length ? item.assessment.actions.map(aiLabel).join(", ") : "None"}</dd><dt>Evidence references</dt><dd>{item.assessment.evidence.map((e, index) => <span className="ai-secondary" key={index}>{e.messageRef} · {aiLabel(e.field)}</span>)}</dd></>}
                {item.score !== undefined && <><dt>Score</dt><dd>{Number(item.score.toFixed(2))}</dd></>}
                {item.contributions?.map((part, index) => <div className="ai-key-pair" key={index}><dt>{aiLabel(part.name)}</dt><dd>{part.value > 0 ? "+" : ""}{Number(part.value.toFixed(2))}</dd></div>)}
              </dl>
            </details>
          </td>
        </tr>)}</tbody></table></div>}
      </>}
      {diagnostics && <h3>Inference attempts</h3>}
      {diagnostics?.attempts.length === 0 && <p className="settings-note">No diagnostic attempts recorded.</p>}
      {!!diagnostics?.attempts.length && <div className="ai-table-scroll"><table className="ai-table"><thead><tr><th>Attempt</th><th>Duration / queue</th></tr></thead><tbody>{diagnostics.attempts.slice(0, 50).map(attempt => <tr key={attempt.id}><td>{aiLabel(attempt.outcome)}{attempt.code && <span className="ai-secondary" title={attempt.code}>{problemLabels[attempt.code] || aiLabel(attempt.code)}</span>}<span className="ai-secondary">{attempt.model}</span>{attempt.requestId && <span className="ai-secondary">Request: {attempt.requestId}</span>}</td><td>{attempt.durationMs === null ? "Pending" : `${number(attempt.durationMs)} ms`} / {number(attempt.queueMs)} ms</td></tr>)}</tbody></table></div>}
    </section>
    <button type="button" className="settings-text-button ai-clear-reading" disabled={busy} onClick={() => {
      if (!window.confirm("Clear estimated reading history for this account? Emails, manual categories, interests, and other settings are kept.")) return;
      void run(async (api, alive) => { await api.clearReading(); if (alive()) setNotice("Estimated reading history cleared."); }, "Could not clear estimated reading history. Try again.");
    }}>Clear estimated reading history</button>
  </div>;
}

export default AiTriageSettings;
