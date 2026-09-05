import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { InboxError, type Inbox, type Account, type Mailbox } from 'inbox-sdk'
import {
  CATEGORY_BATCH_LIMIT, CATEGORY_BODY_LIMIT, CATEGORY_RESPONSE_LIMIT, categoryCommandId, categoryErrorMessages,
  isCategoryCommand, isCategoryKey, type CategoryContext, type CategoryEntry,
  type CategoryErrorCode, type CategoryKey, type CategoryPage, type CategoryReceipt,
} from '../../shared/attention-overrides'

function fail(code: CategoryErrorCode, status = 400): never { throw new InboxError(code, categoryErrorMessages[code], status) }
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? '')
export const CATEGORY_STORAGE_LIMITS = {
  owner: { keys: 100_000, commands: 100_000, bytes: 256 * 1024 * 1024 },
  global: { keys: 500_000, commands: 500_000, bytes: 1024 * 1024 * 1024 },
} as const
type StorageUsage = { keys: number; commands: number; bytes: number }

/** Explicit local choices only. All canonical mail authorization stays in the public SDK. */
export function createAttentionOverridesStore(database: Database, inbox: Inbox, owner: string) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS local_category_clock (owner TEXT PRIMARY KEY, head INTEGER NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS local_category_overrides (owner TEXT NOT NULL, source TEXT NOT NULL, thread TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(owner,source,thread)) STRICT;
    CREATE INDEX IF NOT EXISTS local_category_override_changes ON local_category_overrides(owner,revision);
    CREATE TABLE IF NOT EXISTS local_category_commands (owner TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT NOT NULL, receipt TEXT NOT NULL, before_entries TEXT NOT NULL, PRIMARY KEY(owner,id)) STRICT;
  `)
  // Private byte accounting is additive for pre-quota fixtures/installations.
  // Aggregate once under the migration lock, never COUNT/SUM the ledger per action.
  database.transaction(() => {
    for (const table of ['local_category_overrides', 'local_category_commands']) {
      if (!database.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().some(column => column.name === 'stored_bytes')) database.exec(`ALTER TABLE ${table} ADD COLUMN stored_bytes INTEGER NOT NULL DEFAULT 0 CHECK(stored_bytes>=0)`)
    }
    database.exec(`
      CREATE TABLE IF NOT EXISTS local_category_storage_owner (owner TEXT PRIMARY KEY, key_count INTEGER NOT NULL CHECK(key_count>=0), command_count INTEGER NOT NULL CHECK(command_count>=0), byte_count INTEGER NOT NULL CHECK(byte_count>=0)) STRICT;
      CREATE TABLE IF NOT EXISTS local_category_storage_global (id INTEGER PRIMARY KEY CHECK(id=1), key_count INTEGER NOT NULL CHECK(key_count>=0), command_count INTEGER NOT NULL CHECK(command_count>=0), byte_count INTEGER NOT NULL CHECK(byte_count>=0)) STRICT;
      CREATE TABLE IF NOT EXISTS local_category_storage_migration (id INTEGER PRIMARY KEY CHECK(id=1)) STRICT;
    `)
    if (!database.query('SELECT 1 FROM local_category_storage_migration WHERE id=1').get()) {
      database.exec(`
        UPDATE local_category_overrides SET stored_bytes=length(CAST(owner AS BLOB))+length(CAST(source AS BLOB))+length(CAST(thread AS BLOB))+length(CAST(data AS BLOB));
        UPDATE local_category_commands SET stored_bytes=length(CAST(owner AS BLOB))+length(CAST(id AS BLOB))+length(CAST(fingerprint AS BLOB))+length(CAST(receipt AS BLOB))+length(CAST(before_entries AS BLOB));
        INSERT INTO local_category_storage_owner
          SELECT owner,SUM(keys),SUM(commands),SUM(bytes) FROM (
            SELECT owner,COUNT(*) keys,0 commands,SUM(stored_bytes) bytes FROM local_category_overrides GROUP BY owner
            UNION ALL SELECT owner,0 keys,COUNT(*) commands,SUM(stored_bytes) bytes FROM local_category_commands GROUP BY owner
          ) GROUP BY owner
          ON CONFLICT(owner) DO UPDATE SET key_count=excluded.key_count,command_count=excluded.command_count,byte_count=excluded.byte_count;
        INSERT INTO local_category_storage_global SELECT 1,COALESCE(SUM(key_count),0),COALESCE(SUM(command_count),0),COALESCE(SUM(byte_count),0) FROM local_category_storage_owner WHERE true
          ON CONFLICT(id) DO UPDATE SET key_count=excluded.key_count,command_count=excluded.command_count,byte_count=excluded.byte_count;
        INSERT INTO local_category_storage_migration VALUES (1);
      `)
    }
  }).immediate()
  const stored = (key: CategoryKey) => database.query<{ data: string; stored_bytes: number }, [string, string, string]>('SELECT data,stored_bytes FROM local_category_overrides WHERE owner=? AND source=? AND thread=?').get(owner, key.sourceId, key.threadId)
  const read = (key: CategoryKey): CategoryEntry => {
    const row = stored(key)
    return row ? JSON.parse(row.data) : { sourceId: key.sourceId, threadId: key.threadId, revision: 0, override: null }
  }
  const command = (id: string) => database.query<{ fingerprint: string; receipt: string; before_entries: string; stored_bytes: number }, [string, string]>('SELECT fingerprint,receipt,before_entries,stored_bytes FROM local_category_commands WHERE owner=? AND id=?').get(owner, id)
  const head = () => database.query<{ head: number }, [string]>('SELECT head FROM local_category_clock WHERE owner=?').get(owner)?.head ?? 0
  // Charge every persisted JSON copy (including before/Undo), plus its text keys
  // and fingerprint. SQLite page/index overhead is not serialized context data.
  const commandBytes = (id: string, fingerprint: string, receipt: string, before: string) => Buffer.byteLength(owner) + Buffer.byteLength(id) + Buffer.byteLength(fingerprint) + Buffer.byteLength(receipt) + Buffer.byteLength(before)
  const prepare = (entries: CategoryEntry[]) => {
    const baseline = head()
    if (!Number.isSafeInteger(baseline + entries.length)) fail('HOST_CATEGORY_UNAVAILABLE', 503)
    return entries.map((value, index) => {
      const entry = { ...value, revision: baseline + index + 1 }, data = JSON.stringify(entry)
      return { entry, data, size: Buffer.byteLength(owner) + Buffer.byteLength(entry.sourceId) + Buffer.byteLength(entry.threadId) + Buffer.byteLength(data) }
    })
  }
  const charge = (delta: StorageUsage, admit: boolean) => {
    const own = database.query<StorageUsage, [string]>('SELECT key_count keys,command_count commands,byte_count bytes FROM local_category_storage_owner WHERE owner=?').get(owner) ?? { keys: 0, commands: 0, bytes: 0 }
    const global = database.query<StorageUsage, []>('SELECT key_count keys,command_count commands,byte_count bytes FROM local_category_storage_global WHERE id=1').get()!
    const next = (value: StorageUsage): StorageUsage => ({ keys: value.keys + delta.keys, commands: value.commands + delta.commands, bytes: value.bytes + delta.bytes })
    const ownerNext = next(own), globalNext = next(global)
    for (const value of [ownerNext, globalNext]) if (Object.values(value).some(count => !Number.isSafeInteger(count) || count < 0)) fail('HOST_CATEGORY_UNAVAILABLE', 503)
    const fits = (value: StorageUsage, limit: StorageUsage) => value.keys <= limit.keys && value.commands <= limit.commands && value.bytes <= limit.bytes
    if (admit && (!fits(ownerNext, CATEGORY_STORAGE_LIMITS.owner) || !fits(globalNext, CATEGORY_STORAGE_LIMITS.global))) fail('HOST_CATEGORY_STORAGE_FULL', 409)
    database.query('INSERT INTO local_category_storage_owner VALUES (?,?,?,?) ON CONFLICT(owner) DO UPDATE SET key_count=excluded.key_count,command_count=excluded.command_count,byte_count=excluded.byte_count').run(owner, ownerNext.keys, ownerNext.commands, ownerNext.bytes)
    database.query('UPDATE local_category_storage_global SET key_count=?,command_count=?,byte_count=? WHERE id=1').run(globalNext.keys, globalNext.commands, globalNext.bytes)
  }
  const save = (records: ReturnType<typeof prepare>) => {
    database.query('INSERT INTO local_category_clock VALUES (?,?) ON CONFLICT(owner) DO UPDATE SET head=excluded.head').run(owner, records.at(-1)!.entry.revision)
    for (const { entry, data, size } of records) database.query('INSERT INTO local_category_overrides(owner,source,thread,revision,data,stored_bytes) VALUES (?,?,?,?,?,?) ON CONFLICT(owner,source,thread) DO UPDATE SET revision=excluded.revision,data=excluded.data,stored_bytes=excluded.stored_bytes').run(owner, entry.sourceId, entry.threadId, entry.revision, data, size)
  }
  let queue = Promise.resolve()
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const task = queue.then(work)
    queue = task.then(() => {}, () => {})
    return task
  }
  async function safe<T>(work: () => Promise<T>): Promise<T> {
    try { return await work() }
    catch (error) {
      if (error instanceof InboxError && Object.hasOwn(categoryErrorMessages, error.code)) throw new InboxError(error.code, categoryErrorMessages[error.code as CategoryErrorCode], error.status)
      if (error instanceof InboxError && [403, 404].includes(error.status)) fail('HOST_CATEGORY_NOT_FOUND', 404)
      if (error instanceof InboxError && [409, 412].includes(error.status)) fail('HOST_CATEGORY_CONTEXT_CHANGED', 412)
      fail('HOST_CATEGORY_UNAVAILABLE', 503)
    }
  }
  function scopes() {
    const accounts = new Map<string, Promise<Account>>()
    let boxes: Promise<Map<string, Mailbox>> | undefined
    return {
      account(source: string) { let task = accounts.get(source); if (!task) { task = inbox.account(owner, source); accounts.set(source, task) }; return task },
      boxes() { return boxes ??= inbox.mailboxes(owner).then(values => new Map(values.map(value => [value.id, value]))) },
    }
  }
  async function authorize(context: CategoryContext, scope: ReturnType<typeof scopes>, exact: boolean) {
    const [account, boxes] = await Promise.all([scope.account(context.sourceId), scope.boxes()])
    if (account.status !== 'connected' || account.generation !== context.sourceGeneration) fail('HOST_CATEGORY_CONTEXT_CHANGED', 412)
    for (const id of context.mailboxIds) {
      const box = boxes.get(id)
      if (!box || box.sourceId !== context.sourceId || box.status === 'detached') fail('HOST_CATEGORY_NOT_FOUND', 404)
    }
    let eligible = false
    const messages = exact ? context.messages : context.messages.filter(message => message.messageId === context.latestMessageId)
    for (const captured of messages) for (const member of captured.memberships) {
      const summary = await inbox.mailboxMessageSummary(owner, member.mailboxId, captured.messageId)
      if (summary.sourceId !== context.sourceId || summary.threadId !== context.threadId) fail('HOST_CATEGORY_NOT_FOUND', 404)
      const state = summary.memberships.find(value => value.mailboxId === member.mailboxId)
      if (!state) fail('HOST_CATEGORY_NOT_FOUND', 404)
      if (exact && (summary.revision !== captured.revision || (summary.bodyRevision ?? null) !== captured.bodyRevision || state.revision !== member.revision)) fail('HOST_CATEGORY_CONTEXT_CHANGED', 412)
      eligible ||= summary.folder === 'inbox' && !state.done && (!state.snoozedUntil || Date.parse(state.snoozedUntil) <= Date.now())
    }
    if (exact && !eligible) fail('HOST_CATEGORY_CONTEXT_CHANGED', 412)
  }
  async function visible(entry: CategoryEntry, scope: ReturnType<typeof scopes>): Promise<CategoryEntry> {
    try {
      if (entry.override) await authorize(entry.override.context, scope, false)
      else await scope.account(entry.sourceId)
      return entry
    } catch (error) {
      if (!(error instanceof InboxError) || ![403, 404, 409, 412].includes(error.status)) throw error
      // Keep the owner's revision fence, but never return inaccessible context.
      return { sourceId: entry.sourceId, threadId: entry.threadId, revision: entry.revision, override: null }
    }
  }
  async function replay(receipt: CategoryReceipt): Promise<CategoryReceipt> {
    const scope = scopes()
    // Replay returns the durable receipt, not current categories. Reauthorize its
    // contexts without treating later content or membership revisions as new input.
    for (const entry of receipt.entries) if (entry.override) await authorize(entry.override.context, scope, false)
    else await scope.account(entry.sourceId)
    return receipt
  }
  return {
    classify(input: unknown): Promise<CategoryReceipt> { return safe(() => serial(async () => {
      if (bytes(input) > CATEGORY_BODY_LIMIT) fail('HOST_CATEGORY_TOO_LARGE', 413)
      if (!isCategoryCommand(input)) fail('HOST_CATEGORY_INVALID')
      const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex')
      const prior = command(input.id)
      if (prior) {
        if (prior.fingerprint !== fingerprint) fail('HOST_CATEGORY_IDEMPOTENCY_CONFLICT', 409)
        return replay(JSON.parse(prior.receipt))
      }
      const scope = scopes()
      for (const target of input.targets) await authorize(target.context, scope, true)
      // No atomic SDK head claim: this record is applicable only to the captured
      // context. A concurrent arrival cannot be absorbed into it by this write.
      const receipt = database.transaction(() => {
        const prior = command(input.id)
        if (prior) {
          if (prior.fingerprint !== fingerprint) fail('HOST_CATEGORY_IDEMPOTENCY_CONFLICT', 409)
          return JSON.parse(prior.receipt) as CategoryReceipt
        }
        const previous = input.targets.map(target => stored(target.context))
        const before: CategoryEntry[] = previous.map((row, index) => row ? JSON.parse(row.data) : { sourceId: input.targets[index]!.context.sourceId, threadId: input.targets[index]!.context.threadId, revision: 0, override: null })
        if (bytes(before) > CATEGORY_RESPONSE_LIMIT - 4096) fail('HOST_CATEGORY_TOO_LARGE', 413)
        if (before.some((entry, index) => entry.revision !== input.targets[index]!.ifRevision)) fail('HOST_CATEGORY_CONFLICT', 412)
        const records = prepare(input.targets.map(target => ({ sourceId: target.context.sourceId, threadId: target.context.threadId, revision: 0, override: { category: input.category, context: target.context } })))
        const receipt: CategoryReceipt = { id: input.id, retracted: false, entries: records.map(record => record.entry) }
        const receiptText = JSON.stringify(receipt), beforeText = JSON.stringify(before), size = commandBytes(input.id, fingerprint, receiptText, beforeText)
        charge({ keys: previous.filter(row => !row).length, commands: 1, bytes: size + records.reduce((sum, record) => sum + record.size, 0) - previous.reduce((sum, row) => sum + (row?.stored_bytes ?? 0), 0) }, true)
        save(records)
        database.query('INSERT INTO local_category_commands(owner,id,fingerprint,receipt,before_entries,stored_bytes) VALUES (?,?,?,?,?,?)').run(owner, input.id, fingerprint, receiptText, beforeText, size)
        return receipt
      }).immediate()
      return receipt
    })) },
    undo(id: string): Promise<CategoryReceipt> { return safe(() => serial(async () => {
      if (!categoryCommandId(id)) fail('HOST_CATEGORY_INVALID')
      const row = command(id)
      if (!row) fail('HOST_CATEGORY_NOT_FOUND', 404)
      const receipt: CategoryReceipt = JSON.parse(row.receipt)
      await replay(receipt)
      if (receipt.retracted) return receipt
      const prior: CategoryEntry[] = JSON.parse(row.before_entries), scope = scopes(), before: CategoryEntry[] = []
      for (const entry of prior) before.push(await visible(entry, scope))
      return database.transaction(() => {
        const current = command(id)!
        const accepted: CategoryReceipt = JSON.parse(current.receipt)
        if (accepted.retracted) return accepted
        const previous = accepted.entries.map(entry => stored(entry))
        if (accepted.entries.some((entry, index) => !previous[index] || (JSON.parse(previous[index]!.data) as CategoryEntry).revision !== entry.revision)) fail('HOST_CATEGORY_UNDO_CONFLICT', 412)
        const records = prepare(before), result: CategoryReceipt = { id, retracted: true, entries: records.map(record => record.entry) }
        const receiptText = JSON.stringify(result), size = commandBytes(id, current.fingerprint, receiptText, current.before_entries)
        // Recovery of an existing command remains available even above a quota.
        // Its actual new serialized bytes are still accounted transactionally.
        charge({ keys: 0, commands: 0, bytes: size - current.stored_bytes + records.reduce((sum, record) => sum + record.size, 0) - previous.reduce((sum, row) => sum + row!.stored_bytes, 0) }, false)
        save(records)
        database.query('UPDATE local_category_commands SET receipt=?,stored_bytes=? WHERE owner=? AND id=?').run(receiptText, size, owner, id)
        return result
      }).immediate()
    })) },
    lookup(keys: unknown): Promise<{ entries: CategoryEntry[] }> { return safe(async () => {
      if (!Array.isArray(keys) || !keys.length || keys.length > CATEGORY_BATCH_LIMIT || !keys.every(isCategoryKey)) fail('HOST_CATEGORY_INVALID')
      if (new Set(keys.map(key => `${key.sourceId}\0${key.threadId}`)).size !== keys.length) fail('HOST_CATEGORY_INVALID')
      const scope = scopes(), entries: CategoryEntry[] = []
      for (const key of keys) { await scope.account(key.sourceId); entries.push(await visible(read(key), scope)) }
      if (bytes({ entries }) > CATEGORY_RESPONSE_LIMIT) fail('HOST_CATEGORY_TOO_LARGE', 413)
      return { entries }
    }) },
    changes(after: number): Promise<CategoryPage> { return safe(async () => {
      if (!Number.isSafeInteger(after) || after < 0) fail('HOST_CATEGORY_INVALID')
      const snapshot = database.transaction(() => ({ head: head(), rows: database.query<{ data: string }, [string, number]>('SELECT data FROM local_category_overrides WHERE owner=? AND revision>? ORDER BY revision LIMIT 51').all(owner, after) })).deferred()
      if (after > snapshot.head) return { entries: [], cursor: snapshot.head, hasMore: false, resetRequired: true }
      const entries: CategoryEntry[] = [], scope = scopes()
      let cursor = after, size = 0
      for (const row of snapshot.rows.slice(0, CATEGORY_BATCH_LIMIT)) {
        const saved: CategoryEntry = JSON.parse(row.data), entry = await visible(saved, scope), cost = bytes(entry)
        if (size + cost > CATEGORY_RESPONSE_LIMIT - 1024) break
        entries.push(entry); size += cost; cursor = saved.revision
      }
      const hasMore = entries.length < snapshot.rows.length
      if (hasMore && !entries.length) fail('HOST_CATEGORY_TOO_LARGE', 413)
      return { entries, cursor: hasMore ? cursor : snapshot.head, hasMore, resetRequired: false }
    }) },
  }
}
