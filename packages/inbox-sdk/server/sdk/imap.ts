import { ImapFlow, type FetchMessageObject, type ImapFlowOptions, type MessageAddressObject, type MessageStructureObject, type SearchObject } from 'imapflow'
import nodemailer from 'nodemailer'
import MailComposer from 'nodemailer/lib/mail-composer'
import type SMTPTransport from 'nodemailer/lib/smtp-transport'
import { createConnection, type Socket } from 'node:net'
import { createHash, randomUUID } from 'node:crypto'
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
  ProviderMutationError,
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
  type SyncContext,
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
  /** Host-qualified Sent policy. SMTP itself does not guarantee a saved copy. */
  sentCopy?: 'server' | 'append'
}

export interface ImapProviderDependencies {
  createClient?: (options: ImapFlowOptions) => ImapFlow
  createTransport?: (options: SMTPTransport.Options) => {
    sendMail(message: SMTPTransport.MailOptions): Promise<SMTPTransport.SentMessageInfo>
    verify?(): Promise<unknown>
    close(): void
  }
}

const FETCH_QUERY = {
  uid: true,
  flags: true,
  envelope: true,
  internalDate: true,
  bodyStructure: true,
  headers: true,
  size: true,
} as const

const MAX_BODY_BYTES = 8 * 1024 * 1024
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
const MAX_BATCH_BODY_BYTES = 32 * 1024 * 1024
const MAX_HEADERS_BYTES = 128 * 1024
const MAX_THREAD_MESSAGES = 1_000
const MAX_THREAD_SCAN = 10_000
const MAX_UIDS = 1_000_000

function headerMap(buffer: Buffer | undefined): Record<string, string> {
  if (!buffer) return {}
  if (buffer.byteLength > MAX_HEADERS_BYTES) throw new ProviderError('imap', 'UPSTREAM', 'Message headers exceed the supported size limit')
  const headers: Record<string, string> = Object.create(null)
  for (const line of buffer.toString('utf8').replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon < 1) continue
    const key = line.slice(0, colon).toLowerCase()
    if (!/^[a-z0-9-]+$/.test(key)) continue
    const value = line.slice(colon + 1).trim()
    headers[key] = headers[key] ? `${headers[key]} ${value}` : value
  }
  return headers
}

function rfcReferences(headers: Record<string, string>): string[] {
  return [...new Set(headers.references?.match(/<[^<>\s]+>/g) ?? [])]
}

function threadIdentity(message: FetchMessageObject, fallback: string): string {
  const headers = headerMap(message.headers)
  return rfcReferences(headers)[0] ?? headers['in-reply-to']?.match(/<[^<>\s]+>/)?.[0] ?? message.envelope?.inReplyTo ?? message.envelope?.messageId ?? fallback
}

function bodyNodes(part: MessageStructureObject | undefined, type: string): MessageStructureObject[] {
  if (!part || isAttachment(part)) return []
  if (part.type.toLowerCase() === type) return [part]
  const children = (part.childNodes ?? []).map(child => bodyNodes(child, type))
  // Alternatives are representations of the same content, not extra body paragraphs.
  return part.type.toLowerCase() === 'multipart/alternative' ? children.filter(parts => parts.length).at(-1) ?? [] : children.flat()
}

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

function messageId(accountId: string, mailbox: string, uidValidity: string, uid: number): string {
  return `imap:${encodeURIComponent(accountId)}:${encodeURIComponent(mailbox)}:${uidValidity}:${uid}`
}

function parseMessageId(value: string, accountId: string): { mailbox: string; uidValidity: string; uid: number } {
  const match = value.match(/^imap:([^:]+):([^:]+):(\d+):(\d+)$/)
  if (!match || match[1] !== encodeURIComponent(accountId)) throw new ProviderNotFoundError('imap', 'Message identifier does not belong to this account')
  const uid = Number(match[4])
  if (!Number.isSafeInteger(uid) || uid < 1) {
    throw new ProviderError('imap', 'VALIDATION', 'Invalid IMAP message UID')
  }
  try {
    return { mailbox: decodeURIComponent(match[2]!), uidValidity: match[3]!, uid }
  } catch {
    throw new ProviderError('imap', 'VALIDATION', 'Invalid IMAP mailbox identifier')
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

async function streamBuffer(stream: AsyncIterable<unknown> | undefined, maximum: number): Promise<Buffer> {
  if (!stream) throw new ProviderError('imap', 'UPSTREAM', 'The IMAP server did not return the requested MIME part')
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of stream) {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array)
      size += bytes.byteLength
      if (size > maximum) throw new ProviderError('imap', 'UPSTREAM', 'The MIME part exceeds the supported size limit')
      chunks.push(bytes)
    }
  } catch (cause) {
    if (cause instanceof ProviderError) throw cause
    throw new ProviderError('imap', 'NETWORK', 'IMAP response body was interrupted', { retryable: true })
  }
  return Buffer.concat(chunks)
}

export class ImapProvider implements InboxProvider {
  readonly type = 'imap' as const
  readonly accountId: string
  private effectiveCapabilities: Readonly<ProviderCapabilities>
  get capabilities(): Readonly<ProviderCapabilities> { return this.effectiveCapabilities }
  private readonly credentials: ImapCredentials
  private readonly imap: ImapServerCredentials
  private readonly smtp?: SmtpServerCredentials
  private readonly dependencies: ImapProviderDependencies
  private readonly folders = new Map<MailFolder, string>()
  private readonly expunged = new Map<string, Set<number>>()
  private client?: ImapFlow
  private connecting?: Promise<ImapFlow>
  private cancelConnect?: () => void
  private connectionGeneration = 0
  private readonly known = new Map<string, Set<number>>()
  private readonly transports = new Set<{ close(): void }>()
  private readonly sockets = new Set<Socket>()
  private readonly abort = () => { void this.disconnect() }
  private smtpVerified = false
  private foldersDiscovered = false

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
      if (server.tls?.rejectUnauthorized === false || server.tls?.checkServerIdentity) {
        throw new ProviderError('imap', 'VALIDATION', `${protocol} certificate verification cannot be disabled`)
      }
      if (['TLSv1', 'TLSv1.1'].includes(server.tls?.minVersion ?? '')) {
        throw new ProviderError('imap', 'VALIDATION', `${protocol} requires TLS 1.2 or newer`)
      }
    }
    this.folders.set('inbox', credentials.mailboxes?.inbox ?? 'INBOX')
    for (const [folder, path] of Object.entries(credentials.mailboxes ?? {})) {
      if (path) this.folders.set(folder as MailFolder, path)
    }

    const canSend = Boolean(this.smtp?.host)
    this.effectiveCapabilities = Object.freeze({
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
      archive: false,
      trash: false,
      permanentDelete: false,
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
    credentials.signal?.addEventListener('abort', this.abort, { once: true })
  }

  private updateCapabilities(client: ImapFlow): void {
    // UIDPLUS is mandatory even for MOVE: without COPYUID we cannot preserve identity.
    const uidPlus = client.capabilities.has('UIDPLUS') || client.capabilities.has('IMAP4rev2')
    this.effectiveCapabilities = Object.freeze({ ...this.effectiveCapabilities,
      archive: uidPlus && this.folders.has('archive'), trash: uidPlus && this.folders.has('trash'), permanentDelete: uidPlus })
  }

  private async connection(): Promise<ImapFlow> {
    if (this.credentials.signal?.aborted) throw new ProviderError('imap', 'NETWORK', 'IMAP request was cancelled', { retryable: true })
    this.credentials.signal?.addEventListener('abort', this.abort, { once: true })
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
        ...this.imap.tls,
        minVersion: this.imap.tls?.minVersion ?? 'TLSv1.2',
        servername: this.imap.host,
        rejectUnauthorized: true,
      },
      logger: false,
      logRaw: false,
      emitLogs: false,
      // Polling is the SDK's delivery mechanism; an idle socket is not a push capability.
      disableAutoIdle: true,
      maxLineLength: 16 * 1024 * 1024,
      maxLiteralSize: MAX_HEADERS_BYTES + 1024,
      maxResponseSize: 16 * 1024 * 1024,
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
    this.client = client // disconnect must also cancel a connection still authenticating
    const cancelled = new Promise<never>((_, reject) => { this.cancelConnect = () => reject(new ProviderError('imap', 'NETWORK', 'IMAP connection was cancelled', { retryable: true })) })
    const connected = client.connect().then(() => {
      if (generation !== this.connectionGeneration) { client.close(); throw new ProviderError('imap', 'NETWORK', 'IMAP connection was disconnected', { retryable: true }) }
    })
    this.connecting = Promise.race([connected, cancelled])
      .then(() => {
        if (generation !== this.connectionGeneration) {
          client.close()
          throw new ProviderError('imap', 'NETWORK', 'IMAP connection was disconnected', { retryable: true })
        }
        this.client = client
        this.updateCapabilities(client)
        return client
      })
      .catch((error: unknown) => {
        client.close()
        if (this.client === client) this.client = undefined
        if (error instanceof ProviderError) throw error
        const failure = error && typeof error === 'object'
          ? error as { authenticationFailed?: boolean; code?: string }
          : undefined
        const details = error instanceof Error ? error.message : String(error)
        const certificateFailure = /cert|self.signed|unable.to.verify/i.test(`${failure?.code ?? ''} ${details}`)
        const timedOut = ['ETIMEDOUT', 'CONNECT_TIMEOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE'].includes(failure?.code ?? '')
        if (!certificateFailure && !timedOut && (failure?.authenticationFailed || failure?.code === 'EAUTH')) {
          throw new ProviderAuthenticationError('imap', 'IMAP authentication failed; reconnect with the mail password or a new app-specific password')
        }
        throw new ProviderError('imap', 'NETWORK', 'IMAP connection failed', {
          retryable: !certificateFailure,
        })
      })
      .finally(() => {
        this.connecting = undefined
        this.cancelConnect = undefined
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

  private async withMailbox<T>(path: string, callback: (client: ImapFlow, uidValidity: string) => Promise<T>, readOnly = true): Promise<T> {
    const client = await this.connection()
    if (!this.foldersDiscovered) await this.listFolders()
    let lock: Awaited<ReturnType<ImapFlow['getMailboxLock']>>
    try {
      lock = await client.getMailboxLock(path, { readOnly, acquireTimeout: this.credentials.timeoutMs ?? 30_000 })
    } catch (error) {
      const code = error && typeof error === 'object' ? (error as { code?: string }).code : undefined
      const networkFailure = code === 'LockTimeout' || code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'EPIPE' ||
        (error instanceof Error && error.name === 'AbortError')
      if (networkFailure && this.client === client && !client.usable) this.client = undefined
      throw new ProviderError('imap', networkFailure ? 'NETWORK' : 'UPSTREAM', 'Unable to open the IMAP mailbox', {
        retryable: networkFailure,
      })
    }
    try {
      if (!client.mailbox) throw new ProviderError('imap', 'UPSTREAM', 'IMAP mailbox did not open')
      return await callback(client, String(client.mailbox.uidValidity))
    } catch (cause) {
      if (cause instanceof ProviderError) throw cause
      const failure = cause as { code?: string; name?: string }
      const network = failure?.name === 'AbortError' || ['ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'NoConnection', 'ConnectionClosed'].includes(failure?.code ?? '')
      throw new ProviderError('imap', network ? 'NETWORK' : 'UPSTREAM', 'IMAP operation failed', { retryable: network })
    } finally {
      lock.release()
    }
  }

  private async body(client: ImapFlow, uid: number, part: MessageStructureObject | undefined): Promise<string> {
    if (!part || part.size === 0) return ''
    if ((part.size ?? 0) > MAX_BODY_BYTES) throw new ProviderError('imap', 'UPSTREAM', 'Message body exceeds the supported size limit')
    const result = await client.download(String(uid), part.part ?? '1', { uid: true, maxBytes: MAX_BODY_BYTES + 1 })
    const content = await streamBuffer(result.content, MAX_BODY_BYTES)
    const charset = result.meta.charset ?? part.parameters?.charset ?? 'utf-8'
    try {
      return new TextDecoder(charset, { fatal: true }).decode(content)
    } catch {
      throw new UnsupportedOperationError('imap', 'decoding this message character encoding without data loss')
    }
  }

  private async normalize(
    client: ImapFlow,
    message: FetchMessageObject,
    mailbox: string,
    uidValidity: string,
    folderHint?: MailFolder,
  ): Promise<MailMessage> {
    const id = messageId(this.accountId, mailbox, uidValidity, message.uid)
    const parts = flattenParts(message.bodyStructure, true)
    const textParts = bodyNodes(message.bodyStructure, 'text/plain')
    const htmlParts = bodyNodes(message.bodyStructure, 'text/html')
    const readParts = async (parts: MessageStructureObject[]) => {
      const bodies: string[] = []
      let size = 0
      for (const part of parts) {
        const body = await this.body(client, message.uid, part)
        size += Buffer.byteLength(body)
        if (size > MAX_BODY_BYTES) throw new ProviderError('imap', 'UPSTREAM', 'Message body exceeds the supported size limit')
        bodies.push(body)
      }
      return bodies.join('\n')
    }
    const bodyHtml = await readParts(htmlParts)
    // An explicitly empty plain alternative is valid; do not replace it with derived HTML text.
    const bodyText = textParts.length ? await readParts(textParts) : htmlToPlainText(bodyHtml)
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
    const headers = headerMap(message.headers)
    const references = rfcReferences(headers)
    // iCloud's ENVELOPE may omit In-Reply-To even when the original header is present.
    const inReplyTo = headers['in-reply-to']?.match(/<[^<>\s]+>/)?.[0] ?? envelope?.inReplyTo
    const knownKey = `${mailbox}\0${uidValidity}`
    const known = this.known.get(knownKey) ?? new Set<number>()
    known.add(message.uid)
    this.known.set(knownKey, known)
    const from = participants(envelope?.from)[0] ?? { name: '', email: '' }
    return {
      id,
      threadId: threadIdentity(message, id),
      accountId: this.accountId,
      from,
      to: participants(envelope?.to),
      cc: participants(envelope?.cc),
      bcc: participants(envelope?.bcc),
      replyTo: participants(envelope?.replyTo),
      ...(envelope?.messageId ? { rfcMessageId: envelope.messageId } : {}),
      ...(inReplyTo ? { inReplyTo } : {}),
      references,
      headers,
      subject: envelope?.subject ?? '',
      preview: previewText(bodyText || bodyHtml),
      bodyText,
      bodyHtml,
      receivedAt: normalizeDate(message.internalDate ?? envelope?.date),
      isRead: message.flags?.has('\\Seen') ?? false,
      isStarred: message.flags?.has('\\Flagged') ?? false,
      folder: [...this.folders].find(([, path]) => path === mailbox)?.[0] ?? mailboxFolder(mailbox) ?? mailbox,
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
    let bytes = 0
    for (const message of fetched) {
      const normalized = await this.normalize(client, message, mailbox, uidValidity, folder)
      bytes += Buffer.byteLength(normalized.bodyText) + Buffer.byteLength(normalized.bodyHtml)
      if (bytes > MAX_BATCH_BODY_BYTES) throw new ProviderError('imap', 'UPSTREAM', 'Message batch exceeds the supported body size limit; request a smaller page')
      messages.push(normalized)
    }
    return messages.sort((left, right) => right.receivedAt.localeCompare(left.receivedAt))
  }

  async getAccount(): Promise<MailAccount> {
    const client = await this.connection()
    await this.listFolders()
    const inbox = await client.status(this.folders.get('inbox')!, { unseen: true })
    if (this.smtp && !this.smtpVerified) {
      const transport = this.smtpTransport()
      try { if (transport.verify) await transport.verify(); this.smtpVerified = true }
      catch (error) { throw this.smtpError(error) }
      finally { transport.close(); this.transports.delete(transport) }
    }
    const email = this.credentials.email ?? this.imap.user!
    return createMailAccount('imap', this.credentials, { email, unreadCount: inbox.unseen ?? 0 })
  }

  async listFolders(): Promise<ProviderFolder[]> {
    const client = await this.connection()
    const mailboxes = await client.list({ statusQuery: { unseen: true, messages: true } })
    const folders: ProviderFolder[] = []
    for (const mailbox of mailboxes) {
      if (mailbox.flags?.has('\\Noselect') || mailbox.flags?.has('\\NonExistent')) continue
      const classified = mailboxFolder(mailbox.path, mailbox.specialUse)
      const folder = classified ?? mailbox.path
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
    this.updateCapabilities(client)
    this.foldersDiscovered = true
    return folders
  }

  async createFolder(name: string): Promise<ProviderFolder> {
    if (!name || name.length > 512 || /[\x00-\x1f\x7f]/.test(name)) throw new ProviderError('imap', 'VALIDATION', 'A bounded mailbox name is required')
    const client = await this.connection()
    try {
      const mailbox = await client.mailboxCreate(name)
      if (!mailbox.created) {
        throw new ProviderError('imap', 'VALIDATION', 'An IMAP mailbox with that name already exists', { status: 409 })
      }
      return { id: mailbox.path, name, folder: mailbox.path, kind: 'folder', path: mailbox.path, custom: true }
    } catch (error) {
      if (error instanceof ProviderError) throw error
      throw new ProviderError('imap', 'UPSTREAM', 'Unable to create the IMAP mailbox')
    }
  }

  async listMessages(options: ListOptions = {}): Promise<ProviderListResult<MailMessage>> {
    const folder = options.folder ?? 'inbox'
    const path = await this.mailboxPath(folder)
    return this.withMailbox(path, async (client, uidValidity) => {
      let before = Number.POSITIVE_INFINITY
      if (options.cursor) {
        {
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
      if (result && result.length > MAX_UIDS) throw new UnsupportedOperationError('imap', 'mailboxes exceeding the UID inventory limit')
      const matching = (result || []).sort((left, right) => right - left)
      const available = matching.filter((uid) => uid < before)
      const limit = clampLimit(options.limit, 25, 25)
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
    const folder = options.folder ?? 'inbox'
    const path = await this.mailboxPath(folder)
    return this.withMailbox(path, async (client, uidValidity) => {
      const scope = [this.accountId, path, uidValidity, folder, options.search ?? '', Boolean(options.unreadOnly)]
      let ceiling = Number.MAX_SAFE_INTEGER
      let offset = 0
      if (options.cursor) {
        try {
          if (options.cursor.length > 2048 || !/^[\w-]+$/.test(options.cursor)) throw new Error()
          const saved = JSON.parse(Buffer.from(options.cursor, 'base64url').toString())
          if (saved.kind !== 'threads' || JSON.stringify(saved.scope) !== JSON.stringify(scope) ||
            !Number.isSafeInteger(saved.ceiling) || !Number.isSafeInteger(saved.offset) || saved.offset < 0) throw new Error()
          ceiling = saved.ceiling; offset = saved.offset
        } catch { throw new ProviderCursorExpiredError('imap', 'Invalid IMAP thread cursor') }
      }
      const matches = await client.search({ all: true, ...(options.unreadOnly ? { seen: false } : {}),
        ...(folder === 'starred' ? { flagged: true } : {}), ...(options.search ? { text: options.search } : {}) }, { uid: true })
      const uids = (matches || []).filter(uid => uid <= ceiling).sort((a, b) => b - a)
      if (uids.length > MAX_THREAD_SCAN) throw new UnsupportedOperationError('imap', 'direct thread listing above 10,000 matching messages; use the SDK indexed thread view')
      ceiling = Math.min(ceiling, uids[0] ?? 0)
      const headers = uids.length ? await client.fetchAll(uids, { uid: true, envelope: true, headers: true }, { uid: true }) : []
      const grouped = new Map<string, number[]>()
      for (const message of headers.sort((a, b) => b.uid - a.uid)) {
        const key = threadIdentity(message, messageId(this.accountId, path, uidValidity, message.uid))
        grouped.set(key, [...grouped.get(key) ?? [], message.uid])
      }
      const selected = [...grouped].slice(offset, offset + clampLimit(options.limit))
      const items: MailThread[] = []
      for (const [threadId, members] of selected) {
        if (members.length > MAX_THREAD_MESSAGES) throw new UnsupportedOperationError('imap', 'conversations exceeding 1,000 messages')
        items.push(requireThread('imap', (await this.fetchMessages(client, members, path, uidValidity, folder)).map(message => ({ ...message, threadId })), threadId))
      }
      const hasMore = offset + selected.length < grouped.size
      return { items, hasMore, total: grouped.size, nextCursor: hasMore
        ? Buffer.from(JSON.stringify({ kind: 'threads', scope, ceiling, offset: offset + selected.length })).toString('base64url') : null }
    })
  }

  async getMessage(id: string): Promise<MailMessage> {
    const parsed = parseMessageId(id, this.accountId)
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
    if (threadId.startsWith('imap:')) return requireThread('imap', [await this.getMessage(threadId)], threadId)
    if (!/^<[^<>\s]{1,998}>$/.test(threadId)) throw new ProviderNotFoundError('imap', 'Unknown IMAP thread identifier')
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
        if ((matches || []).length + messages.length > MAX_THREAD_MESSAGES) throw new UnsupportedOperationError('imap', 'conversations exceeding 1,000 messages')
        return this.fetchMessages(client, matches || [], path, uidValidity)
      })
      messages.push(...found)
    }
    return requireThread('imap', messages.map((message) => ({ ...message, threadId })), threadId)
  }

  async sync(cursor?: SyncCursor | string | null, options: SyncOptions = {}, context?: SyncContext): Promise<SyncResult> {
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
    if (current?.metadata?.mailbox && current.metadata.mailbox !== path) throw new ProviderCursorExpiredError('imap', 'IMAP sync cursors are scoped to one mailbox path')
    return this.withMailbox(path, async (client, uidValidity) => {
      const mailbox = client.mailbox
      if (!mailbox) throw new ProviderError('imap', 'UPSTREAM', 'IMAP mailbox is no longer selected')
      const valid = current?.metadata?.uidValidity === uidValidity
      const continuingPage = current?.kind === 'page' && valid
      // Advertisement alone is not an enabled extension; ImapFlow otherwise ignores
      // changedSince. In particular, NOMODSEQ mailboxes still need the polling fallback.
      const highestModseq = client.enabled.has('CONDSTORE') && !mailbox.noModseq ? mailbox.highestModseq?.toString() : undefined
      const found = mailbox.exists ? await client.search({ all: true }, { uid: true }) : []
      const all = (found || []).sort((a, b) => b - a)
      if (all.length > MAX_UIDS) throw new UnsupportedOperationError('imap', 'mailboxes exceeding the UID inventory limit')
      const present = new Set(all)
      const knownKey = `${path}\0${uidValidity}`
      const known = new Set(this.known.get(knownKey) ?? [])
      const retired = new Set<string>()
      // UID inventories contain no bodies. The SDK supplies its stored subset after restart,
      // so EXPUNGE notifications/CONDSTORE are optimizations, never deletion-history evidence.
      for (const id of context?.knownMessageIds ?? options.knownMessageIds ?? []) {
        if (id.startsWith('submission:')) continue
        const previous = parseMessageId(id, this.accountId)
        if (previous.mailbox !== path) continue
        if (previous.uidValidity !== uidValidity || !present.has(previous.uid)) retired.add(id)
        else known.add(previous.uid)
      }
      for (const uid of known) if (!present.has(uid)) retired.add(messageId(this.accountId, path, uidValidity, uid))
      for (const uid of this.expunged.get(knownKey) ?? []) retired.add(messageId(this.accountId, path, uidValidity, uid))
      const limit = clampLimit(options.limit, 25, 25)
      const deltaPage = valid && current?.metadata?.mode === 'changes'
      const snapshot = !current || !valid || continuingPage && !deltaPage
      const watermark = continuingPage ? Number(current!.value) : all[0] ?? 0
      const before = continuingPage ? Number(current!.metadata?.beforeUid) : Infinity
      if (continuingPage && (!Number.isSafeInteger(before) || before < 1)) throw new ProviderCursorExpiredError('imap', 'Invalid IMAP sync continuation')
      let candidates: number[]
      const previousModseq = current?.metadata?.highestModseq
      if (snapshot) candidates = all.filter(uid => uid < before && uid <= watermark)
      else {
        if (previousModseq && !/^\d+$/.test(previousModseq)) throw new ProviderCursorExpiredError('imap', 'Invalid IMAP modification sequence')
        // A whole-mailbox CHANGEDSINCE scan was >12s on the qualified large iCloud
        // mailbox before any bodies were fetched. Reconcile only the SDK's stored
        // subset and actual arrivals; older history belongs to the backfill lane.
        const after = Number(current?.metadata?.afterUid ?? current?.value ?? 0)
        const tracked = all.filter(uid => uid <= watermark && (uid > after || known.has(uid)))
        const changed = tracked.length ? await client.fetchAll(tracked, { uid: true, flags: true }, { uid: true,
          ...(previousModseq && highestModseq ? { changedSince: BigInt(previousModseq) } : {}) }) : []
        const states = new Map((context?.knownMessageStates ?? options.knownMessageStates ?? []).map(state => [state.id, state]))
        candidates = [...new Set(changed.filter(message => {
          const state = states.get(messageId(this.accountId, path, uidValidity, message.uid))
          // IMAP message content is immutable for a UID. A flag-only poll must not
          // redownload every unchanged body when CONDSTORE was not enabled.
          return message.uid > after || !state || state.isRead !== Boolean(message.flags?.has('\\Seen')) || state.isStarred !== Boolean(message.flags?.has('\\Flagged'))
        }).map(message => message.uid))].filter(uid => present.has(uid) && uid < before && uid <= watermark).sort((a, b) => b - a)
      }
      const selected = candidates.slice(0, limit)
      const hasMore = candidates.length > limit
      const messages = await this.fetchMessages(client, selected, path, uidValidity, folder)
      this.expunged.delete(knownKey)
      for (const uid of known) if (!present.has(uid)) this.known.get(knownKey)?.delete(uid)
      const targetModseq = deltaPage ? current!.metadata?.targetModseq : highestModseq
      const modseq = snapshot ? (continuingPage ? previousModseq : highestModseq) : hasMore ? previousModseq : targetModseq
      const metadata: Record<string, string> = { accountId: this.accountId, mailbox: path, uidValidity,
        ...(modseq ? { highestModseq: modseq } : {}),
        ...(hasMore ? { beforeUid: String(selected.at(-1)), mode: snapshot ? 'snapshot' : 'changes',
          ...(!snapshot ? { afterUid: current?.metadata?.afterUid ?? current!.value, ...(targetModseq ? { targetModseq } : {}) } : {}) } : {}),
      }
      const next: SyncCursor = { provider: 'imap', kind: hasMore ? 'page' : 'uid', value: String(watermark), folder, metadata }
      return { messages, threads: buildThreads(messages), deletedMessageIds: [], removedMessageIds: [...retired], retiredMessageIds: [...retired],
        cursor: next, hasMore, fullSync: snapshot, snapshotComplete: snapshot && !hasMore,
        // A partial delta must retain its continuation; advancing MODSEQ here would lose later pages.
        recentCursor: snapshot ? { provider: 'imap', kind: 'uid', value: String(watermark), folder,
          metadata: { accountId: this.accountId, mailbox: path, uidValidity, ...(modseq ? { highestModseq: modseq } : {}) } } : next,
      }
    })
  }

  private smtpTransport() {
    this.credentials.signal?.addEventListener('abort', this.abort, { once: true })
    const smtp = this.smtp!
    const user = smtp.user ?? smtp.username ?? this.imap.user!
    const token = smtp.accessToken ?? this.credentials.accessToken ?? this.imap.accessToken
    const secure = smtp.secure ?? smtp.port === 465
    const timeout = this.credentials.timeoutMs ?? 30_000
    const options: SMTPTransport.Options = {
      host: smtp.host,
      port: smtp.port ?? (secure ? 465 : 587),
      secure,
      requireTLS: !secure,
      opportunisticTLS: false,
      auth: token
        ? { type: 'OAuth2', user, accessToken: token }
        : { user, pass: smtp.password ?? this.credentials.password ?? this.imap.password },
      tls: {
        ...smtp.tls,
        minVersion: smtp.tls?.minVersion ?? 'TLSv1.2',
        servername: smtp.host,
        rejectUnauthorized: true,
      },
      logger: false,
      debug: false,
      connectionTimeout: timeout,
      greetingTimeout: timeout,
      socketTimeout: timeout,
      dnsTimeout: timeout,
      // Non-pooled Nodemailer close() does not cancel an active SMTP socket. Own the
      // plain transport; Nodemailer performs its normal verified TLS/STARTTLS upgrade.
      getSocket: (_options, callback) => {
        if (this.credentials.signal?.aborted) { callback(new Error('SMTP cancelled'), {}); return }
        const socket = createConnection({ host: smtp.host, port: options.port! })
        this.sockets.add(socket)
        const timer = setTimeout(() => socket.destroy(Object.assign(new Error('SMTP connection timed out'), { code: 'ETIMEDOUT' })), timeout)
        let settled = false
        const failed = (error: Error) => { if (!settled) { settled = true; callback(error, {}) } }
        socket.once('error', failed)
        socket.once('connect', () => { if (settled) return; settled = true; clearTimeout(timer); socket.removeListener('error', failed); callback(null, { connection: socket }) })
        socket.once('close', () => { clearTimeout(timer); this.sockets.delete(socket); failed(Object.assign(new Error('SMTP connection cancelled'), { code: 'ECONNECTION' })) })
      },
    }
    const transport = this.dependencies.createTransport?.(options) ?? nodemailer.createTransport(options)
    this.transports.add(transport)
    return transport
  }

  private smtpError(error: unknown): ProviderError {
    const code = error && typeof error === 'object' ? (error as { code?: string }).code : undefined
    if (code === 'EAUTH') return new ProviderAuthenticationError('imap', 'SMTP authentication failed; reconnect with a valid mail password')
    const details = error instanceof Error ? error.message : ''
    const certificateFailure = /cert|self.signed|unable.to.verify/i.test(`${code ?? ''} ${details}`)
    const networkFailure = !certificateFailure && ['ETIMEDOUT', 'ESOCKET', 'ECONNECTION'].includes(code ?? '')
    // Upstream strings may contain a username, recipient or AUTH response. Never retain them.
    return new ProviderError('imap', networkFailure ? 'NETWORK' : 'UPSTREAM', certificateFailure ? 'SMTP TLS certificate verification failed' : 'SMTP message delivery failed', { retryable: networkFailure })
  }

  async send(input: SendInput): Promise<SendResult> {
    if (input.accountId !== undefined && input.accountId !== this.accountId) throw new ProviderAuthorizationError('imap', 'The message belongs to a different account')
    if (!this.smtp?.host) throw new UnsupportedOperationError('imap', 'sending without an SMTP configuration')
    if (input.scheduledAt) throw new UnsupportedOperationError('imap', 'scheduled sending')
    if (this.credentials.signal?.aborted) throw new ProviderError('imap', 'NETWORK', 'SMTP request was cancelled', { retryable: true })
    const from = input.from ?? this.credentials.email ?? this.imap.user!
    const sender = parseParticipants(from)
    const to = parseParticipants(input.to), cc = parseParticipants(input.cc), bcc = parseParticipants(input.bcc)
    const recipients = [...to, ...cc, ...bcc]
    const valid = (participant: Participant) => /^[^\s<>@]+@[^\s<>@]+$/.test(participant.email) && !/[\r\n\0]/.test(participant.name)
    if (sender.length !== 1 || !valid(sender[0]!) || !recipients.length || recipients.length > 500 || !recipients.every(valid)) {
      throw new ProviderError('imap', 'VALIDATION', 'Valid sender and recipient addresses are required')
    }
    if (sender[0]!.email.toLowerCase() !== (this.credentials.email ?? this.imap.user!).toLowerCase()) throw new ProviderAuthorizationError('imap', 'Only the connected sending identity is supported')
    const headers = input.headers ?? {}
    if (Object.entries(headers).some(([key, value]) => !/^x-[a-z0-9-]+$/i.test(key) || typeof value !== 'string' || value.length > 4096 || /[\r\n\0]/.test(value))) {
      throw new ProviderError('imap', 'VALIDATION', 'Only bounded custom X- headers are accepted')
    }
    let inReplyTo = input.inReplyTo
    let references = input.references
    if (input.sourceMessageId) {
      const parent = await this.getMessage(input.sourceMessageId)
      if (inReplyTo && inReplyTo !== parent.rfcMessageId) throw new ProviderError('imap', 'VALIDATION', 'Reply parent does not match the selected message')
      inReplyTo = parent.rfcMessageId
      references ??= [...parent.references ?? [], ...inReplyTo ? [inReplyTo] : []]
    }
    if (inReplyTo && !/^<[^<>\s]+>$/.test(inReplyTo) || references?.some(value => !/^<[^<>\s]+>$/.test(value))) throw new ProviderError('imap', 'VALIDATION', 'Invalid reply references')
    const attachments = input.attachments?.map(attachment => ({ filename: attachment.filename, content: attachmentContent(attachment),
      contentType: attachment.contentType, cid: attachment.contentId, contentDisposition: attachment.inline ? 'inline' as const : 'attachment' as const }))
    const bytes = Buffer.byteLength(input.bodyText ?? input.text ?? input.body ?? '') + Buffer.byteLength(input.bodyHtml ?? input.html ?? '') +
      (attachments ?? []).reduce((size, attachment) => size + attachment.content.byteLength, 0)
    if (bytes > MAX_ATTACHMENT_BYTES || (attachments?.length ?? 0) > 100) throw new ProviderError('imap', 'VALIDATION', 'Outgoing message exceeds the supported size limit')
    const submission = Object.entries(headers).find(([key]) => key.toLowerCase() === 'x-inbox-submission-id')?.[1]
    const rfcId = `<${submission ? createHash('sha256').update(`${this.accountId}\0${submission}`).digest('hex') : randomUUID()}@superlocal.invalid>`
    const mail: SMTPTransport.MailOptions = { from: formatParticipant(from), to: to.map(formatParticipant), cc: cc.map(formatParticipant), bcc: bcc.map(formatParticipant),
      envelope: { from: sender[0]!.email, to: [...new Set(recipients.map(participant => participant.email))] },
      subject: input.subject, text: input.bodyText ?? input.text ?? input.body, html: input.bodyHtml ?? input.html,
      inReplyTo, references, headers, attachments, messageId: rfcId, disableFileAccess: true, disableUrlAccess: true }
    const compiled = new MailComposer(mail).compile()
    const outgoing = await compiled.build() // Bcc is omitted on the wire, retained only in the private Sent copy.
    const sentPath = this.credentials.sentCopy === 'append' ? await this.mailboxPath('sent') : undefined
    const transport = this.smtpTransport()
    try {
      const result = await transport.sendMail({ ...mail, raw: outgoing })
      let providerMessageId: string | undefined
      let sentCopyUnconfirmed = false
      if (sentPath && result.accepted.length) {
        try {
          compiled.keepBcc = true
          const client = await this.connection()
          const copy = await client.append(sentPath, await compiled.build(), ['\\Seen'])
          if (copy && copy.uid && copy.uidValidity) providerMessageId = messageId(this.accountId, sentPath, String(copy.uidValidity), copy.uid)
          else if (!copy) sentCopyUnconfirmed = true
        } catch { sentCopyUnconfirmed = true } // Acceptance is final; neither resend nor retry APPEND blindly.
      }
      return {
        id: result.messageId,
        messageId: result.messageId,
        ...(providerMessageId ? { providerMessageId } : {}),
        ...(sentCopyUnconfirmed ? { sentCopyUnconfirmed: true } : {}),
        ...(input.threadId ? { threadId: input.threadId } : {}),
        accepted: result.accepted.map(String),
        rejected: result.rejected.map(String),
      }
    } catch (error) {
      throw this.smtpError(error)
    } finally {
      transport.close()
      this.transports.delete(transport)
    }
  }

  async mutate(id: string, mutation: MessageMutation): Promise<MailMessage | null> {
    if (!mutation || Object.keys(mutation).some(key => !['isRead', 'isStarred', 'isArchived', 'folder', 'addLabels', 'removeLabels', 'snoozedUntil', 'deletePermanently'].includes(key))) {
      throw new ProviderError('imap', 'VALIDATION', 'Unknown IMAP mutation field')
    }
    for (const key of ['isRead', 'isStarred', 'isArchived', 'deletePermanently'] as const) {
      if (mutation[key] !== undefined && typeof mutation[key] !== 'boolean') throw new ProviderError('imap', 'VALIDATION', 'IMAP flags must be boolean')
    }
    if (mutation.snoozedUntil !== undefined) throw new UnsupportedOperationError('imap', 'snoozing')
    if (mutation.addLabels?.length || mutation.removeLabels?.length) throw new UnsupportedOperationError('imap', 'labels')
    if (mutation.folder && mutation.isArchived !== undefined && mutation.folder !== (mutation.isArchived ? 'archive' : 'inbox') ||
      mutation.folder === 'starred' && mutation.isStarred === false ||
      mutation.deletePermanently && Object.keys(mutation).some(key => key !== 'deletePermanently')) {
      throw new ProviderError('imap', 'VALIDATION', 'Conflicting IMAP mutation fields')
    }

    const parsed = parseMessageId(id, this.accountId)
    const destinationFolder = mutation.folder ?? (mutation.isArchived === undefined ? undefined : mutation.isArchived ? 'archive' : 'inbox')
    const destination = destinationFolder && destinationFolder !== 'starred' ? await this.mailboxPath(destinationFolder) : undefined
    let movedUid: number | undefined
    let movedUidValidity: string | undefined
    let sourceRetired = false
    let progressed = false

    const updated = await this.withMailbox(parsed.mailbox, async (client, uidValidity) => {
      if (uidValidity !== parsed.uidValidity) {
        throw new ProviderCursorExpiredError('imap', `UIDVALIDITY changed for mailbox ${parsed.mailbox}`)
      }
      const range = String(parsed.uid)
      if (!client.mailbox || client.mailbox.readOnly) throw new ProviderAuthorizationError('imap', 'This mailbox is read-only')
      const moving = destination && destination !== parsed.mailbox
      if ((moving || mutation.deletePermanently) && !this.capabilities.permanentDelete) {
        throw new UnsupportedOperationError('imap', 'safe per-UID removal without UIDPLUS')
      }
      const flags = client.mailbox.permanentFlags
      for (const [needed, flag] of [[mutation.isRead !== undefined, '\\Seen'], [mutation.isStarred !== undefined || destinationFolder === 'starred', '\\Flagged']] as const) {
        if (needed && flags && !flags.has(flag)) throw new UnsupportedOperationError('imap', `the ${flag} flag in this mailbox`)
      }
      if (!await client.fetchOne(range, { uid: true }, { uid: true })) throw new ProviderNotFoundError('imap', 'Message was not found')
      const applied = (result: boolean) => {
        if (!result) throw new ProviderError('imap', 'UPSTREAM', 'IMAP command was not accepted')
        progressed = true
      }
      try {
        if (mutation.deletePermanently) {
          // Never let ImapFlow fall back to mailbox-wide EXPUNGE.
          applied(await client.messageDelete(range, { uid: true }))
          return null
        }
        if (mutation.isRead !== undefined) applied(await (mutation.isRead
          ? client.messageFlagsAdd(range, ['\\Seen'], { uid: true }) : client.messageFlagsRemove(range, ['\\Seen'], { uid: true })))
        if (mutation.isStarred !== undefined || destinationFolder === 'starred') {
          const flagged = destinationFolder === 'starred' || mutation.isStarred === true
          applied(await (flagged ? client.messageFlagsAdd(range, ['\\Flagged'], { uid: true }) : client.messageFlagsRemove(range, ['\\Flagged'], { uid: true })))
        }
        if (moving) {
          const nativeMove = client.capabilities.has('MOVE') || client.capabilities.has('IMAP4rev2')
          const result = nativeMove ? await client.messageMove(range, destination, { uid: true }) : await client.messageCopy(range, destination, { uid: true })
          if (!result) throw new ProviderMutationError('imap') // server may have applied part of a MOVE
          progressed = true
          sourceRetired = nativeMove
          movedUid = result.uidMap?.get(parsed.uid)
          movedUidValidity = result.uidValidity?.toString()
          if (!movedUid || !movedUidValidity) throw new ProviderMutationError('imap', undefined, sourceRetired)
          // COPY first, and require authoritative COPYUID before deleting even the source instance.
          if (!nativeMove) { applied(await client.messageDelete(range, { uid: true })); sourceRetired = true }
          return null
        }
        const message = await client.fetchOne(range, FETCH_QUERY, { uid: true })
        if (!message) throw new ProviderNotFoundError('imap', 'Message was not found')
        return await this.normalize(client, message, parsed.mailbox, uidValidity)
      } catch (error) {
        if (!progressed && !(error instanceof ProviderMutationError)) throw error
        let confirmed: MailMessage | undefined
        if (!sourceRetired) {
          try { const message = await client.fetchOne(range, FETCH_QUERY, { uid: true }); if (message) confirmed = await this.normalize(client, message, parsed.mailbox, uidValidity) } catch { /* Report partial evidence, never fabricate rollback. */ }
        }
        throw new ProviderMutationError('imap', confirmed, sourceRetired)
      }
    }, false)

    if (mutation.deletePermanently || !destination || destination === parsed.mailbox) return updated
    try { return await this.withMailbox(destination, async (client, uidValidity) => {
      if (movedUidValidity && movedUidValidity !== uidValidity) {
        throw new ProviderCursorExpiredError('imap', `UIDVALIDITY changed for mailbox ${destination}`)
      }
      const uid = movedUid
      if (!uid) {
        throw new ProviderError('imap', 'UPSTREAM', 'IMAP server did not provide a destination UID after moving the message')
      }
      const message = await client.fetchOne(String(uid), FETCH_QUERY, { uid: true })
      if (!message) throw new ProviderNotFoundError('imap', `Moved message was not found in ${destination}`)
      return this.normalize(client, message, destination, uidValidity, destinationFolder)
    }) } catch { throw new ProviderMutationError('imap', undefined, true) }
  }

  async getAttachment(id: string, attachmentId: string): Promise<AttachmentData> {
    const parsed = parseMessageId(id, this.accountId)
    return this.withMailbox(parsed.mailbox, async (client, uidValidity) => {
      if (uidValidity !== parsed.uidValidity) {
        throw new ProviderCursorExpiredError('imap', `UIDVALIDITY changed for mailbox ${parsed.mailbox}`)
      }
      const fetched = await client.fetchOne(String(parsed.uid), { uid: true, bodyStructure: true }, { uid: true })
      if (!fetched) throw new ProviderNotFoundError('imap', `Message ${id} was not found`)
      const part = flattenParts(fetched.bodyStructure, true).find((item) => item.part === attachmentId && isAttachment(item))
      if (!part) throw new ProviderNotFoundError('imap', `Attachment ${attachmentId} was not found`)
      if ((part.size ?? 0) > MAX_ATTACHMENT_BYTES * 1.4) throw new ProviderError('imap', 'UPSTREAM', 'Attachment exceeds the supported size limit')
      // iCloud returns NIL, not an empty literal stream, for zero-octet parts. The
      // fetched BODYSTRUCTURE is authoritative; a missing nonempty part still fails.
      const downloaded = part.size === 0 ? undefined : await client.download(String(parsed.uid), attachmentId, { uid: true, maxBytes: MAX_ATTACHMENT_BYTES + 1 })
      const content = part.size === 0 ? Buffer.alloc(0) : await streamBuffer(downloaded?.content, MAX_ATTACHMENT_BYTES)
      const filename = downloaded?.meta?.filename ?? partFilename(part) ?? 'attachment'
      const contentType = downloaded?.meta?.contentType ?? part.type
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
    this.cancelConnect?.()
    this.credentials.signal?.removeEventListener('abort', this.abort)
    for (const transport of this.transports) transport.close()
    this.transports.clear()
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    // Closing the transport is immediate cancellation, not IMAP CLOSE (which expunges).
    client?.close()
    if (connecting) await connecting.catch(() => undefined)
  }
}
