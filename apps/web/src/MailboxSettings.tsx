import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Account, Mailbox } from "inbox-sdk/types";
import { IconButton } from "./components";
import { InboxViewPreferencesError, type HostConfiguration, type InboxViewPreferences } from "./host";
import type { InboxStore } from "./inbox";

type ViewDraft = Omit<InboxViewPreferences, "revision">;
type MailboxRow = { mailbox: Mailbox; name: string; detail: string; sourceName: string; source?: Account; search: string };

const draftFrom = (value: InboxViewPreferences): ViewDraft => ({
  unifiedMode: value.unifiedMode,
  includedMailboxIds: [...value.includedMailboxIds],
  pinnedMailboxIds: [...value.pinnedMailboxIds],
});
const sameDraft = (left: ViewDraft, right: ViewDraft) =>
  left.unifiedMode === right.unifiedMode &&
  JSON.stringify([...left.includedMailboxIds].sort()) === JSON.stringify([...right.includedMailboxIds].sort()) &&
  JSON.stringify(left.pinnedMailboxIds) === JSON.stringify(right.pinnedMailboxIds);

export default function MailboxSettings({ store, host, onEditStateChange }: {
  store: InboxStore;
  host: HostConfiguration | null;
  onEditStateChange: (state: { dirty: boolean; saving: boolean }) => void;
}) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const saved = snapshot.viewPreferences;
  const [base, setBase] = useState(saved);
  const [draft, setDraft] = useState<ViewDraft | null>(() => saved ? draftFrom(saved) : null);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const mounted = useRef(false);
  const dirty = !!draft && !!base && !sameDraft(draft, base);
  const newer = !!saved && !!base && saved.revision !== base.revision;
  const conflicted = conflict || dirty && newer;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!saved || saving || dirty || conflict || base?.revision === saved.revision) return;
    setBase(saved);
    setDraft(draftFrom(saved));
  }, [saved, saving, dirty, conflict, base?.revision]);

  useEffect(() => {
    onEditStateChange({ dirty, saving });
  }, [dirty, saving, onEditStateChange]);

  const configuration = snapshot.host ?? host;
  const rows = useMemo<MailboxRow[]>(() => {
    const sources = new Map(snapshot.sources.map(source => [source.id, source]));
    return snapshot.mailboxes.filter(mailbox => mailbox.status !== "detached").map(mailbox => {
      const source = sources.get(mailbox.sourceId);
      const provider = configuration?.providers.find(provider => provider.id === source?.providerId)?.name ?? source?.providerId;
      const sourceLabel = source?.name || source?.email;
      const sourceName = [...new Set([provider, sourceLabel].filter(Boolean))].join(" · ") || "Unavailable source";
      const selector = mailbox.selector.kind === "all" ? "All mail from this source" : mailbox.selector.value;
      const name = mailbox.name || selector;
      const detail = selector === name
        ? mailbox.selector.kind === "domain" ? "Domain" : mailbox.selector.kind === "address" ? "Address" : "All mail"
        : selector;
      return { mailbox, name, detail, source, sourceName,
        search: [name, selector, sourceName, source?.email].filter(Boolean).join(" ").toLocaleLowerCase() };
    });
  }, [snapshot.mailboxes, snapshot.sources, configuration]);
  const rowById = useMemo(() => new Map(rows.map(row => [row.mailbox.id, row])), [rows]);
  const visible = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return rows.filter(row => row.search.includes(search));
  }, [rows, query]);
  const groups = useMemo(() => {
    const grouped = new Map<string, { name: string; rows: MailboxRow[] }>();
    for (const row of visible) {
      const group = grouped.get(row.mailbox.sourceId) ?? { name: row.sourceName, rows: [] };
      group.rows.push(row);
      grouped.set(row.mailbox.sourceId, group);
    }
    return [...grouped.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name)).map(([id, group]) => ({
      id, ...group, rows: group.rows.sort((a, b) => a.name.localeCompare(b.name) || a.mailbox.id.localeCompare(b.mailbox.id)),
    }));
  }, [visible]);

  function edit(patch: Partial<ViewDraft>) {
    if (saving) return;
    setDraft(current => current && ({ ...current, ...patch }));
    setError("");
    setNotice("");
  }

  function useSaved() {
    const current = store.getSnapshot().viewPreferences;
    if (!current || saving) return;
    setBase(current);
    setDraft(draftFrom(current));
    setConflict(false);
    setError("");
    setNotice("Saved settings restored.");
  }

  async function checkSaved() {
    if (checking || saving) return;
    setChecking(true);
    setError("");
    try { await store.refresh(true); }
    catch { if (mounted.current) setError("Could not reload mailbox settings. Your edits are still here."); }
    finally { if (mounted.current) setChecking(false); }
  }

  async function save() {
    if (!draft || !base || !dirty || saving || checking || conflicted) return;
    const current = store.getSnapshot().viewPreferences;
    if (!current) { setError("Mailbox settings are unavailable. Your edits are still here."); return; }
    if (current.revision !== base.revision) { setConflict(true); return; }
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await store.setViewPreferences(draft);
      if (!mounted.current) return;
      const next = store.getSnapshot().viewPreferences;
      if (!next) throw new Error("The saved settings could not be reloaded.");
      setBase(next);
      setDraft(draftFrom(next));
      setConflict(false);
      setNotice("Mailbox settings saved.");
    } catch (cause) {
      if (!mounted.current) return;
      if (cause instanceof InboxViewPreferencesError && (cause.status === 412 || cause.code === "HOST_INBOX_PREFERENCES_CONFLICT")) {
        setConflict(true);
      } else {
        setError(`${cause instanceof Error ? cause.message : "Could not save mailbox settings."} Your edits are still here.`);
      }
    } finally { if (mounted.current) setSaving(false); }
  }

  if (!draft || !base) return (
    <div className="mailbox-settings">
      <p className="settings-note" role="status">
        {snapshot.loading || snapshot.refreshing || checking ? "Loading mailbox settings…" : "Mailbox settings could not be loaded."}
      </p>
      {!snapshot.loading && <button type="button" className="settings-text-button" disabled={checking} onClick={() => void checkSaved()}>Retry</button>}
      {error && <p className="settings-error" role="alert">{error}</p>}
    </div>
  );

  const included = new Set(draft.includedMailboxIds);
  const all = draft.unifiedMode === "all";
  const selectedVisible = visible.filter(row => included.has(row.mailbox.id)).length;
  const selectedKnown = rows.filter(row => included.has(row.mailbox.id)).length;
  const unavailableSelections = draft.includedMailboxIds.filter(id => !rowById.has(id)).length;
  const unavailableEdits = new Set([...draft.includedMailboxIds, ...draft.pinnedMailboxIds].filter(id => !rowById.has(id))).size;
  const pinLimit = draft.pinnedMailboxIds.length >= 9;
  const pin = (id: string) => {
    const pinned = draft.pinnedMailboxIds.includes(id);
    if (!pinned && pinLimit) return;
    edit({ pinnedMailboxIds: pinned ? draft.pinnedMailboxIds.filter(value => value !== id) : [...draft.pinnedMailboxIds, id] });
  };
  const movePin = (index: number, direction: -1 | 1) => {
    const next = index + direction;
    if (next < 0 || next >= draft.pinnedMailboxIds.length) return;
    const pins = [...draft.pinnedMailboxIds];
    [pins[index], pins[next]] = [pins[next], pins[index]];
    edit({ pinnedMailboxIds: pins });
  };

  return (
    <div className="mailbox-settings">
      <div className="mailbox-settings-content">
        <fieldset className="mailbox-mode" disabled={saving}>
          <legend>Unified inbox</legend>
          <label className="settings-radio-row">
            <input type="radio" name="unified-mailbox-mode" checked={all} onChange={() => edit({ unifiedMode: "all" })} />
            <span>All connected mailboxes<span className="mailbox-option-note">Includes every added mailbox, including ones you add later.</span></span>
          </label>
          <label className="settings-radio-row">
            <input type="radio" name="unified-mailbox-mode" checked={!all} onChange={() => edit({ unifiedMode: "selected" })} />
            <span>Chosen mailboxes<span className="mailbox-option-note">Only checked mailboxes. Newly added mailboxes stay excluded.</span></span>
          </label>
        </fieldset>

        <section className="mailbox-inclusion" aria-label="Added mailboxes">
          <div className="mailbox-section-heading">
            <h3>Added mailboxes</h3>
            <span className="mailbox-count">{all ? rows.length : selectedKnown} of {rows.length} included</span>
          </div>
          <input type="search" aria-label="Search added mailboxes" placeholder="Search mailboxes or connections" value={query} onChange={event => setQuery(event.target.value)} />
          <div className="mailbox-list-toolbar">
            <span className="mailbox-count" role="status">{visible.length} shown{!all && ` · ${selectedVisible} selected`}</span>
            <div className="mailbox-bulk-actions">
              <button type="button" className="settings-text-button" disabled={all || saving || selectedVisible === visible.length} onClick={() => edit({ includedMailboxIds: [...new Set([...draft.includedMailboxIds, ...visible.map(row => row.mailbox.id)])] })}>
                Select visible ({visible.length})
              </button>
              <button type="button" className="settings-text-button" disabled={all || saving || selectedVisible === 0} onClick={() => {
                const ids = new Set(visible.map(row => row.mailbox.id));
                edit({ includedMailboxIds: draft.includedMailboxIds.filter(id => !ids.has(id)) });
              }}>Clear visible ({selectedVisible})</button>
            </div>
          </div>
          {!all && draft.includedMailboxIds.length === 0 && <p className="mailbox-empty-selection" role="status">No mailboxes selected. The unified inbox will be empty.</p>}
          {!all && unavailableSelections > 0 && <p className="settings-note">{unavailableSelections} selected {unavailableSelections === 1 ? "mailbox is" : "mailboxes are"} unavailable. Reload saved settings to review the current list.</p>}
          <div className="mailbox-settings-list" tabIndex={0} aria-label="Added mailbox list">
            {groups.map(group => (
              <section className="mailbox-source-group" key={group.id} aria-label={group.name}>
                <h4 title={group.name}>{group.name}</h4>
                {group.rows.map(({ mailbox, name, detail, source }) => {
                  const slot = draft.pinnedMailboxIds.indexOf(mailbox.id);
                  const status = source?.status === "reconnect_required" ? "Reconnect required · Cached mail retained"
                    : source?.status === "disconnected" ? "Disconnected · Cached mail retained"
                    : mailbox.status === "paused" ? "Paused · Cached mail retained"
                    : mailbox.receiving !== "ready" ? `Receiving ${mailbox.receiving}` : "";
                  return (
                    <div className="mailbox-settings-row" key={mailbox.id}>
                      <label className="mailbox-inclusion-choice" title={[name, detail, status].filter(Boolean).join(" · ")}>
                        <input type="checkbox" aria-label={`Include ${name} in unified inbox`} checked={all || included.has(mailbox.id)} disabled={all || saving} onChange={event => edit({ includedMailboxIds: event.target.checked ? [...draft.includedMailboxIds, mailbox.id] : draft.includedMailboxIds.filter(id => id !== mailbox.id) })} />
                        <span className="mailbox-row-label"><span>{name}</span><small>{[detail, status].filter(Boolean).join(" · ")}</small></span>
                      </label>
                      <span className="mailbox-shortcut-slot">{slot >= 0 && <kbd>Ctrl+{slot + 1}</kbd>}</span>
                      <button type="button" className="settings-text-button mailbox-pin-toggle" aria-label={`${slot >= 0 ? "Unpin" : "Pin"} ${name}`} title={slot < 0 && pinLimit ? "Unpin a mailbox to free a shortcut" : `${slot >= 0 ? "Unpin" : "Pin"} ${name}`} disabled={saving || slot < 0 && pinLimit} onClick={() => pin(mailbox.id)}>{slot >= 0 ? "Unpin" : "Pin"}</button>
                    </div>
                  );
                })}
              </section>
            ))}
            {visible.length === 0 && <p className="settings-note">{rows.length === 0 ? "No mailboxes added. Choose mailboxes in Add Accounts to add a view." : "No mailboxes match this search."}</p>}
          </div>
        </section>

        <section className="mailbox-pins" aria-label="Pinned mailboxes">
          <div className="mailbox-section-heading"><h3>Pinned mailboxes</h3><span className="mailbox-count">{draft.pinnedMailboxIds.length} of 9</span></div>
          <p className="settings-note">Pinning adds a shortcut, independent of unified inbox inclusion.</p>
          {draft.pinnedMailboxIds.length === 0 ? <p className="settings-note">No pinned mailboxes. Use Pin above to assign Ctrl+1–9.</p> : (
            <ol className="mailbox-pinned-list">
              {draft.pinnedMailboxIds.map((id, index) => {
                const row = rowById.get(id);
                const name = row?.name || "Unavailable mailbox";
                return (
                  <li key={id}>
                    <kbd className="mailbox-shortcut-slot">Ctrl+{index + 1}</kbd>
                    <span className="mailbox-row-label" title={row ? `${name} · ${row.sourceName}` : name}><span>{name}</span><small>{row?.sourceName || "Mailbox is no longer available"}</small></span>
                    <div className="mailbox-pin-actions">
                      <IconButton name="ChevronUp" title={`Move ${name} up`} size={14} disabled={saving || index === 0} onClick={() => movePin(index, -1)} />
                      <IconButton name="ChevronDown" title={`Move ${name} down`} size={14} disabled={saving || index === draft.pinnedMailboxIds.length - 1} onClick={() => movePin(index, 1)} />
                      <IconButton name="Close" title={`Unpin ${name}`} size={14} disabled={saving} onClick={() => pin(id)} />
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          {pinLimit && <p className="settings-note">All 9 shortcuts are assigned. Unpin a mailbox to add another.</p>}
        </section>
      </div>

      {conflicted && <div className="mailbox-save-conflict" role="alert">
        <p>Mailbox settings changed elsewhere. Your edits are still here.</p>
        {newer ? <>
          <p className="settings-note">Use the saved version, or keep your edits and review them before replacing the newer settings.</p>
          {unavailableEdits > 0 && <p className="settings-note">{unavailableEdits} removed {unavailableEdits === 1 ? "mailbox will" : "mailboxes will"} be omitted from your version. Paused and disconnected mailboxes are kept.</p>}
          <div className="mailbox-bulk-actions">
            <button type="button" className="settings-text-button" disabled={saving || checking} onClick={useSaved}>Use saved settings</button>
            <button type="button" className="settings-text-button" disabled={saving || checking} onClick={() => {
              const latest = store.getSnapshot();
              const current = latest.viewPreferences;
              if (!current) return;
              const attached = new Set(latest.mailboxes.filter(mailbox => mailbox.status !== "detached").map(mailbox => mailbox.id));
              setDraft(previous => previous && ({ ...previous,
                includedMailboxIds: previous.includedMailboxIds.filter(id => attached.has(id)),
                pinnedMailboxIds: previous.pinnedMailboxIds.filter(id => attached.has(id)),
              }));
              setBase(current);
              setConflict(false);
              setError("");
              setNotice("Your edits are kept. Save will replace the newer settings.");
            }}>Keep my edits</button>
          </div>
        </> : <button type="button" className="settings-text-button" disabled={checking || saving} onClick={() => void checkSaved()}>{checking ? "Checking…" : "Reload saved settings"}</button>}
      </div>}
      {error && <p className="settings-error" role="alert">{error}</p>}
      <footer className="mailbox-settings-footer">
        <span className="settings-note" role="status">{saving ? "Saving mailbox settings…" : notice || (dirty ? "Unsaved changes" : "")}</span>
        <button type="button" className="settings-text-button" disabled={!dirty || saving || checking} onClick={useSaved}>Cancel</button>
        <button type="button" className="settings-button" disabled={!dirty || saving || checking || conflicted} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button>
      </footer>
    </div>
  );
}
