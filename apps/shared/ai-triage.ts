/** Application-owned triage. These are not provider flags or permission grants. */
export const AI_TRIAGE_VERSION = "triage-2";
export const AI_INPUT_POLICY_VERSION = "input-3";
export const AI_PREFERENCE_VERSION = "preference-3";
export const aiKinds = ["conversation", "request", "notification", "invoice", "receipt", "newsletter", "promotion", "cold_outreach", "invitation", "other", "unknown"] as const;
export const aiResponses = ["needed", "optional", "not_needed", "waiting", "unknown"] as const;
export const aiTasks = ["required", "optional", "none", "unknown"] as const;
export const aiActions = ["reply", "review", "approve", "confirm", "attend", "investigate", "payment_requested", "other"] as const;
export const aiUrgencies = ["immediate", "deadline", "routine", "none", "unknown"] as const;
export const aiRisks = ["none_observed", "unsolicited", "spam_suspected", "phishing_suspected", "unknown"] as const;
export type AiCategory = "Important" | "Other";
export type AiAssessment = {
  type: typeof aiKinds[number];
  response: typeof aiResponses[number];
  /** Outstanding work beyond an email reply; absent only on retained legacy assessments. */
  task?: typeof aiTasks[number];
  actions: Array<typeof aiActions[number]>;
  urgency: typeof aiUrgencies[number];
  /** Only an explicitly supported absolute deadline; otherwise null. */
  deadline: string | null;
  topics: string[];
  risk: typeof aiRisks[number];
  certainty: "clear" | "ambiguous" | "insufficient";
  reason: string;
  /** Private decision evidence, never general diagnostic-log fields. */
  evidence: Array<{ messageRef: string; quote: string; field: "response" | "task" | "action" | "urgency" | "risk" | "type" }>;
};
export type AiTriageInput = {
  observedAt: string;
  messages: Array<{
    ref: string;
    direction: "incoming" | "outgoing";
    toSelf: boolean;
    receivedAt: string;
    subject: string;
    text: string;
    truncated: boolean;
    facts?: { reply?: boolean; bulk?: boolean; listUnsubscribe?: boolean; listId?: boolean; nativeCategories?: string[] };
  }>;
};
export type AiTokenUsage = {
  input: number | null;
  output: number | null;
  total: number | null;
  cachedInput: number | null;
  cacheWriteInput: number | null;
  /** Included in output, never added again for pricing. */
  reasoningOutput: number | null;
};
export type AiRateCard = {
  version: string;
  source: string;
  currency: "USD";
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion: number | null;
  cacheWriteInputPerMillion: number | null;
};
export type AiCostEstimate = {
  minimumUsd: number;
  maximumUsd: number;
  complete: boolean;
  rate: AiRateCard;
};
export type AiInferenceResult = {
  outcome: "completed" | "refused" | "incomplete" | "invalid" | "error" | "aborted";
  assessment: AiAssessment | null;
  code: string | null;
  retryable: boolean;
  retryAfterMs: number | null;
  requestedModel: string;
  returnedModel: string | null;
  requestId: string | null;
  responseId: string | null;
  durationMs: number;
  httpStatus: number | null;
  usage: AiTokenUsage;
  estimate: AiCostEstimate | null;
};
export type AiModel = { id: string; label: string; pricing: AiRateCard | null };
export type AiSettings = {
  revision: number;
  enabled: boolean;
  mode: "preview" | "apply";
  model: string;
  /** null includes all active owned mailboxes; [] deliberately includes none. */
  mailboxIds: string[] | null;
  personalization: boolean;
  readingSignals: boolean;
  /** Explicit local interests, not instructions sent to inference. */
  interests: string[];
};
export type AiScoreSignals = {
  correspondenceDays: number;
  readingSeconds: number;
  explicitAffinity: number;
  interestMatches: number;
  learnedTopicAffinity: number;
};
export type AiScore = {
  category: AiCategory;
  score: number;
  reasons: string[];
  contributions: Array<{ name: string; value: number }>;
  version: string;
};
export type AiThreadKey = { sourceId: string; threadId: string };
export type AiDecision = AiThreadKey & {
  revision: number;
  settingsRevision: number;
  state: "pending" | "processing" | "ready" | "failed" | "stale";
  mailboxIds: string[];
  messageIds: string[];
  contextVersions: Array<{ messageId: string; bodyRevision: string | null }>;
  latestMessageId: string;
  inputHash: string | null;
  model: string;
  schemaVersion: string;
  /** Policy used for the saved inference; absent on legacy or uninferred decisions. */
  inputPolicyVersion?: string;
  updatedAt: string;
  /** Only new-arrival presentation may wait until this deadline, never startup. */
  holdUntil: string | null;
  assessment: AiAssessment | null;
  score: AiScore | null;
  override: { category: AiCategory; inputHash: string; at: string } | null;
  problemCode: string | null;
};
export type AiHistoryJob = {
  id: string;
  status: "running" | "paused" | "completed" | "cancelled" | "failed";
  scope: "inbox" | "all";
  limit: number;
  /** Captured configuration consent; absent only on retained older jobs. */
  settingsRevision?: number;
  scanned: number;
  queued: number;
  completed: number;
  failed: number;
  createdAt: string;
  problemCode: string | null;
};
export type AiUsageSummary = {
  attempts: number;
  completed: number;
  failed: number;
  reused: number;
  unknownUsage: number;
  unpriced: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  reasoningOutputTokens: number;
  estimatedMinimumUsd: number;
  estimatedMaximumUsd: number;
};
export type AiDiagnosticAttempt = AiThreadKey & {
  id: string;
  at: string;
  finishedAt: string | null;
  lane: "incoming" | "history";
  outcome: string;
  code: string | null;
  model: string;
  queueMs: number;
  durationMs: number | null;
  httpStatus: number | null;
  requestId: string | null;
  responseId: string | null;
  usage: AiTokenUsage | null;
  estimate: AiCostEstimate | null;
};
export const aiActivityReasons = ["queued", "processing", "ready", "failed", "stale", "removed", "cache_reused", "feedback", "rescored", "historical_no_prior", "inactive_membership", "outgoing_no_prior", "unavailable", "recovery_historical", "drain_error"] as const;
export type AiActivityReason = typeof aiActivityReasons[number];
/** Bounded private trace. No free-form assessment text or evidence quotes. */
export type AiDiagnosticActivity = AiThreadKey & {
  id: number;
  at: string;
  reason: AiActivityReason;
  eventReason?: "arrival" | "initial" | "backfill" | "mutation";
  /** Only fixed host/inference codes, never arbitrary error text. */
  problemCode?: string;
  state?: AiDecision["state"];
  revision?: number;
  model?: string;
  settingsRevision?: number;
  schemaVersion?: string;
  inputPolicyVersion?: string;
  scorePolicyVersion?: string;
  inputHash?: string;
  manual?: boolean;
  category?: AiCategory;
  score?: number;
  assessment?: Pick<AiAssessment, "type" | "response" | "actions" | "urgency" | "risk" | "certainty"> & {
    task?: "required" | "optional" | "none" | "unknown";
    hasDeadline: boolean;
    evidence: Array<{ messageRef: string; field: "response" | "action" | "urgency" | "risk" | "type" | "task" }>;
    evidenceCount: number;
  };
  contributions?: Array<{ name: string; value: number }>;
};
export type AiDiagnosticCoverage = {
  /** Prospective boundary, not the timestamp of a past inferred consent. */
  admissionSince: string | null;
  lastDrainAt: string | null;
  problemCode: string | null;
  /** Durable event counts, not unique-message coverage. */
  counts: Partial<Record<AiActivityReason, number>>;
};
export type AiDiagnostics = {
  usage: AiUsageSummary;
  attempts: AiDiagnosticAttempt[];
  /** Optional for older injected clients; the current host always returns these. */
  activity?: AiDiagnosticActivity[];
  coverage?: AiDiagnosticCoverage;
};
export type AiTriageState = {
  configured: boolean;
  provider: { name: string; endpointHost: string; models: AiModel[] } | null;
  problemCode: string | null;
  settings: AiSettings;
  queue: { pending: number; processing: number; failed: number };
  usage: AiUsageSummary;
  jobs: AiHistoryJob[];
  cursor: number;
};
export function aiSortingStatus(state: AiTriageState | null, unavailable = false): { tone: "normal" | "warning"; label: string; detail?: string } {
  if (unavailable) return { tone: "warning", label: "Sorting status unavailable", detail: "Current sorting could not be checked. Existing mail stays available." };
  if (!state) return { tone: "normal", label: "Checking automatic sorting…" };
  if (!state.configured) return { tone: "warning", label: "Automatic sorting unavailable", detail: "The mail host needs its AI connection configured. Normal inbox rules are in use." };
  if (!state.settings.enabled) return { tone: "normal", label: "Automatic sorting off" };
  if (state.settings.mailboxIds?.length === 0) return { tone: "warning", label: "No mailboxes selected", detail: "Choose a mailbox in Advanced options to start sorting." };
  if (state.problemCode) return { tone: "warning", label: "Automatic sorting needs attention", detail: state.problemCode === "AI_MODEL_UNAVAILABLE" ? "The configured model is unavailable. Choose an available model in Advanced options." : "Some mail may not have a current assessment. Existing mail stays available; check sorting details for the recorded problem." };
  if (state.queue.failed > 0) return { tone: "warning", label: "Some mail could not be sorted", detail: "Those conversations use normal inbox rules until a new assessment is available." };
  if (state.settings.mode !== "apply") return { tone: "normal", label: "Preview only", detail: "Assessments are not changing Important or Other." };
  return { tone: "normal", label: state.queue.processing || state.queue.pending ? "Sorting new activity…" : "Automatic sorting on" };
}

export type AiDecisionPage = { decisions: AiDecision[]; removed: AiThreadKey[]; cursor: number; hasMore: boolean; resetRequired: boolean };
export type AiFeedbackInput = AiThreadKey & { id: string; revision: number; category: AiCategory | null; note?: string };
export type AiReadingInput = AiThreadKey & { visitId: string; sequence: number; messageId: string; activeMs: number };

/** UI adapter; credentials and raw inference responses are never part of it. */
export type AiTriageActions = {
  state(): Promise<AiTriageState>;
  configure(input: AiSettings): Promise<AiTriageState>;
  process(input: { id: string; scope: "inbox" | "all"; limit: number; settingsRevision?: number }): Promise<AiHistoryJob>;
  control(id: string, action: "pause" | "resume" | "cancel"): Promise<AiHistoryJob>;
  lookup(keys: AiThreadKey[]): Promise<AiDecisionPage>;
  changes(after: number): Promise<AiDecisionPage>;
  results(after?: number): Promise<AiDecisionPage>;
  feedback(input: AiFeedbackInput): Promise<AiDecision>;
  reading(input: AiReadingInput): Promise<void>;
  clearReading(): Promise<void>;
  diagnostics(): Promise<AiDiagnostics>;
};
