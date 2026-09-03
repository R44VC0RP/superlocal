import type { Participant } from "inbox-sdk/types";
import type { Mail, MailboxOption } from "./data";

export type SenderHistoryMessage = {
  id: string;
  sourceId: string;
  threadId: string;
  revision: number;
  from: Participant;
  to: Participant[];
  cc: Participant[];
  subject: string;
  receivedAt: string;
  folder: string;
  outgoing: boolean;
  mailboxIds: string[];
};

export type SenderDomainInfo = {
  hostname: string;
  rootDomain: string | null;
  kind: "domain" | "mail-provider" | "unavailable";
  websiteUrl: string | null;
  registrationUrl: string | null;
  iconUrl: string | null;
  imagePolicy: "allowed" | "blocked" | "offline";
};

export type SenderContact = { name: string; email: string; messageId: string | null; role: "sender" | "recipient" };
export type SenderWeek = { start: number; received: number; sent: number };
const WEEK = 7 * 24 * 60 * 60_000;
const addressKey = (value: string) => value.trim().toLowerCase();
export const senderThreadKey = (source: string, thread: string) => `${source}\0${thread}`;

export function senderHostname(address: string): string | null {
  const match = address.trim().match(/^[^@\s<>]+@([^\s<>@/\\?#:]+)$/);
  if (!match) return null;
  try {
    const url = new URL(`https://${match[1]}`);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    return /^[a-z\d-]+(?:\.[a-z\d-]+)*\.[a-z][a-z\d-]*$/.test(hostname) && !url.username && !url.password && !url.port ? hostname : null;
  } catch { return null; }
}

export function senderContact(mail: Mail, history: readonly SenderHistoryMessage[], accounts: readonly MailboxOption[], selectedMessageId?: string): SenderContact {
  const ids = new Set(mail.messages.filter(message => !message.pending).map(message => message.id));
  const messages = history.filter(message => ids.has(message.id) && (!mail.sourceId || message.sourceId === mail.sourceId))
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id));
  const selected = selectedMessageId ? messages.find(message => message.id === selectedMessageId) : undefined;
  const incoming = selected && !selected.outgoing ? selected : [...messages].reverse().find(message => !message.outgoing);
  if (incoming && !selected?.outgoing) return { ...incoming.from, messageId: incoming.id, role: "sender" };
  const outgoing = selected || [...messages].reverse().find(message => message.outgoing);
  const own = new Set(accounts.map(account => addressKey(account.email)).filter(Boolean));
  const recipient = outgoing && [...outgoing.to, ...outgoing.cc].find(person => !own.has(addressKey(person.email)));
  if (recipient) return { ...recipient, messageId: outgoing.id, role: "recipient" };
  return { name: mail.from, email: mail.email, messageId: mail.messages.filter(message => !message.pending).at(-1)?.id ?? null, role: "sender" };
}

/** Local, scope-bound evidence only. Opening/reading/Done never contributes to contact level. */
export function senderActivity(
  history: readonly SenderHistoryMessage[],
  email: string,
  mailboxIds: readonly string[],
  domain: string | null = null,
  now = Date.now(),
) {
  const scope = new Set(mailboxIds), address = addressKey(email);
  const canonical = new Map<string, SenderHistoryMessage>();
  for (const message of history) {
    const key = `${message.sourceId}\0${message.id}`, previous = canonical.get(key);
    canonical.set(key, previous ? {
      ...(previous.revision > message.revision ? previous : message),
      mailboxIds: [...new Set([...previous.mailboxIds, ...message.mailboxIds])],
    } : message);
  }
  const matches = (value: string) => {
    if (!domain) return addressKey(value) === address;
    const hostname = senderHostname(value);
    return hostname === domain || hostname?.endsWith(`.${domain}`) === true;
  };
  const since = now - 12 * WEEK;
  const weeks: SenderWeek[] = Array.from({ length: 12 }, (_, index) => ({ start: since + index * WEEK, received: 0, sent: 0 }));
  const threads = new Map<string, { received: boolean; sent: boolean; latest: number }>();
  let received = 0, sent = 0, firstMessage: number | null = null, lastMessage: number | null = null, lastSent: number | null = null;
  for (const message of canonical.values()) {
    if (!message.mailboxIds.some(id => scope.has(id))) continue;
    if (["trash", "spam", "scheduled", "draft", "drafts"].includes(message.folder)) continue;
    const time = Date.parse(message.receivedAt);
    if (!Number.isFinite(time) || time > now) continue;
    const direction = message.outgoing ? [...message.to, ...message.cc].some(person => matches(person.email)) ? "sent" : null
      : matches(message.from.email) ? "received" : null;
    if (!direction) continue;
    if (direction === "sent") { sent++; lastSent = Math.max(lastSent ?? time, time); } else received++;
    firstMessage = Math.min(firstMessage ?? time, time); lastMessage = Math.max(lastMessage ?? time, time);
    const key = senderThreadKey(message.sourceId, message.threadId);
    const thread = threads.get(key) ?? { received: false, sent: false, latest: time };
    thread[direction] = true; thread.latest = Math.max(thread.latest, time); threads.set(key, thread);
    if (time >= since) weeks[Math.min(11, Math.floor((time - since) / WEEK))][direction]++;
  }
  const twoWay = [...threads.values()].filter(thread => thread.received && thread.sent).length;
  const level = !received && !sent ? 0 : twoWay >= 25 ? 5 : twoWay >= 10 ? 4 : twoWay >= 3 ? 3 : twoWay >= 1 ? 2 : 1;
  return { received, sent, conversations: threads.size, twoWay, level, weeks, firstMessage, lastMessage, lastSent,
    recentThreadKeys: [...threads].sort((a, b) => b[1].latest - a[1].latest).map(([key]) => key) };
}

export async function readSenderDomain(hostname: string, signal: AbortSignal): Promise<SenderDomainInfo> {
  const response = await fetch(`/host/sender-domains/${encodeURIComponent(hostname)}`, { credentials: "include", cache: "no-store", signal });
  const value = await response.json().catch(() => null);
  if (!response.ok || !value || value.hostname !== hostname || !["domain", "mail-provider", "unavailable"].includes(value.kind)
    || !["allowed", "blocked", "offline"].includes(value.imagePolicy) || value.rootDomain !== null && typeof value.rootDomain !== "string") {
    throw new Error("Domain information is unavailable.");
  }
  const root = value.rootDomain && senderHostname(`root@${value.rootDomain}`) === value.rootDomain
    && (hostname === value.rootDomain || hostname.endsWith(`.${value.rootDomain}`)) ? value.rootDomain : null;
  const website = typeof value.websiteUrl === "string" && root && value.websiteUrl === `https://${root}/` ? value.websiteUrl : null;
  const registration = root && value.registrationUrl === `https://lookup.icann.org/en/lookup?name=${encodeURIComponent(root)}` ? value.registrationUrl : null;
  const icon = root && value.iconUrl === `/host/sender-domains/${encodeURIComponent(root)}/icon` ? value.iconUrl : null;
  return { hostname, rootDomain: root, kind: value.kind, imagePolicy: value.imagePolicy, websiteUrl: website, registrationUrl: registration, iconUrl: icon };
}
