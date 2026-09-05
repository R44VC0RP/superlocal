import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Database } from 'bun:sqlite'
import { InboxError, type Inbox, type Account, type Mailbox, type Label, type Folder, type MailboxMessageSummary, type MailboxMembership, type MailboxStateReceipt, type MailboxStateTarget, type MailboxConversation } from 'inbox-sdk'
import type { CategoryContext, CategoryEntry, CategoryReceipt } from '../../shared/attention-overrides'
import * as DTO from '../../shared/inbox-window'
import { projectMailboxMail } from '../../shared/mail-projection'
import { classifyAttention, conversationAttention } from '../../shared/mail-attention'
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
  HOST_INBOX_UNAVAILABLE: 'The inbox index or required receipt is not available yet.', HOST_ZERO_SESSION_CONFLICT: 'The cleanup session changed. Resume it before continuing.',
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
type Scope = { row: ScopeRow; boxes: Mailbox[]; sources: Account[]; labels: Label[]; folders: Map<string, Folder[]>; preference: string; preferences: Preferences; ai: AiTriageState; users: number; lastUsed: number; metadataAt: number; metadataDirty: boolean; seenEvents: number }
type Prefix = { cursor: string | null; exhausted: number; indexed: number }
type ProjectionStamp = { preference?: string; metadata?: string; aiCursor?: number; categoryCursor?: number }
type QueryRow = { id: string; scope: string; data: string; preference: string; scanned: number; generation: number; expires: number; problem: string | null }
type StoredRow = { key: string; source: string; thread: string; data: string; at: number; revision: number; context: string }
type CaptureRow = { id: string; kind: string; scope: string; data: string; input: string; cursor: number; complete: number; revision: number }
type Aggregate = { count: number; unread: number; starred: number; trash: number; spam: number; archive: number; sent: number; awake: number; important: number; memberships: number; done: number; snoozed: number; reminder: string | null; attachments: number }

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
  let closed = false, timer: ReturnType<typeof setTimeout> | undefined, working: Promise<void> | undefined
  let activeRequests = 0, aiCursor: number | undefined, categoryCursor: number | undefined, watched = false
  let workingScope: Scope | undefined, watchedVersion = 0, projectionWork: Promise<void> | undefined
  const requests = new AsyncLocalStorage<Set<Scope>>()
  const scopes = new Map<string, Scope>()
  const pendingContext = new InboxError('HOST_INBOX_UNAVAILABLE', 'Conversation context is still preparing.', 503)
  const unwatch = inbox.subscribe(owner, () => { watched = true; watchedVersion++; for (const scope of scopes.values()) scope.metadataDirty = true; schedule(0) })
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
    if (prior?.metadata !== hash) { invalidateProjection(scope); stamp(scope, { metadata: hash }) }
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
    const preference = digest(['bounded-window-2', preferences.revision, split, ai.configured, ai.settings])
    aiCursor ??= ai.cursor
    const categoryHead = db.query<{ head: number }, string[]>('SELECT head FROM local_category_clock WHERE owner=?').get(owner)?.head ?? 0
    categoryCursor ??= categoryHead
    let scope = scopes.get(id)
    if (!scope) {
      if (scopes.size >= MAX_ACTIVE) {
        const oldest = [...scopes.values()].filter(value => !value.users && value !== workingScope).sort((a, b) => a.lastUsed - b.lastUsed)[0]
        if (!oldest) fail('HOST_INBOX_UNAVAILABLE', 429)
        // Eviction removes metadata memory only. Indexes and frozen/paused queues stay durable.
        scopes.delete(oldest!.row.id)
      }
      db.query('INSERT OR IGNORE INTO local_window_scopes(owner,id,account,data) VALUES (?,?,?,?)').run(owner, id, account, JSON.stringify(identity))
      scope = { row: getScopeRow(id), boxes, sources: selectedSources, labels: [], folders: new Map(), preference, preferences: split as unknown as Preferences, ai, users: 0, lastUsed: Date.now(), metadataAt: 0, metadataDirty: true, seenEvents: -1 }
      scopes.set(id, scope)
      const saved = json<{ projection?: ProjectionStamp }>(scope.row.data).projection
      if (saved?.preference !== preference || saved.aiCursor !== ai.cursor || saved.categoryCursor !== categoryCursor) invalidateProjection(scope)
      stamp(scope, { preference, aiCursor: ai.cursor, categoryCursor })
      if (!boxes.length) db.query('UPDATE local_window_scopes SET raw_complete=1,checked=? WHERE owner=? AND id=?').run(Date.now(), owner, id)
    }
    const uses = requests.getStore()
    if (uses && !uses.has(scope)) { uses.add(scope); scope.users++ }
    scope.lastUsed = Date.now()
    if (scope.preference !== preference) { scope.preference = preference; invalidateProjection(scope); stamp(scope, { preference }) }
    scope.boxes = boxes; scope.sources = selectedSources; scope.ai = ai; scope.preferences = split as unknown as Preferences
    if (ai.cursor !== aiCursor || categoryHead !== categoryCursor) await updateSavedProjections()
    await refreshMetadata(scope)
    refresh(scope); schedule(0)
    return scope
  }
  function project(scope: Scope, summaries: MailboxMessageSummary[]) {
    return projectMailboxMail({ sources: scope.sources, mailboxes: scope.boxes, summaries, labels: scope.labels, folders: scope.folders,
      includedMailboxIds: scope.boxes.map(box => box.id), allowProviderWrites: deps.allowProviderWrites, now: Date.now(), displayTime })
  }
  function storeMessages(scope: Scope, messages: MailboxMessageSummary[]) {
    const put = db.query('INSERT INTO local_window_messages VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(owner,scope,source,id) DO UPDATE SET thread=excluded.thread,at=excluded.at,folder=excluded.folder,attention=excluded.attention,data=excluded.data')
    const contact = db.query('INSERT OR REPLACE INTO local_window_contacts VALUES (?,?,?,?,?,?,?,?,?,?)')
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
        db.query('DELETE FROM local_window_contacts WHERE owner=? AND scope=? AND source=? AND message=?').run(owner, scope.row.id, message.sourceId, message.id)
        const outgoing = message.folder === 'sent', people = outgoing ? [...message.to, ...message.cc] : [message.from]
        for (const person of people) contact.run(owner, scope.row.id, message.sourceId, message.id, message.threadId, person.email.trim().toLowerCase(), person.name, outgoing ? 'sent' : 'received', Date.parse(message.receivedAt), message.folder)
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
  function aggregate(scope: Scope, source: string, thread: string): Aggregate {
    const now = new Date().toISOString()
    const result = db.query<Aggregate, string[]>(`SELECT COUNT(*) count,COALESCE(SUM(json_extract(data,'$.isRead')=0),0) unread,COALESCE(MAX(json_extract(data,'$.isStarred')),0) starred,
      COALESCE(SUM(folder='trash'),0) trash,COALESCE(SUM(folder='spam'),0) spam,COALESCE(SUM(folder='archive'),0) archive,COALESCE(SUM(folder='sent'),0) sent,
      COALESCE(SUM(folder='inbox' AND EXISTS(SELECT 1 FROM json_each(data,'$.memberships') j WHERE json_extract(j.value,'$.done')=0 AND (json_extract(j.value,'$.snoozedUntil') IS NULL OR json_extract(j.value,'$.snoozedUntil')<=?))),0) awake,
      COALESCE(SUM(folder='inbox' AND attention='Important' AND EXISTS(SELECT 1 FROM json_each(data,'$.memberships') j WHERE json_extract(j.value,'$.done')=0 AND (json_extract(j.value,'$.snoozedUntil') IS NULL OR json_extract(j.value,'$.snoozedUntil')<=?))),0) important,
      COALESCE(SUM(json_array_length(data,'$.memberships')),0) memberships,COALESCE(SUM((SELECT COUNT(*) FROM json_each(data,'$.memberships') j WHERE json_extract(j.value,'$.done')=1)),0) done,
      COALESCE(SUM((SELECT COUNT(*) FROM json_each(data,'$.memberships') j WHERE json_extract(j.value,'$.snoozedUntil')>?)),0) snoozed,
      MIN((SELECT MIN(json_extract(j.value,'$.snoozedUntil')) FROM json_each(data,'$.memberships') j WHERE json_extract(j.value,'$.snoozedUntil')>?)) reminder,
      COALESCE(MAX(json_extract(data,'$.hasAttachments')),0) attachments FROM local_window_messages WHERE owner=? AND scope=? AND source=? AND thread=?`).get(now, now, now, now, owner, scope.row.id, source, thread)!
    return result
  }
  async function contextFingerprint(scope: Scope, source: string, thread: string) {
    const hash = createHash('sha256').update(scope.row.id)
    let after = ''
    while (!closed) {
      let count = 0
      const statement = db.query<{ id: string; context: string }, string[]>(`SELECT id,json_object('id',id,'body',COALESCE(json_extract(data,'$.bodyRevision'),json_extract(data,'$.revision')),'folder',folder,'memberships',(SELECT json_group_array(json_array(json_extract(j.value,'$.mailboxId'),json_extract(j.value,'$.done'),json_extract(j.value,'$.snoozedUntil'))) FROM json_each(data,'$.memberships') j)) context FROM local_window_messages INDEXED BY local_window_message_thread WHERE owner=? AND scope=? AND source=? AND thread=? AND id>? ORDER BY id LIMIT 500`)
      for (const item of statement.iterate(owner, scope.row.id, source, thread, after)) { hash.update(item.context).update('\n'); after = item.id; count++ }
      if (count < 500) break
      await wait()
    }
    return hash.digest('hex')
  }
  async function buildRows(scope: Scope, inputKeys: DTO.InboxThreadKey[], live?: ReadonlyMap<string, MailboxConversation>) {
    const keys = inputKeys.map(({ sourceId, threadId }) => ({ sourceId, threadId }))
    if (!keys.length) return
    const [categories, assessments] = await Promise.all([deps.attentionOverrides.lookup(keys), deps.ai.lookup(owner, keys)])
    if (captureLocked(scope)) return
    const decisions = new Map<string, AiDecision>(assessments.decisions.map(value => [`${value.sourceId}\0${value.threadId}`, value]))
    const choices = new Map(categories.entries.map(value => [`${value.sourceId}\0${value.threadId}`, value]))
    for (const key of keys) {
      const sdk = live?.get(`${key.sourceId}\0${key.threadId}`)
      const values = sdk && !sdk.messagesComplete ? sdk.messages : summaries(scope, key.sourceId, key.threadId, 500)
      const partial = !!sdk && !sdk.messagesComplete
      const roles = sdk?.nativeFolders
      const totals: Aggregate = partial ? {
        count: sdk.messageCount, memberships: sdk.membershipCount, done: sdk.doneMembershipCount, unread: Number(!sdk.isRead), starred: Number(sdk.isStarred), attachments: Number(sdk.hasAttachments),
        awake: sdk.awakeInboxMessageCount, important: 0, reminder: sdk.earliestSnoozedUntil, snoozed: Number(!!sdk.earliestSnoozedUntil),
        trash: roles!.trash && !roles!.inbox && !roles!.archive && !roles!.sent && !roles!.spam && !roles!.drafts ? sdk.messageCount : 0,
        spam: roles!.spam && !roles!.inbox && !roles!.archive && !roles!.sent && !roles!.trash && !roles!.drafts ? sdk.messageCount : 0,
        archive: Number(roles!.archive), sent: Number(roles!.sent),
      } : aggregate(scope, key.sourceId, key.threadId)
      if (!totals.count) {
        const prior = db.query<{ key: string }, string[]>('SELECT key FROM local_window_rows WHERE owner=? AND scope=? AND source=? AND thread=?').get(owner, scope.row.id, key.sourceId, key.threadId)
        if (prior) {
          db.query('DELETE FROM local_window_rows WHERE owner=? AND scope=? AND key=?').run(owner, scope.row.id, prior.key)
          db.query('DELETE FROM local_window_matches WHERE owner=? AND key=? AND query_id IN (SELECT id FROM local_window_queries WHERE owner=? AND scope=?)').run(owner, prior.key, owner, scope.row.id)
          db.query('DELETE FROM local_window_counts WHERE owner=? AND key=? AND query_id IN (SELECT id FROM local_window_queries WHERE owner=? AND scope=?)').run(owner, prior.key, owner, scope.row.id)
          db.query('DELETE FROM local_window_query_pending WHERE owner=? AND key=? AND query_id IN (SELECT id FROM local_window_queries WHERE owner=? AND scope=?)').run(owner, prior.key, owner, scope.row.id)
          bump(scope)
        }
        db.query('DELETE FROM local_window_dirty WHERE owner=? AND scope=? AND source=? AND thread=?').run(owner, scope.row.id, key.sourceId, key.threadId); continue
      }
      if (!values.length) fail('HOST_INBOX_TOO_LARGE', 413)
      const projected = project(scope, values), mail = projected.mail.find(mail => mail.account === scope.row.account)!
      if (!mail) fail('HOST_INBOX_SCOPE_CHANGED', 409)
      mail.hasAttachments = !!totals.attachments
      const full = !partial && values.length === totals.count
      if (!full) {
        const first = db.query<{ data: string }, string[]>('SELECT data FROM local_window_messages WHERE owner=? AND scope=? AND source=? AND thread=? ORDER BY at,id LIMIT 1').get(owner, scope.row.id, key.sourceId, key.threadId)!
        mail.subject = sdk?.subject ?? json<MailboxMessageSummary>(first.data).subject
        const hidden = totals.trash === totals.count ? 'Trash' : totals.spam === totals.count ? 'Spam' : undefined
        const locations = hidden ? [hidden] : [totals.awake ? 'Inbox' : '', totals.sent ? 'Sent' : '', totals.done === totals.memberships ? 'Done' : '', totals.snoozed ? 'Reminders' : '', (partial ? roles!.archive && !roles!.inbox && !roles!.trash && !roles!.spam && !roles!.drafts : totals.archive && totals.archive + totals.sent === totals.count) ? 'Auto Archived' : ''].filter(Boolean)
        mail.locations = locations; mail.folder = hidden ?? (locations.includes('Inbox') ? 'Inbox' : locations.includes('Done') ? 'Done' : locations.includes('Reminders') ? 'Reminders' : locations[0] ?? 'Auto Archived')
        mail.unread = totals.unread > 0; mail.starred = !!totals.starred; mail.reminder = totals.reminder ?? undefined; mail.reminderAt = totals.reminder ? Date.parse(totals.reminder) : undefined
        // Full indexed history supplies labels. A prefix-only giant remains explicitly unresolved.
        if (!partial) {
          const labelIds = db.query<{ id: string }, string[]>(`SELECT DISTINCT j.value id FROM local_window_messages m,json_each(m.data,'$.labelIds') j WHERE m.owner=? AND m.scope=? AND m.source=? AND m.thread=? LIMIT 5001`).all(owner, scope.row.id, key.sourceId, key.threadId)
          const folderIds = db.query<{ id: string }, string[]>(`SELECT DISTINCT j.value id FROM local_window_messages m,json_each(m.data,'$.folderIds') j WHERE m.owner=? AND m.scope=? AND m.source=? AND m.thread=? LIMIT 5001`).all(owner, scope.row.id, key.sourceId, key.threadId)
          if (labelIds.length > 5000 || folderIds.length > 5000) fail('HOST_INBOX_TOO_LARGE', 413)
          const wantedLabels = new Set(labelIds.map(value => value.id)), wantedFolders = new Set(folderIds.map(value => value.id))
          mail.labels = [...new Set([...scope.labels.filter(label => label.accountId === key.sourceId && wantedLabels.has(label.id)).map(label => label.name), ...(scope.folders.get(key.sourceId) ?? []).filter(folder => folder.kind === 'label' && wantedFolders.has(folder.id)).map(folder => folder.name)])]
        }
      }
      const identity = `${key.sourceId}\0${key.threadId}`, choice = choices.get(identity)
      if (scope.sources.find(source => source.id === key.sourceId)?.status === 'connected' && full && currentCategoryOverride(mail, choice?.override)) mail.attentionOverride = choice
      if (scope.ai.configured && scope.ai.settings.enabled) {
        let decision = currentAiDecision(mail, decisions.get(identity), scope.ai.settings.model)
        if (decision?.state === 'ready' && decision.contextVersions.some(context => {
          const message = values.find(value => value.id === context.messageId)
          const saved = message || partial ? undefined : db.query<{ data: string }, string[]>('SELECT data FROM local_window_messages WHERE owner=? AND scope=? AND source=? AND id=?').get(owner, scope.row.id, key.sourceId, context.messageId)
          const actual = message ?? (saved ? json<MailboxMessageSummary>(saved.data) : undefined)
          return !actual || context.bodyRevision === null || actual.bodyRevision !== context.bodyRevision
        })) decision = { ...decision, state: 'stale', score: null, override: null }
        if (decision) { mail.triage = decision; if (scope.ai.settings.mode === 'apply' && decision.state === 'ready' && decision.score) mail.attentionCategory = decision.score.category }
        if (scope.ai.settings.mode === 'apply' && decision?.state !== 'ready' && decision?.holdUntil && Date.parse(decision.holdUntil) > Date.now()) mail.aiHoldUntil = Date.parse(decision.holdUntil)
      }
      if (mail.attentionOverride?.override) mail.aiHoldUntil = undefined
      // Unknown is an explicit provisional row, not an inferred Important/Other decision.
      mail.split = full ? conversationAttention(mail) : partial ? 'Unknown'
        : !totals.awake ? 'Important' : mail.attentionCategory ?? (totals.important ? 'Important' : 'Other')
      const targets = sdk?.targets ?? values.flatMap(value => value.memberships.map(state => ({ mailboxId: state.mailboxId, messageId: value.id, revision: state.revision, messageRevision: value.revision }))).slice(0, 500)
      // Partial contexts never authorize whole-conversation actions or pretend to contain all content.
      const context = partial ? digest([scope.row.id, sdk.subject, sdk.firstMessageId, sdk.messageCount, sdk.membershipCount, sdk.doneMembershipCount, sdk.earliestSnoozedUntil,
        values.map(value => [value.id, value.bodyRevision ?? value.revision, value.folder, value.memberships.map(state => [state.mailboxId, state.done, state.snoozedUntil])])]) : await contextFingerprint(scope, key.sourceId, key.threadId)
      const preview = values.slice(0, 50), previewIds = new Set(preview.map(value => value.id))
      const row: DTO.InboxWindowRow = { ...key, key: mail.id, sourceGeneration: mail.sourceGeneration!, revision: scope.row.revision + 1,
        mail: { ...mail, messages: mail.messages.filter(message => previewIds.has(message.id)) }, summaries: preview, messagesComplete: preview.length === totals.count,
        counts: { messages: totals.count, memberships: totals.memberships, unread: partial ? null : totals.unread, done: totals.done, snoozed: partial ? null : totals.snoozed },
        targets, targetsComplete: (sdk ? sdk.targetsComplete : full) && targets.length === totals.memberships, actionContextComplete: full && targets.length === totals.memberships && preview.length === totals.count, contextVersion: context }
      while (bytes(row) > 512 * 1024 && row.summaries.length > 1) {
        const removed = row.summaries.pop()!; row.mail.messages = row.mail.messages.filter(message => message.id !== removed.id); row.messagesComplete = false; row.actionContextComplete = false
      }
      if (bytes(row) > DTO.INBOX_RESPONSE_BYTE_LIMIT - 65536) fail('HOST_INBOX_TOO_LARGE', 413)
      const previous = record(scope, row.key)
      if (!previous || digest({ ...json<DTO.InboxWindowRow>(previous.data), revision: 0 }) !== digest({ ...row, revision: 0 })) {
        row.revision = bump(scope)
        db.query('INSERT INTO local_window_rows VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner,scope,key) DO UPDATE SET at=excluded.at,revision=excluded.revision,context=excluded.context,data=excluded.data,wake=excluded.wake').run(owner, scope.row.id, row.key, key.sourceId, key.threadId, mail.receivedAt ?? 0, row.revision, context, JSON.stringify(row), Math.min(mail.reminderAt ?? Infinity, mail.aiHoldUntil ?? Infinity) === Infinity ? null : Math.min(mail.reminderAt ?? Infinity, mail.aiHoldUntil ?? Infinity))
      }
      db.query('DELETE FROM local_window_dirty WHERE owner=? AND scope=? AND source=? AND thread=?').run(owner, scope.row.id, key.sourceId, key.threadId)
    }
  }

  function state(scope: Scope, query?: QueryRow): DTO.InboxWindowState {
    const ready = current(scope) && (!query || query.scanned >= scope.row.revision && !queryPending(query))
    return { queryId: query?.id ?? `scope:${scope.row.id}`, queryGeneration: query?.generation ?? scope.row.generation,
      indexRevision: query ? Math.min(query.scanned, scope.row.revision) : scope.row.revision, scopeState: scope.row.sdk_scope || scope.row.id, preferenceRevision: scope.preference,
      sources: scope.sources.map(source => ({ sourceId: source.id, generation: source.generation })), sdkState: scope.row.sdk_state,
      indexing: !ready, catchup: scope.row.reset || query?.problem ? 'blocked' : ready ? 'current' : scope.row.raw_complete ? 'catching-up' : 'pending' }
  }
  function unknownTotals(scope: Scope): DTO.InboxTotals {
    return { conversations: null, messages: null, inbox: null, splits: Object.fromEntries(scope.preferences.splits.map(name => [name, null])), folders: {}, holding: null }
  }
  function totals(scope: Scope, query: QueryRow): DTO.InboxTotals {
    if (!current(scope) || query.scanned < scope.row.revision || query.problem || queryPending(query)) return unknownTotals(scope)
    const match = db.query<{ conversations: number; messages: number }, string[]>('SELECT COUNT(*) conversations,COALESCE(SUM(messages),0) messages FROM local_window_matches WHERE owner=? AND query_id=?').get(owner, query.id)!
    const sums = db.query<{ name: string; count: number }, string[]>(`SELECT j.key name,SUM(j.value) count FROM local_window_counts c,json_each(c.data) j WHERE c.owner=? AND c.query_id=? GROUP BY j.key LIMIT 1000`).all(owner, query.id)
    const map = new Map(sums.map(item => [item.name, item.count]))
    return { ...match, inbox: map.get('inbox') ?? 0, splits: Object.fromEntries(scope.preferences.splits.map(name => [name, map.get(`split:${name}`) ?? 0])),
      folders: Object.fromEntries(sums.filter(item => item.name.startsWith('folder:')).map(item => [item.name.slice(7), item.count])), holding: !!map.get('holding') }
  }
  const parsedSearch = new Map<string, ReturnType<typeof parseSearch>>()
  const searchTerms = new Map<string, ReturnType<typeof compileSearch>>()
  async function expression(scope: Scope, row: DTO.InboxWindowRow, query: string, bodies: boolean): Promise<boolean> {
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
      const matches = searchTerms.get(term)!
      let yes = term === 'has:attachment' ? !!row.mail.hasAttachments : matches(row.mail)
      if (!yes && row.counts.unread === null && (/^(?:from:|to:|label:)/.test(term) || !bodies && !term.includes(':'))) return null
      // Per-term OR over bounded message chunks preserves Boolean conversation semantics.
      if (!yes && !row.messagesComplete && /^(?:from:|to:|has:|[^:]+$)/.test(term)) {
        let after: [string, string] | undefined
        do {
          const values = summaries(scope, row.sourceId, row.threadId, 500, after)
          if (!values.length) break
          const mail = project(scope, values).mail.find(mail => mail.account === scope.row.account)!
          if (matches({ ...row.mail, messages: mail.messages })) { yes = true; break }
          const last = values.at(-1)!; after = [last.receivedAt, last.id]
          await wait()
        } while (!closed)
      }
      if (!yes && bodies && term.includes(':') && !/^(?:from|to|subject|in|label|is|has|before|after|older_than|newer_than):/.test(term)) fail('HOST_INBOX_INVALID')
      if (!yes && bodies && !term.includes(':')) {
        if (term.length > 2000) fail('HOST_INBOX_TOO_LARGE', 413)
        const found = await inbox.mailboxConversations(owner, { mailboxIds: scope.boxes.map(box => box.id), keys: [{ sourceId: row.sourceId, threadId: row.threadId }], query: { search: term }, limit: 1 })
        yes = found.items.length > 0
      }
      return negative ? !yes : yes
    }
    const result = await evaluate(expression)
    // A partial category is visible as Unknown; an unproven search is not a match.
    if (result === null) throw pendingContext
    return result!
  }
  async function evaluateRow(scope: Scope, query: DTO.InboxViewQuery, row: DTO.InboxWindowRow) {
    const mail = row.mail, inbox = inFolder(mail, 'Inbox'), holding = inbox && (mail.aiHoldUntil ?? 0) > Date.now()
    const attention = mail.split, counts: Record<string, number> = {}
    const splitMatches = new Map<string, boolean>()
    for (const name of new Set([...scope.preferences.splits, query.split])) {
      const category = attentionSplit(scope.preferences as never, name), rule = (scope.preferences.splitRules as Record<string, string> | undefined)?.[name]
      splitMatches.set(name, category ? attention === category || category === 'Important' && attention === 'Unknown' : typeof rule === 'string' && !!rule.trim() && await expression(scope, row, rule, false))
    }
    if (!(holding && !query.search && query.folder === 'Inbox')) {
      counts.inbox = Number(inbox && attention === 'Important')
      for (const [name, matches] of splitMatches) counts[`split:${name}`] = Number(inbox && matches)
    }
    counts.holding = Number(holding)
    for (const folder of ['Inbox', 'Starred', 'Sent', 'Done', 'Auto Archived', 'Reminders', 'Spam', 'Trash', 'All Mail']) counts[`folder:${folder}`] = Number(inFolder(mail, folder))
    const assessment = mail.triage?.state === 'ready' ? mail.triage.assessment : null
    let matches = !(query.filter === 'Unread' && !mail.unread || query.filter === 'Starred' && !mail.starred || query.filter === 'Important' && attention !== 'Important' && attention !== 'Unknown'
      || query.filter === 'No reply' && !mail.messages.at(-1)?.outgoing || query.filter === 'Needs reply' && assessment?.response !== 'needed'
      || query.filter === 'Action requested' && !assessment?.actions.length || query.filter === 'Time-sensitive' && !['immediate', 'deadline'].includes(assessment?.urgency ?? '')
      || query.filter === 'Suspicious' && !['spam_suspected', 'phishing_suspected'].includes(assessment?.risk ?? '') || query.filter === 'Unassessed' && !!assessment)
    if (matches) matches = query.search ? (!(mail.folder === 'Trash' || mail.folder === 'Spam') || /in:(trash|spam)/i.test(query.query)) && await expression(scope, row, query.query, true)
      : query.folder === 'Inbox' ? inbox && !holding && !!splitMatches.get(query.split) : inFolder(mail, query.folder)
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
    for (const stored of records) {
      const row = json<DTO.InboxWindowRow>(stored.data)
      let result: Awaited<ReturnType<typeof evaluateRow>>
      try { result = await evaluateRow(scope, json(query.data), row) }
      catch (error) {
        if (error !== pendingContext) throw error
        db.query('INSERT OR IGNORE INTO local_window_query_pending VALUES (?,?,?)').run(owner, query.id, row.key)
        db.query('DELETE FROM local_window_matches WHERE owner=? AND query_id=? AND key=?').run(owner, query.id, row.key)
        complete = false; continue
      }
      db.query('DELETE FROM local_window_query_pending WHERE owner=? AND query_id=? AND key=?').run(owner, query.id, row.key)
      if (result.matches) db.query('INSERT OR REPLACE INTO local_window_matches VALUES (?,?,?,?,?)').run(owner, query.id, row.key, stored.at, row.counts.messages ?? 0)
      else db.query('DELETE FROM local_window_matches WHERE owner=? AND query_id=? AND key=?').run(owner, query.id, row.key)
      db.query('INSERT OR REPLACE INTO local_window_counts VALUES (?,?,?,?)').run(owner, query.id, row.key, JSON.stringify(result.counts))
    }
    return complete
  }
  /** Request-driven recent conversation discovery is independent of the raw metadata
   * backfill. Three bounded SDK pages per request; no automatic corpus drain here.
   */
  async function fillPrefix(scope: Scope, query: QueryRow, maximum: number, after?: [number, string]) {
    if (captureLocked(scope) || !scope.boxes.length || queryPending(query) && !scope.row.raw_complete || current(scope) && query.scanned >= scope.row.revision && !queryPending(query)) return
    db.query('INSERT OR IGNORE INTO local_window_prefix(owner,query_id) VALUES (?,?)').run(owner, query.id)
    const extra = { remaining: 4 }
    for (let batch = 0; batch < 3; batch++) {
      const available = db.query<{ count: number }, (string | number)[]>(`SELECT COUNT(*) count FROM (SELECT m.key FROM local_window_matches m JOIN local_window_prefix_rows p ON p.owner=m.owner AND p.query_id=m.query_id AND p.key=m.key WHERE m.owner=? AND m.query_id=? ${after ? 'AND (m.at<? OR (m.at=? AND m.key>?))' : ''} LIMIT ?)`).get(owner, query.id, ...after ? [after[0], after[0], after[1]] : [], maximum + 1)!.count
      const prefix = db.query<Prefix, string[]>('SELECT cursor,exhausted,indexed FROM local_window_prefix WHERE owner=? AND query_id=?').get(owner, query.id)!
      if (available >= maximum + 1 || prefix.exhausted || prefix.indexed) break
      const page = await inbox.mailboxConversations(owner, { mailboxIds: scope.boxes.map(box => box.id), limit: 100, ...(prefix.cursor ? { cursor: prefix.cursor } : {}) })
      await materializeConversations(scope, page.items, extra, page.state)
      const rows: StoredRow[] = []
      for (const item of page.items) {
        const row = db.query<StoredRow, string[]>('SELECT * FROM local_window_rows WHERE owner=? AND scope=? AND source=? AND thread=?').get(owner, scope.row.id, item.sourceId, item.threadId)
        if (!row) fail('HOST_INBOX_UNAVAILABLE', 503)
        rows.push(row!); db.query('INSERT OR IGNORE INTO local_window_prefix_rows VALUES (?,?,?)').run(owner, query.id, row!.key)
      }
      if (!await indexQueryRows(scope, query, rows)) return
      db.query('UPDATE local_window_prefix SET cursor=?,exhausted=? WHERE owner=? AND query_id=?').run(page.nextCursor, Number(!page.nextCursor), owner, query.id)
      db.query('UPDATE local_window_scopes SET baseline=COALESCE(baseline,?),sdk_state=?,sdk_scope=? WHERE owner=? AND id=?').run(page.state, page.state, page.scopeState, owner, scope.row.id)
      refresh(scope); await wait()
    }
  }
  async function preparePage(scope: Scope, query: QueryRow, maximum: number, after?: [number, string], reverse = false) {
    if (!reverse) await fillPrefix(scope, query, maximum, after)
    if (!captureLocked(scope)) {
      const rows = pageResult(scope, query, maximum, after, reverse, true).rows
      const stale = rows.filter(row => db.query('SELECT 1 FROM local_window_dirty WHERE owner=? AND scope=? AND source=? AND thread=?').get(owner, scope.row.id, row.sourceId, row.threadId))
      if (stale.length) { await refreshRows(scope, stale.map(({ sourceId, threadId }) => ({ sourceId, threadId }))); await indexQueryRows(scope, query, stale.flatMap(row => { const value = record(scope, row.key); return value ? [value] : [] })) }
    }
    return pageResult(scope, query, maximum, after, reverse)
  }
  function pageResult(scope: Scope, query: QueryRow, maximum: number, after?: [number, string], reverse = false, allowDirty = false): DTO.InboxWindowPage {
    const ready = current(scope) && query.scanned >= scope.row.revision && !queryPending(query)
    // Do not page past an unresolved conversation's position, even if older rows match.
    const boundary = db.query<{ at: number; key: string }, string[]>('SELECT r.at,r.key FROM local_window_query_pending p JOIN local_window_rows r ON r.owner=p.owner AND r.scope=? AND r.key=p.key WHERE p.owner=? AND p.query_id=? ORDER BY r.at DESC,r.key LIMIT 1').get(scope.row.id, owner, query.id)
    const previousCoverage = db.query<{ indexed: number }, string[]>('SELECT indexed FROM local_window_prefix WHERE owner=? AND query_id=?').get(owner, query.id)?.indexed
    if (ready && !previousCoverage) db.query('INSERT INTO local_window_prefix(owner,query_id,indexed) VALUES (?,?,1) ON CONFLICT(owner,query_id) DO UPDATE SET indexed=1').run(owner, query.id)
    const indexed = ready || !!previousCoverage
    const selected = db.query<StoredRow, (string | number)[]>(`SELECT r.* FROM local_window_matches m JOIN local_window_rows r ON r.owner=m.owner AND r.scope=? AND r.key=m.key WHERE m.owner=? AND m.query_id=? ${indexed ? '' : 'AND EXISTS(SELECT 1 FROM local_window_prefix_rows p WHERE p.owner=m.owner AND p.query_id=m.query_id AND p.key=m.key)'} ${boundary ? 'AND (m.at>? OR (m.at=? AND m.key<?))' : ''} ${after ? reverse ? 'AND (m.at>? OR (m.at=? AND m.key<?))' : 'AND (m.at<? OR (m.at=? AND m.key>?))' : ''} ORDER BY m.at ${reverse ? 'ASC' : 'DESC'},m.key ${reverse ? 'DESC' : 'ASC'} LIMIT ?`).all(scope.row.id, owner, query.id, ...boundary ? [boundary.at, boundary.at, boundary.key] : [], ...after ? [after[0], after[0], after[1]] : [], maximum + 1)
    const rows: DTO.InboxWindowRow[] = []; let size = 65536, pendingDirty = false
    for (const stored of selected.slice(0, maximum)) {
      if (!allowDirty && db.query('SELECT 1 FROM local_window_dirty WHERE owner=? AND scope=? AND source=? AND thread=?').get(owner, scope.row.id, stored.source, stored.thread)) { pendingDirty = true; break }
      const row = json<DTO.InboxWindowRow>(stored.data), cost = bytes(row)
      if (size + cost > DTO.INBOX_RESPONSE_BYTE_LIMIT) break
      rows.push(row); size += cost
    }
    if (!rows.length && selected.length && !pendingDirty) fail('HOST_INBOX_TOO_LARGE', 413)
    if (!rows.length && scope.row.reset === 'unavailable') fail('HOST_INBOX_UNAVAILABLE', 503)
    const hasMore = selected.length > rows.length
    if (reverse) rows.reverse()
    const first = rows[0], last = rows.at(-1)
    return { state: state(scope, query), rows, totals: totals(scope, query), exhausted: ready && !hasMore,
      nextCursor: hasMore || !ready || reverse ? token(`page:${query.id}`, scope, { older: last ? [last.mail.receivedAt ?? 0, last.key] : after ?? null, newer: first ? [first.mail.receivedAt ?? 0, first.key] : after ?? null }) : null }
  }

  async function maintain(scope: Scope) {
    refresh(scope)
    // A capture freezes this derived index, not SDK commands or their durable receipts.
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
      const views = db.query<QueryRow, (string | number)[]>('SELECT * FROM local_window_queries WHERE owner=? AND scope=? AND expires>? AND preference=? AND generation=? ORDER BY expires DESC LIMIT 8').all(owner, scope.row.id, Date.now(), scope.preference, scope.row.generation)
      for (const view of views) { await indexQueryRows(scope, view, records); for (const row of records) db.query('INSERT OR IGNORE INTO local_window_prefix_rows VALUES (?,?,?)').run(owner, view.id, row.key) }
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
      db.query("UPDATE local_window_captures SET complete=1,revision=revision+1,data=CASE WHEN kind='zero' THEN json_set(data,'$.session.status','invalidated') ELSE data END WHERE owner=? AND scope=?").run(owner, scope.row.id)
      for (const table of ['prefix', 'prefix_rows', 'query_pending']) db.query(`DELETE FROM local_window_${table} WHERE owner=? AND query_id IN (SELECT id FROM local_window_queries WHERE owner=? AND scope=?)`).run(owner, owner, scope.row.id)
      db.query('UPDATE local_window_scopes SET cursor=NULL,baseline=NULL,sdk_state=NULL,sdk_scope=\'\',raw_complete=0,generation=generation+1,revision=revision+1,reset=?,checked=0 WHERE owner=? AND id=?').run(reason, owner, scope.row.id)
    }).immediate()
    refresh(scope)
  }
  function resetReadFailure(scope: Scope, error: unknown) {
    if (!(error instanceof InboxError) || !['INVALID_CURSOR', 'STALE_CURSOR', 'SNAPSHOT_SCOPE_CHANGED', 'MAILBOX_SCOPE_CHANGED', 'HISTORY_EXPIRED'].includes(error.code)) return false
    const scopeChanged = ['SNAPSHOT_SCOPE_CHANGED', 'MAILBOX_SCOPE_CHANGED'].includes(error.code)
    reset(scope, scopeChanged ? 'scope' : 'history')
    if (scopeChanged) scopes.delete(scope.row.id)
    return true
  }
  async function scopedRead<T>(scope: Scope, work: () => Promise<T>): Promise<T> {
    try { return await work() }
    catch (error) { if (resetReadFailure(scope, error)) fail('HOST_INBOX_QUERY_EXPIRED', 409); throw error }
  }
  function schedule(delay = 10) {
    if (delay === 0 && timer) { clearTimeout(timer); timer = undefined }
    if (closed || timer || working) return
    timer = setTimeout(() => { timer = undefined; working = work().catch(() => {}).finally(() => {
      working = undefined
      const pending = watched || [...scopes.values()].some(scope => !scope.row.raw_complete || hasDirty(scope))
        || !!db.query('SELECT 1 FROM local_window_queries q JOIN local_window_scopes s ON s.owner=q.owner AND s.id=q.scope WHERE q.owner=? AND q.scanned<s.revision AND q.expires>? AND q.problem IS NULL LIMIT 1').get(owner, Date.now())
        || !!db.query('SELECT 1 FROM local_window_query_pending WHERE owner=? LIMIT 1').get(owner)
        || !!db.query('SELECT 1 FROM local_window_captures WHERE owner=? AND complete=0 LIMIT 1').get(owner)
      schedule(pending ? 25 : 2000)
    }) }, delay)
    timer.unref?.()
  }
  async function work() {
    if (closed || activeRequests) return
    const observed = watchedVersion
    for (const scope of [...scopes.values()].sort((a, b) => b.lastUsed - a.lastUsed)) {
      if (closed || activeRequests) break
      if (scopes.get(scope.row.id) !== scope) continue
      workingScope = scope
      try {
        await captures(scope)
        await maintain(scope)
        if (scope.row.raw_complete && !hasDirty(scope) && scope.row.reset) { db.query('UPDATE local_window_scopes SET reset=NULL WHERE owner=? AND id=?').run(owner, scope.row.id); refresh(scope) }
        const queries = db.query<QueryRow, (string | number)[]>(`SELECT * FROM local_window_queries q WHERE owner=? AND scope=? AND expires>? AND problem IS NULL AND (scanned<? OR EXISTS(SELECT 1 FROM local_window_query_pending p WHERE p.owner=q.owner AND p.query_id=q.id)) ORDER BY expires DESC LIMIT 8`).all(owner, scope.row.id, Date.now(), scope.row.revision)
        for (const query of queries) if (query.preference === scope.preference && query.generation === scope.row.generation) {
          try { await scanQuery(scope, query) } catch (error) { if (resetReadFailure(scope, error)) break; if (error !== pendingContext) db.query("UPDATE local_window_queries SET problem='HOST_INBOX_UNAVAILABLE' WHERE owner=? AND id=?").run(owner, query.id) }
          if (closed || activeRequests) break
        }
      } catch (error) {
        if (!resetReadFailure(scope, error)) { db.query("UPDATE local_window_scopes SET reset='unavailable',checked=0 WHERE owner=? AND id=?").run(owner, scope.row.id); refresh(scope) }
      } finally { workingScope = undefined }
      await wait()
    }
    watched = observed !== watchedVersion
    if (closed || activeRequests || aiCursor === undefined || categoryCursor === undefined) return
    await updateSavedProjections()
    const expired = db.query<{ id: string }, (string | number)[]>("SELECT q.id FROM local_window_queries q WHERE q.owner=? AND q.expires<? AND NOT EXISTS(SELECT 1 FROM local_window_captures c WHERE c.owner=q.owner AND c.complete=0 AND json_extract(c.data,'$.queryId')=q.id) LIMIT 8").all(owner, Date.now())
    for (const query of expired) { for (const table of ['matches', 'counts', 'prefix', 'prefix_rows', 'query_pending']) db.query(`DELETE FROM local_window_${table} WHERE owner=? AND query_id=?`).run(owner, query.id); db.query('DELETE FROM local_window_queries WHERE owner=? AND id=?').run(owner, query.id) }
  }

  type CaptureMeta = { account: string; queryId: string; snapshotRevision?: number; scopeGeneration: number; preference: string; explicitIds?: string[]; session?: DTO.InboxZeroSession; invalidated?: boolean }
  const captureRow = (id: string) => db.query<CaptureRow, string[]>('SELECT * FROM local_window_captures WHERE owner=? AND id=?').get(owner, id)
  function selection(capture: CaptureRow): DTO.InboxSelection {
    return { id: capture.id, account: json<CaptureMeta>(capture.data).account, scopeKey: capture.scope, revision: capture.revision,
      count: capture.complete ? db.query<{ count: number }, string[]>('SELECT COUNT(*) count FROM local_window_capture_items WHERE owner=? AND capture=?').get(owner, capture.id)!.count : null, captureComplete: !!capture.complete }
  }
  function zeroSession(capture: CaptureRow): DTO.InboxZeroSession {
    const meta = json<CaptureMeta>(capture.data), session = meta.session!
    const counts = db.query<{ initial: number; remaining: number; decided: number; ineligible: number }, string[]>(`SELECT COUNT(*) initial,COALESCE(SUM(status='remaining'),0) remaining,COALESCE(SUM(status='decided'),0) decided,COALESCE(SUM(status='ineligible'),0) ineligible FROM local_window_capture_items WHERE owner=? AND capture=?`).get(owner, capture.id)!
    const unknown = db.query<{ count: number }, string[]>(`SELECT COUNT(*) count FROM local_window_capture_items i LEFT JOIN local_window_rows r ON r.owner=i.owner AND r.scope=? AND r.key=i.key WHERE i.owner=? AND i.capture=? AND i.status='remaining' AND (r.key IS NULL OR r.context<>i.context)`).get(capture.scope, owner, capture.id)!.count
    return { ...session, revision: capture.revision, status: session.status === 'invalidated' ? 'invalidated' : !capture.complete ? 'capturing' : !counts.remaining ? 'complete' : 'ready', progress: {
      initialCount: capture.complete ? counts.initial : null, remainingCount: capture.complete ? counts.remaining : null, decidedCount: counts.decided,
      ineligibleCount: counts.ineligible, unknownCount: capture.complete ? unknown : null, captureComplete: !!capture.complete } }
  }
  function invalidateCapture(capture: CaptureRow, meta: CaptureMeta) {
    meta.invalidated = true
    if (meta.session) meta.session.status = 'invalidated'
    db.query('UPDATE local_window_captures SET data=?,complete=1,revision=revision+1 WHERE owner=? AND id=?').run(JSON.stringify(meta), owner, capture.id)
  }
  async function checkedCapture(id: string, kind: string) {
    const capture = captureRow(text(id))
    if (!capture || capture.kind !== kind) fail('HOST_ZERO_SESSION_NOT_FOUND', 404)
    const meta = json<CaptureMeta>(capture!.data), scope = await resolve(meta.account)
    if (meta.invalidated || meta.snapshotRevision === undefined || scope.row.id !== capture!.scope || scope.row.generation !== meta.scopeGeneration || !capture!.complete && meta.preference !== scope.preference) {
      if (!meta.invalidated) invalidateCapture(capture!, meta)
      fail('HOST_INBOX_SCOPE_CHANGED', 409)
    }
    return { capture: capture!, meta, scope }
  }
  async function newQuery(input: DTO.InboxQueryInput, scope: Scope): Promise<QueryRow> {
    const { limit: _, ...query } = input
    text(query.account); text(query.folder, 128); text(query.split, 128)
    if (typeof query.search !== 'boolean' || typeof query.query !== 'string' || query.query.length > 4096 || query.filter !== null && !['Unread', 'Starred', 'Important', 'No reply', 'Needs reply', 'Action requested', 'Time-sensitive', 'Suspicious', 'Unassessed'].includes(query.filter)) fail('HOST_INBOX_INVALID')
    try { parseSearch(query.query) } catch { fail('HOST_INBOX_INVALID') }
    const serialized = JSON.stringify(query)
    const prior = db.query<QueryRow, (string | number)[]>('SELECT * FROM local_window_queries WHERE owner=? AND scope=? AND preference=? AND generation=? AND data=? AND expires>? AND problem IS NULL LIMIT 1').get(owner, scope.row.id, scope.preference, scope.row.generation, serialized, Date.now())
    if (prior) return prior
    const count = db.query<{ count: number }, (string | number)[]>('SELECT COUNT(*) count FROM local_window_queries WHERE owner=? AND scope=? AND expires>?').get(owner, scope.row.id, Date.now())!.count
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
    if (!current(scope) || 'allMatching' in input && input.allMatching === true && query.scanned < scope.row.revision || captureLocked(scope) || scope.users > 1 || workingScope === scope) fail('HOST_INBOX_UNAVAILABLE', 503)
    // Acceptance is the snapshot boundary. No awaiting, deferred readiness, or later arrivals.
    const meta: CaptureMeta = { account: input.account, queryId: query.id, snapshotRevision: scope.row.revision, scopeGeneration: scope.row.generation, preference: scope.preference, ...(explicitIds ? { explicitIds } : {}) }
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
        db.query('INSERT OR IGNORE INTO local_window_capture_items VALUES (?,?,?,?,?,?,?,?)').run(owner, capture.id, ++ordinal, row.key, stored.context, review, JSON.stringify({ item, targets: row.targets, contextComplete: row.targetsComplete, categoryRevision: db.query<{ revision: number }, string[]>('SELECT revision FROM local_category_overrides WHERE owner=? AND source=? AND thread=?').get(owner, row.sourceId, row.threadId)?.revision ?? 0 }), 'remaining')
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
  async function lookupRows(scope: Scope, requested: string[]): Promise<DTO.InboxLookupEntry[]> {
    const outdated = requested.flatMap(id => { const row = record(scope, id); return row && db.query('SELECT 1 FROM local_window_dirty WHERE owner=? AND scope=? AND source=? AND thread=?').get(owner, scope.row.id, row.source, row.thread) ? [{ sourceId: row.source, threadId: row.thread }] : [] })
    await refreshRows(scope, outdated)
    const missing = requested.filter(id => !record(scope, id))
    if (missing.length && scope.boxes.length && !db.query("SELECT 1 FROM local_window_captures WHERE owner=? AND scope=? AND complete=0 AND json_extract(data,'$.snapshotRevision') IS NOT NULL LIMIT 1").get(owner, scope.row.id)) {
      const keys: DTO.InboxThreadKey[] = []
      for (const id of missing) {
        if (scope.row.account === 'unified') {
          const source = scope.sources.find(source => id.startsWith(`unified:${source.id}:`))
          if (source) keys.push({ sourceId: source.id, threadId: id.slice(`unified:${source.id}:`.length) })
        } else if (id.startsWith(`${scope.row.account}:`)) keys.push({ sourceId: scope.boxes[0]!.sourceId, threadId: id.slice(scope.row.account.length + 1) })
      }
      for (let offset = 0; offset < keys.length; offset += 50) {
        const found = await inbox.mailboxConversations(owner, { mailboxIds: scope.boxes.map(box => box.id), keys: keys.slice(offset, offset + 50), limit: 50 })
        await materializeConversations(scope, found.items, { remaining: 4 }, found.state)
        db.query('UPDATE local_window_scopes SET baseline=COALESCE(baseline,?),sdk_state=?,sdk_scope=? WHERE owner=? AND id=?').run(found.state, found.state, found.scopeState, owner, scope.row.id)
        refresh(scope)
      }
    }
    return requested.map(id => {
      const found = record(scope, id)
      if (found && db.query('SELECT 1 FROM local_window_dirty WHERE owner=? AND scope=? AND source=? AND thread=?').get(owner, scope.row.id, found.source, found.thread)) return { id, status: 'unknown' }
      return found ? { id, status: 'found', row: json<DTO.InboxWindowRow>(found.data) } : { id, status: current(scope) ? 'absent' : 'unknown' }
    })
  }
  async function sender(input: DTO.InboxSenderInput): Promise<DTO.InboxSenderResult> {
    const scope = await resolve(input.account), entry = (await lookupRows(scope, [text(input.id)]))[0]!
    if (entry.status !== 'found') return { state: state(scope), status: entry.status, contact: null, activity: null, recent: [] }
    const row = entry.row, values = summaries(scope, row.sourceId, row.threadId, 500)
    if (input.selectedMessageId && !values.some(value => value.id === input.selectedMessageId)) {
      const selected = db.query<{ data: string }, string[]>('SELECT data FROM local_window_messages WHERE owner=? AND scope=? AND source=? AND thread=? AND id=?').get(owner, scope.row.id, row.sourceId, row.threadId, text(input.selectedMessageId))
      if (selected) values.push(json(selected.data))
    }
    const history: SenderHistoryMessage[] = values.map(value => ({ ...value, threadId: value.threadId, outgoing: value.folder === 'sent', mailboxIds: value.memberships.map(state => state.mailboxId) }))
    const projection = project(scope, values), mail = projection.mail.find(mail => mail.account === scope.row.account)!
    const contact = senderContact(mail, history, projection.accounts, input.selectedMessageId)
    if (!current(scope)) return { state: state(scope), status: 'unknown', contact, activity: null, recent: [] }
    const domain = input.domain ? text(input.domain, 253).toLowerCase() : null, hostname = senderHostname(contact.email)
    if (domain && (!hostname || senderHostname(`root@${domain}`) !== domain || !(hostname === domain || hostname.endsWith(`.${domain}`)))) fail('HOST_INBOX_INVALID')
    if (domain) {
      if (!deps.senderDomains) fail('HOST_INBOX_UNAVAILABLE', 503)
      const response = await deps.senderDomains!.fetch(new Request(`http://localhost/host/sender-domains/${encodeURIComponent(hostname!)}`))
      const info = await response.json() as SenderDomainInfo
      if (!response.ok || info.kind !== 'domain' || info.rootDomain !== domain) fail('HOST_INBOX_INVALID')
    }
    const predicate = domain ? "(substr(email,instr(email,'@')+1)=? OR substr(email,instr(email,'@')+1) LIKE ? ESCAPE '\\')" : 'email=?'
    const params = domain ? [domain, `%.${domain.replace(/[\\%_]/g, value => `\\${value}`)}`] : [contact.email.trim().toLowerCase()]
    const where = `owner=? AND scope=? AND ${predicate} AND folder NOT IN ('trash','spam','scheduled','draft','drafts') AND at<=?`
    const common = [owner, scope.row.id, ...params, Date.now()]
    // Domain grouping deduplicates messages addressed to multiple people at that domain.
    const base = `SELECT source,message,thread,direction,at FROM local_window_contacts WHERE ${where} GROUP BY source,message,direction`
    const total = db.query<{ received: number; sent: number; firstMessage: number | null; lastMessage: number | null; lastSent: number | null }, (string | number)[]>(`SELECT COALESCE(SUM(direction='received'),0) received,COALESCE(SUM(direction='sent'),0) sent,MIN(at) firstMessage,MAX(at) lastMessage,MAX(CASE WHEN direction='sent' THEN at END) lastSent FROM (${base})`).get(...common)!
    const threadSql = `SELECT source,thread,MAX(direction='received') received,MAX(direction='sent') sent,MAX(at) latest FROM (${base}) GROUP BY source,thread`
    const threadCounts = db.query<{ conversations: number; twoWay: number }, (string | number)[]>(`SELECT COUNT(*) conversations,COALESCE(SUM(received AND sent),0) twoWay FROM (${threadSql})`).get(...common)!
    const week = 7 * 86400_000, since = Date.now() - 12 * week
    const weeks = Array.from({ length: 12 }, (_, index) => ({ start: since + index * week, received: 0, sent: 0 }))
    const bins = db.query<{ week: number; received: number; sent: number }, (string | number)[]>(`SELECT CAST((at-?)/? AS INTEGER) week,SUM(direction='received') received,SUM(direction='sent') sent FROM (${base}) WHERE at>=? GROUP BY week LIMIT 12`).all(since, week, ...common, since)
    for (const bin of bins) if (weeks[bin.week]) { weeks[bin.week]!.received = bin.received; weeks[bin.week]!.sent = bin.sent }
    const recentKeys = db.query<{ source: string; thread: string }, (string | number)[]>(`${threadSql} ORDER BY latest DESC LIMIT 5`).all(...common)
    const recent = recentKeys.flatMap(key => { const row = db.query<{ data: string }, string[]>('SELECT data FROM local_window_rows WHERE owner=? AND scope=? AND source=? AND thread=?').get(owner, scope.row.id, key.source, key.thread); return row ? [json<DTO.InboxWindowRow>(row.data)] : [] })
    const { twoWay } = threadCounts, level = !total.received && !total.sent ? 0 : twoWay >= 25 ? 5 : twoWay >= 10 ? 4 : twoWay >= 3 ? 3 : twoWay ? 2 : 1
    return { state: state(scope), status: 'ready', contact, activity: { ...total, ...threadCounts, weeks, level }, recent }
  }

  type ZeroItemRow = { key: string; context: string; review: string; data: string; status: string }
  type ZeroItemData = { item: DTO.InboxZeroItem; targets: MailboxStateTarget[]; contextComplete: boolean; categoryRevision?: number; reviewOnly?: boolean; latestProgress?: string; credit?: string; batchOffer?: { version: string; categoryRevision: number } }
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
        const saved = json<ZeroItemData>(item.data), row = record(scope, item.key)
        return saved.reviewOnly || !saved.contextComplete || !row ? [] : [{ item, saved, key: { sourceId: row.source, threadId: row.thread } }]
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

  const transport: DTO.InboxWindowTransport = {
    async query(input) {
      const maximum = limit(input.limit), scope = await resolve(input.account)
      const query = await newQuery(input, scope)
      return scopedRead(scope, () => preparePage(scope, query, maximum))
    },
    async page(input) {
      const maximum = limit(input.limit), { scope, query } = await queryScope(input.queryId)
      if (input.direction !== undefined && !['older', 'newer'].includes(input.direction) || input.seek !== undefined && !['start', 'end'].includes(input.seek)) fail('HOST_INBOX_INVALID')
      if (input.seek === 'end' && (!current(scope) || query.scanned < scope.row.revision)) fail('HOST_INBOX_UNAVAILABLE', 503)
      const cursor = input.cursor ? untoken<{ older: [number, string] | null; newer: [number, string] | null }>(input.cursor, `page:${query.id}`, scope) : null
      const reverse = input.seek === 'end' || input.direction === 'newer'
      const after = input.seek ? undefined : (reverse ? cursor?.newer : cursor?.older) ?? undefined
      return scopedRead(scope, () => preparePage(scope, query, maximum, after, reverse))
    },
    async counts(input) { const { scope, query } = await queryScope(input.queryId); return { state: state(scope, query), totals: totals(scope, query) } },
    async lookup(input) { const scope = await resolve(input.account), entries = await scopedRead(scope, () => lookupRows(scope, ids(input.ids))); return { state: state(scope), entries } },
    async changes(input) {
      const maximum = limit(input.limit), resident = ids(input.residentKeys, 1000), pinned = ids(input.pinnedKeys, 100), since = integer(input.sinceRevision)
      const query = getQuery(text(input.queryId))
      if (!query || query.expires < Date.now()) fail('HOST_INBOX_QUERY_EXPIRED', 410)
      if (query!.problem) fail('HOST_INBOX_UNAVAILABLE', 503)
      const scope = await resolve(json<DTO.InboxViewQuery>(query!.data).account)
      const resetReason = scope.row.id !== query!.scope ? 'scope' : scope.row.generation !== query!.generation ? 'history' : scope.preference !== query!.preference ? 'query' : null
      if (resetReason) return { state: state(scope, query!), upserts: [], newHead: [], removed: [], totals: unknownTotals(scope), nextCursor: null, throughRevision: scope.row.revision, resetReason }
      if (scope.seenEvents !== watchedVersion || watched || Date.now() - scope.row.checked >= 2000) await scopedRead(scope, () => maintain(scope))
      const wanted = [...new Set([...resident, ...pinned])]
      if (wanted.length > 1000) fail('HOST_INBOX_TOO_LARGE', 413)
      const cursorKind = `changes:${query!.id}:${digest([since, wanted])}`
      const cursor = input.cursor ? untoken<{ offset: number; through: number }>(input.cursor, cursorKind, scope) : { offset: 0, through: Math.max(since, Math.min(query!.scanned, scope.row.revision)) }
      const offset = cursor.offset, through = cursor.through
      if (since > scope.row.revision) fail('HOST_INBOX_CURSOR_INVALID', 409)
      const entries = wanted.slice(offset, offset + maximum), upserts: DTO.InboxWindowRow[] = [], removed: DTO.InboxWindowChanges['removed'] = []
      const records = entries.flatMap(key => { const row = record(scope, key); return row ? [row] : [] })
      const dirtyRows = records.filter(row => db.query('SELECT 1 FROM local_window_dirty WHERE owner=? AND scope=? AND source=? AND thread=?').get(owner, scope.row.id, row.source, row.thread))
      await scopedRead(scope, () => refreshRows(scope, dirtyRows.map(row => ({ sourceId: row.source, threadId: row.thread }))))
      await indexQueryRows(scope, query!, entries.flatMap(key => { const row = record(scope, key); return row ? [row] : [] }))
      let consumed = 0, size = 65536
      for (const key of entries) {
        if (db.query('SELECT 1 FROM local_window_query_pending WHERE owner=? AND query_id=? AND key=?').get(owner, query!.id, key)) { consumed++; continue }
        const stored = record(scope, key)
        if (!stored) { if (current(scope)) removed.push({ key, reason: 'deleted' }) }
        else {
          const matches = db.query('SELECT 1 FROM local_window_matches WHERE owner=? AND query_id=? AND key=?').get(owner, query!.id, key)
          if (!matches && !pinned.includes(key)) removed.push({ key, reason: 'not-matching' })
          else if (stored.revision > since) { const row = json<DTO.InboxWindowRow>(stored.data); if (size + bytes(row) > DTO.INBOX_RESPONSE_BYTE_LIMIT) break; upserts.push(row); size += bytes(row) }
        }
        consumed++
      }
      if (!consumed && entries.length) fail('HOST_INBOX_TOO_LARGE', 413)
      const next = offset + consumed, newHead: DTO.InboxWindowRow[] = []
      // A separate final head page cannot be crowded out by 100 resident updates.
      const headPage = offset >= wanted.length
      if (headPage) {
        const head = pageResult(scope, query!, maximum)
        for (const row of head.rows) if (!wanted.includes(row.key) && row.revision > since && size + bytes(row) <= DTO.INBOX_RESPONSE_BYTE_LIMIT) { newHead.push(row); size += bytes(row) }
      }
      return { state: state(scope, query!), upserts, newHead, removed, totals: totals(scope, query!),
        nextCursor: !headPage ? token(cursorKind, scope, { offset: next, through }) : null,
        throughRevision: through, resetReason: null }
    },
    async messages(input) {
      const maximum = limit(input.limit), scope = await resolve(input.account), entry = (await lookupRows(scope, [text(input.id)]))[0]!
      if (entry.status !== 'found') fail('HOST_INBOX_UNAVAILABLE', 503)
      const row = (entry as Extract<DTO.InboxLookupEntry, { status: 'found' }>).row
      const cursor = input.cursor ? untoken<{ context: string; cursor: string }>(input.cursor, `messages:${row.key}`, scope) : undefined
      if (cursor && cursor.context !== row.contextVersion) fail('HOST_INBOX_CONTEXT_CHANGED', 409)
      const page = await inbox.mailboxMessagePage(owner, { mailboxIds: scope.boxes.map(box => box.id), sourceId: row.sourceId, threadId: row.threadId, limit: maximum, ...(cursor ? { cursor: cursor.cursor } : {}) })
      if (page.state !== scope.row.sdk_state || page.scopeState !== scope.row.sdk_scope || db.query('SELECT 1 FROM local_window_dirty WHERE owner=? AND scope=? AND source=? AND thread=?').get(owner, scope.row.id, row.sourceId, row.threadId)) fail('HOST_INBOX_CONTEXT_CHANGED', 409)
      const projected = project(scope, page.items).mail.find(mail => mail.account === scope.row.account)
      return { state: state(scope), key: row.key, contextVersion: row.contextVersion, summaries: page.items, messages: projected?.messages ?? [], total: row.counts.messages,
        nextCursor: page.nextCursor ? token(`messages:${row.key}`, scope, { context: row.contextVersion, cursor: page.nextCursor }) : null, exhausted: !page.nextCursor }
    },
    sender,
    async contacts(input) {
      const scope = await resolve(input.account), maximum = limit(input.limit)
      if (typeof input.query !== 'string' || input.query.length > 256) fail('HOST_INBOX_INVALID')
      const pattern = `%${input.query.trim().toLowerCase().replace(/[\\%_]/g, value => `\\${value}`)}%`
      const found = db.query<{ name: string; email: string }, (string | number)[]>(`SELECT email,MAX(name) name FROM local_window_contacts WHERE owner=? AND scope=? AND (email LIKE ? ESCAPE '\\' OR lower(name) LIKE ? ESCAPE '\\') AND folder NOT IN ('trash','spam','scheduled','draft','drafts') GROUP BY email ORDER BY MAX(at) DESC,email LIMIT ?`).all(owner, scope.row.id, pattern, pattern, maximum)
      return { state: state(scope), contacts: found.map(value => ({ ...value, messageId: null, role: 'recipient' as const })), complete: current(scope) }
    },
    async selectionCreate(input) { return selection(await createCapture(input, 'selection')) },
    async selectionPage(input) {
      const maximum = limit(input.limit), { capture, scope } = await checkedCapture(input.selectionId, 'selection')
      const after = input.cursor ? untoken<number>(input.cursor, `selection:${capture.id}`, scope) : 0
      const live = scope.boxes.length ? await inbox.mailboxMessagePage(owner, { mailboxIds: scope.boxes.map(box => box.id), limit: 1 }) : null
      const caughtUp = !live || live.state === scope.row.sdk_state && live.scopeState === scope.row.sdk_scope
      const stored = db.query<{ key: string; context: string; ordinal: number }, (string | number)[]>('SELECT key,context,ordinal FROM local_window_capture_items WHERE owner=? AND capture=? AND ordinal>? ORDER BY ordinal LIMIT ?').all(owner, capture.id, after, maximum + 1)
      const entries: DTO.InboxSelectionPage['entries'] = []; let size = 65536, last = after
      for (const item of stored.slice(0, maximum)) {
        const row = record(scope, item.key)
        const pending = !caughtUp || !!row && !!db.query('SELECT 1 FROM local_window_dirty WHERE owner=? AND scope=? AND source=? AND thread=?').get(owner, scope.row.id, row.source, row.thread)
        const entry: DTO.InboxSelectionPage['entries'][number] = pending ? { id: item.key, status: 'unknown' } : !row ? { id: item.key, status: current(scope) ? 'absent' : 'unknown' } : row.context !== item.context ? { id: item.key, status: 'changed' } : { id: item.key, status: 'found', row: json(row.data) }
        if (size + bytes(entry) > DTO.INBOX_RESPONSE_BYTE_LIMIT) break
        entries.push(entry); size += bytes(entry); last = item.ordinal
      }
      return { selection: selection(capture), entries, nextCursor: stored.length > entries.length || !capture.complete ? token(`selection:${capture.id}`, scope, last) : null,
        exhausted: !!capture.complete && stored.length <= entries.length }
    },
    async zeroCreate(input) { return zeroSession(await createCapture(input, 'zero')) },
    async zeroResume(input) {
      text(input.sessionId); text(input.account)
      const capture = captureRow(input.sessionId)
      if (!capture || capture.kind !== 'zero' || json<CaptureMeta>(capture.data).account !== input.account) return { status: 'absent' }
      try { await checkedCapture(input.sessionId, 'zero') } catch (error) { if (!(error instanceof InboxError) || error.code !== 'HOST_INBOX_SCOPE_CHANGED') throw error }
      return { status: 'found', session: zeroSession(captureRow(input.sessionId)!) }
    },
    zeroPage(input) { return serialZero(async () => {
      const maximum = limit(input.limit), { capture, scope } = await checkedCapture(input.sessionId, 'zero')
      const after = input.cursor ? untoken<number>(input.cursor, `zero:${capture.id}`, scope) : 0
      const stored = db.query<{ key: string; data: string; context: string; review: string; ordinal: number }, (string | number)[]>("SELECT key,data,context,review,ordinal FROM local_window_capture_items WHERE owner=? AND capture=? AND ordinal>? AND status='remaining' ORDER BY ordinal LIMIT ?").all(owner, capture.id, after, maximum + 1)
      const batches = capture.complete ? await freshBatchCandidates(scope, capture, stored.slice(0, maximum)) : new Map()
      const items = stored.slice(0, maximum).map(value => {
        const saved = json<ZeroItemData>(value.data), opaqueReview = value.review ? reviewToken(capture.id, value.review) : null
        const batch = batches.get(value.key)
        const item: DTO.InboxZeroItem = { ...saved.item, reviewVersion: opaqueReview, batchEligibility: batch ? 'eligible' : 'ineligible', batchCandidate: batch?.candidate ?? null }
        const currentRow = record(scope, value.key)
        if (!currentRow || currentRow.context !== value.context) return { ...item, eligibility: 'unknown' as const, batchEligibility: 'unknown' as const, batchCandidate: null }
        if (batch) db.query("UPDATE local_window_capture_items SET data=json_set(data,'$.batchOffer',json(?)) WHERE owner=? AND capture=? AND key=?").run(JSON.stringify(batch.offer), owner, capture.id, value.key)
        return item
      })
      const last = stored[Math.min(maximum, stored.length) - 1]?.ordinal ?? after
      return { session: zeroSession(capture), items, nextCursor: stored.length > maximum || !capture.complete ? token(`zero:${capture.id}`, scope, last) : null,
        exhausted: !!capture.complete && stored.length <= maximum && items.every(item => item.eligibility !== 'unknown') }
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
          db.query("UPDATE local_window_capture_items SET status='remaining',data=? WHERE owner=? AND capture=? AND key=?").run(JSON.stringify(saved), owner, capture.id, proof.id)
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
        lookup: ['account', 'ids'], changes: ['queryId', 'sinceRevision', 'residentKeys', 'pinnedKeys', 'cursor', 'limit'], messages: ['account', 'id', 'cursor', 'limit'],
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
        } finally { for (const scope of uses) scope.users--; activeRequests--; schedule(0) }
      })
    },
    async close() { closed = true; unwatch(); clearTimeout(timer); await Promise.all([working, zeroWrites, projectionWork]); scopes.clear() },
  }
}
