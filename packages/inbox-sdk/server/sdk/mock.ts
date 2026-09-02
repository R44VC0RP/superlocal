import type { SQLQueryBindings } from 'bun:sqlite'
import { resolve, sep } from 'node:path'
import { sqlite } from '../db'
import {
  attachmentContent,
  buildThreads,
  clampLimit,
  parseParticipant,
  parseParticipants,
  previewText,
  ProviderError,
  type Attachment,
  type AttachmentData,
  type InboxProvider,
  type ListOptions,
  type MailAccount,
  type MailFolder,
  type MailMessage,
  type MailThread,
  type MessageMutation,
  type Participant,
  type ProviderCapabilities,
  type ProviderCredentials,
  type ProviderFolder,
  type ProviderListResult,
  type SendInput,
  type SendResult,
  type SyncCursor,
  type SyncOptions,
  type SyncResult,
} from './types'

type Bindings = SQLQueryBindings[]

type StoredAccount = {
  id: string
  user_id: string
  name: string
  email: string
  provider: MailAccount['provider']
  color: string
  sync_status: MailAccount['syncStatus']
  last_sync_at: string | null
  unread_count: number
  signature: string
}

type StoredMessage = {
  id: string
  thread_id: string
  account_id: string
  user_id: string
  from_json: string
  to_json: string
  cc_json: string
  bcc_json: string
  subject: string
  preview: string
  body_text: string
  body_html: string
  received_at: string
  is_read: number
  is_starred: number
  is_important?: number
  folder: MailFolder
  labels_json: string
  attachments_json: string
  snoozed_until: string | null
  scheduled_at: string | null
  read_receipt: number
}

const FOLDERS: MailFolder[] = [
  'inbox',
  'starred',
  'sent',
  'drafts',
  'archive',
  'trash',
  'spam',
  'snoozed',
  'scheduled',
]

const MOCK_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  sync: true,
  incrementalSync: false,
  deltaSync: false,
  send: true,
  reply: true,
  threads: true,
  nativeThreads: true,
  folders: true,
  createFolders: true,
  labels: true,
  archive: true,
  trash: true,
  permanentDelete: true,
  markRead: true,
  markUnread: true,
  star: true,
  attachments: true,
  attachmentDownload: true,
  search: true,
  drafts: true,
  scheduledSend: true,
  snooze: true,
  readReceipts: true,
  pushNotifications: false,
})

const customFolders = new Map<string, ProviderFolder[]>()

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function messageFromRow(row: StoredMessage): MailMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    accountId: row.account_id,
    from: parseJson<Participant>(row.from_json, { name: '', email: '' }),
    to: parseJson<Participant[]>(row.to_json, []),
    cc: parseJson<Participant[]>(row.cc_json, []),
    bcc: parseJson<Participant[]>(row.bcc_json, []),
    subject: row.subject,
    preview: row.preview,
    bodyText: row.body_text,
    bodyHtml: row.body_html,
    receivedAt: row.received_at,
    isRead: Boolean(row.is_read),
    isStarred: Boolean(row.is_starred),
    isImportant: Boolean(row.is_important ?? 1),
    folder: row.folder,
    labels: parseJson<string[]>(row.labels_json, []),
    attachments: parseJson<Attachment[]>(row.attachments_json, []),
    snoozedUntil: row.snoozed_until,
    scheduledAt: row.scheduled_at,
    readReceipt: Boolean(row.read_receipt),
  }
}

function htmlForText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\n', '<br />')
}

export class MockInboxProvider implements InboxProvider {
  readonly type = 'mock' as const
  readonly capabilities = MOCK_CAPABILITIES
  readonly accountId: string
  private readonly userId?: string

  constructor(credentials: ProviderCredentials | MailAccount | string, userId?: string) {
    if (typeof credentials === 'string') {
      this.accountId = credentials
      this.userId = userId
    } else {
      this.accountId = 'accountId' in credentials ? credentials.accountId : credentials.id
      this.userId = userId ?? credentials.userId
    }

    if (!this.accountId) throw new Error('Mock provider requires an account ID')
  }

  private scope(alias = ''): { conditions: string[]; bindings: Bindings } {
    const prefix = alias ? `${alias}.` : ''
    const conditions = [`${prefix}account_id = ?`]
    const bindings: Bindings = [this.accountId]

    if (this.userId) {
      conditions.push(`${prefix}user_id = ?`)
      bindings.push(this.userId)
    }

    return { conditions, bindings }
  }

  private filteredRows(options: ListOptions = {}): StoredMessage[] {
    const { conditions, bindings } = this.scope()

    if (options.folder === 'starred') {
      conditions.push("is_starred = 1 AND folder NOT IN ('trash', 'spam')")
    } else if (options.folder === 'snoozed') {
      conditions.push("(folder = 'snoozed' OR snoozed_until > ?)")
      bindings.push(new Date().toISOString())
    } else if (options.folder === 'scheduled') {
      conditions.push("(folder = 'scheduled' OR scheduled_at IS NOT NULL)")
    } else if (options.folder) {
      conditions.push('folder = ?')
      bindings.push(options.folder)
    }

    if (options.unreadOnly) conditions.push('is_read = 0')

    for (const term of options.search?.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []) {
      const value = term.replace(/^"|"$/g, '')
      const [operator, ...remainder] = value.split(':')
      const operand = remainder.join(':')

      if (operator === 'from' && operand) {
        conditions.push("from_json LIKE ? ESCAPE '\\'")
        bindings.push(`%${operand.replace(/[\\%_]/g, '\\$&')}%`)
      } else if (operator === 'to' && operand) {
        conditions.push("to_json LIKE ? ESCAPE '\\'")
        bindings.push(`%${operand.replace(/[\\%_]/g, '\\$&')}%`)
      } else if (operator === 'subject' && operand) {
        conditions.push("subject LIKE ? ESCAPE '\\'")
        bindings.push(`%${operand.replace(/[\\%_]/g, '\\$&')}%`)
      } else if (operator === 'label' && operand) {
        conditions.push('EXISTS (SELECT 1 FROM json_each(labels_json) WHERE value = ?)')
        bindings.push(operand)
      } else if (operator === 'has' && operand === 'attachment') {
        conditions.push('json_array_length(attachments_json) > 0')
      } else if (operator === 'is' && operand === 'unread') {
        conditions.push('is_read = 0')
      } else if (operator === 'is' && operand === 'read') {
        conditions.push('is_read = 1')
      } else if (operator === 'is' && operand === 'starred') {
        conditions.push('is_starred = 1')
      } else {
        const pattern = `%${value.replace(/[\\%_]/g, '\\$&')}%`
        conditions.push("(subject LIKE ? ESCAPE '\\' OR preview LIKE ? ESCAPE '\\' OR body_text LIKE ? ESCAPE '\\' OR from_json LIKE ? ESCAPE '\\' OR to_json LIKE ? ESCAPE '\\')")
        bindings.push(pattern, pattern, pattern, pattern, pattern)
      }
    }

    return sqlite.query<StoredMessage, Bindings>(`
      SELECT * FROM messages
      WHERE ${conditions.join(' AND ')}
      ORDER BY received_at DESC, id DESC
    `).all(...bindings)
  }

  private page<T>(items: T[], options: ListOptions): ProviderListResult<T> {
    if (options.cursor && !/^\d+$/.test(options.cursor)) {
      throw new Error('Invalid mock provider pagination cursor')
    }

    const offset = options.cursor ? Number(options.cursor) : 0
    const limit = clampLimit(options.limit)
    const nextOffset = offset + limit

    return {
      items: items.slice(offset, nextOffset),
      nextCursor: nextOffset < items.length ? String(nextOffset) : null,
      hasMore: nextOffset < items.length,
      total: items.length,
    }
  }

  private refreshUnreadCount(): void {
    sqlite.query(`
      UPDATE mail_accounts
      SET unread_count = (
        SELECT COUNT(*) FROM messages
        WHERE account_id = ? AND user_id = mail_accounts.user_id
          AND folder = 'inbox' AND is_read = 0
      )
      WHERE id = ?
    `).run(this.accountId, this.accountId)
  }

  private createOutgoing(input: SendInput, folder: 'sent' | 'drafts' | 'scheduled'): MailMessage {
    const account = this.accountRow()
    if (input.accountId && input.accountId !== this.accountId) {
      throw new Error('Cannot send from a different account')
    }

    const to = parseParticipants(input.to)
    if (folder !== 'drafts' && to.length === 0) {
      throw new Error('At least one recipient is required')
    }

    if (input.threadId) {
      const { conditions, bindings } = this.scope()
      conditions.push('thread_id = ?')
      bindings.push(input.threadId)
      const existing = sqlite.query<{ id: string }, Bindings>(`
        SELECT id FROM messages WHERE ${conditions.join(' AND ')} LIMIT 1
      `).get(...bindings)
      if (!existing) throw new Error(`Thread ${input.threadId} was not found`)
    }

    const now = new Date().toISOString()
    const id = crypto.randomUUID()
    const threadId = input.threadId ?? crypto.randomUUID()
    const bodyText = input.bodyText ?? input.text ?? input.body ?? ''
    const bodyHtml = input.bodyHtml ?? input.html ?? htmlForText(bodyText)
    const attachments = (input.attachments ?? []).map((item): Attachment => {
      const content = attachmentContent(item)
      const contentType = item.contentType ?? 'application/octet-stream'
      return {
        id: crypto.randomUUID(),
        filename: item.filename,
        contentType,
        size: content.byteLength,
        url: `data:${contentType};base64,${content.toString('base64')}`,
        ...(item.inline ? { inline: true } : {}),
        ...(item.contentId ? { contentId: item.contentId } : {}),
      }
    })
    const scheduledAt = folder === 'scheduled' ? input.scheduledAt ?? null : null
    if (scheduledAt && Number.isNaN(Date.parse(scheduledAt))) {
      throw new Error('Scheduled send requires a valid date')
    }

    sqlite.query(`
      INSERT INTO messages (
        id, thread_id, account_id, user_id, from_json, to_json, cc_json, bcc_json,
        subject, preview, body_text, body_html, received_at, is_read, is_starred,
        folder, labels_json, attachments_json, snoozed_until, scheduled_at,
        read_receipt, provider_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      threadId,
      this.accountId,
      account.user_id,
      JSON.stringify(input.from ? parseParticipant(input.from) : { name: account.name, email: account.email }),
      JSON.stringify(to),
      JSON.stringify(parseParticipants(input.cc)),
      JSON.stringify(parseParticipants(input.bcc)),
      input.subject,
      previewText(bodyText || bodyHtml, 180),
      bodyText,
      bodyHtml,
      now,
      1,
      0,
      folder,
      JSON.stringify([]),
      JSON.stringify(attachments),
      null,
      scheduledAt,
      Number(Boolean(input.headers?.['Disposition-Notification-To'])),
      `mock-${id}`,
      now,
    )

    const row = sqlite.query<StoredMessage, [string, string]>(`
      SELECT * FROM messages WHERE id = ? AND account_id = ?
    `).get(id, this.accountId)

    if (!row) throw new Error(`Sent message ${id} was not created`)
    return messageFromRow(row)
  }

  private accountRow(): StoredAccount {
    const conditions = ['id = ?']
    const bindings: Bindings = [this.accountId]
    if (this.userId) {
      conditions.push('user_id = ?')
      bindings.push(this.userId)
    }

    const account = sqlite.query<StoredAccount, Bindings>(`
      SELECT * FROM mail_accounts WHERE ${conditions.join(' AND ')}
    `).get(...bindings)
    if (!account) throw new Error(`Mock account ${this.accountId} was not found`)
    return account
  }

  async getAccount(): Promise<MailAccount> {
    const account = this.accountRow()
    return {
      id: account.id,
      userId: account.user_id,
      name: account.name,
      email: account.email,
      provider: 'mock',
      color: account.color,
      syncStatus: account.sync_status,
      lastSyncAt: account.last_sync_at,
      unreadCount: account.unread_count,
      signature: account.signature,
    }
  }

  async listFolders(): Promise<ProviderFolder[]> {
    const account = this.accountRow()
    const folders = FOLDERS.map((folder) => {
      const messages = this.filteredRows({ folder })
      return {
        id: folder,
        name: folder.charAt(0).toUpperCase() + folder.slice(1),
        folder,
        unreadCount: messages.filter((message) => !message.is_read).length,
        totalCount: messages.length,
      }
    })
    const custom = new Map<string, ProviderFolder>()
    for (const message of this.filteredRows()) {
      for (const label of parseJson<string[]>(message.labels_json, [])) {
        if (typeof label === 'string' && label) {
          custom.set(label, { id: label, name: label, folder: 'inbox', path: label, custom: true })
        }
      }
    }
    for (const item of customFolders.get(`${account.user_id}:${account.id}`) ?? []) custom.set(item.id, item)
    return [...folders, ...custom.values()]
  }

  async createFolder(name: string): Promise<ProviderFolder> {
    const account = this.accountRow()
    const existing = await this.listFolders()
    if (existing.some((folder) => folder.name.toLowerCase() === name.toLowerCase())) {
      throw new ProviderError('mock', 'VALIDATION', 'A folder with that name already exists', { status: 409 })
    }
    const folder: ProviderFolder = { id: name, name, folder: 'inbox', path: name, custom: true }
    const key = `${account.user_id}:${account.id}`
    customFolders.set(key, [...(customFolders.get(key) ?? []), folder])
    return folder
  }

  async listMessages(options: ListOptions = {}): Promise<ProviderListResult<MailMessage>> {
    this.accountRow()
    return this.page(this.filteredRows(options).map(messageFromRow), options)
  }

  async listThreads(options: ListOptions = {}): Promise<ProviderListResult<MailThread>> {
    this.accountRow()
    const visibleThreadIds = new Set(this.filteredRows(options).map((message) => message.thread_id))
    const messages = this.filteredRows()
      .filter((message) => visibleThreadIds.has(message.thread_id))
      .map(messageFromRow)
    return this.page(buildThreads(messages), options)
  }

  async getMessage(messageId: string): Promise<MailMessage> {
    const { conditions, bindings } = this.scope()
    conditions.push('id = ?')
    bindings.push(messageId)
    const message = sqlite.query<StoredMessage, Bindings>(`
      SELECT * FROM messages WHERE ${conditions.join(' AND ')}
    `).get(...bindings)
    if (!message) throw new Error(`Message ${messageId} was not found`)
    return messageFromRow(message)
  }

  async getThread(threadId: string): Promise<MailThread> {
    const { conditions, bindings } = this.scope()
    conditions.push('thread_id = ?')
    bindings.push(threadId)
    const messages = sqlite.query<StoredMessage, Bindings>(`
      SELECT * FROM messages
      WHERE ${conditions.join(' AND ')}
      ORDER BY received_at ASC, id ASC
    `).all(...bindings).map(messageFromRow)
    const thread = buildThreads(messages)[0]
    if (!thread) throw new Error(`Thread ${threadId} was not found`)
    return thread
  }

  async sync(_cursor?: SyncCursor | string | null, options: SyncOptions = {}): Promise<SyncResult> {
    this.accountRow()
    const messages: MailMessage[] = []
    let nextCursor: string | null = null

    do {
      const listing: ProviderListResult<MailMessage> = await this.listMessages({
        folder: options.folder,
        limit: options.limit,
        cursor: nextCursor,
      })
      messages.push(...listing.items)
      nextCursor = listing.nextCursor
    } while (nextCursor)

    const syncedAt = new Date().toISOString()
    sqlite.query(`
      UPDATE mail_accounts SET sync_status = 'connected', last_sync_at = ? WHERE id = ?
    `).run(syncedAt, this.accountId)

    return {
      messages,
      threads: buildThreads(messages),
      deletedMessageIds: [],
      cursor: null,
      hasMore: false,
      fullSync: true,
    }
  }

  async send(input: SendInput): Promise<SendResult> {
    const message = this.createOutgoing(input, input.scheduledAt ? 'scheduled' : 'sent')
    return {
      id: message.id,
      threadId: message.threadId,
      messageId: `<${message.id}@mock.openmail.dev>`,
      accepted: message.to.map((recipient) => recipient.email),
      rejected: [],
      ...(message.scheduledAt ? { scheduledAt: message.scheduledAt } : {}),
    }
  }

  async saveDraft(input: Omit<SendInput, 'to'> & { to?: SendInput['to'] }): Promise<MailMessage> {
    return this.createOutgoing({ ...input, to: input.to ?? [] }, 'drafts')
  }

  async schedule(input: SendInput, scheduledAt: string): Promise<SendResult> {
    return this.send({ ...input, scheduledAt })
  }

  async cancelScheduled(messageId: string): Promise<MailMessage> {
    const message = await this.getMessage(messageId)
    if (message.folder !== 'scheduled') throw new Error(`Message ${messageId} is not scheduled`)
    const { conditions, bindings } = this.scope()
    conditions.push('id = ?')
    bindings.push(messageId)
    sqlite.query<unknown, Bindings>(`
      UPDATE messages SET folder = 'drafts', scheduled_at = NULL
      WHERE ${conditions.join(' AND ')}
    `).run(...bindings)
    return this.getMessage(messageId)
  }

  async mutate(messageId: string, mutation: MessageMutation): Promise<MailMessage | null> {
    const message = await this.getMessage(messageId)
    const { conditions, bindings } = this.scope()
    conditions.push('id = ?')
    bindings.push(messageId)
    const where = conditions.join(' AND ')

    if (mutation.deletePermanently) {
      sqlite.query<unknown, Bindings>(`DELETE FROM messages WHERE ${where}`).run(...bindings)
      this.refreshUnreadCount()
      return null
    }

    const assignments: string[] = []
    const values: Bindings = []

    if (mutation.isRead !== undefined) {
      assignments.push('is_read = ?')
      values.push(Number(mutation.isRead))
    }

    if (mutation.isStarred !== undefined || mutation.folder === 'starred') {
      assignments.push('is_starred = ?')
      values.push(Number(mutation.folder === 'starred' || mutation.isStarred))
    }

    let destination = mutation.folder === 'starred' ? undefined : mutation.folder
    if (!destination && mutation.isArchived !== undefined) {
      destination = mutation.isArchived ? 'archive' : 'inbox'
    }
    if (mutation.snoozedUntil) destination = 'snoozed'
    if (mutation.snoozedUntil === null && message.folder === 'snoozed' && !destination) {
      destination = 'inbox'
    }
    if (destination) {
      assignments.push('folder = ?')
      values.push(destination)
    }

    if (mutation.snoozedUntil !== undefined) {
      if (mutation.snoozedUntil && Number.isNaN(Date.parse(mutation.snoozedUntil))) {
        throw new Error('Snoozing requires a valid date')
      }
      assignments.push('snoozed_until = ?')
      values.push(mutation.snoozedUntil)
    } else if (destination && destination !== 'snoozed' && message.snoozedUntil) {
      assignments.push('snoozed_until = NULL')
    }

    if (destination && destination !== 'scheduled' && message.scheduledAt) {
      assignments.push('scheduled_at = NULL')
    }

    if (mutation.addLabels?.length || mutation.removeLabels?.length) {
      const labels = new Set(message.labels)
      for (const label of mutation.addLabels ?? []) labels.add(label)
      for (const label of mutation.removeLabels ?? []) labels.delete(label)
      assignments.push('labels_json = ?')
      values.push(JSON.stringify([...labels]))
    }

    if (assignments.length) {
      sqlite.query<unknown, Bindings>(`
        UPDATE messages SET ${assignments.join(', ')} WHERE ${where}
      `).run(...values, ...bindings)
      this.refreshUnreadCount()
    }

    return this.getMessage(messageId)
  }

  async markRead(messageId: string, isRead = true): Promise<MailMessage | null> {
    return this.mutate(messageId, { isRead })
  }

  async star(messageId: string, isStarred = true): Promise<MailMessage | null> {
    return this.mutate(messageId, { isStarred })
  }

  async archive(messageId: string): Promise<MailMessage | null> {
    return this.mutate(messageId, { isArchived: true })
  }

  async trash(messageId: string): Promise<MailMessage | null> {
    return this.mutate(messageId, { folder: 'trash' })
  }

  async snooze(messageId: string, until: string): Promise<MailMessage | null> {
    return this.mutate(messageId, { snoozedUntil: until })
  }

  async search(query: string, options: ListOptions = {}): Promise<ProviderListResult<MailMessage>> {
    return this.listMessages({ ...options, search: query })
  }

  async getAttachment(messageId: string, attachmentId: string): Promise<AttachmentData> {
    const message = await this.getMessage(messageId)
    const attachment = message.attachments.find((item) => item.id === attachmentId)
    if (!attachment) throw new Error(`Attachment ${attachmentId} was not found`)

    let content: Uint8Array
    if (attachment.url.startsWith('data:')) {
      const encoded = attachment.url.match(/^data:[^,]*;base64,(.*)$/)?.[1]
      if (!encoded) throw new Error(`Attachment ${attachmentId} has an invalid data URL`)
      content = Buffer.from(encoded, 'base64')
    } else {
      const pathname = decodeURIComponent(new URL(attachment.url, 'http://openmail.local').pathname)
      if (!pathname.startsWith('/fixtures/')) {
        throw new Error(`Attachment ${attachmentId} is outside the fixture directory`)
      }
      let fixture: Bun.BunFile | undefined
      for (const directory of ['../../public/fixtures', '../../dist/fixtures']) {
        const fixtureRoot = resolve(import.meta.dir, directory)
        const fixturePath = resolve(fixtureRoot, pathname.slice('/fixtures/'.length))
        if (!fixturePath.startsWith(`${fixtureRoot}${sep}`)) {
          throw new Error(`Attachment ${attachmentId} is outside the fixture directory`)
        }
        const candidate = Bun.file(fixturePath)
        if (await candidate.exists()) {
          fixture = candidate
          break
        }
      }
      if (!fixture) throw new Error(`Attachment ${attachmentId} was not found`)
      content = new Uint8Array(await fixture.arrayBuffer())
    }

    return {
      attachment,
      content,
      filename: attachment.filename,
      contentType: attachment.contentType,
    }
  }

  async disconnect(): Promise<void> {
    this.accountRow()
    sqlite.query("UPDATE mail_accounts SET sync_status = 'idle' WHERE id = ?").run(this.accountId)
  }
}

export default MockInboxProvider
