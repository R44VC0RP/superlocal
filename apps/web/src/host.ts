import type { SplitPreferences } from "../../shared/splits";
import type { MailboxMembership } from "inbox-sdk/types";
import { configurePerformanceLogging, measureRequest } from "./browser-logs";
export type SavedSplitPreferences = SplitPreferences & { revision: number };
export type AttentionFeedback = { id: string; createdAt: string; status: "pending" | "active" | "retracting" | "retracted" | "failed"; count: number; problem?: string; states?: MailboxMembership[] };
export type AttentionFeedbackTarget = { sourceId: string; messageId: string; mailboxId: string; messageRevision: number; revision: number };

export type HostProvider = {
  id: string;
  name: string;
  connection: "oauth" | "credentials" | "none";
  enabled: boolean;
  ready: boolean;
  setupMessage?: string;
  actionLabel?: string;
  fields?: Array<{ name: string; label: string; type: "password" | "text" | "email" | "select"; required: boolean; advanced?: boolean; defaultValue?: string; options?: Array<{ value: string; label: string }> }>;
  mailboxSelection?: "automatic" | "manual";
  credentialHelp?: { text: string; url: string };
  reconnect?: boolean;
  connectionIds: string[];
};

export type HostConfiguration = {
  mode: "mock" | "real";
  allowProviderWrites: boolean;
  preferenceScope?: string;
  performanceLogging?: boolean;
  providers: HostProvider[];
};

export type InboxViewPreferences = {
  revision: number;
  unifiedMode: "all" | "selected";
  includedMailboxIds: string[];
  pinnedMailboxIds: string[];
};

export class InboxViewPreferencesError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = "InboxViewPreferencesError";
  }
}

async function hostFetch(path: string, init: RequestInit): Promise<Response> {
  const finish = measureRequest(path, init.method ?? "GET");
  try { const response = await fetch(path, init); finish(response.status); return response; }
  catch (error) { finish(0); throw error; }
}

async function request<T>(path: string, signal: AbortSignal, credentials?: Record<string, string>): Promise<T> {
  const response = await hostFetch(path, {
    method: credentials === undefined ? "GET" : "POST",
    credentials: "include", cache: "no-store", signal,
    ...(credentials === undefined ? {} : {
      headers: { "Content-Type": "application/json", "X-Superlocal": "1" },
      body: JSON.stringify(Object.keys(credentials).length ? { credentials } : {}),
    }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof result?.error === "string" ? result.error : "The host could not complete account setup.");
  if (!result || typeof result !== "object") throw new Error("The host returned an invalid setup response.");
  return result as T;
}

export async function readHostConfiguration(signal: AbortSignal): Promise<HostConfiguration> {
  const config = await request<HostConfiguration>("/host/config", signal);
  if (!["mock", "real"].includes(config.mode) || typeof config.allowProviderWrites !== "boolean" || !Array.isArray(config.providers)) {
    throw new Error("The host did not provide a valid provider configuration.");
  }
  configurePerformanceLogging(config.performanceLogging === true);
  return config;
}

export function connectHostProvider(id: string, credentials: Record<string, string>, signal: AbortSignal, connectionId?: string) {
  return request<{ connectionId?: string; authorizeUrl?: string }>(`/host/providers/${encodeURIComponent(id)}/${connectionId ? `connections/${encodeURIComponent(connectionId)}/reconnect` : "connect"}`, signal, credentials);
}

function isInboxViewPreferences(value: unknown): value is InboxViewPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const fields = ["revision", "unifiedMode", "includedMailboxIds", "pinnedMailboxIds"];
  const ids = (value: unknown, maximum: number) => Array.isArray(value) && value.length <= maximum &&
    value.every(id => typeof id === "string" && id.length > 0 && id.length <= 512 && id.trim() === id && !/[\x00-\x1f\x7f/\\]/.test(id)) && new Set(value).size === value.length;
  return Object.keys(input).length === fields.length && Object.keys(input).every(key => fields.includes(key)) &&
    typeof input.revision === "number" && Number.isSafeInteger(input.revision) && input.revision >= 1 &&
    (input.unifiedMode === "all" || input.unifiedMode === "selected") && ids(input.includedMailboxIds, 5000) && ids(input.pinnedMailboxIds, 9);
}

async function requestInboxViewPreferences(signal: AbortSignal, input?: InboxViewPreferences): Promise<InboxViewPreferences> {
  const response = await hostFetch("/host/inbox-preferences", {
    method: input === undefined ? "GET" : "PUT",
    credentials: "include", cache: "no-store", signal,
    ...(input === undefined ? {} : {
      headers: { "Content-Type": "application/json", "X-Superlocal": "1" },
      body: JSON.stringify(input),
    }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof result?.code === "string" && /^HOST_[A-Z_]{1,80}$/.test(result.code) ? result.code : "HOST_REQUEST_FAILED";
    const fallback = response.status === 412 ? "Inbox preferences changed elsewhere. Reload them before saving again." : "The host could not update inbox preferences.";
    throw new InboxViewPreferencesError(typeof result?.error === "string" && result.error.length <= 512 ? result.error : fallback, response.status, code);
  }
  if (!isInboxViewPreferences(result)) throw new InboxViewPreferencesError("The host returned invalid inbox preferences.", response.status, "HOST_INBOX_PREFERENCES_INVALID_RESPONSE");
  return result;
}

export function readInboxViewPreferences(signal: AbortSignal): Promise<InboxViewPreferences> {
  return requestInboxViewPreferences(signal);
}

export function writeInboxViewPreferences(input: InboxViewPreferences, signal: AbortSignal): Promise<InboxViewPreferences> {
  return requestInboxViewPreferences(signal, input);
}

async function appRequest<T>(path: string, signal: AbortSignal, method = "GET", input?: unknown): Promise<T> {
  const response = await hostFetch(path, { method, signal, credentials: "include", cache: "no-store",
    ...(method === "GET" ? {} : { headers: { "Content-Type": "application/json", "X-Superlocal": "1" }, body: JSON.stringify(input ?? {}) }) });
  const result = await response.json();
  if (!response.ok) throw new InboxViewPreferencesError(typeof result?.error === "string" ? result.error : "The host could not save this action.", response.status, result?.code ?? "HOST_REQUEST_FAILED");
  return result as T;
}
export const readSplitPreferences = (signal: AbortSignal) => appRequest<SavedSplitPreferences | null>("/host/split-preferences", signal);
export const writeSplitPreferences = (input: SavedSplitPreferences, signal: AbortSignal) => appRequest<SavedSplitPreferences>("/host/split-preferences", signal, "PUT", input);
export const readAttentionFeedback = (signal: AbortSignal) => appRequest<AttentionFeedback[]>("/host/attention-feedback", signal);
export async function recordAttentionFeedback(input: { id: string; targets: AttentionFeedbackTarget[] }, signal: AbortSignal): Promise<AttentionFeedback> {
  // A lost response must retry the same durable ID, never create another label.
  try { return await appRequest<AttentionFeedback>("/host/attention-feedback", signal, "POST", input); }
  catch (error) {
    if (signal.aborted || error instanceof InboxViewPreferencesError && error.status < 500) throw error;
    return appRequest<AttentionFeedback>("/host/attention-feedback", signal, "POST", input);
  }
}
export const retractAttentionFeedback = (id: string, signal: AbortSignal) => appRequest<AttentionFeedback>(`/host/attention-feedback/${encodeURIComponent(id)}/undo`, signal, "POST");
