import type { ProviderDefinition } from 'inbox-sdk'
import {
  buildThreads, ProviderAuthorizationError, ProviderCursorExpiredError, ProviderError,
  type Attachment, type InboxProvider, type ListOptions, type MailMessage, type MailThread,
  type MessageMutation, type ProviderCapabilities, type ProviderCredentials, type ProviderListResult,
  type SendInput, type SyncCursor, type SyncOptions, type SyncResult,
} from 'inbox-sdk/provider'
import { MockMailStore, type StoreScope, type StoredMessage } from './store'
import { compare, contextId, email, fingerprint, invalid, keys, limit, object, PROVIDER_ID, text } from './validation'

export const MOCK_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  sync: true, incrementalSync: true, deltaSync: true, send: true, reply: true,
  threads: true, nativeThreads: true, folders: true, createFolders: true, labels: true,
  archive: true, trash: true, permanentDelete: true, markRead: true, markUnread: true,
  star: true, attachments: true, attachmentDownload: true, search: true,
  drafts: false, scheduledSend: false, snooze: false, readReceipts: false, pushNotifications: false,
})

type MailScope = NonNullable<ListOptions['mailboxScopes']>[number]
type Selection = { folder: string; search: string; unreadOnly: boolean; mailboxScopes: MailScope[] }
type Resource = 'messages' | 'threads' | 'sync'
type PageCursor = {
  version: 1
  database: string
  store: string
  owner: string
  account: string
  resource: Resource
  selection: string
  mode: 'snapshot' | 'delta'
  ceiling: number
  offset: number
  after: number
}

function cursorError(): never {
  throw new ProviderCursorExpiredError(PROVIDER_ID, 'Mock cursor does not match this store, owner, account, query, or resource.', { status: 400 })
}

/** Instances are cheap scoped views; disconnect retires only this instance, never the shared database. */
export class MockInboxProvider implements InboxProvider {
  readonly type = PROVIDER_ID
  readonly capabilities = MOCK_CAPABILITIES
  readonly accountId: string
  readonly scope: Readonly<StoreScope>
  private disconnected = false

  constructor(private readonly store: MockMailStore, scope: StoreScope) {
    store.assertScope(scope)
    this.scope = Object.freeze({ ...scope })
    this.accountId = scope.accountId
  }

  private open(): void {
    if (this.disconnected) throw new ProviderError(PROVIDER_ID, 'AUTHORIZATION', 'This mock provider instance is disconnected.', { status: 409 })
    this.store.assertScope(this.scope)
  }

  belongsTo(store: MockMailStore): boolean { return store === this.store }

  private selection(options: Omit<ListOptions, 'cursor' | 'limit'>, defaultFolder: string): Selection {
    const profile = this.store.assertScope(this.scope)
    const folder = this.store.folder(this.scope, options.folder ?? defaultFolder)
    const search = options.search === undefined ? '' : text(options.search, 'search', 2000, true).toLowerCase()
    if (options.unreadOnly !== undefined && typeof options.unreadOnly !== 'boolean') invalid('unreadOnly must be boolean.')
    const scopes = options.mailboxScopes
    if (scopes !== undefined && (!Array.isArray(scopes) || !scopes.length || scopes.length > 50)) invalid('Invalid mailbox scopes.')
    const addresses = [profile.email, ...profile.aliases]
    const normalized = (scopes ?? []).map(scope => {
      object(scope, 'Mailbox scope'); keys(scope, ['kind', 'value'], 'Mailbox scope')
      if (scope.kind !== 'address' && scope.kind !== 'domain') invalid('Invalid mailbox scope kind.')
      const value = scope.kind === 'address' ? email(scope.value) : text(scope.value, 'mailbox domain', 254).toLowerCase()
      const allowed = scope.kind === 'address' ? addresses : addresses.map(address => address.split('@')[1]!)
      if (!allowed.includes(value)) throw new ProviderAuthorizationError(PROVIDER_ID, 'This mailbox scope is not offered by the mock store.')
      return { kind: scope.kind, value }
    })
    const mailboxScopes = [...new Map(normalized.map(scope => [`${scope.kind}:${scope.value}`, scope])).values()].sort((a, b) => compare(`${a.kind}:${a.value}`, `${b.kind}:${b.value}`))
    return { folder, search, unreadOnly: options.unreadOnly ?? false, mailboxScopes }
  }

  private matchesMailbox(message: StoredMessage, selection: Selection): boolean {
    return !selection.mailboxScopes.length || selection.mailboxScopes.some(scope => scope.kind === 'address'
      ? message.deliveryRecipients?.includes(scope.value) : message.sourceDomains?.includes(scope.value))
  }

  private matches(message: StoredMessage | null, selection: Selection): boolean {
    if (!message || !this.matchesMailbox(message, selection)) return false
    if (selection.folder === 'starred' ? !message.isStarred
      : selection.folder !== 'all' && !message.folderIds?.includes(selection.folder)) return false
    if (selection.unreadOnly && message.isRead) return false
    if (selection.search) {
      const haystack = [message.subject, message.bodyText, message.bodyHtml,
        ...[message.from, ...message.to, ...message.cc, ...message.bcc].flatMap(person => [person.name, person.email]),
        ...message.attachments.map(file => file.filename)].join('\n').toLowerCase()
      if (!haystack.includes(selection.search)) return false
    }
    return true
  }

  private initialCursor(resource: Resource, selection: Selection): PageCursor {
    return { version: 1, database: this.store.identity, store: this.scope.storeId,
      owner: this.scope.owner, account: this.accountId, resource, selection: fingerprint(selection),
      mode: 'snapshot', ceiling: this.store.highWater(this.scope), offset: 0, after: 0 }
  }

  private parseCursor(raw: string, resource: Resource, selection: Selection): PageCursor {
    const value = this.store.readCursor(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) cursorError()
    const cursor = value as PageCursor
    if (Object.keys(cursor).sort().join(',') !== ['version', 'database', 'store', 'owner', 'account', 'resource', 'selection', 'mode', 'ceiling', 'offset', 'after'].sort().join(',')) cursorError()
    if (cursor.version !== 1 || cursor.database !== this.store.identity || cursor.store !== this.scope.storeId ||
      cursor.owner !== this.scope.owner || cursor.account !== this.accountId || cursor.resource !== resource || cursor.selection !== fingerprint(selection)) cursorError()
    if (!['snapshot', 'delta'].includes(cursor.mode) || resource !== 'sync' && cursor.mode !== 'snapshot') cursorError()
    if ([cursor.ceiling, cursor.offset, cursor.after].some(value => !Number.isSafeInteger(value) || value < 0) ||
      cursor.ceiling > this.store.highWater(this.scope) || cursor.after > cursor.ceiling || cursor.mode === 'snapshot' && cursor.after !== 0) cursorError()
    return cursor
  }

  private syncCursor(cursor: PageCursor, selection: Selection): SyncCursor {
    return { provider: PROVIDER_ID, kind: cursor.mode === 'snapshot' ? 'page' : 'delta', folder: selection.folder, value: this.store.signCursor(cursor) }
  }

  async getAccount() {
    this.open()
    return { ...this.store.account(this.scope), capabilities: MOCK_CAPABILITIES }
  }

  async listFolders() { this.open(); return this.store.listFolders(this.scope) }
  async createFolder(name: string) { this.open(); return this.store.createFolder(this.scope, name) }

  async listMessages(options: ListOptions = {}): Promise<ProviderListResult<MailMessage>> {
    this.open(); object(options, 'List options'); keys(options, ['folder', 'search', 'unreadOnly', 'mailboxScopes', 'cursor', 'limit'], 'List options')
    const selection = this.selection(options, 'all'); const size = limit(options.limit)
    if (options.cursor !== undefined && options.cursor !== null && typeof options.cursor !== 'string') cursorError()
    const cursor = options.cursor === undefined || options.cursor === null ? this.initialCursor('messages', selection) : this.parseCursor(options.cursor, 'messages', selection)
    const rows = this.store.snapshot(this.scope, cursor.ceiling).filter(message => this.matches(message, selection))
      .sort((a, b) => compare(b.receivedAt, a.receivedAt) || compare(a.id, b.id))
    if (cursor.offset > rows.length) cursorError()
    const selected = rows.slice(cursor.offset, cursor.offset + size)
    const offset = cursor.offset + selected.length
    return { items: selected.map(message => this.store.project(this.scope, message)), total: rows.length,
      hasMore: offset < rows.length, nextCursor: offset < rows.length ? this.store.signCursor({ ...cursor, offset }) : null }
  }

  async listThreads(options: ListOptions = {}): Promise<ProviderListResult<MailThread>> {
    this.open(); object(options, 'List options'); keys(options, ['folder', 'search', 'unreadOnly', 'mailboxScopes', 'cursor', 'limit'], 'List options')
    const selection = this.selection(options, 'all'); const size = limit(options.limit)
    if (options.cursor !== undefined && options.cursor !== null && typeof options.cursor !== 'string') cursorError()
    const cursor = options.cursor === undefined || options.cursor === null ? this.initialCursor('threads', selection) : this.parseCursor(options.cursor, 'threads', selection)
    const snapshot = this.store.snapshot(this.scope, cursor.ceiling)
    const matching = new Set(snapshot.filter(message => this.matches(message, selection)).map(message => message.threadId))
    // Select entire conversations before paginating, rather than grouping a page of messages.
    const threads = buildThreads(snapshot.filter(message => matching.has(message.threadId) && this.matchesMailbox(message, selection)).map(message => this.store.project(this.scope, message)))
      .sort((a, b) => compare(b.lastMessageAt, a.lastMessageAt) || compare(a.id, b.id))
    if (cursor.offset > threads.length) cursorError()
    const items = threads.slice(cursor.offset, cursor.offset + size)
    const offset = cursor.offset + items.length
    return { items, total: threads.length, hasMore: offset < threads.length,
      nextCursor: offset < threads.length ? this.store.signCursor({ ...cursor, offset }) : null }
  }

  async getMessage(id: string) { this.open(); return this.store.project(this.scope, this.store.message(this.scope, id)) }
  async getThread(id: string) { this.open(); return buildThreads(this.store.thread(this.scope, id).map(message => this.store.project(this.scope, message)))[0]! }

  async sync(raw?: SyncCursor | string | null, options: SyncOptions = {}): Promise<SyncResult> {
    this.open(); object(options, 'Sync options'); keys(options, ['folder', 'limit', 'mailboxScopes'], 'Sync options')
    const selection = this.selection(options, 'inbox'); const size = limit(options.limit, 100)
    let cursor: PageCursor
    if (raw === undefined || raw === null) cursor = this.initialCursor('sync', selection)
    else {
      if (typeof raw !== 'string') {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !['provider', 'kind', 'folder', 'value'].includes(key))) cursorError()
        if (raw.provider !== PROVIDER_ID || raw.folder !== selection.folder || typeof raw.value !== 'string') cursorError()
      }
      cursor = this.parseCursor(typeof raw === 'string' ? raw : raw.value, 'sync', selection)
      if (typeof raw !== 'string' && raw.kind !== (cursor.mode === 'snapshot' ? 'page' : 'delta')) cursorError()
    }
    if (cursor.mode === 'snapshot') {
      const snapshot = this.store.snapshot(this.scope, cursor.ceiling).filter(message => this.matches(message, selection))
        .sort((a, b) => compare(b.receivedAt, a.receivedAt) || compare(a.id, b.id))
      if (cursor.offset > snapshot.length) cursorError()
      const messages = snapshot.slice(cursor.offset, cursor.offset + size).map(message => this.store.project(this.scope, message))
      const offset = cursor.offset + messages.length; const hasMore = offset < snapshot.length
      const recentCursor = this.syncCursor({ ...cursor, mode: 'delta', after: cursor.ceiling, offset: 0 }, selection)
      return { messages, threads: buildThreads(messages), deletedMessageIds: [], removedMessageIds: [],
        hasMore, fullSync: true, snapshotComplete: !hasMore, recentCursor,
        cursor: hasMore ? this.syncCursor({ ...cursor, offset }, selection) : recentCursor }
    }

    // A continuation has a fixed upper fence. Once drained, the next request opens a new interval.
    if (cursor.after === cursor.ceiling && cursor.offset === 0) cursor = { ...cursor, ceiling: this.store.highWater(this.scope) }
    const changes = this.store.changes(this.scope, cursor.after, cursor.ceiling).filter(change =>
      this.matches(change.after, selection) || this.matches(change.before, selection) ||
      change.after === null && change.before !== null && this.matchesMailbox(change.before, selection))
    if (cursor.offset > changes.length) cursorError()
    const selected = changes.slice(cursor.offset, cursor.offset + size)
    const messages = selected.flatMap(change => change.after ? [this.store.project(this.scope, change.after)] : [])
    const deletedMessageIds = selected.filter(change => change.after === null).map(change => change.id)
    const removedMessageIds = selection.folder === 'all' ? [] : selected.filter(change => change.after !== null && this.matches(change.before, selection) && !this.matches(change.after, selection)).map(change => change.id)
    // Rehydrate a folder exit too: the SDK can record the actual destination (e.g. Trash),
    // not merely its fallback of Archive when processing a folder-removal tombstone.
    const offset = cursor.offset + selected.length; const hasMore = offset < changes.length
    const next = this.syncCursor(hasMore ? { ...cursor, offset } : { ...cursor, after: cursor.ceiling, offset: 0 }, selection)
    return { messages, threads: buildThreads(messages), deletedMessageIds, removedMessageIds,
      hasMore, fullSync: false, snapshotComplete: false, cursor: next, ...(!hasMore ? { recentCursor: next } : {}) }
  }

  async send(input: SendInput) { this.open(); return this.store.send(this.scope, input) }
  async mutate(id: string, changes: MessageMutation) { this.open(); return this.store.mutate(this.scope, id, changes) }
  async getAttachment(messageId: string, attachmentId: string, cid?: string, metadata?: Pick<Attachment, 'filename' | 'contentType' | 'inline'>) {
    this.open(); return this.store.attachment(this.scope, messageId, attachmentId, cid, metadata)
  }
  async disconnect(): Promise<void> { this.disconnected = true }
}

export function mockCredentialScope(store: MockMailStore, credentials: ProviderCredentials & Record<string, unknown>): StoreScope {
  object(credentials, 'Mock credentials')
  keys(credentials, ['storeId', 'databaseId', 'accountId', 'userId', 'fetch', 'sdkMailboxScopes'], 'Mock credentials')
  if (credentials.databaseId !== store.identity) throw new ProviderAuthorizationError(PROVIDER_ID, 'Mock credentials address a different upstream database.')
  if (credentials.sdkMailboxScopes !== undefined) invalid('Mailbox scopes must be supplied to the operation, not stored as credentials.')
  const scope: StoreScope = { owner: contextId(credentials.userId, 'SDK owner'), accountId: contextId(credentials.accountId, 'SDK account ID'), storeId: contextId(credentials.storeId, 'mock store ID') }
  store.assertScope(scope)
  return scope
}

export function createMockProviderDefinition(store: MockMailStore): ProviderDefinition {
  return {
    id: PROVIDER_ID, name: 'Superlocal Mock (offline)', connection: 'credentials', scopes: [],
    credentialReconnect: false, mailboxSelection: 'automatic',
    create(credentials) { return new MockInboxProvider(store, mockCredentialScope(store, credentials)) },
    async discover(provider) {
      if (!(provider instanceof MockInboxProvider) || !provider.belongsTo(store)) invalid('Mock discovery requires an instance of this store factory.')
      const account = await provider.getAccount()
      const identities = [account.email, ...(account.aliases ?? [])].map(email => ({ email, name: account.name }))
      const domains = [...new Set(identities.map(identity => identity.email.split('@')[1]!))]
      return { identities, sources: [
        ...identities.map(identity => ({ kind: 'address' as const, value: identity.email, canReceive: true, canSend: true, canFilter: true })),
        ...domains.map(value => ({ kind: 'domain' as const, value, canReceive: true, canSend: true, canFilter: true })),
      ] }
    },
  }
}
