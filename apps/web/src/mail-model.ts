import type { Draft, Mail, Message } from "./data.ts";

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
