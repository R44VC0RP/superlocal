import { useEffect, useRef, useState } from "react";
import { type AiDecision, type AiSettings, type AiTriageActions, type AiTriageState, type AiUsageSummary } from "../../shared/ai-triage";
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
  const [saveUncertain, setSaveUncertain] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const progressEpoch = useRef(0);
  const [reload, setReload] = useState(0);
  const [scope, setScope] = useState<"inbox" | "all">("inbox");
  const [limit, setLimit] = useState(100);
  const [historyRequest, setHistoryRequest] = useState<{ actions: AiTriageActions; input: Parameters<AiTriageActions["process"]>[0]; confirmation: string } | null>(null);
  const [historyConfirmation, setHistoryConfirmation] = useState<typeof historyRequest>(null);
  const historyButton = useRef<HTMLButtonElement>(null);
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
    setState(null); setDraft(null); setDirty(false); setBusy(false); setHistoryConfirmation(null);
    setResults(null); setResultCursor(undefined); setHasMore(false); setDiagnostics(null);
    setLoadError(false); setSaveUncertain(false); setError(""); setNotice("");
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

  /** Immediate, revision-conditional save of a single setting from the saved state (not the advanced draft). */
  function saveNow(patch: Partial<AiSettings>, message: string) {
    const saved = stateRef.current?.settings;
    if (!saved || dirtyRef.current || loadError || saveUncertain) return;
    if (patch.enabled && !stateRef.current?.configured) return;
    void run(async (api, alive) => {
      try {
        const next = await api.configure({ ...saved, ...patch });
        if (alive()) { accept(next, true); setNotice(message); }
      } catch (cause) {
        if (alive()) setSaveUncertain(true);
        throw cause;
      }
    }, "Could not confirm the saved setting. Reload saved settings before trying again; your change may have been saved.");
  }

  function refreshStatus() {
    void run(async (api, alive) => {
      try {
        const next = await api.state(); if (alive()) { accept(next); setLoadError(false); }
      } catch (cause) {
        if (alive()) setLoadError(true);
        throw cause;
      }
    }, "Could not refresh AI status. Your unsaved settings have been kept.");
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
  const pendingHistory = historyRequest?.actions === actions ? historyRequest : null;
  const level: "off" | "preview" | "apply" = !saved.enabled ? "off" : saved.mode;
  const locked = busy || dirty || loadError || saveUncertain;
  const provider = state.provider?.endpointHost || "the configured provider";
  const modelLabel = savedModel?.label || saved.model || "the saved model";
  const working = state.queue.processing + state.queue.pending;
  const runningJob = state.jobs.find(job => job.status === "running" || job.status === "paused");
  // Rough per-conversation budget for the confirmation: ~3k input and ~500 output tokens.
  const estimate = (count: number) => savedModel?.pricing ? count * (3000 * savedModel.pricing.inputPerMillion + 500 * savedModel.pricing.outputPerMillion) / 1_000_000 : null;
  const money = (value: number) => value < 0.01 ? "under a cent" : `about ${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value)}`;
  const rules = saved.rules ?? [];
  const setLevel = (next: typeof level) => {
    if (next === level) return;
    saveNow(next === "off" ? { enabled: false } : { enabled: true, mode: next }, next === "off" ? "AI sorting is off." : next === "preview" ? "Previewing. Your inbox will not change." : "Sorting new mail automatically.");
  };
  return <div className="ai-triage-settings" aria-busy={busy}>
    {!state.configured && <p className="settings-note">No AI provider is configured on this host, so sorting stays off. Add the host's private inference configuration to use it.</p>}
    <div className="ai-mode" role="radiogroup" aria-label="AI sorting">
      {([["off", "Off"], ["preview", "Preview"], ["apply", "Sort automatically"]] as const).map(([value, label]) => <button type="button" key={value} role="radio" aria-checked={level === value} className={`ai-mode-option ${level === value ? "is-selected" : ""}`} disabled={locked || value !== "off" && !state.configured} onClick={() => setLevel(value)}>{label}</button>)}
    </div>
    <p className="ai-mode-copy" role="status" aria-live="polite">
      {level === "off" && "New mail follows the normal inbox rules. Nothing is sent to the model."}
      {level === "preview" && <>New mail is assessed by {modelLabel} and the reasoning appears under <strong>Why?</strong> on each conversation, but Important and Other do not change. Use this to check its judgement first.</>}
      {level === "apply" && <>New mail is placed in <strong>Important</strong> or <strong>Other</strong> by {modelLabel}. Important means a reply or action is needed or it matches your interests. Your manual moves and taught rules always win.</>}
      {level !== "off" && <> Email text goes to {provider}; your reading history and preferences stay on this server.</>}
    </p>
    {level !== "off" && <label className="settings-checkbox-row ai-auto-labels"><span>Label by type<span className="settings-checkbox-note">Adds Newsletters, Promotions, Receipts, Notifications, Invitations or Cold outreach as local labels. Personal mail stays unlabeled; nothing is written to your provider.</span></span><input type="checkbox" checked={!!saved.autoLabels} disabled={locked} onChange={event => saveNow({ autoLabels: event.target.checked }, event.target.checked ? "Labeling by type. Already assessed mail is being labeled now." : "Type labels are no longer added.")} /></label>}
    {level !== "off" && (working > 0 || state.queue.failed > 0) && <p className="settings-note" role="status">
      {working > 0 && `Assessing ${number(working)} conversation${working === 1 ? "" : "s"}…`}
      {working > 0 && state.queue.failed > 0 && " "}
      {state.queue.failed > 0 && `${number(state.queue.failed)} could not be assessed and follow the normal rules.`}
    </p>}
    {(state.problemCode || loadError) && <p className="settings-error" role="alert">{loadError ? "Sorting status could not be checked. Existing mail stays available." : `Sorting needs attention: ${problemLabels[state.problemCode!] || aiLabel(state.problemCode!)}.`}</p>}
    {dirty && <p className="settings-note" role="status">Save or discard the advanced changes below before changing the mode.</p>}
    {stale && <p className="settings-error" role="alert">Settings changed elsewhere. Reload before saving.</p>}
    {error && <p className="settings-error" role="alert">{error}</p>}
    {saveUncertain && !error && <p className="settings-error" role="alert">The last change could not be confirmed. Reload saved settings before making another.</p>}
    {pendingHistory && !busy && <p className="settings-error" role="alert">The last sorting request is unconfirmed. Retry it below; its scope and limit are kept.</p>}
    {notice && <p className="settings-note" role="status">{notice}</p>}
    {saveUncertain ? <button type="button" className="settings-text-button ai-refresh" disabled={busy} onClick={reset}>Reload saved settings</button>
      : loadError && <button type="button" className="settings-text-button ai-refresh" disabled={busy} onClick={refreshStatus}>Refresh status</button>}

    {level !== "off" && <section className="ai-section">
      <h3>Sort mail already in your inbox</h3>
      <p className="settings-note">Turning sorting on only covers new mail. Run this once to assess what is already there; conversations that were already assessed are skipped.</p>
      <div className="ai-actions ai-history-controls">
        <select aria-label="Which mail" value={pendingHistory?.input.scope ?? scope} disabled={busy || !!pendingHistory || !!historyConfirmation} onChange={event => setScope(event.target.value as "inbox" | "all")}><option value="inbox">Inbox</option><option value="all">All mail</option></select>
        <select aria-label="How many conversations" value={pendingHistory?.input.limit ?? limit} disabled={busy || !!pendingHistory || !!historyConfirmation} onChange={event => setLimit(Number(event.target.value))}>{[100, 500, 1000, 10000].map(value => <option key={value} value={value}>Up to {number(value)}</option>)}</select>
        <button type="button" className="settings-button" ref={historyButton} aria-expanded={!!historyConfirmation} disabled={busy || saveUncertain || !!runningJob || !pendingHistory && (loadError || !state.configured || saved.mailboxIds?.length === 0)} onClick={() => {
          const cost = estimate(limit);
          const request = pendingHistory ?? {
            actions,
            input: { id: crypto.randomUUID(), scope, limit, settingsRevision: saved.revision },
            confirmation: `Send up to ${number(limit)} ${scope === "inbox" ? "inbox" : ""} conversations to ${modelLabel}${cost === null ? "" : ` (${money(cost)})`}?${saved.mode === "preview" ? " Preview only: your inbox will not change." : " Results will move mail between Important and Other."}`,
          };
          setHistoryConfirmation(request);
        }}>{pendingHistory ? "Retry" : "Sort now"}</button>
      </div>
      {historyConfirmation && <div className="ai-history-confirmation" role="group" aria-label="Confirm sorting" onKeyDown={event => {
        if (event.key === "Escape" && !busy) { event.preventDefault(); event.stopPropagation(); setHistoryConfirmation(null); historyButton.current?.focus(); }
      }}>
        <p>{historyConfirmation.confirmation}</p>
        <div className="ai-actions ai-history-controls">
        <button type="button" className="settings-button" disabled={busy || saveUncertain || !pendingHistory && loadError} onClick={() => {
          const request = historyConfirmation;
          if (request.actions !== actions) { setHistoryConfirmation(null); return; }
          void run(async (api, alive) => {
            setHistoryRequest(request);
            setHistoryConfirmation(null);
            let job;
            try {
              job = await api.process(request.input);
            } catch (cause) {
              if (alive() && cause && typeof cause === "object" && "code" in cause && cause.code === "AI_SETTINGS_CONFLICT") {
                setHistoryRequest(null); setLoadError(true);
                setError("Saved settings changed. Refresh status before starting a new run.");
                return;
              }
              throw cause;
            }
            if (!alive()) return;
            setHistoryRequest(null);
            const current = stateRef.current;
            if (current) accept({ ...current, jobs: [job, ...current.jobs.filter(item => item.id !== job.id)].slice(0, 20) });
            setNotice("Sorting started.");
            try {
              const next = await api.state(); if (alive()) { accept(next); setLoadError(false); }
            } catch {
              if (alive()) { setLoadError(true); setError("Sorting started, but progress could not be refreshed. Refresh status before starting another run."); }
            }
          }, "Could not start sorting. Retry the same request.");
        }}>Confirm</button>
        <button type="button" className="settings-text-button" autoFocus disabled={busy} onClick={() => { setHistoryConfirmation(null); historyButton.current?.focus(); }}>Cancel</button>
        </div>
      </div>}
      {state.jobs.slice(0, 5).map(job => {
        const done = job.completed + job.failed, scopeLabel = job.scope === "inbox" ? "Inbox" : job.scope === "important" ? "Important" : "All mail";
        const summary = job.status === "running" ? `${number(done)} of ${number(job.queued)} assessed` : job.status === "paused" ? `Paused at ${number(done)} of ${number(job.queued)}`
          : job.status === "completed" ? `${number(job.completed)} assessed${job.failed ? `, ${number(job.failed)} could not be` : ""}` : `${aiLabel(job.status)} after ${number(done)}`;
        return <div className="ai-job" key={job.id}>
          <div className="ai-job-line"><span>{scopeLabel} · up to {number(job.limit)}</span><span className="ai-secondary">{summary}</span>
            {(job.status === "running" ? ["pause", "cancel"] as const : job.status === "paused" ? ["resume", "cancel"] as const : []).map(action => <button type="button" className="settings-text-button" disabled={busy || action === "resume" && !saved.enabled} key={action} onClick={() => void run(async (api, alive) => {
              const next = await api.control(job.id, action);
              if (!alive()) return;
              setState(previous => previous ? { ...previous, jobs: previous.jobs.map(item => item.id === next.id ? next : item) } : previous);
            }, "Could not change this run. Refresh status and try again.")}>{aiLabel(action)}</button>)}
          </div>
          {(job.status === "running" || job.status === "paused") && job.queued > 0 && <progress className="ai-job-progress" value={Math.min(job.queued, done)} max={job.queued} aria-label={`${scopeLabel} sorting, ${done} of ${job.queued}`} />}
          {job.problemCode && <p className="settings-error">{problemLabels[job.problemCode] || aiLabel(job.problemCode)}</p>}
        </div>;
      })}
    </section>}

    {level !== "off" && <section className="ai-section">
      <h3>Taught rules</h3>
      {rules.length ? <ul className="ai-rule-list">{rules.map(rule => <li key={rule.id}>
        <span className="ai-rule-text">{rule.text}</span>
        {rule.category && <span className="ai-rule-category">→ {rule.category}</span>}
        <button type="button" className="settings-text-button" disabled={locked} onClick={() => saveNow({ rules: rules.filter(item => item.id !== rule.id) }, "Rule removed. Recent inbox mail is being re-sorted.")} aria-label={`Remove rule: ${rule.text}`}>Remove</button>
      </li>)}</ul> : null}
      <p className="settings-note">When a conversation is sorted wrong, open it, press <kbd>⌘K</kbd> and choose <strong>Teach AI</strong>. Say what should change in your own words; it becomes a rule here and recent inbox mail is re-sorted under it.</p>
    </section>}

    {level !== "off" && <details className="ai-settings-disclosure">
      <summary tabIndex={0}>Recent decisions</summary>
      <div className="ai-disclosure-body">
        <p className="settings-note">{level === "preview" ? "What the model would do. Nothing here has moved yet." : "What the model decided for recently assessed conversations."}</p>
        <div className="ai-actions"><button type="button" className="settings-text-button" disabled={busy} onClick={() => void loadResults()}>{results ? "Refresh" : "Load decisions"}</button>{hasMore && (results?.length ?? 0) < 100 && <button type="button" className="settings-text-button" disabled={busy} onClick={() => void loadResults(true)}>Load more</button>}</div>
        {results?.length === 0 && <p className="settings-note">No decisions yet.</p>}
        {!!results?.length && <div className="ai-table-scroll"><table className="ai-table"><thead><tr><th>{level === "preview" ? "Would be" : "Category"}</th><th>Why</th></tr></thead><tbody>{results.map(item => <tr key={JSON.stringify([item.sourceId, item.threadId])}><td>{item.override?.category || item.score?.category || "Not assessed"}{item.override && <span className="ai-secondary">Your choice</span>}{item.state !== "ready" && <span className="ai-secondary">{aiLabel(item.state)}</span>}</td><td>{item.assessment ? <>{item.assessment.reason}<span className="ai-secondary">{aiLabel(item.assessment.type)} · {aiLabel(item.assessment.response)} · {aiTaskLabel(item.assessment.task)}</span></> : "Assessment not available"}</td></tr>)}</tbody></table></div>}
      </div>
    </details>}

    <details className="ai-settings-disclosure">
      <summary tabIndex={0}>Advanced</summary>
      <div className="ai-disclosure-body">
      <form className="ai-settings-form" onSubmit={event => {
      event.preventDefault();
      if (!dirty || invalidInterests || stale || saveUncertain) return;
      void run(async (api, alive) => {
        try {
          const next = await api.configure({ ...draft, interests: terms });
          if (alive()) { accept(next, true); setNotice("AI settings saved."); }
        } catch (cause) {
          if (alive()) setSaveUncertain(true);
          throw cause;
        }
      }, "Could not save settings. Reload saved settings before retrying; another change may have been saved.");
    }}>
      <fieldset disabled={busy}>
        <label className="settings-control-row"><span>Model</span><select value={draft.model} disabled={!state.provider?.models.length} onChange={event => change({ model: event.target.value })}>
          {!selectedModel && <option value={draft.model}>{draft.model || "Not configured"}</option>}
          {state.provider?.models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
        </select></label>
        <label className="settings-control-row"><span>Mailboxes</span><select value={draft.mailboxIds === null ? "all" : "selected"} onChange={event => change({ mailboxIds: event.target.value === "all" ? null : [] })}><option value="all">All active mailboxes</option><option value="selected">Selected mailboxes</option></select></label>
        {draft.mailboxIds !== null && <div className="ai-mailbox-options">
          {mailboxes.map(mailbox => <label className="settings-checkbox-row" key={mailbox.id}><span>{mailbox.name}{mailbox.email && <span className="settings-checkbox-note">{mailbox.email}</span>}</span><input type="checkbox" checked={draft.mailboxIds!.includes(mailbox.id)} onChange={event => change({ mailboxIds: event.target.checked ? [...draft.mailboxIds!, mailbox.id] : draft.mailboxIds!.filter(id => id !== mailbox.id) })} /></label>)}
          {!draft.mailboxIds.length && <p className="settings-note">No mailboxes selected. No email will be processed.</p>}
        </div>}
        <label className="settings-checkbox-row"><span>Personalize with your correspondence history<span className="settings-checkbox-note">People you write to often lean Important. Computed locally.</span></span><input type="checkbox" checked={draft.personalization} onChange={event => change({ personalization: event.target.checked })} /></label>
        <label className="settings-field"><span>Interests</span><input value={interests} maxLength={1220} placeholder="Comma-separated topics" onChange={event => { setInterests(event.target.value); change({}); }} aria-invalid={invalidInterests} /></label>
        <p className={invalidInterests ? "settings-error" : "settings-note"}>Mail about these topics leans Important. Up to 20 terms of 60 characters; matched locally, not sent to the model.</p>
        <label className="settings-checkbox-row"><span>Use estimated reading activity<span className="settings-checkbox-note">Conversations you spend time reading lean Important. No text, typing, or screenshots are collected.</span></span><input type="checkbox" checked={draft.readingSignals} onChange={event => change({ readingSignals: event.target.checked })} /></label>
      </fieldset>
      {dirty && <p className="settings-note">Unsaved changes. Sorting keeps using your saved settings until you save.</p>}
      <div className="ai-actions"><button type="submit" className="settings-button" disabled={busy || !dirty || invalidInterests || stale || saveUncertain || draft.enabled && !state.configured}>Save</button><button type="button" className="settings-text-button" disabled={busy} onClick={reset}>{dirty ? "Discard changes" : "Reload saved settings"}</button></div>
    </form>
    <button type="button" className="settings-text-button ai-clear-reading" disabled={busy} onClick={() => {
      if (!window.confirm("Clear estimated reading history for this account? Emails, manual categories, interests, and other settings are kept.")) return;
      void run(async (api, alive) => { await api.clearReading(); if (alive()) setNotice("Estimated reading history cleared."); }, "Could not clear estimated reading history. Try again.");
    }}>Clear estimated reading history</button>
      </div>
    </details>

    <details className="ai-settings-disclosure">
      <summary tabIndex={0}>Usage and cost</summary>
      <div className="ai-disclosure-body">
      <Usage usage={state.usage} />
      {savedModel?.pricing ? <>
        <p className="settings-note">Reference rates for {savedModel.label}. Estimates above use the rates recorded with each attempt.</p>
        <dl className="ai-key-values">
          <dt>Input / output per million tokens</dt><dd>{dollars(savedModel.pricing.inputPerMillion)} / {dollars(savedModel.pricing.outputPerMillion)}</dd>
          <dt>Cached input / cache write</dt><dd>{savedModel.pricing.cachedInputPerMillion === null ? "Unknown" : dollars(savedModel.pricing.cachedInputPerMillion)} / {savedModel.pricing.cacheWriteInputPerMillion === null ? "Unknown" : dollars(savedModel.pricing.cacheWriteInputPerMillion)}</dd>
          <dt>Rate source</dt><dd>{savedModel.pricing.source}</dd><dt>Rate version</dt><dd>{savedModel.pricing.version}</dd>
        </dl>
      </> : <p className="settings-note">Pricing is not configured for {modelLabel}. Unknown costs are not counted as zero.</p>}
      </div>
    </details>

    <details className="ai-settings-disclosure">
      <summary tabIndex={0}>Diagnostics</summary>
      <div className="ai-disclosure-body">
      <p className="settings-note">{loadError ? "Last reported queue: " : "Queue: "}{number(state.queue.processing)} processing · {number(state.queue.pending)} waiting · {number(state.queue.failed)} failed</p>
      {state.problemCode && <p className="settings-error">{state.problemCode}</p>}
      <button type="button" className="settings-text-button ai-refresh" disabled={busy} onClick={refreshStatus}>Refresh status</button>
    <section className="ai-section">
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
      </div>
    </details>
  </div>;
}

export default AiTriageSettings;
