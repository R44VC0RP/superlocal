/** Content-free, local-only timing samples. Never add message or account identifiers. */
export const performanceActions = ["done", "not-important", "undo", "undo-done", "undo-feedback", "open", "read", "unread", "star", "trash", "spam", "inbox", "remind", "label", "undo-label", "save-draft", "send", "search", "other"] as const;
export type PerformanceAction = typeof performanceActions[number];
export type PerformanceSample = {
  kind: "action" | "input" | "work" | "refresh" | "rebuild" | "thread" | "request";
  tab: string;
  id: string;
  at: number;
  durationMs: number;
  outcome: "ok" | "error" | "ignored" | "hidden";
  action?: PerformanceAction;
  queueMs?: number;
  acceptedMs?: number;
  processingMs?: number;
  /** Awaited page fetch and decoding, not pure wire time. */
  networkMs?: number;
  messages?: number;
  conversations?: number;
  pages?: number;
  full?: boolean;
  route?: "mailboxes" | "mailbox-page" | "mailbox-action" | "feedback" | "operation" | "message-body" | "draft" | "other";
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE" | "HEAD";
  status?: number;
};

const fields = new Set(["kind", "tab", "id", "at", "durationMs", "outcome", "action", "queueMs", "acceptedMs", "processingMs", "networkMs", "messages", "conversations", "pages", "full", "route", "method", "status"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const number = (value: unknown, maximum: number) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum;
const oneOf = (value: unknown, values: readonly string[]) => typeof value === "string" && values.includes(value);

/** The host rejects unknown fields instead of attempting to redact arbitrary logs. */
export function isPerformanceSample(value: unknown): value is PerformanceSample {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const s = value as Record<string, unknown>;
  if (Object.keys(s).some(key => !fields.has(key)) || typeof s.tab !== "string" || !uuid.test(s.tab) || typeof s.id !== "string" || !uuid.test(s.id)) return false;
  if (!oneOf(s.kind, ["action", "input", "work", "refresh", "rebuild", "thread", "request"]) || !oneOf(s.outcome, ["ok", "error", "ignored", "hidden"]) || !number(s.at, 8.64e15) || !number(s.durationMs, 86_400_000)) return false;
  if (s.action !== undefined && !oneOf(s.action, performanceActions)) return false;
  for (const key of ["queueMs", "acceptedMs", "processingMs", "networkMs"]) if (s[key] !== undefined && !number(s[key], 86_400_000)) return false;
  for (const key of ["messages", "conversations", "pages"]) if (s[key] !== undefined && (!number(s[key], 1_000_000) || !Number.isInteger(s[key]))) return false;
  if (s.full !== undefined && typeof s.full !== "boolean") return false;
  if (s.route !== undefined && !oneOf(s.route, ["mailboxes", "mailbox-page", "mailbox-action", "feedback", "operation", "message-body", "draft", "other"])) return false;
  if (s.method !== undefined && !oneOf(s.method, ["GET", "POST", "PATCH", "PUT", "DELETE", "HEAD"])) return false;
  return s.status === undefined || number(s.status, 599) && Number.isInteger(s.status);
}
