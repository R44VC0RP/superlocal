import type { SplitPreferences } from "../../shared/splits";
import type { MailboxMembership } from "inbox-sdk/types";
import { configurePerformanceLogging, measureRequest } from "./browser-logs";
import { privateFetch } from "./application-auth";
import type { AiTriageActions, AiTriageState, AiDecisionPage, AiHistoryJob, AiDecision } from "../../shared/ai-triage";
import { CATEGORY_BATCH_LIMIT, CATEGORY_RESPONSE_LIMIT, categoryErrorMessages, isCategoryEntry, type CategoryErrorCode, type CategoryEntry, type CategoryPage, type CategoryReceipt, type CategoryTransport } from "../../shared/attention-overrides";
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
  aiTriage?: boolean;
  attentionOverrides?: boolean;
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
  try { const response = await privateFetch(path, init); finish(response.status); return response; }
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

export class CategoryRequestError extends InboxViewPreferencesError {
  declare readonly code: CategoryErrorCode;
  constructor(code: CategoryErrorCode, status: number) { super(categoryErrorMessages[code], status, code); }
}

/** Local choices use the store's immutable owner transport, never AI settings. */
export function createCategoryTransport(signal: () => AbortSignal, fetcher: typeof privateFetch = privateFetch): CategoryTransport {
  async function call(path: string, method = "GET", input?: unknown): Promise<Record<string, unknown>> {
    const requestSignal = signal(), finish = measureRequest(`/host/attention-overrides${path}`, method);
    let response: Response;
    try {
      response = await fetcher(`/host/attention-overrides${path}`, { method, signal: requestSignal, credentials: "include", cache: "no-store",
        ...(method === "GET" ? {} : { headers: { "Content-Type": "application/json", "X-Superlocal": "1" }, body: JSON.stringify(input ?? {}) }) });
      finish(response.status);
    } catch (error) { finish(0); throw error; }
    const text = await response.text(); requestSignal.throwIfAborted();
    if (new TextEncoder().encode(text).length > CATEGORY_RESPONSE_LIMIT) throw new CategoryRequestError("HOST_CATEGORY_UNAVAILABLE", 503);
    const result = (() => { try { return JSON.parse(text); } catch { return null; } })();
    if (!response.ok) {
      const code = result && typeof result.code === "string" && Object.hasOwn(categoryErrorMessages, result.code) ? result.code as CategoryErrorCode : "HOST_CATEGORY_UNAVAILABLE";
      throw new CategoryRequestError(code, response.status);
    }
    if (!result || typeof result !== "object" || Array.isArray(result) || !Array.isArray(result.entries) || result.entries.length > CATEGORY_BATCH_LIMIT || !result.entries.every(isCategoryEntry)) throw new CategoryRequestError("HOST_CATEGORY_UNAVAILABLE", 503);
    return result;
  }
  const receipt = async (path: string, id: string, input?: unknown): Promise<CategoryReceipt> => {
    const result = await call(path, "POST", input);
    if (result.id !== id || typeof result.retracted !== "boolean" || !(result.entries as unknown[]).length) throw new CategoryRequestError("HOST_CATEGORY_UNAVAILABLE", 503);
    return result as CategoryReceipt;
  };
  return {
    changes: async after => {
      const result = await call(`?after=${after}`);
      if (!Number.isSafeInteger(result.cursor) || Number(result.cursor) < 0 || typeof result.hasMore !== "boolean" || typeof result.resetRequired !== "boolean") throw new CategoryRequestError("HOST_CATEGORY_UNAVAILABLE", 503);
      return result as CategoryPage;
    },
    lookup: async keys => {
      const result = await call("/lookup", "POST", { keys });
      return { entries: result.entries as CategoryEntry[] };
    },
    classify: input => receipt("", input.id, input),
    undo: id => receipt(`/${encodeURIComponent(id)}/undo`, id),
  };
}

/** Each store supplies its immutable owner transport and current abort signal. */
export function createAiTriageClient(signal: () => AbortSignal, fetcher: typeof privateFetch = privateFetch): AiTriageActions {
  async function call<T>(path: string, method = "GET", input?: unknown): Promise<T> {
    const requestSignal = signal();
    const finish = measureRequest(`/host/ai-triage${path}`, method);
    let response: Response;
    try {
      response = await fetcher(`/host/ai-triage${path}`, { method, signal: requestSignal, credentials: "include", cache: "no-store",
        ...(method === "GET" ? {} : { headers: { "Content-Type": "application/json", "X-Superlocal": "1" }, body: JSON.stringify(input ?? {}) }) });
      finish(response.status);
    } catch (error) { finish(0); throw error; }
    const result = await response.json().catch(() => null);
    requestSignal.throwIfAborted();
    if (!response.ok || result === null || typeof result !== "object") {
      const code = typeof result?.code === "string" && /^(?:AI_|HOST_)[A-Z_]{1,80}$/.test(result.code) ? result.code : "AI_REQUEST_FAILED";
      const text = response.status === 412 ? "AI triage changed elsewhere. Reload before saving again."
        : response.status === 429 ? "AI triage is at capacity. Existing mail is still available; try again later."
        : response.status === 409 ? "This AI triage action is not available in the current state. Reload its settings."
        : "AI triage could not complete this request. Your mail has not been changed.";
      throw new InboxViewPreferencesError(text, response.status, code);
    }
    return result as T;
  }
  return {
    state: () => call<AiTriageState>(""),
    configure: input => call<AiTriageState>("/settings", "PATCH", input),
    process: input => call<AiHistoryJob>("/process", "POST", input),
    control: (id, action) => call<AiHistoryJob>(`/jobs/${encodeURIComponent(id)}`, "POST", { action }),
    lookup: keys => call<AiDecisionPage>("/lookup", "POST", { keys }),
    changes: after => call<AiDecisionPage>(`/changes?after=${encodeURIComponent(after)}`),
    results: after => call<AiDecisionPage>(after === undefined ? "/results" : `/results?after=${encodeURIComponent(after)}`),
    feedback: input => call<AiDecision>("/feedback", "POST", input),
    reading: async input => { await call("/reading", "POST", input); },
    clearReading: async () => { await call("/reading", "DELETE"); },
    diagnostics: () => call<Awaited<ReturnType<AiTriageActions["diagnostics"]>>>("/diagnostics"),
  };
}
