import type { Mail } from "./data.ts";
import { inFolder } from "./mail-model.ts";
import { plainText } from "./mail-text.ts";

export function matchesSearch(m: Mail, query: string) {
  const terms = query.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  return terms.every((raw) => {
    const negative = raw.startsWith("-");
    const term = negative ? raw.slice(1) : raw;
    const match = () => {
      const [key, ...rest] = term.split(":");
      const value = rest.join(":").replaceAll('"', "").toLowerCase();
      if (rest.length) {
        if (key === "from")
          return `${m.from} ${m.email} ${m.messages.map((message) => `${message.from} ${message.email}`).join(" ")}`
            .toLowerCase()
            .includes(value);
        if (key === "to")
          return [m.to, ...m.messages.map((message) => message.to)].some((to) =>
            to.toLowerCase().includes(value),
          );
        if (key === "subject") return m.subject.toLowerCase().includes(value);
        if (key === "in") return inFolder(m, value);
        if (key === "label")
          return [...m.labels, m.split].some((l) =>
            l.toLowerCase().includes(value),
          );
        if (key === "is")
          return value === "unread"
            ? m.unread
            : value === "read"
              ? !m.unread
              : value === "starred"
                ? m.starred
                : false;
        if (key === "has" && value === "attachment")
          return m.messages.some((msg) => msg.hasAttachments || msg.attachments?.length);
      }
      if (["before", "after", "older_than", "newer_than"].includes(key)) {
        const received =
          m.receivedAt ||
          (/^Aug \d+/.test(m.date)
            ? new Date(`${m.date}, 2026`).getTime()
            : new Date(
                m.date === "Yesterday" ? "2026-08-31" : "2026-09-01",
              ).getTime());
        let boundary = Date.parse(value);
        if (key.endsWith("_than")) {
          const duration = value.match(/^(\d+)([dmy])$/);
          if (!duration) return false;
          boundary =
            Date.now() -
            Number(duration[1]) *
              (({ d: 1, m: 30, y: 365 } as Record<string, number>)[
                duration[2]
              ] || 1) *
              86400000;
        }
        return (
          Number.isFinite(boundary) &&
          (key === "before" || key === "older_than"
            ? received < boundary
            : received >= boundary)
        );
      }
      return `${m.from} ${m.email} ${m.to} ${m.subject} ${m.snippet} ${m.messages.map((msg) => plainText(msg.body)).join(" ")}`
        .toLowerCase()
        .includes(term.replaceAll('"', "").toLowerCase());
    };
    return negative ? !match() : match();
  });
}
