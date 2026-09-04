import type { Mail, Preferences } from "./data.ts";
import { inFolder } from "./mail-model.ts";
import { compileSearch } from "./mail-search.ts";
import { conversationAttention } from "../../shared/mail-attention.ts";
import { attentionSplit } from "../../shared/splits.ts";

export type MailListEntry = {
  key: string;
  top: number;
  height: number;
  mail: Mail;
  index: number;
  group?: string;
};

export function selectMailView(
  accountMail: Mail[],
  account: string,
  folder: string,
  split: string,
  preferences: Preferences,
  search: boolean,
  query: string,
  filter: string | null,
  serverMatches?: ReadonlySet<string>,
  mobile = false,
) {
  const rules = preferences.splitRules as Record<string, string> | undefined;
  const aliases = preferences.splitAliases as
    Record<string, string> | undefined;
  const matchers = new Map([...new Set([...preferences.splits, split])].map(name => {
    const category = attentionSplit({ splitRules: rules ?? {}, splitAliases: aliases ?? {} }, name);
    const query = rules?.[name];
    return [name, { category, matches: !category && typeof query === "string" && query.trim() ? compileSearch(query, false) : undefined }] as const;
  }));
  const splitCounts = Object.fromEntries(preferences.splits.map(name => [name, 0]));
  const countedSplits = [...new Set(preferences.splits)];
  const queryMatches = search && !serverMatches ? compileSearch(query) : undefined;
  const searchHidden = /in:(trash|spam)/i.test(query);
  const visibleMail: Mail[] = [];
  const now = Date.now();
  let holdingMail = false;
  let inboxCount = 0;
  for (const message of accountMail) {
    const inbox = inFolder(message, "Inbox");
    if (!search && folder === "Inbox" && inbox && (message.aiHoldUntil ?? 0) > now) { holdingMail = true; continue; }
    const attention = inbox || filter === "Important" ? conversationAttention(message) : undefined;
    const matchesSplit = (name: string) => {
      const matcher = matchers.get(name)!;
      return matcher.category ? attention === matcher.category : matcher.matches?.(message) ?? false;
    };
    let selectedSplit = false;
    if (inbox) {
      if (attention === "Important") inboxCount++;
      for (const name of countedSplits) {
        const matches = matchesSplit(name);
        if (matches) splitCounts[name]++;
        if (name === split) selectedSplit = matches;
      }
      if (!Object.hasOwn(splitCounts, split)) selectedSplit = matchesSplit(split);
    }
    if (filter === "Unread" && !message.unread) continue;
    if (filter === "Starred" && !message.starred) continue;
    if (filter === "Important" && attention !== "Important") continue;
    if (filter === "No reply" && !(message.messages.at(-1)?.outgoing ?? message.messages.at(-1)?.email === account)) continue;
    const assessment = message.triage?.state === "ready" ? message.triage.assessment : null;
    if (filter === "Needs reply" && assessment?.response !== "needed") continue;
    if (filter === "Action requested" && !assessment?.actions.length) continue;
    if (filter === "Time-sensitive" && assessment?.urgency !== "immediate" && assessment?.urgency !== "deadline") continue;
    if (filter === "Suspicious" && assessment?.risk !== "spam_suspected" && assessment?.risk !== "phishing_suspected") continue;
    if (filter === "Unassessed" && assessment) continue;
    if (search) {
      if ((message.folder === "Trash" || message.folder === "Spam") && !searchHidden) continue;
      if (!(serverMatches ? serverMatches.has(message.id) : queryMatches!(message))) continue;
    } else if (folder === "Inbox" ? !inbox || !selectedSplit : !inFolder(message, folder)) continue;
    visibleMail.push(message);
  }
  const shownSplits = preferences.splits.filter(
    (name) =>
      !preferences.hideEmptySplits || name === split || splitCounts[name] > 0,
  );
  const rowHeight = mobile ? 44 : preferences.density === "Compact" ? 30 : 36;
  const entries: MailListEntry[] = [];
  let totalHeight = 0;
  for (const [index, message] of visibleMail.entries()) {
    if (
      folder !== "Inbox" &&
      !search &&
      index > 0 &&
      message.group &&
      message.group !== visibleMail[index - 1].group
    ) {
      entries.push({
        key: `group-${message.id}`,
        top: totalHeight,
        height: 60,
        mail: message,
        index,
        group: message.group === "August" ? "Earlier in August" : message.group,
      });
      totalHeight += 60;
    }
    entries.push({
      key: message.id,
      top: totalHeight,
      height: rowHeight,
      mail: message,
      index,
    });
    totalHeight += rowHeight;
  }
  return {
    visibleMail,
    shownSplits,
    splitCounts,
    entries,
    totalHeight,
    rowHeight,
    inboxCount,
    holdingMail,
  };
}

// Find the visible slice without scanning the entire mailbox on each scroll.
export function mailWindow(
  entries: MailListEntry[],
  top: number,
  height: number,
  rowHeight: number,
) {
  const last = entries.at(-1);
  const total = last ? last.top + last.height : 0;
  const offset = Math.max(0, Math.min(top, Math.max(0, total - height)));
  const minimum = offset - rowHeight * 6;
  const maximum = offset + height + rowHeight * 6;
  let low = 0,
    high = entries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (entries[middle].top + entries[middle].height < minimum)
      low = middle + 1;
    else high = middle;
  }
  const start = low;
  high = entries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (entries[middle].top <= maximum) low = middle + 1;
    else high = middle;
  }
  return { start, end: low };
}
