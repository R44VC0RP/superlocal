import { useEffect, useMemo, useRef, useState } from "react";
import type { InboxClient } from "inbox-sdk/client";
import type { Account, Mailbox, MailboxSyncStatus } from "inbox-sdk/types";
import { Icon } from "./components";
import "./mail-sync-status.css";

type Observation = { scope: string; rows: MailboxSyncStatus[] };
type Props = {
  client: InboxClient;
  mailboxes: readonly Mailbox[];
  sources: readonly Account[];
  enabled: boolean;
  onMailboxes: () => void;
};
/** Newer SDKs report per-row inbox coverage; older ones leave it to the source. */
type SyncRow = MailboxSyncStatus & { coverage?: Account["sync"]["coverage"] };
export type SyncNotice = { row: MailboxSyncStatus; kind: "paused" | "reconnect" | "error" | "importing"; text: string };

const reconnect = new Set(["AUTHENTICATION", "AUTHORIZATION", "CREDENTIALS_REVOKED", "RECONNECT_REQUIRED"]);
const clock = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" });
/** Routine polling cadence while the footer is visible; status reads never start a sync. */
const POLL_MS = 20_000;
const MAX_POLL_MS = 60_000;

/** Only actionable states and a genuine first-time import are worth a line; healthy or idle sync shows nothing. */
export function syncNotice(row: SyncRow, source?: Account): SyncNotice | null {
  if (row.state === "paused") return { row, kind: "paused", text: "Sync paused" };
  if (reconnect.has(row.problemCode ?? "")) return { row, kind: "reconnect", text: "Reconnect to resume syncing" };
  if (row.state === "waiting") {
    const reason = row.problemCode === "RATE_LIMITED" ? "Rate limited" : "Waiting to retry";
    return { row, kind: "error", text: row.retryAt ? `${reason} · retrying after ${clock.format(new Date(row.retryAt))}` : reason };
  }
  if (row.state === "error") {
    if (row.problemCode === "RATE_LIMITED") return { row, kind: "error", text: "Rate limited · waiting to retry" };
    if (row.problemCode === "NETWORK") return { row, kind: "error", text: "Couldn’t reach the mail provider" };
    return { row, kind: "error", text: "Couldn’t sync mail" };
  }
  const coverage = row.coverage ?? source?.sync.coverage;
  if (coverage === "complete") return null;
  const importing = row.state === "syncing" ? row.activeLanes.includes("backfill") : row.lastBatch?.lane === "backfill" && row.lastBatch.hasMore;
  return importing ? { row, kind: "importing", text: "Importing older mail…" } : null;
}

export function syncNotices(rows: readonly SyncRow[], sources: readonly Account[]): SyncNotice[] {
  const order = { reconnect: 0, error: 1, paused: 2, importing: 3 };
  return rows.flatMap(row => { const notice = syncNotice(row, sources.find(source => source.id === row.sourceId)); return notice ? [notice] : []; })
    .sort((a, b) => order[a.kind] - order[b.kind]);
}

/** Status is sampled separately from the mail model: a poll must never refresh mail or start a sync. */
export function MailSyncStatus({ client, mailboxes, sources, enabled, onMailboxes }: Props) {
  const slot = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [observation, setObservation] = useState<Observation | null>(null);
  const scope = useMemo(() => {
    const boxes = mailboxes.filter(box => box.status !== "detached").sort((a, b) => a.id.localeCompare(b.id));
    const sourceIds = new Set(boxes.map(box => box.sourceId));
    // Source problems and coverage changes re-sample immediately; routine sync timestamps do not.
    const generations = sources.filter(source => sourceIds.has(source.id)).map(source => [source.id, source.generation, source.status, source.sync.problem, source.sync.coverage]);
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
    if (!enabled || !visible || !scope.ids.length || scope.ids.length > 1000) return;
    let stopped = false;
    let failures = 0;
    let next: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      request = new AbortController();
      // This deadline applies only to a read of status, never to a sync or a mail operation.
      timeout = setTimeout(() => request?.abort(), 8000);
      let delay = POLL_MS;
      try {
        const rows = await client.mailboxSyncStatus({ mailboxIds: scope.ids }, { signal: request.signal });
        if (stopped) return;
        failures = 0;
        setObservation({ scope: scope.key, rows });
      } catch {
        // A failed status read keeps the last observation; it is not a mail problem to announce.
        if (stopped) return;
        failures++;
        delay = Math.min(MAX_POLL_MS, POLL_MS * 2 ** Math.min(failures, 2));
      } finally {
        clearTimeout(timeout);
        if (!stopped) next = setTimeout(() => { void poll(); }, delay);
      }
    };
    void poll();
    return () => { stopped = true; clearTimeout(next); clearTimeout(timeout); request?.abort(); };
    // The key includes every requested ID/revision and source generation, not routine account sync timestamps.
  }, [client, scope.key, enabled, visible]);

  const current = observation?.scope === scope.key ? observation : null;
  const notices = useMemo(() => current ? syncNotices(current.rows, sources) : [], [current, sources]);
  const show = enabled && scope.ids.length > 0 && notices.length > 0;

  return <div ref={slot} className="mail-sync-slot">
    {show && <section className="mail-sync-status" aria-label="Mail sync status" role="status" aria-live="polite" aria-atomic="false">
      <ul className="mail-sync-list">
        {notices.map(({ row, kind, text }) => {
          const sourceBoxes = scope.boxes.filter(box => box.sourceId === row.sourceId);
          const boxes = kind === "paused" ? sourceBoxes : sourceBoxes.filter(box => box.status === "active");
          const source = sources.find(item => item.id === row.sourceId);
          const mailboxNames = boxes.map(box => box.selector.kind === "all" ? box.name : box.selector.value);
          const label = mailboxNames.slice(0, 2).join(", ") || source?.name || source?.email || "Mail account";
          return <li key={row.sourceId} className="mail-sync-row" data-sync-state={kind}>
            <p>
              <span className="mail-sync-name" title={mailboxNames.join(", ")}>{label}{boxes.length > 2 && <span> +{boxes.length - 2}</span>}</span>
              <span className="mail-sync-text">{text}</span>
            </p>
            {kind === "importing" && <div className={`mail-sync-progress${row.state === "syncing" && visible ? " is-active" : ""}`} role="progressbar" aria-label={`${label}: importing older mail`} aria-valuetext={text}><span /></div>}
          </li>;
        })}
      </ul>
      <button type="button" className="mail-sync-settings" onClick={onMailboxes}>Mailboxes<Icon name="ChevronRight" size={12} /></button>
    </section>}
  </div>;
}
