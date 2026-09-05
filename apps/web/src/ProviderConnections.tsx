import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type RefObject } from "react";
import type { Account, MailboxCandidate, MailboxSelector } from "inbox-sdk/types";
import { Icon } from "./components";
import type { HostConfiguration, HostProvider } from "./host";
import { connectHostProvider } from "./host";
import type { InboxStore } from "./inbox";

type Phase = "connecting" | "finding" | "adding" | "syncing" | "refreshing" | "connected" | "failed";
type Progress = { kind: "progress"; providerId: string; phase: Phase; failedAt: Phase | null; connectionIds: string[]; added: string[]; error: string | null; note: string | null };
type Step = { kind: "pick" } | { kind: "connect"; providerId: string; reconnectId: string | null } | Progress;
type Field = NonNullable<HostProvider["fields"]>[number];

// Compare selector values, not object property order. Do not infer receiving scopes from names or senders.
const mailboxKey = (sourceId: string, selector: MailboxSelector) => JSON.stringify([sourceId, selector.kind, selector.kind === "all" ? null : selector.value]);
const problem = (cause: unknown, fallback: string) => cause instanceof Error ? cause.message : fallback;
const scopeLabel = (selector: MailboxSelector) => selector.kind === "all" ? "All mail" : selector.value;

/**
 * Coverage without duplicates: every eligible "all mail" scope, every eligible domain, and every eligible
 * address whose domain is not already covered. The user can prune or pin later in Mailboxes.
 */
function coverage(candidates: MailboxCandidate[]): MailboxCandidate[] {
  const eligible = candidates.filter(candidate => candidate.canReceive && candidate.canFilter);
  const domains = new Set(eligible.flatMap(candidate => candidate.selector.kind === "domain" ? [candidate.selector.value] : []));
  return eligible.filter(candidate => candidate.selector.kind !== "address" || !domains.has(candidate.selector.value.split("@").at(-1) ?? ""));
}

const method = (provider: HostProvider) =>
  provider.connection === "oauth" ? "Sign in with your Google account"
  : provider.fields?.some(field => field.name === "apiKey") ? "Paste an API key"
  : provider.fields?.some(field => field.type === "password") ? "Email and app-specific password"
  : "";

const statusLabel = (source: Account) =>
  source.status === "reconnect_required" ? "Sign-in required" : source.status === "disconnected" ? "Disconnected" : "Connected";

// Account sync problems are codes, not provider messages. Unknown codes stay generic.
function syncProblemLabel(code: string): string {
  switch (code) {
    case "AUTHENTICATION": return "Couldn’t sync mail: the provider rejected sign-in.";
    case "AUTHORIZATION": return "Couldn’t sync mail: the provider denied access.";
    case "CREDENTIALS_REVOKED": return "Couldn’t sync mail: provider access was revoked.";
    case "CREDENTIALS_UNAVAILABLE": return "Couldn’t sync mail: sign-in credentials are unavailable.";
    case "RECONNECT_REQUIRED": return "Couldn’t sync mail: the provider requires sign-in.";
    case "NOT_FOUND": return "Couldn’t sync mail: requested mail data was not found.";
    case "RATE_LIMITED": return "Couldn’t sync mail: the provider’s request limit was reached.";
    case "INVALID_CURSOR": return "Couldn’t sync mail: the saved sync position is no longer valid.";
    case "UNSUPPORTED_OPERATION": return "Couldn’t sync mail: the provider does not support this sync operation.";
    case "VALIDATION": return "Couldn’t sync mail: the sync request was not accepted.";
    case "NETWORK": return "Couldn’t sync mail: communication with the provider failed.";
    case "UPSTREAM": return "Couldn’t sync mail: the provider response could not be processed.";
    case "INVALID_PROVIDER": return "Couldn’t sync mail: the mail provider is not available.";
    default: return "Couldn’t sync mail.";
  }
}

export default function ProviderConnections({ host, store, resume, onStepChange, onDone, onBeforeRedirect }: {
  host: HostConfiguration | null;
  store: InboxStore;
  /** Present after an OAuth redirect: finish onboarding for this provider/connection immediately. */
  resume: { providerId: string; connectionId: string | null } | null;
  onStepChange: (state: { title: string; back: (() => void) | null; busy: boolean }) => void;
  onDone?: () => void;
  onBeforeRedirect?: () => boolean;
}) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const configuration = snapshot.host ?? host;
  const [step, setStep] = useState<Step>({ kind: "pick" });
  const [preset, setPreset] = useState("");
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const resumed = useRef<"idle" | "running" | "handled">("idle");
  const root = useRef<HTMLDivElement | null>(null);

  // The control that advanced the step unmounts with it; keep focus inside the dialog without drawing a ring.
  useEffect(() => {
    if (document.activeElement === document.body || document.activeElement === null) root.current?.focus({ preventScroll: true });
  }, [step.kind]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; controller.current?.abort(); };
  }, []);

  const providers = useMemo(() => (configuration?.providers ?? []).filter(provider => provider.enabled), [configuration]);
  const provider = step.kind === "pick" ? null : providers.find(item => item.id === step.providerId) ?? null;
  const busy = step.kind === "progress" && step.phase !== "connected" && step.phase !== "failed";

  useEffect(() => {
    const toPick = () => {
      controller.current?.abort();
      controller.current = null;
      if (resumed.current === "running") resumed.current = "handled";
      setStep({ kind: "pick" });
    };
    onStepChange(step.kind === "pick" ? { title: "Add account", back: null, busy: false }
      : step.kind === "connect" ? { title: step.reconnectId ? `Reconnect ${provider?.name ?? "account"}` : `Add ${provider?.name ?? "account"}`, back: toPick, busy: false }
      : { title: provider?.name ?? "Connecting", back: step.phase === "failed" ? toPick : null, busy });
  }, [step, provider, busy, onStepChange]);


  const report = (patch: Partial<Progress>) => {
    if (!mounted.current) return;
    setStep(current => current.kind === "progress" ? { ...current, ...patch } : current);
  };

  /** After a connection exists: discover its mailboxes, add coverage, sync, refresh. */
  async function finalize(target: HostProvider, connectionIds: string[], signal: AbortSignal) {
    const added: string[] = [];
    const push = (label: string) => { added.push(label); report({ added: [...added] }); };
    let note: string | null = null;
    report({ phase: "finding", connectionIds });
    await store.refresh(true);
    if (signal.aborted) return;
    const syncs: Array<[string, "latest" | "backfill", number]> = [];
    if (target.mailboxSelection === "automatic") {
      const boxes = store.getSnapshot().mailboxes.filter(box => connectionIds.includes(box.connectionId) && box.status === "active");
      for (const box of boxes) { push(box.name || scopeLabel(box.selector)); syncs.push([box.id, "latest", 25]); }
      if (!boxes.length) note = "Its mailbox is paused. Resume it in Mailboxes to load mail.";
    } else {
      const existing = new Set(store.getSnapshot().mailboxes.filter(box => box.status !== "detached").map(box => mailboxKey(box.sourceId, box.selector)));
      const wanted: MailboxCandidate[] = [];
      for (const id of connectionIds) {
        if (signal.aborted) return;
        for (const candidate of coverage(await store.client.mailboxCandidates(id, { signal }))) {
          if (!existing.has(mailboxKey(candidate.sourceId, candidate.selector))) wanted.push(candidate);
        }
      }
      report({ phase: "adding" });
      const sources = new Set<string>();
      for (const candidate of wanted) {
        if (signal.aborted) return;
        // One in-flight create at a time; only eligible, uncovered scopes reach this call.
        const box = await store.client.createMailbox({
          sourceId: candidate.sourceId, name: candidate.name, selector: candidate.selector,
          defaultSender: candidate.canSend ? candidate.identities[0] ?? null : null,
        }, { signal });
        push(candidate.name);
        // syncMailbox synchronizes a source, not a single scope: one sync per source.
        if (!sources.has(candidate.sourceId)) { sources.add(candidate.sourceId); syncs.push([box.id, "backfill", 50]); }
      }
    }
    report({ phase: "syncing" });
    let syncFailures = 0;
    for (const [boxId, lane, limit] of syncs) {
      if (signal.aborted) return;
      try { await store.client.syncMailbox(boxId, { lane, limit }, { signal }); }
      catch { if (signal.aborted) return; syncFailures++; }
    }
    if (syncFailures) note = "Recent mail could not be loaded yet. It will sync when the connection is available.";
    report({ phase: "refreshing" });
    await store.refresh(true);
    if (signal.aborted) return;
    report({ phase: "connected", note });
  }

  function begin(providerId: string, connectionIds: string[] = []): AbortController | null {
    if (controller.current) return null;
    const operation = new AbortController();
    controller.current = operation;
    setStep({ kind: "progress", providerId, phase: "connecting", failedAt: null, connectionIds, added: [], error: null, note: null });
    return operation;
  }

  async function run(target: HostProvider, operation: AbortController, work: (signal: AbortSignal) => Promise<void>) {
    try {
      await work(operation.signal);
    } catch (cause) {
      if (mounted.current && !operation.signal.aborted) {
        const error = problem(cause, `Could not connect ${target.name}.`);
        setStep(current => current.kind === "progress" ? { ...current, phase: "failed", failedAt: current.phase, error } : current);
      }
    } finally {
      if (controller.current === operation) controller.current = null;
    }
  }

  function setUp(target: HostProvider, connectionIds: string[]) {
    const operation = begin(target.id, connectionIds);
    if (operation) void run(target, operation, signal => finalize(target, connectionIds, signal));
  }

  async function connect(event: FormEvent<HTMLFormElement>, target: HostProvider, reconnectId: string | null) {
    event.preventDefault();
    const form = event.currentTarget;
    const credentials = Object.fromEntries([...new FormData(form)].filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    // Credentials exist only in this submission. Clear password controls immediately;
    // never put mail passwords in React state, draft recovery, storage, or URLs.
    for (const input of form.querySelectorAll<HTMLInputElement>('input[type="password"]')) input.value = "";
    const operation = begin(target.id);
    if (!operation) return;
    await run(target, operation, async signal => {
      try {
        const result = await connectHostProvider(target.id, credentials, signal, reconnectId ?? undefined);
        if (result.authorizeUrl) {
          const url = new URL(result.authorizeUrl, location.origin);
          if (url.origin !== location.origin) throw new Error("The host returned an unexpected authorization address.");
          if (onBeforeRedirect?.() === false) throw new Error("Sign-in was canceled. Unsaved settings are still open.");
          location.assign(url.href);
          return;
        }
        if (!result.connectionId) throw new Error("The host did not return a connection.");
        await finalize(target, [result.connectionId], signal);
      } finally {
        for (const key of Object.keys(credentials)) credentials[key] = "";
      }
    });
  }

  // OAuth return: the page reloaded, so pick up the new connection and finish here.
  // Runs once per resume request; an aborted attempt (StrictMode remount, unmount) may start again.
  const ready = configuration !== null;
  useEffect(() => {
    if (!resume || !ready || resumed.current !== "idle") return;
    const target = (store.getSnapshot().host ?? host)?.providers.find(item => item.enabled && item.id === resume.providerId);
    if (!target) return;
    const operation = begin(target.id);
    if (!operation) return;
    resumed.current = "running";
    void run(target, operation, async signal => {
      await store.refresh(true);
      if (signal.aborted) return;
      const known = store.getSnapshot().host?.providers.find(item => item.id === target.id)?.connectionIds ?? target.connectionIds;
      const ids = resume.connectionId && known.includes(resume.connectionId) ? [resume.connectionId] : known;
      if (!ids.length) throw new Error("The connection could not be found after signing in.");
      await finalize(target, ids, signal);
    }).then(() => { if (!operation.signal.aborted) resumed.current = "handled"; });
    return () => {
      if (resumed.current !== "running") return;
      operation.abort();
      if (controller.current === operation) controller.current = null;
      resumed.current = "idle";
    };
  }, [resume, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!configuration) return <p className="settings-note" role="status">Loading provider setup…</p>;

  if (step.kind === "pick") {
    const addable = providers.filter(item => item.connection !== "none");
    const covered = new Set(snapshot.mailboxes.filter(box => box.status !== "detached").map(box => box.connectionId));
    const sources = snapshot.sources.filter(source => source.connectionId && providers.some(item => item.connectionIds.includes(source.connectionId!)));
    return (
      <div className="provider-flow" ref={root} tabIndex={-1}>
        {configuration.mode === "mock" && <p className="settings-note">Offline mock: explore the fictional sources below. Enable real providers in the local host configuration to add accounts.</p>}
        {!configuration.allowProviderWrites && configuration.mode !== "mock" && <p className="settings-note">Real accounts are read-only. Provider changes are disabled.</p>}
        {addable.length > 0 && <div className="provider-options">
          {addable.map(item => {
            const disabled = !item.ready || !configuration.allowProviderWrites;
            return <button key={item.id} type="button" className="provider-option" disabled={disabled}
              title={!item.ready ? item.setupMessage || "Configure this provider in your local host before connecting." : undefined}
              onClick={() => { setPreset(item.fields?.find(field => field.type === "select")?.defaultValue ?? ""); setStep({ kind: "connect", providerId: item.id, reconnectId: null }); }}>
              <span className="mailbox-row-label"><span>{item.name}</span><small>{!item.ready ? "Setup required" : method(item)}</small></span>
              <Icon name="ChevronRight" size={14} />
            </button>;
          })}
        </div>}
        {addable.length === 0 && configuration.mode !== "mock" && <p className="settings-note">No providers are enabled in the local host configuration.</p>}
        {sources.length > 0 && <section className="provider-connected" aria-label="Connected accounts">
          <h3>Connected</h3>
          <ul>
            {sources.map(source => {
              const connectionId = source.connectionId!;
              const owner = providers.find(item => item.connectionIds.includes(connectionId))!;
              const attention = source.status !== "connected";
              const incomplete = source.status === "connected" && owner.mailboxSelection !== "automatic" && !covered.has(connectionId);
              const writable = configuration.allowProviderWrites;
              return <li key={source.id}>
                <span className="mailbox-row-label" title={`${source.email || source.name} · ${owner.name}`}>
                  <span>{source.email || source.name}</span>
                  <small className={attention || incomplete ? "provider-attention" : ""}>{owner.name} · {incomplete ? "Setup not finished" : statusLabel(source)}</small>
                  {source.status === "connected" && source.sync.problem && <small>{syncProblemLabel(source.sync.problem)}</small>}
                </span>
                {writable && incomplete && <button type="button" className="settings-text-button" onClick={() => setUp(owner, [connectionId])}>Finish setup</button>}
                {writable && owner.reconnect && <button type="button" className="settings-text-button" onClick={() => {
                  setPreset(owner.fields?.find(field => field.type === "select")?.defaultValue ?? "");
                  setStep({ kind: "connect", providerId: owner.id, reconnectId: connectionId });
                }}>Reconnect</button>}
                {writable && owner.connection === "oauth" && attention && <button type="button" className="settings-text-button" onClick={() => setStep({ kind: "connect", providerId: owner.id, reconnectId: null })}>Sign in again</button>}
              </li>;
            })}
          </ul>
        </section>}
      </div>
    );
  }

  if (!provider) return <p className="settings-note" role="alert">This provider is no longer available.</p>;

  if (step.kind === "connect") {
    const reconnecting = snapshot.sources.find(source => source.connectionId === step.reconnectId);
    const hasPreset = provider.fields?.some(field => field.type === "select") ?? false;
    const currentPreset = preset || provider.fields?.find(field => field.type === "select")?.defaultValue || "icloud";
    const isIcloud = !hasPreset || currentPreset === "icloud";
    const fieldInput = (field: Field) => <label className="settings-field" key={field.name}>
      <span>{field.type === "password" && provider.id === "imap" && !isIcloud ? "Mail password" : field.label}</span>
      {field.type === "select" ? <select name={field.name} required={field.required} value={currentPreset} onChange={event => setPreset(event.target.value)}>
        {field.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select> : <input name={field.name} type={field.type} required={field.required} maxLength={4096}
        defaultValue={field.name === "email" ? reconnecting?.email : field.defaultValue} readOnly={field.name === "email" && !!reconnecting}
        autoComplete={field.type === "email" ? "email" : "off"} autoCapitalize="none" spellCheck={false} />}
    </label>;
    return (
      <form className="provider-flow provider-connect" ref={root as unknown as RefObject<HTMLFormElement>} tabIndex={-1} key={`${provider.id}:${step.reconnectId ?? ""}`} onSubmit={event => void connect(event, provider, step.reconnectId)}>
        {provider.connection === "oauth" ? <>
          <p className="settings-note">You will be sent to Google to approve access, then brought back here while your mail loads.</p>
          <button className="settings-button" type="submit">{provider.actionLabel || `Sign in with ${provider.name}`}</button>
        </> : <>
          {reconnecting && <p className="settings-note">Enter a new password for {reconnecting.email || reconnecting.name}. Server settings stay the same.</p>}
          {(provider.fields ?? []).filter(field => !field.advanced).map(fieldInput)}
          {!isIcloud && provider.fields?.some(field => field.advanced) && <details className="provider-advanced">
            <summary>Advanced server settings</summary>
            <p className="settings-note">Server endpoints and required TLS are set by the selected host preset. Change presets in the local host configuration.</p>
            {provider.fields.filter(field => field.advanced).map(fieldInput)}
          </details>}
          {provider.credentialHelp && isIcloud && <p className="settings-note">{provider.credentialHelp.text} <a href={provider.credentialHelp.url} target="_blank" rel="noopener noreferrer">Create an app-specific password</a></p>}
          <button className="settings-button" type="submit">{step.reconnectId ? "Reconnect" : provider.actionLabel || `Connect ${provider.name}`}</button>
        </>}
      </form>
    );
  }

  const automatic = provider.mailboxSelection === "automatic";
  const phases: Array<{ id: Phase; label: string }> = [
    { id: "connecting", label: "Connecting" },
    { id: "finding", label: automatic ? "Checking mailbox" : "Finding mailboxes" },
    ...(automatic ? [] : [{ id: "adding" as Phase, label: "Adding mailboxes" }]),
    { id: "syncing", label: "Loading recent mail" },
    { id: "refreshing", label: "Refreshing inbox" },
  ];
  const order: Phase[] = ["connecting", "finding", "adding", "syncing", "refreshing", "connected"];
  const position = order.indexOf(step.phase === "failed" ? step.failedAt ?? "connecting" : step.phase);
  const failedAfterConnect = step.phase === "failed" && step.connectionIds.length > 0;
  return (
    <div className="provider-flow provider-progress" ref={root} tabIndex={-1} role="status" aria-live="polite">
      <ol className="provider-phases">
        {phases.map(phase => {
          const index = order.indexOf(phase.id);
          const state = step.phase === "connected" || index < position ? "done" : index === position ? step.phase === "failed" ? "failed" : "active" : "pending";
          return <li key={phase.id} data-state={state}>
            <span className="provider-phase-mark" aria-hidden="true">{state === "done" ? <Icon name="Check" size={12} /> : state === "failed" ? <Icon name="Close" size={12} /> : state === "active" ? <i /> : null}</span>
            <span>{phase.label}</span>
          </li>;
        })}
      </ol>
      {step.phase === "connected" && <p className="provider-result">
        <strong>Connected.</strong> {step.added.length ? `Added ${step.added.length === 1 ? step.added[0] : `${step.added.length} mailboxes`}.` : step.note ?? "Mailbox is up to date."}
        {step.added.length > 0 && step.note && ` ${step.note}`}
      </p>}
      {step.added.length > 1 && step.phase !== "failed" && <ul className="provider-added">{step.added.map(name => <li key={name}>{name}</li>)}</ul>}
      {step.phase === "failed" && <p className="provider-connection-error" role="alert">{step.error}</p>}
      {step.phase === "connected" && <button type="button" className="settings-button" onClick={() => { setStep({ kind: "pick" }); onDone?.(); }}>Done</button>}
      {step.phase === "failed" && <div className="mailbox-bulk-actions">
        {failedAfterConnect
          ? <button type="button" className="settings-text-button" onClick={() => setUp(provider, step.connectionIds)}>Retry setup</button>
          : <button type="button" className="settings-text-button" onClick={() => setStep({ kind: "connect", providerId: provider.id, reconnectId: null })}>Try again</button>}
        <button type="button" className="settings-text-button" onClick={() => setStep({ kind: "pick" })}>Choose another provider</button>
      </div>}
    </div>
  );
}
