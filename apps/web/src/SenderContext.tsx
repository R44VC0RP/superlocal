import { useEffect, useMemo, useState } from "react";
import type { Mail } from "./data";
import { Icon } from "./components";
import {
  readSenderDomain, senderActivity, senderHostname, senderThreadKey,
  type SenderContact, type SenderDomainInfo, type SenderHistoryMessage,
} from "./sender-context";
import "./sender-context.css";

const date = (time: number) => new Date(time).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
const number = (value: number) => value.toLocaleString();

function DomainMark({ src }: { src: string | null }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  return <span className="sender-domain-mark" aria-hidden="true">
    {(!src || !loaded || failed) && <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.2">
      <circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18M5 6.5c4 2 10 2 14 0M5 17.5c4-2 10-2 14 0" />
    </svg>}
    {src && !failed && <img src={src} alt="" width="40" height="40" referrerPolicy="no-referrer" decoding="async"
      className={loaded ? "is-loaded" : ""} onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />}
  </span>;
}

export default function SenderContext({ contact, history, mailboxIds, mail, currentThreadId, remoteImages, showLogos, canCompose, onCompose, onOpen, onImageSettings }: {
  contact: SenderContact;
  history: readonly SenderHistoryMessage[];
  mailboxIds: readonly string[];
  mail: readonly Mail[];
  currentThreadId: string;
  remoteImages: boolean;
  showLogos: boolean;
  canCompose: boolean;
  onCompose: () => void;
  onOpen: (mail: Mail) => void;
  onImageSettings: () => void;
}) {
  const hostname = senderHostname(contact.email);
  const [lookup, setLookup] = useState<{ key: string; info: SenderDomainInfo | null; failed: boolean } | null>(null);
  const [wholeDomain, setWholeDomain] = useState(false);
  const lookupKey = `${hostname}:${remoteImages}:${showLogos}`;
  const info = lookup?.key === lookupKey ? lookup.info : null;
  const failed = lookup?.key === lookupKey && lookup.failed;
  useEffect(() => {
    if (!hostname) return;
    const controller = new AbortController();
    void readSenderDomain(hostname, AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)])).then(info => {
      if (!controller.signal.aborted) setLookup({ key: lookupKey, info, failed: false });
    }).catch(() => {
      if (!controller.signal.aborted) setLookup({ key: lookupKey, info: null, failed: true });
    });
    return () => controller.abort();
  }, [hostname, lookupKey]);
  const root = info?.rootDomain ?? null;
  const grouped = wholeDomain && info?.kind === "domain" && root ? root : null;
  const activity = useMemo(() => senderActivity(history, contact.email, mailboxIds, grouped), [history, contact.email, mailboxIds, grouped]);
  const conversations = useMemo(() => {
    const byThread = new Map(mail.filter(item => !item.operationId && item.sourceId && item.sdkThreadId)
      .map(item => [senderThreadKey(item.sourceId!, item.sdkThreadId!), item]));
    return activity.recentThreadKeys.flatMap(key => { const item = byThread.get(key); return item ? [item] : []; }).slice(0, 5);
  }, [mail, activity]);
  const icon = remoteImages && showLogos && info?.imagePolicy === "allowed" ? info.iconUrl : null;
  const peak = Math.max(1, ...activity.weeks.map(week => week.received + week.sent));
  const levelName = activity.level === 0 ? "No history" : activity.level === 1 ? "One-way mail" : activity.level === 2 ? "In touch"
    : activity.level === 3 ? "Regular contact" : activity.level === 4 ? "Frequent contact" : "Established contact";

  return <section className="sender-context" aria-label="Sender context" data-sender-domain={root ?? ""}>
    <header className="sender-heading">
      <DomainMark key={`${lookupKey}:${icon}`} src={icon} />
      <div>
        <h2 dir="auto">{contact.name || contact.email}</h2>
        {info?.websiteUrl ? <a className="sender-root-link" href={info.websiteUrl} target="_blank" rel="noopener noreferrer" title={`Open ${root}`}>
          <span>{root}</span><Icon name="PopOut" size={12} />
        </a> : hostname && <span className="sender-hostname">{hostname}</span>}
      </div>
    </header>
    <div className="sender-address" dir="auto"><span>{contact.role === "recipient" ? "To" : "From"}</span> {contact.email}</div>
    <button type="button" className="sender-compose" disabled={!canCompose} onClick={onCompose}><Icon name="Envelope" />Compose email</button>

    {hostname && <details className="sender-domain-details">
      <summary>Domain details<Icon name="ChevronDown" size={12} /></summary>
      <dl>
        <div><dt>Address domain</dt><dd>{hostname}</dd></div>
        {root && <div><dt>Root domain</dt><dd>{root}</dd></div>}
        {info?.kind === "mail-provider" && <div><dt>Domain type</dt><dd>Email service</dd></div>}
      </dl>
      {info?.registrationUrl && <a className="sender-domain-lookup" href={info.registrationUrl} target="_blank" rel="noopener noreferrer">Domain registration<Icon name="PopOut" size={12} /></a>}
      <p>{failed ? "Domain information is unavailable right now. Local history still works." : info?.imagePolicy === "offline" ? "Offline mock: no external logo requests."
        : !remoteImages || !showLogos ? "Domain logos are hidden in image settings."
        : root ? `Logo lookup sends only ${root} to Google’s favicon service, never the email address.` : "No public root domain is available for this address."}</p>
      {root && <p>{info?.kind === "mail-provider" ? "An email-service domain is not this person’s organization. " : ""}Domain branding does not verify the sender.</p>}
      <button type="button" className="sender-settings-link" onClick={onImageSettings}>Image settings</button>
    </details>}

    <section className="sender-exchanges" aria-label="Local exchange history">
      <h3>Your exchanges</h3>
      {info?.kind === "domain" && root && <div className="sender-history-scope" role="group" aria-label="Exchange scope">
        <button type="button" aria-pressed={!wholeDomain} onClick={() => setWholeDomain(false)}>This address</button>
        <button type="button" aria-pressed={wholeDomain} onClick={() => setWholeDomain(true)} title={`Include addresses at ${root} and its subdomains`}>Whole domain</button>
      </div>}
      <details className="sender-level-details">
        <summary>
          <span className="sender-level-scale" aria-hidden="true">{[1, 2, 3, 4, 5].map(value => <i key={value} className={value <= activity.level ? "is-filled" : ""} />)}</span>
          <span>Level {activity.level}</span><span className="sender-level-name">{levelName}</span><Icon name="ChevronDown" size={12} />
        </summary>
        <p>Levels count two-way conversations: level 1 is one-way mail; level 2 is 1–2 conversations; level 3 is 3–9; level 4 is 10–24; level 5 is 25 or more.</p>
        <p>Sent-folder mail and confirmed sends to {grouped ? "addresses at this domain" : "this address"} (To or Cc) count. Opens, drafts, Spam and Trash do not. This measures exchange history, not trust or importance.</p>
      </details>
      <dl className="sender-counts">
        <div><dt>Received</dt><dd data-sender-count="received">{number(activity.received)}</dd></div>
        <div><dt>Sent</dt><dd data-sender-count="sent">{number(activity.sent)}</dd></div>
      </dl>
      <p className="sender-two-way">{number(activity.twoWay)} two-way {activity.twoWay === 1 ? "conversation" : "conversations"}</p>
      <div className="sender-activity-chart" role="img" aria-label={`Last 12 weeks: ${activity.weeks.reduce((sum, week) => sum + week.received, 0)} received and ${activity.weeks.reduce((sum, week) => sum + week.sent, 0)} sent.`}>
        {activity.weeks.map(week => <span key={week.start} className="sender-week" title={`${date(week.start)} – ${date(week.start + 7 * 86_400_000 - 1)}: ${number(week.received)} received, ${number(week.sent)} sent`}>
          <i className="sender-week-sent" style={{ height: `${week.sent / peak * 100}%` }} /><i className="sender-week-received" style={{ height: `${week.received / peak * 100}%` }} />
        </span>)}
      </div>
      <div className="sender-chart-caption"><span>Last 12 weeks</span><span><i />Sent</span></div>
    </section>

    <section className="sender-conversations" aria-label="Recent conversations with this contact">
      <h3>Recent conversations</h3>
      {conversations.length ? conversations.map(item => <button type="button" key={item.id} className="sender-conversation"
        title={item.subject || "(No subject)"} aria-current={item.id === currentThreadId ? "true" : undefined} onClick={() => onOpen(item)}>
        <span dir="auto">{item.subject || "(No subject)"}</span><time>{item.date}</time>
      </button>) : <p>No conversations in this view.</p>}
    </section>
  </section>;
}
