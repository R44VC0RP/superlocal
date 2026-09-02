import { ImapFlow, type FetchMessageObject, type ImapFlowOptions, type MessageAddressObject, type MessageStructureObject, type SearchObject } from 'imapflow'
import nodemailer from 'nodemailer'
import type SMTPTransport from 'nodemailer/lib/smtp-transport'
import {
  attachmentContent,
  attachmentUrl,
  buildThreads,
  clampLimit,
  createMailAccount,
  formatParticipant,
  htmlToPlainText,
  normalizeCursor,
  normalizeDate,
  parseParticipants,
  previewText,
  ProviderAuthenticationError,
  ProviderAuthorizationError,
  ProviderCursorExpiredError,
  ProviderError,
  ProviderNotFoundError,
  requireThread,
  UnsupportedOperationError,
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

export interface ImapServerCredentials {
  host: string
  port?: number
  secure?: boolean
  user?: string
  username?: string
  password?: string
  accessToken?: string
  tls?: ImapFlowOptions['tls']
}

export interface SmtpServerCredentials {
  host: string
  port?: number
  secure?: boolean
  user?: string
  username?: string
  password?: string
  accessToken?: string
  tls?: SMTPTransport.Options['tls']
}

export interface ImapCredentials extends ProviderCredentials {
  host?: string
  port?: number
  secure?: boolean
  user?: string
  username?: string
  password?: string
  accessToken?: string
  imapHost?: string
  imapPort?: number
  smtpHost?: string
  smtpPort?: number
  imap?: ImapServerCredentials
  smtp?: SmtpServerCredentials
  mailboxes?: Partial<Record<MailFolder, string>>
}

export interface ImapProviderDependencies {
  createClient?: (options: ImapFlowOptions) => ImapFlow
  createTransport?: (options: SMTPTransport.Options) => {
    sendMail(message: SMTPTransport.MailOptions): Promise<SMTPTransport.SentMessageInfo>
    close(): void
  }
}

const FETCH_QUERY = {
  uid: true,
  flags: true,
  envelope: true,
  internalDate: true,
  bodyStructure: true,
  threadId: true,
  size: true,
} as const

function mailboxFolder(path: string, specialUse?: string): MailFolder | null {
  const special = specialUse?.toLowerCase()
  if (special === '\\inbox' || path.toLowerCase() === 'inbox') return 'inbox'
  if (special === '\\sent') return 'sent'
  if (special === '\\drafts') return 'drafts'
  if (special === '\\archive' || special === '\\all') return 'archive'
  if (special === '\\trash') return 'trash'
  if (special === '\\junk') return 'spam'
  if (special === '\\flagged') return 'starred'

  const name = path.split(/[/.]/).at(-1)?.toLowerCase().replace(/[\s_-]/g, '') ?? ''
  if (name === 'sent' || name === 'sentitems' || name === 'sentmail') return 'sent'
  if (name === 'drafts') return 'drafts'
  if (name === 'archive' || name === 'allmail') return 'archive'
  if (name === 'trash' || name === 'deleteditems' || name === 'deletedmessages') return 'trash'
  if (name === 'spam' || name === 'junk' || name === 'junkemail') return 'spam'
  return null
}

function messageId(mailbox: string, uidValidity: string, uid: number): string {
  return `${encodeURIComponent(mailbox)}:${uidValidity}:${uid}`
}

function parseMessageId(value: string): { mailbox: string; uidValidity: string; uid: number } {
  const match = value.match(/^([^:]+):([^:]+):(\d+)$/)
  if (!match) throw new ProviderError('imap', 'VALIDATION', `Invalid IMAP message identifier: ${value}`)
  const uid = Number(match[3])
  if (!Number.isSafeInteger(uid) || uid < 1) {
    throw new ProviderError('imap', 'VALIDATION', `Invalid IMAP message UID: ${match[3]}`)
  }
  try {
    return { mailbox: decodeURIComponent(match[1]!), uidValidity: match[2]!, uid }
  } catch (error) {
    throw new ProviderError('imap', 'VALIDATION', 'Invalid IMAP mailbox identifier', { cause: error })
  }
}

function participants(values: MessageAddressObject[] | undefined): Participant[] {
  return (values ?? [])
    .filter((value) => value.address)
    .map((value) => ({ name: value.name ?? value.address!, email: value.address! }))
}

function flattenParts(part: MessageStructureObject | undefined, excludeAttachedChildren = false): MessageStructureObject[] {
  if (!part) return []
  if (excludeAttachedChildren && isAttachment(part)) return [part]
  return [part, ...(part.childNodes ?? []).flatMap((child) => flattenParts(child, excludeAttachedChildren))]
}

function partFilename(part: MessageStructureObject): string | undefined {
  return part.dispositionParameters?.filename ?? part.parameters?.name
}

function isAttachment(part: MessageStructureObject): boolean {
  const disposition = part.disposition?.toLowerCase()
  return Boolean(
    partFilename(part) || disposition === 'attachment' ||
    (disposition === 'inline' || part.id) && !part.type.toLowerCase().startsWith('text/'),
  )
}

async function streamBuffer(stream: AsyncIterable<unknown>): Promise<Buffer> {
  const chunks: Buffer[] = []
  try {
    for await (const chunk of stream) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array))
    }
  } catch (cause) {
    throw new ProviderError('imap', 'NETWORK', 'IMAP response body was interrupted', { retryable: true, cause })
  }
  return Buffer.concat(chunks)
}

export class ImapProvider implements InboxProvider {
  readonly type = 'imap' as const
  readonly accountId: string
  readonly capabilities: Readonly<ProviderCapabilities>
  private readonly credentials: ImapCredentials
  private readonly imap: ImapServerCredentials
  private readonly smtp?: SmtpServerCredentials
  private readonly dependencies: ImapProviderDependencies
  private readonly folders = new Map<MailFolder, string>()
  private readonly expunged = new Map<string, Set<number>>()
  private client?: ImapFlow
  private connecting?: Promise<ImapFlow>
  private connectionGeneration = 0

  constructor(credentials: ImapCredentials, dependencies: ImapProviderDependencies = {}) {
    const imap = credentials.imap ?? {
      host: credentials.imapHost ?? credentials.host ?? '',
      port: credentials.imapPort ?? credentials.port,
      secure: credentials.secure,
      user: credentials.user ?? credentials.username,
      password: credentials.password,
      accessToken: credentials.accessToken,
    }
    const user = imap.user ?? imap.username ?? credentials.user ?? credentials.username ?? credentials.email
    if (!credentials.accountId || !imap.host || !user || !(imap.password ?? credentials.password ?? imap.accessToken ?? credentials.accessToken)) {
      throw new ProviderError('imap', 'VALIDATION', 'IMAP requires an account ID, host, username, and password or OAuth token')
    }

    this.credentials = credentials
    this.dependencies = dependencies
    this.accountId = credentials.accountId
    this.imap = { ...imap, user }
    this.smtp = credentials.smtp ?? (credentials.smtpHost ? {
      host: credentials.smtpHost,
      port: credentials.smtpPort,
      user,
      password: credentials.password,
      accessToken: credentials.accessToken,
    } : undefined)
    if (credentials.timeoutMs !== undefined && (!Number.isSafeInteger(credentials.timeoutMs) || credentials.timeoutMs < 1)) {
      throw new ProviderError('imap', 'VALIDATION', 'The IMAP connection timeout must be a positive integer')
    }
    for (const [protocol, server] of [['IMAP', this.imap], ['SMTP', this.smtp]] as const) {
      if (!server) continue
      if (server.port !== undefined && (!Number.isSafeInteger(server.port) || server.port < 1 || server.port > 65_535)) {
        throw new ProviderError('imap', 'VALIDATION', `${protocol} requires a valid server port`)
      }
      if (server.tls?.rejectUnauthorized === false && (
        process.env.NODE_ENV === 'production' || process.env.OPENMAIL_IMAP_ALLOW_INSECURE_TLS !== 'true'
      )) {
        throw new ProviderError('imap', 'VALIDATION', `${protocol} certificate verification cannot be disabled`)
      }
      if (process.env.NODE_ENV === 'production' && ['TLSv1', 'TLSv1.1'].includes(server.tls?.minVersion ?? '')) {
        throw new ProviderError('imap', 'VALIDATION', `${protocol} requires TLS 1.2 or newer in production`)
      }
    }
    this.folders.set('inbox', credentials.mailboxes?.inbox ?? 'INBOX')
    for (const [folder, path] of Object.entries(credentials.mailboxes ?? {})) {
      if (path) this.folders.set(folder as MailFolder, path)
    }

    const canSend = Boolean(this.smtp?.host)
    this.capabilities = Object.freeze({
      sync: true,
      incrementalSync: true,
      deltaSync: false,
      send: canSend,
      reply: canSend,
      threads: true,
      nativeThreads: false,
      folders: true,
      createFolders: true,
      labels: false,
      archive: true,
      trash: true,
      permanentDelete: true,
      markRead: true,
      markUnread: true,
      star: true,
      attachments: true,
      attachmentDownload: true,
      search: true,
      drafts: false,
      scheduledSend: false,
      snooze: false,
      readReceipts: false,
      pushNotifications: false,
    })
  }

  private async connection(): Promise<ImapFlow> {
    if (this.client?.usable) return this.client
    if (this.connecting) return this.connecting

    const auth: NonNullable<ImapFlowOptions['auth']> = { user: this.imap.user! }
    const accessToken = this.imap.accessToken ?? this.credentials.accessToken
    if (accessToken) auth.accessToken = accessToken
    else auth.pass = this.imap.password ?? this.credentials.password

    const secure = this.imap.secure ?? this.imap.port !== 143
    const timeout = this.credentials.timeoutMs ?? 30_000
    const client = (this.dependencies.createClient ?? ((options) => new ImapFlow(options)))({
      host: this.imap.host,
      port: this.imap.port ?? (secure ? 993 : 143),
      secure,
      ...(secure ? {} : { doSTARTTLS: true }),
      auth,
      tls: {
        minVersion: 'TLSv1.2',
        ...this.imap.tls,
        rejectUnauthorized: this.imap.tls?.rejectUnauthorized ?? true,
      },
      logger: false,
      qresync: true,
      connectionTimeout: timeout,
      greetingTimeout: timeout,
      socketTimeout: timeout,
    })
    client.on('error', () => {
      if (this.client === client) this.client = undefined
    })
    client.on('close', () => {
      if (this.client === client) this.client = undefined
    })
    client.on('expunge', (event) => {
      if (!Number.isSafeInteger(event.uid) || !event.uid || !client.mailbox || client.mailbox.path !== event.path) return
      const key = `${event.path}\0${client.mailbox.uidValidity}`
      const expunged = this.expunged.get(key) ?? new Set<number>()
      expunged.add(event.uid)
      this.expunged.set(key, expunged)
    })

    const generation = this.connectionGeneration
    this.connecting = client.connect()
      .then(() => {
        if (generation !== this.connectionGeneration) {
          client.close()
          throw new ProviderError('imap', 'NETWORK', 'IMAP connection was disconnected', { retryable: true })
        }
        this.client = client
        return client
      })
      .catch((error: unknown) => {
        if (error instanceof ProviderError) throw error
        const failure = error && typeof error === 'object'
          ? error as { authenticationFailed?: boolean; code?: string }
          : undefined
        const details = error instanceof Error ? error.message : String(error)
        if (failure?.authenticationFailed || failure?.code === 'EAUTH' || /auth|login|credentials/i.test(details)) {
          throw new ProviderAuthenticationError('imap', 'IMAP authentication failed', { cause: error })
        }
        const certificateFailure = /cert|self.signed|unable.to.verify/i.test(`${failure?.code ?? ''} ${details}`)
        throw new ProviderError('imap', 'NETWORK', 'IMAP connection failed', {
          retryable: !certificateFailure,
          cause: error,
        })
      })
      .finally(() => {
        this.connecting = undefined
      })
    return this.connecting
  }

  private async mailboxPath(folder: MailFolder): Promise<string> {
    if (folder === 'starred') return this.folders.get('inbox')!
    let path = this.folders.get(folder)
    if (!path) {
      const listed = await this.listFolders()
      path = this.folders.get(folder) ?? listed.find((item) => item.id === folder)?.path
    }
    if (!path) throw new UnsupportedOperationError('imap', `the ${folder} mailbox`)
    return path
  }

  private async withMailbox<T>(path: string, callback: (client: ImapFlow, uidValidity: string) => Promise<T>): Promise<T> {
    const client = await this.connection()
    let lock: Awaited<ReturnType<ImapFlow['getMailboxLock']>>
    try {
      lock = await client.getMailboxLock(path, { acquireTimeout: this.credentials.timeoutMs ?? 30_000 })
    } catch (error) {
      const code = error && typeof error === 'object' ? (error as { code?: string }).code : undefined
      const networkFailure = code === 'LockTimeout' || code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'EPIPE' ||
        (error instanceof Error && error.name === 'AbortError')
      if (networkFailure && this.client === client && !client.usable) this.client = undefined
      throw new ProviderError('imap', networkFailure ? 'NETWORK' : 'UPSTREAM', 'Unable to open the IMAP mailbox', {
        retryable: networkFailure,
        cause: error,
      })
    }
    try {
      if (!client.mailbox) throw new ProviderError('imap', 'UPSTREAM', `IMAP mailbox ${path} did not open`)
      return await callback(client, String(client.mailbox.uidValidity))
    } catch (cause) {
      if (cause instanceof ProviderError) throw cause
      const failure = cause as { code?: string; name?: string }
      const network = failure?.name === 'AbortError' || ['ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'NoConnection', 'ConnectionClosed'].includes(failure?.code ?? '')
      throw new ProviderError('imap', network ? 'NETWORK' : 'UPSTREAM', 'IMAP operation failed', { retryable: network, cause })
    } finally {
      lock.release()
    }
  }

  private async body(client: ImapFlow, uid: number, part: MessageStructureObject | undefined): Promise<string> {
    if (!part) return ''
    const result = await client.download(String(uid), part.part ?? '1', { uid: true })
    const content = await streamBuffer(result.content)
    const charset = result.meta.charset ?? part.parameters?.charset ?? 'utf-8'
    try {
      return new TextDecoder(charset).decode(content)
    } catch {
      return content.toString('utf8')
    }
  }

  private async normalize(
    client: ImapFlow,
    message: FetchMessageObject,
    mailbox: string,
    uidValidity: string,
    folderHint?: MailFolder,
  ): Promise<MailMessage> {
    const id = messageId(mailbox, uidValidity, message.uid)
    const parts = flattenParts(message.bodyStructure)
    const bodyParts = flattenParts(message.bodyStructure, true)
    const textPart = bodyParts.find((part) => part.type.toLowerCase() === 'text/plain' && !isAttachment(part))
    const htmlPart = bodyParts.find((part) => part.type.toLowerCase() === 'text/html' && !isAttachment(part))
    const bodyHtml = await this.body(client, message.uid, htmlPart)
    const bodyText = await this.body(client, message.uid, textPart) || htmlToPlainText(bodyHtml)
    const attachments = parts
      .filter((part) => isAttachment(part) && part.part)
      .map((part): Attachment => {
        const partId = part.part!
        const contentId = part.id?.replace(/^<|>$/g, '')
        return {
          id: partId,
          filename: partFilename(part) ?? 'attachment',
          contentType: part.type,
          size: Number.isSafeInteger(part.size) && part.size! >= 0 ? part.size! : 0,
          url: attachmentUrl(this.accountId, id, partId),
          ...(part.disposition?.toLowerCase() === 'inline' || contentId ? { inline: true } : {}),
          ...(contentId ? { contentId } : {}),
        }
      })
    const envelope = message.envelope
    const from = participants(envelope?.from)[0] ?? { name: '', email: '' }
    return {
      id,
      threadId: message.threadId ?? envelope?.inReplyTo ?? envelope?.messageId ?? id,
      accountId: this.accountId,
      from,
      to: participants(envelope?.to),
      cc: participants(envelope?.cc),
      bcc: participants(envelope?.bcc),
      replyTo: participants(envelope?.replyTo),
      ...(envelope?.messageId ? { rfcMessageId: envelope.messageId } : {}),
      ...(envelope?.inReplyTo ? { inReplyTo: envelope.inReplyTo } : {}),
      subject: envelope?.subject ?? '',
      preview: previewText(bodyText || bodyHtml),
      bodyText,
      bodyHtml,
      receivedAt: normalizeDate(message.internalDate ?? envelope?.date),
      isRead: message.flags?.has('\\Seen') ?? false,
      isStarred: message.flags?.has('\\Flagged') ?? false,
      folder: folderHint ?? mailboxFolder(mailbox) ?? 'inbox',
      folderIds: [mailbox],
      labels: [],
      attachments,
    }
  }

  private async fetchMessages(
    client: ImapFlow,
    uids: number[],
    mailbox: string,
    uidValidity: string,
    folder?: MailFolder,
  ): Promise<MailMessage[]> {
    if (!uids.length) return []
    const fetched = await client.fetchAll(uids, FETCH_QUERY, { uid: true })
    const messages: MailMessage[] = []
    for (const message of fetched) {
      messages.push(await this.normalize(client, message, mailbox, uidValidity, folder))
    }
    return messages.sort((left, right) => right.receivedAt.localeCompare(left.receivedAt))
  }

  async getAccount(): Promise<MailAccount> {
    const client = await this.connection()
    const inbox = await client.status(this.folders.get('inbox')!, { unseen: true })
    const email = this.credentials.email ?? this.imap.user!
    return createMailAccount('imap', this.credentials, { email, unreadCount: inbox.unseen ?? 0 })
  }

  async listFolders(): Promise<ProviderFolder[]> {
    const client = await this.connection()
    const mailboxes = await client.list({ statusQuery: { unseen: true, messages: true } })
    const folders: ProviderFolder[] = []
    for (const mailbox of mailboxes) {
      const classified = mailboxFolder(mailbox.path, mailbox.specialUse)
      const folder = classified ?? 'inbox'
      if (classified && (!this.folders.has(folder) || mailbox.specialUse)) this.folders.set(folder, mailbox.path)
      folders.push({
        id: mailbox.path,
        name: mailbox.name,
        path: mailbox.path,
        folder,
        kind: 'folder',
        ...(classified ? {} : { custom: true }),
        unreadCount: mailbox.status?.unseen ?? 0,
        totalCount: mailbox.status?.messages ?? 0,
      })
    }
    if (!folders.some((folder) => folder.folder === 'starred')) {
      folders.push({ id: 'flagged', name: 'Flagged', folder: 'starred' })
    }
    return folders
  }

  async createFolder(name: string): Promise<ProviderFolder> {
    const client = await this.connection()
    try {
      const mailbox = await client.mailboxCreate(name)
      if (!mailbox.created) {
        throw new ProviderError('imap', 'VALIDATION', 'An IMAP mailbox with that name already exists', { status: 409 })
      }
      return { id: mailbox.path, name, folder: 'inbox', kind: 'folder', path: mailbox.path, custom: true }
    } catch (error) {
      if (error instanceof ProviderError) throw error
      throw new ProviderError('imap', 'UPSTREAM', 'Unable to create the IMAP mailbox', { cause: error })
    }
  }

  async listMessages(options: ListOptions = {}): Promise<ProviderListResult<MailMessage>> {
    const folder = options.folder ?? 'inbox'
    const path = await this.mailboxPath(folder)
    return this.withMailbox(path, async (client, uidValidity) => {
      let before = Number.POSITIVE_INFINITY
      if (options.cursor) {
        if (/^\d+$/.test(options.cursor)) {
          before = Number(options.cursor)
        } else {
          try {
            if (options.cursor.length > 2_048 || !/^[\w-]+$/.test(options.cursor)) throw new Error('Malformed cursor')
            const scope = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8')) as unknown
            if (!Array.isArray(scope) || scope.length !== 7 || scope[0] !== this.accountId ||
              scope[1] !== path || scope[2] !== uidValidity || scope[3] !== folder ||
              scope[4] !== (options.search ?? '') || scope[5] !== Boolean(options.unreadOnly)) {
              throw new Error('Cursor scope changed')
            }
            before = scope[6] as number
          } catch {
            throw new ProviderCursorExpiredError('imap', 'Invalid or expired IMAP pagination cursor')
          }
        }
        if (!Number.isSafeInteger(before) || before < 1) {
          throw new ProviderCursorExpiredError('imap', 'Invalid IMAP pagination cursor')
        }
      }
      const query: SearchObject = { all: true }
      if (options.unreadOnly) query.seen = false
      if (folder === 'starred') query.flagged = true
      if (options.search) query.text = options.search
      const result = await client.search(query, { uid: true })
      const matching = (result || []).sort((left, right) => right - left)
      const available = matching.filter((uid) => uid < before)
      const limit = clampLimit(options.limit)
      const selected = available.slice(0, limit)
      const items = await this.fetchMessages(client, selected, path, uidValidity, folder)
      return {
        items,
        nextCursor: available.length > limit ? Buffer.from(JSON.stringify([
          this.accountId,
          path,
          uidValidity,
          folder,
          options.search ?? '',
          Boolean(options.unreadOnly),
          selected[selected.length - 1]!,
        ])).toString('base64url') : null,
        hasMore: available.length > limit,
        total: matching.length,
      }
    })
  }

  async listThreads(options: ListOptions = {}): Promise<ProviderListResult<MailThread>> {
    const messages = await this.listMessages(options)
    return {
      items: buildThreads(messages.items),
      nextCursor: messages.nextCursor,
      hasMore: messages.hasMore,
      ...(messages.total === undefined ? {} : { total: messages.total }),
    }
  }

  async getMessage(id: string): Promise<MailMessage> {
    const parsed = parseMessageId(id)
    return this.withMailbox(parsed.mailbox, async (client, uidValidity) => {
      if (uidValidity !== parsed.uidValidity) {
        throw new ProviderCursorExpiredError('imap', `UIDVALIDITY changed for mailbox ${parsed.mailbox}`)
      }
      const message = await client.fetchOne(String(parsed.uid), FETCH_QUERY, { uid: true })
      if (!message) throw new ProviderNotFoundError('imap', `Message ${id} was not found`)
      return this.normalize(client, message, parsed.mailbox, uidValidity)
    })
  }

  async getThread(threadId: string): Promise<MailThread> {
    if (/^[^:]+:[^:]+:\d+$/.test(threadId)) return requireThread('imap', [await this.getMessage(threadId)], threadId)
    const folders = await this.listFolders()
    const paths = [...new Set(folders.map((folder) => folder.path).filter((path): path is string => Boolean(path)))]
    const messages: MailMessage[] = []
    for (const path of paths) {
      const found = await this.withMailbox(path, async (client, uidValidity) => {
        const query: SearchObject = {
          or: [
            { header: { 'Message-ID': threadId } },
            { header: { 'In-Reply-To': threadId } },
            { header: { References: threadId } },
          ],
        }
        const matches = await client.search(query, { uid: true })
        return this.fetchMessages(client, matches || [], path, uidValidity)
      })
      messages.push(...found)
    }
    return requireThread('imap', messages.map((message) => ({ ...message, threadId })), threadId)
  }

  async sync(cursor?: SyncCursor | string | null, options: SyncOptions = {}): Promise<SyncResult> {
    const current = normalizeCursor('imap', cursor, 'uid')
    if (current && (current.kind !== 'uid' && current.kind !== 'page' ||
      !/^\d+$/.test(current.value) || !Number.isSafeInteger(Number(current.value)))) {
      throw new ProviderCursorExpiredError('imap', 'Invalid IMAP sync cursor')
    }
    if (current?.metadata?.accountId && current.metadata.accountId !== this.accountId) {
      throw new ProviderCursorExpiredError('imap', 'IMAP sync cursors are scoped to one account')
    }
    const folder = options.folder ?? current?.folder ?? 'inbox'
    if (current?.folder && current.folder !== folder) {
      throw new ProviderCursorExpiredError('imap', 'IMAP sync cursors are scoped to one mailbox')
    }
    const path = await this.mailboxPath(folder)
    return this.withMailbox(path, async (client, uidValidity) => {
      const mailbox = client.mailbox
      if (!mailbox) throw new ProviderError('imap', 'UPSTREAM', 'IMAP mailbox is no longer selected')
      const valid = current?.metadata?.uidValidity === uidValidity
      const continuingPage = current?.kind === 'page' && valid
      const fullSync = !current || !valid || continuingPage
      const highestModseq = mailbox.highestModseq?.toString()
      const limit = clampLimit(options.limit)
      let selected: number[] = []
      let hasMore = false
      let watermark = Number(current?.value ?? 0)

      if (mailbox.exists > 0 && fullSync) {
        const found = await client.search({ all: true }, { uid: true })
        const all = (found || []).sort((left, right) => right - left)
        const before = continuingPage ? Number(current.metadata?.beforeUid ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY
        if (continuingPage && (!Number.isSafeInteger(before) || before < 1)) {
          throw new ProviderCursorExpiredError('imap', 'Invalid IMAP sync pagination cursor')
        }
        const available = all.filter((uid) => uid < before)
        selected = available.slice(0, limit)
        hasMore = available.length > limit
        watermark = continuingPage ? watermark : all[0] ?? 0
      } else if (mailbox.exists > 0 && current) {
        const previousModseq = current.metadata?.highestModseq
        if (previousModseq && highestModseq) {
          if (!/^\d+$/.test(previousModseq)) {
            throw new ProviderCursorExpiredError('imap', 'Invalid IMAP modification sequence')
          }
          const changed = await client.fetchAll('1:*', { uid: true }, {
            uid: true,
            changedSince: BigInt(previousModseq),
          })
          selected = changed.map((message) => message.uid)
        } else {
          const found = await client.search({ uid: `${watermark + 1}:*` }, { uid: true })
          selected = (found || []).filter((uid) => uid > watermark)
        }
        if (selected.length) watermark = Math.max(watermark, ...selected)
      }

      const messages = await this.fetchMessages(client, selected, path, uidValidity, folder)
      const expungeKey = `${path}\0${uidValidity}`
      const deletedMessageIds = valid
        ? [...(this.expunged.get(expungeKey) ?? [])].map((uid) => messageId(path, uidValidity, uid))
        : []
      this.expunged.delete(expungeKey)
      const metadata: Record<string, string> = {
        accountId: this.accountId,
        uidValidity,
        ...(continuingPage && current.metadata?.highestModseq
          ? { highestModseq: current.metadata.highestModseq }
          : highestModseq ? { highestModseq } : {}),
        ...(hasMore && selected.length ? { beforeUid: String(Math.min(...selected)) } : {}),
      }
      return {
        messages,
        threads: buildThreads(messages),
        deletedMessageIds: [],
        removedMessageIds: deletedMessageIds,
        cursor: {
          provider: 'imap',
          kind: hasMore ? 'page' : 'uid',
          value: String(watermark),
          folder,
          metadata,
        },
        hasMore,
        fullSync,
        snapshotComplete: fullSync && !hasMore,
        recentCursor: {
          provider: 'imap', kind: 'uid', value: String(watermark), folder,
          metadata: {
            accountId: this.accountId, uidValidity,
            ...(metadata.highestModseq ? { highestModseq: metadata.highestModseq } : {}),
          },
        },
      }
    })
  }

  async send(input: SendInput): Promise<SendResult> {
    if (input.accountId !== undefined && input.accountId !== this.accountId) {
      throw new ProviderAuthorizationError('imap', 'The message belongs to a different account')
    }
    if (!this.smtp?.host) throw new UnsupportedOperationError('imap', 'sending without an SMTP configuration')
    if (input.scheduledAt) throw new UnsupportedOperationError('imap', 'scheduled sending')
    const from = input.from ?? this.credentials.email ?? this.imap.user
    if (!from) throw new ProviderError('imap', 'VALIDATION', 'A sender email address is required')

    const user = this.smtp.user ?? this.smtp.username ?? this.imap.user!
    const token = this.smtp.accessToken ?? this.credentials.accessToken ?? this.imap.accessToken
    const secure = this.smtp.secure ?? this.smtp.port === 465
    const timeout = this.credentials.timeoutMs ?? 30_000
    const options: SMTPTransport.Options = {
      host: this.smtp.host,
      port: this.smtp.port ?? (secure ? 465 : 587),
      secure,
      requireTLS: !secure,
      opportunisticTLS: false,
      auth: token
        ? { type: 'OAuth2', user, accessToken: token }
        : { user, pass: this.smtp.password ?? this.credentials.password ?? this.imap.password },
      tls: {
        minVersion: 'TLSv1.2',
        ...this.smtp.tls,
        rejectUnauthorized: this.smtp.tls?.rejectUnauthorized ?? true,
      },
      logger: false,
      debug: false,
      connectionTimeout: timeout,
      greetingTimeout: timeout,
      socketTimeout: timeout,
    }
    const transport = this.dependencies.createTransport?.(options) ?? nodemailer.createTransport(options)
    try {
      const result = await transport.sendMail({
        from: formatParticipant(from),
        to: parseParticipants(input.to).map(formatParticipant),
        cc: parseParticipants(input.cc).map(formatParticipant),
        bcc: parseParticipants(input.bcc).map(formatParticipant),
        subject: input.subject,
        text: input.bodyText ?? input.text ?? input.body,
        html: input.bodyHtml ?? input.html,
        inReplyTo: input.inReplyTo,
        references: input.references,
        headers: input.headers,
        attachments: input.attachments?.map((attachment) => ({
          filename: attachment.filename,
          content: attachmentContent(attachment),
          contentType: attachment.contentType,
          cid: attachment.contentId,
          contentDisposition: attachment.inline ? 'inline' : 'attachment',
        })),
      })
      return {
        id: result.messageId,
        messageId: result.messageId,
        ...(input.threadId ? { threadId: input.threadId } : {}),
        accepted: result.accepted.map(String),
        rejected: result.rejected.map(String),
      }
    } catch (error) {
      const code = error && typeof error === 'object' ? (error as { code?: string }).code : undefined
      if (code === 'EAUTH') {
        throw new ProviderAuthenticationError('imap', 'SMTP authentication failed', { cause: error })
      }
      const details = error instanceof Error ? error.message : ''
      const certificateFailure = /cert|self.signed|unable.to.verify/i.test(`${code ?? ''} ${details}`)
      const networkFailure = !certificateFailure &&
        (code === 'ETIMEDOUT' || code === 'ESOCKET' || code === 'ECONNECTION')
      throw new ProviderError('imap', networkFailure ? 'NETWORK' : 'UPSTREAM', 'SMTP message delivery failed', {
        retryable: networkFailure,
        cause: error,
      })
    } finally {
      transport.close()
    }
  }

  async mutate(id: string, mutation: MessageMutation): Promise<MailMessage | null> {
    if (mutation.snoozedUntil !== undefined) throw new UnsupportedOperationError('imap', 'snoozing')
    if (mutation.addLabels?.length || mutation.removeLabels?.length) throw new UnsupportedOperationError('imap', 'labels')

    const parsed = parseMessageId(id)
    const destinationFolder = mutation.folder ?? (mutation.isArchived === undefined ? undefined : mutation.isArchived ? 'archive' : 'inbox')
    const destination = destinationFolder && destinationFolder !== 'starred' ? await this.mailboxPath(destinationFolder) : undefined
    let movedUid: number | undefined
    let movedUidValidity: string | undefined
    let internetMessageId: string | undefined

    const updated = await this.withMailbox(parsed.mailbox, async (client, uidValidity) => {
      if (uidValidity !== parsed.uidValidity) {
        throw new ProviderCursorExpiredError('imap', `UIDVALIDITY changed for mailbox ${parsed.mailbox}`)
      }
      const range = String(parsed.uid)
      if (mutation.deletePermanently) {
        await client.messageDelete(range, { uid: true })
        return null
      }
      if (mutation.isRead !== undefined) {
        await (mutation.isRead ? client.messageFlagsAdd(range, ['\\Seen'], { uid: true }) : client.messageFlagsRemove(range, ['\\Seen'], { uid: true }))
      }
      if (mutation.isStarred !== undefined || destinationFolder === 'starred') {
        const flagged = destinationFolder === 'starred' || mutation.isStarred === true
        await (flagged ? client.messageFlagsAdd(range, ['\\Flagged'], { uid: true }) : client.messageFlagsRemove(range, ['\\Flagged'], { uid: true }))
      }

      if (destination && destination !== parsed.mailbox) {
        const original = await client.fetchOne(range, { uid: true, envelope: true }, { uid: true })
        if (!original) throw new ProviderNotFoundError('imap', `Message ${id} was not found`)
        internetMessageId = original.envelope?.messageId
        const result = await client.messageMove(range, destination, { uid: true })
        if (!result) throw new ProviderError('imap', 'UPSTREAM', `Unable to move message to ${destination}`)
        movedUid = result.uidMap?.get(parsed.uid)
        movedUidValidity = result.uidValidity?.toString()
        return null
      }

      const message = await client.fetchOne(range, FETCH_QUERY, { uid: true })
      if (!message) throw new ProviderNotFoundError('imap', `Message ${id} was not found`)
      return this.normalize(client, message, parsed.mailbox, uidValidity)
    })

    if (mutation.deletePermanently || !destination || destination === parsed.mailbox) return updated
    return this.withMailbox(destination, async (client, uidValidity) => {
      if (movedUidValidity && movedUidValidity !== uidValidity) {
        throw new ProviderCursorExpiredError('imap', `UIDVALIDITY changed for mailbox ${destination}`)
      }
      let uid = movedUid
      if (!uid && internetMessageId) {
        const matches = await client.search({ header: { 'Message-ID': internetMessageId } }, { uid: true })
        uid = matches && matches.length ? Math.max(...matches) : undefined
      }
      if (!uid) {
        throw new ProviderError('imap', 'UPSTREAM', 'IMAP server did not provide a destination UID after moving the message')
      }
      const message = await client.fetchOne(String(uid), FETCH_QUERY, { uid: true })
      if (!message) throw new ProviderNotFoundError('imap', `Moved message was not found in ${destination}`)
      return this.normalize(client, message, destination, uidValidity, destinationFolder)
    })
  }

  async getAttachment(id: string, attachmentId: string): Promise<AttachmentData> {
    const parsed = parseMessageId(id)
    return this.withMailbox(parsed.mailbox, async (client, uidValidity) => {
      if (uidValidity !== parsed.uidValidity) {
        throw new ProviderCursorExpiredError('imap', `UIDVALIDITY changed for mailbox ${parsed.mailbox}`)
      }
      const fetched = await client.fetchOne(String(parsed.uid), { uid: true, bodyStructure: true }, { uid: true })
      if (!fetched) throw new ProviderNotFoundError('imap', `Message ${id} was not found`)
      const part = flattenParts(fetched.bodyStructure).find((item) => item.part === attachmentId && isAttachment(item))
      if (!part) throw new ProviderNotFoundError('imap', `Attachment ${attachmentId} was not found`)
      const downloaded = await client.download(String(parsed.uid), attachmentId, { uid: true })
      const content = await streamBuffer(downloaded.content)
      const filename = downloaded.meta.filename ?? partFilename(part) ?? 'attachment'
      const contentType = downloaded.meta.contentType ?? part.type
      const attachment: Attachment = {
        id: attachmentId,
        filename,
        contentType,
        size: content.byteLength,
        url: attachmentUrl(this.accountId, id, attachmentId),
        ...(part.disposition?.toLowerCase() === 'inline' ? { inline: true } : {}),
        ...(part.id ? { contentId: part.id.replace(/^<|>$/g, '') } : {}),
      }
      return { attachment, content, filename, contentType }
    })
  }

  async disconnect(): Promise<void> {
    this.connectionGeneration += 1
    const client = this.client
    const connecting = this.connecting
    this.client = undefined
    if (!client) {
      if (connecting) await connecting.catch(() => undefined)
      return
    }
    try {
      if (client.usable) await client.logout()
      else client.close()
    } catch {
      client.close()
    }
  }
}
