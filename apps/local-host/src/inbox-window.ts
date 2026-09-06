import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Database } from 'bun:sqlite'
import { InboxError, type Inbox, type Account, type Mailbox, type Label, type Folder, type MailboxMessageSummary, type MailboxMembership, type MailboxStateReceipt, type MailboxStateTarget, type MailboxConversation } from 'inbox-sdk'
import type { CategoryContext, CategoryEntry, CategoryReceipt } from '../../shared/attention-overrides'
import * as DTO from '../../shared/inbox-window'
import { projectMailboxMail } from '../../shared/mail-projection'
import { importantExpiry, recentImportant, IMPORTANT_WINDOW_MS, IMPORTANT_WINDOW_VERSION } from '../../shared/important-window'
import { AI_PREFERENCE_VERSION } from '../../shared/ai-triage'
import { ATTENTION_VERSION, classifyAttention, conversationAttention } from '../../shared/mail-attention'
import { normalizeSplits, attentionSplit } from '../../shared/splits'
import { currentAiDecision, currentCategoryOverride, inFolder } from '../../web/src/mail-model'
import { compileSearch, parseSearch } from '../../web/src/mail-search'
import { zeroScope, zeroEligible, zeroReviewVersion, zeroBatchCandidate } from '../../web/src/mail-view'
import { senderContact, senderHostname, type SenderHistoryMessage } from '../../web/src/sender-context'
import type { Mail, Preferences } from '../../web/src/data'
import type { AiTriageState, AiDecision } from '../../shared/ai-triage'
import type { createInboxViewPreferencesStore } from './inbox-preferences'
import type { createSplitPreferencesStore } from './split-preferences'
import type { createAttentionOverridesStore } from './attention-overrides'
import type { createAiTriageService } from './ai-triage'
import type { createSenderDomainHost, SenderDomainInfo } from './sender-domains'

const BATCH = 50, RAW_BATCH = 500, QUERY_TTL = 30 * 60_000, MAX_ACTIVE = 16
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
const wait = () => new Promise<void>(resolve => setTimeout(resolve, 0))
const fail = (code: DTO.InboxWindowErrorCode, status = 400): never => { throw new InboxError(code, ({
  HOST_INBOX_INVALID: 'Invalid inbox request.', HOST_INBOX_TOO_LARGE: 'The selected context exceeds the bounded inbox response.',
  HOST_INBOX_QUERY_EXPIRED: 'Reopen the current inbox query.', HOST_INBOX_CURSOR_INVALID: 'The inbox cursor does not match this request.',
  HOST_INBOX_SCOPE_CHANGED: 'The receiving scope changed. Reopen the inbox.', HOST_INBOX_CONTEXT_CHANGED: 'The captured conversation changed. Review it again.',
  HOST_INBOX_UNAVAILABLE: 'The inbox index or required receipt is not available yet.', HOST_INBOX_PREPARING: 'Preparing the selected conversations.',
  HOST_ZERO_SESSION_CONFLICT: 'The cleanup session changed. Resume it before continuing.',
  HOST_ZERO_SESSION_NOT_FOUND: 'The cleanup session is no longer available.',
} satisfies Record<DTO.InboxWindowErrorCode, string>)[code], status) }
const text = (value: unknown, maximum = 1024): string => typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value) ? value : fail('HOST_INBOX_INVALID')
const limit = (value: unknown, maximum = 100) => value === undefined ? maximum : Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= maximum ? Number(value) : fail('HOST_INBOX_INVALID')
const ids = (value: unknown, maximum = 100): string[] => Array.isArray(value) && value.length <= maximum && new Set(value).size === value.length ? value.map(id => text(id)) : fail('HOST_INBOX_INVALID')
const integer = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fail('HOST_INBOX_INVALID')
const json = <T>(value: string): T => JSON.parse(value) as T

type Dependencies = {
  database: Database; inbox: Inbox; owner: string; sessionKey: string | Buffer; allowProviderWrites: boolean
  inboxPreferences: ReturnType<typeof createInboxViewPreferencesStore>
  splitPreferences: ReturnType<typeof createSplitPreferencesStore>
  attentionOverrides: ReturnType<typeof createAttentionOverridesStore>
  ai: ReturnType<typeof createAiTriageService>
  senderDomains?: ReturnType<typeof createSenderDomainHost>
}
type ScopeRow = { id: string; account: string; data: string; cursor: string | null; baseline: string | null; sdk_state: string | null; sdk_scope: string; raw_complete: number; revision: number; generation: number; reset: string | null; checked: number }
type ReadBaseline = { sdkState: string | null; scopeState: string; revision: number; ai: number; category: number; at: number }
type Scope = { row: ScopeRow; boxes: Mailbox[]; sources: Account[]; labels: Label[]; folders: Map<string, Folder[]>; preference: string; preferences: Preferences; ai: AiTriageState; users: number; lastUsed: number; metadataAt: number; metadataDirty: boolean; seenEvents: number; read?: ReadBaseline }
type ProjectionStamp = { preference?: string; metadata?: string; aiCursor?: number; categoryCursor?: number; contextVersion?: 3 }
type QueryRow = { id: string; scope: string; data: string; preference: string; scanned: number; generation: number; expires: number; problem: string | null; read_state: string | null }
type ReadMetadata = { importantSince?: string; baselines: Array<{ revision: number; token: string }>; wake?: number; changes?: { id: string; input: string; baseline: ReadBaseline; keys: string[]; head: boolean; more: boolean }; counts?: { position?: PagePosition; progress?: number; baseline: ReadBaseline; totals: DTO.InboxTotals; complete: boolean; wake?: number } }
type ReadBudget = { pages: number; details: number; searches: number; now: number; legacy: Map<string, string>; summaries: Map<string, MailboxMessageSummary[]>; contexts: Map<string, string>; keys: DTO.InboxThreadKey[]; proofs: Map<string, Map<string, boolean>>; unknownLocation: Set<string>; detailDeferred: Set<string> }
type PagePosition = { cursor?: string }
type PageCursor = { older: string; newer: string; baseline: Readonly<ReadBaseline>; direction: 'older' | 'newer' }
type PageableRow = DTO.InboxWindowRow & { pageCursor: string }
const readBudget = (): ReadBudget => ({ pages: 5, details: 4, searches: 32, now: Date.now(), legacy: new Map(), summaries: new Map(), contexts: new Map(), keys: [], proofs: new Map(), unknownLocation: new Set(), detailDeferred: new Set() })
type StoredRow = { key: string; source: string; thread: string; data: string; at: number; revision: number; context: string }
type CaptureRow = { id: string; kind: string; scope: string; data: string; input: string; cursor: number; complete: number; revision: number }

/** All SQL in this service addresses its own derived local_window_* tables. SDK data
 * enters only through public body-free pages/deltas; no provider calls or AI processing.
 */
export function createInboxWindowService(deps: Dependencies) {
  const { database: db, inbox, owner } = deps
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_window_scopes(owner TEXT NOT NULL,id TEXT NOT NULL,account TEXT NOT NULL,data TEXT NOT NULL,cursor TEXT,baseline TEXT,sdk_state TEXT,sdk_scope TEXT NOT NULL DEFAULT '',raw_complete INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0,generation INTEGER NOT NULL DEFAULT 1,reset TEXT,checked INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(owner,id)) STRICT;
    CREATE TABLE IF NOT EXISTS local_window_messages(owner TEXT NOT NULL,scope TEXT NOT NULL,source TEXT NOT NULL,id TEXT NOT NULL,thread TEXT NOT NULL,at TEXT NOT NULL,folder TEXT NOT NULL,attention TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(owner,scope,source,id)) STRICT;
    CREATE INDEX IF NOT EXISTS local_window_message_thread ON local_window_messages(owner,scope,source,thread,at,id);
    CREATE TABLE IF NOT EXISTS local_window_dirty(owner TEXT NOT NULL,scope TEXT NOT NULL,source TEXT NOT NULL,thread TEXT NOT NULL,PRIMARY KEY(owner,scope,source,thread)) STRICT;
    CREATE TABLE IF NOT EXISTS local_window_rows(owner TEXT NOT NULL,scope TEXT NOT NULL,key TEXT NOT NULL,source TEXT NOT NULL,thread TEXT NOT NULL,at INTEGER NOT NULL,revision INTEGER NOT NULL,context TEXT NOT NULL,data TEXT NOT NULL,wake INTEGER,PRIMARY KEY(owner,scope,key)) STRICT;
    CREATE INDEX IF NOT EXISTS local_window_row_revision ON local_window_rows(owner,scope,revision,key);
    CREATE INDEX IF NOT EXISTS local_window_row_order ON local_window_rows(owner,scope,at DESC,key);
    CREATE INDEX IF NOT EXISTS local_window_row_thread ON local_window_rows(owner,scope,source,thread);
    CREATE INDEX IF NOT EXISTS local_window_row_wake ON local_window_rows(owner,scope,wake);
    CREATE TABLE IF NOT EXISTS local_window_queries(owner TEXT NOT NULL,id TEXT NOT NULL,scope TEXT NOT NULL,data TEXT NOT NULL,preference TEXT NOT NULL,scanned INTEGER NOT NULL DEFAULT 0,generation INTEGER NOT NULL,expires INTEGER NOT NULL,problem TEXT,PRIMARY KEY(owner,id)) STRICT;
    CREATE TABLE IF NOT EXISTS local_window_matches(owner TEXT NOT NULL,query_id TEXT NOT NULL,key TEXT NOT NULL,at INTEGER NOT NULL,messages INTEGER NOT NULL,PRIMARY KEY(owner,query_id,key)) STRICT;
    CREATE INDEX IF NOT EXISTS local_window_match_order ON local_window_matches(owner,query_id,at DESC,key);
    CREATE TABLE IF NOT EXISTS local_window_counts(owner TEXT NOT NULL,query_id TEXT NOT NULL,key TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(owner,query_id,key)) STRICT;
    CREATE TABLE IF NOT EXISTS local_window_query_pending(owner TEXT NOT NULL,query_id TEXT NOT NULL,key TEXT NOT NULL,PRIMARY KEY(owner,query_id,key)) STRICT;
    CREATE TABLE IF NOT EXISTS local_window_contacts(owner TEXT NOT NULL,scope TEXT NOT NULL,source TEXT NOT NULL,message TEXT NOT NULL,thread TEXT NOT NULL,email TEXT NOT NULL,name TEXT NOT NULL,direction TEXT NOT NULL,at INTEGER NOT NULL,folder TEXT NOT NULL,PRIMARY KEY(owner,scope,source,message,email,direction)) STRICT;
    CREATE INDEX IF NOT EXISTS local_window_contact_address ON local_window_contacts(owner,scope,email,at DESC);
    CREATE INDEX IF NOT EXISTS local_window_contact_thread ON local_window_contacts(owner,scope,source,thread,message);
    CREATE TABLE IF NOT EXISTS local_window_captures(owner TEXT NOT NULL,id TEXT NOT NULL,kind TEXT NOT NULL,scope TEXT NOT NULL,data TEXT NOT NULL,input TEXT NOT NULL,cursor INTEGER NOT NULL DEFAULT 0,complete INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(owner,id)) STRICT;
    CREATE TABLE IF NOT EXISTS local_window_capture_items(owner TEXT NOT NULL,capture TEXT NOT NULL,ordinal INTEGER NOT NULL,key TEXT NOT NULL,context TEXT NOT NULL,review TEXT NOT NULL,data TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'remaining',PRIMARY KEY(owner,capture,key),UNIQUE(owner,capture,ordinal)) STRICT;
    CREATE TABLE IF NOT EXISTS local_window_progress(owner TEXT NOT NULL,id TEXT NOT NULL,capture TEXT NOT NULL,input TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(owner,id)) STRICT;
    CREATE TABLE IF NOT EXISTS local_window_prefix(owner TEXT NOT NULL,query_id TEXT NOT NULL,cursor TEXT,exhausted INTEGER NOT NULL DEFAULT 0,indexed INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(owner,query_id)) STRICT;
    CREATE TABLE IF NOT EXISTS local_window_prefix_rows(owner TEXT NOT NULL,query_id TEXT NOT NULL,key TEXT NOT NULL,PRIMARY KEY(owner,query_id,key)) STRICT;
    CREATE TABLE IF NOT EXISTS local_window_zero_receipts(owner TEXT NOT NULL,receipt TEXT NOT NULL,key TEXT NOT NULL,progress TEXT NOT NULL,context TEXT NOT NULL,PRIMARY KEY(owner,receipt,key)) STRICT;
  `)
  if (!db.query<{ name: string }, []>('PRAGMA table_info(local_window_queries)').all().some(column => column.name === 'read_state')) db.exec('ALTER TABLE local_window_queries ADD COLUMN read_state TEXT')
  let closed = false, timer: ReturnType<typeof setTimeout> | undefined, working: Promise<void> | undefined
  let activeRequests = 0, aiCursor: number | undefined, categoryCursor: number | undefined, watched = false
  let workingScope: Scope | undefined, watchedVersion = 0, projectionWork: Promise<void> | undefined
  const requests = new AsyncLocalStorage<Set<Scope>>()
  const scopes = new Map<string, Scope>()
  // Only an explicit selection/Zero creation can lease the dormant capture index.
  // Rejected preparation requests have no accepted ID and cannot capture later arrivals.
  const preparations = new Map<string, { until: number; queries: Set<string> }>()
  const pruning = new Set<string>()
  const pendingContext = new InboxError('HOST_INBOX_UNAVAILABLE', 'This conversation needs more complete cached context.', 503)
  const unwatch = inbox.subscribe(owner, () => { watched = true; watchedVersion++; for (const scope of scopes.values()) scope.metadataDirty = true })
  const getScopeRow = (id: string) => db.query<ScopeRow, [string, string]>('SELECT * FROM local_window_scopes WHERE owner=? AND id=?').get(owner, id)!
  const getQuery = (id: string) => db.query<QueryRow, [string, string]>('SELECT * FROM local_window_queries WHERE owner=? AND id=?').get(owner, id)
  const queryPending = (query: QueryRow) => !!db.query('SELECT 1 FROM local_window_query_pending WHERE owner=? AND query_id=? LIMIT 1').get(owner, query.id)
  const refresh = (scope: Scope) => { scope.row = getScopeRow(scope.row.id); return scope }
  const dirty = (scope: string, source: string, thread: string) => db.query('INSERT OR IGNORE INTO local_window_dirty VALUES (?,?,?,?)').run(owner, scope, source, thread)
  const record = (scope: Scope, key: string) => db.query<StoredRow, [string, string, string]>('SELECT * FROM local_window_rows WHERE owner=? AND scope=? AND key=?').get(owner, scope.row.id, key)
  const reviewToken = (capture: string, review: string) => createHmac('sha256', deps.sessionKey).update(JSON.stringify([owner, capture, review])).digest('hex')
  const hasDirty = (scope: Scope) => !!db.query('SELECT 1 FROM local_window_dirty WHERE owner=? AND scope=? LIMIT 1').get(owner, scope.row.id)
  const current = (scope: Scope) => !!refresh(scope).row.raw_complete && !hasDirty(scope) && !scope.row.reset && scope.seenEvents === watchedVersion && (aiCursor ?? scope.ai.cursor) >= scope.ai.cursor && Date.now() - scope.row.checked < 10_000
  const bump = (scope: Scope) => { db.query('UPDATE local_window_scopes SET revision=revision+1 WHERE owner=? AND id=?').run(owner, scope.row.id); refresh(scope); return scope.row.revision }
  function token(kind: string, scope: Scope, value: unknown) {
    const data = Buffer.from(JSON.stringify({ kind, owner, scope: scope.row.id, generation: scope.row.generation, value })).toString('base64url')
    return `${data}.${createHmac('sha256', deps.sessionKey).update(data).digest('base64url')}`
  }
  function untoken<T>(encoded: string, kind: string, scope: Scope): T {
    const [data, mac, extra] = text(encoded, 16384).split('.')
    const expected = createHmac('sha256', deps.sessionKey).update(data!).digest()
    const actual = Buffer.from(mac ?? '', 'base64url')
    if (extra || actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail('HOST_INBOX_CURSOR_INVALID')
    let decoded: { kind: string; owner: string; scope: string; generation: number; value: T }
    try { decoded = JSON.parse(Buffer.from(data!, 'base64url').toString()) } catch { return fail('HOST_INBOX_CURSOR_INVALID') }
    if (decoded.kind !== kind || decoded.owner !== owner || decoded.scope !== scope.row.id || decoded.generation !== scope.row.generation) fail('HOST_INBOX_CURSOR_INVALID', 409)
    return decoded.value
  }
  const formatters = { clock: new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' }), date: new Intl.DateTimeFormat([], { month: 'short', day: 'numeric' }), month: new Intl.DateTimeFormat([], { month: 'long' }), year: new Intl.DateTimeFormat([], { month: 'long', year: 'numeric' }) }
  const displayTime = (value: string) => {
    const now = new Date(), at = new Date(value), yesterday = new Date(now); yesterday.setDate(now.getDate() - 1)
    const today = now.toDateString() === at.toDateString()
    return { date: (today ? formatters.clock : formatters.date).format(at),
      group: today ? 'Today' : yesterday.toDateString() === at.toDateString() ? 'Yesterday' : (at.getFullYear() === now.getFullYear() ? formatters.month : formatters.year).format(at) }
  }
  const captureLocked = (scope: Scope) => !!db.query("SELECT 1 FROM local_window_captures WHERE owner=? AND scope=? AND complete=0 AND json_extract(data,'$.snapshotRevision') IS NOT NULL LIMIT 1").get(owner, scope.row.id)
  function stamp(scope: Scope, patch: ProjectionStamp) {
    const saved = json<Record<string, unknown>>(refresh(scope).row.data)
    if (Object.entries(patch).every(([key, value]) => (saved.projection as Record<string, unknown> | undefined)?.[key] === value)) return
    db.query('UPDATE local_window_scopes SET data=? WHERE owner=? AND id=?').run(JSON.stringify({ ...saved, projection: { ...(saved.projection as ProjectionStamp | undefined), ...patch } }), owner, scope.row.id)
    refresh(scope)
  }
  function invalidateProjection(scope: Scope) {
    db.query('INSERT OR IGNORE INTO local_window_dirty SELECT owner,scope,source,thread FROM local_window_rows WHERE owner=? AND scope=?').run(owner, scope.row.id)
  }
  async function updateSavedProjections() {
    if (projectionWork) return projectionWork
    if (aiCursor === undefined || categoryCursor === undefined) return
    const afterAi = aiCursor, afterCategory = categoryCursor
    projectionWork = (async () => {
      const [ai, categories] = await Promise.all([deps.ai.changes(owner, afterAi), deps.attentionOverrides.changes(afterCategory)])
      const nextAi = ai.resetRequired ? (await deps.ai.state(owner)).cursor : ai.cursor
      for (const scope of scopes.values()) {
        if (!preparations.has(scope.row.id)) continue
        if (ai.resetRequired || categories.resetRequired) invalidateProjection(scope)
        else for (const key of [...ai.decisions, ...ai.removed, ...categories.entries]) if (scope.sources.some(source => source.id === key.sourceId)) dirty(scope.row.id, key.sourceId, key.threadId)
        stamp(scope, { aiCursor: nextAi, categoryCursor: categories.cursor })
      }
      aiCursor = nextAi; categoryCursor = categories.cursor
    })().finally(() => { projectionWork = undefined })
    return projectionWork
  }
  async function refreshMetadata(scope: Scope, force = false) {
    if (!force && Date.now() - scope.metadataAt < (scope.metadataDirty ? 250 : 30_000)) return
    const labels = await inbox.labels(owner), folders = new Map<string, Folder[]>()
    for (const source of scope.sources) folders.set(source.id, await inbox.cachedFolders(owner, source.id))
    const hash = digest([labels, [...folders]]), prior = json<{ projection?: ProjectionStamp }>(scope.row.data).projection
    scope.labels = labels; scope.folders = folders; scope.metadataAt = Date.now(); scope.metadataDirty = false
    if (prior?.metadata !== hash && preparations.has(scope.row.id)) { invalidateProjection(scope); stamp(scope, { metadata: hash }) }
  }
  async function resolve(account: string): Promise<Scope> {
    text(account)
    const [preferences, allBoxes, sources, ai] = await Promise.all([deps.inboxPreferences.read(), inbox.mailboxes(owner), inbox.accounts(owner), deps.ai.state(owner)])
    const available = allBoxes.filter(box => box.status !== 'detached')
    const boxes = account === 'unified' ? available.filter(box => preferences.unifiedMode === 'all' || preferences.includedMailboxIds.includes(box.id)) : available.filter(box => box.id === account)
    if (account !== 'unified' && !boxes.length) fail('HOST_INBOX_SCOPE_CHANGED', 409)
    if (boxes.length > 5000 || sources.length > 1000) fail('HOST_INBOX_TOO_LARGE', 413)
    const selectedSources = sources.filter(source => boxes.some(box => box.sourceId === source.id))
    const identity = { account, boxes: boxes.map(box => [box.id, box.sourceId, box.revision, box.status]).sort(), sources: selectedSources.map(source => [source.id, source.generation]).sort() }
    const id = digest(identity), split = deps.splitPreferences.read() ?? { ...normalizeSplits({}), revision: 0 }
    const preference = digest(['demand-window-1', ATTENTION_VERSION, AI_PREFERENCE_VERSION, IMPORTANT_WINDOW_VERSION, preferences.revision, split, ai.configured, ai.settings])
    aiCursor ??= ai.cursor
    const categoryHead = db.query<{ head: number }, string[]>('SELECT head FROM local_category_clock WHERE owner=?').get(owner)?.head ?? 0
    categoryCursor ??= categoryHead
    let scope = scopes.get(id)
    if (!scope) {
      if (scopes.size >= MAX_ACTIVE) {
        const oldest = [...scopes.values()].filter(value => !value.users && value !== workingScope && !preparations.has(value.row.id) && !pruning.has(value.row.id) && !captureLocked(value)).sort((a, b) => a.lastUsed - b.lastUsed)[0]
        if (!oldest) fail('HOST_INBOX_UNAVAILABLE', 429)
        // Eviction removes metadata memory only. Indexes and frozen/paused queues stay durable.
        scopes.delete(oldest!.row.id)
      }
      db.query('INSERT OR IGNORE INTO local_window_scopes(owner,id,account,data) VALUES (?,?,?,?)').run(owner, id, account, JSON.stringify(identity))
      scope = { row: getScopeRow(id), boxes, sources: selectedSources, labels: [], folders: new Map(), preference, preferences: split as unknown as Preferences, ai, users: 0, lastUsed: Date.now(), metadataAt: 0, metadataDirty: true, seenEvents: -1 }
      scopes.set(id, scope)
      // Existing capture data remains durable, but resolving an ordinary view neither
      // reads that copy as live mail nor resumes its materialization.
    }
    const uses = requests.getStore()
    if (uses && !uses.has(scope)) { uses.add(scope); scope.users++ }
    scope.lastUsed = Date.now()
    if (scope.preference !== preference) {
      scope.preference = preference
      if (preparations.has(scope.row.id)) { invalidateProjection(scope); stamp(scope, { preference }) }
    }
    scope.boxes = boxes; scope.sources = selectedSources; scope.ai = ai; scope.preferences = split as unknown as Preferences
    await refreshMetadata(scope)
    refresh(scope)
    return scope
  }
  function project(scope: Scope, summaries: MailboxMessageSummary[]) {
    return projectMailboxMail({ sources: scope.sources, mailboxes: scope.boxes, summaries, labels: scope.labels, folders: scope.folders,
      includedMailboxIds: scope.boxes.map(box => box.id), allowProviderWrites: deps.allowProviderWrites, now: Date.now(), displayTime })
  }
  function storeMessages(scope: Scope, messages: MailboxMessageSummary[]) {
    const put = db.query('INSERT INTO local_window_messages VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(owner,scope,source,id) DO UPDATE SET thread=excluded.thread,at=excluded.at,folder=excluded.folder,attention=excluded.attention,data=excluded.data')
    db.transaction(() => {
      for (let message of messages) {
        const previous = db.query<{ thread: string; data: string }, [string, string, string, string]>('SELECT thread,data FROM local_window_messages WHERE owner=? AND scope=? AND source=? AND id=?').get(owner, scope.row.id, message.sourceId, message.id)
        if (previous) {
          const prior = json<MailboxMessageSummary>(previous.data)
          if (prior.revision > message.revision) continue
          const states = new Map(prior.memberships.map(state => [state.mailboxId, state]))
          message = { ...message, memberships: message.memberships.map(state => (states.get(state.mailboxId)?.revision ?? 0) > state.revision ? states.get(state.mailboxId)! : state) }
          if (previous.data === JSON.stringify(message)) continue
          if (previous.thread !== message.threadId) dirty(scope.row.id, message.sourceId, previous.thread)
        }
        put.run(owner, scope.row.id, message.sourceId, message.id, message.threadId, message.receivedAt, message.folder, classifyAttention(message).category, JSON.stringify(message))
        dirty(scope.row.id, message.sourceId, message.threadId)
      }
    }).immediate()
  }
  /** Bounded by rows AND encoded bytes, even with oversized individual headers. */
  function summaries(scope: Scope, source: string, thread: string, maximum: number, after?: [string, string]) {
    const values: MailboxMessageSummary[] = []; let size = 0
    const statement = db.query<{ data: string; at: string; id: string }, (string | number)[]>(`SELECT data,at,id FROM local_window_messages WHERE owner=? AND scope=? AND source=? AND thread=? ${after ? 'AND (at,id)<(?,?)' : ''} ORDER BY at DESC,id DESC LIMIT ?`)
    for (const row of statement.iterate(owner, scope.row.id, source, thread, ...after ?? [], maximum)) {
      const cost = Buffer.byteLength(row.data)
      if (size + cost > DTO.INBOX_RESPONSE_BYTE_LIMIT / 2) break
      values.push(json(row.data)); size += cost
    }
    return values
  }
  const threadKey = (key: DTO.InboxThreadKey) => `${key.sourceId}\0${key.threadId}`
  const mailKey = (scope: Scope, key: DTO.InboxThreadKey) => scope.row.account === 'unified' ? `unified:${key.sourceId}:${key.threadId}` : `${scope.row.account}:${key.threadId}`
  function ownedKey(scope: Scope, id: string): DTO.InboxThreadKey | null {
    if (scope.row.account === 'unified') {
      const source = [...scope.sources].sort((a, b) => b.id.length - a.id.length).find(source => id.startsWith(`unified:${source.id}:`))
      const threadId = source && id.slice(`unified:${source.id}:`.length)
      return source && threadId && threadId.length <= 512 ? { sourceId: source.id, threadId } : null
    }
    const threadId = id.startsWith(`${scope.row.account}:`) && id.slice(scope.row.account.length + 1)
    return scope.boxes[0] && threadId && threadId.length <= 512 ? { sourceId: scope.boxes[0].sourceId, threadId } : null
  }
  const awake = (message: MailboxMessageSummary, now: number) => message.folder === 'inbox' && message.memberships.some(state => !state.done && (!state.snoozedUntil || Date.parse(state.snoozedUntil) <= now))
  const completeContext = (sdk: MailboxConversation, values: MailboxMessageSummary[]) => values.length === sdk.messageCount
    && values.reduce((sum, value) => sum + value.memberships.length, 0) === sdk.membershipCount
    && values.reduce((sum, value) => sum + value.memberships.filter(state => state.done).length, 0) === sdk.doneMembershipCount
    && values.every(value => value.isRead) === sdk.isRead && values.some(value => value.isStarred) === sdk.isStarred
    && values.some(value => value.hasAttachments) === sdk.hasAttachments && values.some(value => value.id === sdk.firstMessageId && value.subject === sdk.subject)
  // SQLite's BINARY tie order, including non-ASCII IDs, not locale collation.
  const binary = (left: string, right: string) => Buffer.compare(Buffer.from(left), Buffer.from(right))
  const newestMessages = (values: MailboxMessageSummary[]) => [...values].sort((a, b) => binary(b.receivedAt, a.receivedAt) || binary(b.id, a.id))
  function summaryTargets(values: MailboxMessageSummary[]): MailboxStateTarget[] {
    const targets: MailboxStateTarget[] = []
    for (const value of newestMessages(values)) for (const state of [...value.memberships].sort((a, b) => binary(a.mailboxId, b.mailboxId))) {
      targets.push({ mailboxId: state.mailboxId, messageId: value.id, revision: state.revision, messageRevision: value.revision })
      if (targets.length === 500) return targets
    }
    return targets
  }
  /** A read-path-independent identity, not permission to act on partial context.
   * Full capture review/receipt evidence and the separate completeness gates remain
   * mandatory. Expanding messages must not change an otherwise identical row hash.
   */
  function contextFingerprint(scope: Scope, sdk: MailboxConversation, values: MailboxMessageSummary[]) {
    const canonical = newestMessages(values).slice(0, 50), selectedTargets = sdk.targets.slice(0, 500)
    if (canonical.length !== Math.min(50, sdk.messageCount) || selectedTargets.length !== Math.min(500, sdk.membershipCount)) throw pendingContext
    const messages = [...canonical].sort((a, b) => binary(a.id, b.id)).map(value => [value.id, value.bodyRevision ?? value.revision, value.folder,
      [...value.memberships].sort((a, b) => binary(a.mailboxId, b.mailboxId)).map(state => [state.mailboxId, state.done, state.snoozedUntil])])
    const bodies = new Map(canonical.map(value => [value.id, value.bodyRevision]))
    const targets = selectedTargets.sort((a, b) => binary(a.messageId, b.messageId) || binary(a.mailboxId, b.mailboxId)).map(target => [target.mailboxId, target.messageId, target.revision, bodies.get(target.messageId) ? null : target.messageRevision ?? null])
    const evidence = ['conversation-context-3', scope.row.id, sdk.sourceId, sdk.threadId, scope.sources.find(source => source.id === sdk.sourceId)?.generation,
      sdk.subject, sdk.firstMessageId, sdk.messageCount, sdk.membershipCount, sdk.doneMembershipCount, sdk.awakeInboxMessageCount, sdk.earliestSnoozedUntil,
      // Keep the frozen evidence layout (messages=12, targets=13). Coverage describes
      // the canonical caps, never whether this particular read expanded all messages.
      messages, targets, sdk.messageCount <= 50, sdk.membershipCount <= 500]
    return { hash: digest(evidence), evidence: JSON.stringify(evidence) }
  }
  function legacyContextFingerprint(scope: Scope, values: MailboxMessageSummary[]) {
    const hash = createHash('sha256').update(scope.row.id)
    for (const value of [...values].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) hash.update(JSON.stringify({ id: value.id, body: value.bodyRevision ?? value.revision, folder: value.folder,
      memberships: JSON.stringify(value.memberships.map(state => [state.mailboxId, Number(state.done), state.snoozedUntil])) })).update('\n')
    return hash.digest('hex')
  }
  async function projectConversations(scope: Scope, items: MailboxConversation[], budget: ReadBudget, fullContext = false, captured = false) {
    if (!items.length) return []
    const keys = items.map(({ sourceId, threadId }) => ({ sourceId, threadId }))
    budget.keys = keys
    const [categoryPages, assessments] = await Promise.all([
      Promise.all(Array.from({ length: Math.ceil(keys.length / BATCH) }, (_, index) => deps.attentionOverrides.lookup(keys.slice(index * BATCH, (index + 1) * BATCH)))),
      deps.ai.lookup(owner, keys),
    ])
    const decisions = new Map<string, AiDecision>(assessments.decisions.map(value => [threadKey(value), value]))
    const choices = new Map(categoryPages.flatMap(page => page.entries).map(value => [threadKey(value), value]))
    const rows: DTO.InboxWindowRow[] = []
    for (const original of items) {
      let sdk = original, values = sdk.messages
      const identity = threadKey(sdk), choice = choices.get(identity), savedDecision = decisions.get(identity)
      const needsEvidence = !!choice?.override || !!savedDecision?.contextVersions.some(context => !values.some(value => value.id === context.messageId))
      if (captured && scope.row.raw_complete) {
        const all = summaries(scope, sdk.sourceId, sdk.threadId, 500)
        if (completeContext(sdk, all)) {
          values = all
          const targets = summaryTargets(values)
          sdk = { ...sdk, messages: values, messagesComplete: true, targets, targetsComplete: targets.length === sdk.membershipCount }
        }
      }
      const clipped = () => values.length < Math.min(50, sdk.messageCount) || sdk.targets.length < Math.min(500, sdk.membershipCount)
      const repairCanonical = clipped()
      if (repairCanonical || !sdk.messagesComplete && sdk.messageCount <= 500 && (fullContext || needsEvidence || values.filter(value => awake(value, budget.now)).length !== sdk.awakeInboxMessageCount)) {
        if (budget.details > 0) {
          const fetched: MailboxMessageSummary[] = []
          let cursor: string | undefined
          do {
            budget.details--
            const page = await inbox.mailboxMessagePage(owner, { mailboxIds: scope.boxes.map(box => box.id), sourceId: sdk.sourceId, threadId: sdk.threadId, limit: 500 - fetched.length, ...(cursor ? { cursor } : {}) })
            fetched.push(...page.items)
            const complete = !page.nextCursor && completeContext(sdk, fetched), targets = summaryTargets(fetched)
            if (complete || repairCanonical && fetched.length >= Math.min(50, sdk.messageCount) && targets.length >= Math.min(500, sdk.membershipCount)) {
              values = fetched
              sdk = { ...sdk, messages: values, messagesComplete: complete, targets, targetsComplete: complete && targets.length === sdk.membershipCount }
              break
            }
            cursor = page.nextCursor ?? undefined
            // Only clipped canonical evidence needs continuation. Never drain a
            // giant thread for action context, or read more than 500 summaries.
          } while (repairCanonical && cursor && budget.details > 0 && fetched.length < 500)
        } else {
          // A full-context or canonical read was deferred, not proved absent.
          // Captured pages stop before this identity and retry with a fresh budget.
          budget.detailDeferred.add(mailKey(scope, sdk))
        }
      }
      if (clipped()) {
        budget.detailDeferred.add(mailKey(scope, sdk))
        break // Preserve the SDK ordinal prefix; never publish a clipped hash.
      }
      const full = sdk.messagesComplete && values.length === sdk.messageCount
      const mail = project(scope, values).mail.find(mail => mail.account === scope.row.account)
      if (!mail) fail('HOST_INBOX_SCOPE_CHANGED', 409)
      if (sdk.latestAwakeInboxAt !== undefined) mail!.importantReceivedAt = sdk.latestAwakeInboxAt === null ? null : Date.parse(sdk.latestAwakeInboxAt)
      mail!.subject = sdk.subject; mail!.receivedAt = Date.parse(sdk.lastMessageAt); Object.assign(mail!, displayTime(sdk.lastMessageAt))
      mail!.hasAttachments = sdk.hasAttachments; mail!.unread = !sdk.isRead; mail!.starred = sdk.isStarred
      if (!full) {
        const primary = sdk.primaryFolderCounts, roles = sdk.nativeFolders
        // Match the full projection: only uniformly primary Trash or Spam is
        // hidden. Mixed Trash/Spam and custom folders remain visible in All Mail.
        // Older SDKs lack this proof; keep their conservative preview fallback.
        const hidden = primary?.trash === sdk.messageCount ? 'Trash' : primary?.spam === sdk.messageCount ? 'Spam' : undefined
        const unknownLocation = !primary && !sdk.awakeInboxMessageCount && (values.every(value => value.folder === 'trash') || values.every(value => value.folder === 'spam'))
        if (unknownLocation) budget.unknownLocation.add(mail!.id)
        const sent = primary ? primary.sent > 0 : roles.sent
        const archived = primary ? primary.archive > 0 && primary.archive + primary.sent === sdk.messageCount : roles.archive && !roles.inbox && !roles.trash && !roles.spam && !roles.drafts
        const locations = hidden ? [hidden] : unknownLocation ? [] : [sdk.awakeInboxMessageCount ? 'Inbox' : '', sent ? 'Sent' : '', sdk.doneMembershipCount === sdk.membershipCount ? 'Done' : '',
          sdk.earliestSnoozedUntil ? 'Reminders' : '', archived ? 'Auto Archived' : ''].filter(Boolean)
        mail!.locations = locations; mail!.folder = hidden ?? (unknownLocation ? 'Unknown' : locations.includes('Inbox') ? 'Inbox' : locations.includes('Done') ? 'Done' : locations.includes('Reminders') ? 'Reminders' : locations[0] ?? 'Auto Archived')
        mail!.reminder = sdk.earliestSnoozedUntil ?? undefined; mail!.reminderAt = sdk.earliestSnoozedUntil ? Date.parse(sdk.earliestSnoozedUntil) : undefined
        // Whole receiving scope comes from aggregates, not whichever copies fit a preview.
        if (scope.row.account === 'unified') {
          mail!.mailboxIds = [...new Set([...(mail!.mailboxIds ?? []), ...sdk.mailboxStates.map(value => value.mailboxId)])]
          mail!.mailboxNames = mail!.mailboxIds.map(id => scope.boxes.find(box => box.id === id)?.name ?? 'Mailbox')
        }
      }
      if (full && scope.sources.find(source => source.id === sdk.sourceId)?.status === 'connected' && currentCategoryOverride(mail!, choice?.override)) mail!.attentionOverride = choice
      if (scope.ai.configured && scope.ai.settings.enabled) {
        let decision = currentAiDecision(mail!, savedDecision, scope.ai.settings.model)
        if (decision?.state === 'ready' && decision.contextVersions.some(context => {
          const actual = values.find(value => value.id === context.messageId)
          return !actual || context.bodyRevision === null || actual.bodyRevision !== context.bodyRevision
        })) decision = { ...decision, state: 'stale', score: null, override: null }
        if (decision) { mail!.triage = decision; if (scope.ai.settings.mode === 'apply' && decision.state === 'ready' && decision.score) mail!.attentionCategory = decision.score.category }
        if (scope.ai.settings.mode === 'apply' && decision?.state !== 'ready' && decision?.holdUntil && Date.parse(decision.holdUntil) > budget.now) mail!.aiHoldUntil = Date.parse(decision.holdUntil)
      }
      if (mail!.attentionOverride?.override) mail!.aiHoldUntil = undefined
      const attentionComplete = values.filter(value => awake(value, budget.now)).length === sdk.awakeInboxMessageCount && (!needsEvidence || full)
      mail!.split = attentionComplete ? conversationAttention(mail!, budget.now) : 'Unknown'
      const preview = newestMessages(values).slice(0, 50)
      const previewIds = new Set(preview.map(value => value.id)), targetsComplete = sdk.targetsComplete && sdk.targets.length === sdk.membershipCount
      const context = contextFingerprint(scope, sdk, values)
      const row: DTO.InboxWindowRow = { sourceId: sdk.sourceId, threadId: sdk.threadId, key: mail!.id, sourceGeneration: mail!.sourceGeneration!, revision: scope.read?.revision ?? scope.row.revision,
        mail: { ...mail!, messages: mail!.messages.filter(message => previewIds.has(message.id)) }, summaries: preview, messagesComplete: full && preview.length === sdk.messageCount,
        counts: { messages: sdk.messageCount, memberships: sdk.membershipCount, unread: full ? values.filter(value => !value.isRead).length : sdk.isRead ? 0 : null, done: sdk.doneMembershipCount,
          snoozed: full ? values.reduce((sum, value) => sum + value.memberships.filter(state => !!state.snoozedUntil && Date.parse(state.snoozedUntil) > budget.now).length, 0) : sdk.earliestSnoozedUntil ? null : 0 },
        targets: sdk.targets, targetsComplete, actionContextComplete: full && targetsComplete && preview.length === sdk.messageCount, contextVersion: context.hash }
      while (bytes(row) > 512 * 1024 && row.summaries.length > 1) {
        const removed = row.summaries.pop()!; row.mail.messages = row.mail.messages.filter(message => message.id !== removed.id); row.messagesComplete = false; row.actionContextComplete = false
      }
      if (bytes(row) > DTO.INBOX_RESPONSE_BYTE_LIMIT - 65536) fail('HOST_INBOX_TOO_LARGE', 413)
      budget.summaries.set(row.key, values); budget.contexts.set(row.key, context.evidence)
      if (full) budget.legacy.set(row.key, legacyContextFingerprint(scope, values))
      rows.push(row)
    }
    return rows
  }
  /** Capture-only materialization. No query/page/lookup/change/sender read calls it. */
  async function buildRows(scope: Scope, inputKeys: DTO.InboxThreadKey[], live?: ReadonlyMap<string, MailboxConversation>) {
    if (!inputKeys.length || captureLocked(scope)) return
    const keys = inputKeys.map(({ sourceId, threadId }) => ({ sourceId, threadId }))
    const page = live ? null : await inbox.mailboxConversations(owner, { mailboxIds: scope.boxes.map(box => box.id), keys, limit: 100 })
    if (page?.nextCursor) throw pendingContext
    const items = live ? keys.flatMap(key => { const item = live.get(threadKey(key)); return item ? [item] : [] }) : page!.items
    const budget = readBudget(), rows = await projectConversations(scope, items, budget, true, !page || page.state === scope.row.baseline)
    const found = new Set(rows.map(row => threadKey(row)))
    for (const key of keys) {
      const row = rows.find(row => threadKey(row) === threadKey(key))
      // A clipped projection is still present. Leave it dirty for explicit
      // preparation's next bounded pass rather than deleting frozen source rows.
      if (!row && items.some(item => threadKey(item) === threadKey(key))) continue
      if (!found.has(threadKey(key))) {
        const id = mailKey(scope, key)
        if (record(scope, id)) {
          db.query('DELETE FROM local_window_rows WHERE owner=? AND scope=? AND key=?').run(owner, scope.row.id, id)
          for (const table of ['matches', 'counts', 'query_pending']) db.query(`DELETE FROM local_window_${table} WHERE owner=? AND key=? AND query_id IN (SELECT id FROM local_window_queries WHERE owner=? AND scope=?)`).run(owner, id, owner, scope.row.id)
          bump(scope)
        }
      } else {
        const previous = record(scope, row!.key)
        const saved = { ...row!, contextEvidence: budget.contexts.get(row!.key), folderContextComplete: !budget.unknownLocation.has(row!.key) }
        if (!previous || digest({ ...json<DTO.InboxWindowRow>(previous.data), revision: 0 }) !== digest({ ...saved, revision: 0 })) {
          row!.revision = bump(scope); saved.revision = row!.revision
          const wake = Math.min(row!.mail.reminderAt ?? Infinity, row!.mail.aiHoldUntil ?? Infinity)
          db.query('INSERT INTO local_window_rows VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner,scope,key) DO UPDATE SET at=excluded.at,revision=excluded.revision,context=excluded.context,data=excluded.data,wake=excluded.wake').run(owner, scope.row.id, row!.key, key.sourceId, key.threadId, row!.mail.receivedAt ?? 0, row!.revision, row!.contextVersion, JSON.stringify(saved), Number.isFinite(wake) ? wake : null)
        }
      }
      db.query('DELETE FROM local_window_dirty WHERE owner=? AND scope=? AND source=? AND thread=?').run(owner, scope.row.id, key.sourceId, key.threadId)
    }
  }

  const categoryHead = () => db.query<{ head: number }, string[]>('SELECT head FROM local_category_clock WHERE owner=?').get(owner)?.head ?? 0
  const readMetadata = (query: QueryRow): ReadMetadata => { const saved = getQuery(query.id)?.read_state; return saved ? json(saved) : { baselines: [] } }
  function saveReadMetadata(query: QueryRow, value: ReadMetadata) {
    query.read_state = JSON.stringify(value)
    db.query('UPDATE local_window_queries SET read_state=? WHERE owner=? AND id=?').run(query.read_state, owner, query.id)
  }
  function baseline(scope: Scope, query: QueryRow, revision?: number) {
    const values = readMetadata(query).baselines, saved = revision === undefined ? values.at(-1) : values.find(value => value.revision === revision)
    return saved ? untoken<ReadBaseline>(saved.token, `read:${query.id}`, scope) : undefined
  }
  function observe(scope: Scope, sdkState: string | null, scopeState: string, query?: QueryRow, clocks?: Pick<ReadBaseline, 'ai' | 'category' | 'at'>): ReadBaseline {
    const ai = clocks?.ai ?? scope.ai.cursor, category = clocks?.category ?? categoryHead()
    const previous = query ? baseline(scope, query) : scope.read
    if (previous?.sdkState === sdkState && previous.scopeState === scopeState && previous.ai === ai && previous.category === category && !clocks) { scope.read = previous; return previous }
    const value: ReadBaseline = { sdkState, scopeState, ai, category, at: clocks?.at ?? Date.now(), revision: bump(scope) }
    scope.read = value
    if (query) {
      const saved = readMetadata(query)
      saved.baselines = [...saved.baselines, { revision: value.revision, token: token(`read:${query.id}`, scope, value) }].slice(-16)
      if (saved.counts && (saved.counts.baseline.sdkState !== sdkState || saved.counts.baseline.ai !== ai || saved.counts.baseline.category !== category)) delete saved.counts
      saveReadMetadata(query, saved)
    }
    return value
  }
  function state(scope: Scope, query?: QueryRow, read = query ? baseline(scope, query) : scope.read): DTO.InboxWindowState {
    return { queryId: query?.id ?? `scope:${scope.row.id}`, queryGeneration: query?.generation ?? scope.row.generation,
      indexRevision: read?.revision ?? scope.row.revision, scopeState: read?.scopeState ?? scope.row.id, preferenceRevision: scope.preference,
      sources: scope.sources.map(source => ({ sourceId: source.id, generation: source.generation })), sdkState: read?.sdkState ?? null,
      ...(query && read ? { readCursor: token(`read:${query.id}`, scope, read) } : {}),
      // Current means this bounded cached SDK read, not upstream history completion.
      // The dormant capture index is deliberately not a source of ordinary read state.
      indexing: false, catchup: query?.problem ? 'blocked' : 'current' }
  }
  function unknownTotals(scope: Scope): DTO.InboxTotals {
    return { conversations: null, messages: null, inbox: null, splits: Object.fromEntries(scope.preferences.splits.map(name => [name, null])), folders: {}, holding: null }
  }
  function totals(scope: Scope, query: QueryRow): DTO.InboxTotals {
    const count = readMetadata(query).counts, read = baseline(scope, query)
    return count?.complete && read && count.baseline.sdkState === read.sdkState && count.baseline.scopeState === read.scopeState
      && count.baseline.ai === scope.ai.cursor && count.baseline.category === categoryHead() && (!count.wake || count.wake > Date.now()) ? count.totals : unknownTotals(scope)
  }
  const parsedSearch = new Map<string, ReturnType<typeof parseSearch>>()
  const searchTerms = new Map<string, ReturnType<typeof compileSearch>>()
  function participantQuery(key: string, value: string): Parameters<Inbox['mailboxConversations']>[1]['query'] {
    if (key !== 'from' && key !== 'to') return undefined
    const normalized = value.trim().toLowerCase()
    if (normalized.length > 320 || /[\x00-\x1f\x7f]/.test(normalized)) return undefined
    if (/^[^\s<>@]+@[^\s<>@]+$/.test(normalized)) return { participant: { field: key, match: 'address', value: normalized } }
    if (key === 'from' && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(normalized)) return { participant: { field: key, match: 'domain', value: normalized } }
    return undefined // Display-name/free-text from/to syntax keeps its legacy meaning.
  }
  async function expression(scope: Scope, row: DTO.InboxWindowRow, query: string, bodies: boolean, budget: ReadBudget = readBudget()): Promise<boolean> {
    if (!parsedSearch.has(query)) {
      if (parsedSearch.size >= 256) parsedSearch.delete(parsedSearch.keys().next().value!)
      parsedSearch.set(query, parseSearch(query))
    }
    const expression = parsedSearch.get(query)!
    if (!expression) return true
    async function evaluate(node: NonNullable<ReturnType<typeof parseSearch>>): Promise<boolean | null> {
      if ('not' in node) { const value = await evaluate(node.not); return value === null ? null : !value }
      if ('op' in node) {
        const left = await evaluate(node.left)
        if (node.op === 'and' && left === false || node.op === 'or' && left === true) return left
        const right = await evaluate(node.right)
        return node.op === 'and' ? right === false ? false : left === null || right === null ? null : true : right === true ? true : left === null || right === null ? null : false
      }
      const negative = node.term.startsWith('-'), term = negative ? node.term.slice(1) : node.term
      if (!searchTerms.has(term)) {
        if (searchTerms.size >= 512) searchTerms.delete(searchTerms.keys().next().value!)
        searchTerms.set(term, compileSearch(term, false))
      }
      const matches = searchTerms.get(term)!, values = budget.summaries.get(row.key) ?? row.summaries
      const complete = values.length === row.counts.messages
      const projected = values.length === row.summaries.length ? row.mail : { ...row.mail, messages: project(scope, values).mail.find(mail => mail.account === scope.row.account)!.messages }
      let yes = term === 'has:attachment' ? !!row.mail.hasAttachments : matches(projected)
      const colon = term.indexOf(':'), key = colon < 0 ? '' : term.slice(0, colon), value = colon < 0 ? term : term.slice(colon + 1).replaceAll('"', '').toLowerCase()
      if (colon >= 0 && (!value || !['from', 'to', 'subject', 'in', 'label', 'is', 'has', 'before', 'after', 'older_than', 'newer_than'].includes(key))) fail('HOST_INBOX_INVALID')
      if (key === 'is' && !['read', 'unread', 'starred'].includes(value) || key === 'has' && value !== 'attachment') fail('HOST_INBOX_INVALID')
      const keyed = async (query: Parameters<Inbox['mailboxConversations']>[1]['query']) => {
        const hash = digest(query), identity = threadKey(row), proof = budget.proofs.get(hash) ?? new Map<string, boolean>()
        budget.proofs.set(hash, proof)
        if (proof.has(identity)) return proof.get(identity)!
        const index = budget.keys.findIndex(key => threadKey(key) === identity)
        const keys = index < 0 ? [{ sourceId: row.sourceId, threadId: row.threadId }] : budget.keys.slice(Math.floor(index / 50) * 50, Math.floor(index / 50) * 50 + 50)
        let cursor: string | undefined
        do {
          if (budget.searches <= 0 || budget.pages <= 0) throw pendingContext
          budget.searches--; budget.pages--
          const found = await inbox.mailboxConversations(owner, { mailboxIds: scope.boxes.map(box => box.id), keys, query, limit: 100, ...(cursor ? { cursor } : {}) })
          for (const item of found.items) proof.set(threadKey(item), true)
          cursor = found.nextCursor ?? undefined
          if (!cursor) for (const key of keys) if (!proof.has(threadKey(key))) proof.set(threadKey(key), false)
        } while (cursor && budget.pages > 0)
        if (!proof.has(identity)) throw pendingContext
        return proof.get(identity)!
      }
      const nativeParticipant = participantQuery(key, value), participant = nativeParticipant?.participant
      if (participant) {
        // Read real header addresses, never formatted display names or Cc/Bcc.
        // A preview hit is exact; a miss needs the complete keyed SDK proof.
        yes = values.some(summary => (participant.field === 'from' ? [summary.from] : summary.to).some(person => {
          const email = person.email.trim().replace(/[A-Z]/g, letter => letter.toLowerCase())
          if (participant.match === 'address') return email === participant.value
          const at = email.indexOf('@'), domain = email.slice(at + 1)
          return at >= 0 && (domain === participant.value || domain.endsWith(`.${participant.value}`))
        }))
        if (!yes && !complete) yes = await keyed(nativeParticipant)
      } else if (!yes && !complete && ['from', 'to'].includes(key)) {
        // Legacy substring candidates still cannot prove an unseen header match.
        const candidate = await keyed({ [key]: value })
        if (candidate) return null
      }
      if (!yes && !complete && (key === 'label' || key === 'in')) {
        const normalize = (name: string) => key === 'in' ? name.toLowerCase().replaceAll(/\s/g, '') : name.toLowerCase()
        const wanted = normalize(value), matchName = (name: string) => key === 'in' ? normalize(name) === wanted : normalize(name).includes(wanted)
        const labels = scope.labels.filter(label => label.accountId === row.sourceId && matchName(label.name))
        const folders = (scope.folders.get(row.sourceId) ?? []).filter(folder => folder.kind === 'label' && matchName(folder.name))
        for (const label of labels) if (await keyed({ labelId: label.id })) { yes = true; break }
        if (!yes) for (const folder of folders) if (await keyed({ folder: folder.id })) { yes = true; break }
      }
      if (!yes && bodies && colon < 0) {
        if (term.length > 2000) fail('HOST_INBOX_TOO_LARGE', 413)
        yes = await keyed({ search: term })
      }
      return negative ? !yes : yes
    }
    const result = await evaluate(expression)
    // A partial category is visible as Unknown; an unproven search is not a match.
    if (result === null) throw pendingContext
    return result!
  }
  async function evaluateRow(scope: Scope, query: DTO.InboxViewQuery, row: DTO.InboxWindowRow, budget: ReadBudget = readBudget(), includeCounts = false) {
    const mail = row.mail, inbox = inFolder(mail, 'Inbox'), holding = inbox && (mail.aiHoldUntil ?? 0) > budget.now
    const attention = mail.split, recent = recentImportant(mail, budget.now), counts: Record<string, number> = {}
    if (includeCounts && budget.unknownLocation.has(row.key)) throw pendingContext
    const splitMatches = new Map<string, boolean>()
    for (const name of new Set(includeCounts ? [...scope.preferences.splits, query.split] : !query.search && query.folder === 'Inbox' ? [query.split] : [])) {
      const category = attentionSplit(scope.preferences as never, name), rule = (scope.preferences.splitRules as Record<string, string> | undefined)?.[name]
      splitMatches.set(name, category ? (attention === category || category === 'Important' && attention === 'Unknown') && (category !== 'Important' || recent) : typeof rule === 'string' && !!rule.trim() && await expression(scope, row, rule, false, budget))
    }
    // Explicit pages, counts, captures and resident updates never wait on AI.
    // A presentation-only hold is applied solely to unseen demandChanges rows.
    counts.inbox = Number(inbox && (attention === 'Important' || attention === 'Unknown') && recent)
    for (const [name, matches] of splitMatches) counts[`split:${name}`] = Number(inbox && matches)
    counts.holding = Number(holding)
    for (const folder of ['Inbox', 'Starred', 'Sent', 'Done', 'Auto Archived', 'Reminders', 'Spam', 'Trash', 'All Mail']) counts[`folder:${folder}`] = Number(inFolder(mail, folder))
    const assessment = mail.triage?.state === 'ready' ? mail.triage.assessment : null
    let matches = !(query.filter === 'Unread' && !mail.unread || query.filter === 'Starred' && !mail.starred || query.filter === 'Important' && attention !== 'Important' && attention !== 'Unknown'
      || query.filter === 'No reply' && !mail.messages.at(-1)?.outgoing || query.filter === 'Needs reply' && assessment?.response !== 'needed'
      || query.filter === 'Action requested' && !assessment?.actions.length || query.filter === 'Time-sensitive' && !['immediate', 'deadline'].includes(assessment?.urgency ?? '')
      || query.filter === 'Suspicious' && !['spam_suspected', 'phishing_suspected'].includes(assessment?.risk ?? '') || query.filter === 'Unassessed' && !!assessment)
    if (matches && budget.unknownLocation.has(row.key)) {
      if (!query.search && query.folder === 'Inbox' && !inbox) matches = false // SDK awake count proves this exclusion.
      else throw pendingContext
    }
    if (matches) matches = query.search ? (!(mail.folder === 'Trash' || mail.folder === 'Spam') || /in:(trash|spam)/i.test(query.query)) && await expression(scope, row, query.query, true, budget)
      : query.folder === 'Inbox' ? inbox && !!splitMatches.get(query.split) : await expression(scope, row, `in:"${query.folder.replaceAll('"', '')}"`, false, budget)
    return { matches, counts }
  }
  async function scanQuery(scope: Scope, query: QueryRow, count = BATCH) {
    if (captureLocked(scope)) return
    if (queryPending(query)) {
      if (!scope.row.raw_complete) return
      const pending = db.query<StoredRow, (string | number)[]>('SELECT r.* FROM local_window_query_pending p JOIN local_window_rows r ON r.owner=p.owner AND r.scope=? AND r.key=p.key WHERE p.owner=? AND p.query_id=? LIMIT ?').all(scope.row.id, owner, query.id, count)
      await refreshRows(scope, pending.map(row => ({ sourceId: row.source, threadId: row.thread })))
      await indexQueryRows(scope, query, pending.flatMap(row => { const fresh = record(scope, row.key); return fresh ? [fresh] : [] }))
      await wait()
      return // Keep this cycle bounded; the ordinary revision scan resumes next cycle.
    }
    const records = db.query<StoredRow, (string | number)[]>('SELECT * FROM local_window_rows WHERE owner=? AND scope=? AND revision>? ORDER BY revision,key LIMIT ?').all(owner, scope.row.id, query.scanned, count)
    const stale = records.filter(row => db.query('SELECT 1 FROM local_window_dirty WHERE owner=? AND scope=? AND source=? AND thread=?').get(owner, scope.row.id, row.source, row.thread))
    await refreshRows(scope, stale.map(row => ({ sourceId: row.source, threadId: row.thread })))
    if (!await indexQueryRows(scope, query, records.flatMap(row => { const fresh = record(scope, row.key); return fresh ? [fresh] : [] }))) return
    query.scanned = records.at(-1)?.revision ?? scope.row.revision
    if (records.length < count && !stale.length) query.scanned = scope.row.revision
    db.query('UPDATE local_window_queries SET scanned=? WHERE owner=? AND id=?').run(query.scanned, owner, query.id)
  }
  async function queryScope(id: string) {
    const query = getQuery(text(id))
    if (!query || query.expires < Date.now()) fail('HOST_INBOX_QUERY_EXPIRED', 410)
    const scope = await resolve(json<DTO.InboxViewQuery>(query!.data).account)
    if (scope.row.id !== query!.scope || scope.row.generation !== query!.generation) fail('HOST_INBOX_SCOPE_CHANGED', 409)
    if (scope.preference !== query!.preference) fail('HOST_INBOX_QUERY_EXPIRED', 409)
    if (query!.problem) fail('HOST_INBOX_UNAVAILABLE', 503)
    return { scope, query: query! }
  }
  async function materializeConversations(scope: Scope, items: MailboxConversation[], extra = { remaining: 4 }, readState?: string) {
    if (captureLocked(scope)) return
    const prepared: MailboxConversation[] = []
    for (const item of items) {
      let conversation = item
      if (!item.messages.length || !item.messagesComplete && item.messageCount <= 500 && extra.remaining > 0) {
        if (!extra.remaining--) fail('HOST_INBOX_UNAVAILABLE', 503)
        const page = await inbox.mailboxMessagePage(owner, { mailboxIds: scope.boxes.map(box => box.id), sourceId: item.sourceId, threadId: item.threadId, limit: item.messageCount <= 500 ? 500 : 1 })
        const complete = !page.nextCursor && page.items.length === item.messageCount
        const targets = page.items.flatMap(value => value.memberships.map(state => ({ mailboxId: state.mailboxId, messageId: value.id, revision: state.revision, messageRevision: value.revision })))
        conversation = { ...item, messages: page.items, messagesComplete: complete, ...(complete ? { targets: targets.slice(0, 500), targetsComplete: targets.length <= 500 } : {}) }
      }
      if (!conversation.messages.length) fail('HOST_INBOX_UNAVAILABLE', 503)
      if (conversation.messagesComplete) {
        const present = JSON.stringify(conversation.messages.map(message => message.id))
        db.query('DELETE FROM local_window_messages WHERE owner=? AND scope=? AND source=? AND thread=? AND id NOT IN (SELECT value FROM json_each(?))').run(owner, scope.row.id, conversation.sourceId, conversation.threadId, present)
        db.query('DELETE FROM local_window_contacts WHERE owner=? AND scope=? AND source=? AND thread=? AND message NOT IN (SELECT value FROM json_each(?))').run(owner, scope.row.id, conversation.sourceId, conversation.threadId, present)
      }
      storeMessages(scope, conversation.messages)
      prepared.push(conversation)
    }
    for (let index = 0; index < prepared.length; index += BATCH) {
      const batch = prepared.slice(index, index + BATCH)
      await buildRows(scope, batch, scope.row.raw_complete && scope.row.baseline === readState ? undefined : new Map(batch.map(value => [`${value.sourceId}\0${value.threadId}`, value])))
      await wait()
    }
  }
  async function refreshRows(scope: Scope, keys: DTO.InboxThreadKey[]) {
    if (!keys.length || captureLocked(scope)) return
    for (let offset = 0; offset < keys.length; offset += 50) {
      const wanted = keys.slice(offset, offset + 50)
      const page = await inbox.mailboxConversations(owner, { mailboxIds: scope.boxes.map(box => box.id), keys: wanted, limit: 50 })
      await materializeConversations(scope, page.items, { remaining: 4 }, page.state)
      const found = new Set(page.items.map(value => `${value.sourceId}\0${value.threadId}`))
      for (const key of wanted) if (!found.has(`${key.sourceId}\0${key.threadId}`) && !page.nextCursor) {
        db.query('DELETE FROM local_window_messages WHERE owner=? AND scope=? AND source=? AND thread=?').run(owner, scope.row.id, key.sourceId, key.threadId)
        db.query('DELETE FROM local_window_contacts WHERE owner=? AND scope=? AND source=? AND thread=?').run(owner, scope.row.id, key.sourceId, key.threadId)
        await buildRows(scope, [key])
      }
    }
  }
  async function indexQueryRows(scope: Scope, query: QueryRow, records: StoredRow[]) {
    if (captureLocked(scope)) return false
    let complete = true
    const budget = readBudget()
    budget.keys = records.map(row => ({ sourceId: row.source, threadId: row.thread }))
    for (const stored of records) {
      const row = json<DTO.InboxWindowRow>(stored.data)
      if (scope.row.raw_complete) budget.summaries.set(row.key, summaries(scope, row.sourceId, row.threadId, 500))
      if (json<{ folderContextComplete?: boolean }>(stored.data).folderContextComplete === false) budget.unknownLocation.add(row.key)
      let result: Awaited<ReturnType<typeof evaluateRow>>
      try { result = await evaluateRow(scope, json(query.data), row, budget) }
      catch (error) {
        if (error !== pendingContext) throw error
        db.query('INSERT OR IGNORE INTO local_window_query_pending VALUES (?,?,?)').run(owner, query.id, row.key)
        db.query('DELETE FROM local_window_matches WHERE owner=? AND query_id=? AND key=?').run(owner, query.id, row.key)
        complete = false; continue
      }
      db.query('DELETE FROM local_window_query_pending WHERE owner=? AND query_id=? AND key=?').run(owner, query.id, row.key)
      if (result.matches) db.query('INSERT OR REPLACE INTO local_window_matches VALUES (?,?,?,?,?)').run(owner, query.id, row.key, stored.at, row.counts.messages ?? 0)
      else db.query('DELETE FROM local_window_matches WHERE owner=? AND query_id=? AND key=?').run(owner, query.id, row.key)
    }
    return complete
  }
  function nativeQuery(scope: Scope, view: DTO.InboxViewQuery): Parameters<Inbox['mailboxConversations']>[1]['query'] {
    // A query's native fields match one member. Combining independent conversation
    // predicates here would lose, for example, a read inbox message + unread reply
    // in Archive. Push only a necessary predicate and evaluate whole aggregates below.
    const folder = (name: string) => ({ Inbox: { folder: 'inbox', done: false }, Sent: { folder: 'sent' }, Starred: { starredOnly: true },
      Trash: { folder: 'trash' }, Spam: { folder: 'spam' }, Done: { done: true }, Reminders: { snoozed: true }, 'Auto Archived': { folder: 'archive' } } as Record<string, Parameters<Inbox['mailboxConversations']>[1]['query']>)[name]
    if (!view.search && folder(view.folder)) return folder(view.folder)
    const expression = view.search ? parseSearch(view.query) : null
    function necessary(node: NonNullable<ReturnType<typeof parseSearch>>): Parameters<Inbox['mailboxConversations']>[1]['query'] {
      if ('not' in node || 'op' in node && node.op === 'or') return undefined
      if ('op' in node) return necessary(node.left) ?? necessary(node.right)
      if (node.term.startsWith('-')) return undefined
      const colon = node.term.indexOf(':'), key = colon < 0 ? '' : node.term.slice(0, colon), value = colon < 0 ? node.term : node.term.slice(colon + 1).replaceAll('"', '')
      if (colon < 0 && node.term.length <= 2000) return { search: node.term }
      if (['from', 'to'].includes(key) && value.length <= 512) return participantQuery(key, value) ?? { [key]: value }
      if (key === 'subject' && node.term.length <= 2000) return { search: node.term }
      if (key === 'is' && value === 'unread') return { unreadOnly: true }
      if (key === 'is' && value === 'starred') return { starredOnly: true }
      if (key === 'has' && value === 'attachment') return { hasAttachments: true }
      if (['before', 'after'].includes(key) && Number.isFinite(Date.parse(value))) return { [key]: new Date(value).toISOString() }
      if (key === 'in') return folder(Object.keys({ Inbox: 1, Sent: 1, Starred: 1, Trash: 1, Spam: 1, Done: 1, Reminders: 1, 'Auto Archived': 1 }).find(name => name.toLowerCase().replaceAll(/\s/g, '') === value.toLowerCase().replaceAll(/\s/g, '')) ?? '')
      return undefined
    }
    return expression && necessary(expression) || (view.filter === 'Unread' ? { unreadOnly: true } : view.filter === 'Starred' ? { starredOnly: true } : undefined)
  }
  const conversationCursor = (item: MailboxConversation): string => typeof item.cursor === 'string' && item.cursor.length > 0 && item.cursor.length <= 4096 ? item.cursor : fail('HOST_INBOX_UNAVAILABLE', 503)
  /** No row, message, matching-ID, prefix or count-table writes: five SDK leader
   * pages maximum, in either direction. Only consumed leaders advance the cursor;
   * an unreturned match is never skipped, including at an SDK page's terminal edge.
   */
  async function preparePage(scope: Scope, query: QueryRow, maximum: number, cursor?: PageCursor, reverse = false, budget = readBudget()): Promise<DTO.InboxWindowPage> {
    if (cursor && (typeof cursor.older !== 'string' || typeof cursor.newer !== 'string' || !['older', 'newer'].includes(cursor.direction)
      || !cursor.baseline || typeof cursor.baseline.scopeState !== 'string' || typeof cursor.baseline.sdkState !== 'string'
      || ![cursor.baseline.revision, cursor.baseline.ai, cursor.baseline.category, cursor.baseline.at].every(value => Number.isSafeInteger(value) && value >= 0))) fail('HOST_INBOX_CURSOR_INVALID')
    const direction = reverse ? 'newer' : 'older'
    // The authenticated page bookmark owns its immutable starting read. Numeric
    // change baselines may retire without expiring still-valid SDK keyset history.
    let position = cursor ? cursor[direction] : undefined, read = cursor?.baseline
    if (!scope.boxes.length) {
      read = observe(scope, null, scope.row.id, query)
      return { state: state(scope, query, read), rows: [], totals: unknownTotals(scope), nextCursor: null, exhausted: true }
    }
    const view = json<DTO.InboxViewQuery>(query.data), recentView = !view.search && view.folder === 'Inbox' && attentionSplit(scope.preferences as never, view.split) === 'Important'
    const metadata = readMetadata(query)
    if (recentView && !metadata.importantSince) { metadata.importantSince = new Date(budget.now - IMPORTANT_WINDOW_MS).toISOString(); saveReadMetadata(query, metadata) }
    const queryFilter = recentView ? { ...nativeQuery(scope, view), after: metadata.importantSince } : nativeQuery(scope, view), rows: PageableRow[] = []
    let size = 65536, exhausted = false, stopped = false, wake = Infinity, firstConsumed: string | undefined, firstVisible: string | undefined
    const bookmark = (older: string, newer: string) => token(`page:${query.id}`, scope, { older, newer, baseline: { ...read! }, direction } satisfies PageCursor)
    while (budget.pages > 0 && rows.length < maximum && !stopped) {
      budget.pages--
      const page = await inbox.mailboxConversations(owner, { mailboxIds: scope.boxes.map(box => box.id), limit: 100, direction, query: queryFilter, ...(position ? { cursor: position } : {}) })
      read ??= observe(scope, page.state, page.scopeState, query)
      if (page.scopeState !== read.scopeState || page.state !== read.sdkState) fail('HOST_INBOX_QUERY_EXPIRED', 409)
      if (queryFilter) budget.proofs.set(digest(queryFilter), new Map(page.items.map(item => [threadKey(item), true])))
      const projected = await projectConversations(scope, page.items, budget)
      let consumed = 0
      for (const [index, row] of projected.entries()) {
        row.revision = read.revision
        wake = Math.min(wake, row.mail.reminderAt ?? Infinity, row.mail.aiHoldUntil ?? Infinity, recentView ? importantExpiry(row.mail, budget.now) : Infinity)
        let matches: boolean
        try { matches = (await evaluateRow(scope, view, row, budget)).matches }
        catch (error) { if (error !== pendingContext || !rows.length && !consumed) throw error; stopped = true; break }
        const at = conversationCursor(page.items[index]!)
        if (matches) {
          // Per-row bookmarks are necessary when the browser evicts only part of
          // this response. A page-first bookmark would skip the evicted prefix.
          const result: PageableRow = { ...row, pageCursor: bookmark(at, at) }, cost = bytes(result)
          if (size + cost > DTO.INBOX_RESPONSE_BYTE_LIMIT) { stopped = true; break }
          rows.push(result); size += cost; firstVisible ??= at
        }
        firstConsumed ??= at; position = at; consumed++
        if (rows.length >= maximum) { stopped = true; break }
      }
      if (consumed === page.items.length && !page.nextCursor) { exhausted = true; break }
      if (projected.length < page.items.length) stopped = true
    }
    if (!position && budget.detailDeferred.size) fail('HOST_INBOX_TOO_LARGE', 413)
    if (!read || !exhausted && !position) fail('HOST_INBOX_UNAVAILABLE', 503)
    const saved = readMetadata(query)
    if (Number.isFinite(wake)) { saved.wake = Math.min(saved.wake ?? Infinity, wake); saveReadMetadata(query, saved) }
    const opposite = firstVisible ?? firstConsumed ?? position
    if (reverse) rows.reverse() // SDK traverses oldest-to-newest; the UI always displays newest first.
    return { state: state(scope, query, read), rows, totals: totals(scope, query), exhausted,
      nextCursor: exhausted ? null : reverse ? bookmark(opposite!, position!) : bookmark(position!, opposite!) }
  }

  async function maintain(scope: Scope) {
    if (!preparations.has(scope.row.id)) return
    refresh(scope)
    // This materialization exists only during an explicit, expiring capture lease.
    // A capture freezes it, not SDK commands or their durable receipts.
    if (captureLocked(scope)) return
    await refreshMetadata(scope)
    if (!scope.boxes.length) { scope.seenEvents = watchedVersion; scope.row.checked = Date.now(); db.query('UPDATE local_window_scopes SET checked=? WHERE owner=? AND id=?').run(scope.row.checked, owner, scope.row.id); return }
    if ((scope.seenEvents !== watchedVersion || watched || Date.now() - scope.row.checked >= 2000) && scope.row.baseline) {
      const observedEvents = watchedVersion
      const page = await inbox.mailboxChanges(owner, { mailboxIds: scope.boxes.map(box => box.id), since: scope.row.baseline, scopeState: scope.row.sdk_scope, limit: 500 })
      if (page.resetRequired) { reset(scope, page.resetReason ?? 'history'); return }
      storeMessages(scope, page.upserts)
      for (const removal of page.removed) {
        const prior = db.query<{ thread: string }, string[]>('SELECT thread FROM local_window_messages WHERE owner=? AND scope=? AND source=? AND id=?').get(owner, scope.row.id, removal.sourceId, removal.messageId)
        db.query('DELETE FROM local_window_messages WHERE owner=? AND scope=? AND source=? AND id=?').run(owner, scope.row.id, removal.sourceId, removal.messageId)
        db.query('DELETE FROM local_window_contacts WHERE owner=? AND scope=? AND source=? AND message=?').run(owner, scope.row.id, removal.sourceId, removal.messageId)
        if (prior) dirty(scope.row.id, removal.sourceId, prior.thread)
      }
      for (const key of page.affectedThreads) dirty(scope.row.id, key.sourceId, key.threadId)
      if (page.events.some(event => ['label.updated', 'account.updated', 'mailbox.updated'].includes(event.type))) await refreshMetadata(scope, true)
      db.query('UPDATE local_window_scopes SET baseline=?,sdk_state=?,checked=? WHERE owner=? AND id=?').run(page.state, page.state, page.hasMore ? 0 : Date.now(), owner, scope.row.id)
      if (!page.hasMore) scope.seenEvents = observedEvents
      refresh(scope)
      // Events affecting visible conversation identities outrank the history backfill.
      const affected = page.affectedThreads.slice(0, 50)
      await refreshRows(scope, affected)
      const records = affected.flatMap(key => { const row = db.query<StoredRow, string[]>('SELECT * FROM local_window_rows WHERE owner=? AND scope=? AND source=? AND thread=?').get(owner, scope.row.id, key.sourceId, key.threadId); return row ? [row] : [] })
      const views = [...preparations.get(scope.row.id)!.queries].flatMap(id => { const query = getQuery(id); return query ? [query] : [] })
      for (const view of views) await indexQueryRows(scope, view, records)
    }
    if (activeRequests || closed) return
    if (!scope.row.raw_complete) {
      const page = await inbox.mailboxMessagePage(owner, { mailboxIds: scope.boxes.map(box => box.id), limit: RAW_BATCH, ...(scope.row.cursor ? { cursor: scope.row.cursor } : {}) })
      storeMessages(scope, page.items)
      db.query('UPDATE local_window_scopes SET cursor=?,baseline=COALESCE(baseline,?),sdk_state=?,sdk_scope=?,raw_complete=? WHERE owner=? AND id=?').run(page.nextCursor, page.state, page.state, page.scopeState, Number(!page.nextCursor), owner, scope.row.id)
      refresh(scope)
    }
    if (scope.row.raw_complete) {
      const due = db.query<DTO.InboxThreadKey, (string | number)[]>('SELECT source sourceId,thread threadId FROM local_window_rows WHERE owner=? AND scope=? AND wake<=? ORDER BY wake LIMIT 50').all(owner, scope.row.id, Date.now())
      for (const key of due) dirty(scope.row.id, key.sourceId, key.threadId)
      const keys = db.query<DTO.InboxThreadKey, string[]>('SELECT source sourceId,thread threadId FROM local_window_dirty WHERE owner=? AND scope=? LIMIT 50').all(owner, scope.row.id)
      await buildRows(scope, keys)
    }
  }
  function reset(scope: Scope, reason: string) {
    db.transaction(() => {
      for (const table of ['messages', 'contacts', 'dirty', 'rows']) db.query(`DELETE FROM local_window_${table} WHERE owner=? AND scope=?`).run(owner, scope.row.id)
      // A retention reset restarts only this unaccepted preparation. Completed
      // captures and historical Undo proofs do not depend on retained SDK events.
      for (const table of ['matches', 'counts', 'prefix', 'prefix_rows', 'query_pending']) db.query(`DELETE FROM local_window_${table} WHERE owner=? AND query_id IN (SELECT id FROM local_window_queries WHERE owner=? AND scope=?)`).run(owner, owner, scope.row.id)
      db.query('UPDATE local_window_queries SET scanned=0 WHERE owner=? AND scope=?').run(owner, scope.row.id)
      db.query('UPDATE local_window_scopes SET cursor=NULL,baseline=NULL,sdk_state=NULL,sdk_scope=\'\',raw_complete=0,revision=revision+1,reset=?,checked=0 WHERE owner=? AND id=?').run(reason, owner, scope.row.id)
    }).immediate()
    refresh(scope)
  }
  function resetReadFailure(scope: Scope, error: unknown) {
    if (!(error instanceof InboxError) || !['INVALID_CURSOR', 'STALE_CURSOR', 'SNAPSHOT_SCOPE_CHANGED', 'MAILBOX_SCOPE_CHANGED', 'HISTORY_EXPIRED', 'MAILBOX_HISTORY_EXPIRED'].includes(error.code)) return false
    const scopeChanged = ['SNAPSHOT_SCOPE_CHANGED', 'MAILBOX_SCOPE_CHANGED'].includes(error.code)
    reset(scope, scopeChanged ? 'scope' : 'history')
    if (scopeChanged) scopes.delete(scope.row.id)
    return true
  }
  async function scopedRead<T>(_scope: Scope, work: () => Promise<T>): Promise<T> {
    try { return await work() }
    catch (error) {
      // An ordinary expired read cannot invalidate an accepted capture or start a
      // replacement inventory. The caller explicitly reopens only its bounded view.
      if (error instanceof InboxError && ['INVALID_CURSOR', 'STALE_CURSOR', 'SNAPSHOT_SCOPE_CHANGED', 'MAILBOX_SCOPE_CHANGED', 'HISTORY_EXPIRED', 'MAILBOX_HISTORY_EXPIRED'].includes(error.code)) fail('HOST_INBOX_QUERY_EXPIRED', 409)
      throw error
    }
  }
  function captureWorkPending() { return preparations.size > 0 || pruning.size > 0 || [...scopes.values()].some(scope => captureLocked(scope)) }
  function schedule(delay = 10) {
    if (delay === 0 && timer) { clearTimeout(timer); timer = undefined }
    if (closed || timer || working || !captureWorkPending()) return
    timer = setTimeout(() => { timer = undefined; working = work().catch(() => {}).finally(() => {
      working = undefined
      if (captureWorkPending()) schedule([...scopes.values()].some(scope => preparations.has(scope.row.id) && !current(scope) || captureLocked(scope)) || pruning.size ? 25 : 1000)
    }) }, delay)
    timer.unref?.()
  }
  function pruneCaptureIndex(scope: Scope) {
    if (captureLocked(scope) || preparations.has(scope.row.id)) return
    // Persist invalidity before the first deletion, not after the last chunk.
    // A restart must never accept rows whose frozen summary copy was half-pruned.
    if (refresh(scope).row.reset !== 'pruning') {
      db.query("UPDATE local_window_scopes SET cursor=NULL,baseline=NULL,raw_complete=0,checked=0,reset='pruning' WHERE owner=? AND id=?").run(owner, scope.row.id)
      refresh(scope)
    }
    // Only disposable materialization is removed, in bounded chunks. Frozen items,
    // progress receipts, Undo and category/user data are never part of this cleanup.
    for (const table of ['messages', 'contacts', 'dirty', 'rows']) {
      const removed = db.query(`DELETE FROM local_window_${table} WHERE rowid IN (SELECT rowid FROM local_window_${table} WHERE owner=? AND scope=? LIMIT 500)`).run(owner, scope.row.id)
      if (removed.changes) return
    }
    for (const table of ['matches', 'counts', 'prefix', 'prefix_rows', 'query_pending']) {
      const removed = db.query(`DELETE FROM local_window_${table} WHERE rowid IN (SELECT rowid FROM local_window_${table} WHERE owner=? AND query_id IN (SELECT id FROM local_window_queries WHERE owner=? AND scope=?) LIMIT 500)`).run(owner, owner, scope.row.id)
      if (removed.changes) return
    }
    db.query("UPDATE local_window_scopes SET cursor=NULL,baseline=NULL,raw_complete=0,checked=0,reset=NULL WHERE owner=? AND id=?").run(owner, scope.row.id)
    db.query('UPDATE local_window_queries SET scanned=0 WHERE owner=? AND scope=?').run(owner, scope.row.id)
    refresh(scope); pruning.delete(scope.row.id)
  }
  async function work() {
    if (closed || activeRequests) return
    for (const [id, preparation] of preparations) if (preparation.until <= Date.now()) { preparations.delete(id); pruning.add(id) }
    const observed = watchedVersion
    if (preparations.size) await updateSavedProjections()
    for (const scope of [...scopes.values()].filter(scope => preparations.has(scope.row.id) || pruning.has(scope.row.id) || captureLocked(scope)).sort((a, b) => b.lastUsed - a.lastUsed)) {
      if (closed || activeRequests) break
      workingScope = scope
      try {
        const wasCapturing = captureLocked(scope)
        await captures(scope)
        if (wasCapturing && !captureLocked(scope)) { preparations.delete(scope.row.id); pruning.add(scope.row.id) }
        if (preparations.has(scope.row.id)) {
          await maintain(scope)
          if (scope.row.raw_complete && !hasDirty(scope) && scope.row.reset) { db.query('UPDATE local_window_scopes SET reset=NULL WHERE owner=? AND id=?').run(owner, scope.row.id); refresh(scope) }
          for (const id of preparations.get(scope.row.id)!.queries) {
            const query = getQuery(id)
            if (query && query.preference === scope.preference && query.generation === scope.row.generation && (query.scanned < scope.row.revision || queryPending(query))) await scanQuery(scope, query)
            if (closed || activeRequests) break
          }
        }
        if (pruning.has(scope.row.id)) pruneCaptureIndex(scope)
      } catch (error) {
        if (!resetReadFailure(scope, error)) { db.query("UPDATE local_window_scopes SET reset='unavailable',checked=0 WHERE owner=? AND id=?").run(owner, scope.row.id); refresh(scope) }
      } finally { workingScope = undefined }
      await wait()
    }
    watched = observed !== watchedVersion
  }

  type CaptureMeta = { account: string; queryId: string; snapshotRevision?: number; scopeGeneration: number; preference: string; contextVersion?: 1 | 2 | 3; explicitIds?: string[]; session?: DTO.InboxZeroSession; invalidated?: boolean }
  const captureRow = (id: string) => db.query<CaptureRow, string[]>('SELECT * FROM local_window_captures WHERE owner=? AND id=?').get(owner, id)
  function selection(capture: CaptureRow): DTO.InboxSelection {
    return { id: capture.id, account: json<CaptureMeta>(capture.data).account, scopeKey: capture.scope, revision: capture.revision,
      count: capture.complete ? db.query<{ count: number }, string[]>('SELECT COUNT(*) count FROM local_window_capture_items WHERE owner=? AND capture=?').get(owner, capture.id)!.count : null, captureComplete: !!capture.complete }
  }
  function zeroSession(capture: CaptureRow): DTO.InboxZeroSession {
    const meta = json<CaptureMeta>(capture.data), session = meta.session!
    const counts = db.query<{ initial: number; remaining: number; decided: number; ineligible: number }, string[]>(`SELECT COUNT(*) initial,COALESCE(SUM(status='remaining'),0) remaining,COALESCE(SUM(status='decided'),0) decided,COALESCE(SUM(status='ineligible'),0) ineligible FROM local_window_capture_items WHERE owner=? AND capture=?`).get(owner, capture.id)!
    return { ...session, revision: capture.revision, status: session.status === 'invalidated' ? 'invalidated' : !capture.complete ? 'capturing' : !counts.remaining ? 'complete' : 'ready', progress: {
      initialCount: capture.complete ? counts.initial : null, remainingCount: capture.complete ? counts.remaining : null, decidedCount: counts.decided,
      ineligibleCount: counts.ineligible, unknownCount: null, captureComplete: !!capture.complete } }
  }
  function invalidateCapture(capture: CaptureRow, meta: CaptureMeta) {
    meta.invalidated = true
    if (meta.session) meta.session.status = 'invalidated'
    db.query('UPDATE local_window_captures SET data=?,complete=1,revision=revision+1 WHERE owner=? AND id=?').run(JSON.stringify(meta), owner, capture.id)
    const scope = scopes.get(capture.scope)
    if (scope && !captureLocked(scope)) { preparations.delete(capture.scope); pruning.add(capture.scope); schedule(0) }
  }
  async function checkedCapture(id: string, kind: string) {
    const capture = captureRow(text(id))
    if (!capture || capture.kind !== kind) fail('HOST_ZERO_SESSION_NOT_FOUND', 404)
    const meta = json<CaptureMeta>(capture!.data), scope = await resolve(meta.account)
    if (meta.invalidated || meta.snapshotRevision === undefined || scope.row.id !== capture!.scope || scope.row.generation !== meta.scopeGeneration || !capture!.complete && meta.preference !== scope.preference) {
      if (!meta.invalidated) invalidateCapture(capture!, meta)
      fail('HOST_INBOX_SCOPE_CHANGED', 409)
    }
    // Only explicit capture use resumes interrupted disposal; ordinary view
    // resolution leaves any old copies inert and does no mailbox-sized cleanup.
    if (scope.row.reset === 'pruning') { pruning.add(scope.row.id); schedule(0) }
    return { capture: capture!, meta, scope }
  }
  async function newQuery(input: DTO.InboxQueryInput, scope: Scope, reuse = true): Promise<QueryRow> {
    const { limit: _, ...query } = input
    text(query.account); text(query.folder, 128); text(query.split, 128)
    if (typeof query.search !== 'boolean' || typeof query.query !== 'string' || query.query.length > 4096 || query.filter !== null && !['Unread', 'Starred', 'Important', 'No reply', 'Needs reply', 'Action requested', 'Time-sensitive', 'Suspicious', 'Unassessed'].includes(query.filter)) fail('HOST_INBOX_INVALID')
    try { parseSearch(query.query) } catch { fail('HOST_INBOX_INVALID') }
    const serialized = JSON.stringify(query)
    const preparing = JSON.stringify([...preparations.values()].flatMap(value => [...value.queries]))
    // Unfinished captures still consult their query. Completed queues and Undo use
    // frozen capture items instead; never remove those items or materialized refs.
    const disposable = `NOT EXISTS(SELECT 1 FROM local_window_captures c WHERE c.owner=q.owner AND c.complete=0 AND json_extract(c.data,'$.queryId')=q.id)
      AND NOT EXISTS(SELECT 1 FROM local_window_matches m WHERE m.owner=q.owner AND m.query_id=q.id)
      AND NOT EXISTS(SELECT 1 FROM local_window_query_pending p WHERE p.owner=q.owner AND p.query_id=q.id)
      AND NOT EXISTS(SELECT 1 FROM local_window_counts c WHERE c.owner=q.owner AND c.query_id=q.id)
      AND NOT EXISTS(SELECT 1 FROM local_window_prefix p WHERE p.owner=q.owner AND p.query_id=q.id)
      AND NOT EXISTS(SELECT 1 FROM local_window_prefix_rows p WHERE p.owner=q.owner AND p.query_id=q.id)
      AND q.id NOT IN (SELECT value FROM json_each(?))`
    const expired = db.query<{ id: string }, (string | number)[]>(`SELECT q.id FROM local_window_queries q WHERE q.owner=? AND q.expires<? AND ${disposable} LIMIT 8`).all(owner, Date.now(), preparing)
    for (const value of expired) db.query('DELETE FROM local_window_queries WHERE owner=? AND id=?').run(owner, value.id)
    const prior = reuse ? db.query<QueryRow, (string | number)[]>('SELECT * FROM local_window_queries WHERE owner=? AND scope=? AND preference=? AND generation=? AND data=? AND expires>? AND problem IS NULL LIMIT 1').get(owner, scope.row.id, scope.preference, scope.row.generation, serialized, Date.now()) : null
    if (prior) return prior
    const active = db.query<{ count: number }, (string | number)[]>('SELECT COUNT(*) count FROM local_window_queries WHERE owner=? AND scope=? AND expires>?')
    let count = active.get(owner, scope.row.id, Date.now())!.count
    if (count >= 128) {
      // TTL renewal already records recency. Reclaim one atomic bounded batch,
      // keeping independent public IDs and every capture/preparation safety fence.
      db.query(`DELETE FROM local_window_queries WHERE owner=? AND scope=? AND id IN (
        SELECT q.id FROM local_window_queries q WHERE q.owner=? AND q.scope=? AND q.expires>? AND ${disposable}
        ORDER BY q.expires,q.id LIMIT 32)`).run(owner, scope.row.id, owner, scope.row.id, Date.now(), preparing)
      count = active.get(owner, scope.row.id, Date.now())!.count
    }
    if (count >= 128) fail('HOST_INBOX_UNAVAILABLE', 429)
    const id = crypto.randomUUID()
    db.query('INSERT INTO local_window_queries(owner,id,scope,data,preference,generation,expires) VALUES (?,?,?,?,?,?,?)').run(owner, id, scope.row.id, serialized, scope.preference, scope.row.generation, Date.now() + QUERY_TTL)
    return getQuery(id)!
  }
  async function createCapture(input: DTO.InboxSelectionInput | DTO.InboxZeroCreateInput, kind: 'selection' | 'zero') {
    text(input.id, 128)
    const fingerprint = digest(input), existing = captureRow(input.id)
    if (existing) {
      if (existing.input !== fingerprint || existing.kind !== kind) fail('HOST_ZERO_SESSION_CONFLICT', 409)
      await checkedCapture(existing.id, kind)
      return existing
    }
    if (kind === 'selection') {
      const selected = input as DTO.InboxSelectionInput
      if (selected.allMatching === true ? typeof selected.queryId !== 'string' || selected.ids !== undefined : !Array.isArray(selected.ids) || selected.queryId !== undefined) fail('HOST_INBOX_INVALID')
    }
    const scope = await resolve(input.account)
    let query: QueryRow, explicitIds: string[] | undefined
    if ('allMatching' in input && input.allMatching) {
      const resolved = await queryScope(input.queryId!)
      if (resolved.scope.row.id !== scope.row.id) fail('HOST_INBOX_SCOPE_CHANGED', 409)
      query = resolved.query
    } else {
      if ('ids' in input && input.ids) explicitIds = ids(input.ids)
      query = await newQuery({ account: input.account, folder: 'All Mail', split: 'Important', search: false, query: '', filter: null }, scope)
    }
    if (scope.row.reset === 'pruning') pruning.add(scope.row.id)
    const live = scope.boxes.length && current(scope) ? await inbox.mailboxConversations(owner, { mailboxIds: scope.boxes.map(box => box.id), limit: 1 }) : null
    const caughtUp = !scope.boxes.length || !!live && live.state === scope.row.baseline && live.scopeState === scope.row.sdk_scope
    const canonicalProjection = json<{ projection?: ProjectionStamp }>(scope.row.data).projection?.contextVersion === 3
    if (!current(scope) || !caughtUp || !canonicalProjection || 'allMatching' in input && input.allMatching === true && (query.scanned < scope.row.revision || queryPending(query)) || captureLocked(scope) || scope.users > 1 || workingScope === scope || pruning.has(scope.row.id)) {
      if (!pruning.has(scope.row.id) && !captureLocked(scope)) {
        let preparation = preparations.get(scope.row.id)
        if (!preparation) {
          if (preparations.size >= 4) fail('HOST_INBOX_UNAVAILABLE', 429)
          preparation = { until: Date.now() + 5 * 60_000, queries: new Set() }; preparations.set(scope.row.id, preparation)
          const saved = json<{ projection?: ProjectionStamp }>(scope.row.data).projection
          if (saved?.preference !== scope.preference || saved.aiCursor !== scope.ai.cursor || saved.categoryCursor !== categoryHead() || saved.contextVersion !== 3) invalidateProjection(scope)
          // Only new explicit preparation upgrades dormant rows. Accepted captures
          // retain their original evidence/version and are never silently rebased.
          stamp(scope, { preference: scope.preference, aiCursor: scope.ai.cursor, categoryCursor: categoryHead(), contextVersion: 3 })
          if (!caughtUp) { db.query('UPDATE local_window_scopes SET checked=0 WHERE owner=? AND id=?').run(owner, scope.row.id); refresh(scope) }
          if (!scope.boxes.length) { db.query('UPDATE local_window_scopes SET raw_complete=1,checked=? WHERE owner=? AND id=?').run(Date.now(), owner, scope.row.id); scope.seenEvents = watchedVersion; refresh(scope) }
        }
        if (preparation.queries.size >= 8 && !preparation.queries.has(query.id)) fail('HOST_INBOX_UNAVAILABLE', 429)
        preparation.until = Date.now() + 5 * 60_000
        preparation.queries.add(query.id)
      }
      schedule(0)
      fail('HOST_INBOX_PREPARING', 503)
    }
    // Acceptance is the snapshot boundary. No awaiting, deferred readiness, or later arrivals.
    const meta: CaptureMeta = { account: input.account, queryId: query.id, snapshotRevision: scope.row.revision, scopeGeneration: scope.row.generation, preference: scope.preference, contextVersion: 3, ...(explicitIds ? { explicitIds } : {}) }
    if (kind === 'zero') meta.session = { version: 2, id: input.id, account: input.account, scopeKey: scope.row.id, revision: 1, startedAt: Date.now(), phase: 'batches', paused: false, currentId: null,
      status: 'capturing', progress: { initialCount: null, remainingCount: null, decidedCount: 0, ineligibleCount: 0, unknownCount: null, captureComplete: false } }
    db.query('INSERT INTO local_window_captures(owner,id,kind,scope,data,input) VALUES (?,?,?,?,?,?)').run(owner, input.id, kind, scope.row.id, JSON.stringify(meta), fingerprint)
    schedule(0)
    return captureRow(input.id)!
  }
  async function captures(scope: Scope) {
    // Frozen queues own their lifecycle; query expiry cannot strand the scope lock.
    const values = db.query<CaptureRow, string[]>('SELECT * FROM local_window_captures WHERE owner=? AND scope=? AND complete=0 LIMIT 4').all(owner, scope.row.id)
    if (values.length) {
      let live: Scope
      try { live = await resolve(scope.row.account) }
      catch (error) {
        if (!(error instanceof InboxError && error.code === 'HOST_INBOX_SCOPE_CHANGED')) throw error
        for (const capture of values) invalidateCapture(capture, json(capture.data))
        return
      }
      if (live.row.id !== scope.row.id) { for (const capture of values) invalidateCapture(capture, json(capture.data)); return }
    }
    for (const capture of values) {
      const meta = json<CaptureMeta>(capture.data)
      const query = capture.kind === 'selection' && !meta.explicitIds ? getQuery(meta.queryId) : null
      if (meta.invalidated || meta.snapshotRevision === undefined || meta.scopeGeneration !== scope.row.generation || meta.preference !== scope.preference
        || capture.kind === 'selection' && !meta.explicitIds && (!query || query.scope !== scope.row.id || query.generation !== meta.scopeGeneration || query.preference !== meta.preference)) {
        invalidateCapture(capture, meta); continue
      }
      const records = capture.kind === 'zero'
        ? db.query<StoredRow, (string | number)[]>('SELECT * FROM local_window_rows WHERE owner=? AND scope=? AND revision>? AND revision<=? ORDER BY revision LIMIT 100').all(owner, scope.row.id, capture.cursor, meta.snapshotRevision!)
        : meta.explicitIds
          ? db.query<StoredRow, (string | number)[]>('SELECT * FROM local_window_rows WHERE owner=? AND scope=? AND revision>? AND revision<=? AND key IN (SELECT value FROM json_each(?)) ORDER BY revision LIMIT 100').all(owner, scope.row.id, capture.cursor, meta.snapshotRevision!, JSON.stringify(meta.explicitIds))
          : db.query<StoredRow, (string | number)[]>('SELECT r.* FROM local_window_matches m JOIN local_window_rows r ON r.owner=m.owner AND r.scope=? AND r.key=m.key WHERE m.owner=? AND m.query_id=? AND r.revision>? AND r.revision<=? ORDER BY r.revision LIMIT 100').all(scope.row.id, owner, meta.queryId, capture.cursor, meta.snapshotRevision!)
      let ordinal = db.query<{ ordinal: number }, string[]>('SELECT COALESCE(MAX(ordinal),0) ordinal FROM local_window_capture_items WHERE owner=? AND capture=?').get(owner, capture.id)!.ordinal
      for (const stored of records) {
        const row = json<DTO.InboxWindowRow>(stored.data), fullValues = summaries(scope, row.sourceId, row.threadId, 500)
        const projected = project(scope, fullValues), mail = { ...row.mail, messages: projected.mail.find(mail => mail.account === scope.row.account)!.messages }
        const frozenScope = zeroScope(scope.row.account, scope.boxes.map(box => box.id), projected.accounts)
        const eligibility = row.counts.messages === fullValues.length ? zeroEligible(mail, frozenScope) : inFolder(mail, 'Inbox') && mail.split === 'Important' && !mail.operationId && !mail.muted
        capture.cursor = stored.revision
        if (capture.kind === 'zero' && !eligibility) continue
        const review = zeroReviewVersion(mail, frozenScope)
        const candidate = row.counts.messages === fullValues.length && row.targetsComplete ? zeroBatchCandidate(mail, frozenScope, scope.ai) : null
        const opaqueReview = reviewToken(capture.id, review)
        const item: DTO.InboxZeroItem = { id: row.key, eligibility: eligibility ? 'eligible' : 'ineligible', reviewVersion: opaqueReview,
          batchEligibility: candidate ? 'eligible' : 'ineligible', batchCandidate: candidate ? { ...candidate, reviewVersion: opaqueReview } : null }
        db.query('INSERT OR IGNORE INTO local_window_capture_items VALUES (?,?,?,?,?,?,?,?)').run(owner, capture.id, ++ordinal, row.key, stored.context, review, JSON.stringify({ item, targets: row.targets, contextComplete: row.targetsComplete && row.counts.messages === fullValues.length && row.counts.memberships === fullValues.reduce((sum, value) => sum + value.memberships.length, 0), contextEvidence: json<{ contextEvidence?: string }>(stored.data).contextEvidence, categoryRevision: db.query<{ revision: number }, string[]>('SELECT revision FROM local_category_overrides WHERE owner=? AND source=? AND thread=?').get(owner, row.sourceId, row.threadId)?.revision ?? 0 }), 'remaining')
      }
      if (records.length < 100 && meta.explicitIds) for (const id of meta.explicitIds) {
        if (!db.query('SELECT 1 FROM local_window_capture_items WHERE owner=? AND capture=? AND key=?').get(owner, capture.id, id)) {
          const item: DTO.InboxZeroItem = { id, eligibility: 'unknown', reviewVersion: null, batchEligibility: 'unknown', batchCandidate: null }
          db.query('INSERT INTO local_window_capture_items VALUES (?,?,?,?,?,?,?,?)').run(owner, capture.id, ++ordinal, id, '', '', JSON.stringify({ item, targets: [], contextComplete: false }), 'remaining')
        }
      }
      db.query('UPDATE local_window_captures SET cursor=?,complete=?,revision=revision+1 WHERE owner=? AND id=?').run(capture.cursor, Number(records.length < 100), owner, capture.id)
    }
  }
  async function lookupRows(scope: Scope, requested: string[], budget = readBudget(), fullContext = false): Promise<DTO.InboxLookupEntry[]> {
    const found = new Map<string, DTO.InboxWindowRow>(), absent = new Set<string>()
    const keys = requested.flatMap(id => { const key = ownedKey(scope, id); if (!key) absent.add(id); return key ? [key] : [] })
    if (!scope.boxes.length) { observe(scope, null, scope.row.id); return requested.map(id => ({ id, status: 'absent' })) }
    for (let offset = 0; offset < keys.length && budget.pages > 0; offset += 50) {
      const wanted = keys.slice(offset, offset + 50), items = new Map<string, MailboxConversation>()
      let cursor: string | undefined, read: ReadBaseline
      do {
        budget.pages--
        const page = await inbox.mailboxConversations(owner, { mailboxIds: scope.boxes.map(box => box.id), keys: wanted, limit: 100, ...(cursor ? { cursor } : {}) })
        read = observe(scope, page.state, page.scopeState)
        for (const item of page.items) items.set(threadKey(item), item)
        cursor = page.nextCursor ?? undefined
      } while (cursor && budget.pages > 0)
      // Spend scarce detail reads in requested/capture ordinal order, not SDK
      // chronological order. Otherwise an early captured item can starve forever.
      const ordered = wanted.flatMap(key => { const item = items.get(threadKey(key)); return item ? [item] : [] })
      for (const row of await projectConversations(scope, ordered, budget, fullContext)) {
        if (!budget.unknownLocation.has(row.key)) { row.revision = read!.revision; found.set(row.key, row) }
      }
      // Only an exhausted keyed SDK read proves absence. Deferred projection or
      // an insufficient detail budget never turns a present identity into absent.
      if (!cursor) for (const key of wanted) if (!items.has(threadKey(key))) absent.add(mailKey(scope, key))
    }
    return requested.map(id => found.has(id) ? { id, status: 'found', row: found.get(id)! } : { id, status: absent.has(id) ? 'absent' : 'unknown' })
  }
  async function sender(input: DTO.InboxSenderInput): Promise<DTO.InboxSenderResult> {
    const scope = await resolve(input.account), budget = readBudget(), entry = (await lookupRows(scope, [text(input.id)], budget, true))[0]!
    if (entry.status !== 'found') return { state: state(scope), status: entry.status, contact: null, activity: null, recent: [] }
    const row = entry.row, values = [...budget.summaries.get(row.key) ?? row.summaries]
    if (input.selectedMessageId && !values.some(value => value.id === input.selectedMessageId)) {
      const id = text(input.selectedMessageId, 512)
      for (const box of scope.boxes.filter(box => box.sourceId === row.sourceId)) {
        if (budget.details <= 0) break
        budget.details--
        try {
          const selected = await inbox.mailboxMessageSummary(owner, box.id, id)
          if (selected.sourceId !== row.sourceId || selected.threadId !== row.threadId) fail('HOST_INBOX_INVALID')
          values.push(selected); break
        } catch (error) { if (!(error instanceof InboxError) || error.status !== 404) throw error }
      }
      if (!values.some(value => value.id === id)) return { state: state(scope), status: 'unknown', contact: null, activity: null, recent: [] }
    }
    if (!input.selectedMessageId && values.length !== row.counts.messages && values.every(value => value.folder === 'sent')) return { state: state(scope), status: 'unknown', contact: null, activity: null, recent: [] }
    const history: SenderHistoryMessage[] = values.map(value => ({ ...value, outgoing: value.folder === 'sent', mailboxIds: value.memberships.map(state => state.mailboxId) }))
    const projection = project(scope, values), mail = projection.mail.find(mail => mail.account === scope.row.account)!
    const contact = senderContact(mail, history, projection.accounts, input.selectedMessageId)
    const domain = input.domain ? text(input.domain, 253).toLowerCase() : null, hostname = senderHostname(contact.email)
    if (domain && (!hostname || senderHostname(`root@${domain}`) !== domain || !(hostname === domain || hostname.endsWith(`.${domain}`)))) fail('HOST_INBOX_INVALID')
    if (domain) {
      if (!deps.senderDomains) fail('HOST_INBOX_UNAVAILABLE', 503)
      const response = await deps.senderDomains!.fetch(new Request(`http://localhost/host/sender-domains/${encodeURIComponent(hostname!)}`))
      const info = await response.json() as SenderDomainInfo
      if (!response.ok || info.kind !== 'domain' || info.rootDomain !== domain) fail('HOST_INBOX_INVALID')
    }
    const week = 7 * 86400_000
    let activity: Awaited<ReturnType<Inbox['mailboxCorrespondence']>>
    try { activity = await inbox.mailboxCorrespondence(owner, { mailboxIds: scope.boxes.map(box => box.id), email: contact.email.trim().toLowerCase(), ...(domain ? { domain } : {}), since: new Date(Date.now() - 12 * week).toISOString(), bucketMs: week, bucketCount: 12, recentLimit: 5 }) }
    catch (error) {
      if (!(error instanceof InboxError) || error.code !== 'READ_UNAVAILABLE') throw error
      return { state: state(scope), status: 'unknown', contact: null, activity: null, recent: [] }
    }
    observe(scope, activity.state, activity.scopeState)
    const recent = (await lookupRows(scope, activity.recent.map(key => mailKey(scope, key)), budget)).flatMap(entry => entry.status === 'found' ? [entry.row] : [])
    const { received, sent, conversations, twoWay } = activity, level = !received && !sent ? 0 : twoWay >= 25 ? 5 : twoWay >= 10 ? 4 : twoWay >= 3 ? 3 : twoWay ? 2 : 1
    const timestamp = (value: string | null) => value === null ? null : Date.parse(value)
    return { state: state(scope), status: 'ready', contact, activity: { received, sent, conversations, twoWay, level,
      firstMessage: timestamp(activity.firstMessageAt), lastMessage: timestamp(activity.lastMessageAt), lastSent: timestamp(activity.lastSentAt),
      weeks: activity.periods.map(period => ({ ...period, start: Date.parse(period.start) })) }, recent }
  }

  type ZeroItemRow = { key: string; context: string; review: string; data: string; status: string }
  type ZeroItemData = { item: DTO.InboxZeroItem; targets: MailboxStateTarget[]; contextComplete: boolean; contextEvidence?: string; categoryRevision?: number; reviewOnly?: boolean; latestProgress?: string; credit?: string; batchOffer?: { version: string; categoryRevision: number } }
  type ZeroProof = { id: string; context: string; decision: DTO.InboxZeroDecisionInput['decision']; sourceId: string; threadId: string;
    before: MailboxMembership[]; states: MailboxMembership[]; receipts: DTO.InboxActionReceiptReference[];
    category?: { id: string; revision: number; before: CategoryEntry }; undoneBy?: string }
  type ZeroProgressRecord = { kind: 'progress'; result: DTO.InboxZeroProgressResult; proofs: ZeroProof[] }
  type ZeroUndoRecord = { kind: 'undo'; result: DTO.InboxZeroUndoResult }
  const rejectedReceipt = Symbol('rejected receipt'), pendingReceipt = Symbol('pending receipt')
  const memberKey = (state: Pick<MailboxMembership, 'mailboxId' | 'messageId'>) => `${state.mailboxId}\0${state.messageId}`
  const sameState = (left: MailboxMembership, right: MailboxMembership) => left.revision === right.revision && left.done === right.done && left.snoozedUntil === right.snoozedUntil
  const zeroItem = (capture: string, key: string) => db.query<ZeroItemRow, string[]>('SELECT key,context,review,data,status FROM local_window_capture_items WHERE owner=? AND capture=? AND key=?').get(owner, capture, key)
  let zeroWrites: Promise<unknown> = Promise.resolve()
  function serialZero<T>(work: () => Promise<T>): Promise<T> {
    const task = zeroWrites.then(work); zeroWrites = task.catch(() => {}); return task
  }
  function receiptReferences(value: unknown): DTO.InboxActionReceiptReference[] {
    if (!Array.isArray(value) || value.length > 500) return fail('HOST_INBOX_INVALID')
    const references: DTO.InboxActionReceiptReference[] = []
    for (const raw of value) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('HOST_INBOX_INVALID')
      if (raw.kind === 'mailbox-membership') {
        if (Object.keys(raw).sort().join(',') !== 'kind,target' || !raw.target || typeof raw.target !== 'object' || Array.isArray(raw.target)
          || Object.keys(raw.target).some(key => !['mailboxId', 'messageId', 'revision', 'messageRevision'].includes(key))) fail('HOST_INBOX_INVALID')
        const target = { mailboxId: text(raw.target.mailboxId, 512), messageId: text(raw.target.messageId, 512), revision: integer(raw.target.revision) }
        if (!target.revision || raw.target.messageRevision !== undefined && !integer(raw.target.messageRevision)) fail('HOST_INBOX_INVALID')
        references.push({ kind: 'mailbox-membership', target })
      } else {
        if (Object.keys(raw).sort().join(',') !== 'id,kind' || !['mailbox-state', 'attention-feedback', 'category', 'operation'].includes(raw.kind)) fail('HOST_INBOX_INVALID')
        references.push({ kind: raw.kind, id: text(raw.id, 128) })
      }
    }
    if (new Set(references.map(receiptKey)).size !== references.length) fail('HOST_INBOX_INVALID')
    return references
  }
  function receiptKey(reference: DTO.InboxActionReceiptReference): string {
    return reference.kind === 'mailbox-membership' ? `member:${memberKey(reference.target)}:${reference.target.revision}`
      : reference.kind === 'attention-feedback' ? `mailbox-state:attention:${reference.id}` : `${reference.kind}:${reference.id}`
  }
  async function freshBatchCandidates(scope: Scope, capture: CaptureRow, items: Array<Pick<ZeroItemRow, 'key' | 'review' | 'data'>>, before?: Map<string, CategoryEntry>) {
    const result = new Map<string, { candidate: NonNullable<DTO.InboxZeroItem['batchCandidate']>; offer: NonNullable<ZeroItemData['batchOffer']> }>()
    const ai = await deps.ai.state(owner)
    for (let offset = 0; offset < items.length; offset += BATCH) {
      const batch = items.slice(offset, offset + BATCH).flatMap(item => {
        const saved = json<ZeroItemData>(item.data), key = ownedKey(scope, item.key)
        return saved.reviewOnly || !saved.contextComplete || !key ? [] : [{ item, saved, key }]
      })
      if (!batch.length) continue
      const keys = batch.map(value => value.key)
      const [page, decisions, categories] = await Promise.all([
        inbox.mailboxConversations(owner, { mailboxIds: scope.boxes.map(box => box.id), keys, limit: BATCH }),
        deps.ai.lookup(owner, keys), deps.attentionOverrides.lookup(keys),
      ])
      for (const { item, saved, key } of batch) {
        const conversation = page.items.find(value => value.sourceId === key.sourceId && value.threadId === key.threadId)
        // Incomplete or changed contexts stay available for individual review, never a batch.
        if (!conversation?.messagesComplete || !conversation.targetsComplete || conversation.targets.length !== saved.targets.length
          || conversation.targets.some(target => !saved.targets.some(prior => memberKey(prior) === memberKey(target) && prior.revision === target.revision))) continue
        const projected = project(scope, conversation.messages), mail = projected.mail.find(value => value.account === scope.row.account)
        if (!mail) continue
        const selected = zeroScope(scope.row.account, scope.boxes.map(box => box.id), projected.accounts)
        if (zeroReviewVersion(mail, selected) !== item.review) continue
        const category = before?.get(item.key) ?? categories.entries.find(value => value.sourceId === key.sourceId && value.threadId === key.threadId)
        if (!category || category.revision !== saved.categoryRevision) continue
        if (currentCategoryOverride(mail, category.override)) mail.attentionOverride = category
        const decision = decisions.decisions.find(value => value.sourceId === key.sourceId && value.threadId === key.threadId)
        // Do not fall back to weaker baseline evidence for a stale/disabled saved assessment.
        if (decision) mail.triage = currentAiDecision(mail, decision, ai.settings.model)
        if (ai.configured && ai.settings.enabled && ai.settings.mode === 'apply' && mail.triage?.state === 'ready' && mail.triage.score) mail.attentionCategory = mail.triage.score.category
        const candidate = zeroBatchCandidate(mail, selected, ai)
        if (!candidate) continue
        const provenance = digest([ai.configured, ai.settings, category, decision ?? null, mail.messages.map(message => message.attention)])
        const version = reviewToken(capture.id, JSON.stringify(['batch', item.review, provenance]))
        result.set(item.key, { candidate: { ...candidate, reviewVersion: version }, offer: { version, categoryRevision: category.revision } })
      }
      await wait()
    }
    return result
  }
  function verificationCache() {
    const receipts = new Map<string, Promise<MailboxStateReceipt>>(), messages = new Map<string, Promise<MailboxMessageSummary>>()
    return {
      receipt(id: string) { let result = receipts.get(id); if (!result) { if (receipts.size >= 500) throw rejectedReceipt; result = inbox.mailboxStateReceipt(owner, id); receipts.set(id, result) }; return result },
      message(target: Pick<MailboxStateTarget, 'mailboxId' | 'messageId'>) { const key = memberKey(target); let result = messages.get(key); if (!result) { if (messages.size >= 500) throw rejectedReceipt; result = inbox.mailboxMessageSummary(owner, target.mailboxId, target.messageId); messages.set(key, result) }; return result },
    }
  }
  /** These are application-owned command ledgers, never canonical SDK SQL. Their
   * public services have no receipt getter; reads stay owner-bound and byte-limited.
   */
  function categoryCommand(id: string) {
    const saved = db.query<{ receipt: string; before_entries: string }, string[]>('SELECT receipt,before_entries FROM local_category_commands WHERE owner=? AND id=? AND length(CAST(receipt AS BLOB))<=262144 AND length(CAST(before_entries AS BLOB))<=262144').get(owner, id)
    if (!saved) throw rejectedReceipt
    return { receipt: json<CategoryReceipt>(saved.receipt), before: json<CategoryEntry[]>(saved.before_entries) }
  }
  function feedbackCommand(id: string) {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE name='local_attention_feedback' AND type='table'").get()) throw rejectedReceipt
    const saved = db.query<{ data: string }, string[]>('SELECT data FROM local_attention_feedback WHERE owner=? AND id=? AND length(CAST(data AS BLOB))<=262144').get(owner, id)
    if (!saved) throw rejectedReceipt
    return json<{ id: string; status: string; targets: Array<MailboxStateTarget & { sourceId: string }> }>(saved.data)
  }
  async function zeroEvidence(scope: Scope, item: ZeroItemRow, cache: ReturnType<typeof verificationCache>) {
    const saved = json<ZeroItemData>(item.data)
    if (!saved.contextComplete || !saved.targets.length || saved.targets.length > 500) throw rejectedReceipt
    const review = json<unknown[]>(item.review)
    if (review.length !== 8 || typeof review[2] !== 'string' || typeof review[3] !== 'string' || !Array.isArray(review[7])) throw rejectedReceipt
    const sourceId = review[2], threadId = review[3]
    const before = new Map<string, MailboxMembership>(), content = new Map<string, string | null>()
    for (const value of review[7] as unknown[][]) {
      if (!Array.isArray(value) || typeof value[0] !== 'string' || !Array.isArray(value[8])) throw rejectedReceipt
      content.set(value[0], typeof value[1] === 'string' ? value[1] : null)
      for (const state of value[8] as Array<[string, boolean, string | null]>) before.set(memberKey({ mailboxId: state[0], messageId: value[0] }), { mailboxId: state[0], messageId: value[0], revision: 0, done: state[1], snoozedUntil: state[2] })
    }
    if (before.size !== saved.targets.length || new Set(saved.targets.map(memberKey)).size !== before.size) throw rejectedReceipt
    const live = new Map<string, MailboxMembership>(), restored = new Map<string, MailboxMessageSummary>()
    for (const target of saved.targets) {
      const original = before.get(memberKey(target))
      if (!original || !scope.boxes.some(box => box.id === target.mailboxId && box.sourceId === sourceId)) throw rejectedReceipt
      original.revision = target.revision
      const summary = await cache.message(target), state = summary.memberships.find(state => state.mailboxId === target.mailboxId)
      if (!state || summary.sourceId !== sourceId || summary.threadId !== threadId || (content.get(summary.id) === null && summary.revision !== target.messageRevision)) throw rejectedReceipt
      live.set(memberKey(target), state)
      const previous = restored.get(summary.id)
      restored.set(summary.id, { ...summary, memberships: [...previous?.memberships ?? [], original] })
    }
    // Compare captured content while restoring only the captured pre-command local
    // states. Read/star changes are not decisions; later replies are never added.
    const projected = project(scope, [...restored.values()]), mail = projected.mail.find(mail => mail.account === scope.row.account)
    if (!mail || zeroReviewVersion(mail, zeroScope(scope.row.account, scope.boxes.map(box => box.id), projected.accounts)) !== item.review) throw rejectedReceipt
    return { saved, sourceId, threadId, before, live, content }
  }
  function categoryContextMatches(context: CategoryContext, evidence: Awaited<ReturnType<typeof zeroEvidence>>, scope: Scope) {
    if (context.sourceId !== evidence.sourceId || context.threadId !== evidence.threadId || context.sourceGeneration !== scope.sources.find(source => source.id === context.sourceId)?.generation) return false
    const targets = new Map(evidence.saved.targets.map(target => [memberKey(target), target]))
    const members = context.messages.flatMap(message => message.memberships.map(state => ({ message, state, key: memberKey({ mailboxId: state.mailboxId, messageId: message.messageId }) })))
    return context.messages.length === evidence.content.size && members.length === targets.size && new Set(members.map(member => member.key)).size === targets.size
      && context.mailboxIds.length === new Set(evidence.saved.targets.map(target => target.mailboxId)).size && context.mailboxIds.every(id => evidence.saved.targets.some(target => target.mailboxId === id))
      && members.every(({ message, state, key }) => { const target = targets.get(key); return !!target && state.revision === target.revision && message.bodyRevision === evidence.content.get(message.messageId) && (message.bodyRevision !== null || message.revision === target.messageRevision) })
  }
  async function verifyZeroDecision(scope: Scope, capture: CaptureRow, item: ZeroItemRow, decision: DTO.InboxZeroDecisionInput, progressId: string, cache: ReturnType<typeof verificationCache>): Promise<ZeroProof> {
    const batch = json<ZeroItemData>(item.data).batchOffer
    const batchReview = decision.reviewVersion !== reviewToken(capture.id, item.review)
    if (item.status !== 'remaining' || batchReview && batch?.version !== decision.reviewVersion) throw rejectedReceipt
    const evidence = await zeroEvidence(scope, item, cache), states = new Map<string, MailboxMembership>(), used: DTO.InboxActionReceiptReference[] = []
    let category: ZeroProof['category']
    for (const reference of decision.receipts) {
      if ((decision.decision === 'done' || decision.decision === 'later') && reference.kind === 'mailbox-state' || decision.decision === 'done' && reference.kind === 'attention-feedback') {
        const id = reference.kind === 'attention-feedback' ? `attention:${reference.id}` : reference.id
        const receipt = await cache.receipt(id), relevant = receipt.states.filter(state => evidence.before.has(memberKey(state)))
        if (!relevant.length) continue
        if (receipt.retracted || receipt.id !== id) throw rejectedReceipt
        if (reference.kind === 'attention-feedback') {
          const feedback = feedbackCommand(reference.id)
          if (feedback.status === 'pending') throw pendingReceipt
          if (feedback.status !== 'active' || feedback.id !== reference.id || relevant.some(state => !feedback.targets.some(target => target.sourceId === evidence.sourceId && memberKey(target) === memberKey(state) && target.revision + 1 === state.revision))) throw rejectedReceipt
        }
        for (const state of relevant) {
          const before = evidence.before.get(memberKey(state))!, current = evidence.live.get(memberKey(state))!
          const intended = decision.decision === 'done' ? state.done && state.snoozedUntil === null
            : state.done === before.done && state.snoozedUntil !== null && Number.isFinite(Date.parse(state.snoozedUntil)) && Date.parse(state.snoozedUntil) > Date.now()
          if (!intended || state.revision !== before.revision + 1 || !sameState(current, state)) throw rejectedReceipt
          const previous = states.get(memberKey(state)); if (previous && !sameState(previous, state)) throw rejectedReceipt
          states.set(memberKey(state), state)
        }
        used.push(reference)
      } else if (decision.decision === 'later' && reference.kind === 'mailbox-membership') {
        const key = memberKey(reference.target), before = evidence.before.get(key)
        if (!before) continue
        const current = evidence.live.get(key)!
        if (reference.target.revision !== before.revision + 1 || current.revision !== reference.target.revision || current.done !== before.done || !current.snoozedUntil || Date.parse(current.snoozedUntil) <= Date.now()) throw rejectedReceipt
        states.set(key, current); used.push(reference)
      } else if (decision.decision === 'other' && reference.kind === 'category') {
        const command = categoryCommand(reference.id), entry = command.receipt.entries.find(entry => entry.sourceId === evidence.sourceId && entry.threadId === evidence.threadId)
        if (!entry) continue
        const before = command.before.find(entry => entry.sourceId === evidence.sourceId && entry.threadId === evidence.threadId)
        if (category || command.receipt.id !== reference.id || command.receipt.retracted || !entry.override || entry.override.category !== 'Other' || !before
          || evidence.saved.categoryRevision === undefined || before.revision !== evidence.saved.categoryRevision || entry.revision <= before.revision || !categoryContextMatches(entry.override.context, evidence, scope)) throw rejectedReceipt
        const live = (await deps.attentionOverrides.lookup([{ sourceId: evidence.sourceId, threadId: evidence.threadId }])).entries[0]
        if (!live || live.revision !== entry.revision || digest(live.override) !== digest(entry.override)) throw rejectedReceipt
        for (const [key, state] of evidence.before) { if (!sameState(evidence.live.get(key)!, state)) throw rejectedReceipt; states.set(key, state) }
        category = { id: reference.id, revision: entry.revision, before }; used.push(reference)
      } else throw rejectedReceipt // Provider operations, queued sends and reads never qualify.
    }
    if (!used.length) throw rejectedReceipt
    if (states.size !== evidence.before.size) throw pendingReceipt
    if (batchReview) {
      if (decision.decision !== 'other' || !category || category.before.revision !== batch!.categoryRevision || evidence.saved.reviewOnly) throw rejectedReceipt
      // The conditional category receipt proves it followed this validated category
      // revision. Reconstruct only that command's pre-category state; fresh AI and
      // full metadata must still authorize the exact issued batch provenance.
      const fresh = await freshBatchCandidates(scope, capture, [item], new Map([[item.key, category.before]]))
      if (fresh.get(item.key)?.offer.version !== decision.reviewVersion) throw rejectedReceipt
    }
    for (const reference of used) {
      const prior = db.query<{ progress: string }, string[]>('SELECT progress FROM local_window_zero_receipts WHERE owner=? AND receipt=? AND key=?').get(owner, receiptKey(reference), `${evidence.sourceId}\0${evidence.threadId}`)
      if (prior && prior.progress !== progressId) throw rejectedReceipt
    }
    return { id: item.key, context: item.context, decision: decision.decision, sourceId: evidence.sourceId, threadId: evidence.threadId, before: [...evidence.before.values()], states: [...states.values()], receipts: used, ...(category ? { category } : {}) }
  }
  async function verifyZeroUndo(scope: Scope, item: ZeroItemRow, proof: ZeroProof, references: DTO.InboxActionReceiptReference[], cache: ReturnType<typeof verificationCache>) {
    const evidence = await zeroEvidence(scope, item, cache), covered = new Set<string>()
    let categoryRevision: number | undefined
    for (const original of proof.receipts) {
      if (original.kind === 'mailbox-state' || original.kind === 'attention-feedback') {
        if (!references.some(reference => receiptKey(reference) === receiptKey(original))) throw rejectedReceipt
        const id = original.kind === 'attention-feedback' ? `attention:${original.id}` : original.id, receipt = await cache.receipt(id)
        if (!receipt.retracted) {
          if (proof.states.some(state => receipt.states.some(value => memberKey(value) === memberKey(state)) && !sameState(evidence.live.get(memberKey(state))!, state))) throw rejectedReceipt
          throw pendingReceipt
        }
        if (original.kind === 'attention-feedback' && feedbackCommand(original.id).status !== 'retracted') throw pendingReceipt
        for (const accepted of proof.states.filter(state => receipt.states.some(restored => memberKey(restored) === memberKey(state)))) {
          const restored = receipt.states.find(state => memberKey(state) === memberKey(accepted))!, before = evidence.before.get(memberKey(accepted))!, current = evidence.live.get(memberKey(accepted))!
          if (restored.revision !== accepted.revision + 1 || restored.done !== before.done || restored.snoozedUntil !== before.snoozedUntil || !sameState(current, restored)) throw rejectedReceipt
          covered.add(memberKey(accepted))
        }
      } else if (original.kind === 'mailbox-membership') {
        const key = memberKey(original.target), inverse = references.find((reference): reference is Extract<DTO.InboxActionReceiptReference, { kind: 'mailbox-membership' }> => reference.kind === 'mailbox-membership' && memberKey(reference.target) === key)
        const before = evidence.before.get(key)!, current = evidence.live.get(key)!
        if (!inverse || inverse.target.revision !== original.target.revision + 1) throw rejectedReceipt
        if (current.revision === original.target.revision) throw pendingReceipt
        if (current.revision !== inverse.target.revision || current.done !== before.done || current.snoozedUntil !== before.snoozedUntil) throw rejectedReceipt
        covered.add(key)
      } else if (original.kind === 'category' && proof.category) {
        if (!references.some(reference => reference.kind === 'category' && reference.id === original.id)) throw rejectedReceipt
        const command = categoryCommand(original.id), restored = command.receipt.entries.find(entry => entry.sourceId === proof.sourceId && entry.threadId === proof.threadId)
        const live = (await deps.attentionOverrides.lookup([{ sourceId: proof.sourceId, threadId: proof.threadId }])).entries[0]
        if (!command.receipt.retracted) { if (!live || live.revision !== proof.category.revision) throw rejectedReceipt; throw pendingReceipt }
        if (!restored || restored.revision <= proof.category.revision || digest(restored.override) !== digest(proof.category.before.override)) throw rejectedReceipt
        if (!live || live.revision !== restored.revision || digest(live.override) !== digest(restored.override)) throw rejectedReceipt
        for (const [key, before] of evidence.before) { if (!sameState(evidence.live.get(key)!, before)) throw rejectedReceipt; covered.add(key) }
        categoryRevision = restored.revision
      } else throw rejectedReceipt
    }
    if (covered.size !== proof.before.length) throw pendingReceipt
    return { states: [...evidence.live.values()], ...(categoryRevision !== undefined ? { categoryRevision } : {}) }
  }
  const receiptFailure = (error: unknown): 'pending' | 'rejected' => error === rejectedReceipt || error instanceof InboxError && error.status >= 400 && error.status < 500 ? 'rejected' : 'pending'

  async function requestedCounts(scope: Scope, query: QueryRow): Promise<DTO.InboxCountsResult> {
    let saved = readMetadata(query), count = saved.counts
    if (count?.complete && totals(scope, query).conversations !== null) return { state: state(scope, query), totals: count.totals }
    const empty = (): DTO.InboxTotals => ({ conversations: 0, messages: 0, inbox: 0, splits: Object.fromEntries(scope.preferences.splits.map(name => [name, 0])),
      folders: Object.fromEntries(['Inbox', 'Starred', 'Sent', 'Done', 'Auto Archived', 'Reminders', 'Spam', 'Trash', 'All Mail'].map(name => [name, 0])), holding: false })
    if (!count) {
      // SDK counts are exact for the cached receiving scope. App folder/category
      // conjunctions are not message predicates; do not mislabel matching-message
      // counts as whole-conversation message totals.
      const cached = scope.boxes.length ? await inbox.mailboxCounts(owner, { mailboxIds: scope.boxes.map(box => box.id) }) : null
      const read = observe(scope, cached?.asOfState ?? null, cached?.scopeState ?? scope.row.id, query)
      count = { baseline: read, totals: empty(), complete: !cached || cached.conversations === 0 }
    }
    const budget = readBudget(), view = json<DTO.InboxViewQuery>(query.data)
    while (!count.complete && budget.pages > 0) {
      const position = count.position ?? {}
      budget.pages--
      const page = await inbox.mailboxConversations(owner, { mailboxIds: scope.boxes.map(box => box.id), limit: 100, ...(position.cursor ? { cursor: position.cursor } : {}) })
      if (page.state !== count.baseline.sdkState || page.scopeState !== count.baseline.scopeState) {
        saved = readMetadata(query); delete saved.counts; saveReadMetadata(query, saved)
        return { state: state(scope, query), totals: unknownTotals(scope) }
      }
      const projected = await projectConversations(scope, page.items, budget)
      let consumed = 0, stopped = false
      for (const [index, row] of projected.entries()) {
        // Count the visible categories, including Unknown's conservative Important
        // placement. Incomplete AI evidence must not stall all inbox counters.
        let result: Awaited<ReturnType<typeof evaluateRow>>
        try { result = await evaluateRow(scope, view, row, budget, true) }
        catch (error) { if (error !== pendingContext) throw error; stopped = true; break }
        if (result.matches) { count.totals.conversations!++; count.totals.messages! += row.counts.messages! }
        count.totals.inbox! += result.counts.inbox ?? 0
        count.totals.holding ||= !!result.counts.holding
        for (const name of scope.preferences.splits) count.totals.splits[name]! += result.counts[`split:${name}`] ?? 0
        for (const name of Object.keys(count.totals.folders)) count.totals.folders[name]! += result.counts[`folder:${name}`] ?? 0
        const wake = Math.min(row.mail.reminderAt ?? Infinity, row.mail.aiHoldUntil ?? Infinity, importantExpiry(row.mail, budget.now))
        if (Number.isFinite(wake)) count.wake = Math.min(count.wake ?? Infinity, wake)
        count.position = { cursor: conversationCursor(page.items[index]!) }; count.progress = (count.progress ?? 0) + 1; consumed++
      }
      if (consumed === page.items.length && !page.nextCursor) { count.complete = true; delete count.position }
      if (stopped || projected.length < page.items.length) break
    }
    if (count.complete && count.baseline.sdkState) {
      const live = await inbox.mailboxChanges(owner, { mailboxIds: scope.boxes.map(box => box.id), since: count.baseline.sdkState, scopeState: count.baseline.scopeState, limit: 1 })
      if (live.resetRequired || live.state !== count.baseline.sdkState || count.baseline.ai !== (await deps.ai.state(owner)).cursor || count.baseline.category !== categoryHead() || count.wake && count.wake <= Date.now()) {
        saved = readMetadata(query); delete saved.counts; saveReadMetadata(query, saved)
        return { state: state(scope, query), totals: unknownTotals(scope) }
      }
    }
    saved = readMetadata(query); saved.counts = count; saveReadMetadata(query, saved)
    return { state: state(scope, query), totals: count.complete ? count.totals : unknownTotals(scope), progress: count.progress ?? 0 }
  }
  async function demandChanges(input: DTO.InboxChangesInput): Promise<DTO.InboxWindowChanges> {
    const maximum = limit(input.limit), resident = ids(input.residentKeys, 1000), pinned = ids(input.pinnedKeys, 100), since = integer(input.sinceRevision)
    const query = getQuery(text(input.queryId))
    if (!query || query.expires < Date.now()) fail('HOST_INBOX_QUERY_EXPIRED', 410)
    const scope = await resolve(json<DTO.InboxViewQuery>(query!.data).account)
    const resetReason = scope.row.id !== query!.scope ? 'scope' : scope.row.generation !== query!.generation ? 'history' : scope.preference !== query!.preference ? 'query' : null
    const reset = (reason: NonNullable<DTO.InboxWindowChanges['resetReason']>): DTO.InboxWindowChanges => ({ state: state(scope), upserts: [], newHead: [], removed: [], totals: unknownTotals(scope), nextCursor: null, throughRevision: scope.row.revision, resetReason: reason })
    if (resetReason) return reset(resetReason)
    let attested: ReadBaseline | undefined
    if (input.sinceCursor !== undefined) {
      try { attested = untoken<ReadBaseline>(input.sinceCursor, `read:${query!.id}`, scope) }
      catch { fail('HOST_INBOX_CURSOR_INVALID', 409) }
      if (!attested || typeof attested !== 'object' || Array.isArray(attested)
        || Object.keys(attested).some(key => !['sdkState', 'scopeState', 'revision', 'ai', 'category', 'at'].includes(key))
        || attested.sdkState !== null && (typeof attested.sdkState !== 'string' || !attested.sdkState.length)
        || typeof attested.scopeState !== 'string' || !attested.scopeState.length
        || ![attested.revision, attested.ai, attested.category, attested.at].every(value => Number.isSafeInteger(value) && value >= 0)
        || attested.revision !== since) fail('HOST_INBOX_CURSOR_INVALID', 409)
    }
    // Preserve the legacy three-part pass identity when no attestation is supplied.
    const wanted = [...new Set([...resident, ...pinned])], pinnedSet = new Set(pinned)
    const inputHash = digest(input.sinceCursor === undefined ? [since, resident, pinned] : [since, resident, pinned, input.sinceCursor])
    if (wanted.length > 1000) fail('HOST_INBOX_TOO_LARGE', 413)
    const cursor = input.cursor ? untoken<{ id: string; offset: number; stage: 'rows' | 'head' | 'next' }>(input.cursor, `changes:${query!.id}`, scope) : undefined
    let saved = readMetadata(query!), pass = cursor ? saved.changes : undefined
    if (cursor && (!pass || pass.id !== cursor.id || pass.input !== inputHash)) fail('HOST_INBOX_CURSOR_INVALID', 409)
    if (!pass || cursor?.stage === 'next') {
      // A signed old page can outlive the numeric cache, but never the underlying
      // SDK/AI/category history and scope checks performed below.
      const before = pass?.baseline ?? attested ?? baseline(scope, query!, since)
      if (!before) return reset('history')
      const delta = before.sdkState && scope.boxes.length ? await inbox.mailboxChanges(owner, { mailboxIds: scope.boxes.map(box => box.id), since: before.sdkState, scopeState: before.scopeState, limit: 100 }) : null
      if (delta?.resetRequired) return reset(delta.resetReason ?? 'history')
      const [ai, categories] = await Promise.all([
        before.ai !== scope.ai.cursor ? deps.ai.changes(owner, before.ai) : Promise.resolve({ decisions: [], removed: [], cursor: before.ai, hasMore: false, resetRequired: false }),
        before.category !== categoryHead() ? deps.attentionOverrides.changes(before.category) : Promise.resolve({ entries: [], cursor: before.category, hasMore: false, resetRequired: false }),
      ])
      const metadataChanged = !!delta?.events.some(event => ['label.updated', 'account.updated', 'mailbox.updated'].includes(event.type))
      if (metadataChanged) await refreshMetadata(scope, true)
      const due = (saved.wake ?? Infinity) <= Date.now()
      const affected = new Set([...(delta?.affectedThreads ?? []), ...ai.decisions, ...ai.removed, ...categories.entries].map(threadKey))
      const allResident = metadataChanged || due || ai.resetRequired || categories.resetRequired
      const keys = wanted.filter(id => { const key = ownedKey(scope, id); return allResident || !!key && affected.has(threadKey(key)) })
      const next = observe(scope, delta?.state ?? before.sdkState, before.scopeState, query!, { ai: ai.cursor, category: categories.cursor, at: Date.now() })
      pass = { id: crypto.randomUUID(), input: inputHash, baseline: next, keys,
        head: metadataChanged || due || !!delta?.events.length || !!ai.decisions.length || !!ai.removed.length || !!categories.entries.length || ai.resetRequired || categories.resetRequired,
        more: !!delta?.hasMore || ai.hasMore || categories.hasMore }
      saved = readMetadata(query!); saved.changes = pass; if (due) delete saved.wake; saveReadMetadata(query!, saved)
    }
    const budget = readBudget(), upserts: DTO.InboxWindowRow[] = [], removed: DTO.InboxWindowChanges['removed'] = [], newHead: DTO.InboxWindowRow[] = []
    const offset = cursor?.stage === 'rows' ? integer(cursor.offset) : 0
    if (offset > pass.keys.length) fail('HOST_INBOX_CURSOR_INVALID')
    const headStage = cursor?.stage === 'head', entries = headStage ? [] : pass.keys.slice(offset, offset + maximum)
    let consumed = 0, size = 65536
    for (const entry of await lookupRows(scope, entries, budget)) {
      if (entry.status === 'unknown') break
      if (entry.status === 'absent') removed.push({ key: entry.id, reason: 'deleted' })
      else {
        const matches = pinnedSet.has(entry.id) || (await evaluateRow(scope, json(query!.data), entry.row, budget)).matches
        if (!matches) removed.push({ key: entry.id, reason: 'not-matching' })
        else {
          const cost = bytes(entry.row)
          if (size + cost > DTO.INBOX_RESPONSE_BYTE_LIMIT) break
          entry.row.revision = pass.baseline.revision; upserts.push(entry.row); size += cost
        }
      }
      consumed++
    }
    if (!consumed && entries.length) throw pendingContext
    const nextOffset = offset + consumed
    if (headStage) {
      const view = json<DTO.InboxViewQuery>(query!.data), head = await preparePage(scope, query!, maximum, undefined, false, budget)
      for (const row of head.rows) {
        if (wanted.includes(row.key)) continue
        // preparePage records the hold's wake even when this unseen arrival is
        // withheld. A later bounded changes pass retries it without another event.
        if (!view.search && view.folder === 'Inbox' && (row.mail.aiHoldUntil ?? 0) > budget.now) continue
        const cost = bytes(row)
        if (size + cost > DTO.INBOX_RESPONSE_BYTE_LIMIT) break
        row.revision = pass.baseline.revision; newHead.push(row); size += cost
      }
    }
    const stage = !headStage && nextOffset < pass.keys.length ? 'rows' : !headStage && pass.head ? 'head' : pass.more ? 'next' : null
    if (!stage) { saved = readMetadata(query!); delete saved.changes; saveReadMetadata(query!, saved) }
    return { state: state(scope, query!, pass.baseline), upserts, newHead, removed, totals: totals(scope, query!),
      nextCursor: stage ? token(`changes:${query!.id}`, scope, { id: pass.id, offset: stage === 'rows' ? nextOffset : 0, stage }) : null,
      throughRevision: pass.baseline.revision, resetReason: null }
  }
  const transport: DTO.InboxWindowTransport = {
    async query(input) {
      const maximum = limit(input.limit), scope = await resolve(input.account)
      // Public openings own independent reconciliation passes; internal capture
      // preparation keeps the default reuse so explicit retries retain their work.
      const query = await newQuery(input, scope, false)
      return scopedRead(scope, () => preparePage(scope, query, maximum))
    },
    async page(input) {
      const maximum = limit(input.limit), { scope, query } = await queryScope(input.queryId)
      if (input.direction !== undefined && !['older', 'newer'].includes(input.direction) || input.seek !== undefined && !['start', 'end'].includes(input.seek)) fail('HOST_INBOX_INVALID')
      const cursor = !input.seek && input.cursor ? untoken<PageCursor>(input.cursor, `page:${query.id}`, scope) : undefined
      const reverse = input.seek ? input.seek === 'end' : input.direction === 'newer'
      return scopedRead(scope, () => preparePage(scope, query, maximum, cursor, reverse))
    },
    async counts(input) { const { scope, query } = await queryScope(input.queryId); return scopedRead(scope, () => requestedCounts(scope, query)) },
    async lookup(input) { const scope = await resolve(input.account), entries = await scopedRead(scope, () => lookupRows(scope, ids(input.ids), readBudget(), true)); return { state: state(scope), entries } },
    changes: demandChanges,
    async messages(input) {
      const maximum = limit(input.limit), scope = await resolve(input.account), budget = readBudget()
      budget.details-- // Reserve the requested detail page within the four-read cap.
      const entry = (await lookupRows(scope, [text(input.id)], budget, true))[0]!
      if (entry.status !== 'found') fail('HOST_INBOX_UNAVAILABLE', 503)
      const row = (entry as Extract<DTO.InboxLookupEntry, { status: 'found' }>).row, read = scope.read!
      const cursor = input.cursor ? untoken<{ context: string; cursor: string; state: string | null; preference: string }>(input.cursor, `messages:${row.key}`, scope) : undefined
      if (cursor && (cursor.context !== row.contextVersion || cursor.state !== read.sdkState || cursor.preference !== scope.preference)) fail('HOST_INBOX_CONTEXT_CHANGED', 409)
      const page = await inbox.mailboxMessagePage(owner, { mailboxIds: scope.boxes.map(box => box.id), sourceId: row.sourceId, threadId: row.threadId, limit: maximum, ...(cursor ? { cursor: cursor.cursor } : {}) })
      if (page.state !== read.sdkState || page.scopeState !== read.scopeState) fail('HOST_INBOX_CONTEXT_CHANGED', 409)
      const projected = project(scope, page.items).mail.find(mail => mail.account === scope.row.account)
      return { state: state(scope), key: row.key, contextVersion: row.contextVersion, summaries: page.items, messages: projected?.messages ?? [], total: row.counts.messages,
        nextCursor: page.nextCursor ? token(`messages:${row.key}`, scope, { context: row.contextVersion, cursor: page.nextCursor, state: read.sdkState, preference: scope.preference }) : null, exhausted: !page.nextCursor }
    },
    sender,
    async contacts(input) {
      const scope = await resolve(input.account), maximum = limit(input.limit)
      if (typeof input.query !== 'string' || input.query.length > 256) fail('HOST_INBOX_INVALID')
      if (!scope.boxes.length) { observe(scope, null, scope.row.id); return { state: state(scope), contacts: [], complete: true } }
      const found = await inbox.mailboxContacts(owner, { mailboxIds: scope.boxes.map(box => box.id), query: input.query, limit: maximum })
      observe(scope, found.state, found.scopeState)
      return { state: state(scope), contacts: found.items.map(value => ({ ...value, messageId: null, role: 'recipient' as const })), complete: true }
    },
    async selectionCreate(input) { return selection(await createCapture(input, 'selection')) },
    async selectionPage(input) {
      const maximum = limit(input.limit), { capture, scope, meta } = await checkedCapture(input.selectionId, 'selection')
      const after = input.cursor ? untoken<number>(input.cursor, `selection:${capture.id}`, scope) : 0
      const stored = db.query<{ key: string; context: string; ordinal: number; data: string }, (string | number)[]>('SELECT key,context,ordinal,data FROM local_window_capture_items WHERE owner=? AND capture=? AND ordinal>? ORDER BY ordinal LIMIT ?').all(owner, capture.id, after, maximum + 1)
      const budget = readBudget(), live = await lookupRows(scope, stored.slice(0, maximum).map(item => item.key), budget, true)
      const entries: DTO.InboxSelectionPage['entries'] = []; let size = 65536, last = after
      for (const item of stored.slice(0, maximum)) {
        if (budget.detailDeferred.has(item.key)) break
        const found = live.find(entry => entry.id === item.key)!
        const complete = found.status === 'found' && found.row.targetsComplete && budget.legacy.has(item.key) && json<ZeroItemData>(item.data).contextComplete
        const matches = found.status === 'found' && (found.row.contextVersion === item.context || (meta.contextVersion ?? 1) === 1 && budget.legacy.get(item.key) === item.context)
        const entry: DTO.InboxSelectionPage['entries'][number] = found.status !== 'found' ? found : !complete ? { id: item.key, status: 'unknown' } : !matches ? { id: item.key, status: 'changed' } : found
        if (size + bytes(entry) > DTO.INBOX_RESPONSE_BYTE_LIMIT) break
        entries.push(entry); size += bytes(entry); last = item.ordinal
      }
      if (!capture.complete) schedule(0)
      return { selection: selection(capture), entries, nextCursor: stored.length > entries.length || !capture.complete ? token(`selection:${capture.id}`, scope, last) : null,
        exhausted: !!capture.complete && stored.length <= entries.length }
    },
    async zeroCreate(input) { return zeroSession(await createCapture(input, 'zero')) },
    async zeroResume(input) {
      text(input.sessionId); text(input.account)
      const capture = captureRow(input.sessionId)
      if (!capture || capture.kind !== 'zero' || json<CaptureMeta>(capture.data).account !== input.account) return { status: 'absent' }
      try { await checkedCapture(input.sessionId, 'zero') } catch (error) { if (!(error instanceof InboxError) || error.code !== 'HOST_INBOX_SCOPE_CHANGED') throw error }
      if (!capture.complete) schedule(0)
      return { status: 'found', session: zeroSession(captureRow(input.sessionId)!) }
    },
    zeroPage(input) { return serialZero(async () => {
      const maximum = limit(input.limit), { capture, scope, meta } = await checkedCapture(input.sessionId, 'zero')
      const after = input.cursor ? untoken<number>(input.cursor, `zero:${capture.id}`, scope) : 0
      const stored = db.query<{ key: string; data: string; context: string; review: string; ordinal: number }, (string | number)[]>("SELECT key,data,context,review,ordinal FROM local_window_capture_items WHERE owner=? AND capture=? AND ordinal>? AND status='remaining' ORDER BY ordinal LIMIT ?").all(owner, capture.id, after, maximum + 1)
      const budget = readBudget(), live = await lookupRows(scope, stored.slice(0, maximum).map(item => item.key), budget, true)
      const deferred = stored.findIndex(value => budget.detailDeferred.has(value.key))
      const prefix = stored.slice(0, deferred < 0 ? maximum : Math.min(maximum, deferred))
      const batches = capture.complete ? await freshBatchCandidates(scope, capture, prefix) : new Map()
      const items = prefix.map(value => {
        const saved = json<ZeroItemData>(value.data), opaqueReview = value.review ? reviewToken(capture.id, value.review) : null
        const batch = batches.get(value.key)
        const item: DTO.InboxZeroItem = { ...saved.item, reviewVersion: opaqueReview, batchEligibility: batch ? 'eligible' : 'ineligible', batchCandidate: batch?.candidate ?? null }
        const currentRow = live.find(entry => entry.id === value.key)
        const matches = currentRow?.status === 'found' && (currentRow.row.contextVersion === value.context || (meta.contextVersion ?? 1) === 1 && budget.legacy.get(value.key) === value.context)
        const complete = currentRow?.status === 'found' && currentRow.row.targetsComplete && budget.legacy.has(value.key) && saved.contextComplete
        if (!matches || !complete) return { ...item, eligibility: 'unknown' as const, batchEligibility: 'unknown' as const, batchCandidate: null }
        if (batch) db.query("UPDATE local_window_capture_items SET data=json_set(data,'$.batchOffer',json(?)) WHERE owner=? AND capture=? AND key=?").run(JSON.stringify(batch.offer), owner, capture.id, value.key)
        return item
      })
      const last = prefix.at(-1)?.ordinal ?? after
      if (!capture.complete) schedule(0)
      return { session: zeroSession(capture), items, nextCursor: stored.length > items.length || !capture.complete ? token(`zero:${capture.id}`, scope, last) : null,
        exhausted: !!capture.complete && stored.length <= items.length && items.every(item => item.eligibility !== 'unknown') }
    }) },
    zeroProgress(input) { return serialZero(async () => {
      text(input.id, 128); integer(input.ifRevision)
      if (!Array.isArray(input.decisions) || input.decisions.length > 100 || new Set(input.decisions.map(value => value?.id)).size !== input.decisions.length) fail('HOST_INBOX_INVALID')
      const decisions = input.decisions.map(value => {
        if (!value || Object.keys(value).sort().join(',') !== 'decision,id,receipts,reviewVersion' || !['done', 'other', 'later'].includes(value.decision)) fail('HOST_INBOX_INVALID')
        return { id: text(value.id), decision: value.decision, reviewVersion: text(value.reviewVersion, 65536), receipts: receiptReferences(value.receipts) }
      })
      const { capture, meta, scope } = await checkedCapture(input.sessionId, 'zero'), fingerprint = digest(input)
      const prior = db.query<{ capture: string; input: string; data: string }, string[]>('SELECT capture,input,data FROM local_window_progress WHERE owner=? AND id=?').get(owner, input.id)
      let saved: ZeroProgressRecord
      if (prior) {
        if (prior.capture !== capture.id || prior.input !== fingerprint) fail('HOST_ZERO_SESSION_CONFLICT', 409)
        const value = json<ZeroProgressRecord | ZeroUndoRecord | DTO.InboxZeroProgressResult>(prior.data)
        if (!('kind' in value)) return value
        if (value.kind !== 'progress') fail('HOST_ZERO_SESSION_CONFLICT', 409)
        saved = value as ZeroProgressRecord
        if (!saved.result.results.some(result => result.status === 'pending')) return saved.result
      } else {
        if (capture.revision !== input.ifRevision || meta.session?.status === 'invalidated') fail('HOST_ZERO_SESSION_CONFLICT', 409)
        if (decisions.length && !capture.complete) fail('HOST_INBOX_UNAVAILABLE', 503)
        if (input.currentId !== undefined && input.currentId !== null && zeroItem(capture.id, text(input.currentId))?.status !== 'remaining') fail('HOST_INBOX_INVALID')
        if (input.phase !== undefined && !['batches', 'review'].includes(input.phase) || input.paused !== undefined && typeof input.paused !== 'boolean') fail('HOST_INBOX_INVALID')
        const reviewOnly = input.reviewOnlyIds === undefined ? [] : ids(input.reviewOnlyIds, 100)
        for (const id of reviewOnly) if (zeroItem(capture.id, id)?.status !== 'remaining') fail('HOST_INBOX_INVALID')
        const items = decisions.map(decision => zeroItem(capture.id, decision.id))
        if (items.reduce((sum, item) => sum + (item ? json<ZeroItemData>(item.data).targets.length : 0), 0) > 500) fail('HOST_INBOX_TOO_LARGE', 413)
        if (meta.session?.phase === 'batches' && items.some(item => item && (reviewOnly.includes(item.key) || json<ZeroItemData>(item.data).reviewOnly))) fail('HOST_INBOX_INVALID')
        if (meta.session?.phase === 'batches' && decisions.length > 1 && (decisions.length > 50 || items.some((item, index) => !item || decisions[index]!.decision !== 'other' || json<ZeroItemData>(item.data).batchOffer?.version !== decisions[index]!.reviewVersion))) fail('HOST_INBOX_INVALID')
        saved = { kind: 'progress', result: { session: zeroSession(capture), results: decisions.map(decision => ({ id: decision.id, status: 'pending' })), undo: null }, proofs: [] }
        db.transaction(() => {
          for (const id of reviewOnly) db.query("UPDATE local_window_capture_items SET data=json_set(data,'$.reviewOnly',json('true')) WHERE owner=? AND capture=? AND key=?").run(owner, capture.id, id)
          for (const [index, decision] of decisions.entries()) {
            const item = items[index]
            if (item?.status === 'remaining' && (reviewToken(capture.id, item.review) === decision.reviewVersion || json<ZeroItemData>(item.data).batchOffer?.version === decision.reviewVersion)) db.query("UPDATE local_window_capture_items SET data=json_set(data,'$.latestProgress',?) WHERE owner=? AND capture=? AND key=?").run(input.id, owner, capture.id, item.key)
          }
          if (input.currentId !== undefined) meta.session!.currentId = input.currentId
          if (input.phase !== undefined) meta.session!.phase = input.phase
          if (input.paused !== undefined) meta.session!.paused = input.paused
          db.query('UPDATE local_window_captures SET data=?,revision=revision+1 WHERE owner=? AND id=?').run(JSON.stringify(meta), owner, capture.id)
          saved.result.session = zeroSession(captureRow(capture.id)!)
          db.query('INSERT INTO local_window_progress VALUES (?,?,?,?,?)').run(owner, input.id, capture.id, fingerprint, JSON.stringify(saved))
        }).immediate()
        if (!decisions.length) return saved.result
      }
      const cache = verificationCache(), accepted: ZeroProof[] = []
      for (const decision of decisions) {
        const result = saved!.result.results.find(result => result.id === decision.id)!
        if (result.status !== 'pending') continue
        const item = zeroItem(capture.id, decision.id)
        if (!item || json<ZeroItemData>(item.data).latestProgress !== input.id) { result.status = 'rejected'; continue }
        try { const proof = await verifyZeroDecision(scope, capture, item, decision, input.id, cache); accepted.push(proof); result.status = 'accepted' }
        catch (error) { result.status = receiptFailure(error) }
      }
      const fresh = await checkedCapture(capture.id, 'zero')
      return db.transaction(() => {
        for (const proof of accepted) {
          const item = zeroItem(capture.id, proof.id), data = item ? json<ZeroItemData>(item.data) : null
          if (!item || !data || item.status !== 'remaining' || data.latestProgress !== input.id) { saved!.result.results.find(result => result.id === proof.id)!.status = 'rejected'; continue }
          for (const reference of proof.receipts) db.query('INSERT INTO local_window_zero_receipts VALUES (?,?,?,?,?)').run(owner, receiptKey(reference), `${proof.sourceId}\0${proof.threadId}`, input.id, proof.context)
          data.credit = input.id
          db.query("UPDATE local_window_capture_items SET status='decided',data=? WHERE owner=? AND capture=? AND key=?").run(JSON.stringify(data), owner, capture.id, proof.id)
          saved!.proofs.push(proof)
        }
        if (fresh.meta.session!.currentId && zeroItem(capture.id, fresh.meta.session!.currentId)?.status !== 'remaining') fresh.meta.session!.currentId = null
        db.query('UPDATE local_window_captures SET data=?,revision=revision+1 WHERE owner=? AND id=?').run(JSON.stringify(fresh.meta), owner, capture.id)
        saved!.result = { session: zeroSession(captureRow(capture.id)!), results: saved!.result.results, undo: saved!.proofs.some(proof => !proof.undoneBy) ? { sessionId: capture.id, progressId: input.id } : null }
        db.query('UPDATE local_window_progress SET data=? WHERE owner=? AND id=?').run(JSON.stringify(saved), owner, input.id)
        return saved!.result
      }).immediate()
    }) },
    zeroUndo(input) { return serialZero(async () => {
      text(input.id, 128)
      if (!input.reference || Object.keys(input.reference).sort().join(',') !== 'progressId,sessionId') fail('HOST_INBOX_INVALID')
      text(input.reference.progressId, 128)
      const references = receiptReferences(input.receipts), { capture, scope } = await checkedCapture(input.reference.sessionId, 'zero'), fingerprint = digest(input)
      const prior = db.query<{ capture: string; input: string; data: string }, string[]>('SELECT capture,input,data FROM local_window_progress WHERE owner=? AND id=?').get(owner, input.id)
      if (prior) {
        if (prior.capture !== capture.id || prior.input !== fingerprint) fail('HOST_ZERO_SESSION_CONFLICT', 409)
        const saved = json<ZeroUndoRecord>(prior.data)
        if (saved.kind !== 'undo') fail('HOST_ZERO_SESSION_CONFLICT', 409)
        if (saved.result.status !== 'pending') return saved.result
      }
      const original = db.query<{ data: string }, string[]>('SELECT data FROM local_window_progress WHERE owner=? AND id=? AND capture=?').get(owner, input.reference.progressId, capture.id)
      if (!original) fail('HOST_ZERO_SESSION_CONFLICT', 409)
      const progress = json<ZeroProgressRecord>(original!.data)
      if (progress.kind !== 'progress') fail('HOST_ZERO_SESSION_CONFLICT', 409)
      const cache = verificationCache(), restored: Array<{ proof: ZeroProof; states: MailboxMembership[]; categoryRevision?: number }> = []
      const outcomes: Array<'accepted' | 'pending' | 'rejected'> = []
      for (const proof of progress.proofs) {
        if (proof.undoneBy) { outcomes.push(proof.undoneBy === input.id ? 'accepted' : 'rejected'); continue }
        const item = zeroItem(capture.id, proof.id)
        if (!item || item.status !== 'decided' || json<ZeroItemData>(item.data).credit !== input.reference.progressId) { outcomes.push('rejected'); continue }
        try { const inverse = await verifyZeroUndo(scope, item, proof, references, cache); restored.push({ proof, ...inverse }); outcomes.push('accepted') }
        catch (error) { outcomes.push(receiptFailure(error)) }
      }
      await checkedCapture(capture.id, 'zero')
      return db.transaction(() => {
        for (const { proof, states, categoryRevision } of restored) {
          const item = zeroItem(capture.id, proof.id)!, saved = json<ZeroItemData>(item.data)
          if (item.status !== 'decided' || saved.credit !== input.reference.progressId) fail('HOST_ZERO_SESSION_CONFLICT', 409)
          // Only revision references advance after a verified inverse; frozen IDs,
          // message/content versions and pre-decision local values never recapture.
          saved.targets = saved.targets.map(target => ({ ...target, revision: states.find(state => memberKey(state) === memberKey(target))!.revision }))
          if (categoryRevision !== undefined) saved.categoryRevision = categoryRevision
          delete saved.credit; saved.latestProgress = `undo:${input.id}`; proof.undoneBy = input.id
          let context = item.context
          if (saved.contextEvidence) {
            const evidence = json<unknown[]>(saved.contextEvidence)
            if (!['conversation-context-2', 'conversation-context-3'].includes(String(evidence[0])) || evidence.length !== 16 || !Array.isArray(evidence[12])
              || !Array.isArray(evidence[13]) || evidence[13].length !== saved.targets.length || digest(evidence) !== item.context) fail('HOST_INBOX_CONTEXT_CHANGED', 409)
            // Keep either frozen format intact. Only the inverse's proven captured
            // revision references advance; no current inventory, new IDs or replies.
            evidence[13] = (evidence[13] as unknown[][]).map(target => {
              if (!Array.isArray(target) || target.length !== 4) fail('HOST_INBOX_CONTEXT_CHANGED', 409)
              const state = states.find(state => state.mailboxId === target[0] && state.messageId === target[1])
              if (!state) fail('HOST_INBOX_CONTEXT_CHANGED', 409)
              return [target[0], target[1], state!.revision, target[3]]
            })
            saved.contextEvidence = JSON.stringify(evidence); context = digest(evidence)
          }
          db.query("UPDATE local_window_capture_items SET status='remaining',data=?,context=? WHERE owner=? AND capture=? AND key=?").run(JSON.stringify(saved), context, owner, capture.id, proof.id)
        }
        if (restored.length) db.query('UPDATE local_window_captures SET revision=revision+1 WHERE owner=? AND id=?').run(owner, capture.id)
        const result: DTO.InboxZeroUndoResult = { session: zeroSession(captureRow(capture.id)!), status: outcomes.includes('pending') ? 'pending' : !outcomes.length || outcomes.includes('rejected') ? 'rejected' : 'accepted' }
        db.query('UPDATE local_window_progress SET data=? WHERE owner=? AND id=?').run(JSON.stringify(progress), owner, input.reference.progressId)
        const saved: ZeroUndoRecord = { kind: 'undo', result }
        db.query('INSERT INTO local_window_progress VALUES (?,?,?,?,?) ON CONFLICT(owner,id) DO UPDATE SET data=excluded.data').run(owner, input.id, capture.id, fingerprint, JSON.stringify(saved))
        return result
      }).immediate()
    }) },
  }
  return {
    async dispatch(path: string, input: Record<string, unknown>): Promise<unknown> {
      const name = (Object.keys(DTO.inboxWindowPaths) as Array<keyof DTO.InboxWindowTransport>).find(key => DTO.inboxWindowPaths[key] === path)
      if (!name) fail('HOST_INBOX_INVALID', 404)
      const fields: Record<keyof DTO.InboxWindowTransport, string[]> = {
        query: ['account', 'folder', 'split', 'search', 'query', 'filter', 'limit'], page: ['queryId', 'cursor', 'limit', 'direction', 'seek'], counts: ['queryId'],
        lookup: ['account', 'ids'], changes: ['queryId', 'sinceRevision', 'sinceCursor', 'residentKeys', 'pinnedKeys', 'cursor', 'limit'], messages: ['account', 'id', 'cursor', 'limit'],
        sender: ['account', 'id', 'selectedMessageId', 'domain'], contacts: ['account', 'query', 'limit'], selectionCreate: ['id', 'account', 'queryId', 'allMatching', 'ids'], selectionPage: ['selectionId', 'cursor', 'limit'],
        zeroCreate: ['id', 'account'], zeroResume: ['sessionId', 'account'], zeroPage: ['sessionId', 'cursor', 'limit'], zeroProgress: ['sessionId', 'id', 'ifRevision', 'decisions', 'currentId', 'reviewOnlyIds', 'phase', 'paused'], zeroUndo: ['id', 'reference', 'receipts'],
      }
      if (Object.keys(input).some(key => !fields[name!].includes(key))) fail('HOST_INBOX_INVALID')
      const uses = new Set<Scope>(), started = Date.now()
      return requests.run(uses, async () => {
        activeRequests++
        try {
          const result = await (transport[name!] as (input: never) => Promise<unknown>)(input as never)
          if (bytes(result) > DTO.INBOX_RESPONSE_BYTE_LIMIT) fail('HOST_INBOX_TOO_LARGE', 413)
          const queryId = typeof input.queryId === 'string' ? input.queryId : (result as { state?: DTO.InboxWindowState })?.state?.queryId
          const query = queryId ? getQuery(queryId) : null
          // Renew only a successfully used, still-valid derived view; never auth/session TTLs.
          if (query && query.expires >= started && !query.problem && [...uses].some(scope => scope.row.id === query.scope && scope.row.generation === query.generation && scope.preference === query.preference)) {
            db.query('UPDATE local_window_queries SET expires=? WHERE owner=? AND id=?').run(Date.now() + QUERY_TTL, owner, query.id)
          }
          return result
        } finally { for (const scope of uses) scope.users--; activeRequests-- }
      })
    },
    async close() { closed = true; unwatch(); clearTimeout(timer); await Promise.all([working, zeroWrites, projectionWork]); scopes.clear() },
  }
}
