import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import type { Mailbox, MailboxCandidate, MailboxSelector } from "inbox-sdk/types";
import type { HostConfiguration, HostProvider } from "./host";
import { connectHostProvider } from "./host";
import type { InboxStore } from "./inbox";

type Choice = { candidate: MailboxCandidate; key: string; added: boolean; error?: string };
type ChoiceList = { providerId: string; items: Choice[]; failedConnections: number };
type Busy = { providerId: string; action: "connect" | "discover" | "add" };
type AddProgress = { phase: "checking" | "creating" | "syncing" | "refreshing"; total: number; added: number; sources: number; finishedSources: number };
type SyncIssue = { sourceId: string; message: string };

// Compare selector values, not object property order. Do not infer receiving scopes from names or senders.
const mailboxKey = (sourceId: string, selector: MailboxSelector) => JSON.stringify([sourceId, selector.kind, selector.kind === "all" ? null : selector.value]);
const eligible = (candidate: MailboxCandidate) => candidate.canReceive && candidate.canFilter;
const problem = (cause: unknown, fallback: string) => cause instanceof Error ? cause.message : fallback;

export default function ProviderConnections({ host, store }: { host: HostConfiguration | null; store: InboxStore }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const configuration = snapshot.host ?? host;
  const [busy, setBusy] = useState<Busy | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [choices, setChoices] = useState<ChoiceList | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const [progress, setProgress] = useState<AddProgress | null>(null);
  const [syncIssues, setSyncIssues] = useState<SyncIssue[]>([]);
  const [stopping, setStopping] = useState(false);
  const [recheckRequired, setRecheckRequired] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const recheckController = useRef<AbortController | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; controller.current?.abort(); recheckController.current?.abort(); };
  }, []);

  const sourceNames = useMemo(() => new Map(snapshot.sources.map(source => [source.id, source.name || source.email])), [snapshot.sources]);
  const visible = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return (choices?.items ?? []).filter(({ candidate }) => [candidate.name,
      candidate.selector.kind === "all" ? "All mail" : candidate.selector.value,
      sourceNames.get(candidate.sourceId), ...candidate.identities,
    ].filter(Boolean).join(" ").toLocaleLowerCase().includes(search));
  }, [choices, query, sourceNames]);
  const visibleGroups = useMemo(() => {
    const groups = new Map<string, Choice[]>();
    for (const item of visible) {
      const group = groups.get(item.candidate.sourceId) ?? [];
      group.push(item);
      groups.set(item.candidate.sourceId, group);
    }
    return [...groups.entries()].map(([sourceId, items]) => ({ sourceId, items }));
  }, [visible]);

  function begin(providerId: string, action: Busy["action"]) {
    if (controller.current || !mounted.current) return null;
    const operation = new AbortController();
    controller.current = operation;
    setBusy({ providerId, action });
    setError("");
    setNotice("");
    setProgress(null);
    setSyncIssues([]);
    setStopping(false);
    return operation;
  }

  function finish() {
    if (!mounted.current) return;
    controller.current = null;
    setBusy(null);
    setStopping(false);
  }

  function markAdded(keys: Set<string>) {
    if (!mounted.current) return;
    setChoices(current => current && ({ ...current, items: current.items.map(item => keys.has(item.key) ? { ...item, added: true, error: undefined } : item) }));
    setSelected(previous => new Set([...previous].filter(key => !keys.has(key))));
  }

  async function discover(providerId: string, connectionIds: string[], signal: AbortSignal) {
    const sameProvider = choices?.providerId === providerId;
    if (!sameProvider) { setChoices(null); setSelected(new Set()); setQuery(""); }
    const mailboxes = await store.client.mailboxes({ signal });
    const added = new Set(mailboxes.filter(box => box.status !== "detached").map(box => mailboxKey(box.sourceId, box.selector)));
    const found = new Map<string, Choice>();
    const connections = [...new Set(connectionIds)];
    let failedConnections = 0;
    // Connections are few; their candidate lists may be large. Keep discovery requests bounded too.
    for (const id of connections) {
      if (signal.aborted) return;
      try {
        for (const candidate of await store.client.mailboxCandidates(id, { signal })) {
          const key = mailboxKey(candidate.sourceId, candidate.selector);
          if (!found.has(key)) found.set(key, { candidate, key, added: added.has(key) });
        }
      } catch (cause) {
        if (signal.aborted) return;
        failedConnections++;
        if (connections.length === 1) throw cause;
      }
    }
    if (!mounted.current || signal.aborted) return;
    if (failedConnections && sameProvider) {
      markAdded(added);
      setRecheckRequired(true);
      setError(`Could not refresh ${failedConnections} of ${connections.length} connections. Your selection is retained. Recheck mailboxes before adding.`);
      return;
    }
    const items = [...found.values()];
    setChoices({ providerId, items, failedConnections });
    setSelected(previous => new Set(sameProvider ? [...previous].filter(key => {
      const item = found.get(key);
      return item && !item.added && eligible(item.candidate);
    }) : []));
    setRecheckRequired(false);
    if (failedConnections) setError(`Could not discover mailboxes from ${failedConnections} of ${connections.length} connections. Choose mailboxes again to retry those connections.`);
  }

  async function connect(event: FormEvent<HTMLFormElement>, provider: HostProvider) {
    event.preventDefault();
    const operation = begin(provider.id, "connect");
    if (!operation) return;
    const signal = operation.signal;
    const form = event.currentTarget;
    const credentials = Object.fromEntries([...new FormData(form)].filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    try {
      const result = await connectHostProvider(provider.id, credentials, signal);
      form.reset();
      if (result.authorizeUrl) {
        const url = new URL(result.authorizeUrl, location.origin);
        if (url.origin !== location.origin) throw new Error("The host returned an unexpected authorization address.");
        location.assign(url.href);
        return;
      }
      if (!result.connectionId) throw new Error("The host did not return a connection.");
      await store.refresh(true);
      if (signal.aborted) return;
      setNotice(`${provider.name} connected. Choose which mailboxes to add.`);
      await discover(provider.id, [result.connectionId], signal);
    } catch (cause) {
      if (mounted.current && !signal.aborted) setError(problem(cause, "Could not connect this account."));
    } finally { finish(); }
  }

  async function showMailboxes(provider: HostProvider) {
    const operation = begin(provider.id, "discover");
    if (!operation) return;
    try { await discover(provider.id, provider.connectionIds, operation.signal); }
    catch (cause) {
      if (mounted.current && !operation.signal.aborted) {
        if (choices?.providerId === provider.id) setRecheckRequired(true);
        setError(problem(cause, "Could not load mailboxes."));
      }
    }
    finally { finish(); }
  }

  async function addMailboxes() {
    if (!choices || recheckRequired) return;
    const requested = choices.items.filter(item => !item.added && eligible(item.candidate) && selected.has(item.key));
    if (!requested.length) return;
    const operation = begin(choices.providerId, "add");
    if (!operation) return;
    const signal = operation.signal;
    const requestedKeys = new Set(requested.map(item => item.key));
    const confirmed = new Set<string>();
    const attempted = new Set<string>();
    const before = new Set<string>();
    const backfill = new Map<string, string>();
    const failures: SyncIssue[] = [];
    const work: AddProgress = { phase: "checking", total: requested.length, added: 0, sources: 0, finishedSources: 0 };
    const report = () => { if (mounted.current) setProgress({ ...work }); };
    const accept = (mailboxes: Mailbox[]) => {
      const keys = new Set<string>();
      for (const box of mailboxes) {
        if (box.status === "detached") continue;
        const key = mailboxKey(box.sourceId, box.selector);
        keys.add(key);
        if (!requestedKeys.has(key)) continue;
        confirmed.add(key);
        if (attempted.has(key) && !before.has(key)) backfill.set(box.sourceId, box.id);
      }
      markAdded(keys);
      work.added = confirmed.size;
      report();
    };
    let creationFailed = false;
    let refreshed = false;
    let initialCheckPassed = false;
    let successfulSyncs = 0;
    let needsRecheck = false;
    const errors: string[] = [];
    report();
    try {
      const existing = await store.client.mailboxes({ signal });
      initialCheckPassed = true;
      for (const box of existing) if (box.status !== "detached") before.add(mailboxKey(box.sourceId, box.selector));
      accept(existing);
      work.phase = "creating";
      report();
      for (const choice of requested) {
        if (signal.aborted) break;
        if (confirmed.has(choice.key)) continue;
        attempted.add(choice.key);
        const candidate = choice.candidate;
        try {
          // One in-flight create at a time; only explicit, eligible selections reach this call.
          const mailbox = await store.client.createMailbox({
            sourceId: candidate.sourceId, name: candidate.name, selector: candidate.selector,
            defaultSender: candidate.canSend ? candidate.identities[0] ?? null : null,
          }, { signal });
          accept([mailbox]);
        } catch (cause) {
          if (!signal.aborted) {
            creationFailed = true;
            const message = problem(cause, "Could not create this mailbox.");
            if (mounted.current) setChoices(current => current && ({ ...current, items: current.items.map(item => item.key === choice.key ? { ...item, error: message } : item) }));
          }
          // A failed request may already have committed. Stop scheduling creates and reconcile before retrying.
          break;
        }
      }
      if (!mounted.current) return;
      if (creationFailed || signal.aborted) {
        work.phase = "checking";
        report();
        const recheck = new AbortController();
        recheckController.current = recheck;
        try { accept(await store.client.mailboxes({ signal: recheck.signal })); }
        catch { needsRecheck = true; errors.push("Could not confirm the last request. Recheck mailboxes before retrying."); }
        finally { recheckController.current = null; }
      }
      // syncMailbox synchronizes a source, not a single domain. Create the views first, then sync each source once.
      work.sources = backfill.size;
      if (!signal.aborted && mounted.current) {
        work.phase = "syncing";
        report();
        for (const [sourceId, mailboxId] of backfill) {
          if (signal.aborted) break;
          try {
            await store.client.syncMailbox(mailboxId, { lane: "backfill", limit: 50 }, { signal });
            successfulSyncs++;
          } catch (cause) {
            if (signal.aborted) break;
            failures.push({ sourceId, message: problem(cause, "Initial sync failed.") });
            if (mounted.current) setSyncIssues([...failures]);
          }
          work.finishedSources++;
          report();
        }
      }
    } catch (cause) {
      if (!signal.aborted) errors.push(initialCheckPassed ? problem(cause, "Could not finish mailbox setup.") : "Could not check existing mailboxes. No new mailbox requests were started.");
    } finally {
      if (mounted.current) {
        if (attempted.size || confirmed.size) {
          work.phase = "refreshing";
          report();
          try { await store.refresh(true); refreshed = true; }
          catch { errors.push("The inbox could not refresh. Added mailboxes are retained; refresh the inbox to reload them."); }
          if (refreshed) accept(store.getSnapshot().mailboxes);
        }
        if (mounted.current) {
          const cancelled = signal.aborted;
          setRecheckRequired(needsRecheck || cancelled && attempted.size > 0);
          if (creationFailed && confirmed.size < requested.length) errors.unshift("Adding stopped after a request failed. The unadded mailboxes are still selected; retry when ready.");
          setError(errors.join(" "));
          const summary = `${confirmed.size} of ${requested.length} selected mailboxes are added.`;
          setNotice(cancelled
            ? `Stopped. ${summary} ${attempted.size ? "Added mailboxes remain; an in-flight request may still finish. Recheck mailboxes before retrying." : "No new mailbox requests were started."}`
            : initialCheckPassed ? `${summary}${backfill.size ? ` Initial sync completed for ${successfulSyncs} of ${backfill.size} sources (up to 50 messages per source).` : ""}` : "");
          finish();
        }
      }
    }
  }

  if (!configuration) return <p className="settings-note" role="status">Loading provider setup…</p>;
  const providers = configuration.providers.filter(provider => provider.enabled);
  const available = (choices?.items ?? []).filter(item => !item.added && eligible(item.candidate));
  const visibleAvailable = visible.filter(item => !item.added && eligible(item.candidate));
  const selectedVisible = visibleAvailable.filter(item => selected.has(item.key)).length;
  const addedCount = choices?.items.filter(item => item.added).length ?? 0;
  const selectedCount = available.filter(item => selected.has(item.key)).length;
  const progressLabel = !progress ? "" : progress.phase === "checking" ? "Checking selected mailboxes…"
    : progress.phase === "creating" ? `${progress.added} of ${progress.total} selected mailboxes added`
    : progress.phase === "syncing" ? `Initial sync: ${progress.finishedSources} of ${progress.sources} sources finished`
    : "Refreshing the inbox…";
  return (
    <div className="provider-connections">
      <p className="settings-note">
        {configuration.mode === "mock"
          ? "Explore the fictional sources below. To connect real accounts, enable their providers in the local host configuration."
          : configuration.allowProviderWrites ? "A connection supplies credentials. Choose mailboxes to add the domains or addresses you want in the inbox." : "Real accounts are read-only. Sending and provider changes are disabled."}
      </p>
      {providers.length === 0 && <p className="settings-note">No providers are enabled in the local host configuration.</p>}
      {providers.map(provider => (
        <section className="provider-connection" key={provider.id} aria-label={`${provider.name} connection`}>
          <div className="provider-connection-heading">
            <h3>{provider.name}</h3>
            <span className="mailbox-count">{provider.connectionIds.length ? `${provider.connectionIds.length} ${provider.connectionIds.length === 1 ? "connection" : "connections"}` : provider.ready ? "Not connected" : "Setup required"}</span>
          </div>
          {!provider.ready ? <p className="settings-note">{provider.setupMessage || "Configure this provider in your local host before connecting."}</p> : provider.connection !== "none" && (
            <form onSubmit={event => void connect(event, provider)}>
              {(provider.fields ?? []).map(field => (
                <label className="settings-field" key={field.name}>
                  <span>{field.label}</span>
                  <input name={field.name} type={field.type === "password" ? "password" : "text"} required={field.required}
                    autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={busy !== null} />
                </label>
              ))}
              <button className="settings-button" type="submit" disabled={busy !== null}>
                {busy?.providerId === provider.id && busy.action === "connect" ? "Connecting…" : provider.actionLabel || `Connect ${provider.name}`}
              </button>
            </form>
          )}
          {provider.ready && provider.connectionIds.length > 0 && (
            <button className="settings-text-button" type="button" disabled={busy !== null} onClick={() => void showMailboxes(provider)}>
              {busy?.providerId === provider.id && busy.action === "discover" ? "Finding mailboxes…" : choices?.providerId === provider.id && recheckRequired ? "Recheck mailboxes" : "Choose mailboxes"}
            </button>
          )}
          {choices?.providerId === provider.id && (
            <div className="provider-mailboxes">
              <h4>Choose mailboxes</h4>
              <input type="search" aria-label={`Search ${provider.name} mailboxes`} placeholder="Search domains, addresses or sources" value={query} onChange={event => setQuery(event.target.value)} />
              <div className="provider-mailbox-counts" role="status">
                <span>{selectedCount} selected</span><span>{available.length} available</span><span>{addedCount} added</span>
              </div>
              <div className="mailbox-list-toolbar">
                <span className="mailbox-count">{visible.length} shown</span>
                <div className="mailbox-bulk-actions">
                  <button className="settings-text-button" type="button" disabled={busy !== null || visibleAvailable.length === selectedVisible} onClick={() => setSelected(previous => new Set([...previous, ...visibleAvailable.map(item => item.key)]))}>Select visible ({visibleAvailable.length})</button>
                  <button className="settings-text-button" type="button" disabled={busy !== null || !selectedVisible} onClick={() => {
                    const keys = new Set(visibleAvailable.map(item => item.key));
                    setSelected(previous => new Set([...previous].filter(key => !keys.has(key))));
                  }}>Clear visible ({selectedVisible})</button>
                </div>
              </div>
              <div className="mailbox-bulk-actions provider-all-actions">
                <button className="settings-text-button" type="button" disabled={busy !== null || selectedCount === available.length} onClick={() => setSelected(new Set(available.map(item => item.key)))}>Select all available ({available.length})</button>
                <button className="settings-text-button" type="button" disabled={busy !== null || !selectedCount} onClick={() => setSelected(new Set())}>Clear all selected ({selectedCount})</button>
              </div>
              <div className="provider-mailbox-list" tabIndex={0} aria-label={`${provider.name} mailbox candidates`}>
                {visibleGroups.map(group => (
                  <section className="mailbox-source-group" key={group.sourceId} aria-label={sourceNames.get(group.sourceId) || "Connected source"}>
                    {sourceNames.get(group.sourceId) && <h5 title={sourceNames.get(group.sourceId)}>{sourceNames.get(group.sourceId)}</h5>}
                    {group.items.map(({ candidate, key, added, error }) => {
                      const available = eligible(candidate);
                      const scope = candidate.selector.kind === "all" ? "All mail" : candidate.selector.value;
                      const detail = error ? error : !available && !added ? candidate.unavailableReason || (candidate.canReceive ? "This connection cannot verify the receiving scope." : "Receiving is not available for this mailbox.")
                        : candidate.name !== scope ? scope : candidate.selector.kind === "domain" ? "Domain" : candidate.selector.kind === "address" ? "Address" : "All mail";
                      return <label className="provider-mailbox" key={key} title={`${candidate.name} · ${detail}${added ? " · Added" : ""}`}>
                        <input type="checkbox" aria-label={candidate.name} checked={added || selected.has(key)} disabled={added || !available || busy !== null} onChange={event => setSelected(previous => {
                          const next = new Set(previous);
                          if (event.target.checked) next.add(key); else next.delete(key);
                          return next;
                        })} />
                        <span className="mailbox-row-label"><span>{candidate.name}</span><small className={error ? "provider-choice-error" : ""}>{detail}</small></span>
                        <span className="provider-mailbox-status">{added ? "Added" : !available ? "Unavailable" : ""}</span>
                      </label>;
                    })}
                  </section>
                ))}
                {visible.length === 0 && <p className="settings-note">{choices.items.length ? "No mailboxes match this search." : choices.failedConnections ? "No candidates loaded. Retry discovery to check the unavailable connections." : "No mailboxes are available for this connection."}</p>}
              </div>
              <div className="provider-mailbox-actions">
                <button className="settings-button" type="button" disabled={!selectedCount || busy !== null || recheckRequired} onClick={() => void addMailboxes()}>Add selected ({selectedCount})</button>
                {busy?.providerId === provider.id && busy.action === "add" && progress?.phase !== "refreshing" && <button className="settings-text-button" type="button" disabled={stopping} onClick={() => { setStopping(true); controller.current?.abort(); recheckController.current?.abort(); }}>{stopping ? "Stopping…" : "Stop"}</button>}
              </div>
              {busy?.providerId === provider.id && busy.action === "add" && progress && <div className="provider-add-progress">
                <p role="status">{progressLabel}</p>
                <progress aria-label={progressLabel} max={progress.phase === "syncing" ? Math.max(1, progress.sources) : progress.total} value={progress.phase === "checking" || progress.phase === "refreshing" ? undefined : progress.phase === "syncing" ? progress.finishedSources : progress.added} />
              </div>}
            </div>
          )}
        </section>
      ))}
      {syncIssues.length > 0 && <div className="provider-sync-issues" role="alert">
        <p>Mailboxes were added, but initial sync failed for {syncIssues.length} {syncIssues.length === 1 ? "source" : "sources"}. Sync again from the inbox when the connection is available.</p>
        <ul>{syncIssues.map(issue => <li key={issue.sourceId}><span title={sourceNames.get(issue.sourceId)}>{sourceNames.get(issue.sourceId) || "Connected source"}</span><span>{issue.message}</span></li>)}</ul>
      </div>}
      {error && <p className="provider-connection-error" role="alert">{error}</p>}
      {notice && <p className="settings-note" role="status">{notice}</p>}
    </div>
  );
}
