import { useEffect, useRef, useState } from "react";
import type { AiDecision, AiSettings, AiTriageActions, AiTriageState, AiUsageSummary } from "../../shared/ai-triage";
import { aiLabel } from "./ConversationTriage";
import "./ai-triage.css";

export type AiTriageSettingsProps = {
  actions?: AiTriageActions;
  mailboxes: Array<{ id: string; name: string; email?: string }>;
};

type Diagnostics = Awaited<ReturnType<AiTriageActions["diagnostics"]>>;
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

export function AiTriageSettings({ actions, mailboxes }: AiTriageSettingsProps) {
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
  const [reload, setReload] = useState(0);
  const [scope, setScope] = useState<"inbox" | "all">("inbox");
  const [limit, setLimit] = useState(100);
  const [results, setResults] = useState<AiDecision[] | null>(null);
  const [resultCursor, setResultCursor] = useState<number>();
  const [hasMore, setHasMore] = useState(false);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);

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
    if (!actions || !state?.settings.enabled) return;
    let ignore = false, pending = false;
    const timer = window.setInterval(() => {
      if (pending || busyRef.current) return;
      pending = true;
      void actions.state().then(next => {
        if (!ignore) { accept(next); setLoadError(false); }
      }).catch(() => { if (!ignore) setLoadError(true); }).finally(() => { pending = false; });
    }, 2000);
    return () => { ignore = true; window.clearInterval(timer); };
  }, [actions, state?.settings.enabled, reload]);

  function change(patch: Partial<AiSettings>) {
    dirtyRef.current = true;
    setDirty(true); setNotice("");
    setDraft(previous => previous ? { ...previous, ...patch } : previous);
  }

  async function run(work: (api: AiTriageActions, alive: () => boolean) => Promise<void>, failure: string) {
    if (!actions || busyRef.current) return;
    const token = lifetime.current;
    const alive = () => token !== null && lifetime.current === token;
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
  const stale = dirty && state.settings.revision !== draft.revision;
  return <div className="ai-triage-settings" aria-busy={busy}>
    {!state.configured && <p className="settings-note">AI triage requires a provider, model, and credentials in the host’s private configuration. No credentials are entered here. Your mail remains usable.</p>}
    {loadError && <p className="settings-error" role="alert">Could not refresh progress. <button type="button" className="settings-link-button" onClick={reset}>Retry</button></p>}
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
        <details className="ai-details"><summary>Model details</summary>
          {selectedModel && <p>{selectedModel.id}</p>}
          {selectedModel?.pricing ? <dl className="ai-key-values">
            <dt>Input / output per million tokens</dt><dd>{dollars(selectedModel.pricing.inputPerMillion)} / {dollars(selectedModel.pricing.outputPerMillion)}</dd>
            <dt>Cached input / cache write</dt><dd>{selectedModel.pricing.cachedInputPerMillion === null ? "Unknown" : dollars(selectedModel.pricing.cachedInputPerMillion)} / {selectedModel.pricing.cacheWriteInputPerMillion === null ? "Unknown" : dollars(selectedModel.pricing.cacheWriteInputPerMillion)}</dd>
            <dt>Rate source</dt><dd>{selectedModel.pricing.source}</dd><dt>Rate version</dt><dd>{selectedModel.pricing.version}</dd>
          </dl> : <p className="settings-note">Pricing is not configured. Costs will not be shown as zero.</p>}
        </details>
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
      <div className="ai-actions"><button type="submit" className="settings-button" disabled={busy || !dirty || invalidInterests || stale || draft.enabled && !state.configured}>Save</button><button type="button" className="settings-text-button" disabled={busy} onClick={reset}>Reload saved settings</button></div>
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
        }, "Could not start processing. Refresh progress before retrying.")}>Process</button>
      </div>
      <p className="settings-note">Uses saved settings. Cancelling stops work, never deletes emails.</p>
      <p className="settings-note">Queue: {number(state.queue.pending)} pending · {number(state.queue.processing)} processing · {number(state.queue.failed)} failed</p>
      {state.jobs.length === 0 ? <p className="settings-note">No historical jobs started.</p> : state.jobs.map(job => <div className="ai-job" key={job.id}>
        <div>{job.scope === "inbox" ? "Inbox" : "All mail"} · {aiLabel(job.status)} · up to {number(job.limit)}</div>
        <p className="settings-note">{number(job.scanned)} scanned · {number(job.queued)} queued · {number(job.completed)} completed · {number(job.failed)} failed</p>
        <div className="ai-actions">{(job.status === "running" ? ["pause", "cancel"] as const : job.status === "paused" ? ["resume", "cancel"] as const : []).map(action => <button type="button" className="settings-text-button" disabled={busy || action === "resume" && !state.settings.enabled} key={action} onClick={() => void run(async (api, alive) => {
          const next = await api.control(job.id, action);
          if (!alive()) return;
          setState(previous => previous ? { ...previous, jobs: previous.jobs.map(item => item.id === next.id ? next : item) } : previous);
        }, "Could not change this job. Refresh progress and try again.")}>{aiLabel(action)}</button>)}</div>
      </div>)}
    </section>
    <details className="ai-details">
      <summary>{state.settings.mode === "preview" ? "Preview results" : "Assessment results"}</summary>
      <p className="settings-note">{state.settings.mode === "preview" ? "Proposed categories are not applied. " : "Saved assessments. "}Loads only on request, up to 100 results.</p>
      <div className="ai-actions"><button type="button" className="settings-text-button" disabled={busy} onClick={() => void loadResults()}>{results ? "Refresh results" : "Load results"}</button>{hasMore && (results?.length ?? 0) < 100 && <button type="button" className="settings-text-button" disabled={busy} onClick={() => void loadResults(true)}>Load more</button>}</div>
      {results?.length === 0 && <p className="settings-note">No saved results returned. Pending work appears in the queue above.</p>}
      {!!results?.length && <div className="ai-table-scroll"><table className="ai-table"><thead><tr><th>{state.settings.mode === "preview" ? "Proposed category" : "Category"}</th><th>Assessment</th></tr></thead><tbody>{results.map(item => <tr key={JSON.stringify([item.sourceId, item.threadId])}><td>{item.override?.category || item.score?.category || "Not assessed"}<span className="ai-secondary">{aiLabel(item.state)}</span></td><td>{item.assessment ? <>{item.assessment.reason}<span className="ai-secondary">{aiLabel(item.assessment.type)} · {aiLabel(item.assessment.response)} · {aiLabel(item.assessment.risk)}</span></> : "Assessment not available"}</td></tr>)}</tbody></table></div>}
    </details>
    <details className="ai-details">
      <summary>Diagnostics and estimated costs</summary>
      <Usage usage={diagnostics?.usage ?? state.usage} />
      <div className="ai-actions"><button type="button" className="settings-text-button" disabled={busy} onClick={() => void run(async (api, alive) => { const next = await api.diagnostics(); if (alive()) setDiagnostics(next); }, "Could not load diagnostics. Try again.")}>{diagnostics ? "Refresh diagnostics" : "Load recent attempts"}</button>
        <button type="button" className="settings-text-button" disabled={busy} onClick={() => void run(async (api, alive) => {
          const next = await api.diagnostics(); if (!alive()) return;
          setDiagnostics(next);
          const url = URL.createObjectURL(new Blob([JSON.stringify(next, null, 2)], { type: "application/json" }));
          const anchor = document.createElement("a"); anchor.href = url; anchor.download = "ai-triage-diagnostics.json"; anchor.click();
          window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        }, "Could not download diagnostics. Try again.")}>Download diagnostics</button>
      </div>
      {diagnostics?.attempts.length === 0 && <p className="settings-note">No diagnostic attempts recorded.</p>}
      {!!diagnostics?.attempts.length && <div className="ai-table-scroll"><table className="ai-table"><thead><tr><th>Attempt</th><th>Duration / queue</th></tr></thead><tbody>{diagnostics.attempts.slice(0, 50).map(attempt => <tr key={attempt.id}><td>{aiLabel(attempt.outcome)}{attempt.code && <span className="ai-secondary">{attempt.code}</span>}<span className="ai-secondary">{attempt.model}</span>{attempt.requestId && <span className="ai-secondary">Request: {attempt.requestId}</span>}</td><td>{attempt.durationMs === null ? "Pending" : `${number(attempt.durationMs)} ms`} / {number(attempt.queueMs)} ms</td></tr>)}</tbody></table></div>}
    </details>
    <button type="button" className="settings-text-button ai-clear-reading" disabled={busy} onClick={() => {
      if (!window.confirm("Clear estimated reading history for this account? Emails, manual categories, interests, and other settings are kept.")) return;
      void run(async (api, alive) => { await api.clearReading(); if (alive()) setNotice("Estimated reading history cleared."); }, "Could not clear estimated reading history. Try again.");
    }}>Clear estimated reading history</button>
  </div>;
}

export default AiTriageSettings;
