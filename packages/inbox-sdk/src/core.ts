import { Database } from 'bun:sqlite'
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Context, Effect, Either, Fiber, Layer, ManagedRuntime, Schedule } from 'effect'
import { createCredentialCrypto } from '../server/crypto'
import { sanitizeEmailBody } from '../server/sanitize'
import { createMediaStore } from './media'
import { mailFacts } from './mail-facts'
import { mailPreview } from './mail-preview'
import { ProviderError, ProviderMutationError, type InboxProvider, type MailAccount, type MailMessage, type SyncResult, type SendInput } from '../server/sdk/types'
import { CredentialError, InboxError, type Account, type BlobInfo, type ChangeEvent, type Changes, type CredentialContext, type CredentialState, type Draft,
  type DraftInput, type Folder, type Inbox, type InboxOptions, type Label, type Message,
  type MessageSummary, type MutationInput, type Operation, type Participant, type Policy,
  type Problem, type Query, type SyncCheckpoint, type SyncRequest, type ThreadSummary, type Connection, type ConnectionIdentity,
  type Mailbox, type MailboxCandidate, type MailboxInput, type MailboxMembership, type MailboxMessageSummary,
  type MailboxQuery, type MailboxSelector, type MailboxStateReceipt, type MailboxChangesPage } from './contracts'

type AccountRow = { id: string; owner: string; generation: number; status: Account['status']; data: string; native: string; credentials: string; connection_id: string; connection_generation: number; credential_version: number }
type ConnectionRow = { id: string; owner: string; generation: number; status: Connection['status']; credential_version: number; data: string; credentials: string }
type MailboxRow = { id: string; owner: string; source: string; connection: string; selector: string; data: string }
type MembershipRow = { owner: string; source: string; mailbox: string; message: string; data: string }
type MessageRow = { id: string; owner: string; account: string; generation: number; native_id: string; thread_id: string; confirmed: string; visible: string; body: string; local_labels: string; snoozed_until: string | null; revision: number; deleted: number; last_mutation_seq: number }
type BlobRow = { id: string; owner: string; account: string; generation: number; data: string; content: Uint8Array | null; message_id: string | null; attachment_id: string | null }
type DataRow = { id: string; owner: string; account: string; data: string }
type OperationRow = { seq: number; id: string; owner: string; account: string; generation: number; status: Operation['status']; type: Operation['type']; data: string; payload: string; fingerprint: string; key: string; lease: string | null; lease_until: number; next_at: number }
type MutationPayload = { input: MutationInput; before: Record<string, MessageSummary>; afterRevisions?: Record<string, number>; perMessageChanges?: Record<string, Changes> }
type MailboxInventory = { owner: string; ids: string[]; scopeHash: string; binding: string; seq: number; expires: number; limit: number; bytes: number; completed: boolean }
type SendPayload = { draft: Draft; holdUntil: number; nativeSource?: string; nativeThread?: string; inReplyTo?: string; references?: string[]; blobs: BlobInfo[] }

class Environment extends Context.Tag('inbox/Environment')<Environment, { database: Database; now: () => number }>() {}

function failure(error: unknown): InboxError {
  if (error instanceof CredentialError) return new InboxError(error.code, error.reason === 'revoked'
    ? 'Provider access has been revoked.' : 'Provider credentials are temporarily unavailable.', error.status, error.retryable)
  if (error instanceof InboxError) return error
  if (error instanceof ProviderError) {
    const status = { AUTHENTICATION: 409, AUTHORIZATION: 403, NOT_FOUND: 404, RATE_LIMITED: 429,
      INVALID_CURSOR: 409, UNSUPPORTED_OPERATION: 409, VALIDATION: 400, NETWORK: 502, UPSTREAM: 502 }[error.code]
    return new InboxError(error.code, `Mailbox operation failed: ${error.code.toLowerCase().replaceAll('_', ' ')}.`, status, error.retryable)
  }
  return new InboxError('INTERNAL', 'The inbox operation could not be completed.', 500)
}

function fingerprint(value: unknown): string {
  const canonical = (input: unknown): unknown => Array.isArray(input) ? input.map(canonical)
    : input && typeof input === 'object' ? Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : input
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

function text(value: unknown, field: string, max = 255): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) {
    throw new InboxError('VALIDATION', `${field} must be a nonempty string of at most ${max} characters.`)
  }
  return value.trim()
}

export function createInbox(options: InboxOptions): Inbox {
  const defaultPolicy: Policy = { remoteImages: false, undoSendSeconds: 10, ...options.defaultPolicy }
  if (Object.keys(defaultPolicy).some(key => !['remoteImages', 'undoSendSeconds'].includes(key)) ||
    typeof defaultPolicy.remoteImages !== 'boolean' || !Number.isInteger(defaultPolicy.undoSendSeconds) ||
    defaultPolicy.undoSendSeconds < 0 || defaultPolicy.undoSendSeconds > 120) {
    throw new InboxError('VALIDATION', 'Invalid default policy.')
  }
  const definitions = new Map(options.providers.map(definition => [definition.id, { ...definition, scopes: [...definition.scopes ?? []] }]))
  if (definitions.size !== options.providers.length) throw new InboxError('DUPLICATE_PROVIDER', 'Provider IDs must be unique.')
  const crypto = createCredentialCrypto({ NODE_ENV: 'production', CREDENTIAL_ENCRYPTION_KEY: options.encryptionKey })
  const ownsDatabase = !(options.database instanceof Database)
  const path = typeof options.database === 'string' ? options.database : ':memory:'
  if (ownsDatabase && path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const db = options.database instanceof Database ? options.database : new Database(path, { create: true })
  if (ownsDatabase && path !== ':memory:') chmodSync(path, 0o600)
  db.exec(`
    PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS sdk_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sdk_mailbox_actions (owner TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT NOT NULL, data TEXT NOT NULL, before_states TEXT NOT NULL, PRIMARY KEY(owner,id));
    CREATE TABLE IF NOT EXISTS sdk_accounts (id TEXT PRIMARY KEY, owner TEXT NOT NULL, generation INTEGER NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, native TEXT NOT NULL, credentials TEXT NOT NULL, UNIQUE(id,owner));
    CREATE TABLE IF NOT EXISTS sdk_messages (id TEXT PRIMARY KEY, owner TEXT NOT NULL, account TEXT NOT NULL, generation INTEGER NOT NULL, native_id TEXT NOT NULL, thread_id TEXT NOT NULL, confirmed TEXT NOT NULL, visible TEXT NOT NULL, body TEXT NOT NULL, local_labels TEXT NOT NULL DEFAULT '[]', snoozed_until TEXT, revision INTEGER NOT NULL DEFAULT 1, deleted INTEGER NOT NULL DEFAULT 0, last_mutation_seq INTEGER NOT NULL DEFAULT 0, received_at TEXT NOT NULL, folder TEXT NOT NULL, is_read INTEGER NOT NULL, is_starred INTEGER NOT NULL, subject TEXT NOT NULL, search_text TEXT NOT NULL, UNIQUE(account,generation,native_id), FOREIGN KEY(account,owner) REFERENCES sdk_accounts(id,owner));
    CREATE INDEX IF NOT EXISTS sdk_message_query ON sdk_messages(owner,deleted,received_at,id);
    CREATE INDEX IF NOT EXISTS sdk_message_account ON sdk_messages(owner,account,deleted,received_at,id);
    CREATE INDEX IF NOT EXISTS sdk_message_inventory ON sdk_messages(owner,account,deleted,received_at DESC,id,generation);
    CREATE INDEX IF NOT EXISTS sdk_message_thread ON sdk_messages(owner,thread_id,deleted,received_at,id);
    CREATE TABLE IF NOT EXISTS sdk_thread_keys (account TEXT NOT NULL, generation INTEGER NOT NULL, native_id TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(account,generation,native_id));
    CREATE TABLE IF NOT EXISTS sdk_native_keys (account TEXT NOT NULL, generation INTEGER NOT NULL, native_id TEXT NOT NULL, message_id TEXT NOT NULL, PRIMARY KEY(account,generation,native_id));
    CREATE TABLE IF NOT EXISTS sdk_folders (id TEXT PRIMARY KEY, owner TEXT NOT NULL, account TEXT NOT NULL, generation INTEGER NOT NULL, native_id TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(account,generation,native_id), FOREIGN KEY(account,owner) REFERENCES sdk_accounts(id,owner));
    CREATE TABLE IF NOT EXISTS sdk_labels (id TEXT PRIMARY KEY, owner TEXT NOT NULL, account TEXT NOT NULL, data TEXT NOT NULL, FOREIGN KEY(account,owner) REFERENCES sdk_accounts(id,owner));
    CREATE TABLE IF NOT EXISTS sdk_blobs (id TEXT PRIMARY KEY, owner TEXT NOT NULL, account TEXT NOT NULL, generation INTEGER NOT NULL, data TEXT NOT NULL, content BLOB, message_id TEXT, attachment_id TEXT, UNIQUE(account,generation,message_id,attachment_id), FOREIGN KEY(account,owner) REFERENCES sdk_accounts(id,owner));
    CREATE TABLE IF NOT EXISTS sdk_drafts (id TEXT PRIMARY KEY, owner TEXT NOT NULL, account TEXT NOT NULL, data TEXT NOT NULL, FOREIGN KEY(account,owner) REFERENCES sdk_accounts(id,owner));
    CREATE TABLE IF NOT EXISTS sdk_operations (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, owner TEXT NOT NULL, account TEXT NOT NULL, generation INTEGER NOT NULL, status TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, payload TEXT NOT NULL, fingerprint TEXT NOT NULL, key TEXT NOT NULL, lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, UNIQUE(owner,key), FOREIGN KEY(account,owner) REFERENCES sdk_accounts(id,owner));
    CREATE INDEX IF NOT EXISTS sdk_operation_due ON sdk_operations(status,next_at,seq);
    CREATE TABLE IF NOT EXISTS sdk_checkpoints (account TEXT NOT NULL, generation INTEGER NOT NULL, scope TEXT NOT NULL, lane TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(account,generation,scope,lane));
    CREATE TABLE IF NOT EXISTS sdk_cooldowns (account TEXT PRIMARY KEY, next_at INTEGER NOT NULL, failures INTEGER NOT NULL, hard INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sdk_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS sdk_event_owner ON sdk_events(owner,seq);
    CREATE TABLE IF NOT EXISTS sdk_states (owner TEXT PRIMARY KEY, seq INTEGER NOT NULL DEFAULT 0, floor INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS sdk_policy (owner TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sdk_connections (id TEXT PRIMARY KEY, owner TEXT NOT NULL, generation INTEGER NOT NULL, status TEXT NOT NULL, credential_version INTEGER NOT NULL DEFAULT 1, data TEXT NOT NULL, credentials TEXT NOT NULL, UNIQUE(id,owner));
    CREATE UNIQUE INDEX IF NOT EXISTS sdk_verified_connection_identity ON sdk_connections(owner,json_extract(data,'$.providerId'),json_extract(data,'$.identity.issuer'),json_extract(data,'$.identity.subject'),json_extract(data,'$.identity.registrationId')) WHERE json_type(data,'$.identity')='object';
    CREATE TABLE IF NOT EXISTS sdk_source_connections (source TEXT NOT NULL, owner TEXT NOT NULL, connection TEXT NOT NULL, is_primary INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(source,connection), UNIQUE(source,connection,owner), FOREIGN KEY(source,owner) REFERENCES sdk_accounts(id,owner), FOREIGN KEY(connection,owner) REFERENCES sdk_connections(id,owner));
    CREATE UNIQUE INDEX IF NOT EXISTS sdk_primary_source_connection ON sdk_source_connections(source) WHERE is_primary=1;
    CREATE UNIQUE INDEX IF NOT EXISTS sdk_message_source_owner ON sdk_messages(id,owner,account);
    CREATE TABLE IF NOT EXISTS sdk_mailboxes (id TEXT PRIMARY KEY, owner TEXT NOT NULL, source TEXT NOT NULL, connection TEXT NOT NULL, selector TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(id,owner,source), UNIQUE(owner,source,selector), FOREIGN KEY(source,connection,owner) REFERENCES sdk_source_connections(source,connection,owner));
    CREATE INDEX IF NOT EXISTS sdk_mailbox_owner ON sdk_mailboxes(owner,source);
    CREATE TABLE IF NOT EXISTS sdk_memberships (owner TEXT NOT NULL, source TEXT NOT NULL, mailbox TEXT NOT NULL, message TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(mailbox,message), FOREIGN KEY(mailbox,owner,source) REFERENCES sdk_mailboxes(id,owner,source), FOREIGN KEY(message,owner,source) REFERENCES sdk_messages(id,owner,account));
    CREATE INDEX IF NOT EXISTS sdk_membership_message ON sdk_memberships(owner,source,message);
    CREATE INDEX IF NOT EXISTS sdk_membership_read ON sdk_memberships(owner,source,message,mailbox);
    CREATE TABLE IF NOT EXISTS sdk_delivery_evidence (owner TEXT NOT NULL, source TEXT NOT NULL, message TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(message,kind,value), FOREIGN KEY(message,owner,source) REFERENCES sdk_messages(id,owner,account));
    CREATE TABLE IF NOT EXISTS sdk_connection_refresh (connection TEXT PRIMARY KEY, owner TEXT NOT NULL, lease TEXT NOT NULL, until INTEGER NOT NULL, FOREIGN KEY(connection,owner) REFERENCES sdk_connections(id,owner));
  `)
  db.query('INSERT OR IGNORE INTO sdk_meta VALUES (?,?)').run('epoch', randomUUID())
  const epoch = db.query<{ value: string }, []>("SELECT value FROM sdk_meta WHERE key='epoch'").get()!.value
  const now = options.now ?? Date.now
  // Capture only the existing indexed ID boundary, never bodies at startup.
  // New ingestion already derives previews and needs no historical repair.
  type PreviewRepair = { through: string; after: string; deferred: string[]; retryAt: number; done: boolean; fallbacks: number }
  db.query(`INSERT OR IGNORE INTO sdk_meta(key,value) SELECT 'mail-preview-v1',
    json_object('through',coalesce(max(id),''),'after','','deferred',json('[]'),'retryAt',0,'done',CASE WHEN max(id) IS NULL THEN json('true') ELSE json('false') END,'fallbacks',0)
    FROM sdk_messages`).run()
  // Existing source IDs and encrypted envelopes remain valid; each gets one isolated grant.
  db.transaction(() => {
    const sources = db.query<AccountRow, []>('SELECT * FROM sdk_accounts').all()
    for (const source of sources) {
      if (db.query('SELECT 1 FROM sdk_source_connections WHERE source=?').get(source.id)) continue
      const account = JSON.parse(source.data) as Account
      const connection: Connection = { id: source.id, providerId: account.providerId, name: account.name,
        status: source.status, generation: 1, sourceIds: [source.id], identity: null, createdAt: new Date(now()).toISOString() }
      db.query('INSERT INTO sdk_connections(id,owner,generation,status,data,credentials) VALUES (?,?,?,?,?,?)').run(connection.id, source.owner, 1, source.status, JSON.stringify(connection), source.credentials)
      db.query('INSERT INTO sdk_source_connections(source,owner,connection) VALUES (?,?,?)').run(source.id, source.owner, connection.id)
      account.connectionId = connection.id
      db.query('UPDATE sdk_accounts SET credentials=\'\',data=? WHERE id=?').run(JSON.stringify(account), source.id)
      const mailbox: Mailbox = { id: source.id, sourceId: source.id, connectionId: connection.id, name: account.name,
        selector: { kind: 'all' }, status: source.status === 'disconnected' ? 'paused' : 'active', defaultSender: account.email || null, revision: 1, receiving: 'unverified' }
      db.query('INSERT INTO sdk_mailboxes VALUES (?,?,?,?,?,?)').run(mailbox.id, source.owner, source.id, connection.id, JSON.stringify(mailbox.selector), JSON.stringify(mailbox))
      for (const message of db.query<MessageRow, [string]>('SELECT * FROM sdk_messages WHERE account=? AND deleted=0').all(source.id)) {
        const state: MailboxMembership = { mailboxId: mailbox.id, messageId: message.id, revision: 1, done: false, snoozedUntil: message.snoozed_until }
        db.query('INSERT INTO sdk_memberships VALUES (?,?,?,?,?)').run(source.owner, source.id, mailbox.id, message.id, JSON.stringify(state))
      }
    }
    db.query("INSERT OR REPLACE INTO sdk_meta(key,value) VALUES ('connection-pilot-schema','1')").run()
  }).immediate()
  let media: ReturnType<typeof createMediaStore>
  try { media = createMediaStore({ database: db, now, options: options.media, injectedFetch: options.fetch !== undefined, log: options.log }) }
  catch (error) { if (ownsDatabase) db.close(); throw error }
  const instances = new Map<string, Promise<InboxProvider>>()
  const instanceVersions = new Map<string, number>()
  const controllers = new Map<string, AbortController>()
  const activeRequests = new Map<string, number>()
  const retiring = new Set<string>()
  const disconnecting = new Set<Promise<void>>()
  const refreshes = new Map<string, Promise<ConnectionRow>>()
  const credentialUpdates = new Set<Promise<CredentialState>>()
  const syncing = new Map<string, Promise<{ synchronized: number; hasMore: boolean; state: string }>>()
  const listeners = new Map<string, Set<() => void>>()
  const inventories = new Map<string, MailboxInventory>()
  let inventoryBytes = 0
  const INVENTORY_BYTES = 32 * 1024 * 1024
  const READ_BYTES = 4 * 1024 * 1024
  const READ_MEMBERSHIPS = 5000
  const retention = Math.max(1, Math.trunc(options.eventRetention ?? 10_000))
  const leaseMs = Math.max(100, options.leaseMs ?? 30_000)
  const concurrency = Math.max(1, Math.min(32, options.concurrency ?? 4))
  let closed = false
  let stopping = false
  let due: Promise<void> | undefined
  let polling: Promise<void> | undefined
  let background: Fiber.RuntimeFiber<unknown, unknown>[] = []
  const layer = Layer.scoped(Environment, Effect.acquireRelease(
    Effect.succeed({ database: db, now }),
    () => Effect.promise(async () => {
      await Promise.allSettled([...instances.values()].map(async provider => (await provider).disconnect()))
      instances.clear()
      listeners.clear()
      inventories.clear(); inventoryBytes = 0
      if (ownsDatabase) db.close()
    }),
  ))
  const runtime = ManagedRuntime.make(layer)

  async function run<T>(action: () => T | Promise<T>): Promise<T> {
    if (closed || stopping) throw new InboxError('CLOSED', 'The inbox instance is closed.', 503)
    const result = await runtime.runPromise(Effect.gen(function* () {
      yield* Environment
      return yield* Effect.tryPromise({ try: async () => action(), catch: failure }).pipe(Effect.either)
    }))
    if (Either.isLeft(result)) throw result.left
    return result.right
  }

  function ownerId(owner: string): void {
    if (typeof owner !== 'string' || !owner.trim()) throw new InboxError('UNAUTHORIZED', 'Authentication is required.', 401)
  }

  function accountRow(owner: string, id: string, connected = false): AccountRow {
    ownerId(owner)
    const row = db.query<AccountRow, [string, string]>(`SELECT a.id,a.owner,a.generation,a.status,a.data,a.native,c.credentials,c.id connection_id,c.generation connection_generation,c.credential_version
      FROM sdk_accounts a JOIN sdk_source_connections s ON s.source=a.id AND s.owner=a.owner AND s.is_primary=1
      JOIN sdk_connections c ON c.id=s.connection AND c.owner=s.owner WHERE a.owner=? AND a.id=?`).get(owner, id)
    if (!row) throw new InboxError('NOT_FOUND', 'Account not found.', 404)
    if (connected && row.status !== 'connected') throw new InboxError('RECONNECT_REQUIRED', 'Reconnect this account before continuing.', 409)
    return row
  }

  function current(row: AccountRow): boolean {
    const value = db.query<{ generation: number; status: string; connection_generation: number; connection_status: string }, [string, string]>(`SELECT a.generation,a.status,c.generation connection_generation,c.status connection_status
      FROM sdk_accounts a JOIN sdk_source_connections s ON s.source=a.id AND s.owner=a.owner AND s.is_primary=1 JOIN sdk_connections c ON c.id=s.connection AND c.owner=s.owner
      WHERE a.id=? AND a.owner=?`).get(row.id, row.owner)
    return value?.generation === row.generation && value.status === 'connected' && value.connection_generation === row.connection_generation && value.connection_status === 'connected'
  }

  function generationKey(row: AccountRow): string { return `${row.owner}\0${row.id}\0${row.generation}\0${row.connection_id}\0${row.connection_generation}\0${row.credential_version}` }

  function connectionRow(owner: string, id: string): ConnectionRow {
    ownerId(owner)
    const row = db.query<ConnectionRow, [string, string]>('SELECT * FROM sdk_connections WHERE owner=? AND id=?').get(owner, id)
    if (!row) throw new InboxError('NOT_FOUND', 'Connection not found.', 404)
    return row
  }

  function publicConnection(row: ConnectionRow): Connection {
    return { ...JSON.parse(row.data), status: row.status, generation: row.generation,
      sourceIds: db.query<{ source: string }, [string, string]>('SELECT source FROM sdk_source_connections WHERE owner=? AND connection=? ORDER BY source').all(row.owner, row.id).map(value => value.source) }
  }

  function publicCredentialState(row: ConnectionRow): CredentialState {
    return { connectionId: row.id, generation: row.generation, version: row.credential_version, status: row.status }
  }

  function credentialRecord(value: Record<string, unknown>): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InboxError('INVALID_CREDENTIALS', 'Credentials must be an object.')
    try {
      const encoded = JSON.stringify(value, (_key, item) => {
        if (['function', 'symbol', 'bigint'].includes(typeof item) || typeof item === 'number' && !Number.isFinite(item)) throw new Error()
        return item
      })
      if (Buffer.byteLength(encoded) > 1024 * 1024) throw new Error()
      const result = JSON.parse(encoded) as Record<string, unknown>
      if (result.expiresAt !== undefined && result.expiresAt !== null &&
        (!['string', 'number'].includes(typeof result.expiresAt) || !Number.isFinite(new Date(result.expiresAt as string | number).getTime()))) throw new Error()
      return result
    } catch { throw new InboxError('INVALID_CREDENTIALS', 'Credentials must be bounded JSON data.') }
  }

  function checkedIdentity(identity: ConnectionIdentity): ConnectionIdentity {
    return { issuer: text(identity?.issuer, 'Identity issuer', 2048), subject: text(identity?.subject, 'Identity subject', 1024),
      registrationId: text(identity?.registrationId, 'Identity registration', 1024) }
  }

  function credentialCall<T>(signal: AbortSignal, action: () => Promise<T> | T): Promise<T> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(new CredentialError('unavailable', 'Credential resolution was interrupted.'))
      if (signal.aborted) { abort(); return }
      signal.addEventListener('abort', abort, { once: true })
      Promise.resolve().then(action).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
  }

  function retireInstance(key: string, abort: boolean): void {
    if (abort) controllers.get(key)?.abort()
    retiring.add(key)
    if (!abort && (activeRequests.get(key) ?? 0) > 0) return
    const instance = instances.get(key)
    instances.delete(key); instanceVersions.delete(key); controllers.delete(key); retiring.delete(key)
    if (instance) {
      const closing = instance.then(provider => provider.disconnect()).catch(() => {}).finally(() => disconnecting.delete(closing))
      disconnecting.add(closing)
    }
  }

  function retireSource(owner: string, id: string, abort = true, version = Number.MAX_SAFE_INTEGER): void {
    const prefix = `${owner}\0${id}\0`
    for (const key of new Set([...controllers.keys(), ...instances.keys()])) {
      if (key.startsWith(prefix) && (abort || (instanceVersions.get(key) ?? 0) <= version)) retireInstance(key, abort)
    }
  }

  function retireCredentials(grant: ConnectionRow, abort = true): void {
    for (const { source } of db.query<{ source: string }, [string, string]>(
      'SELECT source FROM sdk_source_connections WHERE connection=? AND owner=? AND is_primary=1').all(grant.id, grant.owner)) {
      retireSource(grant.owner, source, abort, grant.credential_version)
    }
  }

  function saveCredentials(original: ConnectionRow, credentials: Record<string, unknown>, recover = false,
    profiles: Array<{ sourceId: string; native: MailAccount; provider: InboxProvider }> = []): ConnectionRow {
    const saved = transaction(() => {
      const fresh = connectionRow(original.owner, original.id)
      if (fresh.generation !== original.generation || fresh.credential_version !== original.credential_version ||
        fresh.status === 'disconnected' || !recover && fresh.status !== 'connected') {
        throw new InboxError('CREDENTIALS_CHANGED', 'Connection credentials changed during this request.', 409, true)
      }
      const data = { ...publicConnection(fresh), status: 'connected' as const, generation: fresh.generation + Number(recover) }
      db.query('UPDATE sdk_connections SET credentials=?,credential_version=credential_version+1,generation=?,status=?,data=? WHERE id=? AND owner=? AND generation=? AND credential_version=?')
        .run(crypto.encryptCredential(JSON.stringify(credentials), original.owner, original.id), data.generation, data.status, JSON.stringify(data), original.id, original.owner, original.generation, original.credential_version)
      if (recover) db.query('DELETE FROM sdk_connection_refresh WHERE connection=? AND owner=?').run(original.id, original.owner)
      for (const sourceId of data.sourceIds) {
        const source = accountRow(original.owner, sourceId)
        if (source.connection_id !== original.id || source.status === 'disconnected') continue
        const account = JSON.parse(source.data) as Account
        const profile = profiles.find(profile => profile.sourceId === sourceId)
        const needsRecovery = account.status === 'reconnect_required' || ['AUTHENTICATION', 'CREDENTIALS_UNAVAILABLE', 'CREDENTIALS_REVOKED'].includes(account.sync.problem ?? '')
        if (profile || needsRecovery) {
          account.status = 'connected'; account.revision++
          if (needsRecovery) { account.sync.problem = null; db.query('DELETE FROM sdk_cooldowns WHERE account=?').run(sourceId) }
          if (profile) {
            account.name = profile.native.name || account.name; account.email = profile.native.email
            account.capabilities = { ...profile.provider.capabilities }
            account.features.scheduledSend = profile.provider.capabilities.send; account.features.undoSend = profile.provider.capabilities.send
          }
          db.query('UPDATE sdk_accounts SET status=?,data=?,native=? WHERE id=? AND owner=?')
            .run(account.status, JSON.stringify(account), profile ? JSON.stringify(profile.native) : source.native, sourceId, original.owner)
          event(original.owner, 'account.updated', sourceId, sourceId)
        }
        if (recover) {
          for (const row of db.query<OperationRow, [string, string]>("SELECT * FROM sdk_operations WHERE owner=? AND account=? AND status='processing'").all(original.owner, sourceId)) {
            const operation = JSON.parse(row.data) as Operation
            operation.status = row.type === 'send' ? 'uncertain' : 'pending'
            if (row.type === 'send') operation.problem = { code: 'SEND_UNCERTAIN', message: 'Credentials changed while a send was processing. Reconcile before retrying.', retryable: false }
            saveOperation(row, operation, now())
            db.query('UPDATE sdk_operations SET lease=NULL,lease_until=0 WHERE id=?').run(row.id)
          }
        }
      }
      event(original.owner, 'connection.updated', null, original.id)
      return connectionRow(original.owner, original.id)
    })
    retireCredentials(original, recover)
    return saved
  }

  function revokeCredentials(original: ConnectionRow): void {
    const revoked = transaction(() => {
      const fresh = connectionRow(original.owner, original.id)
      if (fresh.generation !== original.generation || fresh.credential_version !== original.credential_version || fresh.status !== 'connected') return false
      const connection = publicConnection(fresh)
      connection.status = 'reconnect_required'
      db.query('UPDATE sdk_connections SET status=?,data=? WHERE id=? AND owner=?').run(connection.status, JSON.stringify(connection), original.id, original.owner)
      for (const sourceId of connection.sourceIds) {
        const source = accountRow(original.owner, sourceId)
        if (source.connection_id !== original.id || source.status === 'disconnected') continue
        const account = JSON.parse(source.data) as Account
        account.status = 'reconnect_required'; account.sync.problem = 'CREDENTIALS_REVOKED'; account.revision++
        db.query('UPDATE sdk_accounts SET status=?,data=? WHERE id=? AND owner=?').run(account.status, JSON.stringify(account), sourceId, original.owner)
        event(original.owner, 'account.updated', sourceId, sourceId)
      }
      event(original.owner, 'connection.updated', null, original.id)
      return true
    })
    if (revoked) retireCredentials(original)
  }

  function sourceSelection(owner: string, sourceId: string): { key: string; count: number; scopes: Array<{ kind: 'domain' | 'address'; value: string }> | undefined } {
    const selected = db.query<MailboxRow, [string, string]>("SELECT * FROM sdk_mailboxes WHERE owner=? AND source=? AND json_extract(data,'$.status')='active' ORDER BY selector").all(owner, sourceId)
    const values = selected.map(row => JSON.parse(row.selector) as MailboxSelector)
    return { key: fingerprint(values), count: values.length,
      scopes: values.some(value => value.kind === 'all') ? undefined : values.filter((value): value is { kind: 'domain' | 'address'; value: string } => value.kind !== 'all') }
  }

  function token(owner: string, seq: number, query?: string): string {
    const value = Buffer.from(JSON.stringify([epoch, owner, seq, query ?? null])).toString('base64url')
    const signature = createHmac('sha256', options.encryptionKey).update(value).digest('base64url')
    return `${value}.${signature}`
  }

  function decode(owner: string, value: string): { seq: number; query: string | null; epoch: string } {
    try {
      if (value.length > 2048) throw new Error()
      const [body, signature, extra] = value.split('.')
      const expected = createHmac('sha256', options.encryptionKey).update(body!).digest()
      const actual = Buffer.from(signature!, 'base64url')
      if (extra || actual.length !== expected.length || !timingSafeEqual(expected, actual)) throw new Error()
      const decoded = JSON.parse(Buffer.from(body!, 'base64url').toString())
      if (decoded[1] !== owner || !Number.isSafeInteger(decoded[2]) || decoded[2] < 0) throw new Error()
      return { epoch: decoded[0], seq: decoded[2], query: decoded[3] }
    } catch { throw new InboxError('INVALID_CURSOR', 'The continuation token is invalid for this account.', 400) }
  }

  function sequence(owner: string): number {
    return db.query<{ seq: number }, [string]>('SELECT seq FROM sdk_states WHERE owner=?').get(owner)?.seq ?? 0
  }

  let changedOwners = new Set<string>()
  function transaction<T>(action: () => T): T {
    const outer = changedOwners
    changedOwners = new Set()
    try {
      const result = db.transaction(() => {
        const result = action()
        for (const owner of changedOwners) {
          const cut = db.query<{ seq: number }, [string, number]>('SELECT seq FROM sdk_events WHERE owner=? ORDER BY seq DESC LIMIT 1 OFFSET ?').get(owner, retention)
          if (cut) {
            db.query('DELETE FROM sdk_events WHERE owner=? AND seq<=?').run(owner, cut.seq)
            db.query('UPDATE sdk_states SET floor=? WHERE owner=?').run(cut.seq, owner)
          }
        }
        return result
      }).immediate()
      for (const owner of changedOwners) for (const listener of listeners.get(owner) ?? []) {
        try { listener() } catch { /* Subscribers cannot roll back committed mail. */ }
      }
      return result
    } finally { changedOwners = outer }
  }

  function event(owner: string, type: ChangeEvent['type'], accountId: string | null, entityId: string, change: ChangeEvent['change'] = 'updated', reason: ChangeEvent['reason'] = 'mutation', mailboxId?: string): void {
    const data = { type, accountId, entityId, change, reason, at: new Date(now()).toISOString(), ...(mailboxId ? { mailboxId } : {}) }
    const seq = Number(db.query('INSERT INTO sdk_events(owner,data) VALUES (?,?)').run(owner, JSON.stringify(data)).lastInsertRowid)
    db.query('INSERT INTO sdk_states(owner,seq) VALUES (?,?) ON CONFLICT(owner) DO UPDATE SET seq=excluded.seq').run(owner, seq)
    if (type === 'mail.changed' && reason === 'mutation') db.query('UPDATE sdk_messages SET last_mutation_seq=? WHERE owner=? AND id=?').run(seq, owner, entityId)
    changedOwners.add(owner)
  }

  function getPolicy(owner: string): Policy {
    ownerId(owner)
    const row = db.query<{ data: string }, [string]>('SELECT data FROM sdk_policy WHERE owner=?').get(owner)
    return row ? JSON.parse(row.data) : { ...defaultPolicy }
  }

  function selector(value: MailboxSelector): MailboxSelector {
    if (!value || typeof value !== 'object') throw new InboxError('VALIDATION', 'A mailbox selector is required.')
    if (value.kind === 'all') return { kind: 'all' }
    if (value.kind !== 'domain' && value.kind !== 'address') throw new InboxError('VALIDATION', 'Unsupported mailbox selector.')
    const clean = text(value.value, 'Mailbox selector', 320)
    if (value.kind === 'domain') {
      if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(clean)) throw new InboxError('VALIDATION', 'Invalid domain.')
      return { kind: 'domain', value: clean.toLowerCase() }
    }
    if (!/^[^\s<>@]+@[^\s<>@]+$/.test(clean)) throw new InboxError('VALIDATION', 'Invalid mailbox address.')
    const at = clean.lastIndexOf('@')
    return { kind: 'address', value: `${clean.slice(0, at)}@${clean.slice(at + 1).toLowerCase()}` }
  }

  function mailboxRow(owner: string, id: string, attached = false): MailboxRow {
    ownerId(owner)
    const row = db.query<MailboxRow, [string, string]>('SELECT * FROM sdk_mailboxes WHERE owner=? AND id=?').get(owner, id)
    if (!row || (attached && (JSON.parse(row.data) as Mailbox).status === 'detached')) throw new InboxError('NOT_FOUND', 'Mailbox not found.', 404)
    return row
  }

  function membership(owner: string, mailboxId: string, messageId: string): MailboxMembership {
    const box = mailboxRow(owner, mailboxId, true)
    const msg = messageRow(owner, messageId)
    if (box.source !== msg.account) throw new InboxError('NOT_FOUND', 'Message is not in this mailbox.', 404)
    const row = db.query<MembershipRow, [string, string, string]>('SELECT * FROM sdk_memberships WHERE owner=? AND mailbox=? AND message=?').get(owner, mailboxId, messageId)
    if (!row) throw new InboxError('NOT_FOUND', 'Message is not in this mailbox.', 404)
    return JSON.parse(row.data)
  }

  function matchesMailbox(row: MailboxRow, messageId: string): boolean {
    const scope = JSON.parse(row.selector) as MailboxSelector
    if (scope.kind === 'all') return true
    return !!db.query('SELECT 1 FROM sdk_delivery_evidence WHERE owner=? AND source=? AND message=? AND kind=? AND value=?').get(row.owner, row.source, messageId, scope.kind, scope.value)
  }

  function materializeMailbox(row: MailboxRow, messageId: string, reason: ChangeEvent['reason']): void {
    if ((JSON.parse(row.data) as Mailbox).status !== 'active' || !matchesMailbox(row, messageId)) return
    const state: MailboxMembership = { mailboxId: row.id, messageId, revision: 1, done: false, snoozedUntil: null }
    const inserted = db.query('INSERT OR IGNORE INTO sdk_memberships(owner,source,mailbox,message,data) VALUES (?,?,?,?,?)').run(row.owner, row.source, row.id, messageId, JSON.stringify(state))
    if (inserted.changes && row.id !== row.source) event(row.owner, 'membership.updated', row.source, messageId, 'created', reason === 'arrival' ? 'initial' : reason, row.id)
  }

  function recordEvidence(row: AccountRow, mail: MailMessage, id: string, reason: ChangeEvent['reason']): void {
    for (const [kind, values] of [['domain', mail.sourceDomains], ['address', mail.deliveryRecipients]] as const) {
      for (const value of values ?? []) {
        let normalized: MailboxSelector
        try { normalized = selector({ kind, value }) } catch { throw new InboxError('INVALID_PROVIDER', 'Provider supplied invalid delivery evidence.', 502) }
        if (normalized.kind !== 'all') db.query('INSERT OR IGNORE INTO sdk_delivery_evidence VALUES (?,?,?,?,?)').run(row.owner, row.id, id, kind, normalized.value)
      }
    }
    // Partial observations add proof. Omission is never a retraction or a delivery guess from To/CC.
    for (const mailbox of db.query<MailboxRow, [string, string]>('SELECT * FROM sdk_mailboxes WHERE owner=? AND source=?').all(row.owner, row.id)) materializeMailbox(mailbox, id, reason)
  }

  async function candidates(owner: string, connectionId: string): Promise<MailboxCandidate[]> {
    const grant = connectionRow(owner, connectionId)
    if (grant.status !== 'connected') throw new InboxError('RECONNECT_REQUIRED', 'Reconnect this provider before discovering mailboxes.', 409)
    const result: MailboxCandidate[] = []
    for (const sourceId of publicConnection(grant).sourceIds) {
      const source = accountRow(owner, sourceId, true)
      const definition = definitions.get((JSON.parse(source.data) as Account).providerId)!
      const native = JSON.parse(source.native)
      if (!definition.discover) {
        result.push({ sourceId, name: native.name || native.email || definition.name, selector: { kind: 'all' },
          canReceive: true, canSend: (JSON.parse(source.data) as Account).capabilities.send, canFilter: true,
          identities: [...new Set([native.email, ...native.aliases ?? []].filter((email: unknown) => typeof email === 'string' && email.includes('@')))] as string[] })
        continue
      }
      const discovered = await io(source, provider => definition.discover!(provider))
      if (!current(source)) throw new InboxError('RECONNECT_REQUIRED', 'Connection changed during discovery.', 409)
      const identities = discovered.identities.map(value => selector({ kind: 'address', value: value.email }))
        .filter((value): value is { kind: 'address'; value: string } => value.kind === 'address').map(value => value.value)
      const aliases = [...new Set(identities)]
      db.query('UPDATE sdk_accounts SET native=? WHERE id=? AND owner=? AND generation=?').run(JSON.stringify({ ...native, aliases }), source.id, owner, source.generation)
      for (const offered of discovered.sources) {
        const scope = selector(offered)
        if (scope.kind === 'all') continue
        result.push({ sourceId, name: scope.value, selector: scope, canReceive: offered.canReceive,
          canSend: offered.canSend, canFilter: offered.canFilter === true,
          identities: aliases.filter(email => scope.kind === 'address' ? email === scope.value : email.split('@').at(-1) === scope.value),
          ...(offered.unavailableReason ? { unavailableReason: offered.unavailableReason } : {}) })
      }
    }
    return result
  }

  function assertMailboxSender(box: Mailbox, from: string): void {
    if (box.selector.kind === 'all') return
    const fromSelector = selector({ kind: 'address', value: from })
    if (fromSelector.kind !== 'address' || (box.selector.kind === 'address'
      ? fromSelector.value !== box.selector.value : fromSelector.value.split('@').at(-1) !== box.selector.value)) {
      throw new InboxError('FORBIDDEN_SENDER', 'The sender does not belong to the selected mailbox.', 403)
    }
  }

  function mailboxQuery(owner: string, input: MailboxQuery): { query: Query; ids: string[]; sql: string; params: Array<string | number>; key: string } {
    ownerId(owner)
    if (!Array.isArray(input.mailboxIds) || !input.mailboxIds.length || input.mailboxIds.length > 50) throw new InboxError('VALIDATION', 'Select between 1 and 50 mailboxes.')
    for (const id of input.mailboxIds) mailboxRow(owner, id, true)
    if ((input.done !== undefined && typeof input.done !== 'boolean') || (input.snoozed !== undefined && typeof input.snoozed !== 'boolean')) throw new InboxError('VALIDATION', 'Mailbox workflow filters must be boolean.')
    const ids = [...new Set(input.mailboxIds)].sort()
    const { mailboxIds: _ids, done, snoozed, ...query } = input
    const base = where(owner, query, true)
    const placeholders = ids.map(() => '?').join(',')
    let match = `v.owner=m.owner AND v.source=m.account AND v.message=m.id AND v.mailbox IN (${placeholders})`
    const params: Array<string | number> = [...base.params, ...ids]
    if (done !== undefined) { match += " AND json_extract(v.data,'$.done')=?"; params.push(Number(done)) }
    if (snoozed !== undefined) match += ` AND json_extract(v.data,'$.snoozedUntil') IS ${snoozed ? 'NOT ' : ''}NULL`
    return { ids, query, sql: `${base.sql} AND EXISTS(SELECT 1 FROM sdk_memberships v WHERE ${match})`, params,
      key: `mailboxes:${fingerprint({ ids, done, snoozed })}` }
  }

  function mailboxSummary(row: MessageRow, ids: string[]): MailboxMessageSummary {
    const { snoozedUntil: _legacy, ...value } = summary(row)
    const memberships = db.query<MembershipRow, (string | number)[]>(`SELECT * FROM sdk_memberships WHERE owner=? AND message=? AND mailbox IN (${ids.map(() => '?').join(',')}) ORDER BY mailbox`).all(row.owner, row.id, ...ids).map(value => JSON.parse(value.data))
    return { ...value, sourceId: row.account, memberships }
  }

  function mailboxReadScope(owner: string, mailboxIds: string[]) {
    ownerId(owner)
    if (!Array.isArray(mailboxIds) || !mailboxIds.length || mailboxIds.length > 1000) throw new InboxError('VALIDATION', 'Select between 1 and 1000 mailboxes.')
    const ids = [...new Set(mailboxIds.map(value => text(value, 'Mailbox ID', 512)))].sort()
    const json = JSON.stringify(ids)
    const rows = db.query<{ id: string; source: string; connection: string; selector: string; status: string; source_generation: number; source_status: string; connection_generation: number; connection_status: string }, [string, string]>(`
      SELECT b.id,b.source,b.connection,b.selector,json_extract(b.data,'$.status') status,
        a.generation source_generation,a.status source_status,c.generation connection_generation,c.status connection_status
      FROM sdk_mailboxes b JOIN sdk_accounts a ON a.id=b.source AND a.owner=b.owner
      JOIN sdk_connections c ON c.id=b.connection AND c.owner=b.owner
      JOIN sdk_source_connections s ON s.source=b.source AND s.connection=b.connection AND s.owner=b.owner
      WHERE b.owner=? AND b.id IN (SELECT value FROM json_each(?)) ORDER BY b.id`).all(owner, json)
    if (rows.length !== ids.length) throw new InboxError('NOT_FOUND', 'Mailbox not found.', 404)
    const sources = new Set(rows.map(row => row.source))
    return { ids, json, sources, sourceJson: JSON.stringify([...sources]), hash: fingerprint(ids), binding: fingerprint(rows),
      attached: rows.every(row => row.status === 'active' || row.status === 'paused'), overhead: 4096 + json.length * 2 + JSON.stringify(rows).length * 2 }
  }

  function mailboxReadLimit(value: number | undefined): number {
    const limit = value ?? 500
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new InboxError('VALIDATION', 'Read pages contain between 1 and 500 entries.')
    return limit
  }

  function discardInventory(id: string): void {
    const saved = inventories.get(id)
    if (saved) { inventoryBytes -= saved.bytes; inventories.delete(id) }
  }

  function rememberInventory(id: string, value: MailboxInventory): void {
    for (const [key, saved] of inventories) if (saved.expires <= now()) discardInventory(key)
    if (value.bytes > INVENTORY_BYTES) throw new InboxError('SNAPSHOT_LIMIT', 'The mailbox inventory exceeds its memory budget.', 413)
    while (inventories.size >= 8 || inventoryBytes + value.bytes > INVENTORY_BYTES || [...inventories.values()].filter(saved => saved.owner === value.owner).length >= 4) {
      const ownerFull = [...inventories.values()].filter(saved => saved.owner === value.owner).length >= 4
      const candidates = [...inventories].filter(([, saved]) => !ownerFull || saved.owner === value.owner)
      const victim = candidates.find(([, saved]) => saved.completed) ?? candidates[0]
      if (!victim) throw new InboxError('SNAPSHOT_LIMIT', 'Mailbox inventory capacity is unavailable.', 429, true)
      discardInventory(victim[0])
    }
    inventories.set(id, value); inventoryBytes += value.bytes
  }

  function appendInventory(id: string, value: MailboxInventory, messageId: string): void {
    const bytes = 64 + messageId.length * 2
    if (value.ids.length >= 100000 || value.bytes + bytes > INVENTORY_BYTES) throw new InboxError('SNAPSHOT_LIMIT', 'The mailbox inventory exceeds its bounded capacity.', 413)
    while (inventoryBytes + bytes > INVENTORY_BYTES) {
      const candidates = [...inventories].filter(([key]) => key !== id)
      const victim = candidates.find(([, saved]) => saved.completed) ?? candidates[0]
      if (!victim) throw new InboxError('SNAPSHOT_LIMIT', 'The mailbox inventory exceeds its memory budget.', 413)
      discardInventory(victim[0])
    }
    value.ids.push(messageId); value.bytes += bytes; inventoryBytes += bytes
  }

  /** Hydrate only a consecutive bounded ID prefix, never one membership query per message. */
  function mailboxReadRows(owner: string, scope: ReturnType<typeof mailboxReadScope>, ids: string[]) {
    type Meta = { id: string; account: string; revision: number; deleted: number; generation: number; source_generation: number; bytes: number }
    const items = new Map<string, MailboxMessageSummary>()
    const rows = new Map<string, Meta>()
    if (!ids.length) return { items, rows, consumed: 0 }
    const json = JSON.stringify(ids)
    for (const row of db.query<Meta, [string, string]>(`SELECT m.id,m.account,m.revision,m.deleted,m.generation,a.generation source_generation,length(CAST(m.visible AS BLOB)) bytes
      FROM sdk_messages m JOIN sdk_accounts a ON a.id=m.account AND a.owner=m.owner WHERE m.owner=? AND m.id IN (SELECT value FROM json_each(?))`).all(owner, json)) rows.set(row.id, row)
    const wanted = ids.flatMap((id, ordinal) => {
      const row = rows.get(id)
      return row && !row.deleted && row.generation === row.source_generation && scope.sources.has(row.account) ? [{ id, source: row.account, ordinal }] : []
    })
    // CROSS JOIN keeps this bounded ID list outermost. Letting SQLite reorder it
    // scanned the entire source membership index once per page on the 50k cache.
    const membershipRows = db.query<{ ordinal: number; message: string; data: string }, [string, string, string]>(`
      SELECT json_extract(w.value,'$.ordinal') ordinal,v.message,v.data FROM json_each(?) w
      CROSS JOIN sdk_memberships v INDEXED BY sdk_membership_read ON v.owner=? AND v.source=json_extract(w.value,'$.source') AND v.message=json_extract(w.value,'$.id')
      WHERE v.mailbox IN (SELECT value FROM json_each(?)) ORDER BY ordinal,v.mailbox LIMIT ${READ_MEMBERSHIPS + 1}`).all(JSON.stringify(wanted), owner, scope.json)
    // If the budget cuts through a membership group, leave that whole message for the next page.
    const boundary = membershipRows.length > READ_MEMBERSHIPS ? membershipRows[READ_MEMBERSHIPS]!.ordinal : ids.length
    const memberships = new Map<string, { states: MailboxMembership[]; bytes: number }>()
    for (const row of membershipRows) {
      if (row.ordinal >= boundary) break
      const group = memberships.get(row.message) ?? { states: [], bytes: 0 }
      const state = JSON.parse(row.data) as MailboxMembership
      group.states.push({ mailboxId: state.mailboxId, messageId: state.messageId, revision: state.revision, done: state.done, snoozedUntil: state.snoozedUntil })
      group.bytes += Buffer.byteLength(row.data)
      memberships.set(row.message, group)
    }
    let consumed = 0, bytes = 0
    const selected: string[] = []
    for (const id of ids.slice(0, boundary)) {
      const row = rows.get(id), group = memberships.get(id)
      const cost = group ? (row?.bytes ?? 0) + group.bytes + 1024 : 256
      if (cost > READ_BYTES - 512 * 1024) throw new InboxError('MAILBOX_READ_TOO_LARGE', 'One mailbox summary exceeds the read budget.', 413)
      if (bytes + cost > READ_BYTES - 512 * 1024) break
      bytes += cost; consumed++
      if (group) selected.push(id)
    }
    if (!consumed) throw new InboxError('MAILBOX_READ_TOO_LARGE', 'The mailbox read could not advance within its budget.', 413)
    if (selected.length) {
      const loaded = db.query<MessageRow, [string, string]>('SELECT id,owner,account,visible FROM sdk_messages WHERE owner=? AND id IN (SELECT value FROM json_each(?))').all(owner, JSON.stringify(selected))
      for (const row of loaded) {
        const { snoozedUntil: _legacy, ...value } = summary(row)
        items.set(row.id, { ...value, sourceId: row.account, memberships: memberships.get(row.id)!.states })
      }
    }
    return { items, rows, consumed }
  }

  async function providerFor(row: AccountRow, reason: CredentialContext['reason'] = 'operation'): Promise<InboxProvider> {
    if (!current(row)) throw new InboxError('RECONNECT_REQUIRED', 'Account connection changed.', 409)
    const definition = definitions.get(JSON.parse(row.data).providerId)
    if (!definition) throw new InboxError('UNSUPPORTED_PROVIDER', 'This provider is not registered.', 409)
    let grant = connectionRow(row.owner, row.connection_id)
    row.credential_version = grant.credential_version
    let credentials = JSON.parse(crypto.decryptCredential(grant.credentials, row.owner, grant.id)) as Record<string, unknown>
    const expires = credentials.expiresAt
    const expiration = expires === undefined || expires === null ? undefined : new Date(expires as string | number).getTime()
    const expired = expiration !== undefined && expiration <= now()
    const refreshDue = expiration !== undefined && expiration <= now() + 60_000 && Boolean(options.resolveCredentials || definition.refresh)
    if (options.resolveCredentials || expired || refreshDue || reason === 'rejected') {
      if (!options.resolveCredentials && !definition.refresh) throw new CredentialError('unavailable', 'The host must supply current provider credentials.')
      const key = `${row.owner}\0${grant.id}\0${grant.generation}\0${grant.credential_version}`
      let refreshing = refreshes.get(key)
      if (!refreshing) {
        refreshing = (async () => {
          const original = grant
          const lease = randomUUID()
          const deadline = Date.now() + 30_000
          for (;;) {
            if (closed || stopping) throw new CredentialError('unavailable', 'Credential resolution is closing.')
            const fresh = connectionRow(row.owner, original.id)
            if (fresh.generation !== original.generation || fresh.status !== 'connected') throw new InboxError('RECONNECT_REQUIRED', 'Connection authorization changed.', 409)
            if (fresh.credential_version !== original.credential_version) return fresh
            const claimed = db.query(`INSERT INTO sdk_connection_refresh(connection,owner,lease,until) VALUES (?,?,?,?)
              ON CONFLICT(connection) DO UPDATE SET lease=excluded.lease,until=excluded.until WHERE sdk_connection_refresh.until<=?`).run(original.id, row.owner, lease, now() + 30_000, now())
            if (claimed.changes) break
            if (Date.now() >= deadline) throw new InboxError('REFRESH_BUSY', 'Credential refresh is already in progress.', 503, true)
            await Bun.sleep(25)
          }
          try {
            const signal = AbortSignal.timeout(25_000)
            const context: CredentialContext = { owner: row.owner, connection: publicConnection(original), credentials: structuredClone(credentials),
              reason: reason === 'rejected' ? reason : expired || refreshDue ? 'expired' : 'operation', signal }
            let resolved: Record<string, unknown>
            try {
              if (options.resolveCredentials) resolved = credentialRecord(await credentialCall(signal, () => options.resolveCredentials!(context)))
              else {
                const refreshed = credentialRecord(await credentialCall(signal, () => definition.refresh!({ ...credentials, ...(options.fetch ? { fetch: options.fetch } : {}) }, signal, context)))
                resolved = { ...credentials, ...refreshed }
                if (!Object.hasOwn(refreshed, 'expiresAt') && Object.keys(refreshed).length) delete resolved.expiresAt
              }
            } catch (error) {
              if (error instanceof CredentialError || error instanceof ProviderError && ['RATE_LIMITED', 'NETWORK', 'UPSTREAM'].includes(error.code)) throw error
              throw new CredentialError('unavailable', 'The host could not supply provider credentials.')
            }
            if (resolved.expiresAt !== undefined && resolved.expiresAt !== null && new Date(resolved.expiresAt as string | number).getTime() <= now()) {
              throw new CredentialError('unavailable', 'The host returned expired provider credentials.')
            }
            const fresh = connectionRow(row.owner, original.id)
            if (fresh.generation !== original.generation || fresh.status !== 'connected') throw new InboxError('RECONNECT_REQUIRED', 'Connection authorization changed.', 409)
            if (fresh.credential_version !== original.credential_version || fingerprint(resolved) === fingerprint(credentials)) return fresh
            return saveCredentials(original, resolved)
          } finally { db.query('DELETE FROM sdk_connection_refresh WHERE connection=? AND owner=? AND lease=?').run(original.id, row.owner, lease) }
        })().finally(() => refreshes.delete(key))
        refreshes.set(key, refreshing)
      }
      try { grant = await refreshing }
      catch (error) {
        if (error instanceof CredentialError && error.reason === 'revoked') revokeCredentials(grant)
        throw error
      }
      credentials = JSON.parse(crypto.decryptCredential(grant.credentials, row.owner, grant.id))
      row.credential_version = grant.credential_version
    }
    if (closed || stopping) throw new InboxError('CLOSED', 'The inbox instance is closing.', 503)
    const key = generationKey(row)
    let controller = controllers.get(key)
    if (!controller) { controller = new AbortController(); controllers.set(key, controller) }
    let instance = instances.get(key)
    if (instance && instanceVersions.get(key) !== grant.credential_version) {
      const retired = instance
      instances.delete(key); instance = undefined
      void retired.then(provider => provider.disconnect()).catch(() => {})
    }
    if (!instance) {
      instance = Promise.resolve(definition.create({ ...credentials, accountId: row.id, userId: row.owner, sdkMailboxScopes: undefined,
        fetch: ((input, init) => (options.fetch ?? globalThis.fetch)(input, { ...init,
          signal: AbortSignal.any([controller!.signal, init?.signal ?? AbortSignal.timeout(30_000)]) })) as typeof fetch }, { signal: controller.signal })).then(provider => {
        if (provider.accountId !== row.id) throw new InboxError('INVALID_PROVIDER', 'Provider returned a foreign account.', 502)
        return provider
      })
      instances.set(key, instance)
      instanceVersions.set(key, grant.credential_version)
      void instance.catch(() => { if (instances.get(key) === instance) instances.delete(key) })
    }
    let provider: InboxProvider
    try { provider = await instance }
    catch (error) {
      if (error instanceof ProviderError && error.code === 'AUTHENTICATION') throw new CredentialError('unavailable', 'The supplied provider credentials were rejected.')
      throw error
    }
    if (!current(row) || instances.get(key) !== instance || retiring.has(key) || !controllers.has(key)) {
      throw new InboxError('CREDENTIALS_CHANGED', 'Connection credentials changed during this request.', 409, true)
    }
    return provider
  }

  function refreshCapabilities(row: AccountRow, provider: InboxProvider): void {
    if (!current(row)) return
    const account = JSON.parse(accountRow(row.owner, row.id).data) as Account
    if (fingerprint(account.capabilities) !== fingerprint(provider.capabilities)) {
      account.capabilities = { ...provider.capabilities }
      account.features.scheduledSend = provider.capabilities.send; account.features.undoSend = provider.capabilities.send
      account.revision++
      db.query('UPDATE sdk_accounts SET data=? WHERE id=? AND owner=? AND generation=?').run(JSON.stringify(account), row.id, row.owner, row.generation)
      event(row.owner, 'account.updated', row.id, row.id)
    }
  }

  async function io<T>(row: AccountRow, action: (provider: InboxProvider) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const provider = await providerFor(row, attempt ? 'rejected' : 'operation')
      const key = generationKey(row)
      const controller = controllers.get(key)
      if (!controller || retiring.has(key)) throw new InboxError('CREDENTIALS_CHANGED', 'Connection credentials changed during this request.', 409, true)
      activeRequests.set(key, (activeRequests.get(key) ?? 0) + 1)
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)])
      try {
        const result = await new Promise<T>((resolve, reject) => {
          const abort = () => { retireInstance(key, true); reject(new InboxError('NETWORK', 'Mailbox request interrupted.', 502, true)) }
          if (signal.aborted) { abort(); return }
          signal.addEventListener('abort', abort, { once: true })
          Promise.resolve().then(() => action(provider)).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
        })
        refreshCapabilities(row, provider)
        return result
      } catch (error) {
        if (error instanceof CredentialError && error.reason === 'revoked') {
          const grant = connectionRow(row.owner, row.connection_id)
          if (grant.generation === row.connection_generation && grant.credential_version === row.credential_version) revokeCredentials(grant)
          throw error
        }
        if (!(error instanceof ProviderError) || error.code !== 'AUTHENTICATION') throw error
        if (attempt) throw new CredentialError('unavailable', 'The supplied provider credentials were rejected.')
      } finally {
        const count = (activeRequests.get(key) ?? 1) - 1
        if (count) activeRequests.set(key, count)
        else { activeRequests.delete(key); if (retiring.has(key)) retireInstance(key, false) }
      }
    }
  }

  function folderFor(row: AccountRow, nativeId: string, role = nativeId, name = role, kind: Folder['kind'] = 'folder'): Folder {
    const existing = db.query<DataRow, [string, number, string]>('SELECT * FROM sdk_folders WHERE account=? AND generation=? AND native_id=?').get(row.id, row.generation, nativeId)
    if (existing && name === role && kind === 'folder') return JSON.parse(existing.data)
    const result: Folder = { id: existing?.id ?? randomUUID(), accountId: row.id, name, role, kind, scope: 'provider' }
    db.query('INSERT INTO sdk_folders(id,owner,account,generation,native_id,data) VALUES (?,?,?,?,?,?) ON CONFLICT(account,generation,native_id) DO UPDATE SET data=excluded.data').run(result.id, row.owner, row.id, row.generation, nativeId, JSON.stringify(result))
    return result
  }

  function applyChanges(value: MessageSummary, changes: Changes, row: AccountRow): MessageSummary {
    const result = structuredClone(value)
    if (changes.isRead !== undefined) result.isRead = changes.isRead
    if (changes.isStarred !== undefined) result.isStarred = changes.isStarred
    const destination = changes.folderId
      ? db.query<DataRow, [string, string, string]>('SELECT * FROM sdk_folders WHERE id=? AND owner=? AND account=?').get(changes.folderId, row.owner, row.id)
      : null
    if (changes.folderId && !destination) throw new InboxError('NOT_FOUND', 'Folder not found.', 404)
    const folder = destination ? (JSON.parse(destination.data) as Folder).role : changes.folder
    if (folder) {
      result.folder = folder
      const target = destination ? JSON.parse(destination.data) as Folder : folderFor(row, folder)
      result.folderIds = [target.id]
      if (folder === 'trash' || folder === 'spam') result.snoozedUntil = null
    }
    if (changes.isArchived === true) {
      result.folder = 'archive'
      const inbox = db.query<{ id: string }, [string, string]>('SELECT id FROM sdk_folders WHERE owner=? AND account=? AND json_extract(data,\'$.role\')=\'inbox\'').all(row.owner, row.id)
      result.folderIds = result.folderIds.filter(id => !inbox.some(f => f.id === id))
      if (!result.folderIds.length) result.folderIds = [folderFor(row, 'archive').id]
    }
    if (changes.isArchived === false) {
      result.folder = 'inbox'
      result.folderIds = [...new Set([...result.folderIds, folderFor(row, 'inbox').id])]
    }
    result.labelIds = [...new Set([...result.labelIds, ...changes.addLabelIds ?? []])].filter(id => !changes.removeLabelIds?.includes(id))
    if (changes.snoozedUntil !== undefined) result.snoozedUntil = changes.snoozedUntil
    return result
  }

  function messageRow(owner: string, id: string): MessageRow {
    ownerId(owner)
    const row = db.query<MessageRow, [string, string]>('SELECT * FROM sdk_messages WHERE owner=? AND id=? AND deleted=0').get(owner, id)
    if (!row) throw new InboxError('NOT_FOUND', 'Message not found.', 404)
    return row
  }

  function messagePresentation(row: MessageRow, remoteImages: boolean, resource?: string) {
    const body = JSON.parse(row.body)
    const bodyText = typeof body.bodyText === 'string' ? body.bodyText : ''
    // A stable, opaque binding to the owner, source, current original body and exact eligible URL.
    // No URL registry, provider call, revision, or event is created by reading message JSON.
    const binding = JSON.stringify(['email-media-v1', epoch, row.owner, row.account, row.id, createHash('sha256').update(row.body).digest('hex')])
    let source: string | undefined
    const presentation = sanitizeEmailBody(body.bodyHtml, bodyText, remoteImages, true, body.attachments, url => {
      const reference = createHmac('sha256', options.encryptionKey).update(binding).update('\0').update(url).digest('base64url')
      if (resource && timingSafeEqual(Buffer.from(resource), Buffer.from(reference))) source = url
      return `/v1/messages/${encodeURIComponent(row.id)}/media/${reference}`
    })
    return { body, bodyText, presentation, source }
  }

  function project(id: string): void {
    const row = db.query<MessageRow, [string]>('SELECT * FROM sdk_messages WHERE id=?').get(id)
    if (!row || row.deleted) return
    const account = accountRow(row.owner, row.account)
    let visible: MessageSummary = { ...JSON.parse(row.confirmed), labelIds: JSON.parse(row.local_labels), snoozedUntil: row.snoozed_until }
    const pending = db.query<OperationRow, [string, string]>("SELECT * FROM sdk_operations WHERE owner=? AND account=? AND type='mutation' AND status IN ('pending','processing') ORDER BY seq").all(row.owner, row.account)
    for (const op of pending) {
      const payload = JSON.parse(op.payload) as MutationPayload
      if (payload.input.messageIds.includes(id) && !(JSON.parse(op.data) as Operation).results.some(result => result.messageId === id)) visible = applyChanges(visible, payload.perMessageChanges?.[id] ?? payload.input.changes, account)
    }
    const labels = new Set(db.query<{ id: string }, [string, string]>('SELECT id FROM sdk_labels WHERE owner=? AND account=?').all(row.owner, row.account).map(label => label.id))
    visible.labelIds = visible.labelIds.filter(id => labels.has(id))
    visible.revision = row.revision + 1
    db.query('UPDATE sdk_messages SET visible=?,revision=?,folder=?,is_read=?,is_starred=? WHERE id=?').run(JSON.stringify(visible), visible.revision, visible.folder, Number(visible.isRead), Number(visible.isStarred), id)
  }

  function persist(row: AccountRow, mail: MailMessage, reason: ChangeEvent['reason'], preferredId?: string, fence = Infinity): string {
    if (mail.accountId !== row.id) throw new InboxError('INVALID_PROVIDER', 'Provider returned mail for another account.', 502)
    const exact = db.query<MessageRow, [string, number, string]>('SELECT * FROM sdk_messages WHERE account=? AND generation=? AND native_id=?').get(row.id, row.generation, mail.id)
    const preferred = preferredId ? db.query<MessageRow, [string, string]>('SELECT * FROM sdk_messages WHERE id=? AND account=?').get(preferredId, row.id) : null
    if (preferred && exact && preferred.id !== exact.id) {
      // A sync can observe a move's new UID before its command receipt is committed.
      // Only the explicit mutation receipt authorizes this merge; never match subjects
      // or RFC Message-ID. Keep the original public identity and retire the sync echo.
      db.query('UPDATE sdk_messages SET native_id=?,deleted=2,revision=revision+1 WHERE id=?').run(`merged:${exact.id}`, exact.id)
      db.query('UPDATE sdk_native_keys SET message_id=? WHERE account=? AND generation=? AND message_id=?').run(preferred.id, row.id, row.generation, exact.id)
      for (const membership of db.query<MembershipRow, [string, string]>('SELECT * FROM sdk_memberships WHERE owner=? AND message=?').all(row.owner, exact.id)) {
        const state: MailboxMembership = { ...JSON.parse(membership.data), messageId: preferred.id }
        db.query('INSERT OR IGNORE INTO sdk_memberships VALUES (?,?,?,?,?)').run(row.owner, row.id, membership.mailbox, preferred.id, JSON.stringify(state))
      }
      db.query('INSERT OR IGNORE INTO sdk_delivery_evidence SELECT owner,source,?,kind,value FROM sdk_delivery_evidence WHERE owner=? AND message=?').run(preferred.id, row.owner, exact.id)
      for (const stored of db.query<DataRow, [string, string]>('SELECT * FROM sdk_drafts WHERE owner=? AND account=?').all(row.owner, row.id)) {
        const draft = JSON.parse(stored.data) as Draft
        if (draft.sourceMessageId !== exact.id || draft.status !== 'active') continue
        draft.sourceMessageId = preferred.id; draft.revision++
        db.query('UPDATE sdk_drafts SET data=? WHERE id=?').run(JSON.stringify(draft), draft.id)
        event(row.owner, 'draft.updated', row.id, draft.id)
      }
      event(row.owner, 'mail.changed', row.id, exact.id, 'deleted')
    }
    const old = preferred ?? exact
      ?? db.query<MessageRow, [string, number, string]>('SELECT m.* FROM sdk_native_keys k JOIN sdk_messages m ON m.id=k.message_id WHERE k.account=? AND k.generation=? AND k.native_id=?').get(row.id, row.generation, mail.id)
      ?? (mail.folder === 'sent' && mail.rfcMessageId ? db.query<MessageRow, [string, number, string, string]>("SELECT * FROM sdk_messages WHERE account=? AND generation=? AND native_id LIKE 'submission:%' AND json_extract(body,'$.rfcMessageId')=? AND lower(json_extract(visible,'$.from.email'))=lower(?)").get(row.id, row.generation, mail.rfcMessageId, mail.from.email) : null)
    if (old?.deleted === 1) return old.id
    if (old) recordEvidence(row, mail, old.id, reason)
    if (old && !old.deleted && (reason === 'backfill' || old.last_mutation_seq > fence)) return old.id
    if (old && old.native_id !== mail.id && !preferredId && !old.native_id.startsWith('submission:')) return old.id
    const id = old?.id ?? preferredId ?? randomUUID()
    const threadKey = mail.threadId || mail.id
    const thread = db.query<{ id: string }, [string, number, string]>('SELECT id FROM sdk_thread_keys WHERE account=? AND generation=? AND native_id=?').get(row.id, row.generation, threadKey)
    const threadId = old?.thread_id ?? thread?.id ?? randomUUID()
    db.query('INSERT OR IGNORE INTO sdk_thread_keys VALUES (?,?,?,?)').run(row.id, row.generation, threadKey, threadId)
    const normalized = mail as MailMessage & { folderIds?: string[]; replyTo?: Participant[]; rfcMessageId?: string; references?: string[]; inReplyTo?: string }
    const folderIds = (normalized.folderIds?.length ? normalized.folderIds : [mail.folder]).map(native => folderFor(row, native, native === mail.folder ? mail.folder : native).id)
    const attachments = mail.attachments.map(attachment => {
      const existing = db.query<BlobRow, [string, number, string, string]>('SELECT * FROM sdk_blobs WHERE account=? AND generation=? AND message_id=? AND attachment_id=?').get(row.id, row.generation, id, attachment.id)
      const info: BlobInfo = { id: existing?.id ?? randomUUID(), accountId: row.id, filename: attachment.filename,
        contentType: attachment.contentType, size: attachment.size, ...(attachment.inline ? { inline: true } : {}), ...(attachment.contentId ? { contentId: attachment.contentId } : {}) }
      db.query('INSERT INTO sdk_blobs(id,owner,account,generation,data,content,message_id,attachment_id) VALUES (?,?,?,?,?,NULL,?,?) ON CONFLICT(account,generation,message_id,attachment_id) DO UPDATE SET data=excluded.data').run(info.id, row.owner, row.id, row.generation, JSON.stringify(info), id, attachment.id)
      return info
    })
    const summary: MessageSummary = { id, accountId: row.id, threadId, revision: 1,
      from: mail.from, to: mail.to, cc: mail.cc, subject: mail.subject, preview: mailPreview(mail), receivedAt: mail.receivedAt,
      isRead: mail.isRead, isStarred: mail.isStarred, folder: mail.folder, folderIds,
      labelIds: [], hasAttachments: attachments.length > 0, snoozedUntil: null, facts: mailFacts(mail) }
    const body = JSON.stringify({ bcc: mail.bcc, bodyText: mail.bodyText, bodyHtml: mail.bodyHtml, attachments,
      replyTo: normalized.replyTo, rfcMessageId: normalized.rfcMessageId, references: normalized.references, inReplyTo: normalized.inReplyTo })
    summary.bodyRevision = createHmac('sha256', options.encryptionKey)
      .update(JSON.stringify([row.owner, row.id, row.generation, id])).update('\0').update(body).digest('base64url')
    const confirmed = JSON.stringify(summary)
    if (old && !old.deleted && old.confirmed === confirmed && old.body === body) return old.id
    db.query(`INSERT INTO sdk_messages(id,owner,account,generation,native_id,thread_id,confirmed,visible,body,received_at,folder,is_read,is_starred,subject,search_text)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET native_id=excluded.native_id,confirmed=excluded.confirmed,body=excluded.body,received_at=excluded.received_at,subject=excluded.subject,search_text=excluded.search_text,deleted=0`).run(
      id, row.owner, row.id, row.generation, mail.id, threadId, confirmed, confirmed, body, mail.receivedAt, mail.folder,
      Number(mail.isRead), Number(mail.isStarred), mail.subject,
      [mail.subject, mail.preview, mail.bodyText, JSON.stringify(mail.from), JSON.stringify(mail.to), JSON.stringify(mail.cc)].join('\n'))
    db.query('INSERT OR IGNORE INTO sdk_native_keys VALUES (?,?,?,?)').run(row.id, row.generation, mail.id, id)
    if (!old) recordEvidence(row, mail, id, reason)
    if (old) project(id)
    event(row.owner, 'mail.changed', row.id, id, old ? 'updated' : 'created', old && reason === 'arrival' ? 'mutation' : reason)
    return id
  }

  const cachedFacts = new Map<string, NonNullable<MessageSummary['facts']>>()
  function summary(row: MessageRow): MessageSummary {
    const value: MessageSummary = JSON.parse(row.visible)
    value.bodyRevision = createHmac('sha256', options.encryptionKey).update(JSON.stringify([
      'body-view-v1', epoch, value.accountId, value.id, value.bodyRevision ?? null, value.bodyRevision ? null : value.revision,
    ])).digest('base64url')
    if (!value.facts) {
      const key = `${value.id}:${value.revision}`
      let facts = cachedFacts.get(key)
      if (!facts) {
        // Existing caches have bodies but predate header facts. Derive only what
        // is actually retained, locally and per requested page; never hydrate upstream.
        const stored = db.query<{ body: string }, [string]>('SELECT body FROM sdk_messages WHERE id=?').get(value.id)
        const body = stored ? JSON.parse(stored.body) : {}
        const source = db.query<{ data: string }, [string]>('SELECT data FROM sdk_accounts WHERE id=?').get(value.accountId)
        const categories = source ? definitions.get((JSON.parse(source.data) as Account).providerId)?.nativeCategoryRoles : undefined
        const nativeFolders = categories ? db.query<{ role: string }, [string, string]>("SELECT json_extract(data,'$.role') role FROM sdk_folders WHERE account=? AND id IN (SELECT value FROM json_each(?))").all(value.accountId, JSON.stringify(value.folderIds)) : []
        facts = mailFacts({ ...body, nativeCategories: categories ? nativeFolders.flatMap(folder => Object.hasOwn(categories, folder.role) ? [categories[folder.role]!] : []) : undefined })
        if (cachedFacts.size >= 2000) cachedFacts.delete(cachedFacts.keys().next().value!)
        cachedFacts.set(key, facts)
      }
      value.facts = facts
    }
    return value
  }

  function repairPreviews(): void {
    const saved = db.query<{ value: string }, []>("SELECT value FROM sdk_meta WHERE key='mail-preview-v1'").get()!
    const initial = JSON.parse(saved.value) as PreviewRepair
    if (initial.done || initial.retryAt > now() && (initial.after >= initial.through || initial.deferred.length >= 128)) return
    transaction(() => {
      // Other instances can finish a batch between our cheap check and this lock.
      if (db.query<{ value: string }, []>("SELECT value FROM sdk_meta WHERE key='mail-preview-v1'").get()?.value !== saved.value) return
      const state = initial
      const started = performance.now()
      const byteBudget = 1024 * 1024
      let bytes = 0, attempts = 0
      // Inspect a bounded active queue once, not all account payloads per message.
      // On overflow, defer conservatively rather than overlook an active writer.
      const active = db.query<{ id: string; owner: string; account: string; generation: number; bytes: number }, []>(`SELECT id,owner,account,generation,length(CAST(payload AS BLOB)) bytes
        FROM sdk_operations WHERE type='mutation' AND status IN ('pending','processing') LIMIT 33`).all()
      const blocked = new Set<string>()
      const uncertain = active.length > 32 || active.reduce((sum, row) => sum + row.bytes, 0) > 128 * 1024
      if (!uncertain) for (const op of active) {
        const payload = db.query<{ payload: string }, [string]>('SELECT payload FROM sdk_operations WHERE id=?').get(op.id)!.payload
        bytes += op.bytes
        for (const id of (JSON.parse(payload) as MutationPayload).input.messageIds) blocked.add(JSON.stringify([op.owner, op.account, op.generation, id]))
      }
      const attempt = (id: string): 'done' | 'defer' | 'budget' => {
        attempts++
        const meta = db.query<{ owner: string; account: string; generation: number; revision: number; deleted: number; bodyBytes: number; summaryBytes: number; currentGeneration: number; status: string; attached: number }, [string]>(`SELECT m.owner,m.account,m.generation,m.revision,m.deleted,
          length(CAST(m.body AS BLOB)) bodyBytes,length(CAST(m.confirmed AS BLOB))+length(CAST(m.visible AS BLOB)) summaryBytes,a.generation currentGeneration,a.status,
          EXISTS(SELECT 1 FROM sdk_memberships v JOIN sdk_mailboxes b ON b.id=v.mailbox AND b.owner=v.owner AND b.source=v.source
            WHERE v.message=m.id AND v.owner=m.owner AND v.source=m.account AND json_extract(b.data,'$.status')<>'detached') attached
          FROM sdk_messages m JOIN sdk_accounts a ON a.id=m.account AND a.owner=m.owner WHERE m.id=?`).get(id)
        if (!meta || meta.deleted) return 'done'
        if (meta.generation !== meta.currentGeneration || meta.status !== 'connected' || !meta.attached || uncertain || blocked.has(JSON.stringify([meta.owner, meta.account, meta.generation, id]))) return 'defer'
        // Oversized summaries are left intact. Oversized bodies get only the
        // bounded existing-preview fallback; neither is reported as full repair.
        if (meta.summaryBytes > 64 * 1024) { state.fallbacks++; return 'done' }
        const full = meta.bodyBytes <= 512 * 1024
        const size = meta.summaryBytes + (full ? meta.bodyBytes : 0)
        if (bytes + size > byteBudget) return 'budget'
        bytes += size
        const row = db.query<{ confirmed: string; visible: string; body: string | null }, [string, string, string, number, number]>(`SELECT confirmed,visible,${full ? 'body' : 'NULL body'} FROM sdk_messages
          WHERE id=? AND owner=? AND account=? AND generation=? AND revision=? AND deleted=0`).get(id, meta.owner, meta.account, meta.generation, meta.revision)
        if (!row) return 'defer'
        let confirmed: MessageSummary, visible: MessageSummary
        try { confirmed = JSON.parse(row.confirmed); visible = JSON.parse(row.visible) }
        catch { state.fallbacks++; return 'done' }
        if (!confirmed || typeof confirmed !== 'object' || Array.isArray(confirmed) || !visible || typeof visible !== 'object' || Array.isArray(visible)) { state.fallbacks++; return 'done' }
        let body: { bodyText?: string; bodyHtml?: string } | undefined
        if (row.body !== null) {
          try { body = JSON.parse(row.body) }
          catch { /* Keep malformed historical bodies untouched; clean only the preview. */ }
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) { body = undefined; state.fallbacks++ }
        const preview = mailPreview(body ? { bodyText: typeof body.bodyText === 'string' ? body.bodyText : undefined, bodyHtml: typeof body.bodyHtml === 'string' ? body.bodyHtml : undefined,
          preview: typeof confirmed.preview === 'string' ? confirmed.preview : undefined, subject: typeof confirmed.subject === 'string' ? confirmed.subject : undefined,
          from: typeof confirmed.from?.name === 'string' ? { name: confirmed.from.name } : undefined }
          : { preview: typeof confirmed.preview === 'string' ? confirmed.preview.slice(0, 4096) : '' })
        const changed = visible.preview !== preview
        if (confirmed.preview === preview && !changed) return 'done'
        confirmed.preview = preview
        visible.preview = preview
        if (changed) visible.revision = meta.revision + 1
        // Read/extraction and the conditional write share this short transaction:
        // no body, scope, generation or active operation can change between them.
        const result = db.query(`UPDATE sdk_messages SET confirmed=?,visible=?,revision=?
          WHERE id=? AND owner=? AND account=? AND generation=? AND revision=? AND deleted=0
            AND EXISTS(SELECT 1 FROM sdk_accounts a WHERE a.id=sdk_messages.account AND a.owner=sdk_messages.owner AND a.generation=sdk_messages.generation AND a.status='connected')
            AND EXISTS(SELECT 1 FROM sdk_memberships v JOIN sdk_mailboxes b ON b.id=v.mailbox AND b.owner=v.owner AND b.source=v.source
              WHERE v.message=sdk_messages.id AND v.owner=sdk_messages.owner AND v.source=sdk_messages.account AND json_extract(b.data,'$.status')<>'detached')`).run(
          JSON.stringify(confirmed), JSON.stringify(visible), changed ? meta.revision + 1 : meta.revision, id, meta.owner, meta.account, meta.generation, meta.revision)
        if (!result.changes) return 'defer'
        if (changed) event(meta.owner, 'mail.changed', meta.account, id, 'updated', 'backfill')
        return 'done'
      }
      const timeLeft = () => attempts === 0 || performance.now() - started < 8
      const retries = state.retryAt <= now() ? Math.min(state.deferred.length, state.deferred.length >= 128 || state.after >= state.through ? 16 : 4) : 0
      for (let i = 0; i < retries && attempts < 16 && timeLeft(); i++) {
        const id = state.deferred.shift()!
        const result = attempt(id)
        if (result !== 'done') state.deferred.push(id)
        if (result === 'budget') break
      }
      if (attempts < 16 && timeLeft() && state.deferred.length < 128 && state.after < state.through) {
        const ids = db.query<{ id: string }, [string, string, number]>('SELECT id FROM sdk_messages WHERE id>? AND id<=? ORDER BY id LIMIT ?').all(state.after, state.through, 16 - attempts)
        if (!ids.length) state.after = state.through
        for (const { id } of ids) {
          if (attempts >= 16 || !timeLeft() || state.deferred.length >= 128) break
          const result = attempt(id)
          if (result === 'budget') break
          if (result === 'defer') state.deferred.push(id)
          state.after = id
        }
      }
      state.retryAt = state.deferred.length ? now() + 1000 : 0
      state.done = state.after >= state.through && state.deferred.length === 0
      db.query("UPDATE sdk_meta SET value=? WHERE key='mail-preview-v1' AND value=?").run(JSON.stringify(state), saved.value)
    })
  }

  function where(owner: string, query: Query, mailboxMode = false): { sql: string; params: Array<string | number> } {
    ownerId(owner)
    const clauses = ['m.owner=?', 'm.deleted=0']; const params: Array<string | number> = [owner]
    if (query.accountId) { accountRow(owner, query.accountId); clauses.push('m.account=?'); params.push(query.accountId) }
    if (query.sort && !['newest', 'oldest'].includes(query.sort)) throw new InboxError('VALIDATION', 'Invalid sort order.')
    const literal = (value: string) => `%${value.replace(/[\\%_]/g, '\\$&')}%`
    const fieldLike = (field: string, value: string) => { clauses.push(`${field} LIKE ? ESCAPE '\\'`); params.push(literal(value)) }
    const folder = (value: string) => {
      if (value === 'all') return
      if (value === 'starred') { clauses.push('m.is_starred=1'); return }
      if (value === 'snoozed') { clauses.push("json_extract(m.visible,'$.snoozedUntil') IS NOT NULL"); return }
      clauses.push("(m.folder=? OR EXISTS(SELECT 1 FROM json_each(m.visible,'$.folderIds') j JOIN sdk_folders f ON f.id=j.value AND f.owner=m.owner WHERE j.value=? OR json_extract(f.data,'$.role')=?))"); params.push(value, value, value)
      if (value === 'inbox' && !mailboxMode) clauses.push("json_extract(m.visible,'$.snoozedUntil') IS NULL")
    }
    if (query.folder) folder(query.folder)
    if (query.labelId) { clauses.push("EXISTS(SELECT 1 FROM json_each(m.visible,'$.labelIds') WHERE value=?)"); params.push(query.labelId) }
    if (query.unreadOnly !== undefined) { clauses.push('m.is_read=?'); params.push(query.unreadOnly ? 0 : 1) }
    if (query.starredOnly !== undefined) { clauses.push('m.is_starred=?'); params.push(Number(query.starredOnly)) }
    if (query.hasAttachments !== undefined) { clauses.push("json_extract(m.visible,'$.hasAttachments')=?"); params.push(Number(query.hasAttachments)) }
    if (query.from) fieldLike("json_extract(m.visible,'$.from')", query.from)
    if (query.to) fieldLike("json_extract(m.visible,'$.to') || json_extract(m.visible,'$.cc')", query.to)
    const date = (value: string, before: boolean) => {
      if (!Number.isFinite(Date.parse(value))) throw new InboxError('VALIDATION', 'Invalid date filter.')
      clauses.push(`m.received_at ${before ? '<' : '>='} ?`); params.push(new Date(value).toISOString())
    }
    if (query.before) date(query.before, true)
    if (query.after) date(query.after, false)
    if (query.search) {
      if (query.search.length > 2000 || (query.search.match(/"/g)?.length ?? 0) % 2) throw new InboxError('VALIDATION', 'Invalid search query.')
      for (const token of query.search.match(/(?:[^\s"]|"[^"]*")+/g) ?? []) {
        const clean = token.replaceAll('"', ''); const colon = clean.indexOf(':')
        if (colon < 0) { fieldLike('m.search_text', clean); continue }
        const op = clean.slice(0, colon).toLowerCase(); const value = clean.slice(colon + 1)
        if (!value) throw new InboxError('VALIDATION', 'Search operators require a value.')
        if (op === 'in') folder(value)
        else if (op === 'from') fieldLike("json_extract(m.visible,'$.from')", value)
        else if (op === 'to') fieldLike("json_extract(m.visible,'$.to') || json_extract(m.visible,'$.cc')", value)
        else if (op === 'subject') fieldLike('m.subject', value)
        else if (op === 'before' || op === 'after') date(value, op === 'before')
        else if (op === 'is' && ['read', 'unread', 'starred'].includes(value)) clauses.push(value === 'starred' ? 'm.is_starred=1' : `m.is_read=${value === 'read' ? 1 : 0}`)
        else if (op === 'has' && ['attachment', 'attachments'].includes(value)) clauses.push("json_extract(m.visible,'$.hasAttachments')=1")
        else if (op === 'label') { clauses.push("EXISTS(SELECT 1 FROM json_each(m.visible,'$.labelIds') j LEFT JOIN sdk_labels l ON l.id=j.value AND l.owner=m.owner WHERE j.value=? OR json_extract(l.data,'$.name')=?)"); params.push(value, value) }
        else throw new InboxError('VALIDATION', 'Unsupported search operator or value.')
      }
    }
    return { sql: clauses.join(' AND '), params }
  }

  function pagination(owner: string, query: Query, kind: string): { limit: number; offset: number; state: string; hash: string } {
    const limit = query.limit ?? 50
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new InboxError('VALIDATION', 'Page size must be between 1 and 100.')
    const { cursor, ...rest } = query
    const hash = fingerprint({ ...rest, limit, kind }); const seq = sequence(owner)
    let offset = 0
    if (cursor) {
      const parsed = decode(owner, cursor)
      const [encodedHash, encodedOffset] = (parsed.query ?? '').split(':')
      if (encodedHash !== hash) throw new InboxError('INVALID_CURSOR', 'Cursor does not match this query.')
      if (parsed.epoch !== epoch || parsed.seq !== seq) throw new InboxError('STALE_CURSOR', 'The mailbox changed. Restart this query.', 409)
      offset = Number(encodedOffset)
      if (!Number.isSafeInteger(offset) || offset < 0) throw new InboxError('INVALID_CURSOR', 'Invalid cursor offset.')
    }
    return { limit, offset, state: token(owner, seq), hash }
  }

  function recipients(value: unknown): Participant[] {
    if (!Array.isArray(value) || value.length > 200) throw new InboxError('VALIDATION', 'Recipients must be an array of at most 200 addresses.')
    return value.map(item => {
      if (!item || typeof item.email !== 'string' || !/^[^\s<>@]+@[^\s<>@]+$/.test(item.email) || /[\r\n\0]/.test(item.name ?? '')) throw new InboxError('VALIDATION', 'Invalid recipient address.')
      return { name: typeof item.name === 'string' ? item.name : item.email, email: item.email }
    })
  }

  function draftRow(owner: string, id: string): Draft {
    ownerId(owner)
    const row = db.query<DataRow, [string, string]>('SELECT * FROM sdk_drafts WHERE owner=? AND id=?').get(owner, id)
    if (!row) throw new InboxError('NOT_FOUND', 'Draft not found.', 404)
    return JSON.parse(row.data)
  }

  function validateDraft(owner: string, input: DraftInput, submitting = false): Required<Omit<DraftInput, 'sourceMessageId' | 'mailboxId'>> & { sourceMessageId?: string; mailboxId?: string } {
    const row = accountRow(owner, input.accountId)
    const native = JSON.parse(row.native)
    const own = [native.email, ...(native.aliases ?? [])].filter((v: unknown) => typeof v === 'string') as string[]
    const box = input.mailboxId ? JSON.parse(mailboxRow(owner, input.mailboxId, true).data) as Mailbox : null
    if (box && box.sourceId !== row.id) throw new InboxError('NOT_FOUND', 'Mailbox belongs to a different source.', 404)
    const from = input.from ?? box?.defaultSender ?? native.email
    if (typeof from !== 'string' || from.length > 1024 || /[\r\n\0]/.test(from)) throw new InboxError('VALIDATION', 'Invalid sender address.')
    if (submitting && !own.some(email => email.toLowerCase() === from.toLowerCase())) throw new InboxError('FORBIDDEN_SENDER', 'The selected sender is not authorized for this account.', 403)
    if (submitting && box) assertMailboxSender(box, from)
    const mode = input.mode ?? 'compose'
    if (!['compose', 'reply', 'replyAll', 'forward'].includes(mode)) throw new InboxError('VALIDATION', 'Invalid compose mode.')
    if (typeof (input.subject ?? '') !== 'string' || /[\r\n\0]/.test(input.subject ?? '') || (input.subject?.length ?? 0) > 998) throw new InboxError('VALIDATION', 'Invalid subject.')
    for (const value of [input.bodyText, input.bodyHtml]) if (value !== undefined && (typeof value !== 'string' || value.length > 2_000_000)) throw new InboxError('VALIDATION', 'Message body exceeds the supported limit.')
    const ids = input.attachmentIds ?? []
    if (!Array.isArray(ids) || ids.length > 20 || new Set(ids).size !== ids.length) throw new InboxError('VALIDATION', 'Invalid attachment selection.')
    let size = 0
    for (const id of ids) {
      const blob = db.query<BlobRow, [string, string, string]>('SELECT * FROM sdk_blobs WHERE id=? AND owner=? AND account=?').get(id, owner, row.id)
      if (!blob) throw new InboxError('NOT_FOUND', 'Attachment not found.', 404)
      size += (JSON.parse(blob.data) as BlobInfo).size
    }
    if (size > 25 * 1024 * 1024) throw new InboxError('TOO_LARGE', 'Attachments exceed 25 MiB.', 413)
    if (input.sourceMessageId && messageRow(owner, input.sourceMessageId).account !== row.id) throw new InboxError('NOT_FOUND', 'Source message not found.', 404)
    if (input.sourceMessageId && input.mailboxId) membership(owner, input.mailboxId, input.sourceMessageId)
    if (['reply', 'replyAll', 'forward'].includes(mode) && !input.sourceMessageId) throw new InboxError('VALIDATION', 'This compose mode requires a source message.')
    return { accountId: row.id, from, to: recipients(input.to ?? []), cc: recipients(input.cc ?? []), bcc: recipients(input.bcc ?? []), subject: input.subject ?? '', bodyText: input.bodyText ?? '', bodyHtml: input.bodyHtml ?? '', attachmentIds: ids, mode, ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}), ...(input.mailboxId ? { mailboxId: input.mailboxId } : {}) }
  }

  function operationRow(owner: string, id: string): OperationRow {
    ownerId(owner)
    const op = db.query<OperationRow, [string, string]>('SELECT * FROM sdk_operations WHERE owner=? AND id=?').get(owner, id)
    if (!op) throw new InboxError('NOT_FOUND', 'Operation not found.', 404)
    return op
  }

  function replay(owner: string, key: string, intent: unknown): Operation | null {
    text(key, 'Idempotency key', 200)
    const row = db.query<OperationRow, [string, string]>('SELECT * FROM sdk_operations WHERE owner=? AND key=?').get(owner, key)
    if (!row) return null
    if (row.fingerprint !== fingerprint(intent)) throw new InboxError('IDEMPOTENCY_CONFLICT', 'This key belongs to a different operation.', 409)
    return JSON.parse(row.data)
  }

  function saveOperation(row: OperationRow, op: Operation, nextAt = row.next_at): void {
    db.query('UPDATE sdk_operations SET data=?,status=?,next_at=? WHERE id=?').run(JSON.stringify(op), op.status, nextAt, op.id)
    event(row.owner, 'operation.updated', row.account, op.id)
  }

  function accept(owner: string, account: AccountRow, type: Operation['type'], key: string, intent: unknown, payload: unknown, at: number): Operation {
    const op: Operation = { id: randomUUID(), accountId: account.id, type, status: 'pending', createdAt: new Date(now()).toISOString(), sendAt: type === 'send' ? new Date(at).toISOString() : null, attempts: 0, problem: null, results: [], ...(type === 'mutation' ? { mutationRevisions: [] } : {}) }
    db.query('INSERT INTO sdk_operations(id,owner,account,generation,status,type,data,payload,fingerprint,key,next_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(op.id, owner, account.id, account.generation, op.status, type, JSON.stringify(op), JSON.stringify(payload), fingerprint(intent), key, at)
    event(owner, 'operation.updated', account.id, op.id, 'created')
    return op
  }

  function mutationRevision(op: Operation, id: string): number | undefined {
    return db.query<{ revision: number }, [string, string]>('SELECT revision FROM sdk_messages WHERE id=? AND account=?').get(id, op.accountId)?.revision
  }

  function recordMutationRevision(op: Operation, id: string, before: number | undefined): void {
    const after = mutationRevision(op, id)
    // Historical operations have no acceptance lineage. Never reconstruct it
    // from today's row, nor bridge a change preceding this transaction.
    if (!op.mutationRevisions || before === undefined || after === undefined || after <= before) return
    // Accepted/settled/cancelled paths need at most three edges per selected
    // message. At the defensive bound, a missing edge fails closed for rebasing.
    if (op.mutationRevisions.length >= 2000) return
    op.mutationRevisions.push({ messageId: id, before, after })
    db.query('UPDATE sdk_operations SET data=? WHERE id=?').run(JSON.stringify(op), op.id)
  }

  function projectMutation(op: Operation, id: string): void {
    const before = mutationRevision(op, id)
    project(id)
    recordMutationRevision(op, id, before)
  }

  function restoreDraft(row: OperationRow): void {
    const payload = JSON.parse(row.payload) as SendPayload
    const stored = db.query<DataRow, [string, string]>('SELECT * FROM sdk_drafts WHERE owner=? AND id=?').get(row.owner, payload.draft.id)
    if (!stored) return
    const draft = JSON.parse(stored.data) as Draft
    if (draft.revision !== payload.draft.revision) return
    draft.status = 'active'
    db.query('UPDATE sdk_drafts SET data=? WHERE id=? AND owner=?').run(JSON.stringify(draft), draft.id, row.owner)
    event(row.owner, 'draft.updated', row.account, draft.id)
  }

  function ownsLease(row: OperationRow): boolean {
    const current = db.query<{ lease: string; status: string }, [string]>('SELECT lease,status FROM sdk_operations WHERE id=?').get(row.id)
    return current?.lease === row.lease && current.status === 'processing'
  }

  async function executeOperation(row: OperationRow): Promise<void> {
    let op = JSON.parse(row.data) as Operation
    const heartbeat = setInterval(() => {
      try { db.query("UPDATE sdk_operations SET lease_until=? WHERE id=? AND lease=? AND status='processing'").run(now() + leaseMs, row.id, row.lease) }
      catch { /* Recovery handles a lost database connection. */ }
    }, Math.max(25, Math.floor(leaseMs / 3)))
    heartbeat.unref?.()
    let dispatched = false
    let returnedMutation: { messageId: string; result: MailMessage | null | undefined; deleted: boolean } | undefined
    const persistenceProblem: Problem = { code: 'PARTIAL_MUTATION', message: 'The provider confirmed the change, but its local receipt could not be fully saved. Refresh and reconcile before trying again; automatic retry and undo are unavailable.', retryable: false }
    try {
      const account = accountRow(row.owner, row.account, true)
      if (account.generation !== row.generation) throw new InboxError('RECONNECT_REQUIRED', 'Account generation changed.', 409)
      if (row.type === 'send') {
        if (options.allowProviderWrites === false) throw new InboxError('PROVIDER_WRITES_DISABLED', 'Provider writes are disabled for this deployment.', 403)
        const payload = JSON.parse(row.payload) as SendPayload
        const draft = payload.draft
        validateDraft(row.owner, draft, true)
        const attachments = await Promise.all(payload.blobs.map(async blob => ({ filename: blob.filename,
          content: (await inbox.download(row.owner, blob.id)).content, contentType: blob.contentType, contentId: blob.contentId, inline: blob.inline })))
        if (!ownsLease(row) || !current(account)) return
        const input: SendInput = { accountId: row.account, from: draft.from, to: draft.to, cc: draft.cc, bcc: draft.bcc,
          subject: draft.subject, text: draft.bodyText, html: draft.bodyHtml, attachments,
          ...(['reply', 'replyAll'].includes(draft.mode) ? { threadId: payload.nativeThread, sourceMessageId: payload.nativeSource, inReplyTo: payload.inReplyTo,
            references: payload.references, replyAll: false } : {}), headers: { 'X-Inbox-Submission-ID': op.id } }
        const receipt = await io(account, provider => { dispatched = true; return provider.send(input) })
        transaction(() => {
          if (!ownsLease(row)) return
          if (!current(account)) {
            op.status = 'uncertain'; op.problem = { code: 'SEND_UNCERTAIN', message: 'The connection changed after dispatch; provider acceptance needs reconciliation.', retryable: false }
            saveOperation(row, op); return
          }
          const rejected = receipt.rejected?.length ?? 0
          const accepted = receipt.accepted?.length
          if (rejected && accepted === 0) {
            op.status = 'failed'; op.problem = { code: 'RECIPIENTS_REJECTED', message: 'The provider rejected all recipients.', retryable: false }
            saveOperation(row, op); restoreDraft(row); return
          }
          op.status = rejected || receipt.sentCopyUnconfirmed ? 'partial' : 'succeeded'
          if (rejected) op.problem = { code: 'RECIPIENTS_REJECTED', message: 'The provider rejected some recipients.', retryable: false }
          else if (receipt.sentCopyUnconfirmed) op.problem = { code: 'SENT_COPY_UNCONFIRMED', message: 'The message was accepted, but its Sent copy is unconfirmed. Do not resend.', retryable: false }
          const mail: MailMessage = { id: receipt.providerMessageId ?? `submission:${op.id}`, accountId: account.id,
            threadId: receipt.threadId ?? payload.nativeThread ?? `submission:${op.id}`, from: { name: draft.from, email: draft.from },
            to: draft.to, cc: draft.cc, bcc: draft.bcc, subject: draft.subject, preview: draft.bodyText.slice(0, 200),
            bodyText: draft.bodyText, bodyHtml: draft.bodyHtml, receivedAt: new Date(now()).toISOString(), isRead: true, isStarred: false,
            folder: 'sent', labels: [], attachments: payload.blobs.map(blob => ({ ...blob, url: `/v1/blobs/${blob.id}` })),
            ...(receipt.messageId ? { rfcMessageId: receipt.messageId } : {}) }
          const mid = persist(account, mail, 'mutation')
          const address = selector({ kind: 'address', value: draft.from })
          if (address.kind === 'address') {
            db.query('INSERT OR IGNORE INTO sdk_delivery_evidence VALUES (?,?,?,?,?)').run(row.owner, account.id, mid, 'address', address.value)
            db.query('INSERT OR IGNORE INTO sdk_delivery_evidence VALUES (?,?,?,?,?)').run(row.owner, account.id, mid, 'domain', address.value.split('@').at(-1)!)
            for (const box of db.query<MailboxRow, [string, string]>('SELECT * FROM sdk_mailboxes WHERE owner=? AND source=?').all(row.owner, account.id)) materializeMailbox(box, mid, 'mutation')
          }
          for (const blob of payload.blobs) {
            const source = db.query<BlobRow, [string, string]>('SELECT * FROM sdk_blobs WHERE id=? AND owner=?').get(blob.id, row.owner)
            if (source?.content !== null && source?.content !== undefined) db.query('UPDATE sdk_blobs SET content=? WHERE message_id=? AND attachment_id=? AND owner=?').run(source.content, mid, blob.id, row.owner)
          }
          op.results = [{ messageId: mid, status: 'succeeded' }]
          saveOperation(row, op)
          event(row.owner, 'draft.updated', account.id, draft.id)
        })
        return
      }

      const payload = JSON.parse(row.payload) as MutationPayload
      for (const id of payload.input.messageIds) {
        if (op.results.some(result => result.messageId === id)) continue
        if (!ownsLease(row) || !current(account)) return
        try {
          if (payload.input.viaMailboxId) membership(row.owner, payload.input.viaMailboxId, id)
          const change = payload.perMessageChanges?.[id] ?? payload.input.changes
          for (const label of [...change.addLabelIds ?? [], ...change.removeLabelIds ?? []]) if (!db.query('SELECT 1 FROM sdk_labels WHERE id=? AND owner=? AND account=?').get(label, row.owner, row.account)) throw new InboxError('NOT_FOUND', 'Label no longer exists.', 404)
          const stored = messageRow(row.owner, id)
          const native: Changes = {}
          for (const key of ['isRead','isStarred','isArchived','folder','addLabels','removeLabels','deletePermanently'] as const) {
            if (change[key] !== undefined) Object.assign(native, { [key]: change[key] })
          }
          if (change.folderId) {
            const folder = db.query<{ native_id: string }, [string, string, string]>('SELECT native_id FROM sdk_folders WHERE id=? AND owner=? AND account=?').get(change.folderId, row.owner, row.account)
            if (!folder) throw new InboxError('NOT_FOUND', 'Folder not found.', 404)
            native.folder = folder.native_id
          }
          if (Object.keys(native).length && stored.native_id.startsWith('submission:')) throw new InboxError('RECONCILIATION_PENDING', 'Wait for the provider to identify its sent copy before modifying this message.', 409)
          if (Object.keys(native).length && options.allowProviderWrites === false) throw new InboxError('PROVIDER_WRITES_DISABLED', 'Provider writes are disabled for this deployment.', 403)
          const result = Object.keys(native).length ? await io(account, provider => provider.mutate(stored.native_id, native)) : undefined
          if (Object.keys(native).length) returnedMutation = { messageId: id, result, deleted: native.deletePermanently === true && result === null }
          transaction(() => {
            if (!ownsLease(row) || !current(account)) return
            const beforeRevision = mutationRevision(op, id)
            if (result === null && !change.deletePermanently) throw new InboxError('INVALID_PROVIDER', 'Provider did not return the modified message.', 502)
            if (change.deletePermanently && result === null) {
              db.query('UPDATE sdk_messages SET deleted=1,revision=revision+1 WHERE id=?').run(id)
              event(row.owner, 'mail.changed', row.account, id, 'deleted')
            } else {
              if (result) persist(account, result, 'mutation', id)
              const fresh = messageRow(row.owner, id)
              let labels: string[] = JSON.parse(fresh.local_labels)
              labels = [...new Set([...labels, ...change.addLabelIds ?? []])].filter(label => !change.removeLabelIds?.includes(label))
              const snooze = change.folder === 'trash' || change.folder === 'spam' ? null
                : change.snoozedUntil !== undefined ? change.snoozedUntil : fresh.snoozed_until
              db.query('UPDATE sdk_messages SET local_labels=?,snoozed_until=? WHERE id=?').run(JSON.stringify(labels), snooze, id)
            }
            op.results.push({ messageId: id, status: 'succeeded' })
            db.query('UPDATE sdk_operations SET data=? WHERE id=?').run(JSON.stringify(op), op.id)
            project(id)
            payload.afterRevisions ??= {}
            payload.afterRevisions[id] = db.query<{ revision: number }, [string]>('SELECT revision FROM sdk_messages WHERE id=?').get(id)!.revision
            recordMutationRevision(op, id, beforeRevision)
            db.query('UPDATE sdk_operations SET payload=? WHERE id=?').run(JSON.stringify(payload), op.id)
            event(row.owner, 'mail.changed', row.account, id, change.deletePermanently ? 'deleted' : 'updated')
          })
          returnedMutation = undefined
        } catch (error) {
          // Discard every staged result/status/edge if its transaction rolled back.
          op = JSON.parse(operationRow(row.owner, row.id).data) as Operation
          const issue = failure(error)
          if (!returnedMutation && issue.retryable && op.attempts < 5) throw error
          transaction(() => {
            if (!ownsLease(row)) return
            const beforeRevision = mutationRevision(op, id)
            if (returnedMutation) {
              // Retry only local persistence, never the already-confirmed native call.
              if (returnedMutation.deleted) db.query('UPDATE sdk_messages SET deleted=1,revision=revision+1 WHERE id=? AND owner=?').run(id, row.owner)
              else if (returnedMutation.result) persist(account, returnedMutation.result, 'mutation', id)
            } else if (error instanceof ProviderMutationError) {
              if (error.confirmedMessage) persist(account, error.confirmedMessage, 'mutation', id)
              else if (error.sourceRetired) db.query('UPDATE sdk_messages SET deleted=2,revision=revision+1 WHERE id=? AND owner=?').run(id, row.owner)
            }
            const problem: Problem = returnedMutation ? persistenceProblem : error instanceof ProviderMutationError
              ? { code: 'PARTIAL_MUTATION', message: 'Some mailbox changes may have succeeded. Synchronize before retrying; automatic undo is unavailable.', retryable: false }
              : { code: issue.code, message: issue.message, retryable: false }
            op.results.push({ messageId: id, status: 'failed', problem }); op.problem = problem
            db.query('UPDATE sdk_operations SET data=? WHERE id=?').run(JSON.stringify(op), op.id)
            project(id); recordMutationRevision(op, id, beforeRevision); event(row.owner, 'mail.changed', row.account, id, returnedMutation?.deleted ? 'deleted' : 'updated')
          })
          returnedMutation = undefined
        }
      }
      transaction(() => {
        if (!ownsLease(row)) return
        const succeeded = op.results.filter(result => result.status === 'succeeded').length
        op.status = succeeded === payload.input.messageIds.length ? 'succeeded' : succeeded || op.results.some(result => result.problem?.code === 'PARTIAL_MUTATION') ? 'partial' : 'failed'
        saveOperation(row, op)
      })
    } catch (error) {
      op = JSON.parse(operationRow(row.owner, row.id).data) as Operation
      const issue = failure(error)
      const definitelyRejected = ['AUTHENTICATION','AUTHORIZATION','VALIDATION','NOT_FOUND','UNSUPPORTED_OPERATION','RATE_LIMITED','CREDENTIALS_UNAVAILABLE','CREDENTIALS_REVOKED'].includes(issue.code)
      transaction(() => {
        if (!ownsLease(row)) return
        const unknownSend = row.type === 'send' && dispatched && !definitelyRejected
        const retry = !returnedMutation && !unknownSend && issue.retryable && op.attempts < 5
        op.status = returnedMutation ? 'partial' : unknownSend ? 'uncertain' : retry ? 'pending' : 'failed'
        op.problem = returnedMutation ? persistenceProblem : unknownSend
          ? { code: 'SEND_UNCERTAIN', message: 'Provider acceptance is unknown. Do not resend without reconciliation.', retryable: false }
          : { code: issue.code, message: issue.message, retryable: retry }
        const retryAfter = (error instanceof ProviderError || error instanceof CredentialError) && Number.isFinite(error.retryAfter) ? Math.max(0, error.retryAfter!) * 1000 : 0
        saveOperation(row, op, retry ? now() + Math.max(retryAfter, Math.min(300_000, 1000 * 2 ** op.attempts)) : row.next_at)
        if (row.type === 'mutation' && !retry) for (const id of (JSON.parse(row.payload) as MutationPayload).input.messageIds) {
          // If receipt recovery also failed, keep the cached projection explicitly
          // unconfirmed. Do not invent a rollback or edge for the known native change.
          if (id === returnedMutation?.messageId) continue
          projectMutation(op, id); event(row.owner, 'mail.changed', row.account, id)
        }
        if (row.type === 'send' && op.status === 'failed') restoreDraft(row)
      })
      options.log?.({ code: issue.code, operation: row.type })
    } finally { clearInterval(heartbeat) }
  }

  async function processDue(): Promise<number> {
    transaction(() => {
      const expired = db.query<OperationRow, [number]>("SELECT * FROM sdk_operations WHERE status='processing' AND lease_until<=?").all(now())
      for (const row of expired) {
        const op = JSON.parse(row.data) as Operation
        op.status = row.type === 'send' ? 'uncertain' : 'pending'
        if (row.type === 'send') op.problem = { code: 'SEND_UNCERTAIN', message: 'A worker stopped after claiming this send. Reconcile before retrying.', retryable: false }
        saveOperation(row, op, now())
        db.query('UPDATE sdk_operations SET lease=NULL,lease_until=0 WHERE id=?').run(row.id)
      }
      const wake = db.query<MessageRow, [string]>('SELECT * FROM sdk_messages WHERE deleted=0 AND snoozed_until IS NOT NULL AND snoozed_until<=?').all(new Date(now()).toISOString())
      for (const row of wake) {
        db.query('UPDATE sdk_messages SET snoozed_until=NULL WHERE id=?').run(row.id)
        project(row.id); event(row.owner, 'mail.changed', row.account, row.id)
      }
      const memberships = db.query<MembershipRow, [string]>("SELECT * FROM sdk_memberships WHERE json_extract(data,'$.snoozedUntil') IS NOT NULL AND json_extract(data,'$.snoozedUntil')<=?").all(new Date(now()).toISOString())
      for (const row of memberships) {
        const state = JSON.parse(row.data) as MailboxMembership
        state.snoozedUntil = null; state.revision += 1
        db.query('UPDATE sdk_memberships SET data=? WHERE mailbox=? AND message=?').run(JSON.stringify(state), row.mailbox, row.message)
        event(row.owner, 'membership.updated', row.source, row.message, 'updated', 'mutation', row.mailbox)
      }
    })
    // Claim one operation per account. Other processes see the same durable leases.
    const claims = transaction(() => {
      const localOnly = options.allowProviderWrites === false ? `AND o.type='mutation'
        AND NOT EXISTS(SELECT 1 FROM json_each(json_extract(o.payload,'$.input.changes')) c WHERE c.key NOT IN ('addLabelIds','removeLabelIds','snoozedUntil'))
        AND NOT EXISTS(SELECT 1 FROM json_each(json_extract(o.payload,'$.perMessageChanges')) p,json_each(p.value) c WHERE c.key NOT IN ('addLabelIds','removeLabelIds','snoozedUntil'))` : ''
      const candidates = db.query<OperationRow, [number, number]>(`SELECT o.* FROM sdk_operations o JOIN sdk_accounts a ON a.id=o.account AND a.owner=o.owner
        WHERE o.status='pending' AND o.next_at<=? AND a.status='connected' AND a.generation=o.generation
        ${localOnly}
        AND NOT EXISTS(SELECT 1 FROM sdk_operations busy WHERE busy.account=o.account AND busy.status='processing' AND busy.lease_until>?) ORDER BY o.seq LIMIT 100`).all(now(), now())
      const accounts = new Set<string>(); const claims: OperationRow[] = []
      for (const row of candidates) {
        if (claims.length >= concurrency || accounts.has(row.account)) continue
        if (row.type === 'mutation') {
          const ids = (JSON.parse(row.payload) as MutationPayload).input.messageIds
          const earlier = db.query<OperationRow, [string, number]>("SELECT * FROM sdk_operations WHERE account=? AND seq<? AND type='mutation' AND status IN ('pending','processing')").all(row.account, row.seq)
          if (earlier.some(other => (JSON.parse(other.payload) as MutationPayload).input.messageIds.some(id => ids.includes(id)))) continue
        }
        const op = JSON.parse(row.data) as Operation
        op.attempts += 1; op.status = 'processing'; row.lease = randomUUID(); row.status = 'processing'; row.data = JSON.stringify(op)
        const result = db.query("UPDATE sdk_operations SET lease=?,lease_until=?,status='processing',data=? WHERE id=? AND status='pending'").run(row.lease, now() + leaseMs, row.data, row.id)
        if (!result.changes) continue
        accounts.add(row.account); claims.push(row); event(row.owner, 'operation.updated', row.account, row.id)
      }
      return claims
    })
    await runtime.runPromise(Effect.forEach(claims, row => Effect.tryPromise({ try: () => executeOperation(row), catch: failure }).pipe(
      Effect.catchAll(error => Effect.sync(() => options.log?.({ code: error.code, operation: row.type }))),
    ), { concurrency, discard: true }))
    return claims.length
  }

  function verifiedConnection(owner: string, providerId: string, identity: ConnectionIdentity): ConnectionRow | null {
    return db.query<ConnectionRow, [string, string, string, string, string]>(`SELECT * FROM sdk_connections WHERE owner=? AND json_extract(data,'$.providerId')=?
      AND json_extract(data,'$.identity.issuer')=? AND json_extract(data,'$.identity.subject')=? AND json_extract(data,'$.identity.registrationId')=?`).get(owner, providerId, identity.issuer, identity.subject, identity.registrationId)
  }

  async function connectSource(owner: string, input: { providerId: string; credentials: Record<string, unknown> }, identity: ConnectionIdentity | null = null): Promise<Account> {
      ownerId(owner)
      const definition = definitions.get(input.providerId)
      if (!definition) throw new InboxError('UNSUPPORTED_PROVIDER', 'This provider is not registered.', 409)
      const credentials = credentialRecord(input.credentials)
      if (identity) identity = checkedIdentity(identity)
      const id = randomUUID()
      const connectionId = randomUUID()
      const controller = new AbortController()
      const provider = await definition.create({ ...credentials, accountId: id, userId: owner,
        sdkMailboxScopes: undefined, fetch: ((input, init) => (options.fetch ?? globalThis.fetch)(input, { ...init,
          signal: AbortSignal.any([controller.signal, init?.signal ?? AbortSignal.timeout(30_000)]) })) as typeof fetch }, { signal: controller.signal })
      try {
        const native = await provider.getAccount()
        if (provider.accountId !== id || native.id !== id) throw new InboxError('INVALID_PROVIDER', 'Provider returned a foreign account.', 502)
        if (definition.discover) {
          const discovered = await definition.discover(provider)
          native.aliases = [...new Set(discovered.identities.map(value => value.email))]
        }
        const account: Account = { id, providerId: definition.id, email: native.email, name: native.name, generation: 1,
          status: 'connected', capabilities: { ...provider.capabilities },
          features: { localDrafts: true, localLabels: true, snooze: true, scheduledSend: provider.capabilities.send, undoSend: provider.capabilities.send },
          sync: { lastSyncAt: null, coverage: 'empty', problem: null }, revision: 1, connectionId }
        const connection: Connection = { id: connectionId, providerId: definition.id, name: native.name || native.email || definition.name,
          status: 'connected', generation: 1, sourceIds: [id], identity, createdAt: new Date(now()).toISOString() }
        transaction(() => {
          if (identity && verifiedConnection(owner, definition.id, identity)) throw new InboxError('CONNECTION_EXISTS', 'This provider identity is already connected.', 409)
          db.query('INSERT INTO sdk_connections(id,owner,generation,status,data,credentials) VALUES (?,?,?,?,?,?)').run(connectionId, owner, 1, connection.status, JSON.stringify(connection), crypto.encryptCredential(JSON.stringify(credentials), owner, connectionId))
          db.query('INSERT INTO sdk_accounts VALUES (?,?,?,?,?,?,?)').run(id, owner, 1, 'connected', JSON.stringify(account), JSON.stringify(native), '')
          db.query('INSERT INTO sdk_source_connections(source,owner,connection) VALUES (?,?,?)').run(id, owner, connectionId)
          if (definition.mailboxSelection !== 'manual') {
            const mailbox: Mailbox = { id, sourceId: id, connectionId, name: account.name || account.email || definition.name, selector: { kind: 'all' }, status: 'active', defaultSender: native.email || null, revision: 1, receiving: 'unverified' }
            db.query('INSERT INTO sdk_mailboxes VALUES (?,?,?,?,?,?)').run(id, owner, id, connectionId, JSON.stringify(mailbox.selector), JSON.stringify(mailbox))
            event(owner, 'mailbox.updated', id, id, 'created', 'initial', id)
          }
          event(owner, 'connection.updated', id, connectionId, 'created')
          event(owner, 'account.updated', id, id, 'created')
        })
        const row = accountRow(owner, id)
        instances.set(generationKey(row), Promise.resolve(provider))
        instanceVersions.set(generationKey(row), 1)
        controllers.set(generationKey(row), controller)
        return account
      } catch (error) { controller.abort(); await provider.disconnect().catch(() => {}); throw error }
  }

  async function reconnectSource(owner: string, id: string, credentials: Record<string, unknown>, identity?: ConnectionIdentity, expectedGeneration?: number): Promise<Account> {
      const old = accountRow(owner, id)
      const oldGrant = connectionRow(owner, old.connection_id)
      const suppliedCredentials = credentialRecord(credentials)
      credentials = suppliedCredentials
      if (identity) identity = checkedIdentity(identity)
      const grant = publicConnection(oldGrant)
      if (expectedGeneration !== undefined && grant.generation !== expectedGeneration) throw new InboxError('CONFLICT', 'Connection changed during authorization.', 409)
      if (grant.identity && !identity) throw new InboxError('SOURCE_IDENTITY_UNVERIFIED', 'The host must verify the existing connection identity before reconnecting.', 409)
      if (identity && (!grant.identity || fingerprint(grant.identity) !== fingerprint(identity))) throw new InboxError('ACCOUNT_MISMATCH', 'Reconnect must authorize the same provider identity.', 409)
      const definition = definitions.get((JSON.parse(old.data) as Account).providerId)
      if (!definition) throw new InboxError('UNSUPPORTED_PROVIDER', 'This provider is not registered.', 409)
      if (!identity && definition.credentialReconnect === false) throw new InboxError('SOURCE_IDENTITY_UNVERIFIED', 'This provider cannot verify an in-place credential replacement. Create a separate connection.', 409)
      if (identity && oldGrant.credentials) credentials = { ...JSON.parse(crypto.decryptCredential(oldGrant.credentials, owner, oldGrant.id)), ...suppliedCredentials }
      const controller = new AbortController()
      const provider = await definition.create({ ...credentials, accountId: id, userId: owner, sdkMailboxScopes: undefined,
        fetch: ((input, init) => (options.fetch ?? globalThis.fetch)(input, { ...init,
          signal: AbortSignal.any([controller.signal, init?.signal ?? AbortSignal.timeout(30_000)]) })) as typeof fetch }, { signal: controller.signal })
      try {
        const native = await provider.getAccount()
        const previous = JSON.parse(old.data) as Account
        if (native.id !== id || (!identity && native.email.toLowerCase() !== previous.email.toLowerCase())) throw new InboxError('ACCOUNT_MISMATCH', 'Reconnect must authorize the same mailbox.', 409)
        if (definition.discover) native.aliases = (await definition.discover(provider)).identities.map(value => value.email)
        const account: Account = { ...previous, email: native.email, name: native.name || previous.name, generation: old.generation + 1, status: 'connected', capabilities: { ...provider.capabilities },
          features: { ...previous.features, scheduledSend: provider.capabilities.send, undoSend: provider.capabilities.send },
          sync: { lastSyncAt: null, coverage: previous.sync.coverage === 'empty' ? 'empty' : 'partial', problem: null }, revision: previous.revision + 1 }
        transaction(() => {
          if (accountRow(owner, id).generation !== old.generation) throw new InboxError('CONFLICT', 'Account connection changed.', 409)
          const latestGrant = connectionRow(owner, grant.id)
          if (latestGrant.generation !== oldGrant.generation) throw new InboxError('CONFLICT', 'Connection authorization changed.', 409)
          const storedCredentials = identity && latestGrant.credentials
            ? { ...JSON.parse(crypto.decryptCredential(latestGrant.credentials, owner, latestGrant.id)), ...suppliedCredentials } : suppliedCredentials
          grant.generation += 1; grant.status = 'connected'; grant.name = account.name
          db.query('UPDATE sdk_connections SET generation=?,status=?,data=?,credentials=?,credential_version=credential_version+1 WHERE id=? AND owner=? AND generation=?').run(grant.generation, grant.status, JSON.stringify(grant), crypto.encryptCredential(JSON.stringify(storedCredentials), owner, grant.id), grant.id, owner, oldGrant.generation)
          db.query('UPDATE sdk_accounts SET generation=?,status=?,data=?,native=?,credentials=\'\' WHERE id=? AND owner=?').run(account.generation, account.status, JSON.stringify(account), JSON.stringify(native), id, owner)
          // A credential generation fences in-flight work; it does not replace mailbox identity.
          for (const table of ['sdk_messages', 'sdk_blobs', 'sdk_folders', 'sdk_thread_keys', 'sdk_native_keys', 'sdk_checkpoints']) db.query(`UPDATE ${table} SET generation=? WHERE account=? AND generation=?`).run(account.generation, id, old.generation)
          db.query('DELETE FROM sdk_checkpoints WHERE account=?').run(id)
          db.query('DELETE FROM sdk_cooldowns WHERE account=?').run(id)
          const active = db.query<OperationRow, [string]>("SELECT * FROM sdk_operations WHERE account=? AND status='processing'").all(id)
          for (const job of active) {
            const op = JSON.parse(job.data) as Operation
            op.status = job.type === 'send' ? 'uncertain' : 'pending'
            if (job.type === 'send') op.problem = { code: 'SEND_UNCERTAIN', message: 'The connection changed during dispatch. Reconcile before retrying.', retryable: false }
            saveOperation(job, op, now())
            db.query('UPDATE sdk_operations SET lease=NULL,lease_until=0 WHERE id=?').run(job.id)
          }
          db.query("UPDATE sdk_operations SET generation=? WHERE account=? AND status='pending'").run(account.generation, id)
          event(owner, 'account.updated', id, id)
          event(owner, 'connection.updated', id, grant.id)
        })
        retireCredentials(oldGrant)
        const row = accountRow(owner, id)
        instances.set(generationKey(row), Promise.resolve(provider)); controllers.set(generationKey(row), controller)
        instanceVersions.set(generationKey(row), row.credential_version)
        return account
      } catch (error) { controller.abort(); await provider.disconnect().catch(() => {}); throw error }
  }

  async function replaceCredentials(owner: string, id: string, input: Record<string, unknown>, version: number, identity?: ConnectionIdentity): Promise<CredentialState> {
    const original = connectionRow(owner, id)
    if (!Number.isSafeInteger(version) || version < 1) throw new InboxError('INVALID_INPUT', 'A credential version is required.')
    if (original.credential_version !== version) throw new InboxError('PRECONDITION_FAILED', 'Connection credentials have changed.', 412)
    if (original.status === 'disconnected') throw new InboxError('CONNECTION_DISCONNECTED', 'Explicitly reconnect this connection before replacing credentials.', 409)
    const connection = publicConnection(original)
    const definition = definitions.get(connection.providerId)
    if (!definition) throw new InboxError('UNSUPPORTED_PROVIDER', 'This provider is not registered.', 409)
    const credentials = credentialRecord(input)
    const signal = AbortSignal.timeout(25_000)
    let verified = false
    if (identity) {
      identity = checkedIdentity(identity)
      if (!connection.identity || fingerprint(identity) !== fingerprint(connection.identity)) throw new InboxError('ACCOUNT_MISMATCH', 'Credentials must belong to the existing source identity.', 409)
      verified = true
    }
    if (!verified && options.verifyCredentials) {
      try { verified = await credentialCall(signal, () => options.verifyCredentials!({ owner, connection, credentials: structuredClone(credentials), reason: 'update', signal })) === true }
      catch (error) {
        if (error instanceof InboxError) throw error
        throw new CredentialError('unavailable', 'The host could not verify replacement credentials.')
      }
    }
    if (!verified && (connection.identity || definition.credentialReconnect === false)) {
      throw new InboxError('SOURCE_IDENTITY_UNVERIFIED', 'The host must verify that replacement credentials address the same upstream store.', 409)
    }
    const profiles: Array<{ sourceId: string; native: MailAccount; provider: InboxProvider }> = []
    const created: InboxProvider[] = []
    try {
      for (const sourceId of connection.sourceIds) {
        const source = accountRow(owner, sourceId)
        if (source.connection_id !== id || source.status === 'disconnected') continue
        const provider = await definition.create({ ...credentials, accountId: sourceId, userId: owner, sdkMailboxScopes: undefined,
          fetch: ((request, init) => (options.fetch ?? globalThis.fetch)(request, { ...init, signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) })) as typeof fetch }, { signal })
        created.push(provider)
        const native = await credentialCall(signal, () => provider.getAccount())
        if (provider.accountId !== sourceId || native.id !== sourceId) throw new InboxError('INVALID_PROVIDER', 'Provider returned a foreign account.', 502)
        if (!verified && (!native.email || !(JSON.parse(source.data) as Account).email || native.email.toLowerCase() !== (JSON.parse(source.data) as Account).email.toLowerCase())) {
          throw new InboxError('ACCOUNT_MISMATCH', 'Replacement credentials belong to another mailbox.', 409)
        }
        if (definition.discover) native.aliases = (await definition.discover(provider)).identities.map(identity => identity.email)
        profiles.push({ sourceId, native, provider })
      }
      if (closed || stopping) throw new InboxError('CLOSED', 'The inbox instance is closing.', 503)
      if (connectionRow(owner, id).credential_version !== version) throw new InboxError('PRECONDITION_FAILED', 'Connection credentials have changed.', 412)
      return publicCredentialState(saveCredentials(original, credentials, true, profiles))
    } finally { await Promise.allSettled(created.map(provider => provider.disconnect())) }
  }

  function synchronizeSource(owner: string, id: string, request: SyncRequest = {}, mailboxScoped = false): Promise<{ synchronized: number; hasMore: boolean; state: string }> {
    const scope = request.folder ?? 'inbox'; const lane = request.lane ?? 'latest'
    let generation: number
    let connectionGeneration: number
    let selection: ReturnType<typeof sourceSelection> | undefined
    try {
      if (closed || stopping) throw new InboxError('CLOSED', 'The inbox instance is closed.', 503)
      const source = accountRow(owner, id)
      generation = source.generation; connectionGeneration = source.connection_generation
      if (mailboxScoped) {
        selection = sourceSelection(owner, id)
        if (!selection.count) throw new InboxError('MAILBOX_SELECTION_REQUIRED', 'Select an active mailbox before synchronizing.', 409)
      }
    } catch (error) { return Promise.reject(failure(error)) }
    const checkpointScope = selection ? `mailboxes:${selection.key}:${scope}` : scope
    const key = `${owner}\0${id}\0${generation}\0${connectionGeneration}\0${checkpointScope}\0${lane}\0${!!request.reset}`
    const existing = syncing.get(key)
    if (existing) return existing
    const promise = run(async () => {
      const row = accountRow(owner, id, true)
      const scopeCurrent = () => !selection || sourceSelection(owner, id).key === selection.key
      if (!scopeCurrent()) throw new InboxError('SCOPE_CHANGED', 'Mailbox selection changed. Retry synchronization.', 409)
      const cooldown = db.query<{ next_at: number; failures: number; hard: number }, [string]>('SELECT next_at,failures,hard FROM sdk_cooldowns WHERE account=?').get(id)
      if (cooldown?.hard && cooldown.next_at > now()) throw new InboxError('RATE_LIMITED', 'This mailbox is waiting before retrying synchronization.', 429, true)
      const saved = db.query<{ data: string }, [string, number, string, string]>('SELECT data FROM sdk_checkpoints WHERE account=? AND generation=? AND scope=? AND lane=?').get(id, row.generation, checkpointScope, lane)
      const checkpoint: SyncCheckpoint = request.reset || !saved ? { cursor: null, initialized: false } : JSON.parse(saved.data)
      let fence: number
      const known = db.query<{ native_id: string; is_read: number; is_starred: number }, [string, number]>(
        "SELECT native_id,json_extract(confirmed,'$.isRead') is_read,json_extract(confirmed,'$.isStarred') is_starred FROM sdk_messages WHERE account=? AND generation=? AND deleted=0").all(id, row.generation)
      const syncOptions = { folder: scope, limit: request.limit ?? 100, ...(selection?.scopes ? { mailboxScopes: selection.scopes } : {}) }
      // Runtime hints are separate from providers' validated operation input.
      const syncContext = {
        knownMessageIds: known.map(message => message.native_id),
        knownMessageStates: known.map(message => ({ id: message.native_id, isRead: Boolean(message.is_read), isStarred: Boolean(message.is_starred) })) }
      let page: SyncResult
      try {
        const provider = await providerFor(row)
        if (!provider.capabilities.sync) throw new InboxError('UNSUPPORTED_OPERATION', 'Synchronization is unavailable.', 409)
        fence = sequence(owner)
        try { page = await io(row, p => p.sync(checkpoint.cursor, syncOptions, syncContext)) }
        catch (error) {
          if (!(error instanceof ProviderError) || error.code !== 'INVALID_CURSOR' || !checkpoint.cursor) throw error
          checkpoint.cursor = null; checkpoint.initialized = false
          page = await io(row, p => p.sync(null, syncOptions, syncContext))
        }
      } catch (error) {
        if (error instanceof CredentialError && error.reason === 'revoked') throw error
        if (!current(row)) throw new InboxError('RECONNECT_REQUIRED', 'Account connection changed.', 409)
        const problem = failure(error)
        transaction(() => {
          const account = JSON.parse(accountRow(owner, id).data) as Account
          account.sync.problem = problem.code
          if (problem.retryable) {
            const failures = (cooldown?.failures ?? 0) + 1
            const after = (error instanceof ProviderError || error instanceof CredentialError) && Number.isFinite(error.retryAfter) ? Math.max(0, error.retryAfter!) * 1000 : 0
            const delay = Math.max(after, Math.min(300_000, 1000 * 2 ** failures))
            db.query('INSERT INTO sdk_cooldowns VALUES (?,?,?,?) ON CONFLICT(account) DO UPDATE SET next_at=excluded.next_at,failures=excluded.failures,hard=excluded.hard').run(id, now() + delay, failures, Number(problem.code === 'RATE_LIMITED'))
          }
          if (problem.code === 'INVALID_CURSOR') {
            account.sync.coverage = 'partial'
            db.query('DELETE FROM sdk_checkpoints WHERE account=? AND generation=? AND scope=? AND lane=?').run(id, row.generation, checkpointScope, lane)
          }
          account.revision += 1
          db.query('UPDATE sdk_accounts SET data=?,status=? WHERE id=?').run(JSON.stringify(account), account.status, id)
          event(owner, 'account.updated', id, id)
        })
        throw problem
      }
      if (!current(row)) throw new InboxError('RECONNECT_REQUIRED', 'Account connection changed during synchronization.', 409)
      if (!scopeCurrent()) throw new InboxError('SCOPE_CHANGED', 'Mailbox selection changed during synchronization.', 409)
      if (!Array.isArray(page.messages) || (page.hasMore && !page.cursor)) throw new InboxError('INVALID_PROVIDER', 'Provider returned an invalid synchronization page.', 502)
      if (page.hasMore && checkpoint.cursor && fingerprint(page.cursor) === fingerprint(checkpoint.cursor)) throw new InboxError('INVALID_CURSOR', 'Provider synchronization did not advance.', 502)
      transaction(() => {
        if (!current(row)) throw new InboxError('RECONNECT_REQUIRED', 'Account connection changed.', 409)
        if (!scopeCurrent()) throw new InboxError('SCOPE_CHANGED', 'Mailbox selection changed during synchronization.', 409)
        const reason = lane === 'backfill' ? 'backfill' : page.fullSync || !checkpoint.initialized ? 'initial' : 'arrival'
        for (const message of page.messages) persist(row, message, reason, undefined, fence)
        for (const nativeId of page.retiredMessageIds ?? []) {
          const removed = db.query<MessageRow, [string, number, string]>('SELECT * FROM sdk_messages WHERE account=? AND generation=? AND native_id=? AND deleted=0').get(id, row.generation, nativeId)
          if (!removed || lane === 'backfill' || removed.last_mutation_seq > fence) continue
          // A mailbox-scoped identity vanished. Hide this instance, without inventing an
          // Archive membership or permanently tombstoning possible later authoritative evidence.
          db.query('UPDATE sdk_messages SET deleted=2,revision=revision+1 WHERE id=?').run(removed.id)
          event(owner, 'mail.changed', id, removed.id, 'deleted')
        }
        for (const nativeId of page.deletedMessageIds) {
          const removed = db.query<MessageRow, [string, number, string]>('SELECT * FROM sdk_messages WHERE account=? AND generation=? AND native_id=? AND deleted=0').get(id, row.generation, nativeId)
          if (removed && lane !== 'backfill' && removed.last_mutation_seq <= fence) {
            db.query('UPDATE sdk_messages SET deleted=1,revision=revision+1 WHERE id=?').run(removed.id)
            event(owner, 'mail.changed', id, removed.id, 'deleted')
          }
        }
        for (const nativeId of page.removedMessageIds ?? []) {
          const removed = db.query<MessageRow, [string, number, string]>('SELECT * FROM sdk_messages WHERE account=? AND generation=? AND native_id=? AND deleted=0').get(id, row.generation, nativeId)
          if (!removed || lane === 'backfill' || removed.last_mutation_seq > fence) continue
          const value: MessageSummary = JSON.parse(removed.confirmed)
          const folderIds = db.query<{ id: string }, [string, string, string]>('SELECT id FROM sdk_folders WHERE account=? AND (native_id=? OR json_extract(data,\'$.role\')=?)').all(id, scope, scope)
          value.folderIds = value.folderIds.filter(fid => !folderIds.some(folder => folder.id === fid))
          if (value.folder === scope) value.folder = 'archive'
          db.query('UPDATE sdk_messages SET confirmed=? WHERE id=?').run(JSON.stringify(value), removed.id)
          project(removed.id); event(owner, 'mail.changed', id, removed.id)
        }
        const cursor = lane === 'backfill' ? (page.hasMore ? page.cursor : null) : page.recentCursor ?? page.cursor
        if (lane === 'backfill' && !page.hasMore && page.recentCursor) {
          db.query('INSERT INTO sdk_checkpoints VALUES (?,?,?,?,?) ON CONFLICT(account,generation,scope,lane) DO UPDATE SET data=excluded.data').run(id, row.generation, checkpointScope, 'latest', JSON.stringify({ cursor: page.recentCursor, initialized: true }))
        }
        db.query('INSERT INTO sdk_checkpoints VALUES (?,?,?,?,?) ON CONFLICT(account,generation,scope,lane) DO UPDATE SET data=excluded.data').run(id, row.generation, checkpointScope, lane, JSON.stringify({ cursor, initialized: true }))
        const account = JSON.parse(accountRow(owner, id).data) as Account
        // An incremental poll finishing is not proof that older history was imported.
        const coverage = scope !== 'inbox' ? account.sync.coverage
          : page.hasMore ? 'partial' : page.snapshotComplete === false ? account.sync.coverage : 'complete'
        const changed = account.sync.coverage !== coverage || account.sync.problem !== null
        account.sync = { lastSyncAt: new Date(now()).toISOString(), coverage, problem: null }
        if (changed) account.revision += 1
        db.query('UPDATE sdk_accounts SET data=? WHERE id=?').run(JSON.stringify(account), id)
        db.query('DELETE FROM sdk_cooldowns WHERE account=?').run(id)
        if (changed) event(owner, 'account.updated', id, id)
      })
      return { synchronized: page.messages.length, hasMore: page.hasMore, state: token(owner, sequence(owner)) }
    }).finally(() => syncing.delete(key))
    syncing.set(key, promise)
    return promise
  }

  const inbox: Inbox = {
    providers: () => [...definitions.values()].map(definition => ({ id: definition.id, name: definition.name,
      connection: definition.connection ?? 'credentials', scopes: [...definition.scopes ?? []] })),
    connect: (owner, input) => run(() => connectSource(owner, input)),
    reconnect: (owner, id, credentials, authorization) => run(() => reconnectSource(owner, id, credentials, authorization?.identity, authorization?.generation)),

    disconnect: (owner, id) => run(async () => {
      const row = accountRow(owner, id)
      transaction(() => {
        const account: Account = { ...JSON.parse(row.data), status: 'disconnected', generation: row.generation + 1 }
        account.revision += 1
        db.query('UPDATE sdk_accounts SET status=?,generation=?,data=?,credentials=? WHERE owner=? AND id=?').run(account.status, account.generation, JSON.stringify(account), '', owner, id)
        for (const table of ['sdk_messages', 'sdk_blobs', 'sdk_folders', 'sdk_thread_keys', 'sdk_native_keys', 'sdk_checkpoints']) db.query(`UPDATE ${table} SET generation=? WHERE account=? AND generation=?`).run(account.generation, id, row.generation)
        const pending = db.query<OperationRow, [string, string]>("SELECT * FROM sdk_operations WHERE owner=? AND account=? AND status IN ('pending','processing')").all(owner, id)
        for (const job of pending) {
          const op = JSON.parse(job.data) as Operation
          op.status = job.status === 'processing' && job.type === 'send' ? 'uncertain' : 'cancelled'
          saveOperation(job, op)
          if (job.type === 'mutation') for (const mid of (JSON.parse(job.payload) as MutationPayload).input.messageIds) projectMutation(op, mid)
          else if (op.status === 'cancelled') restoreDraft(job)
        }
        const remaining = db.query<{ count: number }, [string, string]>(`SELECT COUNT(*) count FROM sdk_source_connections s JOIN sdk_accounts a ON a.id=s.source AND a.owner=s.owner
          WHERE s.owner=? AND s.connection=? AND a.status='connected'`).get(owner, row.connection_id)!.count
        if (!remaining) {
          const connection = publicConnection(connectionRow(owner, row.connection_id))
          connection.status = 'disconnected'; connection.generation += 1
          db.query('UPDATE sdk_connections SET status=?,generation=?,credentials=\'\',data=? WHERE id=? AND owner=?').run(connection.status, connection.generation, JSON.stringify(connection), connection.id, owner)
          event(owner, 'connection.updated', id, connection.id)
        }
        event(owner, 'account.updated', id, id)
      })
      retireSource(owner, id)
      await Promise.allSettled(disconnecting)
    }),

    accounts: owner => run(() => {
      ownerId(owner)
      return db.query<AccountRow, [string]>('SELECT * FROM sdk_accounts WHERE owner=? ORDER BY rowid').all(owner).map(row => JSON.parse(row.data))
    }),
    account: (owner, id) => run(() => JSON.parse(accountRow(owner, id).data)),

    connections: owner => run(() => {
      ownerId(owner)
      return db.query<ConnectionRow, [string]>('SELECT * FROM sdk_connections WHERE owner=? ORDER BY rowid').all(owner).map(publicConnection)
    }),
    connection: (owner, id) => run(() => publicConnection(connectionRow(owner, id))),
    createConnection: (owner, input, identity) => run(async () => {
      const source = await connectSource(owner, input, identity)
      return publicConnection(connectionRow(owner, source.connectionId!))
    }),
    credentialState: (owner, id) => run(() => publicCredentialState(connectionRow(owner, id))),
    updateCredentials: (owner, id, credentials, version, identity) => {
      const promise = run(() => replaceCredentials(owner, id, credentials, version, identity)).finally(() => credentialUpdates.delete(promise))
      credentialUpdates.add(promise)
      return promise
    },
    disconnectConnection: (owner, id) => run(async () => {
      const connection = publicConnection(connectionRow(owner, id))
      for (const sourceId of connection.sourceIds) await inbox.disconnect(owner, sourceId)
    }),
    mailboxCandidates: (owner, id) => run(() => candidates(owner, id)),
    mailboxes: owner => run(() => {
      ownerId(owner)
      return db.query<MailboxRow, [string]>('SELECT * FROM sdk_mailboxes WHERE owner=? ORDER BY rowid').all(owner).map(row => JSON.parse(row.data))
    }),
    mailbox: (owner, id) => run(() => JSON.parse(mailboxRow(owner, id).data)),
    createMailbox: (owner, input) => run(async () => {
      const source = accountRow(owner, input.sourceId, true)
      const scope = selector(input.selector)
      const name = text(input.name, 'Mailbox name')
      const offered = (await candidates(owner, source.connection_id)).find(value => value.sourceId === source.id && fingerprint(value.selector) === fingerprint(scope))
      if (!offered || !offered.canFilter) throw new InboxError('UNSUPPORTED_SCOPE', 'This connection cannot prove the selected mailbox scope.', 409)
      const defaultSender = input.defaultSender === undefined ? offered.identities.length === 1 ? offered.identities[0]! : null : input.defaultSender
      if (defaultSender !== null && !offered.identities.includes(defaultSender)) throw new InboxError('FORBIDDEN_SENDER', 'The default sender is not verified for this mailbox.', 403)
      return transaction(() => {
        if (!current(source)) throw new InboxError('RECONNECT_REQUIRED', 'Connection changed during mailbox setup.', 409)
        if (db.query("SELECT 1 FROM sdk_mailboxes WHERE owner=? AND source=? AND json_extract(data,'$.status')<>'detached' AND lower(json_extract(data,'$.name'))=lower(?)").get(owner, source.id, name)) throw new InboxError('CONFLICT', 'A mailbox with this name already exists.', 409)
        const existing = db.query<MailboxRow, [string, string, string]>('SELECT * FROM sdk_mailboxes WHERE owner=? AND source=? AND selector=?').get(owner, source.id, JSON.stringify(scope))
        if (existing && (JSON.parse(existing.data) as Mailbox).status !== 'detached') throw new InboxError('CONFLICT', 'This mailbox scope is already configured.', 409)
        const mailbox: Mailbox = { id: existing?.id ?? randomUUID(), sourceId: source.id, connectionId: source.connection_id, name,
          selector: scope, status: 'active', defaultSender, revision: existing ? (JSON.parse(existing.data) as Mailbox).revision + 1 : 1,
          receiving: offered.canReceive ? 'ready' : 'blocked' }
        db.query('INSERT INTO sdk_mailboxes VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(mailbox.id, owner, source.id, source.connection_id, JSON.stringify(scope), JSON.stringify(mailbox))
        const row = mailboxRow(owner, mailbox.id)
        for (const msg of db.query<{ id: string }, [string, string]>('SELECT id FROM sdk_messages WHERE owner=? AND account=? AND deleted=0').all(owner, source.id)) materializeMailbox(row, msg.id, 'initial')
        event(owner, 'mailbox.updated', source.id, mailbox.id, existing ? 'updated' : 'created', 'initial', mailbox.id)
        return mailbox
      })
    }),
    updateMailbox: (owner, id, input, revision) => run(async () => {
      const row = mailboxRow(owner, id)
      if (!input || Object.keys(input).some(key => !['name', 'status', 'defaultSender'].includes(key))) throw new InboxError('VALIDATION', 'Invalid mailbox settings.')
      if (input.name !== undefined) text(input.name, 'Mailbox name')
      if (input.status !== undefined && !['active', 'paused', 'detached'].includes(input.status)) throw new InboxError('VALIDATION', 'Invalid mailbox status.')
      if (input.defaultSender !== undefined && input.defaultSender !== null) {
        const box = JSON.parse(row.data) as Mailbox
        const offered = (await candidates(owner, row.connection)).find(value => value.sourceId === row.source && fingerprint(value.selector) === fingerprint(box.selector))
        if (!offered?.identities.includes(input.defaultSender)) throw new InboxError('FORBIDDEN_SENDER', 'The default sender is not verified for this mailbox.', 403)
      }
      return transaction(() => {
        const mailbox = JSON.parse(mailboxRow(owner, id).data) as Mailbox
        if (mailbox.revision !== revision) throw new InboxError('PRECONDITION_FAILED', 'The mailbox configuration changed.', 412)
        if (input.name && db.query("SELECT 1 FROM sdk_mailboxes WHERE owner=? AND source=? AND id<>? AND json_extract(data,'$.status')<>'detached' AND lower(json_extract(data,'$.name'))=lower(?)").get(owner, row.source, id, input.name)) throw new InboxError('CONFLICT', 'A mailbox with this name already exists.', 409)
        Object.assign(mailbox, input); mailbox.revision += 1
        db.query('UPDATE sdk_mailboxes SET data=? WHERE id=? AND owner=?').run(JSON.stringify(mailbox), id, owner)
        if (mailbox.status === 'active') {
          const current = mailboxRow(owner, id)
          for (const msg of db.query<{ id: string }, [string, string]>('SELECT id FROM sdk_messages WHERE owner=? AND account=? AND deleted=0').all(owner, row.source)) materializeMailbox(current, msg.id, 'initial')
        }
        if (mailbox.status === 'detached') {
          const work = db.query<OperationRow, [string, string, string, string]>(`SELECT * FROM sdk_operations WHERE owner=? AND account=? AND status IN ('pending','processing')
            AND (json_extract(payload,'$.draft.mailboxId')=? OR json_extract(payload,'$.input.viaMailboxId')=?)`).all(owner, row.source, id, id)
          for (const job of work) {
            const operation = JSON.parse(job.data) as Operation
            operation.status = job.status === 'processing' && job.type === 'send' ? 'uncertain' : 'cancelled'
            if (operation.status === 'uncertain') operation.problem = { code: 'SEND_UNCERTAIN', message: 'The mailbox was detached during dispatch. Reconcile before retrying.', retryable: false }
            saveOperation(job, operation)
            if (job.type === 'send' && operation.status === 'cancelled') restoreDraft(job)
            if (job.type === 'mutation') for (const messageId of (JSON.parse(job.payload) as MutationPayload).input.messageIds) projectMutation(operation, messageId)
          }
        }
        event(owner, 'mailbox.updated', row.source, id, mailbox.status === 'detached' ? 'deleted' : 'updated', 'mutation', id)
        return mailbox
      })
    }),
    mailboxMessages: (owner, query) => run(() => {
      const selection = mailboxQuery(owner, query)
      const page = pagination(owner, selection.query, selection.key)
      const total = db.query<{ count: number }, (string | number)[]>(`SELECT COUNT(*) count FROM sdk_messages m WHERE ${selection.sql}`).get(...selection.params)!.count
      const rows = db.query<MessageRow, (string | number)[]>(`SELECT m.id,m.owner,m.account,m.visible FROM sdk_messages m WHERE ${selection.sql}
        ORDER BY m.received_at ${selection.query.sort === 'oldest' ? 'ASC' : 'DESC'},m.id ASC LIMIT ? OFFSET ?`).all(...selection.params, page.limit, page.offset)
      return { items: rows.map(row => mailboxSummary(row, selection.ids)), total, state: page.state,
        nextCursor: page.offset + rows.length < total ? token(owner, sequence(owner), `${page.hash}:${page.offset + rows.length}`) : null }
    }),
    mailboxSnapshot: (owner, input) => run(() => db.transaction(() => {
      if (!input || Object.keys(input).some(key => !['mailboxIds', 'cursor', 'limit'].includes(key))) throw new InboxError('VALIDATION', 'Invalid mailbox snapshot input.')
      const scope = mailboxReadScope(owner, input.mailboxIds)
      let key: string, saved: MailboxInventory, offset = 0, created = false
      if (input.cursor !== undefined) {
        const cursor = decode(owner, text(input.cursor, 'Snapshot cursor', 4096))
        const parts = cursor.query?.split(':')
        if (!parts || parts.length !== 3 || parts[0] !== 'mailbox-snapshot') throw new InboxError('INVALID_CURSOR', 'Not a mailbox snapshot cursor.')
        key = parts[1]!
        const cached = inventories.get(key)
        if (!cached || cached.owner !== owner || cached.expires <= now() || cursor.epoch !== epoch) {
          if (cached?.owner === owner) discardInventory(key)
          throw new InboxError('SNAPSHOT_EXPIRED', 'Restart the expired mailbox inventory.', 410, true)
        }
        saved = cached
        if (saved.scopeHash !== scope.hash || input.limit !== undefined && mailboxReadLimit(input.limit) !== saved.limit || cursor.seq !== saved.seq) throw new InboxError('INVALID_CURSOR', 'Snapshot cursor does not match this selection.')
        offset = Number(parts[2])
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > saved.ids.length) throw new InboxError('INVALID_CURSOR', 'Invalid snapshot position.')
        if (!scope.attached || saved.binding !== scope.binding) { discardInventory(key); throw new InboxError('SNAPSHOT_SCOPE_CHANGED', 'Reload the changed mailbox selection.', 409, true) }
        inventories.delete(key); inventories.set(key, saved)
      } else {
        if (!scope.attached) throw new InboxError('NOT_FOUND', 'Mailbox not found.', 404)
        const limit = mailboxReadLimit(input.limit)
        const seq = sequence(owner)
        key = randomUUID()
        saved = { owner, ids: [], scopeHash: scope.hash, binding: scope.binding, seq, expires: now() + 300000, limit, bytes: scope.overhead + owner.length * 2 + 4096, completed: false }
        rememberInventory(key, saved)
        created = true
        const inventory = db.query<{ id: string }, [string, string, string]>(`SELECT m.id FROM sdk_messages m INDEXED BY sdk_message_inventory
          JOIN sdk_accounts a ON a.id=m.account AND a.owner=m.owner
          WHERE m.owner=? AND m.account IN (SELECT value FROM json_each(?)) AND m.deleted=0 AND m.generation=a.generation
            AND EXISTS(SELECT 1 FROM sdk_memberships v INDEXED BY sdk_membership_read WHERE v.owner=m.owner AND v.source=m.account AND v.message=m.id
              AND v.mailbox IN (SELECT value FROM json_each(?)))
          ORDER BY m.received_at DESC,m.id ASC LIMIT 100001`)
        try { for (const row of inventory.iterate(owner, scope.sourceJson, scope.json)) appendInventory(key, saved, row.id) }
        catch (error) { discardInventory(key); throw error }
      }
      try {
        const selected = saved.ids.slice(offset, offset + saved.limit)
        const page = mailboxReadRows(owner, scope, selected)
        const next = offset + page.consumed
        if (next >= saved.ids.length) saved.completed = true
        const result = { items: selected.slice(0, page.consumed).flatMap(id => page.items.has(id) ? [page.items.get(id)!] : []), total: saved.ids.length,
          nextCursor: next < saved.ids.length ? token(owner, saved.seq, `mailbox-snapshot:${key}:${next}`) : null,
          state: token(owner, saved.seq), scopeState: token(owner, 0, `mailbox-scope:${scope.hash}:${scope.binding}`), expiresAt: new Date(saved.expires).toISOString() }
        if (Buffer.byteLength(JSON.stringify(result)) > READ_BYTES) throw new InboxError('MAILBOX_READ_TOO_LARGE', 'The mailbox page exceeds its encoded budget.', 413)
        return result
      } catch (error) { if (created) discardInventory(key); throw error }
    }).deferred()),
    mailboxChanges: (owner, input) => run(() => db.transaction(() => {
      if (!input || Object.keys(input).some(key => !['mailboxIds', 'since', 'scopeState', 'limit'].includes(key))) throw new InboxError('VALIDATION', 'Invalid mailbox changes input.')
      const scope = mailboxReadScope(owner, input.mailboxIds)
      const bound = decode(owner, text(input.scopeState, 'Mailbox scope state', 4096))
      const parts = bound.query?.split(':')
      if (!parts || parts.length !== 3 || parts[0] !== 'mailbox-scope' || parts[1] !== scope.hash) throw new InboxError('INVALID_CURSOR', 'State does not match this mailbox selection.')
      const from = decode(owner, text(input.since, 'Change state', 4096))
      if (from.query !== null) throw new InboxError('INVALID_CURSOR', 'A query cursor cannot resume mailbox changes.')
      const head = sequence(owner)
      const reset = (reason: 'scope' | 'history'): MailboxChangesPage => ({ events: [], upserts: [], removed: [], state: token(owner, head), hasMore: false, resetRequired: true, resetReason: reason })
      if (!scope.attached || bound.epoch !== epoch || parts[2] !== scope.binding) return reset('scope')
      const floor = db.query<{ floor: number }, [string]>('SELECT floor FROM sdk_states WHERE owner=?').get(owner)?.floor ?? 0
      if (from.epoch !== epoch || from.seq < floor || from.seq > head) return reset('history')
      const limit = mailboxReadLimit(input.limit)
      const rows = db.query<{ seq: number; data: string }, [string, number, number, number]>('SELECT seq,data FROM sdk_events WHERE owner=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?').all(owner, from.seq, head, limit + 1)
      const mailboxIds = new Set(scope.ids)
      const candidates: Array<{ seq: number; event: ChangeEvent; messageId?: string }> = []
      const ids = new Set<string>()
      let eventBytes = 0
      for (const row of rows.slice(0, limit)) {
        const event = { ...JSON.parse(row.data), id: token(owner, row.seq) } as ChangeEvent
        const size = Buffer.byteLength(JSON.stringify(event))
        if (size > 512 * 1024) throw new InboxError('MAILBOX_READ_TOO_LARGE', 'One change exceeds the read budget.', 413)
        if (eventBytes + size > 512 * 1024) break
        eventBytes += size
        const messageId = event.accountId && scope.sources.has(event.accountId) && (event.type === 'mail.changed' || event.type === 'membership.updated' && !!event.mailboxId && mailboxIds.has(event.mailboxId)) ? event.entityId : undefined
        if (messageId) ids.add(messageId)
        candidates.push({ seq: row.seq, event, ...(messageId ? { messageId } : {}) })
      }
      const requested = [...ids]
      const hydrated = mailboxReadRows(owner, scope, requested)
      const available = new Set(requested.slice(0, hydrated.consumed))
      const events: ChangeEvent[] = [], selected = new Map<string, string>()
      let through = from.seq
      for (const candidate of candidates) {
        if (candidate.messageId && !available.has(candidate.messageId)) break
        through = candidate.seq
        if (candidate.messageId) { selected.set(candidate.messageId, candidate.event.accountId!); events.push(candidate.event) }
        else if (!['mail.changed', 'membership.updated'].includes(candidate.event.type)) events.push(candidate.event)
      }
      const upserts: MailboxMessageSummary[] = [], removed: MailboxChangesPage['removed'] = []
      for (const [messageId, sourceId] of selected) {
        const value = hydrated.items.get(messageId)
        if (value) upserts.push(value)
        else {
          const row = hydrated.rows.get(messageId)
          const deleted = !row || row.deleted !== 0 || row.generation !== row.source_generation
          removed.push({ sourceId, messageId, reason: deleted ? 'deleted' : 'unselected', revision: deleted ? row?.revision ?? null : null })
        }
      }
      const result: MailboxChangesPage = { events, upserts, removed, state: token(owner, through), hasMore: through < head, resetRequired: false }
      if (Buffer.byteLength(JSON.stringify(result)) > READ_BYTES) throw new InboxError('MAILBOX_READ_TOO_LARGE', 'The mailbox changes exceed their encoded budget.', 413)
      return result
    }).deferred()),
    mailboxMessage: (owner, mailboxId, messageId) => run(async () => {
      membership(owner, mailboxId, messageId)
      const message = await inbox.message(owner, messageId)
      const state = membership(owner, mailboxId, messageId)
      return { ...message, sourceId: message.accountId, memberships: [state] }
    }),
    setMailboxState: (owner, mailboxId, messageId, input, revision) => run(() => transaction(() => {
      const box = mailboxRow(owner, mailboxId, true)
      const state = membership(owner, mailboxId, messageId)
      if (state.revision !== revision) throw new InboxError('PRECONDITION_FAILED', 'Mailbox state changed.', 412)
      if (!input || !Object.keys(input).length || Object.keys(input).some(key => !['done', 'snoozedUntil'].includes(key))) throw new InboxError('VALIDATION', 'Invalid mailbox state.')
      if (input.done !== undefined && typeof input.done !== 'boolean') throw new InboxError('VALIDATION', 'Done must be boolean.')
      if (input.snoozedUntil !== undefined && input.snoozedUntil !== null && (!Number.isFinite(Date.parse(input.snoozedUntil)) || Date.parse(input.snoozedUntil) <= now())) throw new InboxError('VALIDATION', 'Snooze requires a future instant.')
      Object.assign(state, input)
      if (input.snoozedUntil) state.snoozedUntil = new Date(input.snoozedUntil).toISOString()
      state.revision += 1
      db.query('UPDATE sdk_memberships SET data=? WHERE owner=? AND mailbox=? AND message=?').run(JSON.stringify(state), owner, mailboxId, messageId)
      event(owner, 'membership.updated', box.source, messageId, 'updated', 'mutation', mailboxId)
      return state
    })),
    setMailboxStates: (owner, input) => run(() => transaction(() => {
      ownerId(owner)
      if (!input || Object.keys(input).some(key => !['id', 'targets', 'done'].includes(key))) throw new InboxError('VALIDATION', 'Invalid mailbox action.')
      text(input.id, 'Action ID', 128)
      if (typeof input.done !== 'boolean' || !Array.isArray(input.targets) || !input.targets.length || input.targets.length > 500) throw new InboxError('VALIDATION', 'Use 1–500 mailbox message targets.')
      for (const target of input.targets) {
        if (!target || Object.keys(target).some(key => !['mailboxId', 'messageId', 'revision', 'messageRevision'].includes(key)) || !Number.isSafeInteger(target.revision) || target.revision < 1 || target.messageRevision !== undefined && (!Number.isSafeInteger(target.messageRevision) || target.messageRevision < 1)) throw new InboxError('VALIDATION', 'Invalid mailbox message target.')
        text(target.mailboxId, 'Mailbox ID', 512); text(target.messageId, 'Message ID', 512)
      }
      const hash = fingerprint(input)
      const prior = db.query<{ fingerprint: string; data: string }, [string, string]>('SELECT fingerprint,data FROM sdk_mailbox_actions WHERE owner=? AND id=?').get(owner, input.id)
      if (prior) {
        if (prior.fingerprint !== hash) throw new InboxError('IDEMPOTENCY_CONFLICT', 'This action ID already describes different targets.', 409)
        return JSON.parse(prior.data) as MailboxStateReceipt
      }
      const keys = new Set<string>()
      const before = input.targets.map(target => {
        const key = `${target.mailboxId}\0${target.messageId}`
        if (keys.has(key)) throw new InboxError('VALIDATION', 'Duplicate mailbox message target.')
        keys.add(key); mailboxRow(owner, target.mailboxId, true)
        const state = membership(owner, target.mailboxId, target.messageId)
        if (state.revision !== target.revision) throw new InboxError('PRECONDITION_FAILED', 'Mailbox state changed.', 412)
        if (target.messageRevision !== undefined && summary(messageRow(owner, target.messageId)).revision !== target.messageRevision) throw new InboxError('PRECONDITION_FAILED', 'Message changed.', 412)
        return state
      })
      const states = before.map(state => ({ ...state, done: input.done, snoozedUntil: null, revision: state.revision + 1 }))
      for (const state of states) {
        db.query('UPDATE sdk_memberships SET data=? WHERE owner=? AND mailbox=? AND message=?').run(JSON.stringify(state), owner, state.mailboxId, state.messageId)
        event(owner, 'membership.updated', mailboxRow(owner, state.mailboxId).source, state.messageId, 'updated', 'mutation', state.mailboxId)
      }
      const receipt: MailboxStateReceipt = { id: input.id, retracted: false, states }
      db.query('INSERT INTO sdk_mailbox_actions VALUES (?,?,?,?,?)').run(owner, input.id, hash, JSON.stringify(receipt), JSON.stringify(before))
      return receipt
    })),
    undoMailboxStates: (owner, id) => run(() => transaction(() => {
      ownerId(owner); text(id, 'Action ID', 128)
      const row = db.query<{ data: string; before_states: string }, [string, string]>('SELECT data,before_states FROM sdk_mailbox_actions WHERE owner=? AND id=?').get(owner, id)
      if (!row) throw new InboxError('NOT_FOUND', 'Mailbox action not found.', 404)
      const receipt = JSON.parse(row.data) as MailboxStateReceipt
      if (receipt.retracted) return receipt
      const before = JSON.parse(row.before_states) as MailboxMembership[]
      const states = receipt.states.map((saved, index) => {
        const current = membership(owner, saved.mailboxId, saved.messageId)
        if (current.revision !== saved.revision) throw new InboxError('PRECONDITION_FAILED', 'Mailbox state changed after this action; Undo did not overwrite it.', 412)
        return { ...before[index], revision: current.revision + 1 }
      })
      for (const state of states) {
        db.query('UPDATE sdk_memberships SET data=? WHERE owner=? AND mailbox=? AND message=?').run(JSON.stringify(state), owner, state.mailboxId, state.messageId)
        event(owner, 'membership.updated', mailboxRow(owner, state.mailboxId).source, state.messageId, 'updated', 'mutation', state.mailboxId)
      }
      const result: MailboxStateReceipt = { id, retracted: true, states }
      db.query('UPDATE sdk_mailbox_actions SET data=? WHERE owner=? AND id=?').run(JSON.stringify(result), owner, id)
      return result
    })),
    syncMailbox: (owner, mailboxId, request) => run(async () => {
      const row = mailboxRow(owner, mailboxId, true)
      if ((JSON.parse(row.data) as Mailbox).status === 'paused') throw new InboxError('SYNC_PAUSED', 'Resume this mailbox before syncing.', 409)
      return synchronizeSource(owner, row.source, request, true)
    }),

    sync: (owner, id, request) => synchronizeSource(owner, id, request),

    folders: (owner, id) => run(async () => {
      const row = accountRow(owner, id, true)
      const folders = await io(row, p => p.listFolders())
      if (!current(row)) throw new InboxError('RECONNECT_REQUIRED', 'Account connection changed.', 409)
      return transaction(() => folders.map(folder => folderFor(row, folder.id, folder.folder, folder.name, folder.kind ?? 'folder')))
    }),
    cachedFolders: (owner, id) => run(() => {
      const row = accountRow(owner, id)
      return db.query<{ data: string }, [string, string, number]>('SELECT data FROM sdk_folders WHERE owner=? AND account=? AND generation=? ORDER BY rowid').all(owner, id, row.generation).map(folder => JSON.parse(folder.data) as Folder)
    }),
    createFolder: (owner, id, name) => run(async () => {
      if (options.allowProviderWrites === false) throw new InboxError('PROVIDER_WRITES_DISABLED', 'Provider writes are disabled for this deployment.', 403)
      const row = accountRow(owner, id, true); name = text(name, 'Folder name')
      const provider = await providerFor(row)
      if (!provider.capabilities.createFolders) throw new InboxError('UNSUPPORTED_OPERATION', 'Folder creation is unavailable.', 409)
      const folder = await io(row, p => p.createFolder(name))
      if (!current(row)) throw new InboxError('RECONNECT_REQUIRED', 'Account connection changed.', 409)
      return transaction(() => { const result = folderFor(row, folder.id, folder.folder, folder.name, folder.kind ?? 'folder'); event(owner, 'account.updated', id, id); return result })
    }),

    messages: (owner, query = {}) => run(() => {
      const condition = where(owner, query); const page = pagination(owner, query, 'messages')
      const total = db.query<{ count: number }, (string | number)[]>(`SELECT COUNT(*) count FROM sdk_messages m WHERE ${condition.sql}`).get(...condition.params)!.count
      const rows = db.query<MessageRow, (string | number)[]>(`SELECT m.id,m.visible FROM sdk_messages m WHERE ${condition.sql} ORDER BY m.received_at ${query.sort === 'oldest' ? 'ASC' : 'DESC'},m.id ASC LIMIT ? OFFSET ?`).all(...condition.params, page.limit, page.offset)
      return { items: rows.map(summary), total, state: page.state, nextCursor: page.offset + rows.length < total ? token(owner, sequence(owner), `${page.hash}:${page.offset + rows.length}`) : null }
    }),
    message: (owner, id) => run(() => {
      const row = messageRow(owner, id)
      const { body, bodyText, presentation } = messagePresentation(row, getPolicy(owner).remoteImages)
      return { ...summary(row), bcc: body.bcc, bodyText, ...presentation, attachments: body.attachments, ...(body.replyTo ? { replyTo: body.replyTo } : {}) }
    }),
    media: (owner, id, resource) => run(async () => {
      const row = messageRow(owner, id)
      const authorize = () => {
        if (!getPolicy(owner).remoteImages) throw new InboxError('MEDIA_IMAGES_DISABLED', 'Remote images are disabled.', 403)
        const current = messageRow(owner, id)
        if (current.account !== row.account || current.body !== row.body) throw new InboxError('NOT_FOUND', 'Image not found.', 404)
      }
      authorize()
      if (!/^[A-Za-z\d_-]{43}$/.test(resource)) throw new InboxError('NOT_FOUND', 'Image not found.', 404)
      const { source } = messagePresentation(row, true, resource)
      if (!source) throw new InboxError('NOT_FOUND', 'Image not found.', 404)
      return media.get(owner, id, resource, source, authorize)
    }),
    threads: (owner, query = {}) => run(() => {
      const condition = where(owner, query); const page = pagination(owner, query, 'threads')
      const total = db.query<{ count: number }, (string | number)[]>(`SELECT COUNT(DISTINCT m.thread_id) count FROM sdk_messages m WHERE ${condition.sql}`).get(...condition.params)!.count
      const rows = db.query<{ thread_id: string; matching: number }, (string | number)[]>(`SELECT m.thread_id,COUNT(*) matching FROM sdk_messages m WHERE ${condition.sql} GROUP BY m.thread_id ORDER BY MAX(m.received_at) ${query.sort === 'oldest' ? 'ASC' : 'DESC'},m.thread_id ASC LIMIT ? OFFSET ?`).all(...condition.params, page.limit, page.offset)
      const items: ThreadSummary[] = rows.map(row => {
        const latest = db.query<{ visible: string; account: string }, [string, string]>('SELECT visible,account FROM sdk_messages WHERE owner=? AND thread_id=? AND deleted=0 ORDER BY received_at DESC,id ASC LIMIT 1').get(owner, row.thread_id)!
        const counts = db.query<{ count: number; unread: number; starred: number; attachments: number }, [string, string]>("SELECT COUNT(*) count,SUM(1-is_read) unread,MAX(is_starred) starred,MAX(json_extract(visible,'$.hasAttachments')) attachments FROM sdk_messages WHERE owner=? AND thread_id=? AND deleted=0").get(owner, row.thread_id)!
        const message = JSON.parse(latest.visible) as MessageSummary
        return { id: row.thread_id, accountId: latest.account, subject: message.subject, preview: message.preview, messageCount: counts.count, matchingMessageCount: row.matching,
          isRead: counts.unread === 0, isStarred: Boolean(counts.starred), lastMessageAt: message.receivedAt, hasAttachments: Boolean(counts.attachments) }
      })
      return { items, total, state: page.state, nextCursor: page.offset + items.length < total ? token(owner, sequence(owner), `${page.hash}:${page.offset + items.length}`) : null }
    }),
    thread: (owner, id, query = {}) => run(() => {
      ownerId(owner); const page = pagination(owner, query, `thread:${id}`)
      const total = db.query<{ count: number }, [string, string]>('SELECT COUNT(*) count FROM sdk_messages WHERE owner=? AND thread_id=? AND deleted=0').get(owner, id)!.count
      if (!total) throw new InboxError('NOT_FOUND', 'Conversation not found.', 404)
      const rows = db.query<MessageRow, [string, string, number, number]>('SELECT visible FROM sdk_messages WHERE owner=? AND thread_id=? AND deleted=0 ORDER BY received_at ASC,id ASC LIMIT ? OFFSET ?').all(owner, id, page.limit, page.offset)
      return { items: rows.map(summary), total, state: page.state, nextCursor: page.offset + rows.length < total ? token(owner, sequence(owner), `${page.hash}:${page.offset + rows.length}`) : null }
    }),

    labels: (owner, id) => run(() => {
      ownerId(owner); if (id) accountRow(owner, id)
      return db.query<DataRow, [string, string | null, string | null]>('SELECT * FROM sdk_labels WHERE owner=? AND (? IS NULL OR account=?) ORDER BY id').all(owner, id ?? null, id ?? null).map(row => JSON.parse(row.data))
    }),
    createLabel: (owner, id, name) => run(() => {
      accountRow(owner, id); name = text(name, 'Label name')
      return transaction(() => {
        if (db.query("SELECT 1 FROM sdk_labels WHERE owner=? AND account=? AND lower(json_extract(data,'$.name'))=lower(?)").get(owner, id, name)) throw new InboxError('CONFLICT', 'A label with this name already exists.', 409)
        const label: Label = { id: randomUUID(), accountId: id, name, scope: 'local', revision: 1 }
        db.query('INSERT INTO sdk_labels VALUES (?,?,?,?)').run(label.id, owner, id, JSON.stringify(label)); event(owner, 'label.updated', id, label.id, 'created'); return label
      })
    }),
    updateLabel: (owner, id, name, revision) => run(() => transaction(() => {
      ownerId(owner); name = text(name, 'Label name')
      const row = db.query<DataRow, [string, string]>('SELECT * FROM sdk_labels WHERE owner=? AND id=?').get(owner, id)
      if (!row) throw new InboxError('NOT_FOUND', 'Label not found.', 404)
      const label = JSON.parse(row.data) as Label
      if (label.revision !== revision) throw new InboxError('PRECONDITION_FAILED', 'The label was modified.', 412)
      if (db.query("SELECT 1 FROM sdk_labels WHERE owner=? AND account=? AND id<>? AND lower(json_extract(data,'$.name'))=lower(?)").get(owner, row.account, id, name)) throw new InboxError('CONFLICT', 'A label with this name already exists.', 409)
      label.name = name; label.revision += 1
      db.query('UPDATE sdk_labels SET data=? WHERE id=?').run(JSON.stringify(label), id); event(owner, 'label.updated', row.account, id); return label
    })),
    deleteLabel: (owner, id) => run(() => transaction(() => {
      ownerId(owner)
      const row = db.query<DataRow, [string, string]>('SELECT * FROM sdk_labels WHERE owner=? AND id=?').get(owner, id)
      if (!row) throw new InboxError('NOT_FOUND', 'Label not found.', 404)
      db.query('DELETE FROM sdk_labels WHERE id=?').run(id)
      const messages = db.query<MessageRow, [string, string]>('SELECT * FROM sdk_messages WHERE owner=? AND account=? AND deleted=0').all(owner, row.account)
      for (const message of messages) {
        const labels: string[] = JSON.parse(message.local_labels)
        if (labels.includes(id)) { db.query('UPDATE sdk_messages SET local_labels=? WHERE id=?').run(JSON.stringify(labels.filter(label => label !== id)), message.id); project(message.id); event(owner, 'mail.changed', row.account, message.id) }
      }
      event(owner, 'label.updated', row.account, id, 'deleted')
    })),

    upload: (owner, id, file) => run(() => {
      const row = accountRow(owner, id)
      const filename = text(file.filename, 'Filename', 255)
      if (filename.includes('/') || filename.includes('\\')) throw new InboxError('VALIDATION', 'Filename must not contain a path.')
      if (!(file.content instanceof Uint8Array)) throw new InboxError('VALIDATION', 'Attachment content must be bytes.')
      if (file.content.byteLength > 25 * 1024 * 1024) throw new InboxError('TOO_LARGE', 'Attachment exceeds 25 MiB.', 413)
      const contentType = text(file.contentType, 'Content type', 200)
      const info: BlobInfo = { id: randomUUID(), accountId: id, filename, contentType, size: file.content.byteLength,
        ...(file.inline ? { inline: true } : {}), ...(file.contentId ? { contentId: text(file.contentId, 'Content ID') } : {}) }
      db.query('INSERT INTO sdk_blobs(id,owner,account,generation,data,content) VALUES (?,?,?,?,?,?)').run(info.id, owner, id, row.generation, JSON.stringify(info), file.content)
      return info
    }),
    download: (owner, id) => run(async () => {
      ownerId(owner)
      const blob = db.query<BlobRow, [string, string]>('SELECT * FROM sdk_blobs WHERE owner=? AND id=?').get(owner, id)
      if (!blob) throw new InboxError('NOT_FOUND', 'Attachment not found.', 404)
      const info = JSON.parse(blob.data) as BlobInfo
      if (blob.content !== null) return { info, content: new Uint8Array(blob.content) }
      const row = accountRow(owner, blob.account, true); const message = messageRow(owner, blob.message_id!)
      const result = await io(row, p => p.getAttachment(message.native_id, blob.attachment_id!, info.contentId, info))
      if (!current(row)) throw new InboxError('RECONNECT_REQUIRED', 'Account connection changed.', 409)
      if (result.content.byteLength > 25 * 1024 * 1024) throw new InboxError('TOO_LARGE', 'Attachment exceeds 25 MiB.', 413)
      info.size = result.content.byteLength
      db.query('UPDATE sdk_blobs SET content=?,data=? WHERE id=? AND owner=?').run(result.content, JSON.stringify(info), id, owner)
      return { info, content: new Uint8Array(result.content) }
    }),

    drafts: (owner, id) => run(() => {
      ownerId(owner); if (id) accountRow(owner, id)
      return db.query<DataRow, [string, string | null, string | null]>("SELECT * FROM sdk_drafts WHERE owner=? AND (? IS NULL OR account=?) AND json_extract(data,'$.status')='active' ORDER BY rowid").all(owner, id ?? null, id ?? null).map(row => JSON.parse(row.data))
    }),
    draft: (owner, id) => run(() => draftRow(owner, id)),
    createDraft: (owner, input) => run(() => {
      const account = accountRow(owner, input.accountId)
      let prepared = { ...input }
      if (input.sourceMessageId) {
        const source = messageRow(owner, input.sourceMessageId)
        if (source.account !== account.id) throw new InboxError('NOT_FOUND', 'Source message not found.', 404)
        const base = summary(source); const body = JSON.parse(source.body)
        const native = JSON.parse(account.native); const own = new Set([native.email, ...native.aliases ?? []].map((v: string) => v.toLowerCase()))
        const seen = new Set<string>()
        const unique = (values: Participant[]) => values.filter(p => { const email = p.email.toLowerCase(); if (own.has(email) || seen.has(email)) return false; seen.add(email); return true })
        if (input.mode === 'reply' || input.mode === 'replyAll') {
          const to = unique([...(body.replyTo?.length ? body.replyTo : [base.from]), ...(input.mode === 'replyAll' ? base.to : [])])
          const cc = input.mode === 'replyAll' ? unique(base.cc) : []
          prepared = { ...prepared, to: input.to ?? to, cc: input.cc ?? cc, bcc: input.bcc ?? [], subject: input.subject ?? (/^re:/i.test(base.subject) ? base.subject : `Re: ${base.subject}`) }
        } else if (input.mode === 'forward') prepared = { ...prepared, subject: input.subject ?? `Fwd: ${base.subject}`, bodyText: input.bodyText ?? body.bodyText, bodyHtml: input.bodyHtml ?? body.bodyHtml, attachmentIds: input.attachmentIds ?? body.attachments.map((blob: BlobInfo) => blob.id) }
      }
      const value = validateDraft(owner, prepared)
      const draft: Draft = { ...value, id: randomUUID(), revision: 1, status: 'active', updatedAt: new Date(now()).toISOString() }
      transaction(() => { db.query('INSERT INTO sdk_drafts VALUES (?,?,?,?)').run(draft.id, owner, draft.accountId, JSON.stringify(draft)); event(owner, 'draft.updated', draft.accountId, draft.id, 'created') })
      return draft
    }),
    updateDraft: (owner, id, input, revision) => run(() => transaction(() => {
      const old = draftRow(owner, id)
      if (old.revision !== revision) throw new InboxError('PRECONDITION_FAILED', 'The draft was modified.', 412)
      if (old.status !== 'active') throw new InboxError('CONFLICT', 'This draft has already been submitted.', 409)
      if (input.accountId && input.accountId !== old.accountId) throw new InboxError('VALIDATION', 'A draft cannot change accounts.')
      const value = validateDraft(owner, { ...old, ...input })
      const draft: Draft = { ...value, id, revision: revision + 1, status: 'active', updatedAt: new Date(now()).toISOString() }
      db.query('UPDATE sdk_drafts SET data=? WHERE id=? AND owner=?').run(JSON.stringify(draft), id, owner); event(owner, 'draft.updated', draft.accountId, id); return draft
    })),
    deleteDraft: (owner, id, revision) => run(() => transaction(() => {
      const draft = draftRow(owner, id)
      if (draft.revision !== revision) throw new InboxError('PRECONDITION_FAILED', 'The draft was modified.', 412)
      if (draft.status !== 'active') throw new InboxError('CONFLICT', 'Cancel the submission before discarding its draft.', 409)
      db.query('DELETE FROM sdk_drafts WHERE owner=? AND id=?').run(owner, id); event(owner, 'draft.updated', draft.accountId, id, 'deleted')
    })),

    submit: (owner, id, input) => run(() => {
      if (options.allowProviderWrites === false) throw new InboxError('PROVIDER_WRITES_DISABLED', 'Provider writes are disabled for this deployment.', 403)
      const intent = { type: 'send', id, revision: input.revision, sendAt: input.sendAt ?? null }
      const previous = replay(owner, input.idempotencyKey, intent); if (previous) return previous
      const draft = draftRow(owner, id); const account = accountRow(owner, draft.accountId, true)
      if (draft.revision !== input.revision) throw new InboxError('PRECONDITION_FAILED', 'The draft was modified.', 412)
      if (draft.status !== 'active') throw new InboxError('CONFLICT', 'This draft was already submitted.', 409)
      validateDraft(owner, draft, true)
      if (!draft.to.length && !draft.cc.length && !draft.bcc.length) throw new InboxError('VALIDATION', 'At least one recipient is required.')
      const capabilities = (JSON.parse(account.data) as Account).capabilities
      if (!capabilities.send || (['reply', 'replyAll'].includes(draft.mode) && !capabilities.reply)) throw new InboxError('UNSUPPORTED_OPERATION', 'This account cannot send this message.', 409)
      let at = now() + getPolicy(owner).undoSendSeconds * 1000
      if (input.sendAt !== undefined) {
        const parsed = Date.parse(input.sendAt)
        if (!Number.isFinite(parsed) || parsed < now()) throw new InboxError('VALIDATION', 'Scheduled time must be a future instant.')
        at = Math.max(at, parsed)
      }
      const payload: SendPayload = { draft: structuredClone(draft), holdUntil: now() + getPolicy(owner).undoSendSeconds * 1000,
        blobs: draft.attachmentIds.map(blobId => JSON.parse(db.query<BlobRow, [string, string]>('SELECT * FROM sdk_blobs WHERE id=? AND owner=?').get(blobId, owner)!.data)) }
      if (draft.sourceMessageId) {
        const source = messageRow(owner, draft.sourceMessageId); const body = JSON.parse(source.body)
        payload.nativeSource = source.native_id
        payload.nativeThread = db.query<{ native_id: string }, [string, number, string]>('SELECT native_id FROM sdk_thread_keys WHERE account=? AND generation=? AND id=?').get(account.id, account.generation, source.thread_id)?.native_id
        payload.inReplyTo = body.rfcMessageId
        payload.references = [...body.references ?? [], ...body.rfcMessageId ? [body.rfcMessageId] : []]
      }
      return transaction(() => {
        const repeated = replay(owner, input.idempotencyKey, intent); if (repeated) return repeated
        const latest = draftRow(owner, id)
        if (latest.revision !== input.revision || latest.status !== 'active') throw new InboxError('PRECONDITION_FAILED', 'The draft was modified.', 412)
        const op = accept(owner, account, 'send', input.idempotencyKey, intent, payload, at)
        latest.status = 'submitted'
        db.query('UPDATE sdk_drafts SET data=? WHERE owner=? AND id=?').run(JSON.stringify(latest), owner, id); event(owner, 'draft.updated', account.id, id)
        return op
      })
    }),

    mutate: (owner, input) => run(() => {
      ownerId(owner)
      if (!Array.isArray(input.messageIds) || !input.messageIds.length || input.messageIds.length > 500 || new Set(input.messageIds).size !== input.messageIds.length) throw new InboxError('VALIDATION', 'Select between 1 and 500 unique messages.')
      const intent = { type: 'mutation', ...input, idempotencyKey: undefined }
      const previous = replay(owner, input.idempotencyKey, intent); if (previous) return previous
      if (!input.changes || typeof input.changes !== 'object' || !Object.keys(input.changes).length) throw new InboxError('VALIDATION', 'A mutation is required.')
      const allowed = ['isRead','isStarred','isArchived','folder','folderId','addLabels','removeLabels','addLabelIds','removeLabelIds','snoozedUntil','deletePermanently']
      if (Object.keys(input.changes).some(key => !allowed.includes(key))) throw new InboxError('VALIDATION', 'Unknown mutation field.')
      for (const key of ['isRead','isStarred','isArchived','deletePermanently'] as const) if (input.changes[key] !== undefined && typeof input.changes[key] !== 'boolean') throw new InboxError('VALIDATION', 'Flags must be boolean.')
      const rows = input.messageIds.map(id => messageRow(owner, id))
      const account = accountRow(owner, rows[0]!.account, true)
      if (rows.some(row => row.account !== account.id)) throw new InboxError('VALIDATION', 'A mutation must target one account at a time.')
      const capabilities = (JSON.parse(account.data) as Account).capabilities; const changes = { ...input.changes }
      if (options.allowProviderWrites === false && Object.keys(changes).some(key => !['addLabelIds', 'removeLabelIds', 'snoozedUntil'].includes(key))) throw new InboxError('PROVIDER_WRITES_DISABLED', 'Provider writes are disabled for this deployment.', 403)
      if (input.viaMailboxId) for (const row of rows) membership(owner, input.viaMailboxId, row.id)
      if (changes.folder !== undefined && !['inbox', 'archive', 'trash', 'spam', 'sent'].includes(changes.folder)) throw new InboxError('VALIDATION', 'Use a discovered folder ID for custom destinations.')
      if (changes.folderId && !db.query('SELECT 1 FROM sdk_folders WHERE owner=? AND account=? AND id=?').get(owner, account.id, changes.folderId)) throw new InboxError('NOT_FOUND', 'Folder not found.', 404)
      for (const key of ['addLabelIds', 'removeLabelIds', 'addLabels', 'removeLabels'] as const) if (changes[key] !== undefined && (!Array.isArray(changes[key]) || changes[key]!.some(value => typeof value !== 'string'))) throw new InboxError('VALIDATION', 'Label changes must be arrays of IDs.')
      const checks = [[changes.isRead === true, capabilities.markRead], [changes.isRead === false, capabilities.markUnread],
        [changes.isStarred !== undefined, capabilities.star], [changes.isArchived !== undefined || changes.folder === 'archive', capabilities.archive],
        [changes.folder === 'trash', capabilities.trash], [changes.deletePermanently === true, capabilities.permanentDelete],
        [Boolean(changes.addLabels?.length || changes.removeLabels?.length), capabilities.labels]]
      if (checks.some(([needed, supported]) => needed && !supported)) throw new InboxError('UNSUPPORTED_OPERATION', 'This account does not support the requested mutation.', 409)
      if (changes.snoozedUntil !== undefined && changes.snoozedUntil !== null && (!Number.isFinite(Date.parse(changes.snoozedUntil)) || Date.parse(changes.snoozedUntil) <= now())) throw new InboxError('VALIDATION', 'Snooze time must be a future instant.')
      if (changes.snoozedUntil) changes.snoozedUntil = new Date(changes.snoozedUntil).toISOString()
      for (const label of [...changes.addLabelIds ?? [], ...changes.removeLabelIds ?? []]) if (!db.query('SELECT 1 FROM sdk_labels WHERE owner=? AND account=? AND id=?').get(owner, account.id, label)) throw new InboxError('NOT_FOUND', 'Label not found.', 404)
      const before = Object.fromEntries(rows.map(row => [row.id, summary(row)]))
      for (const row of rows) {
        if (input.ifRevisions && input.ifRevisions[row.id] !== row.revision) throw new InboxError('PRECONDITION_FAILED', 'The selection changed.', 412)
      }
      return transaction(() => {
        const repeated = replay(owner, input.idempotencyKey, intent); if (repeated) return repeated
        if (input.ifRevisions) for (const id of input.messageIds) if (messageRow(owner, id).revision !== input.ifRevisions[id]) throw new InboxError('PRECONDITION_FAILED', 'The selection changed.', 412)
        const op = accept(owner, account, 'mutation', input.idempotencyKey, intent, { input: { ...input, changes }, before } satisfies MutationPayload, now())
        for (const row of rows) { projectMutation(op, row.id); event(owner, 'mail.changed', account.id, row.id) }
        return op
      })
    }),
    operation: (owner, id) => run(() => JSON.parse(operationRow(owner, id).data)),
    cancel: (owner, id) => run(() => transaction(() => {
      const row = operationRow(owner, id); const op = JSON.parse(row.data) as Operation
      if (op.status === 'cancelled') return op
      if (op.status !== 'pending') throw new InboxError('CANNOT_CANCEL', 'The operation has already started.', 409)
      op.status = 'cancelled'; saveOperation(row, op)
      if (row.type === 'mutation') for (const mid of (JSON.parse(row.payload) as MutationPayload).input.messageIds) { projectMutation(op, mid); event(owner, 'mail.changed', row.account, mid) }
      else {
        const draft = draftRow(owner, (JSON.parse(row.payload) as SendPayload).draft.id)
        draft.status = 'active'; db.query('UPDATE sdk_drafts SET data=? WHERE id=? AND owner=?').run(JSON.stringify(draft), draft.id, owner); event(owner, 'draft.updated', row.account, draft.id)
      }
      return op
    })),
    reschedule: (owner, id, sendAt) => run(() => transaction(() => {
      const row = operationRow(owner, id); const op = JSON.parse(row.data) as Operation
      if (row.type !== 'send' || op.status !== 'pending') throw new InboxError('CANNOT_RESCHEDULE', 'Only a pending send can be rescheduled.', 409)
      const timestamp = Date.parse(sendAt)
      if (!Number.isFinite(timestamp) || timestamp < now()) throw new InboxError('VALIDATION', 'Scheduled time must be a future instant.')
      const at = Math.max(timestamp, (JSON.parse(row.payload) as SendPayload).holdUntil)
      op.sendAt = new Date(at).toISOString(); saveOperation(row, op, at); return op
    })),
    undo: (owner, id) => run(async () => {
      const row = operationRow(owner, id); const op = JSON.parse(row.data) as Operation
      if (op.status === 'pending') return inbox.cancel(owner, id)
      if (op.type !== 'mutation' || op.status !== 'succeeded') throw new InboxError('CANNOT_UNDO', 'This operation cannot be undone.', 409)
      const intent = { undo: id }; const key = `undo:${id}`
      const previous = replay(owner, key, intent); if (previous) return previous
      const payload = JSON.parse(row.payload) as MutationPayload
      if (options.allowProviderWrites === false && [payload.input.changes, ...Object.values(payload.perMessageChanges ?? {})]
        .some(changes => Object.keys(changes).some(key => !['addLabelIds', 'removeLabelIds', 'snoozedUntil'].includes(key)))) throw new InboxError('PROVIDER_WRITES_DISABLED', 'Provider writes are disabled for this deployment.', 403)
      if (db.query<OperationRow, [string, number]>("SELECT * FROM sdk_operations WHERE account=? AND seq>? AND type='mutation' AND status IN ('pending','processing')").all(row.account, row.seq)
        .some(later => (JSON.parse(later.payload) as MutationPayload).input.messageIds.some(mid => payload.input.messageIds.includes(mid)))) throw new InboxError('CONFLICT', 'A newer pending edit prevents this undo.', 409)
      const reversed: Record<string, Changes> = {}
      const before: Record<string, MessageSummary> = {}
      for (const mid of payload.input.messageIds) {
        const current = messageRow(owner, mid)
        if (current.revision !== payload.afterRevisions?.[mid]) throw new InboxError('CONFLICT', 'A newer edit prevents this undo.', 409)
        before[mid] = summary(current)
        const original = payload.before[mid]!; const change = payload.perMessageChanges?.[mid] ?? payload.input.changes
        const reverse: Changes = {}
        if (change.isRead !== undefined) reverse.isRead = original.isRead
        if (change.isStarred !== undefined) reverse.isStarred = original.isStarred
        if (change.folder || change.folderId) reverse.folderId = original.folderIds[0]
        if (change.isArchived !== undefined) reverse.isArchived = original.folder !== 'inbox'
        if (change.snoozedUntil !== undefined) reverse.snoozedUntil = original.snoozedUntil
        reverse.removeLabelIds = change.addLabelIds?.filter(label => !original.labelIds.includes(label))
        reverse.addLabelIds = change.removeLabelIds?.filter(label => original.labelIds.includes(label))
        if (change.deletePermanently) throw new InboxError('CANNOT_UNDO', 'Permanent deletion cannot be undone.', 409)
        reversed[mid] = reverse
      }
      return transaction(() => {
        const repeated = replay(owner, key, intent); if (repeated) return repeated
        for (const mid of payload.input.messageIds) if (messageRow(owner, mid).revision !== payload.afterRevisions?.[mid]) throw new InboxError('CONFLICT', 'A newer edit prevents this undo.', 409)
        const result = accept(owner, accountRow(owner, row.account, true), 'mutation', key, intent,
          { input: { messageIds: payload.input.messageIds, changes: {}, idempotencyKey: key }, before, perMessageChanges: reversed } satisfies MutationPayload, now())
        for (const mid of payload.input.messageIds) { projectMutation(result, mid); event(owner, 'mail.changed', row.account, mid) }
        return result
      })
    }),

    policy: owner => run(() => getPolicy(owner)),
    setPolicy: (owner, input) => run(() => {
      if (Object.keys(input).some(key => !['remoteImages', 'undoSendSeconds'].includes(key))) throw new InboxError('VALIDATION', 'Unknown policy field.')
      if (input.remoteImages !== undefined && typeof input.remoteImages !== 'boolean') throw new InboxError('VALIDATION', 'remoteImages must be boolean.')
      if (input.undoSendSeconds !== undefined && (!Number.isInteger(input.undoSendSeconds) || input.undoSendSeconds < 0 || input.undoSendSeconds > 120)) throw new InboxError('VALIDATION', 'Undo send must be between 0 and 120 seconds.')
      const policy = { ...getPolicy(owner), ...input }
      transaction(() => { db.query('INSERT INTO sdk_policy VALUES (?,?) ON CONFLICT(owner) DO UPDATE SET data=excluded.data').run(owner, JSON.stringify(policy)); event(owner, 'policy.updated', null, owner) })
      if (!policy.remoteImages) media.block(owner)
      return policy
    }),
    changes: (owner, input = {}) => run(() => {
      ownerId(owner)
      const seq = sequence(owner); const current = token(owner, seq)
      if (!input.since) return { events: [], state: current, hasMore: false, resetRequired: false }
      const from = decode(owner, input.since)
      if (from.query !== null) throw new InboxError('INVALID_CURSOR', 'A query cursor cannot resume changes.')
      const floor = db.query<{ floor: number }, [string]>('SELECT floor FROM sdk_states WHERE owner=?').get(owner)?.floor ?? 0
      if (from.epoch !== epoch || from.seq < floor || from.seq > seq) return { events: [], state: current, hasMore: false, resetRequired: true }
      const limit = input.limit ?? 100
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new InboxError('VALIDATION', 'Change page size must be between 1 and 1000.')
      const rows = db.query<{ seq: number; data: string }, [string, number, number, number]>('SELECT seq,data FROM sdk_events WHERE owner=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?').all(owner, from.seq, seq, limit + 1)
      const hasMore = rows.length > limit
      const events: ChangeEvent[] = rows.slice(0, limit).map(row => ({ ...JSON.parse(row.data), id: token(owner, row.seq) }))
      return { events, state: hasMore ? events.at(-1)!.id : current, hasMore, resetRequired: false }
    }),
    subscribe: (owner, listener) => {
      ownerId(owner)
      if (closed || stopping) throw new InboxError('CLOSED', 'The inbox instance is closed.', 503)
      let set = listeners.get(owner); if (!set) { set = new Set(); listeners.set(owner, set) }
      set.add(listener)
      return () => { set!.delete(listener); if (!set!.size) listeners.delete(owner) }
    },
    runDue: () => {
      if (due) return due
      due = run(async () => {
        for (let batch = 0; batch < Math.ceil(100 / concurrency); batch++) if (await processDue() === 0) break
        if (!stopping) repairPreviews()
      }).finally(() => { due = undefined })
      return due
    },
    poll: () => {
      if (polling) return polling
      polling = run(async () => {
        const rows = db.query<AccountRow, []>("SELECT * FROM sdk_accounts WHERE status='connected' ORDER BY rowid").all().filter(row => {
          if (!db.query("SELECT 1 FROM sdk_mailboxes WHERE owner=? AND source=? AND json_extract(data,'$.status')='active'").get(row.owner, row.id)) return false
          const last = (JSON.parse(row.data) as Account).sync.lastSyncAt
          const cooldown = db.query<{ next_at: number }, [string]>('SELECT next_at FROM sdk_cooldowns WHERE account=?').get(row.id)
          return (!last || Date.parse(last) + (options.syncIntervalMs ?? 15_000) <= now()) && (!cooldown || cooldown.next_at <= now())
        })
        await runtime.runPromise(Effect.forEach(rows, row => Effect.tryPromise({
          try: async () => {
            await synchronizeSource(row.owner, row.id, {}, true)
            const checkpointScope = `mailboxes:${sourceSelection(row.owner, row.id).key}:inbox`
            const backfill = db.query<{ data: string }, [string, number, string]>('SELECT data FROM sdk_checkpoints WHERE account=? AND generation=? AND lane=\'backfill\' AND scope=?').get(row.id, row.generation, checkpointScope)
            if (backfill ? (JSON.parse(backfill.data) as SyncCheckpoint).cursor : (JSON.parse(accountRow(row.owner, row.id).data) as Account).sync.coverage === 'partial') await synchronizeSource(row.owner, row.id, { lane: 'backfill' }, true)
          }, catch: failure,
        }).pipe(Effect.catchAll(error => Effect.sync(() => options.log?.({ code: error.code, operation: 'sync' })))), { concurrency, discard: true }))
      }).finally(() => { polling = undefined })
      return polling
    },
    start: () => {
      if (background.length || closed || stopping) return
      const job = Effect.tryPromise({ try: () => inbox.runDue(), catch: failure }).pipe(Effect.catchAll(error => Effect.sync(() => options.log?.({ code: error.code, operation: 'jobs' }))))
      const sync = Effect.tryPromise({ try: () => inbox.poll(), catch: failure }).pipe(Effect.catchAll(error => Effect.sync(() => options.log?.({ code: error.code, operation: 'sync' }))))
      background = [runtime.runFork(job.pipe(Effect.repeat(Schedule.spaced(1000)))), runtime.runFork(sync.pipe(Effect.repeat(Schedule.spaced(Math.max(100, options.syncIntervalMs ?? 15_000)))))]
    },
    close: async () => {
      if (closed || stopping) return
      stopping = true
      await media.close()
      for (const controller of controllers.values()) controller.abort()
      await Effect.runPromise(Fiber.interruptAll(background))
      await Promise.allSettled([due, polling, ...syncing.values(), ...refreshes.values(), ...credentialUpdates].filter(Boolean))
      await Promise.allSettled(disconnecting)
      await runtime.runPromise(Environment)
      await runtime.dispose()
      closed = true
    },
  }
  return inbox
}
