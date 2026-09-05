import type { Database } from 'bun:sqlite'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { InboxError, type Inbox, type Mailbox, type Message, type MessageSummary } from 'inbox-sdk'
import { AI_INPUT_POLICY_VERSION, AI_TRIAGE_VERSION, AI_PREFERENCE_VERSION, aiKinds, aiResponses, aiActions, aiUrgencies, aiRisks, aiActivityReasons, type AiActivityReason, type AiAssessment, type AiDecision, type AiDecisionPage, type AiDiagnosticActivity, type AiDiagnosticAttempt, type AiDiagnostics, type AiFeedbackInput, type AiHistoryJob, type AiInferenceResult, type AiReadingInput, type AiSettings, type AiThreadKey, type AiTriageInput, type AiTriageState, type AiUsageSummary } from '../../shared/ai-triage'
import { inferAiTriage, prepareAiText, publicAiProvider, type AiInferenceConfig } from './ai-inference'
import { countAiTopicMatches, normalizeAiTopics, scoreAiTriage } from './ai-preferences'

type Options = { database: Database; inbox: Inbox; configuration: AiInferenceConfig | null; configurationProblem?: string; sessionKey: string | Uint8Array; now?: () => number; fetcher?: typeof fetch }
type SettingsRow = { owner: string; data: string; generation: number; cursor: string | null; baseline: number; admission_since: number }
type CoverageRow = { counts: string; last_drain: number | null; problem: string | null }
type EventReason = NonNullable<AiDiagnosticActivity['eventReason']>
type QueueRow = { owner: string; source: string; thread: string; fingerprint: string; generation: number; lane: 'incoming' | 'history'; queued: number; due: number; attempts: number; status: string; job: string | null; previous: string | null }
type DecisionRow = { data: string; fingerprint: string; sender: string; seq: number }
type JobRow = { owner: string; id: string; data: string; generation: number; boxes: string; enumerated: number; bytes: number; examined: number; input_policy: string }
type RecoveryRow = { owner: string; generation: number; baseline: number; target: string; boxes: string; status: string; problem: string | null; examined: number; bytes: number; restarts: number }
type RescoreRow = { owner: string; token: string; revision: number; through: number; after: number; stale: number; force: number; problem: string | null }
type AffinityVote = { sender: string; topics: string; choice: number; at: number }
type BoundMessage = Message & { sourceId: string; memberships: Array<{ mailboxId: string; done: boolean; snoozedUntil: string | null }> }
type Scope = { boxes: Mailbox[]; addresses: Set<string>; sent: Set<string> }
type Context = { input: AiTriageInput; fingerprint: string; hash: string; legacyHash: string; messages: BoundMessage[]; boxes: string[]; versions: AiDecision['contextVersions']; sender: string; insufficient: boolean }
const QUEUE_LIMIT = 10032
const HISTORY_LIMIT = 10000
const RETAIN = 100000
const GLOBAL_QUEUE_LIMIT = 20064
const GLOBAL_RETAIN = 500000
const DAY = 86_400_000
const idOK = (value: unknown): value is string => typeof value === 'string' && /^[^\s\x00-\x1f\x7f]{1,512}$/.test(value)
const commandOK = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9:_-]{8,100}$/.test(value)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const emptyUsage = (): AiUsageSummary => ({ attempts: 0, completed: 0, failed: 0, reused: 0, unknownUsage: 0, unpriced: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0, estimatedMinimumUsd: 0, estimatedMaximumUsd: 0 })
const insufficient: AiAssessment = { type: 'unknown', response: 'unknown', task: 'unknown', actions: [], urgency: 'unknown', deadline: null, topics: [], risk: 'unknown', certainty: 'insufficient', reason: 'Not enough usable cached context.', evidence: [] }
function fail(code: string, status = 400): never { throw new InboxError(code, 'AI triage could not complete this request.', status) }
const stamp = (time: number) => new Date(time).toISOString()
const quietCampaign = (assessment: AiAssessment) =>
  ['promotion', 'newsletter', 'cold_outreach'].includes(assessment.type) && assessment.response === 'not_needed' &&
  (assessment.task === undefined || assessment.task === 'none') && assessment.actions.length === 0 && assessment.urgency === 'none' && assessment.deadline === null &&
  assessment.risk === 'none_observed' && assessment.evidence.some(item => item.field === 'type')
const legacyCampaign = (assessment: AiAssessment | null, policy?: string) =>
  (!policy || policy === 'input-1') && assessment?.certainty === 'insufficient' && quietCampaign(assessment)
const reusableDecision = (decision: AiDecision, model: string, refreshLegacy: boolean) =>
  decision.state === 'ready' && decision.model === model &&
  !(refreshLegacy && !decision.override && legacyCampaign(decision.assessment, decision.inputPolicyVersion))

/** Host-owned, opt-in projection. Every mail read goes through the owner-scoped public SDK. */
export function createAiTriageService({ database: db, inbox, configuration, configurationProblem, sessionKey, now = Date.now, fetcher }: Options) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_ai_settings (owner TEXT PRIMARY KEY, data TEXT NOT NULL, generation INTEGER NOT NULL, cursor TEXT, baseline INTEGER NOT NULL, admission_since INTEGER NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS local_ai_activity (seq INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, data TEXT NOT NULL) STRICT;
    CREATE INDEX IF NOT EXISTS local_ai_activity_owner ON local_ai_activity(owner,seq);
    CREATE TABLE IF NOT EXISTS local_ai_coverage (owner TEXT PRIMARY KEY, counts TEXT NOT NULL DEFAULT '{}', last_drain INTEGER, problem TEXT, retained INTEGER NOT NULL DEFAULT 0 CHECK(retained>=0)) STRICT;
    CREATE TABLE IF NOT EXISTS local_ai_usage (owner TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS local_ai_decisions (owner TEXT NOT NULL, source TEXT NOT NULL, thread TEXT NOT NULL, data TEXT NOT NULL, fingerprint TEXT NOT NULL, sender TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY(owner,source,thread)) STRICT;
    CREATE INDEX IF NOT EXISTS local_ai_decisions_seq ON local_ai_decisions(owner,seq);
    CREATE INDEX IF NOT EXISTS local_ai_decisions_global_seq ON local_ai_decisions(seq);
    CREATE INDEX IF NOT EXISTS local_ai_decisions_status ON local_ai_decisions(owner,json_extract(data,'$.state'));
    CREATE INDEX IF NOT EXISTS local_ai_decisions_holds ON local_ai_decisions(owner) WHERE json_extract(data,'$.holdUntil') IS NOT NULL;
    CREATE TABLE IF NOT EXISTS local_ai_message_refs (owner TEXT NOT NULL, message TEXT NOT NULL, source TEXT NOT NULL, thread TEXT NOT NULL, PRIMARY KEY(owner,message,source,thread)) STRICT;
    CREATE INDEX IF NOT EXISTS local_ai_message_refs_thread ON local_ai_message_refs(owner,source,thread);
    CREATE TABLE IF NOT EXISTS local_ai_cache (owner TEXT NOT NULL, hash TEXT NOT NULL, assessment TEXT NOT NULL, at INTEGER NOT NULL, input_policy TEXT NOT NULL DEFAULT 'input-1', PRIMARY KEY(owner,hash)) STRICT;
    CREATE INDEX IF NOT EXISTS local_ai_cache_at ON local_ai_cache(owner,at);
    CREATE TABLE IF NOT EXISTS local_ai_counts (owner TEXT PRIMARY KEY, decisions INTEGER NOT NULL DEFAULT 0, events INTEGER NOT NULL DEFAULT 0, cache INTEGER NOT NULL DEFAULT 0) STRICT;
    CREATE TABLE IF NOT EXISTS local_ai_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, source TEXT NOT NULL, thread TEXT NOT NULL, removed INTEGER NOT NULL) STRICT;
    CREATE INDEX IF NOT EXISTS local_ai_events_owner ON local_ai_events(owner,seq);
    CREATE TABLE IF NOT EXISTS local_ai_cursor (owner TEXT PRIMARY KEY, head INTEGER NOT NULL DEFAULT 0, floor INTEGER NOT NULL DEFAULT 0) STRICT;
    CREATE TABLE IF NOT EXISTS local_ai_queue (owner TEXT NOT NULL, source TEXT NOT NULL, thread TEXT NOT NULL, fingerprint TEXT NOT NULL, generation INTEGER NOT NULL, lane TEXT NOT NULL, queued INTEGER NOT NULL, due INTEGER NOT NULL, attempts INTEGER NOT NULL, status TEXT NOT NULL, job TEXT, previous TEXT, PRIMARY KEY(owner,source,thread)) STRICT;
    CREATE INDEX IF NOT EXISTS local_ai_queue_due ON local_ai_queue(status,due,lane,queued);
    CREATE INDEX IF NOT EXISTS local_ai_queue_ready ON local_ai_queue(CASE lane WHEN 'incoming' THEN 0 ELSE 1 END,queued) WHERE status='queued';
    CREATE INDEX IF NOT EXISTS local_ai_queue_owner ON local_ai_queue(owner,status);
    CREATE TABLE IF NOT EXISTS local_ai_queue_counts (owner TEXT PRIMARY KEY, queued INTEGER NOT NULL CHECK(queued>=0)) STRICT;
    CREATE TABLE IF NOT EXISTS local_ai_migrations (name TEXT PRIMARY KEY) STRICT;
    CREATE TABLE IF NOT EXISTS local_ai_rescore (owner TEXT PRIMARY KEY, token TEXT NOT NULL, revision INTEGER NOT NULL, through INTEGER NOT NULL, after INTEGER NOT NULL, stale INTEGER NOT NULL, force INTEGER NOT NULL, problem TEXT) STRICT;
    CREATE TABLE IF NOT EXISTS local_ai_settings_fence (owner TEXT PRIMARY KEY, revision INTEGER NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS local_ai_global (id INTEGER PRIMARY KEY CHECK(id=1), queued INTEGER NOT NULL, decisions INTEGER NOT NULL) STRICT;
    INSERT OR IGNORE INTO local_ai_global SELECT 1,(SELECT COUNT(*) FROM local_ai_queue),(SELECT COUNT(*) FROM local_ai_decisions) WHERE NOT EXISTS (SELECT 1 FROM local_ai_global WHERE id=1);
    CREATE TRIGGER IF NOT EXISTS local_ai_queue_added AFTER INSERT ON local_ai_queue BEGIN UPDATE local_ai_global SET queued=queued+1 WHERE id=1; END;
    CREATE TRIGGER IF NOT EXISTS local_ai_queue_removed AFTER DELETE ON local_ai_queue BEGIN UPDATE local_ai_global SET queued=queued-1 WHERE id=1; END;
    CREATE TRIGGER IF NOT EXISTS local_ai_decision_added AFTER INSERT ON local_ai_decisions BEGIN UPDATE local_ai_global SET decisions=decisions+1 WHERE id=1; END;
    CREATE TRIGGER IF NOT EXISTS local_ai_decision_removed AFTER DELETE ON local_ai_decisions BEGIN UPDATE local_ai_global SET decisions=decisions-1 WHERE id=1; END;
    CREATE TABLE IF NOT EXISTS local_ai_jobs (owner TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, generation INTEGER NOT NULL, boxes TEXT NOT NULL, enumerated INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0, input_policy TEXT NOT NULL DEFAULT 'input-1', PRIMARY KEY(owner,id)) STRICT;
    CREATE TABLE IF NOT EXISTS local_ai_job_items (owner TEXT NOT NULL, job TEXT NOT NULL, source TEXT NOT NULL, thread TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY(owner,job,source,thread)) STRICT;
    CREATE INDEX IF NOT EXISTS local_ai_job_items_thread ON local_ai_job_items(owner,source,thread,status);
    CREATE TABLE IF NOT EXISTS local_ai_attempts (seq INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, id TEXT NOT NULL UNIQUE, data TEXT NOT NULL, config TEXT NOT NULL, finished INTEGER NOT NULL DEFAULT 0) STRICT;
    CREATE INDEX IF NOT EXISTS local_ai_attempts_owner ON local_ai_attempts(owner,seq);
    CREATE INDEX IF NOT EXISTS local_ai_attempts_unfinished ON local_ai_attempts(finished) WHERE finished=0;
    CREATE TABLE IF NOT EXISTS local_ai_feedback (seq INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, id TEXT NOT NULL, source TEXT NOT NULL, thread TEXT NOT NULL, hash TEXT NOT NULL, sender TEXT NOT NULL, topics TEXT NOT NULL, choice INTEGER NOT NULL, at INTEGER NOT NULL, input TEXT NOT NULL, result TEXT NOT NULL, note TEXT, UNIQUE(owner,id)) STRICT;
    CREATE INDEX IF NOT EXISTS local_ai_feedback_sender ON local_ai_feedback(owner,sender,at);
    CREATE INDEX IF NOT EXISTS local_ai_feedback_thread ON local_ai_feedback(owner,source,thread,seq);
    CREATE TABLE IF NOT EXISTS local_ai_correspondence (owner TEXT NOT NULL, message TEXT NOT NULL, recipient TEXT NOT NULL, day INTEGER NOT NULL, PRIMARY KEY(owner,message,recipient,day)) STRICT;
    CREATE INDEX IF NOT EXISTS local_ai_correspondence_sender ON local_ai_correspondence(owner,recipient,day);
    CREATE TABLE IF NOT EXISTS local_ai_reading (owner TEXT NOT NULL, sender TEXT NOT NULL, day INTEGER NOT NULL, ms INTEGER NOT NULL, PRIMARY KEY(owner,sender,day)) STRICT;
    CREATE TABLE IF NOT EXISTS local_ai_message_reading (owner TEXT NOT NULL, message TEXT NOT NULL, day INTEGER NOT NULL, ms INTEGER NOT NULL, PRIMARY KEY(owner,message,day)) STRICT;
    CREATE TABLE IF NOT EXISTS local_ai_visits (owner TEXT NOT NULL, id TEXT NOT NULL, message TEXT NOT NULL, sequence INTEGER NOT NULL, active INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(owner,id)) STRICT;
    CREATE TABLE IF NOT EXISTS local_ai_recovery (owner TEXT PRIMARY KEY, generation INTEGER NOT NULL, baseline INTEGER NOT NULL, target TEXT NOT NULL, boxes TEXT NOT NULL, status TEXT NOT NULL, problem TEXT, examined INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0, restarts INTEGER NOT NULL DEFAULT 0) STRICT;
    CREATE TABLE IF NOT EXISTS local_ai_recovery_seen (owner TEXT NOT NULL, message TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(owner,message)) STRICT;
    CREATE TABLE IF NOT EXISTS local_ai_recovery_global (id INTEGER PRIMARY KEY CHECK(id=1), seen INTEGER NOT NULL) STRICT;
    INSERT OR IGNORE INTO local_ai_recovery_global SELECT 1,COUNT(*) FROM local_ai_recovery_seen;
    CREATE TRIGGER IF NOT EXISTS local_ai_recovery_seen_added AFTER INSERT ON local_ai_recovery_seen BEGIN UPDATE local_ai_recovery_global SET seen=seen+1 WHERE id=1; END;
    CREATE TRIGGER IF NOT EXISTS local_ai_recovery_seen_removed AFTER DELETE ON local_ai_recovery_seen BEGIN UPDATE local_ai_recovery_global SET seen=seen-1 WHERE id=1; END;
  `)
  // Only host-owned schema is inspected. Existing durable queues survive this additive upgrade.
  db.transaction(() => {
    if (!db.query<{ name: string }, []>('PRAGMA table_info(local_ai_coverage)').all().some(column => column.name === 'retained')) db.exec('ALTER TABLE local_ai_coverage ADD COLUMN retained INTEGER NOT NULL DEFAULT 0 CHECK(retained>=0)')
    if (!db.query("SELECT 1 FROM local_ai_migrations WHERE name='activity-retained-counts-1'").get()) {
      db.exec('INSERT INTO local_ai_coverage(owner,retained) SELECT owner,COUNT(*) FROM local_ai_activity GROUP BY owner ON CONFLICT(owner) DO UPDATE SET retained=excluded.retained')
      db.exec("INSERT INTO local_ai_migrations VALUES ('activity-retained-counts-1')")
    }
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS local_ai_activity_added AFTER INSERT ON local_ai_activity BEGIN INSERT INTO local_ai_coverage(owner,retained) VALUES (NEW.owner,1) ON CONFLICT(owner) DO UPDATE SET retained=retained+1; END;
      CREATE TRIGGER IF NOT EXISTS local_ai_activity_removed AFTER DELETE ON local_ai_activity BEGIN UPDATE local_ai_coverage SET retained=retained-1 WHERE owner=OLD.owner; END;
    `)
  })()
  // Old moving watermarks cannot prove past consent. New admission starts prospectively.
  if (!db.query<{ name: string }, []>('PRAGMA table_info(local_ai_settings)').all().some(column => column.name === 'admission_since')) db.transaction(() => {
    db.exec('ALTER TABLE local_ai_settings ADD COLUMN admission_since INTEGER NOT NULL DEFAULT 0')
    db.query('UPDATE local_ai_settings SET admission_since=?').run(now())
  })()
  if (!db.query<{ name: string }, []>('PRAGMA table_info(local_ai_queue)').all().some(column => column.name === 'previous')) db.exec('ALTER TABLE local_ai_queue ADD COLUMN previous TEXT')
  if (!db.query<{ name: string }, []>('PRAGMA table_info(local_ai_cache)').all().some(column => column.name === 'input_policy')) db.exec("ALTER TABLE local_ai_cache ADD COLUMN input_policy TEXT NOT NULL DEFAULT 'input-1'")
  if (!db.query<{ name: string }, []>('PRAGMA table_info(local_ai_jobs)').all().some(column => column.name === 'input_policy')) db.exec("ALTER TABLE local_ai_jobs ADD COLUMN input_policy TEXT NOT NULL DEFAULT 'input-1'")
  if (!db.query<{ name: string }, []>('PRAGMA table_info(local_ai_message_refs)').all().some(column => column.name === 'fingerprint')) db.exec("ALTER TABLE local_ai_message_refs ADD COLUMN fingerprint TEXT NOT NULL DEFAULT ''")
  if (!db.query<{ name: string }, []>('PRAGMA table_info(local_ai_jobs)').all().some(column => column.name === 'examined')) db.exec('ALTER TABLE local_ai_jobs ADD COLUMN examined INTEGER NOT NULL DEFAULT 0')
  db.transaction(() => {
    if (!db.query("SELECT 1 FROM local_ai_migrations WHERE name='owner-queue-counts-1'").get()) {
      db.exec('INSERT INTO local_ai_queue_counts SELECT owner,COUNT(*) FROM local_ai_queue GROUP BY owner ON CONFLICT(owner) DO UPDATE SET queued=excluded.queued')
      db.exec("INSERT INTO local_ai_migrations VALUES ('owner-queue-counts-1')")
    }
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS local_ai_owner_queue_added AFTER INSERT ON local_ai_queue BEGIN INSERT INTO local_ai_queue_counts VALUES (NEW.owner,1) ON CONFLICT(owner) DO UPDATE SET queued=queued+1; END;
      CREATE TRIGGER IF NOT EXISTS local_ai_owner_queue_removed AFTER DELETE ON local_ai_queue BEGIN UPDATE local_ai_queue_counts SET queued=queued-1 WHERE owner=OLD.owner; END;
    `)
  })()
  let started = false, closed = false, pumping = false
  let timer: ReturnType<typeof setInterval> | undefined
  const subscriptions = new Map<string, () => void>()
  const locks = new Map<string, Promise<unknown>>()
  const active = new Map<string, { owner: string; job: string | null; controller: AbortController; task: Promise<void> }>()
  const inventories = new Set<string>()
  const recovering = new Set<string>()
  const rescoring = new Set<string>()
  const policyAfterRescore = new Set<string>()
  const recoveryPages = new Map<string, { cursor?: string; page?: Awaited<ReturnType<Inbox['mailboxSnapshot']>>; index: number }>()
  const work = new Set<Promise<unknown>>()
  const configVersion = digest(configuration ? { version: configuration.version, endpoint: configuration.endpoint, models: configuration.models, output: configuration.maxOutputTokens } : null)
  const hashIdentity = (owner: string, value: string) => createHmac('sha256', sessionKey).update(`${owner}\0${value.trim().toLowerCase()}`).digest('hex')
  const key = (owner: string, source: string, thread: string) => JSON.stringify([owner, source, thread])
  const transaction = <T>(fn: () => T) => db.transaction(fn)()
  const tracked = (promise: Promise<unknown>) => { work.add(promise); void promise.finally(() => work.delete(promise)).catch(() => {}); return promise }
  function serial<T>(owner: string, fn: () => Promise<T>): Promise<T> {
    if (closed) return Promise.reject(new InboxError('AI_CLOSED', 'AI triage is closed.', 503))
    const task = (locks.get(owner) ?? Promise.resolve()).catch(() => {}).then(fn)
    locks.set(owner, task)
    void task.finally(() => { if (locks.get(owner) === task) locks.delete(owner) }).catch(() => {})
    return task
  }
  const settingsStatement = db.prepare<SettingsRow, [string]>('SELECT * FROM local_ai_settings WHERE owner=?')
  const settingsRow = (owner: string) => settingsStatement.get(owner)
  const defaultSettings = (): AiSettings => ({ revision: 0, enabled: false, mode: 'preview', model: configuration?.defaultModel ?? '', mailboxIds: null, personalization: true, readingSignals: false, interests: [] })
  const settings = (owner: string): AiSettings => { const row = settingsRow(owner); return row ? JSON.parse(row.data) : defaultSettings() }
  const decisionStatement = db.prepare<DecisionRow, [string, string, string]>('SELECT data,fingerprint,sender,seq FROM local_ai_decisions WHERE owner=? AND source=? AND thread=?')
  const decisionRow = (owner: string, source: string, thread: string) => decisionStatement.get(owner, source, thread)
  const usage = (owner: string): AiUsageSummary => { const row = db.query<{ data: string }, [string]>('SELECT data FROM local_ai_usage WHERE owner=?').get(owner); return row ? JSON.parse(row.data) : emptyUsage() }
  function updateUsage(owner: string, mutate: (value: AiUsageSummary) => void) { const value = usage(owner); mutate(value); db.query('INSERT INTO local_ai_usage VALUES (?,?) ON CONFLICT(owner) DO UPDATE SET data=excluded.data').run(owner, JSON.stringify(value)) }
  function cursor(owner: string) { return db.query<{ head: number; floor: number }, [string]>('SELECT head,floor FROM local_ai_cursor WHERE owner=?').get(owner) ?? { head: 0, floor: 0 } }
  const activityProblems = new Set(['AI_INSUFFICIENT_CONTEXT', 'AI_RETRY_LIMIT', 'AI_CONTEXT_FAILED', 'AI_REQUEST_FAILED', 'AI_CONTEXT_CHANGED', 'AI_SETTINGS_CHANGED', 'AI_JOB_CANCELLED', 'AI_ASSESSMENT_FAILED', 'AI_INPUT_INVALID', 'AI_INPUT_LIMIT', 'AI_MODEL_NOT_ALLOWED', 'AI_RATE_LIMITED', 'AI_AUTH_FAILED', 'AI_PROVIDER_UNAVAILABLE', 'AI_HTTP_FAILED', 'AI_RESPONSE_LIMIT', 'AI_RESPONSE_INVALID', 'AI_RESPONSE_INCOMPLETE', 'AI_RESPONSE_FAILED', 'AI_RESPONSE_REFUSED', 'AI_ASSESSMENT_INVALID', 'AI_EVIDENCE_INVALID', 'AI_EVIDENCE_REQUIRED', 'AI_TIMEOUT', 'AI_ABORTED', 'AI_TRANSPORT_FAILED'])
  const contributionNames = new Set(['message_type', 'response', 'urgency', 'requested_actions', 'correspondence_days', 'active_reading', 'explicit_feedback', 'interests', 'topic_affinity', 'risk_gate', 'uncertainty_gate', 'actionability_gate', 'no_obligation_gate'])
  const member = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === 'string' && values.includes(value as T)
  // Keep fixed journal statements outside Bun's small shared query LRU. The
  // wider enqueue pipeline must not force SQL recompilation for every event.
  const journalStatements = {
    insert: db.prepare('INSERT INTO local_ai_activity(owner,data) VALUES (?,?)'),
    count: db.prepare("INSERT INTO local_ai_coverage(owner,counts) VALUES (?,json_object(?,?)) ON CONFLICT(owner) DO UPDATE SET counts=json_set(counts,?,COALESCE(json_extract(counts,?),0)+?)"),
    pruneOwner: db.prepare('DELETE FROM local_ai_activity WHERE seq IN (SELECT seq FROM local_ai_activity WHERE owner=? ORDER BY seq LIMIT MAX(0,(SELECT retained FROM local_ai_coverage WHERE owner=?)-2000))'),
    pruneGlobal: db.prepare('DELETE FROM local_ai_activity WHERE seq IN (SELECT seq FROM local_ai_activity ORDER BY seq LIMIT MAX(0,(SELECT COALESCE(SUM(retained),0) FROM local_ai_coverage)-10000))'),
  }
  function countActivity(owner: string, reason: AiActivityReason, amount = 1) {
    journalStatements.count.run(owner, reason, amount, `$.${reason}`, `$.${reason}`, amount)
  }
  function activity(owner: string, source: string, thread: string, reason: AiActivityReason, value?: AiDecision, eventReason?: EventReason) {
    // Only this explicit projection is durable. Never spread an assessment/provider object.
    const item: Omit<AiDiagnosticActivity, 'id'> = { sourceId: source, threadId: thread, at: stamp(now()), reason }
    if (eventReason) item.eventReason = eventReason
    if (value) {
      item.state = value.state; item.revision = value.revision; item.settingsRevision = value.settingsRevision; item.manual = !!value.override
      if (value.problemCode && activityProblems.has(value.problemCode)) item.problemCode = value.problemCode
      if (/^[a-zA-Z0-9._:/-]{1,200}$/.test(value.model)) item.model = value.model
      if (/^triage-[0-9]+$/.test(value.schemaVersion)) item.schemaVersion = value.schemaVersion
      if (value.inputPolicyVersion && /^input-[0-9]+$/.test(value.inputPolicyVersion)) item.inputPolicyVersion = value.inputPolicyVersion
      if (value.inputHash && /^[a-f0-9]{64}$/.test(value.inputHash)) item.inputHash = value.inputHash
      const grade = value.assessment
      if (grade && member(aiKinds, grade.type) && member(aiResponses, grade.response) && member(aiUrgencies, grade.urgency) && member(aiRisks, grade.risk) && member(['clear', 'ambiguous', 'insufficient'] as const, grade.certainty)) {
        item.assessment = { type: grade.type, response: grade.response, actions: grade.actions.filter(action => member(aiActions, action)).slice(0, 8), urgency: grade.urgency, risk: grade.risk, certainty: grade.certainty, hasDeadline: !!grade.deadline,
          evidence: grade.evidence.filter(proof => /^m[0-3]$/.test(proof.messageRef) && member(['response', 'action', 'urgency', 'risk', 'type', 'task'] as const, proof.field)).slice(0, 20).map(proof => ({ messageRef: proof.messageRef, field: proof.field })), evidenceCount: Math.min(20, grade.evidence.length) }
        if (member(['required', 'optional', 'none', 'unknown'] as const, grade.task)) item.assessment.task = grade.task
      }
      const scored = value.score
      if (scored && Number.isFinite(scored.score) && member(['Important', 'Other'] as const, scored.category)) {
        item.score = scored.score; item.category = scored.category
        if (/^preference-[0-9]+$/.test(scored.version)) item.scorePolicyVersion = scored.version
        item.contributions = scored.contributions.filter(part => contributionNames.has(part.name) && Number.isFinite(part.value)).slice(0, contributionNames.size).map(part => ({ name: part.name, value: part.value }))
      }
    }
    journalStatements.insert.run(owner, JSON.stringify(item))
    countActivity(owner, reason)
    // Trigger-maintained retained counts roll back with the journal. Delete only
    // the oldest excess rows; do not walk 2k/10k retained entries on every publish.
    // Summing the small owner ledger never scans message or journal payloads.
    journalStatements.pruneOwner.run(owner, owner)
    journalStatements.pruneGlobal.run()
  }
  function drained(owner: string, problem: string | null = null) {
    db.query('INSERT OR IGNORE INTO local_ai_coverage(owner) VALUES (?)').run(owner)
    if (problem) transaction(() => { countActivity(owner, 'drain_error'); db.query('UPDATE local_ai_coverage SET problem=? WHERE owner=?').run(problem, owner) })
    else db.query('UPDATE local_ai_coverage SET last_drain=?,problem=NULL WHERE owner=?').run(now(), owner)
  }
  function event(owner: string, source: string, thread: string, removed: boolean) {
    const seq = Number(db.query('INSERT INTO local_ai_events(owner,source,thread,removed) VALUES (?,?,?,?)').run(owner, source, thread, Number(removed)).lastInsertRowid)
    db.query('INSERT INTO local_ai_cursor(owner,head,floor) VALUES (?,?,0) ON CONFLICT(owner) DO UPDATE SET head=excluded.head').run(owner, seq)
    db.query('INSERT INTO local_ai_counts(owner,events) VALUES (?,1) ON CONFLICT(owner) DO UPDATE SET events=events+1').run(owner)
    if (db.query<{ events: number }, [string]>('SELECT events FROM local_ai_counts WHERE owner=?').get(owner)!.events > 10128) {
      const cutoff = db.query<{ seq: number }, [string]>('SELECT seq FROM local_ai_events WHERE owner=? ORDER BY seq DESC LIMIT 1 OFFSET 9999').get(owner)
      if (cutoff) { const deleted = db.query('DELETE FROM local_ai_events WHERE owner=? AND seq<?').run(owner, cutoff.seq).changes; db.query('UPDATE local_ai_cursor SET floor=MAX(floor,?) WHERE owner=?').run(cutoff.seq - 1, owner); db.query('UPDATE local_ai_counts SET events=events-? WHERE owner=?').run(deleted, owner) }
    }
    return seq
  }
  function publish(owner: string, value: AiDecision, fingerprint: string, sender: string, messages?: Array<Omit<MessageSummary, 'snoozedUntil'>>, reason?: AiActivityReason, eventReason?: EventReason) {
    const fresh = !decisionRow(owner, value.sourceId, value.threadId)
    const seq = event(owner, value.sourceId, value.threadId, false)
    // Revisions share the monotonic host sequence, including delete/recreate transitions.
    value.revision = seq
    activity(owner, value.sourceId, value.threadId, reason ?? (value.state === 'pending' ? 'queued' : value.state), value, eventReason)
    db.query('INSERT INTO local_ai_decisions VALUES (?,?,?,?,?,?,?) ON CONFLICT(owner,source,thread) DO UPDATE SET data=excluded.data,fingerprint=excluded.fingerprint,sender=excluded.sender,seq=excluded.seq').run(owner, value.sourceId, value.threadId, JSON.stringify(value), fingerprint, sender, seq)
    db.query('DELETE FROM local_ai_message_refs WHERE owner=? AND source=? AND thread=? AND message NOT IN (SELECT value FROM json_each(?))').run(owner, value.sourceId, value.threadId, JSON.stringify(value.messageIds))
    for (const message of value.messageIds) db.query("INSERT OR IGNORE INTO local_ai_message_refs(owner,message,source,thread,fingerprint) VALUES (?,?,?,?,'')").run(owner, message, value.sourceId, value.threadId)
    for (const message of messages ?? []) db.query('UPDATE local_ai_message_refs SET fingerprint=? WHERE owner=? AND message=? AND source=? AND thread=?').run(digest(semantic(message)), owner, message.id, value.sourceId, value.threadId)
    if (fresh) db.query('UPDATE local_ai_counts SET decisions=decisions+1 WHERE owner=?').run(owner)
    const count = db.query<{ decisions: number }, [string]>('SELECT decisions FROM local_ai_counts WHERE owner=?').get(owner)!.decisions
    if (count > RETAIN) {
      const excess = db.query<{ source: string; thread: string }, [string, number]>('SELECT source,thread FROM local_ai_decisions WHERE owner=? ORDER BY seq LIMIT ?').all(owner, Math.min(20, count - RETAIN))
      for (const row of excess) { db.query('DELETE FROM local_ai_decisions WHERE owner=? AND source=? AND thread=?').run(owner, row.source, row.thread); db.query('DELETE FROM local_ai_message_refs WHERE owner=? AND source=? AND thread=?').run(owner, row.source, row.thread); event(owner, row.source, row.thread, true) }
      db.query('UPDATE local_ai_counts SET decisions=decisions-? WHERE owner=?').run(excess.length, owner)
    }
    if (db.query<{ decisions: number }, []>('SELECT decisions FROM local_ai_global WHERE id=1').get()!.decisions > GLOBAL_RETAIN) {
      const old = db.query<{ owner: string; source: string; thread: string }, []>('SELECT owner,source,thread FROM local_ai_decisions ORDER BY seq LIMIT 1').get()!
      db.query('DELETE FROM local_ai_decisions WHERE owner=? AND source=? AND thread=?').run(old.owner, old.source, old.thread)
      db.query('DELETE FROM local_ai_message_refs WHERE owner=? AND source=? AND thread=?').run(old.owner, old.source, old.thread)
      db.query('UPDATE local_ai_counts SET decisions=MAX(0,decisions-1) WHERE owner=?').run(old.owner)
      event(old.owner, old.source, old.thread, true)
    }
  }
  function remove(owner: string, source: string, thread: string) {
    if (decisionRow(owner, source, thread)) activity(owner, source, thread, 'removed')
    if (db.query('DELETE FROM local_ai_decisions WHERE owner=? AND source=? AND thread=?').run(owner, source, thread).changes) { event(owner, source, thread, true); db.query('UPDATE local_ai_counts SET decisions=MAX(0,decisions-1) WHERE owner=?').run(owner) }
    db.query('DELETE FROM local_ai_message_refs WHERE owner=? AND source=? AND thread=?').run(owner, source, thread)
    db.query('DELETE FROM local_ai_queue WHERE owner=? AND source=? AND thread=?').run(owner, source, thread)
    settleItems(owner, source, thread, false)
  }
  const jobStatement = db.prepare<JobRow, [string, string]>('SELECT * FROM local_ai_jobs WHERE owner=? AND id=?')
  const saveJobStatement = db.prepare('UPDATE local_ai_jobs SET data=?,enumerated=?,bytes=?,examined=? WHERE owner=? AND id=?')
  const jobRow = (owner: string, id: string) => jobStatement.get(owner, id)
  function saveJob(row: JobRow, job: AiHistoryJob) { saveJobStatement.run(JSON.stringify(job), row.enumerated, row.bytes, row.examined, row.owner, row.id) }
  function refreshJob(owner: string, id: string) {
    const row = jobRow(owner, id); if (!row) return
    const job: AiHistoryJob = JSON.parse(row.data)
    const counts = db.query<{ status: string; count: number }, [string, string]>('SELECT status,COUNT(*) count FROM local_ai_job_items WHERE owner=? AND job=? GROUP BY status').all(owner, id)
    job.queued = counts.reduce((sum, item) => sum + item.count, 0)
    job.completed = counts.find(item => item.status === 'completed')?.count ?? 0
    job.failed = counts.find(item => item.status === 'failed')?.count ?? 0
    if (row.enumerated && job.status === 'running' && job.queued === job.completed + job.failed) job.status = job.problemCode ? 'failed' : 'completed'
    saveJob(row, job)
  }
  function settleItems(owner: string, source: string, thread: string, success: boolean) {
    const jobs = db.query<{ job: string }, [string, string, string]>("SELECT job FROM local_ai_job_items WHERE owner=? AND source=? AND thread=? AND status='pending'").all(owner, source, thread)
    db.query("UPDATE local_ai_job_items SET status=? WHERE owner=? AND source=? AND thread=? AND status='pending'").run(success ? 'completed' : 'failed', owner, source, thread)
    for (const row of jobs) refreshJob(owner, row.job)
  }
  async function scope(owner: string, value = settings(owner), source?: string): Promise<Scope> {
    const boxes = (await inbox.mailboxes(owner)).filter(box => box.status === 'active' && (value.mailboxIds === null || value.mailboxIds.includes(box.id)) && (!source || box.sourceId === source))
    if (boxes.length > 1000) fail('AI_SCOPE_LIMIT', 413)
    const addresses = new Set<string>(), sent = new Set<string>()
    if (source && boxes.length) {
      const account = await inbox.account(owner, source)
      if (account.status !== 'connected') return { boxes: [], addresses, sent }
      if (account.email) addresses.add(account.email.trim().toLowerCase())
      for (const box of boxes) if (box.selector.kind === 'address') addresses.add(box.selector.value.trim().toLowerCase())
      for (const folder of await inbox.cachedFolders(owner, source)) if (folder.role.toLowerCase() === 'sent') sent.add(folder.id)
    }
    return { boxes, addresses, sent }
  }
  const outgoing = (message: Omit<MessageSummary, 'snoozedUntil'>, selected: Scope) => (message.folder.toLowerCase() === 'sent' || message.folderIds.some(id => selected.sent.has(id))) && selected.addresses.has(message.from.email.trim().toLowerCase())
  const eligible = (message: BoundMessage) => message.folder === 'inbox' && message.memberships.some(item => !item.done && (!item.snoozedUntil || Date.parse(item.snoozedUntil) <= now()))
  async function bound(owner: string, id: string, selected: Scope): Promise<BoundMessage | null> {
    let message: BoundMessage | null = null
    const memberships: BoundMessage['memberships'] = []
    // A body belongs to a selected mailbox; eligibility belongs to the UNION of
    // selected memberships. Never let the first Done mailbox mask an active one.
    for (const box of selected.boxes) {
      try {
        const summary = await inbox.mailboxMessageSummary(owner, box.id, id)
        if (summary.sourceId !== box.sourceId) continue
        if (!message) {
          const candidate = await inbox.mailboxMessage(owner, box.id, id)
          if (candidate.sourceId !== box.sourceId) continue
          message = candidate
        }
        if (message.sourceId !== box.sourceId) continue
        memberships.push(...summary.memberships.filter(item => item.mailboxId === box.id))
      } catch (error) { if (!(error instanceof InboxError) || ![403, 404, 409].includes(error.status)) throw error }
    }
    return message && memberships.length ? { ...message, memberships } : null
  }
  function semantic(message: Omit<MessageSummary, 'snoozedUntil'>) {
    return { id: message.id, bodyRevision: message.bodyRevision ?? null, from: message.from.email.toLowerCase(), to: message.to.map(item => item.email.toLowerCase()), cc: message.cc.map(item => item.email.toLowerCase()), subject: message.subject, preview: message.preview, at: message.receivedAt, facts: message.facts ?? null, folder: message.folder, folderIds: [...message.folderIds].sort() }
  }
  function knownMessage(owner: string, message: Omit<MessageSummary, 'snoozedUntil'>) {
    return db.query<{ fingerprint: string }, [string, string, string, string]>('SELECT fingerprint FROM local_ai_message_refs WHERE owner=? AND message=? AND source=? AND thread=?').get(owner, message.id, message.accountId, message.threadId)?.fingerprint === digest(semantic(message))
  }
  async function prepare(owner: string, source: string, thread: string, value: AiSettings): Promise<Context | null> {
    const selected = await scope(owner, value, source)
    if (!selected.boxes.length) return null
    const page = await inbox.thread(owner, thread, { sort: 'newest', limit: 8 })
    const messages: BoundMessage[] = []
    for (const summary of page.items) {
      if (summary.accountId !== source || messages.length >= 4) continue
      const message = await bound(owner, summary.id, selected)
      if (message && message.threadId === thread) messages.push(message)
    }
    if (!messages.length) return null
    const fingerprint = digest(messages.map(semantic))
    const input: AiTriageInput = { observedAt: stamp(now()), messages: [] }
    let remaining = 12 * 1024
    for (const [index, message] of messages.entries()) {
      const clean = prepareAiText(message, Math.min(3000, remaining))
      const byteLimit = Math.min(3000, remaining)
      const text = Buffer.from(clean.text).subarray(0, byteLimit).toString('utf8').replace(/\uFFFD$/, '')
      remaining -= Buffer.byteLength(text)
      const facts = message.facts
      input.messages.push({ ref: `m${index}`, direction: outgoing(message, selected) ? 'outgoing' : 'incoming', toSelf: [...message.to, ...message.cc].some(item => selected.addresses.has(item.email.trim().toLowerCase())), receivedAt: message.receivedAt, subject: message.subject.slice(0, 500), text, truncated: clean.truncated || text !== clean.text, ...(facts ? { facts: { reply: !!facts.reply, bulk: !!facts.bulk, listUnsubscribe: !!facts.listUnsubscribe, listId: !!facts.listId, nativeCategories: (facts.nativeCategories ?? []).filter(item => /^[a-z0-9_-]{1,32}$/i.test(item)).slice(0, 10) } } : {}) })
    }
    // Include JSON escaping in the budget: the adapter embeds this JSON in another
    // JSON envelope alongside its schema. No raw input is persisted by this host.
    while (Buffer.byteLength(JSON.stringify(input)) > 14 * 1024) {
      const longest = [...input.messages].sort((a, b) => b.text.length - a.text.length)[0]
      if (!longest?.text.length) break
      longest.text = longest.text.slice(0, Math.floor(longest.text.length / 2)); longest.truncated = true
    }
    const senderMessage = messages.find(message => !outgoing(message, selected))
    rememberCorrespondence(owner, messages, selected)
    return { input, fingerprint, hash: digest({ messages: input.messages, model: value.model, schema: AI_TRIAGE_VERSION, configuration: configVersion }), legacyHash: digest({ messages: input.messages, model: value.model, schema: 'triage-1', configuration: configVersion }), messages, boxes: [...new Set(messages.flatMap(message => message.memberships.map(item => item.mailboxId)))], versions: messages.map(message => ({ messageId: message.id, bodyRevision: message.bodyRevision ?? null })), sender: senderMessage ? hashIdentity(owner, senderMessage.from.email) : '', insufficient: !input.messages.some(message => message.direction === 'incoming' && message.text.trim().length > 0) }
  }
  function capturedContext(owner: string, context: Context, decision: AiDecision, value: AiSettings): Context | null {
    if (decision.model !== value.model || decision.settingsRevision < fenceRevision(owner) || JSON.stringify(context.versions) !== JSON.stringify(decision.contextVersions)) return null
    if (decision.inputHash === context.hash) return context
    // Compute, never migrate/invent, the old hash for these exact bounded inputs.
    if (decision.schemaVersion === 'triage-1' && (!decision.inputPolicyVersion || ['input-1', 'input-2'].includes(decision.inputPolicyVersion)) && decision.inputHash === context.legacyHash) return { ...context, hash: context.legacyHash }
    return null
  }
  function rememberCorrespondence(owner: string, messages: BoundMessage[], selected: Scope) {
    transaction(() => {
      for (const message of messages) {
        if (!outgoing(message, selected)) continue
        const day = Math.floor(Date.parse(message.receivedAt) / DAY)
        if (!Number.isFinite(day) || day < Math.floor(now() / DAY) - 180 || day > Math.floor(now() / DAY)) continue
        for (const recipient of [...message.to, ...message.cc, ...message.bcc].slice(0, 100)) {
          if (!recipient.email || selected.addresses.has(recipient.email.trim().toLowerCase())) continue
          db.query('INSERT OR IGNORE INTO local_ai_correspondence VALUES (?,?,?,?)').run(owner, message.id, hashIdentity(owner, recipient.email), day)
        }
      }
      db.query('DELETE FROM local_ai_correspondence WHERE owner=? AND day<?').run(owner, Math.floor(now() / DAY) - 180)
      db.query('DELETE FROM local_ai_correspondence WHERE owner=? AND rowid IN (SELECT rowid FROM local_ai_correspondence WHERE owner=? ORDER BY day DESC,rowid DESC LIMIT -1 OFFSET 50000)').run(owner, owner)
    })
  }
  const affinityVotes = (owner: string) => db.query<AffinityVote, [string, number]>(`SELECT sender,topics,choice,at FROM local_ai_feedback f WHERE owner=? AND at>=? AND seq=(SELECT MAX(seq) FROM local_ai_feedback n WHERE n.owner=f.owner AND n.source=f.source AND n.thread=f.thread) ORDER BY seq DESC LIMIT 1000`).all(owner, now() - 180 * DAY)
  function score(owner: string, assessment: AiAssessment, sender: string, value: AiSettings, override: AiDecision['override'], sharedVotes?: AffinityVote[]) {
    const day = Math.floor(now() / DAY)
    const correspondenceDays = db.query<{ day: number }, [string, string, number]>('SELECT DISTINCT day FROM local_ai_correspondence WHERE owner=? AND recipient=? AND day>? ORDER BY day DESC LIMIT 180').all(owner, sender, day - 180).reduce((sum, item) => sum + 2 ** (-Math.max(0, day - item.day) / 60), 0)
    const readingSeconds = value.readingSignals ? db.query<{ day: number; ms: number }, [string, string, number]>('SELECT day,ms FROM local_ai_reading WHERE owner=? AND sender=? AND day>? ORDER BY day DESC LIMIT 30').all(owner, sender, day - 30).reduce((sum, item) => sum + item.ms / 1000 * 2 ** (-Math.max(0, day - item.day) / 14), 0) : 0
    const votes = sharedVotes ?? affinityVotes(owner)
    let explicitAffinity = 0, learnedTopicAffinity = 0
    const topics = new Set(assessment.topics.map(topic => hashIdentity(owner, `topic:${topic}`)))
    for (const vote of votes) { const weight = vote.choice * 2 ** (-(now() - vote.at) / (60 * DAY)); if (vote.sender === sender) explicitAffinity += weight; if ((JSON.parse(vote.topics) as string[]).some(topic => topics.has(topic))) learnedTopicAffinity += weight }
    return scoreAiTriage(assessment, { correspondenceDays, readingSeconds, explicitAffinity: Math.max(-3, Math.min(3, explicitAffinity)), interestMatches: countAiTopicMatches(assessment.topics, value.interests), learnedTopicAffinity: Math.max(-3, Math.min(3, learnedTopicAffinity)) }, { personalization: value.personalization, override: override?.category ?? null })
  }
  function enqueue(owner: string, message: Omit<MessageSummary, 'snoozedUntil'>, boxes: string[], row: SettingsRow, lane: QueueRow['lane'], job: string | null, holdUntil: string | null, eventReason?: EventReason, prepared?: Context) {
    const source = message.accountId, thread = message.threadId, unchanged = knownMessage(owner, message)
    const previous = decisionRow(owner, source, thread)
    const existing = db.query<QueueRow, [string, string, string]>('SELECT * FROM local_ai_queue WHERE owner=? AND source=? AND thread=?').get(owner, source, thread)
    if (job) db.query("INSERT OR IGNORE INTO local_ai_job_items VALUES (?,?,?,?,'pending')").run(owner, job, source, thread)
    if (existing?.generation === row.generation && unchanged) {
      if (lane === 'incoming') db.query("UPDATE local_ai_queue SET lane='incoming',job=NULL WHERE owner=? AND source=? AND thread=?").run(owner, source, thread)
      return false
    }
    if (previous && unchanged && !existing) {
      const prior: AiDecision = JSON.parse(previous.data)
      if (reusableDecision(prior, (JSON.parse(row.data) as AiSettings).model, lane === 'history' && !!job && jobRow(owner, job)?.input_policy === AI_INPUT_POLICY_VERSION)) { if (job) { db.query("UPDATE local_ai_job_items SET status='completed' WHERE owner=? AND job=? AND source=? AND thread=?").run(owner, job, source, thread); refreshJob(owner, job) }; return false }
    }
    const count = db.query<{ queued: number }, [string]>('SELECT queued FROM local_ai_queue_counts WHERE owner=?').get(owner)?.queued ?? 0
    if (!existing && count >= (lane === 'history' ? HISTORY_LIMIT : QUEUE_LIMIT)) fail('AI_QUEUE_FULL', 429)
    const global = db.query<{ queued: number }, []>('SELECT queued FROM local_ai_global WHERE id=1').get()!.queued
    if (!existing && global >= GLOBAL_QUEUE_LIMIT - (lane === 'history' ? 64 : 0)) fail('AI_QUEUE_FULL', 429)
    const value: AiSettings = JSON.parse(row.data)
    const prior: AiDecision | undefined = previous ? JSON.parse(previous.data) : undefined
    // A transition token is not a last-message hash: two real changes A -> B -> A
    // must still fence the request dispatched for the first A.
    const fingerprint = randomUUID()
    const versions = prepared?.versions ?? [{ messageId: message.id, bodyRevision: message.bodyRevision ?? null }, ...(prior?.contextVersions ?? []).filter(item => item.messageId !== message.id)].slice(0, 8)
    const decision: AiDecision = { sourceId: source, threadId: thread, revision: 0, settingsRevision: value.revision, state: 'pending', mailboxIds: boxes, messageIds: versions.map(item => item.messageId), contextVersions: versions, latestMessageId: prepared?.messages[0]?.id ?? message.id, inputHash: null, model: value.model, schemaVersion: AI_TRIAGE_VERSION, updatedAt: stamp(now()), holdUntil, assessment: null, score: null, override: prior?.override ?? null, problemCode: null }
    // Pending projections intentionally clear their input. Keep the last complete
    // legacy receipt privately with the durable queue so restart/replay cannot lose it.
    const retained = prior?.schemaVersion === 'triage-1' && prior.state === 'ready' && prior.inputHash && prior.assessment ? previous!.data : existing?.previous ?? null
    db.query('INSERT INTO local_ai_queue(owner,source,thread,fingerprint,generation,lane,queued,due,attempts,status,job,previous) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner,source,thread) DO UPDATE SET fingerprint=excluded.fingerprint,generation=excluded.generation,lane=excluded.lane,queued=excluded.queued,due=excluded.due,attempts=0,status=excluded.status,job=excluded.job,previous=excluded.previous').run(owner, source, thread, fingerprint, row.generation, lane, now(), now(), 0, 'queued', job, retained)
    publish(owner, decision, fingerprint, previous?.sender ?? '', prepared?.messages ?? [message], 'queued', eventReason)
    return true
  }
  const startedAt = now()
  const draining = new Set<string>()
  function watch(owner: string) { if (started && !closed && !subscriptions.has(owner)) subscriptions.set(owner, inbox.subscribe(owner, () => schedule(owner))) }
  function schedule(owner: string) {
    if (!started || closed || draining.has(owner)) return
    draining.add(owner)
    const task = serial(owner, () => drain(owner)).catch(error => {
      if (!closed) drained(owner, error instanceof InboxError && /^AI_[A-Z0-9_]{1,76}$/.test(error.code) ? error.code : 'AI_DRAIN_FAILED')
    }).finally(() => { draining.delete(owner); pump() })
    tracked(task)
  }
  async function drain(owner: string) {
    const row = settingsRow(owner)
    if (!row || !JSON.parse(row.data).enabled || !configuration) return
    if (recoveryRow(owner)) { startRecovery(owner); return }
    // A signed SDK page must fit the owner's incoming reserve as one atomic prefix.
    // Otherwise 33 arrivals behind a paused 10k history job would roll back forever.
    const page = await inbox.changes(owner, { ...(row.cursor ? { since: row.cursor } : {}), limit: QUEUE_LIMIT - HISTORY_LIMIT })
    if (!row.cursor) { transaction(() => { db.query('UPDATE local_ai_settings SET cursor=? WHERE owner=?').run(page.state, owner); drained(owner) }); return }
    if (page.resetRequired) {
      const selected = await scope(owner, JSON.parse(row.data))
      db.query("INSERT OR IGNORE INTO local_ai_recovery(owner,generation,baseline,target,boxes,status) VALUES (?,?,?,?,?,'running')").run(owner, row.generation, row.baseline, page.state, JSON.stringify(selected.boxes.map(box => box.id)))
      // Snapshot work runs outside this owner-serialized change-reader. The original
      // durable cursor remains untouched until the whole captured inventory settles.
      startRecovery(owner)
      return
    }
    const value: AiSettings = JSON.parse(row.data)
    const plans: Array<{ message: BoundMessage; hold: string | null; eventReason: EventReason; context?: Context }> = []
    const skips: Array<{ source: string; thread: string; reason: AiActivityReason; eventReason: EventReason }> = []
    let unavailable = 0
    const removals: Array<{ source: string; thread: string }> = []
    const selectedBySource = new Map<string, Scope>()
    const contexts = new Map<string, Context | null>()
    for (const change of page.events) {
      if (!['mail.changed', 'membership.updated'].includes(change.type) || !change.accountId) continue
      const source = change.accountId
      let selected = selectedBySource.get(source)
      if (!selected) { selected = await scope(owner, value, source); selectedBySource.set(source, selected) }
      const message = selected.boxes.length ? await bound(owner, change.entityId, selected) : null
      if (!message) {
        if (change.type === 'mail.changed' && change.change === 'created') unavailable++
        // The current projection has a bounded message-ID array, not a source-wide rescan.
        const affected = db.query<{ thread: string }, [string, string, string]>('SELECT thread FROM local_ai_message_refs WHERE owner=? AND source=? AND message=? LIMIT 100').all(owner, source, change.entityId)
        removals.push(...affected.map(item => ({ source, thread: item.thread })))
        continue
      }
      const prior = decisionRow(owner, source, message.threadId)
      if (outgoing(message, selected)) rememberCorrespondence(owner, [message], selected)
      if (knownMessage(owner, message)) continue
      if (prior && change.reason !== 'arrival') {
        const captured: AiDecision = JSON.parse(prior.data)
        if (captured.inputHash) {
          const identity = key(owner, source, message.threadId)
          if (!contexts.has(identity)) contexts.set(identity, await prepare(owner, source, message.threadId, value))
          const context = contexts.get(identity)
          // Older, uncaptured messages cannot invalidate an unchanged bounded input.
          if (context && capturedContext(owner, context, captured, value)) continue
        }
      }
      const created = change.type === 'mail.changed' && change.change === 'created'
      const sent = outgoing(message, selected)
      const at = Date.parse(change.at)
      const recentCreation = created && at >= row.admission_since && Date.parse(message.receivedAt) >= row.admission_since
      const newSentContext = recentCreation && change.reason === 'mutation' && sent
      const recentImport = recentCreation && ['initial', 'backfill'].includes(change.reason)
      if (change.reason !== 'arrival' && !prior && !recentImport && !newSentContext) {
        // A flag or restored historical membership is not consent to process history.
        if (created) skips.push({ source, thread: message.threadId, reason: 'historical_no_prior', eventReason: change.reason })
        continue
      }
      if (newSentContext && !prior) {
        const context = await prepare(owner, source, message.threadId, value)
        if (context?.messages.some(item => eligible(item) && !outgoing(item, selected))) plans.push({ message, hold: null, eventReason: change.reason, context })
        else skips.push({ source, thread: message.threadId, reason: 'outgoing_no_prior', eventReason: change.reason })
        continue
      }
      if (!eligible(message) || sent) {
        // Placement/Done does not erase historical assessments or become a negative
        // preference. The consumer still applies its current native inbox membership.
        if (prior) plans.push({ message, hold: null, eventReason: change.reason })
        else if (created) skips.push({ source, thread: message.threadId, reason: sent ? 'outgoing_no_prior' : 'inactive_membership', eventReason: change.reason })
        continue
      }
      const hold = !prior && change.reason === 'arrival' && created && at >= startedAt && at + 2000 > now() ? stamp(Math.min(now() + 2000, at + 2000)) : null
      plans.push({ message, hold, eventReason: change.reason })
    }
    transaction(() => {
      if (settingsRow(owner)?.generation !== row.generation) return
      for (const item of removals) remove(owner, item.source, item.thread)
      for (const skip of skips) activity(owner, skip.source, skip.thread, skip.reason, undefined, skip.eventReason)
      if (unavailable) countActivity(owner, 'unavailable', unavailable)
      for (const plan of plans) enqueue(owner, plan.message, plan.context?.boxes ?? plan.message.memberships.map(item => item.mailboxId), row, 'incoming', null, plan.hold, plan.eventReason, plan.context)
      db.query('UPDATE local_ai_settings SET cursor=?,baseline=? WHERE owner=? AND generation=?').run(page.state, Math.max(row.baseline, ...page.events.map(event => Date.parse(event.at)).filter(Number.isFinite)), owner, row.generation)
      drained(owner)
    })
    if (page.hasMore) queueMicrotask(() => { draining.delete(owner); schedule(owner) })
  }
  const recoveryRow = (owner: string) => db.query<RecoveryRow, [string]>('SELECT * FROM local_ai_recovery WHERE owner=?').get(owner)
  const yieldPage = () => new Promise<void>(resolve => setImmediate(resolve))
  function startRecovery(owner: string) {
    const row = recoveryRow(owner)
    if (closed || recovering.has(owner) || !row || row.status === 'blocked') return
    recovering.add(owner)
    tracked(recover(owner).catch(() => {
      db.query("UPDATE local_ai_recovery SET status='blocked',problem='AI_RECOVERY_FAILED' WHERE owner=? AND generation=?").run(owner, row.generation)
    }).finally(() => { recovering.delete(owner); pump() }))
  }
  async function recover(owner: string) {
    let memory = recoveryPages.get(owner)
    if (!memory) { memory = { index: 0 }; recoveryPages.set(owner, memory) }
    while (!closed) {
      const row = recoveryRow(owner), current = settingsRow(owner)
      if (!row || !current || row.generation !== current.generation || !JSON.parse(current.data).enabled) return
      const value: AiSettings = { ...JSON.parse(current.data), mailboxIds: JSON.parse(row.boxes) }
      const valid = () => !closed && settingsRow(owner)?.generation === row.generation && recoveryRow(owner)?.generation === row.generation
      if (!(value.mailboxIds?.length)) {
        transaction(() => { if (!valid()) return; db.query('UPDATE local_ai_settings SET cursor=? WHERE owner=? AND generation=?').run(row.target, owner, row.generation); db.query('DELETE FROM local_ai_recovery WHERE owner=?').run(owner); db.query('DELETE FROM local_ai_recovery_seen WHERE owner=?').run(owner) })
        recoveryPages.delete(owner); return
      }
      if (!memory.page) {
        try { memory.page = await inbox.mailboxSnapshot(owner, { mailboxIds: value.mailboxIds, limit: 500, ...(memory.cursor ? { cursor: memory.cursor } : {}) }); memory.index = 0 }
        catch (error) {
          if (!valid()) return
          if (error instanceof InboxError && error.code === 'SNAPSHOT_EXPIRED' && row.restarts < 3) {
            db.query('UPDATE local_ai_recovery SET restarts=restarts+1 WHERE owner=?').run(owner)
            memory = { index: 0 }; recoveryPages.set(owner, memory); await yieldPage(); continue
          }
          db.query("UPDATE local_ai_recovery SET status='blocked',problem=? WHERE owner=?").run(error instanceof InboxError && error.code === 'SNAPSHOT_SCOPE_CHANGED' ? 'AI_RECOVERY_SCOPE_CHANGED' : 'AI_RECOVERY_FAILED', owner)
          return
        }
        if (!valid()) return
        if (!memory.cursor) { row.target = memory.page.state; db.query("UPDATE local_ai_recovery SET target=?,status='running',problem=NULL WHERE owner=?").run(row.target, owner) }
      }
      const page = memory.page, bySource = new Map<string, Scope>()
      let sliceStarted = performance.now()
      for (; memory.index < page.items.length; memory.index++) {
        if (performance.now() - sliceStarted >= 8) { await yieldPage(); sliceStarted = performance.now() }
        if (!valid()) return
        const summary = page.items[memory.index]!
        const activeMembership = summary.memberships.some(item => !item.done && (!item.snoozedUntil || Date.parse(item.snoozedUntil) <= now()))
        // Recovery admission is distinct from inference input: an expired snooze or
        // restored membership must be reconsidered after a restarted inventory.
        const fingerprint = digest([semantic(summary), activeMembership])
        const seen = db.query<{ fingerprint: string }, [string, string]>('SELECT fingerprint FROM local_ai_recovery_seen WHERE owner=? AND message=?').get(owner, summary.id)
        if (seen?.fingerprint === fingerprint) continue
        const size = Buffer.byteLength(JSON.stringify(summary))
        if (row.examined >= 100000 || row.bytes + size > 128 * 1024 * 1024) { db.query("UPDATE local_ai_recovery SET status='blocked',problem='AI_RECOVERY_LIMIT' WHERE owner=?").run(owner); return }
        if (!seen && db.query<{ seen: number }, []>('SELECT seen FROM local_ai_recovery_global WHERE id=1').get()!.seen >= GLOBAL_RETAIN) { db.query("UPDATE local_ai_recovery SET status='waiting_capacity',problem='AI_RECOVERY_CAPACITY' WHERE owner=?").run(owner); return }
        const prior = decisionRow(owner, summary.sourceId, summary.threadId)
        const historical = !prior && !(Date.parse(summary.receivedAt) >= current.admission_since)
        let skipReason: AiActivityReason = historical ? 'recovery_historical' : 'inactive_membership'
        let shouldQueue = !historical && summary.folder === 'inbox' && activeMembership
        const recentSent = summary.folder === 'sent' && Date.parse(summary.receivedAt) >= current.admission_since
        let sentContext: Context | null = null
        if (shouldQueue || recentSent) {
          let selected = bySource.get(summary.sourceId)
          if (!selected) { selected = await scope(owner, value, summary.sourceId); bySource.set(summary.sourceId, selected) }
          if (!valid()) return
          const sent = outgoing(summary, selected)
          shouldQueue = shouldQueue && selected.boxes.length > 0 && !sent
          skipReason = selected.boxes.length ? 'outgoing_no_prior' : 'unavailable'
          if (recentSent && selected.boxes.length && sent) {
            // Recover the same confirmed-send admission as an ordinary created
            // mutation. Old incoming context alone is still not a history grant.
            sentContext = await prepare(owner, summary.sourceId, summary.threadId, value)
            if (!valid()) return
            shouldQueue = !!sentContext?.messages.some(message => eligible(message) && !outgoing(message, selected))
          }
        }
        try {
          transaction(() => {
            if (!valid()) return
            if (shouldQueue) enqueue(owner, summary, sentContext?.boxes ?? summary.memberships.map(item => item.mailboxId), current, 'incoming', null, null, undefined, sentContext ?? undefined)
            else countActivity(owner, skipReason)
            // Each checkpoint is committed with its queue entry. Fresh inventories on
            // expiry/restart revisit IDs but never grant another paid classification.
            db.query('INSERT INTO local_ai_recovery_seen VALUES (?,?,?) ON CONFLICT(owner,message) DO UPDATE SET fingerprint=excluded.fingerprint').run(owner, summary.id, fingerprint)
            row.examined++; row.bytes += size
            db.query("UPDATE local_ai_recovery SET examined=?,bytes=?,status='running',problem=NULL WHERE owner=?").run(row.examined, row.bytes, owner)
          })
        } catch (error) {
          if (!(error instanceof InboxError) || error.code !== 'AI_QUEUE_FULL') throw error
          db.query("UPDATE local_ai_recovery SET status='waiting_capacity',problem='AI_RECOVERY_CAPACITY' WHERE owner=?").run(owner)
          return
        }
      }
      if (!page.nextCursor) {
        transaction(() => {
          if (!valid()) return
          db.query('UPDATE local_ai_settings SET cursor=? WHERE owner=? AND generation=?').run(row.target, owner, row.generation)
          db.query('DELETE FROM local_ai_recovery WHERE owner=?').run(owner); db.query('DELETE FROM local_ai_recovery_seen WHERE owner=?').run(owner)
          drained(owner)
        })
        recoveryPages.delete(owner); queueMicrotask(() => schedule(owner)); return
      }
      memory.cursor = page.nextCursor; memory.page = undefined; memory.index = 0
      pump(); await yieldPage()
    }
  }
  function startInventory(owner: string, id: string) {
    const inventoryKey = key(owner, 'job', id)
    if (closed || inventories.has(inventoryKey)) return
    inventories.add(inventoryKey)
    tracked(inventory(owner, id).catch(() => {
      const row = jobRow(owner, id); if (!row) return
      const job: AiHistoryJob = JSON.parse(row.data)
      if (job.status === 'running') { job.status = 'paused'; job.problemCode = 'AI_INVENTORY_FAILED'; saveJob(row, job) }
    }).finally(() => { inventories.delete(inventoryKey); pump() }))
  }
  async function inventory(owner: string, id: string) {
    let next: string | undefined, restarts = 0
    while (!closed) {
      const row = jobRow(owner, id); if (!row) return
      const job: AiHistoryJob = JSON.parse(row.data), current = settingsRow(owner)
      if (job.status !== 'running' || row.enumerated || !current || current.generation !== row.generation || !JSON.parse(current.data).enabled) return
      let page: Awaited<ReturnType<Inbox['mailboxSnapshot']>>
      try { page = await inbox.mailboxSnapshot(owner, { mailboxIds: JSON.parse(row.boxes), limit: 500, ...(next ? { cursor: next } : {}) }) }
      catch (error) { if (error instanceof InboxError && error.code === 'SNAPSHOT_EXPIRED' && restarts++ < 2) { next = undefined; continue }; throw error }
      const fresh = jobRow(owner, id)
      if (!fresh || JSON.parse(fresh.data).status !== 'running' || settingsRow(owner)?.generation !== row.generation) return
      const sourceScopes = new Map<string, Scope>()
      let sliceStarted = performance.now()
      for (const summary of page.items) {
        if (performance.now() - sliceStarted >= 8) { await yieldPage(); sliceStarted = performance.now() }
        if (job.scanned >= job.limit) break
        const size = Buffer.byteLength(JSON.stringify(summary))
        if (row.examined >= 100000 || row.bytes + size > 32 * 1024 * 1024) {
          job.problemCode = row.examined >= 100000 ? 'AI_INVENTORY_EXAMINED_LIMIT' : 'AI_INVENTORY_BYTES_LIMIT'; row.enumerated = 1; break
        }
        // Examination is a separate durable budget, including skipped/duplicate rows
        // and rows revisited after expiry. It does not consume the NEW-work limit.
        row.examined++; row.bytes += size; saveJob(row, job)
        if (db.query('SELECT 1 FROM local_ai_job_items WHERE owner=? AND job=? AND source=? AND thread=?').get(owner, id, summary.sourceId, summary.threadId)) continue
        const previous = decisionRow(owner, summary.sourceId, summary.threadId)
        if (previous && knownMessage(owner, summary)) { const decision: AiDecision = JSON.parse(previous.data); if (reusableDecision(decision, (JSON.parse(current.data) as AiSettings).model, row.input_policy === AI_INPUT_POLICY_VERSION)) continue }
        let selected = sourceScopes.get(summary.sourceId)
        if (!selected) { selected = await scope(owner, JSON.parse(current.data), summary.sourceId); sourceScopes.set(summary.sourceId, selected) }
        if (closed || settingsRow(owner)?.generation !== row.generation || JSON.parse(jobRow(owner, id)!.data).status !== 'running') return
        if (job.scope === 'inbox' && (summary.folder !== 'inbox' || outgoing(summary, selected) || !summary.memberships.some(item => !item.done && (!item.snoozedUntil || Date.parse(item.snoozedUntil) <= now())))) continue
        if (!selected.boxes.length) continue
        if (closed || settingsRow(owner)?.generation !== row.generation || JSON.parse(jobRow(owner, id)!.data).status !== 'running') return
        job.scanned++
        // Commit progress with the item, not only at page boundaries: a crash halfway
        // through a page must not grant another full limit/byte budget on restart.
        try { transaction(() => { enqueue(owner, summary, summary.memberships.map(item => item.mailboxId), current, 'history', id, null); saveJob(row, job) }) }
        catch (error) { if (error instanceof InboxError && error.code === 'AI_QUEUE_FULL') { job.problemCode = 'AI_QUEUE_FULL'; row.enumerated = 1; break }; throw error }
      }
      next = page.nextCursor ?? undefined
      if (!next || job.scanned >= job.limit) row.enumerated = 1
      saveJob(row, job); refreshJob(owner, id)
      if (row.enumerated) return
      await yieldPage()
    }
  }
  function permitted(queue: QueueRow): boolean {
    const row = settingsRow(queue.owner), value = row ? JSON.parse(row.data) as AiSettings : null
    if (closed || !configuration || !row || row.generation !== queue.generation || !value?.enabled || !configuration.models.some(model => model.id === value.model)) return false
    if (queue.job) { const job = jobRow(queue.owner, queue.job); if (!job || !job.enumerated || JSON.parse(job.data).status !== 'running') return false }
    const current = db.query<QueueRow, [string, string, string]>('SELECT * FROM local_ai_queue WHERE owner=? AND source=? AND thread=?').get(queue.owner, queue.source, queue.thread)
    return !!current && current.generation === queue.generation && current.fingerprint === queue.fingerprint
  }
  function pump() {
    if (!started || closed || pumping || !configuration || active.size >= Math.min(2, configuration.concurrency ?? 2)) return
    pumping = true
    try {
      const rows = db.query<QueueRow, [number]>(`SELECT q.* FROM local_ai_queue q INDEXED BY local_ai_queue_ready JOIN local_ai_settings s ON s.owner=q.owner LEFT JOIN local_ai_jobs j ON j.owner=q.owner AND j.id=q.job WHERE q.status='queued' AND q.due<=? AND q.generation=s.generation AND json_extract(s.data,'$.enabled')=1 AND (q.job IS NULL OR (j.enumerated=1 AND json_extract(j.data,'$.status')='running')) ORDER BY CASE q.lane WHEN 'incoming' THEN 0 ELSE 1 END,q.queued LIMIT 20`).all(now())
      for (const row of rows) {
        if (active.size >= Math.min(2, configuration.concurrency ?? 2)) break
        const id = key(row.owner, row.source, row.thread)
        if (active.has(id) || !permitted(row)) continue
        db.query("UPDATE local_ai_queue SET status='processing' WHERE owner=? AND source=? AND thread=?").run(row.owner, row.source, row.thread)
        const controller = new AbortController()
        const task = executeQueue(row, controller).catch(() => {
          if (!closed && permitted(row)) transaction(() => finishDecision(row, null, null, 'AI_CONTEXT_FAILED'))
        }).finally(() => { active.delete(id); if (!closed) { schedule(row.owner); pump() } })
        active.set(id, { owner: row.owner, job: row.job, controller, task })
      }
    } finally { pumping = false }
  }
  function beginAttempt(queue: QueueRow, model: string, inputHash: string): AiDiagnosticAttempt {
    const attempt: AiDiagnosticAttempt = { id: randomUUID(), sourceId: queue.source, threadId: queue.thread, at: stamp(now()), finishedAt: null, lane: queue.lane, outcome: 'dispatching', code: null, model, queueMs: Math.max(0, now() - queue.queued), durationMs: null, httpStatus: null, requestId: null, responseId: null, usage: null, estimate: null }
    transaction(() => {
      db.query('INSERT INTO local_ai_attempts(owner,id,data,config) VALUES (?,?,?,?)').run(queue.owner, attempt.id, JSON.stringify(attempt), JSON.stringify({ configurationVersion: configVersion, settingsRevision: settings(queue.owner).revision, schemaVersion: AI_TRIAGE_VERSION, inputPolicyVersion: AI_INPUT_POLICY_VERSION, inputHash, rate: configuration?.models.find(item => item.id === model)?.pricing ?? null }))
      updateUsage(queue.owner, value => { value.attempts++; value.unknownUsage++; value.unpriced++ })
    })
    return attempt
  }
  function finishAttempt(owner: string, attempt: AiDiagnosticAttempt, result: AiInferenceResult | null, outcome?: string) {
    transaction(() => {
      if (!db.query('SELECT 1 FROM local_ai_attempts WHERE owner=? AND id=? AND finished=0').get(owner, attempt.id)) return
      attempt.finishedAt = stamp(now()); attempt.outcome = outcome ?? result?.outcome ?? 'crash_unknown'
      if (attempt.outcome === 'stale') activity(owner, attempt.sourceId, attempt.threadId, 'stale')
      attempt.code = result?.code && /^[A-Z][A-Z0-9_]{0,79}$/.test(result.code) ? result.code : result ? null : 'AI_CRASH_UNKNOWN'
      attempt.durationMs = result ? Math.max(0, result.durationMs) : Math.max(0, now() - Date.parse(attempt.at))
      attempt.httpStatus = result?.httpStatus ?? null
      // Provider IDs are useful only as opaque bounded correlation values, never error bodies.
      const opaque = (value: string | null | undefined) => value && /^[a-zA-Z0-9_-]{1,200}$/.test(value) ? value : null
      attempt.requestId = opaque(result?.requestId); attempt.responseId = opaque(result?.responseId)
      attempt.usage = result?.usage ?? null; attempt.estimate = result?.estimate ?? null
      db.query('UPDATE local_ai_attempts SET data=?,finished=1 WHERE owner=? AND id=?').run(JSON.stringify(attempt), owner, attempt.id)
      db.query("UPDATE local_ai_attempts SET config=json_set(config,'$.returnedModel',?) WHERE owner=? AND id=?").run(result?.returnedModel ?? null, owner, attempt.id)
      updateUsage(owner, value => {
        if (result?.outcome === 'completed' && result.assessment) value.completed++; else value.failed++
        if (result?.usage.input !== null && result?.usage.input !== undefined && result.usage.output !== null) value.unknownUsage--
        if (result?.estimate) { value.unpriced--; value.estimatedMinimumUsd += result.estimate.minimumUsd; value.estimatedMaximumUsd += result.estimate.maximumUsd }
        value.inputTokens += result?.usage.input ?? 0; value.outputTokens += result?.usage.output ?? 0
        value.cachedInputTokens += result?.usage.cachedInput ?? 0; value.cacheWriteInputTokens += result?.usage.cacheWriteInput ?? 0; value.reasoningOutputTokens += result?.usage.reasoningOutput ?? 0
      })
      // Every removed attempt has already contributed to the durable all-time aggregate.
      db.query('DELETE FROM local_ai_attempts WHERE owner=? AND finished=1 AND seq<(SELECT seq FROM local_ai_attempts WHERE owner=? ORDER BY seq DESC LIMIT 1 OFFSET 1999)').run(owner, owner)
    })
  }
  function finishDecision(queue: QueueRow, context: Context | null, assessment: AiAssessment | null, problem: string | null, inputPolicyVersion?: string, reason?: AiActivityReason, retained?: AiDecision) {
    if (!permitted(queue)) return
    const row = decisionRow(queue.owner, queue.source, queue.thread)
    if (!row) { db.query('DELETE FROM local_ai_queue WHERE owner=? AND source=? AND thread=?').run(queue.owner, queue.source, queue.thread); settleItems(queue.owner, queue.source, queue.thread, false); return }
    const decision: AiDecision = JSON.parse(row.data), value = settings(queue.owner)
    decision.updatedAt = stamp(now()); decision.holdUntil = null; decision.settingsRevision = value.revision
    decision.state = assessment ? 'ready' : 'failed'; decision.problemCode = problem
    decision.assessment = assessment
    if (inputPolicyVersion) {
      decision.inputPolicyVersion = inputPolicyVersion
      // Reuse must not relabel a retained pre-task assessment as the new schema.
      decision.schemaVersion = ['input-1', 'input-2'].includes(inputPolicyVersion) ? 'triage-1' : AI_TRIAGE_VERSION
    } else delete decision.inputPolicyVersion
    if (context) {
      decision.inputHash = context.hash; decision.contextVersions = context.versions; decision.messageIds = context.messages.map(message => message.id); decision.latestMessageId = context.messages[0]!.id; decision.mailboxIds = context.boxes
      // A cache-only legacy hit proves content, not a manual choice's captured
      // message/version scope. Only the matching retained receipt carries that choice.
      if (decision.override?.inputHash !== context.hash || context.hash === context.legacyHash && !retained) decision.override = null
    } else decision.override = null
    decision.score = retained?.score && retained.settingsRevision === value.revision && retained.override?.category === decision.override?.category &&
      (retained.assessment?.task === undefined || !!retained.override || retained.score.version === AI_PREFERENCE_VERSION)
      ? structuredClone(retained.score) : assessment ? score(queue.owner, assessment, context?.sender ?? row.sender, value, decision.override) : null
    if (assessment && context && !problem) {
      const fresh = !db.query('SELECT 1 FROM local_ai_cache WHERE owner=? AND hash=?').get(queue.owner, context.hash)
      db.query('INSERT INTO local_ai_cache(owner,hash,assessment,at,input_policy) VALUES (?,?,?,?,?) ON CONFLICT(owner,hash) DO UPDATE SET assessment=excluded.assessment,at=excluded.at,input_policy=excluded.input_policy').run(queue.owner, context.hash, JSON.stringify(assessment), now(), inputPolicyVersion ?? 'input-1')
      if (fresh) db.query('UPDATE local_ai_counts SET cache=cache+1 WHERE owner=?').run(queue.owner)
      if ((db.query<{ cache: number }, [string]>('SELECT cache FROM local_ai_counts WHERE owner=?').get(queue.owner)?.cache ?? 0) > 10000) { const deleted = db.query('DELETE FROM local_ai_cache WHERE owner=? AND hash IN (SELECT hash FROM local_ai_cache WHERE owner=? ORDER BY at LIMIT 1)').run(queue.owner, queue.owner).changes; db.query('UPDATE local_ai_counts SET cache=cache-? WHERE owner=?').run(deleted, queue.owner) }
    }
    publish(queue.owner, decision, queue.fingerprint, context?.sender ?? row.sender, context?.messages, reason)
    db.query('DELETE FROM local_ai_queue WHERE owner=? AND source=? AND thread=?').run(queue.owner, queue.source, queue.thread)
    settleItems(queue.owner, queue.source, queue.thread, !!assessment)
  }
  async function executeQueue(queue: QueueRow, controller: AbortController) {
    if (queue.attempts >= 3) { transaction(() => finishDecision(queue, null, null, 'AI_RETRY_LIMIT')); return }
    const value = settings(queue.owner)
    const contextSettings = (current: AiSettings): AiSettings => {
      if (!queue.job) return current
      const job = jobRow(queue.owner, queue.job)
      const captured: string[] = job ? JSON.parse(job.boxes) : []
      return { ...current, mailboxIds: captured.filter(id => current.mailboxIds === null || current.mailboxIds.includes(id)) }
    }
    let context: Context | null
    try { context = await prepare(queue.owner, queue.source, queue.thread, contextSettings(value)) }
    catch (error) { if (error instanceof InboxError && [403, 404, 409].includes(error.status)) { if (permitted(queue)) transaction(() => remove(queue.owner, queue.source, queue.thread)); return }; throw error }
    if (!permitted(queue) || controller.signal.aborted) return
    if (!context) { transaction(() => remove(queue.owner, queue.source, queue.thread)); return }
    const previous: AiDecision | null = queue.previous ? JSON.parse(queue.previous) : null
    const retained = previous && capturedContext(queue.owner, context, previous, value)
    const refreshLegacy = queue.lane === 'history' && !!queue.job && jobRow(queue.owner, queue.job)?.input_policy === AI_INPUT_POLICY_VERSION
    if (previous?.assessment && retained && reusableDecision(previous, value.model, refreshLegacy)) {
      transaction(() => { updateUsage(queue.owner, value => { value.reused++ }); finishDecision(queue, retained, previous.assessment, previous.problemCode, previous.inputPolicyVersion ?? 'input-1', 'cache_reused', previous) })
      return
    }
    if (context.insufficient) { transaction(() => finishDecision(queue, context, insufficient, 'AI_INSUFFICIENT_CONTEXT')); return }
    const cache = db.query<{ assessment: string; input_policy: string }, [string, string]>('SELECT assessment,input_policy FROM local_ai_cache WHERE owner=? AND hash=?')
    let cached = cache.get(queue.owner, context.hash), cacheContext = context
    if (!cached) {
      // A decision may have been removed while its content-addressed cache remains.
      // The legacy key is computed from the exact current bounded input/model/config,
      // not obtained by relabeling a current hash or restoring a missing receipt.
      const legacy = cache.get(queue.owner, context.legacyHash)
      if (legacy && ['input-1', 'input-2'].includes(legacy.input_policy)) { cached = legacy; cacheContext = { ...context, hash: context.legacyHash } }
    }
    const row = decisionRow(queue.owner, queue.source, queue.thread)
    if (cached) {
      const assessment: AiAssessment = JSON.parse(cached.assessment)
      const override: AiDecision['override'] = cacheContext === context && row ? JSON.parse(row.data).override : null
      // Only an explicit history job refreshes affected legacy campaigns. Preserve
      // old clear results and actual new-policy uncertainty; cache-only hits do not
      // invent a manual-choice exemption when its captured receipt is unavailable.
      const refresh = refreshLegacy && legacyCampaign(assessment, cached.input_policy) && override?.inputHash !== cacheContext.hash
      if (!refresh) { transaction(() => { updateUsage(queue.owner, value => { value.reused++ }); finishDecision(queue, cacheContext, assessment, null, cached.input_policy, 'cache_reused') }); return }
    }
    if (row) transaction(() => {
      const decision: AiDecision = JSON.parse(row.data)
      decision.state = 'processing'; decision.updatedAt = stamp(now()); decision.inputHash = context!.hash
      decision.messageIds = context!.messages.map(message => message.id); decision.contextVersions = context!.versions; decision.mailboxIds = context!.boxes; decision.latestMessageId = context!.messages[0]!.id
      // Install every context message's hash before dispatch, not only after success.
      publish(queue.owner, decision, queue.fingerprint, context!.sender, context!.messages)
    })
    if (!permitted(queue) || controller.signal.aborted) return
    const attempt = beginAttempt(queue, value.model, context.hash)
    let result: AiInferenceResult
    try { result = await inferAiTriage(context.input, configuration!, { model: value.model, signal: controller.signal, fetcher }) }
    catch { finishAttempt(queue.owner, attempt, null); if (permitted(queue)) transaction(() => finishDecision(queue, context, null, 'AI_REQUEST_FAILED')); return }
    let current: Context | null = null
    if (permitted(queue) && !controller.signal.aborted) { try { current = await prepare(queue.owner, queue.source, queue.thread, contextSettings(settings(queue.owner))) } catch {} }
    const valid = permitted(queue) && !controller.signal.aborted && !!current && current.hash === context.hash && JSON.stringify(current.versions) === JSON.stringify(context.versions)
    finishAttempt(queue.owner, attempt, result, controller.signal.aborted ? 'cancelled' : !valid ? 'stale' : undefined)
    if (!valid) {
      if (permitted(queue)) transaction(() => {
        if (!current) remove(queue.owner, queue.source, queue.thread)
        else { db.query("UPDATE local_ai_queue SET status='queued',due=?,attempts=0 WHERE owner=? AND source=? AND thread=?").run(now(), queue.owner, queue.source, queue.thread); const row = decisionRow(queue.owner, queue.source, queue.thread); if (row) { const decision: AiDecision = JSON.parse(row.data); decision.state = 'stale'; decision.holdUntil = null; decision.problemCode = 'AI_CONTEXT_CHANGED'; publish(queue.owner, decision, row.fingerprint, row.sender) } }
      })
      return
    }
    if (result.outcome === 'completed' && result.assessment) {
      // Complete source coverage is not required for a positively grounded, clear
      // non-actionable campaign. Never manufacture clarity from model uncertainty.
      const clearCampaign = result.assessment.certainty === 'clear' && quietCampaign(result.assessment)
      const assessment = context.input.messages.some(message => message.truncated) && !clearCampaign ? { ...result.assessment, certainty: 'insufficient' as const } : result.assessment
      transaction(() => finishDecision(queue, current, assessment, null, AI_INPUT_POLICY_VERSION)); return
    }
    if (result.retryable && queue.attempts < 2) {
      const delay = Math.max(1000 * 2 ** queue.attempts, Math.min(300_000, Math.max(0, result.retryAfterMs ?? 0)))
      db.query("UPDATE local_ai_queue SET status='queued',due=?,attempts=attempts+1 WHERE owner=? AND source=? AND thread=?").run(now() + delay, queue.owner, queue.source, queue.thread)
      return
    }
    transaction(() => finishDecision(queue, current, null, result.code && /^[A-Z][A-Z0-9_]{0,79}$/.test(result.code) ? result.code : 'AI_ASSESSMENT_FAILED'))
  }
  const rescoreRow = (owner: string) => db.query<RescoreRow, [string]>('SELECT * FROM local_ai_rescore WHERE owner=?').get(owner)
  const fenceRevision = (owner: string) => db.query<{ revision: number }, [string]>('SELECT revision FROM local_ai_settings_fence WHERE owner=?').get(owner)?.revision ?? 0
  const needsPolicyScore = (decision: AiDecision) => decision.state === 'ready' && !decision.override &&
    member(['required', 'optional', 'none', 'unknown'] as const, decision.assessment?.task) &&
    !!decision.score && typeof decision.score.version === 'string' && decision.score.version !== AI_PREFERENCE_VERSION
  function queueRescore(owner: string, value: AiSettings, stale = false, force: boolean | 2 = false) {
    if (stale) db.query('INSERT INTO local_ai_settings_fence VALUES (?,?) ON CONFLICT(owner) DO UPDATE SET revision=excluded.revision').run(owner, value.revision)
    db.query('INSERT INTO local_ai_rescore VALUES (?,?,?,?,0,?,?,NULL) ON CONFLICT(owner) DO UPDATE SET token=excluded.token,revision=excluded.revision,through=excluded.through,after=0,stale=excluded.stale,force=excluded.force,problem=NULL WHERE excluded.force<>2').run(owner, randomUUID(), value.revision, cursor(owner).head, Number(stale), Number(force))
  }
  function queuePolicyRescore(owner: string) {
    const existing = rescoreRow(owner)
    // Preference work keeps its token and captured high-water. Recheck once it
    // finishes, including old scores published beyond that earlier high-water.
    if (existing) { if (existing.force !== 2) policyAfterRescore.add(owner); return }
    const value = settings(owner)
    if (!value.enabled) return
    const affected = db.query(`SELECT 1 FROM local_ai_decisions WHERE owner=? AND json_extract(data,'$.state')='ready'
      AND json_extract(data,'$.assessment.task') IN ('required','optional','none','unknown')
      AND json_extract(data,'$.score.version')<>? AND json_extract(data,'$.override') IS NULL
      AND json_extract(data,'$.model')=? AND json_extract(data,'$.settingsRevision')>=? LIMIT 1`).get(owner, AI_PREFERENCE_VERSION, value.model, fenceRevision(owner))
    if (affected) queueRescore(owner, value, false, 2)
  }
  function rescorePage(owner: string, token: string): boolean {
    return transaction(() => {
      const job = rescoreRow(owner), value = settings(owner)
      if (!job || job.token !== token) return true
      if (job.revision !== value.revision) { db.query('DELETE FROM local_ai_rescore WHERE owner=? AND token=?').run(owner, token); return true }
      const rows = db.query<{ source: string; thread: string; seq: number }, [string, number, number]>('SELECT source,thread,seq FROM local_ai_decisions WHERE owner=? AND seq>? AND seq<=? ORDER BY seq LIMIT 100').all(owner, job.after, job.through)
      if (!rows.length) { db.query('DELETE FROM local_ai_rescore WHERE owner=? AND token=?').run(owner, token); return true }
      const fence = fenceRevision(owner)
      let votes: AffinityVote[] | undefined
      for (const item of rows) {
        // Re-read the current revision/override, never a captured 100k-row array.
        // Later manual feedback and fresh inference publish beyond this high-water.
        const row = decisionRow(owner, item.source, item.thread)
        if (!row || row.seq !== item.seq || row.seq > job.through) continue
        const decision: AiDecision = JSON.parse(row.data)
        const stale = decision.model !== value.model || decision.settingsRevision < fence || !!job.stale && decision.settingsRevision < job.revision
        if (job.force === 2 && (stale || !needsPolicyScore(decision))) continue
        if (!job.force && decision.settingsRevision >= job.revision && !stale && !needsPolicyScore(decision)) continue
        decision.settingsRevision = value.revision; decision.updatedAt = stamp(now()); decision.holdUntil = null
        if (stale) { decision.state = 'stale'; decision.problemCode = 'AI_SETTINGS_CHANGED' }
        else if (decision.assessment) { votes ??= affinityVotes(owner); decision.score = score(owner, decision.assessment, row.sender, value, decision.override, votes) }
        publish(owner, decision, row.fingerprint, row.sender, undefined, stale ? 'stale' : 'rescored')
      }
      const after = rows[rows.length - 1]!.seq
      if (rows.length < 100 || after >= job.through) { db.query('DELETE FROM local_ai_rescore WHERE owner=? AND token=?').run(owner, token); return true }
      db.query('UPDATE local_ai_rescore SET after=? WHERE owner=? AND token=?').run(after, owner, token)
      return false
    })
  }
  function startRescore(owner: string) {
    const job = rescoreRow(owner)
    if (closed || rescoring.has(owner) || !job || job.problem) return
    rescoring.add(owner)
    tracked((async () => {
      // The first bounded page may finish a small cache immediately. Every later
      // page yields to normal mail traffic; no SDK or network call runs in the SQL transaction.
      while (!closed && !rescorePage(owner, job.token)) await yieldPage()
    })().catch(() => {
      db.query("UPDATE local_ai_rescore SET problem='AI_RESCORE_FAILED' WHERE owner=? AND token=?").run(owner, job.token)
    }).finally(() => {
      rescoring.delete(owner)
      const next = rescoreRow(owner)
      if (!closed && next && next.token !== job.token) startRescore(owner)
      else if (!closed && !next && policyAfterRescore.delete(owner)) { queuePolicyRescore(owner); startRescore(owner) }
    }))
  }
  function projected(owner: string, decision: AiDecision): AiDecision {
    const value = settings(owner), job = rescoreRow(owner)
    const pending = !!job && decision.revision <= job.through && (job.force === 2 ? needsPolicyScore(decision) : job.force !== 0 || decision.settingsRevision < value.revision)
    const interrupted = ['pending', 'processing'].includes(decision.state) && !db.query('SELECT 1 FROM local_ai_queue WHERE owner=? AND source=? AND thread=?').get(owner, decision.sourceId, decision.threadId)
    if (decision.model !== value.model || decision.settingsRevision < fenceRevision(owner) || pending || interrupted) {
      return { ...decision, settingsRevision: value.revision, state: 'stale', holdUntil: null, score: null, problemCode: 'AI_SETTINGS_CHANGED' }
    }
    return decision
  }
  function validateKey(value: unknown): asserts value is AiThreadKey {
    if (!object(value) || !idOK(value.sourceId) || !idOK(value.threadId)) fail('AI_INVALID_KEY')
  }
  async function authorizedDecision(owner: string, key: AiThreadKey): Promise<{ row: DecisionRow; value: AiDecision; message: BoundMessage; selected: Scope }> {
    validateKey(key)
    const row = decisionRow(owner, key.sourceId, key.threadId)
    if (!row) fail('AI_NOT_FOUND', 404)
    const value: AiDecision = JSON.parse(row.data), selected = await scope(owner, settings(owner), key.sourceId)
    const message = await bound(owner, value.latestMessageId, selected)
    if (!message || message.sourceId !== key.sourceId || message.threadId !== key.threadId) fail('AI_NOT_FOUND', 404)
    return { row, value: projected(owner, value), message, selected }
  }
  async function visible(owner: string, value: AiDecision, boxes: Set<string>) {
    if (!value.mailboxIds.some(id => boxes.has(id))) return false
    // Visibility needs current membership, not a sanitized reader body. Context
    // revisions are still checked by the client against its live canonical rows.
    let sliceStarted = performance.now()
    for (const mailbox of value.mailboxIds) {
      if (!boxes.has(mailbox)) continue
      if (performance.now() - sliceStarted >= 8) { await yieldPage(); sliceStarted = performance.now() }
      try { const message = await inbox.mailboxMessageSummary(owner, mailbox, value.latestMessageId); return message.sourceId === value.sourceId && message.threadId === value.threadId }
      catch (error) { if (!(error instanceof InboxError) || ![403, 404, 409].includes(error.status)) throw error }
    }
    return false
  }
  async function page(owner: string, after: number, initial: boolean): Promise<AiDecisionPage> {
    if (!Number.isSafeInteger(after) || after < 0) fail('AI_INVALID_CURSOR')
    const boundary = cursor(owner)
    if (after > boundary.head || !initial && after < boundary.floor) return { decisions: [], removed: [], cursor: boundary.head, hasMore: false, resetRequired: true }
    const selected = new Set((await scope(owner)).boxes.map(box => box.id))
    const decisions: AiDecision[] = [], removed: AiThreadKey[] = []
    let sliceStarted = performance.now()
    if (initial) {
      const rows = db.query<DecisionRow, [string, number]>('SELECT data,fingerprint,sender,seq FROM local_ai_decisions WHERE owner=? AND seq>? ORDER BY seq LIMIT 101').all(owner, after)
      for (const row of rows.slice(0, 100)) {
        if (performance.now() - sliceStarted >= 8) { await yieldPage(); sliceStarted = performance.now() }
        const value: AiDecision = JSON.parse(row.data)
        if (await visible(owner, value, selected)) decisions.push(projected(owner, value))
      }
      return { decisions, removed, cursor: rows.length > 100 ? rows[99]!.seq : boundary.head, hasMore: rows.length > 100, resetRequired: false }
    }
    const rows = db.query<{ seq: number; source: string; thread: string; removed: number }, [string, number]>('SELECT seq,source,thread,removed FROM local_ai_events WHERE owner=? AND seq>? ORDER BY seq LIMIT 101').all(owner, after)
    const keys = new Map(rows.slice(0, 100).map(row => [key(owner, row.source, row.thread), row]))
    for (const item of keys.values()) {
      if (performance.now() - sliceStarted >= 8) { await yieldPage(); sliceStarted = performance.now() }
      const row = decisionRow(owner, item.source, item.thread)
      if (row) { const value: AiDecision = JSON.parse(row.data); if (await visible(owner, value, selected)) { decisions.push(projected(owner, value)); continue } }
      removed.push({ sourceId: item.source, threadId: item.thread })
    }
    return { decisions, removed, cursor: rows.length > 100 ? rows[99]!.seq : boundary.head, hasMore: rows.length > 100, resetRequired: false }
  }
  const service = {
    async start() {
      if (started || closed) return
      started = true
      // A dispatched request may have reached the provider before a crash. It is never free.
      const interrupted = db.query<{ owner: string; data: string }, []>('SELECT owner,data FROM local_ai_attempts WHERE finished=0').all()
      for (const row of interrupted) finishAttempt(row.owner, JSON.parse(row.data), null)
      db.query("UPDATE local_ai_queue SET status='queued',due=?,attempts=MIN(attempts+1,3) WHERE status='processing'").run(now())
      db.query("UPDATE local_ai_decisions SET data=json_set(data,'$.holdUntil',NULL) WHERE json_extract(data,'$.holdUntil') IS NOT NULL").run()
      const owners = db.query<{ owner: string }, []>("SELECT owner FROM local_ai_settings WHERE json_extract(data,'$.enabled')=1 LIMIT 256").all()
      for (const { owner } of owners) {
        queuePolicyRescore(owner)
        watch(owner); schedule(owner)
        for (const row of db.query<JobRow, [string]>("SELECT * FROM local_ai_jobs WHERE owner=? AND enumerated=0 AND json_extract(data,'$.status')='running' LIMIT 20").all(owner)) startInventory(owner, row.id)
      }
      for (const { owner } of db.query<{ owner: string }, []>('SELECT owner FROM local_ai_rescore WHERE problem IS NULL LIMIT 256').all()) startRescore(owner)
      timer = setInterval(() => { for (const owner of subscriptions.keys()) schedule(owner); pump() }, 1000)
      timer.unref?.(); pump()
    },
    async close() {
      if (closed) return
      closed = true; if (timer) clearInterval(timer)
      for (const unsubscribe of subscriptions.values()) unsubscribe()
      subscriptions.clear()
      for (const running of active.values()) running.controller.abort()
      await Promise.allSettled([...active.values()].map(item => item.task))
      await Promise.allSettled([...work, ...locks.values()])
      for (const statement of Object.values(journalStatements)) statement.finalize()
    },
    async state(owner: string): Promise<AiTriageState> {
      const counts = db.query<{ status: string; count: number }, [string]>('SELECT status,COUNT(*) count FROM local_ai_queue WHERE owner=? GROUP BY status').all(owner)
      const failed = db.query<{ count: number }, [string]>("SELECT COUNT(*) count FROM local_ai_decisions WHERE owner=? AND json_extract(data,'$.state')='failed'").get(owner)?.count ?? 0
      const value = settings(owner)
      return { configured: !!configuration, provider: configuration ? publicAiProvider(configuration) : null, problemCode: configuration ? configuration.models.some(model => model.id === value.model) ? recoveryRow(owner)?.problem ?? rescoreRow(owner)?.problem ?? db.query<CoverageRow, [string]>('SELECT counts,last_drain,problem FROM local_ai_coverage WHERE owner=?').get(owner)?.problem ?? null : 'AI_MODEL_UNAVAILABLE' : configurationProblem && /^[A-Z][A-Z0-9_]{0,79}$/.test(configurationProblem) ? configurationProblem : 'AI_NOT_CONFIGURED', settings: value, queue: { pending: counts.find(item => item.status === 'queued')?.count ?? 0, processing: counts.find(item => item.status === 'processing')?.count ?? 0, failed }, usage: usage(owner), jobs: db.query<{ data: string }, [string]>('SELECT data FROM local_ai_jobs WHERE owner=? ORDER BY rowid DESC LIMIT 20').all(owner).map(row => JSON.parse(row.data)), cursor: cursor(owner).head }
    },
    configure(owner: string, input: AiSettings): Promise<AiTriageState> { return serial(owner, async () => {
      if (!object(input) || Object.keys(input).some(key => !['revision', 'enabled', 'mode', 'model', 'mailboxIds', 'personalization', 'readingSignals', 'interests'].includes(key)) || !Number.isSafeInteger(input.revision) || input.revision < 0 || typeof input.enabled !== 'boolean' || !['preview', 'apply'].includes(input.mode) || typeof input.model !== 'string' || input.model.length > 200 || typeof input.personalization !== 'boolean' || typeof input.readingSignals !== 'boolean' || !Array.isArray(input.interests) || input.interests.length > 64 || input.interests.some(topic => typeof topic !== 'string' || topic.length > 256) || input.mailboxIds !== null && (!Array.isArray(input.mailboxIds) || input.mailboxIds.length > 1000 || input.mailboxIds.some(id => !idOK(id)))) fail('AI_INVALID_SETTINGS')
      const previous = settings(owner), priorRow = settingsRow(owner)
      if (!priorRow && (db.query<{ count: number }, []>('SELECT COUNT(*) count FROM local_ai_settings').get()?.count ?? 0) >= 256) fail('AI_OWNER_LIMIT', 429)
      if (previous.revision !== input.revision) fail('AI_SETTINGS_CONFLICT', 412)
      if (input.enabled && !configuration) fail('AI_NOT_CONFIGURED', 503)
      if (configuration && !configuration.models.some(model => model.id === input.model)) fail('AI_MODEL_UNAVAILABLE')
      const boxes = await inbox.mailboxes(owner)
      if (input.mailboxIds?.some(id => !boxes.some(box => box.id === id && box.status === 'active'))) fail('AI_SCOPE_NOT_FOUND', 404)
      const value: AiSettings = { ...input, revision: previous.revision + 1, mailboxIds: input.mailboxIds === null ? null : [...new Set(input.mailboxIds)].sort(), interests: normalizeAiTopics(input.interests) }
      const invalidated = previous.model !== value.model || JSON.stringify(previous.mailboxIds) !== JSON.stringify(value.mailboxIds)
      const fenced = previous.enabled !== value.enabled || invalidated
      const pauseOnly = previous.enabled !== value.enabled && !invalidated && previous.personalization === value.personalization && previous.readingSignals === value.readingSignals && JSON.stringify(previous.interests) === JSON.stringify(value.interests)
      const head = fenced || !priorRow ? (await inbox.changes(owner, { limit: 1 })).state : priorRow.cursor
      transaction(() => {
        if (settings(owner).revision !== previous.revision) fail('AI_SETTINGS_CONFLICT', 412)
        const generation = (priorRow?.generation ?? 0) + Number(fenced || !priorRow)
        db.query('INSERT INTO local_ai_settings(owner,data,generation,cursor,baseline,admission_since) VALUES (?,?,?,?,?,?) ON CONFLICT(owner) DO UPDATE SET data=excluded.data,generation=excluded.generation,cursor=excluded.cursor,baseline=excluded.baseline,admission_since=excluded.admission_since').run(owner, JSON.stringify(value), generation, head, fenced ? now() : priorRow?.baseline ?? now(), fenced ? now() : priorRow?.admission_since ?? now())
        if (fenced) {
          for (const running of active.values()) if (running.owner === owner) running.controller.abort()
          db.query('DELETE FROM local_ai_queue WHERE owner=?').run(owner)
          db.query('DELETE FROM local_ai_recovery WHERE owner=?').run(owner); db.query('DELETE FROM local_ai_recovery_seen WHERE owner=?').run(owner); recoveryPages.delete(owner)
          const jobs = db.query<JobRow, [string]>('SELECT * FROM local_ai_jobs WHERE owner=? LIMIT 20').all(owner)
          for (const row of jobs) { const job: AiHistoryJob = JSON.parse(row.data); if (['running', 'paused'].includes(job.status)) { job.status = 'cancelled'; job.problemCode = 'AI_SETTINGS_CHANGED'; saveJob(row, job) } }
        }
        // Pausing does not reinterpret a ready receipt. Preserve any already
        // pending local preference/policy pass, including its token and high-water.
        if (pauseOnly) db.query('UPDATE local_ai_rescore SET revision=? WHERE owner=?').run(value.revision, owner)
        else queueRescore(owner, value, invalidated)
      })
      if (pauseOnly && value.enabled) queuePolicyRescore(owner)
      startRescore(owner)
      if (value.enabled) { watch(owner); schedule(owner) } else { subscriptions.get(owner)?.(); subscriptions.delete(owner) }
      return service.state(owner)
    }) },
    process(owner: string, input: { id: string; scope: 'inbox' | 'all'; limit: number; settingsRevision?: number }): Promise<AiHistoryJob> { return serial(owner, async () => {
      if (!object(input) || Object.keys(input).some(key => !['id', 'scope', 'limit', 'settingsRevision'].includes(key)) || !commandOK(input.id) || !['inbox', 'all'].includes(input.scope) || !Number.isInteger(input.limit) || input.limit < 100 || input.limit > 10000 || input.settingsRevision !== undefined && (!Number.isSafeInteger(input.settingsRevision) || input.settingsRevision < 0)) fail('AI_INVALID_JOB')
      const receipt = (): AiHistoryJob | null => {
        const previous = jobRow(owner, input.id); if (!previous) return null
        const job: AiHistoryJob = JSON.parse(previous.data)
        if (job.scope !== input.scope || job.limit !== input.limit || input.settingsRevision !== undefined && job.settingsRevision !== input.settingsRevision) fail('AI_JOB_CONFLICT', 409)
        return job
      }
      // A matching durable command stays idempotent even after settings change.
      const previous = receipt(); if (previous) return previous
      const row = settingsRow(owner), value: AiSettings = row ? JSON.parse(row.data) : defaultSettings()
      if (input.settingsRevision !== undefined && input.settingsRevision !== value.revision) fail('AI_SETTINGS_CONFLICT', 412)
      if (!configuration) fail('AI_NOT_CONFIGURED', 503)
      if (!row || !value.enabled) fail('AI_DISABLED', 409)
      const selected = await scope(owner, value)
      let created = false
      const job = transaction(() => {
        const previous = receipt(); if (previous) return previous
        const current = settingsRow(owner)
        if (!current || current.generation !== row.generation || JSON.parse(current.data).revision !== value.revision) fail('AI_SETTINGS_CONFLICT', 412)
        if (!selected.boxes.length) fail('AI_EMPTY_SCOPE', 409)
        const activeJobs = db.query<{ count: number }, [string]>("SELECT COUNT(*) count FROM local_ai_jobs WHERE owner=? AND json_extract(data,'$.status') IN ('running','paused')").get(owner)!.count
        if (activeJobs >= 3) fail('AI_JOB_LIMIT', 429)
        const job: AiHistoryJob = { id: input.id, status: 'running', scope: input.scope, limit: input.limit, settingsRevision: value.revision, scanned: 0, queued: 0, completed: 0, failed: 0, createdAt: stamp(now()), problemCode: null }
        db.query('INSERT INTO local_ai_jobs(owner,id,data,generation,boxes,input_policy) VALUES (?,?,?,?,?,?)').run(owner, job.id, JSON.stringify(job), row.generation, JSON.stringify(selected.boxes.map(box => box.id)), AI_INPUT_POLICY_VERSION)
        const old = db.query<{ id: string }, [string]>("SELECT id FROM local_ai_jobs WHERE owner=? AND json_extract(data,'$.status') NOT IN ('running','paused') ORDER BY rowid DESC LIMIT 100 OFFSET 17").all(owner)
        for (const item of old) { db.query('DELETE FROM local_ai_job_items WHERE owner=? AND job=?').run(owner, item.id); db.query('DELETE FROM local_ai_jobs WHERE owner=? AND id=?').run(owner, item.id) }
        created = true
        return job
      })
      if (created) startInventory(owner, job.id)
      return job
    }) },
    control(owner: string, id: string, action: 'pause' | 'resume' | 'cancel'): Promise<AiHistoryJob> { return serial(owner, async () => {
      if (!commandOK(id) || !['pause', 'resume', 'cancel'].includes(action)) fail('AI_INVALID_JOB')
      const row = jobRow(owner, id); if (!row) fail('AI_JOB_NOT_FOUND', 404)
      const job: AiHistoryJob = JSON.parse(row.data)
      if (!['running', 'paused'].includes(job.status)) return job
      if (action === 'resume' && (!settings(owner).enabled || settingsRow(owner)?.generation !== row.generation)) fail('AI_JOB_STALE', 409)
      job.status = action === 'pause' ? 'paused' : action === 'resume' ? 'running' : 'cancelled'
      if (action === 'resume' && !row.enumerated) job.problemCode = null
      saveJob(row, job)
      if (action !== 'resume') {
        for (const running of active.values()) if (running.owner === owner && running.job === id) running.controller.abort()
        db.query("UPDATE local_ai_queue SET status='queued' WHERE owner=? AND job=?").run(owner, id)
        if (action === 'cancel') {
          const queues = db.query<QueueRow, [string, string]>('SELECT * FROM local_ai_queue WHERE owner=? AND job=?').all(owner, id)
          for (const queue of queues) {
            const other = db.query<{ job: string }, [string, string, string, string]>("SELECT i.job FROM local_ai_job_items i JOIN local_ai_jobs j ON j.owner=i.owner AND j.id=i.job WHERE i.owner=? AND i.source=? AND i.thread=? AND i.job<>? AND i.status='pending' AND json_extract(j.data,'$.status') IN ('running','paused') LIMIT 1").get(owner, queue.source, queue.thread, id)
            if (other) db.query('UPDATE local_ai_queue SET job=? WHERE owner=? AND source=? AND thread=?').run(other.job, owner, queue.source, queue.thread)
            else { db.query('DELETE FROM local_ai_queue WHERE owner=? AND source=? AND thread=?').run(owner, queue.source, queue.thread); const previous = decisionRow(owner, queue.source, queue.thread); if (previous) { const decision: AiDecision = JSON.parse(previous.data); decision.state = 'stale'; decision.holdUntil = null; decision.problemCode = 'AI_JOB_CANCELLED'; transaction(() => publish(owner, decision, previous.fingerprint, previous.sender)) } }
          }
          schedule(owner)
        }
      } else { if (!row.enumerated) startInventory(owner, id); pump() }
      return job
    }) },
    async lookup(owner: string, keys: AiThreadKey[]): Promise<AiDecisionPage> {
      if (!Array.isArray(keys) || keys.length > 100) fail('AI_LOOKUP_LIMIT')
      const decisions: AiDecision[] = [], seen = new Set<string>()
      for (const item of keys) {
        validateKey(item)
        const id = key(owner, item.sourceId, item.threadId)
        if (seen.has(id)) continue
        seen.add(id)
        const row = decisionRow(owner, item.sourceId, item.threadId)
        if (!row) continue
        const value: AiDecision = JSON.parse(row.data)
        if (value.sourceId !== item.sourceId || value.threadId !== item.threadId) continue
        try {
          const selected = await scope(owner, settings(owner), item.sourceId)
          if (await visible(owner, value, new Set(selected.boxes.map(box => box.id)))) decisions.push(projected(owner, value))
        } catch (error) { if (!(error instanceof InboxError) || error.status !== 404) throw error }
      }
      return { decisions, removed: [], cursor: cursor(owner).head, hasMore: false, resetRequired: false }
    },
    changes(owner: string, after: number) { return page(owner, after, false) },
    results(owner: string, after = 0) { return page(owner, after, true) },
    feedback(owner: string, input: AiFeedbackInput): Promise<AiDecision> { return serial(owner, async () => {
      validateKey(input)
      if (!commandOK(input.id) || !Number.isSafeInteger(input.revision) || input.revision <= 0 || ![null, 'Important', 'Other'].includes(input.category) || input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 1000) || Object.keys(input).some(key => !['sourceId', 'threadId', 'id', 'revision', 'category', 'note'].includes(key))) fail('AI_INVALID_FEEDBACK')
      const inputHash = digest(input)
      const prior = db.query<{ input: string; result: string }, [string, string]>('SELECT input,result FROM local_ai_feedback WHERE owner=? AND id=?').get(owner, input.id)
      if (prior) { if (prior.input !== inputHash) fail('AI_FEEDBACK_CONFLICT', 409); await authorizedDecision(owner, input); return projected(owner, JSON.parse(prior.result)) }
      const { row, value: decision, message } = await authorizedDecision(owner, input)
      if (decision.revision !== input.revision || !decision.inputHash || !decision.assessment || decision.state !== 'ready' || !decision.contextVersions.some(item => item.messageId === message.id && item.bodyRevision === (message.bodyRevision ?? null))) fail('AI_DECISION_CONFLICT', 412)
      const currentSettings = settings(owner), context = await prepare(owner, input.sourceId, input.threadId, currentSettings)
      if (!context || !capturedContext(owner, context, decision, currentSettings)) fail('AI_DECISION_CONFLICT', 412)
      transaction(() => {
        if (decisionRow(owner, input.sourceId, input.threadId)?.seq !== row.seq) fail('AI_DECISION_CONFLICT', 412)
        decision.override = input.category ? { category: input.category, inputHash: decision.inputHash!, at: stamp(now()) } : null
        // Record the new vote first so clearing an override cannot score against the
        // superseded explicit choice. The receipt and revision commit atomically.
        db.query('INSERT INTO local_ai_feedback(owner,id,source,thread,hash,sender,topics,choice,at,input,result,note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(owner, input.id, input.sourceId, input.threadId, decision.inputHash, row.sender, JSON.stringify(decision.assessment!.topics.map(topic => hashIdentity(owner, `topic:${topic}`))), input.category === 'Important' ? 1 : input.category === 'Other' ? -1 : 0, now(), inputHash, '{}', input.note ?? null)
        const current = settings(owner)
        decision.score = score(owner, decision.assessment!, row.sender, current, decision.override); decision.settingsRevision = current.revision; decision.updatedAt = stamp(now())
        publish(owner, decision, row.fingerprint, row.sender, undefined, 'feedback')
        db.query('UPDATE local_ai_feedback SET result=? WHERE owner=? AND id=?').run(JSON.stringify(decision), owner, input.id)
        db.query('DELETE FROM local_ai_feedback WHERE owner=? AND seq<(SELECT seq FROM local_ai_feedback WHERE owner=? ORDER BY seq DESC LIMIT 1 OFFSET 9999)').run(owner, owner)
      })
      return decision
    }) },
    reading(owner: string, input: AiReadingInput): Promise<void> { return serial(owner, async () => {
      validateKey(input)
      if (!commandOK(input.visitId) || !idOK(input.messageId) || !Number.isSafeInteger(input.sequence) || input.sequence < 1 || !Number.isSafeInteger(input.activeMs) || input.activeMs < 0 || input.activeMs > 600_000 || Object.keys(input).some(key => !['sourceId', 'threadId', 'visitId', 'sequence', 'messageId', 'activeMs'].includes(key))) fail('AI_INVALID_READING')
      const value = settings(owner)
      if (!value.enabled || !value.readingSignals || !value.personalization) return
      const selected = await scope(owner, value, input.sourceId), message = await bound(owner, input.messageId, selected)
      if (!message || message.sourceId !== input.sourceId || message.threadId !== input.threadId) fail('AI_NOT_FOUND', 404)
      if (outgoing(message, selected)) return
      const sender = hashIdentity(owner, message.from.email), day = Math.floor(now() / DAY)
      transaction(() => {
        const prior = db.query<{ message: string; sequence: number; active: number; at: number }, [string, string]>('SELECT message,sequence,active,at FROM local_ai_visits WHERE owner=? AND id=?').get(owner, input.visitId)
        if (prior && prior.message !== message.id) fail('AI_READING_CONFLICT', 409)
        if (prior && input.sequence <= prior.sequence) return
        if (prior && input.activeMs < prior.active) fail('AI_READING_CONFLICT', 409)
        const delta = Math.min(30_000, Math.max(0, input.activeMs - (prior?.active ?? 0)), prior ? Math.max(0, now() - prior.at) + 1000 : 1000)
        const total = db.query<{ ms: number }, [string, number]>('SELECT COALESCE(SUM(ms),0) ms FROM local_ai_reading WHERE owner=? AND day=?').get(owner, day)!.ms
        const senderTotal = db.query<{ ms: number }, [string, string, number]>('SELECT ms FROM local_ai_reading WHERE owner=? AND sender=? AND day=?').get(owner, sender, day)?.ms ?? 0
        const messageTotal = db.query<{ ms: number }, [string, string, number]>('SELECT ms FROM local_ai_message_reading WHERE owner=? AND message=? AND day=?').get(owner, message.id, day)?.ms ?? 0
        const accepted = Math.max(0, Math.min(delta, 300_000 - messageTotal, 600_000 - senderTotal, 3_600_000 - total))
        db.query('INSERT INTO local_ai_visits VALUES (?,?,?,?,?,?) ON CONFLICT(owner,id) DO UPDATE SET sequence=excluded.sequence,active=excluded.active,at=excluded.at').run(owner, input.visitId, message.id, input.sequence, input.activeMs, now())
        db.query('INSERT INTO local_ai_reading VALUES (?,?,?,?) ON CONFLICT(owner,sender,day) DO UPDATE SET ms=ms+excluded.ms').run(owner, sender, day, accepted)
        db.query('INSERT INTO local_ai_message_reading VALUES (?,?,?,?) ON CONFLICT(owner,message,day) DO UPDATE SET ms=ms+excluded.ms').run(owner, message.id, day, accepted)
        db.query('DELETE FROM local_ai_reading WHERE owner=? AND day<?').run(owner, day - 30)
        db.query('DELETE FROM local_ai_message_reading WHERE owner=? AND day<?').run(owner, day - 30)
        db.query('DELETE FROM local_ai_visits WHERE owner=? AND rowid IN (SELECT rowid FROM local_ai_visits WHERE owner=? ORDER BY at DESC LIMIT -1 OFFSET 2000)').run(owner, owner)
      })
    }) },
    clearReading(owner: string): Promise<void> { return serial(owner, async () => { transaction(() => { db.query('DELETE FROM local_ai_reading WHERE owner=?').run(owner); db.query('DELETE FROM local_ai_message_reading WHERE owner=?').run(owner); queueRescore(owner, settings(owner), false, true) }); startRescore(owner) }) },
    async diagnostics(owner: string): Promise<AiDiagnostics> {
      const coverage = db.query<CoverageRow, [string]>('SELECT counts,last_drain,problem FROM local_ai_coverage WHERE owner=?').get(owner)
      const saved = coverage ? JSON.parse(coverage.counts) : {}, counts: Partial<Record<AiActivityReason, number>> = {}
      for (const reason of aiActivityReasons) if (Number.isSafeInteger(saved[reason]) && saved[reason] >= 0) counts[reason] = saved[reason]
      const boundary = settingsRow(owner)?.admission_since
      return { usage: usage(owner), attempts: db.query<{ data: string }, [string]>('SELECT data FROM local_ai_attempts WHERE owner=? ORDER BY seq DESC LIMIT 50').all(owner).map(row => JSON.parse(row.data)),
        activity: db.query<{ seq: number; data: string }, [string]>('SELECT seq,data FROM local_ai_activity WHERE owner=? ORDER BY seq DESC LIMIT 50').all(owner).map(row => ({ ...JSON.parse(row.data), id: row.seq })),
        coverage: { admissionSince: boundary === undefined ? null : stamp(boundary), lastDrainAt: coverage?.last_drain == null ? null : stamp(coverage.last_drain), problemCode: recoveryRow(owner)?.problem ?? rescoreRow(owner)?.problem ?? coverage?.problem ?? null, counts } }
    },
  }
  function safe<Args extends unknown[], Result>(fn: (...args: Args) => Promise<Result>): (...args: Args) => Promise<Result> {
    return async (...args) => {
      try { return await fn(...args) }
      catch (error) {
        if (error instanceof InboxError && /^AI_[A-Z0-9_]{1,76}$/.test(error.code)) throw new InboxError(error.code, 'AI triage could not complete this request.', error.status)
        if (error instanceof InboxError && [403, 404].includes(error.status)) fail('AI_NOT_FOUND', 404)
        if (error instanceof InboxError && error.status === 409) fail('AI_SCOPE_CHANGED', 409)
        fail('AI_SERVICE_FAILED', 503)
      }
    }
  }
  return { start: safe(service.start), close: safe(service.close), state: safe(service.state), configure: safe(service.configure), process: safe(service.process), control: safe(service.control), lookup: safe(service.lookup), changes: safe(service.changes), results: safe(service.results), feedback: safe(service.feedback), reading: safe(service.reading), clearReading: safe(service.clearReading), diagnostics: safe(service.diagnostics) }
}

export type AiTriageService = ReturnType<typeof createAiTriageService>
