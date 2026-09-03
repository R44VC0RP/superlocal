import type { Mail } from "./data.ts";
import { inFolder } from "./mail-model.ts";
import { plainText } from "./mail-text.ts";

type SearchExpression = { term: string } | { op: "and" | "or"; left: SearchExpression; right: SearchExpression } | { not: SearchExpression };
export function parseSearch(query: string): SearchExpression | null {
  if (query.length > 4096) throw new Error("Use a search rule under 4096 characters.");
  if ((query.match(/"/g)?.length ?? 0) % 2) throw new Error("Close the quoted phrase.");
  const tokens = query.match(/-?(?:[^\s()"]|"[^"]*")+|[()]/g) ?? [];
  let index = 0;
  function atom(depth: number): SearchExpression {
    if (depth > 20) throw new Error("Use fewer nested parentheses.");
    const term = tokens[index++];
    if (!term || [")", "OR", "AND"].includes(term)) throw new Error("Add a filter on both sides of AND or OR.");
    if (term === "-") return { not: atom(depth + 1) };
    if (term === "(") {
      const expression = or(depth + 1);
      if (tokens[index++] !== ")") throw new Error("Close the filter parentheses.");
      return expression;
    }
    return { term };
  }
  function and(depth: number): SearchExpression {
    let left = atom(depth);
    while (index < tokens.length && tokens[index] !== ")" && tokens[index] !== "OR") {
      if (tokens[index] === "AND") index++;
      left = { op: "and", left, right: atom(depth) };
    }
    return left;
  }
  function or(depth: number): SearchExpression {
    let left = and(depth);
    while (tokens[index] === "OR") { index++; left = { op: "or", left, right: and(depth) }; }
    return left;
  }
  if (!tokens.length) return null;
  const expression = or(0);
  if (index !== tokens.length) throw new Error("Check the filter parentheses.");
  return expression;
}
export function splitRuleError(query: string): string | null {
  try {
    const expression = parseSearch(query);
    if (!expression) return "Add a filter, such as from:john@doe.com.";
    function validate(node: SearchExpression): void {
      if ("not" in node) return validate(node.not);
      if ("op" in node) { validate(node.left); validate(node.right); return; }
      const term = node.term.replace(/^-/, ""), colon = term.indexOf(":");
      if (colon < 0) return;
      const key = term.slice(0, colon), value = term.slice(colon + 1).replaceAll('"', "");
      if (!["from", "to", "subject", "in", "label", "is", "has", "before", "after", "older_than", "newer_than"].includes(key) || !value) throw new Error("Use from:, to:, subject:, in:, label:, is:, has:, or date filters.");
      if (key === "is" && !["read", "unread", "starred"].includes(value) || key === "has" && value !== "attachment") throw new Error("Use is:read, is:unread, is:starred, or has:attachment.");
      if (["before", "after"].includes(key) && !Number.isFinite(Date.parse(value)) || key.endsWith("_than") && !/^\d+[dmy]$/.test(value)) throw new Error("Use a date or an age such as 3d, 1m, or 1y.");
    }
    validate(expression); return null;
  } catch (error) { return error instanceof Error ? error.message : "Invalid filter."; }
}
export function matchesSearch(m: Mail, query: string, includeBodies = true) {
  let expression: SearchExpression | null;
  try { expression = parseSearch(query); } catch { return false; }
  function matchesTerm(raw: string): boolean {
    const negative = raw.startsWith("-");
    const term = negative ? raw.slice(1) : raw;
    const match = () => {
      const [key, ...rest] = term.split(":");
      const value = rest.join(":").replaceAll('"', "").toLowerCase();
      if (rest.length) {
        if (key === "from") {
          const emails = [m.email, ...m.messages.map(message => message.email)].map(email => email.trim().toLowerCase());
          if (value.includes("@")) return emails.includes(value);
          if (value.includes(".")) return emails.some(email => email.split("@")[1] === value || email.split("@")[1]?.endsWith(`.${value}`));
          return `${m.from} ${m.email} ${m.messages.map((message) => `${message.from} ${message.email}`).join(" ")}`
            .toLowerCase()
            .includes(value);
        }
        if (key === "to" && value.includes("@")) return [m.to, ...m.messages.map(message => message.to)].some(to => Array.from(to.toLowerCase().matchAll(/[^\s<>\",;]+@[^\s<>\",;]+/g), match => match[0]).includes(value));
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
      return `${m.from} ${m.email} ${m.to} ${m.subject} ${m.snippet} ${includeBodies ? m.messages.map((msg) => plainText(msg.body)).join(" ") : ""}`
        .toLowerCase()
        .includes(term.replaceAll('"', "").toLowerCase());
    };
    return negative ? !match() : match();
  }
  function evaluate(node: SearchExpression): boolean {
    if ("term" in node) return matchesTerm(node.term);
    if ("not" in node) return !evaluate(node.not);
    return node.op === "and" ? evaluate(node.left) && evaluate(node.right) : evaluate(node.left) || evaluate(node.right);
  }
  return expression ? evaluate(expression) : true;
}
