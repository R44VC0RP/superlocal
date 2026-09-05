import type { Account, Folder, Label, Mailbox, MailboxMessageSummary } from "../../packages/inbox-sdk/src/contracts.ts";
import type { Mail, MailboxOption, Message } from "../web/src/data.ts";
import { unifiedMail } from "../web/src/mail-model.ts";
import { classifyAttention, conversationAttention } from "./mail-attention.ts";

export type MailProjectionInput = {
  sources: readonly Account[];
  mailboxes: readonly Mailbox[];
  summaries: readonly MailboxMessageSummary[];
  labels: readonly Label[];
  folders?: ReadonlyMap<string, readonly Folder[]>;
  includedMailboxIds: readonly string[];
  allowProviderWrites: boolean;
  now: number;
  displayTime: (value: string) => { date: string; group: string };
  decorateMessage?: (message: Message, summary: MailboxMessageSummary) => Message;
};

/** The app's metadata projection, shared by backend queries and resident browser rows. */
export function projectMailboxMail(input: MailProjectionInput): { accounts: MailboxOption[]; mail: Mail[]; labels: Record<string, string[]> } {
  const sources = new Map(input.sources.map(source => [source.id, source]));
  const boxes = input.mailboxes.filter(box => sources.has(box.sourceId));
  const accounts: MailboxOption[] = boxes.map(box => {
    const source = sources.get(box.sourceId)!;
    return { id: box.id, sourceId: source.id, sourceGeneration: source.generation, name: box.name || source.name,
      email: box.defaultSender || source.email, selectorKind: box.selector.kind,
      canSend: input.allowProviderWrites && source.status === "connected" && box.status === "active" && source.capabilities.send && !!box.defaultSender };
  });
  const boxSources = new Map(boxes.map(box => [box.id, box.sourceId]));
  const canonical = new Map<string, MailboxMessageSummary>();
  for (const row of input.summaries) {
    const key = `${row.sourceId}\0${row.id}`, previous = canonical.get(key);
    if (!previous) { canonical.set(key, row); continue; }
    const memberships = new Map(previous.memberships.map(state => [state.mailboxId, state]));
    for (const state of row.memberships) if (!memberships.has(state.mailboxId) || memberships.get(state.mailboxId)!.revision <= state.revision) memberships.set(state.mailboxId, state);
    canonical.set(key, { ...(row.revision > previous.revision ? row : previous), memberships: [...memberships.values()] });
  }
  const byBox = new Map<string, Map<string, MailboxMessageSummary[]>>(boxes.map(box => [box.id, new Map()]));
  for (const row of canonical.values()) for (const state of row.memberships) {
    const groups = byBox.get(state.mailboxId);
    if (!groups || boxSources.get(state.mailboxId) !== row.sourceId) continue;
    const group = groups.get(row.threadId) ?? [];
    group.push(row); groups.set(row.threadId, group);
  }
  const mail: Mail[] = [], labelNames: Record<string, string[]> = {};
  const addresses = (people: MailboxMessageSummary["to"]) => people.map(person => person.name && person.name !== person.email
    ? `${person.name.includes(",") ? JSON.stringify(person.name) : person.name} <${person.email}>` : person.email).join(", ");
  for (const box of boxes) {
    const source = sources.get(box.sourceId)!;
    const nativeFolders = input.folders?.get(source.id) ?? [];
    const labels = input.labels.filter(label => label.accountId === source.id);
    labelNames[box.id] = [...new Set([...labels.map(label => label.name), ...nativeFolders.filter(folder => folder.kind === "label").map(folder => folder.name)])];
    for (const [thread, values] of byBox.get(box.id)!) {
      const rows = [...values].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id));
      const latest = rows.at(-1)!;
      const states = rows.map(row => row.memberships.find(state => state.mailboxId === box.id)!);
      const hidden = rows.every(row => row.folder === "trash") ? "Trash" : rows.every(row => row.folder === "spam") ? "Spam" : undefined;
      const done = states.every(state => state.done);
      const reminders = states.map(state => state.snoozedUntil).filter((value): value is string => !!value && Date.parse(value) > input.now).sort();
      const locations: string[] = [];
      if (hidden) locations.push(hidden);
      else {
        if (rows.some((row, index) => row.folder === "inbox" && !states[index].done && (!states[index].snoozedUntil || Date.parse(states[index].snoozedUntil!) <= input.now))) locations.push("Inbox");
        if (rows.some(row => row.folder === "sent")) locations.push("Sent");
        if (done) locations.push("Done");
        if (reminders.length) locations.push("Reminders");
        if (rows.every(row => row.folder === "archive" || row.folder === "sent") && rows.some(row => row.folder === "archive")) locations.push("Auto Archived");
      }
      const names = [...new Set(rows.flatMap(row => [
        ...row.labelIds.flatMap(id => labels.filter(label => label.id === id).map(label => label.name)),
        ...nativeFolders.filter(folder => folder.kind === "label" && row.folderIds.includes(folder.id)).map(folder => folder.name),
      ]))];
      const messages = rows.map(row => {
        const message: Message = { id: row.id, revision: row.revision, bodyRevision: row.bodyRevision, from: row.from.name || row.from.email,
          email: row.from.email, to: addresses(row.to), cc: addresses(row.cc), date: input.displayTime(row.receivedAt).date,
          receivedAt: row.receivedAt, body: "", loaded: false, outgoing: row.folder === "sent", hasAttachments: row.hasAttachments,
          attention: classifyAttention(row), nativeFolder: row.folder, isRead: row.isRead, isStarred: row.isStarred,
          memberships: row.memberships.filter(state => state.mailboxId === box.id) };
        return input.decorateMessage?.(message, row) ?? message;
      });
      const conversation: Mail = { id: `${box.id}:${thread}`, account: box.id, sourceId: source.id, sourceGeneration: source.generation,
        mailboxId: box.id, sdkThreadId: thread, accountEmail: source.email, from: latest.from.name || latest.from.email, email: latest.from.email,
        to: addresses(latest.to), toAddresses: latest.to.map(person => person.email), subject: rows[0].subject, snippet: latest.preview,
        ...input.displayTime(latest.receivedAt), receivedAt: Date.parse(latest.receivedAt), split: "Important",
        folder: hidden ?? (locations.includes("Inbox") ? "Inbox" : done ? "Done" : reminders.length ? "Reminders" : locations[0] ?? "Auto Archived"),
        locations, unread: rows.some(row => !row.isRead), starred: rows.some(row => row.isStarred), labels: names, messages,
        ...(reminders.length ? { reminder: reminders[0], reminderAt: Date.parse(reminders[0]) } : {}) };
      mail.push(conversation);
    }
  }
  labelNames.unified = [...new Set(input.includedMailboxIds.flatMap(id => labelNames[id] ?? []))];
  mail.push(...unifiedMail(mail, input.includedMailboxIds, accounts, input.now));
  for (const conversation of mail) conversation.split = conversationAttention(conversation, input.now);
  return { accounts, mail: mail.sort((a, b) => (b.receivedAt ?? 0) - (a.receivedAt ?? 0) || a.id.localeCompare(b.id)), labels: labelNames };
}
