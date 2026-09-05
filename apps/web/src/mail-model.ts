import type { Draft, Mail, MailboxOption, Message } from "./data.ts";
import type { AiDecision } from "../../shared/ai-triage.ts";
import type { CategoryOverride } from "../../shared/attention-overrides.ts";

export const UNIFIED_ACCOUNT = "unified";
export const unifiedThreadId = (source: string, thread: string) => `${UNIFIED_ACCOUNT}:${source}:${thread}`;

/** A cached assessment cannot follow a later reply or changed body implicitly. */
export function currentAiDecision(mail: Mail, decision: AiDecision | undefined, model: string): AiDecision | undefined {
  if (!decision || mail.operationId || mail.sourceId !== decision.sourceId || mail.sdkThreadId !== decision.threadId) return;
  const boxes = mail.mailboxIds ?? (mail.mailboxId ? [mail.mailboxId] : [mail.account]);
  if (!boxes.some(id => decision.mailboxIds.includes(id))) return;
  const received = mail.messages.filter(message => !message.pending);
  const latest = received.at(-1);
  const versions = new Map(received.map(message => [message.id, message.bodyRevision]));
  const stale = decision.model !== model || latest?.id !== decision.latestMessageId || decision.contextVersions.some(context => {
    const version = versions.get(context.messageId);
    return version !== undefined && context.bodyRevision !== null && version !== context.bodyRevision;
  });
  return stale && decision.state === "ready" ? { ...decision, state: "stale", score: null, override: null } : decision;
}

/** An explicit category never follows an uncaptured reply, body or receiving scope. */
export function currentCategoryOverride(mail: Mail, override: CategoryOverride | null | undefined): CategoryOverride | undefined {
  if (!override || mail.operationId) return;
  const context = override.context;
  if (mail.sourceId !== context.sourceId || mail.sdkThreadId !== context.threadId || mail.sourceGeneration !== context.sourceGeneration) return;
  const boxes = new Set(mail.mailboxIds ?? (mail.mailboxId ? [mail.mailboxId] : [mail.account]));
  if (!boxes.size || [...boxes].some(id => !context.mailboxIds.includes(id))) return;
  const expected = new Map(context.messages.filter(message => message.memberships.some(state => boxes.has(state.mailboxId))).map(message => [message.messageId, message]));
  const received = mail.messages.filter(message => !message.pending);
  if (!received.length || received.length !== expected.size) return;
  if (boxes.size === context.mailboxIds.length && received.at(-1)?.id !== context.latestMessageId) return;
  for (const message of received) {
    const captured = expected.get(message.id);
    if (!captured || (captured.bodyRevision === null ? message.revision !== captured.revision : message.bodyRevision !== captured.bodyRevision)) return;
    const memberships = new Set(captured.memberships.filter(state => boxes.has(state.mailboxId)).map(state => state.mailboxId));
    if (!message.memberships?.length || message.memberships.length !== memberships.size || message.memberships.some(state => !memberships.has(state.mailboxId))) return;
  }
  return override;
}

/** Combine owned receiving views, never identities from unrelated source accounts. */
export function unifiedMail(
  mail: readonly Mail[],
  includedMailboxIds: readonly string[],
  mailboxes: readonly MailboxOption[],
  now = Date.now(),
): Mail[] {
  const included = new Set(includedMailboxIds);
  const options = new Map(mailboxes.map((box, index) => [box.id, { ...box, index }]));
  const groups = new Map<string, Mail[]>();
  for (const item of mail) {
    if (!included.has(item.account) || item.account === UNIFIED_ACCOUNT) continue;
    const key = item.operationId ? `${UNIFIED_ACCOUNT}:operation:${item.operationId}`
      : item.sourceId && item.sdkThreadId ? unifiedThreadId(item.sourceId, item.sdkThreadId) : `${UNIFIED_ACCOUNT}:${item.id}`;
    const group = groups.get(key) ?? [];
    group.push(item); groups.set(key, group);
  }
  const result: Mail[] = [];
  const sleeping = (value: string | null) => !!value && Date.parse(value) > now;
  for (const [id, copies] of groups) {
    const base = [...copies].sort((a, b) => (b.receivedAt ?? 0) - (a.receivedAt ?? 0) || a.id.localeCompare(b.id))[0];
    const first = [...copies].sort((a, b) => (Date.parse(a.messages.find(message => !message.pending)?.receivedAt ?? "") || Infinity)
      - (Date.parse(b.messages.find(message => !message.pending)?.receivedAt ?? "") || Infinity) || a.id.localeCompare(b.id))[0];
    const byMessage = new Map<string, Message>();
    for (const copy of copies) for (const message of copy.messages) {
      const previous = byMessage.get(message.id);
      const memberships = new Map(previous?.memberships?.map(state => [state.mailboxId, state]) ?? []);
      for (const state of message.memberships ?? []) if (included.has(state.mailboxId)) {
        if (!memberships.has(state.mailboxId) || memberships.get(state.mailboxId)!.revision <= state.revision) memberships.set(state.mailboxId, state);
      }
      const newer = !previous || (message.revision ?? 0) > (previous.revision ?? 0)
        || message.revision === previous.revision && previous.loaded === false && message.loaded !== false;
      byMessage.set(message.id, { ...(newer ? message : previous), memberships: [...memberships.values()] });
    }
    const messages = [...byMessage.values()].sort((a, b) => Number(!!a.pending) - Number(!!b.pending)
      || (Date.parse(a.receivedAt ?? "") || 0) - (Date.parse(b.receivedAt ?? "") || 0) || a.id.localeCompare(b.id));
    const received = messages.filter(message => !message.pending);
    const latestBoxes = new Set(received.at(-1)?.memberships?.map(state => state.mailboxId));
    const mailboxIds = [...new Set(copies.map(copy => copy.mailboxId ?? copy.account))].sort((a, b) => {
      const left = options.get(a), right = options.get(b);
      const specificity = { all: 0, domain: 1, address: 2 };
      return Number(latestBoxes.has(b)) - Number(latestBoxes.has(a)) || Number(!!right?.canSend) - Number(!!left?.canSend)
        || specificity[right?.selectorKind ?? "all"] - specificity[left?.selectorKind ?? "all"] || (left?.index ?? 0) - (right?.index ?? 0);
    });
    const states = received.flatMap(message => message.memberships ?? []);
    const hidden = received.length && received.every(message => message.nativeFolder === "trash") ? "Trash"
      : received.length && received.every(message => message.nativeFolder === "spam") ? "Spam" : undefined;
    const done = states.length > 0 && states.every(state => state.done);
    const reminders = states.flatMap(state => sleeping(state.snoozedUntil) ? [state.snoozedUntil!] : []).sort();
    const locations: string[] = [];
    if (base.operationId) locations.push("Scheduled");
    else if (hidden) locations.push(hidden);
    else if (states.length) {
      if (received.some(message => message.nativeFolder === "inbox" && message.memberships?.some(state => !state.done && !sleeping(state.snoozedUntil)))) locations.push("Inbox");
      if (received.some(message => message.nativeFolder === "sent")) locations.push("Sent");
      if (done) locations.push("Done");
      if (reminders.length) locations.push("Reminders");
      if (received.every(message => ["archive", "sent"].includes(message.nativeFolder ?? "")) && received.some(message => message.nativeFolder === "archive")) locations.push("Auto Archived");
    } else locations.push(...new Set(copies.flatMap(copy => copy.locations ?? [copy.folder])));
    const merged: Mail = { ...base, id, subject: first.subject, account: UNIFIED_ACCOUNT, mailboxId: mailboxIds[0], mailboxIds,
      mailboxNames: mailboxIds.map(box => options.get(box)?.name ?? "Mailbox"), messages, locations,
      folder: hidden ?? (locations.includes("Inbox") ? "Inbox" : done ? "Done" : reminders.length ? "Reminders" : locations[0] ?? base.folder),
      unread: received.length > 0 && received.every(message => typeof message.isRead === "boolean") ? received.some(message => !message.isRead) : copies.some(copy => copy.unread),
      starred: received.length > 0 && received.every(message => typeof message.isStarred === "boolean") ? received.some(message => message.isStarred) : copies.some(copy => copy.starred),
      labels: [...new Set(copies.flatMap(copy => copy.labels))],
      reminder: reminders[0], reminderAt: reminders.length ? Date.parse(reminders[0]) : undefined,
    };
    if (base.triage) {
      merged.triage = currentAiDecision(merged, base.triage, base.triage.model);
      if (merged.triage?.state !== "ready") merged.attentionCategory = undefined;
    }
    if (base.attentionOverride) merged.attentionOverride = currentCategoryOverride(merged, base.attentionOverride.override) ? base.attentionOverride : undefined;
    result.push(merged);
  }
  return result.sort((a, b) => (b.receivedAt ?? 0) - (a.receivedAt ?? 0) || a.id.localeCompare(b.id));
}

export function normalizeSchedule(mail: Mail): Mail {
  if (mail.locations) return mail;
  if (!mail.scheduled || mail.messages.some((message) => message.scheduledAt))
    return mail;
  // Previously saved schedules belong to the most recent outgoing message.
  const index = mail.messages
    .map((message) => message.email === mail.account && !message.cancelled)
    .lastIndexOf(true);
  if (index < 0)
    return {
      ...mail,
      scheduled: undefined,
      folder: mail.folder === "Scheduled" ? "Sent" : mail.folder,
    };
  if (["Trash", "Spam"].includes(mail.folder))
    return {
      ...mail,
      scheduled: undefined,
      messages: mail.messages.map((message, i) =>
        i === index
          ? { ...message, cancelled: true, date: "Not sent" }
          : message,
      ),
    };
  return {
    ...mail,
    messages: mail.messages.map((message, i) =>
      i === index ? { ...message, scheduledAt: mail.scheduled } : message,
    ),
  };
}

function withSchedule(mail: Mail): Mail {
  const scheduled = mail.messages
    .map((message) => message.scheduledAt)
    .filter((value): value is string => !!value)
    .sort()[0];
  return {
    ...mail,
    scheduled,
    folder: !scheduled && mail.folder === "Scheduled" ? "Sent" : mail.folder,
  };
}

export function inFolder(original: Mail, folder: string): boolean {
  if (original.locations) {
    const normalized = folder.toLowerCase().replaceAll(/\s/g, "");
    const hidden = original.locations.some((value) => value === "Trash" || value === "Spam");
    if (normalized === "starred") return !hidden && original.starred;
    if (normalized === "allmail") return !hidden && !original.operationId;
    return [...original.locations, ...original.labels].some((value) => value.toLowerCase().replaceAll(/\s/g, "") === normalized);
  }
  const mail = normalizeSchedule(original);
  const hidden = ["Trash", "Spam"].includes(mail.folder);
  switch (folder.toLowerCase().replaceAll(/\s/g, "")) {
    case "inbox":
      return mail.folder === "Inbox" && !mail.muted;
    case "sent":
      return (
        !hidden &&
        mail.messages.some(
          (message) =>
            message.email === mail.account &&
            !message.scheduledAt &&
            !message.cancelled,
        )
      );
    case "scheduled":
      return !hidden && mail.messages.some((message) => !!message.scheduledAt);
    case "reminders":
      return !hidden && !!mail.reminder;
    case "muted":
      return !hidden && !!mail.muted;
    case "starred":
      return !hidden && mail.starred;
    case "allmail":
      return !hidden;
    default:
      return (
        mail.folder.toLowerCase().replaceAll(/\s/g, "") ===
          folder.toLowerCase().replaceAll(/\s/g, "") ||
        mail.labels.some(
          (label) => label.toLowerCase() === folder.toLowerCase(),
        )
      );
  }
}

export function moveMail(original: Mail, folder: string): Mail {
  const mail = normalizeSchedule(original);
  const cancel = folder === "Trash" || folder === "Spam";
  return withSchedule({
    ...mail,
    folder,
    reminder: undefined,
    reminderAt: undefined,
    messages: cancel
      ? mail.messages.map((message) =>
          message.scheduledAt
            ? {
                ...message,
                scheduledAt: undefined,
                cancelled: true,
                date: "Not sent",
              }
            : message,
        )
      : mail.messages,
  });
}

export function remindMail(
  original: Mail,
  reminder: string,
  reminderAt?: number,
): Mail {
  const mail = normalizeSchedule(original);
  return {
    ...mail,
    folder: mail.scheduled ? mail.folder : "Reminders",
    reminder,
    reminderAt,
  };
}

export function advanceMail(mailbox: Mail[], now: number): Mail[] {
  let changed = false;
  const next = mailbox.map((original) => {
    let mail = normalizeSchedule(original);
    let delivered = false;
    const messages = mail.messages.map((message) => {
      if (
        !message.scheduledAt ||
        Date.parse(message.scheduledAt) > now ||
        !Number.isFinite(Date.parse(message.scheduledAt))
      )
        return message;
      if (["Trash", "Spam"].includes(mail.folder)) return message;
      delivered = true;
      return { ...message, scheduledAt: undefined, date: "Just now" };
    });
    if (delivered)
      mail = withSchedule({
        ...mail,
        messages,
        receivedAt: now,
        date: "Just now",
      });
    if (
      !mail.scheduled &&
      mail.reminderAt &&
      mail.reminderAt <= now &&
      !["Trash", "Spam"].includes(mail.folder)
    ) {
      mail = {
        ...mail,
        folder: "Inbox",
        reminder: undefined,
        reminderAt: undefined,
        unread: true,
      };
    }
    changed ||= mail !== original;
    return mail;
  });
  return changed ? next : mailbox;
}

export function appendOutgoing(
  original: Mail | undefined,
  draft: Draft,
  options: {
    sender: string;
    preview: string;
    when?: string;
    markDone?: boolean;
    now?: number;
  },
): Mail {
  if (original && original.account !== draft.account)
    throw new Error("Cannot append a draft to another account's conversation.");
  if (options.when && original && ["Trash", "Spam"].includes(original.folder))
    throw new Error(
      `Move this conversation out of ${original.folder} before scheduling a reply. Your draft has been kept.`,
    );
  const now = options.now ?? Date.now();
  const message: Message = {
    id: crypto.randomUUID(),
    from: options.sender,
    email: draft.account,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    body: draft.body,
    attachments: draft.attachments,
    date: options.when ? "Scheduled" : "Just now",
    scheduledAt: options.when,
  };
  const mail = original ? normalizeSchedule(original) : undefined;
  return withSchedule({
    ...(mail || {
      id: `sent-${crypto.randomUUID()}`,
      account: draft.account,
      from: draft.to.split("@")[0],
      email: draft.to,
      to: draft.to,
      subject: draft.subject || "(no subject)",
      group: "Today",
      split: "Important",
      folder: options.when ? "Scheduled" : "Sent",
      unread: false,
      starred: false,
      labels: [],
    }),
    messages: [...(mail?.messages || []), message],
    folder: options.markDone
      ? "Done"
      : mail?.folder || (options.when ? "Scheduled" : "Sent"),
    snippet: options.preview,
    receivedAt: now,
    date: options.when ? "Scheduled" : "Just now",
  });
}

export function restoreMail(mailbox: Mail[], previous: Mail[]): Mail[] {
  const byId = new Map(previous.map((mail) => [mail.id, mail]));
  return mailbox.map((mail) => byId.get(mail.id) || mail);
}
