import { useEffect, useRef, useState, type FormEvent } from "react";
import type { MailboxCandidate } from "inbox-sdk/types";
import type { HostConfiguration, HostProvider } from "./host";
import { connectHostProvider } from "./host";
import type { InboxStore } from "./inbox";

type Choice = { candidate: MailboxCandidate; key: string; added: boolean };

export default function ProviderConnections({ host, store }: { host: HostConfiguration | null; store: InboxStore }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [choices, setChoices] = useState<{ providerId: string; items: Choice[] } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    controller.current = new AbortController();
    return () => controller.current?.abort();
  }, []);

  async function discover(providerId: string, connectionIds: string[], signal: AbortSignal) {
    const [groups, mailboxes] = await Promise.all([
      Promise.all(connectionIds.map(id => store.client.mailboxCandidates(id, { signal }))),
      store.client.mailboxes({ signal }),
    ]);
    if (signal.aborted) return;
    const items = groups.flat().map(candidate => ({
      candidate,
      key: JSON.stringify([candidate.sourceId, candidate.selector]),
      added: mailboxes.some(box => box.status !== "detached" && box.sourceId === candidate.sourceId && JSON.stringify(box.selector) === JSON.stringify(candidate.selector)),
    }));
    setSelected([]);
    setChoices({ providerId, items: [...new Map(items.map(item => [item.key, item])).values()] });
  }

  async function connect(event: FormEvent<HTMLFormElement>, provider: HostProvider) {
    event.preventDefault();
    const signal = controller.current?.signal;
    if (!signal || busy) return;
    const form = event.currentTarget;
    const credentials = Object.fromEntries([...new FormData(form)].filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    setBusy(provider.id); setError(""); setNotice(""); setChoices(null);
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
      await discover(provider.id, [result.connectionId], signal);
      if (!signal.aborted) setNotice(`${provider.name} connected.`);
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : "Could not connect this account.");
    } finally { if (!signal.aborted) setBusy(null); }
  }

  async function showMailboxes(provider: HostProvider) {
    const signal = controller.current?.signal;
    if (!signal || busy) return;
    setBusy(provider.id); setError(""); setNotice("");
    try { await discover(provider.id, provider.connectionIds, signal); }
    catch (cause) { if (!signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load mailboxes."); }
    finally { if (!signal.aborted) setBusy(null); }
  }

  async function addMailboxes() {
    const signal = controller.current?.signal;
    if (!signal || busy || !choices) return;
    setBusy(choices.providerId); setError(""); setNotice("");
    const added: Choice[] = [];
    try {
      for (const choice of choices.items.filter(item => !item.added && selected.includes(item.key))) {
        const candidate = choice.candidate;
        const mailbox = await store.client.createMailbox({
          sourceId: candidate.sourceId, name: candidate.name, selector: candidate.selector,
          defaultSender: candidate.canSend ? candidate.identities[0] ?? null : null,
        }, { signal });
        added.push(choice);
        await store.client.syncMailbox(mailbox.id, { lane: "backfill", limit: 50 }, { signal });
      }
      if (!signal.aborted) setNotice(`${added.length === 1 ? "Mailbox" : "Mailboxes"} added.`);
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : "Could not add the selected mailboxes.");
    } finally {
      if (!signal.aborted) {
        setChoices(current => current && ({ ...current, items: current.items.map(item => added.some(value => value.key === item.key) ? { ...item, added: true } : item) }));
        setSelected([]);
        if (added.length) {
          try { await store.refresh(true); }
          catch { if (!signal.aborted) setError("Mailboxes were added, but the inbox could not refresh. Try refreshing the page."); }
        }
        if (!signal.aborted) setBusy(null);
      }
    }
  }

  if (!host) return <p className="settings-note" role="status">Loading provider setup…</p>;
  const providers = host.providers.filter(provider => provider.enabled);
  return (
    <div className="provider-connections">
      <p className="settings-note">
        {host.mode === "mock"
          ? "Mock data is active. To connect your accounts, switch the local host configuration to real mode and enable your providers."
          : host.allowProviderWrites ? "Connect an account using an enabled provider." : "Real accounts are read-only. Sending and provider changes are disabled."}
      </p>
      {providers.length === 0 && <p className="settings-note">No providers are enabled in the local host configuration.</p>}
      {providers.map(provider => (
        <section className="provider-connection" key={provider.id} aria-label={`${provider.name} connection`}>
          <div className="provider-connection-heading">
            <h3>{provider.name}</h3>
            <span>{provider.connectionIds.length ? `${provider.connectionIds.length} ${provider.connectionIds.length === 1 ? "connection" : "connections"}` : provider.ready ? "Not connected" : "Setup required"}</span>
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
                {busy === provider.id ? "Connecting…" : provider.actionLabel || `Connect ${provider.name}`}
              </button>
            </form>
          )}
          {provider.ready && provider.connection !== "none" && provider.connectionIds.length > 0 && (
            <button className="settings-text-button" type="button" disabled={busy !== null} onClick={() => void showMailboxes(provider)}>Choose mailboxes</button>
          )}
          {choices?.providerId === provider.id && (
            <div className="provider-mailboxes">
              <h4>Choose mailboxes</h4>
              <div className="provider-mailbox-list">
                {choices.items.map(({ candidate, key, added }) => {
                  const available = candidate.canReceive && (candidate.selector.kind === "all" || candidate.canFilter);
                  return <label className="provider-mailbox" key={key}>
                    <input type="checkbox" checked={added || selected.includes(key)} disabled={added || !available || busy !== null}
                      onChange={event => setSelected(previous => event.target.checked ? [...previous, key] : previous.filter(value => value !== key))} />
                    <span><span>{candidate.name}</span>{(added || !available) && <small>{added ? "Added" : candidate.unavailableReason || "Receiving is not available for this mailbox."}</small>}</span>
                  </label>;
                })}
                {choices.items.length === 0 && <p className="settings-note">No mailboxes are available for this connection.</p>}
              </div>
              {choices.items.some(choice => !choice.added) && <button className="settings-button" type="button" disabled={!selected.length || busy !== null} onClick={() => void addMailboxes()}>{busy === provider.id ? "Adding mailboxes…" : "Add selected mailboxes"}</button>}
            </div>
          )}
        </section>
      ))}
      {error && <p className="provider-connection-error" role="alert">{error}</p>}
      {notice && <p className="settings-note" role="status">{notice}</p>}
    </div>
  );
}
