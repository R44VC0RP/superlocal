import { Database } from 'bun:sqlite'
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  attachmentUrl, previewText, ProviderAuthorizationError, ProviderCursorExpiredError,
  ProviderError, ProviderNotFoundError, UnsupportedOperationError,
  type Attachment, type AttachmentData, type MailAccount, type MailMessage,
  type MessageMutation, type ProviderFolder, type Recipient,
  type SendAttachment, type SendInput, type SendResult,
} from 'inbox-sdk/provider'
import {
  attachments, body, compare, contentId, contextId, email, fingerprint, headers, invalid,
  keys, LOCAL_FOLDERS, nativeId, object, PROVIDER_ID, recipients, references, rfcId,
  stableJson, storeId, SYSTEM_FOLDERS, text, uniqueRecipients, type PreparedAttachment,
} from './validation'

export interface StoreScope {
  readonly owner: string
  readonly storeId: string
  readonly accountId: string
}

export interface MockMailbox {
  id: string
  owner: string
  seedKey: string
  name: string
  email: string
  aliases: string[]
  color: string
}

export interface SourceLink {
  accountId: string
  connectionId: string
  cacheReady: boolean
}

export interface StoredMessage extends Omit<MailMessage, 'accountId' | 'attachments'> {
  attachments: Array<Omit<Attachment, 'url'>>
}

export interface ReceiveInput {
  from: Recipient
  to?: Recipient | Recipient[]
  cc?: Recipient | Recipient[]
  bcc?: Recipient | Recipient[]
  replyTo?: Recipient | Recipient[]
  subject: string
  text?: string
  html?: string
  bodyText?: string
  bodyHtml?: string
  receivedAt?: string
  rfcMessageId?: string
  inReplyTo?: string
  references?: string[]
  headers?: Record<string, string>
  attachments?: SendAttachment[]
  folder?: string
  labels?: string[]
  isRead?: boolean
  isStarred?: boolean
  threadId?: string
  /** Trusted fake envelope evidence, not inferred from an arbitrary To header. */
  deliveryRecipients?: string[]
  idempotencyKey?: string
}

type JsonRow = { data: string }
type CurrentRow = { id: string; data: string | null }
type VersionRow = CurrentRow & { seq: number }
type LinkRow = { account_id: string; connection_id: string; cache_ready: number }
type ReceiptRow = { fingerprint: string; result: string }
type NewMessage = Omit<StoredMessage, 'id' | 'attachments' | 'preview' | 'folderIds'>

function attachmentIntent(files: PreparedAttachment[]) {
  return files.map(({ content, ...info }) => ({ ...info, sha256: createHash('sha256').update(content).digest('hex') }))
}

function accountAddresses(account: MockMailbox): string[] { return [account.email, ...account.aliases] }

function messageHeaders(input: { rfcMessageId?: string; inReplyTo?: string; references?: string[] }, supplied: Record<string, string>) {
  const messageId = input.rfcMessageId === undefined ? supplied['Message-ID'] : rfcId(input.rfcMessageId)
  if (input.rfcMessageId && supplied['Message-ID'] && input.rfcMessageId !== supplied['Message-ID']) invalid('Conflicting RFC Message-ID fields.')
  const inReplyTo = input.inReplyTo === undefined ? supplied['In-Reply-To'] : rfcId(input.inReplyTo, 'In-Reply-To')
  if (input.inReplyTo && supplied['In-Reply-To'] && input.inReplyTo !== supplied['In-Reply-To']) invalid('Conflicting In-Reply-To fields.')
  const refs = references(input.references ?? (supplied.References ? supplied.References.split(/\s+/) : undefined))
  if (input.references !== undefined && supplied.References && stableJson(refs) !== stableJson(references(supplied.References.split(/\s+/)))) invalid('Conflicting References fields.')
  return { messageId, inReplyTo, references: refs }
}

/** A fake upstream, not an SDK cache. Only its creator owns close(). */
export class MockMailStore {
  readonly identity: string
  private readonly db: Database
  private readonly cursorKey: Buffer
  private closed = false

  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new Database(path, { create: true })
    if (path !== ':memory:') chmodSync(path, 0o600)
    try {
      this.db.exec(`
        PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS mock_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS mock_stores (
          id TEXT NOT NULL, owner TEXT NOT NULL, seed_key TEXT NOT NULL, data TEXT NOT NULL,
          PRIMARY KEY(owner,id), UNIQUE(owner,seed_key)
        );
        CREATE TABLE IF NOT EXISTS mock_source_links (
          owner TEXT NOT NULL, store_id TEXT NOT NULL, account_id TEXT NOT NULL, connection_id TEXT NOT NULL,
          cache_ready INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(owner,store_id), UNIQUE(owner,account_id), UNIQUE(owner,connection_id),
          FOREIGN KEY(owner,store_id) REFERENCES mock_stores(owner,id)
        );
        CREATE TABLE IF NOT EXISTS mock_folders (
          owner TEXT NOT NULL, store_id TEXT NOT NULL, id TEXT NOT NULL, name_key TEXT NOT NULL, data TEXT NOT NULL,
          PRIMARY KEY(owner,store_id,id), UNIQUE(owner,store_id,name_key),
          FOREIGN KEY(owner,store_id) REFERENCES mock_stores(owner,id)
        );
        CREATE TABLE IF NOT EXISTS mock_messages (
          owner TEXT NOT NULL, store_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT,
          PRIMARY KEY(owner,store_id,id), FOREIGN KEY(owner,store_id) REFERENCES mock_stores(owner,id)
        );
        CREATE TABLE IF NOT EXISTS mock_versions (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, store_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT,
          FOREIGN KEY(owner,store_id) REFERENCES mock_stores(owner,id)
        );
        CREATE INDEX IF NOT EXISTS mock_version_snapshot ON mock_versions(owner,store_id,id,seq);
        CREATE INDEX IF NOT EXISTS mock_version_changes ON mock_versions(owner,store_id,seq);
        CREATE TABLE IF NOT EXISTS mock_attachments (
          owner TEXT NOT NULL, store_id TEXT NOT NULL, message_id TEXT NOT NULL, id TEXT NOT NULL, content BLOB NOT NULL,
          PRIMARY KEY(owner,store_id,message_id,id),
          FOREIGN KEY(owner,store_id,message_id) REFERENCES mock_messages(owner,store_id,id)
        );
        CREATE TABLE IF NOT EXISTS mock_receipts (
          owner TEXT NOT NULL, store_id TEXT NOT NULL, account_id TEXT NOT NULL, kind TEXT NOT NULL,
          correlation TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL,
          PRIMARY KEY(owner,store_id,account_id,kind,correlation),
          FOREIGN KEY(owner,store_id) REFERENCES mock_stores(owner,id)
        );
      `)
      this.db.transaction(() => {
        this.db.query('INSERT OR IGNORE INTO mock_meta VALUES (?,?)').run('schema', '1')
        if (this.meta('schema') !== '1') throw new Error('Unsupported mock store schema; no data was reset.')
        this.db.query('INSERT OR IGNORE INTO mock_meta VALUES (?,?)').run('identity', randomUUID())
        this.db.query('INSERT OR IGNORE INTO mock_meta VALUES (?,?)').run('cursor-key', randomBytes(32).toString('hex'))
      }).immediate()
      this.identity = storeId(this.meta('identity'))
      const key = this.meta('cursor-key')
      if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid persisted mock cursor key; no data was reset.')
      this.cursorKey = Buffer.from(key, 'hex')
    } catch (error) { this.db.close(); throw error }
  }

  private open(): void {
    if (this.closed) throw new ProviderError(PROVIDER_ID, 'UPSTREAM', 'The mock store is closed.', { status: 503 })
  }

  private meta(key: string): string {
    return this.db.query<{ value: string }, [string]>('SELECT value FROM mock_meta WHERE key=?').get(key)?.value ?? ''
  }

  /** The completion marker, both stores, mail, bytes, and history commit together. Never reseeds holes. */
  seedOnce(owner: string, create: () => void): void {
    this.open(); contextId(owner, 'owner')
    this.db.transaction(() => {
      const key = `fictional-mail-seeded:${owner}`
      if (this.meta(key)) return
      if (this.mailboxes(owner).length) throw new Error('An unmarked mock store already contains mailboxes; refusing to reseed it.')
      create()
      this.db.query('INSERT INTO mock_meta VALUES (?,?)').run(key, '1')
    }).immediate()
  }

  createMailbox(input: Omit<MockMailbox, 'id'>): MockMailbox {
    this.open(); contextId(input.owner, 'owner'); text(input.seedKey, 'seed key', 80)
    text(input.name, 'mailbox name', 255)
    const address = email(input.email)
    if (!Array.isArray(input.aliases)) invalid('Invalid mailbox aliases.')
    const aliases = [...new Set(input.aliases.map(email))].filter(value => value !== address)
    if ([address, ...aliases].some(value => !value.endsWith('.test'))) invalid('Mock mailbox identities must use fictional .test domains.')
    if (!/^#[a-f0-9]{6}$/i.test(input.color)) invalid('Invalid mailbox color.')
    return this.db.transaction(() => {
      if (this.db.query('SELECT 1 FROM mock_stores WHERE owner=? AND seed_key=?').get(input.owner, input.seedKey)) invalid('This mock seed identity already exists.')
      const mailbox: MockMailbox = { ...input, id: randomUUID(), email: address, aliases }
      this.db.query('INSERT INTO mock_stores VALUES (?,?,?,?)').run(mailbox.id, mailbox.owner, mailbox.seedKey, JSON.stringify(mailbox))
      for (const folder of SYSTEM_FOLDERS) this.insertFolder(mailbox, { id: folder, name: folder === 'inbox' ? 'Inbox' : folder[0]!.toUpperCase() + folder.slice(1), folder, kind: 'folder', custom: false })
      return mailbox
    }).immediate()
  }

  mailboxes(owner: string): MockMailbox[] {
    this.open(); contextId(owner, 'owner')
    return this.db.query<JsonRow, [string]>('SELECT data FROM mock_stores WHERE owner=? ORDER BY seed_key').all(owner).map(row => JSON.parse(row.data))
  }

  mailbox(owner: string, id: string): MockMailbox {
    this.open(); contextId(owner, 'owner'); storeId(id)
    const row = this.db.query<JsonRow, [string, string]>('SELECT data FROM mock_stores WHERE owner=? AND id=?').get(owner, id)
    if (!row) throw new ProviderAuthorizationError(PROVIDER_ID, 'The mock store is not available to this owner.')
    return JSON.parse(row.data)
  }

  link(owner: string, id: string): SourceLink | null {
    this.mailbox(owner, id)
    const row = this.db.query<LinkRow, [string, string]>('SELECT account_id,connection_id,cache_ready FROM mock_source_links WHERE owner=? AND store_id=?').get(owner, id)
    return row ? { accountId: row.account_id, connectionId: row.connection_id, cacheReady: Boolean(row.cache_ready) } : null
  }

  /** Called after real SDK connection creation. Its verified identity recovers a crash before this write. */
  linkSource(scope: StoreScope, connectionId: string): void {
    this.assertScope(scope); contextId(connectionId, 'connection ID')
    this.db.transaction(() => {
      const existing = this.link(scope.owner, scope.storeId)
      if (existing && (existing.accountId !== scope.accountId || existing.connectionId !== connectionId)) {
        throw new ProviderAuthorizationError(PROVIDER_ID, 'This mock store already belongs to another SDK source.')
      }
      this.db.query('INSERT OR IGNORE INTO mock_source_links(owner,store_id,account_id,connection_id) VALUES (?,?,?,?)').run(scope.owner, scope.storeId, scope.accountId, connectionId)
    }).immediate()
  }

  markCacheReady(scope: StoreScope): void {
    this.assertScope(scope)
    const changed = this.db.query('UPDATE mock_source_links SET cache_ready=1 WHERE owner=? AND store_id=? AND account_id=?').run(scope.owner, scope.storeId, scope.accountId)
    if (!changed.changes) invalid('The mock source has not been linked.')
  }

  assertScope(scope: StoreScope): MockMailbox {
    object(scope, 'Store scope'); keys(scope, ['owner', 'storeId', 'accountId'], 'Store scope')
    contextId(scope.accountId, 'SDK account ID')
    const mailbox = this.mailbox(scope.owner, scope.storeId)
    const link = this.link(scope.owner, scope.storeId)
    const other = this.db.query<{ store_id: string }, [string, string]>('SELECT store_id FROM mock_source_links WHERE owner=? AND account_id=?').get(scope.owner, scope.accountId)
    if (link && link.accountId !== scope.accountId || other && other.store_id !== scope.storeId) {
      throw new ProviderAuthorizationError(PROVIDER_ID, 'The SDK source and mock store do not match.')
    }
    return mailbox
  }

  account(scope: StoreScope): MailAccount {
    const profile = this.assertScope(scope)
    return { id: scope.accountId, userId: scope.owner, provider: PROVIDER_ID, name: profile.name,
      email: profile.email, aliases: profile.aliases, color: profile.color, syncStatus: 'connected',
      unreadCount: this.snapshot(scope).filter(message => message.folder === 'inbox' && !message.isRead).length }
  }

  private insertFolder(mailbox: MockMailbox, folder: ProviderFolder): void {
    const key = folder.name.normalize('NFKC').toLowerCase()
    if (this.db.query('SELECT 1 FROM mock_folders WHERE owner=? AND store_id=? AND name_key=?').get(mailbox.owner, mailbox.id, key)) invalid('A folder or label with this name already exists.')
    this.db.query('INSERT INTO mock_folders VALUES (?,?,?,?,?)').run(mailbox.owner, mailbox.id, folder.id, key, JSON.stringify(folder))
  }

  createFolder(scope: StoreScope, name: string, kind: 'folder' | 'label' = 'folder'): ProviderFolder {
    const mailbox = this.assertScope(scope)
    name = text(name, 'folder name', 255).trim()
    if (/[\/\\]/.test(name) || [...SYSTEM_FOLDERS, ...LOCAL_FOLDERS, 'starred', 'all'].includes(name.normalize('NFKC').toLowerCase())) invalid('Reserved or invalid folder name.')
    if (kind !== 'folder' && kind !== 'label') invalid('Invalid folder kind.')
    return this.db.transaction(() => {
      const id = this.newId(scope, kind === 'label' ? 'lbl' : 'fld')
      const folder: ProviderFolder = { id, folder: id, name, path: name, kind, custom: true }
      this.insertFolder(mailbox, folder)
      return folder
    }).immediate()
  }

  private folderRows(scope: StoreScope): ProviderFolder[] {
    this.assertScope(scope)
    return this.db.query<JsonRow, [string, string]>('SELECT data FROM mock_folders WHERE owner=? AND store_id=? ORDER BY rowid').all(scope.owner, scope.storeId).map(row => JSON.parse(row.data))
  }

  listFolders(scope: StoreScope): ProviderFolder[] {
    const messages = this.snapshot(scope)
    return this.folderRows(scope).map(folder => {
      const matches = messages.filter(message => message.folderIds?.includes(folder.id))
      return { ...folder, totalCount: matches.length, unreadCount: matches.filter(message => !message.isRead).length }
    })
  }

  folder(scope: StoreScope, value: unknown, writable = false): string {
    this.assertScope(scope)
    const id = text(value, 'folder')
    if ((LOCAL_FOLDERS as readonly string[]).includes(id)) throw new UnsupportedOperationError(PROVIDER_ID, `native ${id}; use SDK local workflows`)
    if (id === 'all' || id === 'starred') {
      if (writable) throw new UnsupportedOperationError(PROVIDER_ID, `moving to the ${id} view`)
      return id
    }
    if (!(SYSTEM_FOLDERS as readonly string[]).includes(id)) nativeId(id, id.startsWith('lbl_') ? 'lbl' : 'fld', scope.storeId)
    const found = this.folderRows(scope).find(folder => folder.id === id)
    if (!found) throw new ProviderNotFoundError(PROVIDER_ID, 'The folder does not exist in this mock store.')
    if (writable && found.kind === 'label') invalid('Labels are applied with addLabels, not as a destination folder.')
    return id
  }

  private labels(scope: StoreScope, value: unknown): string[] {
    if (value === undefined) return []
    if (!Array.isArray(value) || value.length > 1000) invalid('Invalid labels.')
    const available = this.folderRows(scope).filter(folder => folder.kind === 'label')
    return [...new Set(value.map(item => {
      const label = text(item, 'label')
      if (label.startsWith('lbl_')) nativeId(label, 'lbl', scope.storeId)
      const found = available.find(folder => folder.id === label || folder.name === label)
      if (!found) throw new ProviderNotFoundError(PROVIDER_ID, 'The label does not exist in this mock store.')
      return found.id
    }))]
  }

  highWater(scope: StoreScope): number {
    this.assertScope(scope)
    return this.db.query<{ seq: number }, [string, string]>('SELECT COALESCE(MAX(seq),0) seq FROM mock_versions WHERE owner=? AND store_id=?').get(scope.owner, scope.storeId)!.seq
  }

  /** Durable MVCC snapshots make list reads side-effect-free, even when new mail arrives mid-page. */
  snapshot(scope: StoreScope, at?: number): StoredMessage[] {
    this.assertScope(scope)
    if (at === undefined) return this.db.query<JsonRow, [string, string]>('SELECT data FROM mock_messages WHERE owner=? AND store_id=? AND data IS NOT NULL').all(scope.owner, scope.storeId).map(row => JSON.parse(row.data))
    this.checkSequence(scope, at)
    return this.db.query<JsonRow, [string, string, number]>(`SELECT v.data FROM mock_versions v JOIN (
      SELECT id,MAX(seq) seq FROM mock_versions WHERE owner=? AND store_id=? AND seq<=? GROUP BY id
    ) last ON last.seq=v.seq WHERE v.data IS NOT NULL`).all(scope.owner, scope.storeId, at).map(row => JSON.parse(row.data))
  }

  private checkSequence(scope: StoreScope, seq: number): void {
    if (!Number.isSafeInteger(seq) || seq < 0 || seq > this.highWater(scope)) throw new ProviderCursorExpiredError(PROVIDER_ID, 'Invalid mock history position.', { status: 400 })
  }

  changes(scope: StoreScope, after: number, through: number): Array<{ seq: number; id: string; before: StoredMessage | null; after: StoredMessage | null }> {
    this.assertScope(scope); this.checkSequence(scope, after); this.checkSequence(scope, through)
    if (after > through) throw new ProviderCursorExpiredError(PROVIDER_ID, 'Invalid mock history interval.', { status: 400 })
    const rows = this.db.query<VersionRow, [string, string, number, number]>(`SELECT v.seq,v.id,v.data FROM mock_versions v JOIN (
      SELECT id,MAX(seq) seq FROM mock_versions WHERE owner=? AND store_id=? AND seq>? AND seq<=? GROUP BY id
    ) last ON last.seq=v.seq ORDER BY v.seq`).all(scope.owner, scope.storeId, after, through)
    return rows.map(row => {
      const previous = this.db.query<CurrentRow, [string, string, string, number]>('SELECT id,data FROM mock_versions WHERE owner=? AND store_id=? AND id=? AND seq<=? ORDER BY seq DESC LIMIT 1').get(scope.owner, scope.storeId, row.id, after)
      return { seq: row.seq, id: row.id, before: previous?.data ? JSON.parse(previous.data) : null, after: row.data ? JSON.parse(row.data) : null }
    })
  }

  message(scope: StoreScope, id: string): StoredMessage {
    this.assertScope(scope); nativeId(id, 'msg', scope.storeId)
    const row = this.db.query<CurrentRow, [string, string, string]>('SELECT id,data FROM mock_messages WHERE owner=? AND store_id=? AND id=?').get(scope.owner, scope.storeId, id)
    if (!row?.data) throw new ProviderNotFoundError(PROVIDER_ID, 'The mock message does not exist.')
    return JSON.parse(row.data)
  }

  thread(scope: StoreScope, id: string): StoredMessage[] {
    this.assertScope(scope); nativeId(id, 'thr', scope.storeId)
    const messages = this.snapshot(scope).filter(message => message.threadId === id)
    if (!messages.length) throw new ProviderNotFoundError(PROVIDER_ID, 'The mock thread does not exist.')
    return messages.sort((a, b) => compare(a.receivedAt, b.receivedAt) || compare(a.id, b.id))
  }

  project(scope: StoreScope, message: StoredMessage): MailMessage {
    this.assertScope(scope); nativeId(message.id, 'msg', scope.storeId); nativeId(message.threadId, 'thr', scope.storeId)
    return { ...structuredClone(message), accountId: scope.accountId,
      attachments: message.attachments.map(attachment => ({ ...attachment, url: attachmentUrl(scope.accountId, message.id, attachment.id) })) }
  }

  attachment(scope: StoreScope, messageId: string, attachmentId: string, cid?: string, metadata?: Pick<Attachment, 'filename' | 'contentType' | 'inline'>): AttachmentData {
    const message = this.message(scope, messageId)
    nativeId(attachmentId, 'att', scope.storeId)
    const found = message.attachments.find(attachment => attachment.id === attachmentId)
    if (!found || cid !== undefined && contentId(cid) !== found.contentId) throw new ProviderNotFoundError(PROVIDER_ID, 'The attachment does not belong to this message.')
    if (metadata && (metadata.filename !== found.filename || metadata.contentType !== found.contentType || metadata.inline !== undefined && metadata.inline !== Boolean(found.inline))) invalid('Attachment metadata does not match its opaque ID.')
    const row = this.db.query<{ content: Uint8Array }, [string, string, string, string]>('SELECT content FROM mock_attachments WHERE owner=? AND store_id=? AND message_id=? AND id=?').get(scope.owner, scope.storeId, messageId, attachmentId)
    if (!row) throw new ProviderNotFoundError(PROVIDER_ID, 'The attachment bytes do not exist.')
    return { attachment: { ...found, url: attachmentUrl(scope.accountId, messageId, attachmentId) }, content: new Uint8Array(row.content), filename: found.filename, contentType: found.contentType }
  }

  private newId(scope: StoreScope, kind: 'msg' | 'thr' | 'att' | 'fld' | 'lbl'): string { return `${kind}_${scope.storeId}_${randomUUID()}` }

  private append(scope: StoreScope, id: string, message: StoredMessage | null): void {
    const data = message ? JSON.stringify(message) : null
    this.db.query('INSERT INTO mock_versions(owner,store_id,id,data) VALUES (?,?,?,?)').run(scope.owner, scope.storeId, id, data)
    this.db.query('INSERT INTO mock_messages VALUES (?,?,?,?) ON CONFLICT(owner,store_id,id) DO UPDATE SET data=excluded.data').run(scope.owner, scope.storeId, id, data)
  }

  private insert(scope: StoreScope, input: NewMessage, files: PreparedAttachment[]): StoredMessage {
    const id = this.newId(scope, 'msg')
    const stored: StoredMessage = { ...input, id, preview: previewText(input.bodyText || input.bodyHtml),
      folderIds: [input.folder, ...input.labels],
      attachments: files.map(({ content, ...attachment }) => ({ ...attachment, id: this.newId(scope, 'att'), size: content.byteLength })) }
    this.append(scope, id, stored)
    for (let i = 0; i < files.length; i++) this.db.query('INSERT INTO mock_attachments VALUES (?,?,?,?,?)').run(scope.owner, scope.storeId, id, stored.attachments[i]!.id, files[i]!.content)
    return stored
  }

  private replyThread(scope: StoreScope, inReplyTo?: string, refs: string[] = []): string {
    const current = this.snapshot(scope)
    for (const reference of [...(inReplyTo ? [inReplyTo] : []), ...[...refs].reverse()]) {
      const threads = new Set(current.filter(message => message.rfcMessageId === reference).map(message => message.threadId))
      if (threads.size === 1) return [...threads][0]!
      if (threads.size > 1) invalid('Ambiguous reply reference; supply an explicit native thread ID.')
    }
    return this.newId(scope, 'thr')
  }

  private replay<T>(scope: StoreScope, kind: 'send' | 'receive', correlation: string | undefined, intent: unknown): T | null {
    if (!correlation) return null
    const old = this.db.query<ReceiptRow, [string, string, string, string, string]>('SELECT fingerprint,result FROM mock_receipts WHERE owner=? AND store_id=? AND account_id=? AND kind=? AND correlation=?').get(scope.owner, scope.storeId, scope.accountId, kind, correlation)
    if (!old) return null
    if (old.fingerprint !== fingerprint(intent)) invalid('This correlation ID was already used for a different delivery.')
    return JSON.parse(old.result)
  }

  private receipt(scope: StoreScope, kind: 'send' | 'receive', correlation: string | undefined, intent: unknown, result: unknown): void {
    if (correlation) this.db.query('INSERT INTO mock_receipts VALUES (?,?,?,?,?,?,?)').run(scope.owner, scope.storeId, scope.accountId, kind, correlation, fingerprint(intent), JSON.stringify(result))
  }

  /** Server-side fake arrival injection. Not exposed as another mail HTTP API. */
  receive(scope: StoreScope, input: ReceiveInput): MailMessage {
    const profile = this.assertScope(scope)
    object(input, 'Incoming message')
    keys(input, ['from', 'to', 'cc', 'bcc', 'replyTo', 'subject', 'text', 'html', 'bodyText', 'bodyHtml', 'receivedAt', 'rfcMessageId', 'inReplyTo', 'references', 'headers', 'attachments', 'folder', 'labels', 'isRead', 'isStarred', 'threadId', 'deliveryRecipients', 'idempotencyKey'], 'Incoming message')
    const from = recipients(input.from, 'sender')
    if (from.length !== 1) invalid('Exactly one incoming sender is required.')
    const to = recipients(input.to ?? { name: profile.name, email: profile.email }, 'recipients')
    const cc = recipients(input.cc, 'Cc'); const bcc = recipients(input.bcc, 'Bcc')
    const subject = text(input.subject, 'subject', 998, true)
    const bodies = body(input); const files = attachments(input.attachments)
    const suppliedHeaders = headers(input.headers)
    const replyTo = input.replyTo === undefined && suppliedHeaders['Reply-To'] === undefined ? undefined
      : recipients(input.replyTo ?? suppliedHeaders['Reply-To'], 'Reply-To')
    if (input.replyTo !== undefined && suppliedHeaders['Reply-To'] !== undefined && stableJson(replyTo) !== stableJson(recipients(suppliedHeaders['Reply-To'], 'Reply-To'))) invalid('Conflicting Reply-To fields.')
    const meta = messageHeaders(input, suppliedHeaders)
    const folder = this.folder(scope, input.folder ?? 'inbox', true)
    const labels = this.labels(scope, input.labels)
    for (const flag of [input.isRead, input.isStarred]) if (flag !== undefined && typeof flag !== 'boolean') invalid('Invalid incoming message flag.')
    const allowed = accountAddresses(profile)
    if (folder === 'sent' && !allowed.includes(from[0]!.email)) invalid('A native Sent message must use this mock account as its sender.')
    if (input.deliveryRecipients !== undefined && (!Array.isArray(input.deliveryRecipients) || input.deliveryRecipients.length > 200)) invalid('Invalid delivery evidence.')
    const delivered = [...new Set((input.deliveryRecipients ?? (folder === 'sent' ? [from[0]!.email] : [...to, ...cc, ...bcc].map(item => item.email).filter(value => allowed.includes(value)))).map(email))]
    if (!delivered.length || delivered.some(value => !allowed.includes(value))) invalid('Delivery evidence must address this mock store.')
    let receivedAt: string | undefined
    if (input.receivedAt !== undefined) {
      text(input.receivedAt, 'received time', 100)
      if (!Number.isFinite(Date.parse(input.receivedAt))) invalid('Invalid received time.')
      receivedAt = new Date(input.receivedAt).toISOString()
    }
    if (input.threadId !== undefined) nativeId(input.threadId, 'thr', scope.storeId)
    const correlation = input.idempotencyKey === undefined ? undefined : text(input.idempotencyKey, 'delivery idempotency key', 200)
    const intent = { ...input, receivedAt, from, to, cc, bcc, replyTo, subject, ...bodies, folder, labels, delivered, headers: suppliedHeaders, attachments: attachmentIntent(files) }
    return this.db.transaction(() => {
      const replayed = this.replay<StoredMessage>(scope, 'receive', correlation, intent)
      if (replayed) return this.project(scope, replayed)
      if (input.threadId) this.thread(scope, input.threadId)
      const threadId = input.threadId ?? this.replyThread(scope, meta.inReplyTo, meta.references)
      const messageId = meta.messageId ?? `<${randomUUID()}@mail.mock.test>`
      const finalHeaders = { ...suppliedHeaders, 'Message-ID': messageId, ...(meta.inReplyTo ? { 'In-Reply-To': meta.inReplyTo } : {}), ...(meta.references.length ? { References: meta.references.join(' ') } : {}) }
      const message = this.insert(scope, { threadId, from: from[0]!, to, cc, bcc: [], ...(replyTo ? { replyTo } : {}),
        subject, ...bodies, receivedAt: receivedAt ?? new Date().toISOString(), isRead: input.isRead ?? folder === 'sent', isStarred: input.isStarred ?? false,
        folder, labels, rfcMessageId: messageId, ...(meta.inReplyTo ? { inReplyTo: meta.inReplyTo } : {}), references: meta.references, headers: finalHeaders,
        deliveryRecipients: delivered, sourceDomains: [...new Set(delivered.map(value => value.split('@')[1]!))] }, files)
      this.receipt(scope, 'receive', correlation, intent, message)
      return this.project(scope, message)
    }).immediate()
  }

  send(scope: StoreScope, input: SendInput): SendResult {
    const profile = this.assertScope(scope)
    object(input, 'Send input')
    keys(input, ['accountId', 'from', 'to', 'cc', 'bcc', 'subject', 'body', 'text', 'html', 'bodyText', 'bodyHtml', 'attachments', 'threadId', 'sourceMessageId', 'inReplyTo', 'references', 'replyAll', 'scheduledAt', 'headers'], 'Send input')
    if (input.accountId !== undefined && input.accountId !== scope.accountId) throw new ProviderAuthorizationError(PROVIDER_ID, 'Send account does not match this source.')
    if (input.scheduledAt !== undefined) throw new UnsupportedOperationError(PROVIDER_ID, 'native scheduling; use SDK draft submission')
    if (input.replyAll !== undefined && typeof input.replyAll !== 'boolean') invalid('replyAll must be boolean.')
    const from = recipients(input.from ?? { name: profile.name, email: profile.email }, 'sender')
    const own = accountAddresses(profile)
    if (from.length !== 1 || !own.includes(from[0]!.email)) throw new ProviderAuthorizationError(PROVIDER_ID, 'Send must use a verified identity of this mock account.')
    let to = uniqueRecipients(recipients(input.to, 'recipients'))
    let cc = uniqueRecipients(recipients(input.cc, 'Cc'))
    const bcc = uniqueRecipients(recipients(input.bcc, 'Bcc'))
    const subject = text(input.subject, 'subject', 998, true)
    const bodies = body(input); const files = attachments(input.attachments)
    const suppliedHeaders = headers(input.headers)
    const meta = messageHeaders(input, suppliedHeaders)
    if (input.threadId !== undefined) nativeId(input.threadId, 'thr', scope.storeId)
    if (input.sourceMessageId !== undefined) nativeId(input.sourceMessageId, 'msg', scope.storeId)
    const correlation = suppliedHeaders['X-Inbox-Submission-ID']
    const intent = { from, to, cc, bcc, subject, ...bodies, headers: suppliedHeaders,
      threadId: input.threadId, sourceMessageId: input.sourceMessageId, inReplyTo: meta.inReplyTo, references: meta.references, replyAll: input.replyAll ?? false, attachments: attachmentIntent(files) }
    return this.db.transaction(() => {
      const previous = this.replay<SendResult>(scope, 'send', correlation, intent)
      if (previous) return previous
      const thread = input.threadId ? this.thread(scope, input.threadId) : undefined
      const source = input.sourceMessageId ? this.message(scope, input.sourceMessageId) : thread?.at(-1)
      if (source && input.threadId && source.threadId !== input.threadId) invalid('Reply source does not belong to the specified thread.')
      if (input.replyAll && !source) invalid('Reply-all requires a native source message or thread.')
      if (source && meta.inReplyTo && source.rfcMessageId && meta.inReplyTo !== source.rfcMessageId) invalid('In-Reply-To does not match the reply source.')
      if (source && input.replyAll) {
        to = uniqueRecipients([...to, ...(source.replyTo?.length ? source.replyTo : [source.from]), ...source.to]).filter(item => !own.includes(item.email))
        cc = uniqueRecipients([...cc, ...source.cc]).filter(item => !own.includes(item.email) && !to.some(recipient => recipient.email === item.email))
      } else if (source && !to.length && !cc.length && !bcc.length) {
        to = uniqueRecipients(source.replyTo?.length ? source.replyTo : [source.from]).filter(item => !own.includes(item.email))
      }
      const accepted = [...new Set([...to, ...cc, ...bcc].map(item => item.email))]
      if (!accepted.length || accepted.length > 200) invalid('Send requires between 1 and 200 recipients.')
      const inReplyTo = meta.inReplyTo ?? source?.rfcMessageId
      const refs = input.references !== undefined || suppliedHeaders.References !== undefined ? meta.references
        : source ? [...new Set([...(source.references ?? []), ...(source.rfcMessageId ? [source.rfcMessageId] : [])])] : meta.references
      const threadId = input.threadId ?? source?.threadId ?? this.replyThread(scope, inReplyTo, refs)
      const messageId = meta.messageId ?? `<${randomUUID()}@sent.mock.test>`
      const finalHeaders = { ...suppliedHeaders, 'Message-ID': messageId, ...(inReplyTo ? { 'In-Reply-To': inReplyTo } : {}), ...(refs.length ? { References: refs.join(' ') } : {}) }
      const common = { from: from[0]!, to, cc, subject, ...bodies, receivedAt: new Date().toISOString(),
        rfcMessageId: messageId, ...(inReplyTo ? { inReplyTo } : {}), references: refs, headers: finalHeaders,
        ...(suppliedHeaders['Reply-To'] ? { replyTo: recipients(suppliedHeaders['Reply-To'], 'Reply-To') } : {}) }
      const sent = this.insert(scope, { ...common, threadId, bcc, isRead: true, isStarred: false, folder: 'sent', labels: [],
        deliveryRecipients: [from[0]!.email], sourceDomains: [from[0]!.email.split('@')[1]!] }, files)
      // Delivery is a local SQLite transaction, even for external-looking recipient strings.
      // Matching stores are handled independently: never deduplicate stores by email or RFC IDs.
      for (const mailbox of this.mailboxes(scope.owner)) {
        const local = accepted.filter(value => accountAddresses(mailbox).includes(value))
        if (!local.length) continue
        const linked = this.link(scope.owner, mailbox.id)
        const target: StoreScope = { owner: scope.owner, storeId: mailbox.id, accountId: linked?.accountId ?? `upstream:${mailbox.id}` }
        this.assertScope(target)
        this.insert(target, { ...common, threadId: mailbox.id === scope.storeId ? sent.threadId : this.replyThread(target, inReplyTo, refs), bcc: [],
          isRead: false, isStarred: false, folder: 'inbox', labels: [], deliveryRecipients: local, sourceDomains: [...new Set(local.map(value => value.split('@')[1]!))] }, files)
      }
      const result: SendResult = { id: sent.id, providerMessageId: sent.id, threadId: sent.threadId, messageId, accepted, rejected: [] }
      this.receipt(scope, 'send', correlation, intent, result)
      return result
    }).immediate()
  }

  mutate(scope: StoreScope, id: string, changes: MessageMutation): MailMessage | null {
    this.assertScope(scope); nativeId(id, 'msg', scope.storeId)
    object(changes, 'Mutation')
    keys(changes, ['isRead', 'isStarred', 'isArchived', 'folder', 'addLabels', 'removeLabels', 'snoozedUntil', 'deletePermanently'], 'Mutation')
    if (!Object.keys(changes).length || Object.values(changes).every(value => value === undefined)) invalid('Mutation must contain a change.')
    if (changes.snoozedUntil !== undefined) throw new UnsupportedOperationError(PROVIDER_ID, 'native snooze; use SDK local workflows')
    for (const key of ['isRead', 'isStarred', 'isArchived', 'deletePermanently'] as const) if (changes[key] !== undefined && typeof changes[key] !== 'boolean') invalid('Mutation flags must be boolean.')
    if (changes.deletePermanently && Object.keys(changes).some(key => key !== 'deletePermanently' && changes[key as keyof MessageMutation] !== undefined)) invalid('Permanent deletion cannot be combined with other changes.')
    const folder = changes.folder === undefined ? undefined : this.folder(scope, changes.folder, true)
    if (folder && changes.isArchived !== undefined && folder !== (changes.isArchived ? 'archive' : 'inbox')) invalid('Conflicting archive and folder mutations.')
    const added = this.labels(scope, changes.addLabels); const removed = this.labels(scope, changes.removeLabels)
    if (added.some(label => removed.includes(label))) invalid('A label cannot be both added and removed.')
    return this.db.transaction(() => {
      const existing = this.db.query<CurrentRow, [string, string, string]>('SELECT id,data FROM mock_messages WHERE owner=? AND store_id=? AND id=?').get(scope.owner, scope.storeId, id)
      if (!existing) throw new ProviderNotFoundError(PROVIDER_ID, 'The mock message does not exist.')
      if (changes.deletePermanently) {
        if (existing.data !== null) {
          this.db.query('DELETE FROM mock_attachments WHERE owner=? AND store_id=? AND message_id=?').run(scope.owner, scope.storeId, id)
          this.append(scope, id, null)
        }
        return null
      }
      if (!existing.data) throw new ProviderNotFoundError(PROVIDER_ID, 'The mock message was permanently deleted.')
      const message: StoredMessage = JSON.parse(existing.data)
      if (typeof changes.isRead === 'boolean') message.isRead = changes.isRead
      if (typeof changes.isStarred === 'boolean') message.isStarred = changes.isStarred
      if (folder) message.folder = folder
      if (changes.isArchived !== undefined) message.folder = changes.isArchived ? 'archive' : 'inbox'
      message.labels = [...new Set([...message.labels, ...added])].filter(label => !removed.includes(label))
      message.folderIds = [message.folder, ...message.labels]
      if (JSON.stringify(message) !== existing.data) this.append(scope, id, message)
      return this.project(scope, message)
    }).immediate()
  }

  signCursor(value: unknown): string {
    this.open()
    const encoded = Buffer.from(stableJson(value)).toString('base64url')
    return `${encoded}.${createHmac('sha256', this.cursorKey).update(encoded).digest('base64url')}`
  }

  readCursor(value: string): unknown {
    this.open()
    try {
      if (typeof value !== 'string' || value.length > 4096) throw new Error()
      const parts = value.split('.')
      if (parts.length !== 2) throw new Error()
      const [encoded, signature] = parts as [string, string]
      const bytes = Buffer.from(encoded, 'base64url'); const actual = Buffer.from(signature, 'base64url')
      if (bytes.toString('base64url') !== encoded || actual.toString('base64url') !== signature || actual.length !== 32) throw new Error()
      const expected = createHmac('sha256', this.cursorKey).update(encoded).digest()
      if (!timingSafeEqual(expected, actual)) throw new Error()
      return JSON.parse(bytes.toString('utf8'))
    } catch { throw new ProviderCursorExpiredError(PROVIDER_ID, 'Invalid or foreign mock cursor.', { status: 400 }) }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }
}
