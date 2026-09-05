import { useEffect, useMemo, useRef, useState } from "react";
import type { InboxClient } from "inbox-sdk/client";
import type { Account, Mailbox, MailboxSyncStatus } from "inbox-sdk/types";
import { Icon } from "./components";
import "./mail-sync-status.css";

type Observation = { scope: string; rows: MailboxSyncStatus[]; error: boolean };
type Props = {
  client: InboxClient;
  mailboxes: readonly Mailbox[];
  sources: readonly Account[];
  enabled: boolean;
  onMailboxes: () => void;
};

const reconnect = new Set(["AUTHENTICATION", "AUTHORIZATION", "CREDENTIALS_REVOKED", "RECONNECT_REQUIRED"]);
const numbers = new Intl.NumberFormat();
const clock = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit", second: "2-digit" });

function statusText(row: MailboxSyncStatus): string {
  if (row.state === "paused") return "Sync paused";
  if (row.state === "syncing") return row.activeLanes.includes("backfill") ? "Syncing older mail…" : "Syncing mail…";
  if (reconnect.has(row.problemCode ?? "")) return "Reconnect to resume syncing";
  if (row.state === "waiting") {
    const reason = row.problemCode === "RATE_LIMITED" ? "Rate limited" : "Waiting to retry";
    return row.retryAt ? `${reason} · Retry after ${clock.format(new Date(row.retryAt))}` : reason;
  }
  if (row.state === "error") {
    if (row.problemCode === "RATE_LIMITED") return "Rate limited · Waiting to retry";
    if (row.problemCode === "NETWORK") return "Couldn’t reach the mail provider";
    return "Couldn’t sync mail";
  }
  return row.lastSyncAt ? "Syncing mail · between batches" : "Preparing mail sync…";
}

/** Status is sampled separately from the mail model: a poll must never refresh mail or start a sync. */
export function MailSyncStatus({ client, mailboxes, sources, enabled, onMailboxes }: Props) {
  const slot = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [checking, setChecking] = useState(true);
  const [observation, setObservation] = useState<Observation | null>(null);
  const scope = useMemo(() => {
    const boxes = mailboxes.filter(box => box.status !== "detached").sort((a, b) => a.id.localeCompare(b.id));
    const sourceIds = new Set(boxes.map(box => box.sourceId));
    const generations = sources.filter(source => sourceIds.has(source.id)).map(source => [source.id, source.generation, source.status]);
    return { ids: boxes.map(box => box.id), key: JSON.stringify([boxes.map(box => [box.id, box.revision]), generations]), boxes };
  }, [mailboxes, sources]);

  useEffect(() => {
    const sidebar = slot.current?.parentElement;
    if (!sidebar) return;
    let intersecting = false;
    const update = () => setVisible(intersecting && document.visibilityState === "visible");
    const observer = new IntersectionObserver(([entry]) => { intersecting = entry.isIntersecting; update(); });
    observer.observe(sidebar);
    document.addEventListener("visibilitychange", update);
    return () => { observer.disconnect(); document.removeEventListener("visibilitychange", update); };
  }, []);

  useEffect(() => {
    setChecking(true);
    if (!enabled || !visible || !scope.ids.length) return;
    if (scope.ids.length > 1000) {
      setChecking(false);
      setObservation({ scope: scope.key, rows: [], error: true });
      return;
    }
    let stopped = false;
    let failures = 0;
    let next: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      request = new AbortController();
      // This deadline applies only to a read of status, never to a sync or a mail operation.
      timeout = setTimeout(() => request?.abort(), 8000);
      let delay = 2000;
      try {
        const rows = await client.mailboxSyncStatus({ mailboxIds: scope.ids }, { signal: request.signal });
        if (stopped) return;
        failures = 0;
        setObservation({ scope: scope.key, rows, error: false });
      } catch {
        if (stopped) return;
        failures++;
        delay = Math.min(30000, 2000 * 2 ** Math.min(failures, 4));
        setObservation(previous => ({ scope: scope.key, rows: previous?.scope === scope.key ? previous.rows : [], error: true }));
      } finally {
        clearTimeout(timeout);
        if (!stopped) {
          setChecking(false);
          next = setTimeout(() => { void poll(); }, delay);
        }
      }
    };
    void poll();
    return () => { stopped = true; clearTimeout(next); clearTimeout(timeout); request?.abort(); };
    // The key includes every requested ID/revision and source generation, not routine account sync timestamps.
  }, [client, scope.key, enabled, visible]);

  const current = observation?.scope === scope.key ? observation : null;
  const rows = useMemo(() => {
    if (!current) return [];
    return current.rows.filter(row => row.state !== "idle" || !row.lastSyncAt || row.lastBatch?.hasMore)
      .sort((a, b) => ({ error: 0, waiting: 1, syncing: 2, paused: 3, idle: 4 })[a.state] - ({ error: 0, waiting: 1, syncing: 2, paused: 3, idle: 4 })[b.state]);
  }, [current]);
  const show = enabled && scope.ids.length > 0 && (current?.error || rows.length > 0);

  return <div ref={slot} className="mail-sync-slot">
    {show && <section className="mail-sync-status" aria-label="Mail sync status" role="status" aria-live="polite" aria-atomic="false">
      {(checking || current?.error) && <p className="mail-sync-unavailable">{checking ? "Checking sync status…" : "Sync status unavailable"}{rows.length > 0 && <span>Last reported state below</span>}</p>}
      <ul className="mail-sync-list">
        {rows.map(row => {
          const sourceBoxes = scope.boxes.filter(box => box.sourceId === row.sourceId);
          const boxes = row.state === "paused" ? sourceBoxes : sourceBoxes.filter(box => box.status === "active");
          const source = sources.find(item => item.id === row.sourceId);
          const mailboxNames = boxes.map(box => box.selector.kind === "all" ? box.name : box.selector.value);
          const label = mailboxNames.slice(0, 2).join(", ") || source?.name || source?.email || "Mail account";
          const names = mailboxNames.join(", ");
          const active = !checking && !current?.error && visible && row.state === "syncing";
          const unfinished = row.state === "syncing" || row.state === "idle" && Boolean(row.lastBatch?.hasMore);
          const showProgress = unfinished && !checking && !current?.error;
          const problem = row.state === "error" || row.state === "waiting";
          return <li key={row.sourceId} className="mail-sync-row" data-sync-state={current?.error ? "unavailable" : row.state}>
            <span className="mail-sync-glyph" aria-hidden="true">
              {problem || current?.error ? <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="10" cy="10" r="7.5" /><path d="M10 5.5v5m0 2v1" /></svg> : row.state === "paused" ? <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M7 4v12M13 4v12" /></svg> : <Icon name={unfinished ? "Refresh" : "Clock"} size={14} />}
            </span>
            <div className="mail-sync-copy">
              <div className="mail-sync-name" title={names}>{label}{boxes.length > 2 && <span> +{boxes.length - 2}</span>}</div>
              <p>{statusText(row)}</p>
              {showProgress && <div className={`mail-sync-progress${active ? " is-active" : ""}`} role="progressbar" aria-label={`${label}: mail sync`} aria-valuetext={statusText(row)}><span /></div>}
              {row.lastBatch && <p className="mail-sync-count">Last batch: {numbers.format(row.lastBatch.processed)} {row.lastBatch.processed === 1 ? "record" : "records"} saved</p>}
            </div>
          </li>;
        })}
      </ul>
      <button type="button" className="mail-sync-settings" onClick={onMailboxes}>Mailboxes<Icon name="ChevronRight" size={12} /></button>
    </section>}
  </div>;
}
