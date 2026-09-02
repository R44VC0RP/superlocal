import { compile } from 'html-to-text'
import type { MailScope } from './mail-sources'
import type {
  Attachment,
  MailAccount,
  MailFolder,
  MailMessage,
  MailboxProviderDescriptor,
  MailThread,
  Participant,
  ProviderCapabilities,
} from '../../src/types'

export type {
  Attachment,
  MailAccount,
  MailFolder,
  MailMessage,
  MailboxProviderDescriptor,
  MailThread,
  Participant,
  ProviderCapabilities,
}

export type InboxProviderType = MailAccount['provider']

export interface ProviderCredentials {
  accountId: string
  email?: string
  name?: string
  userId?: string
  color?: string
  baseUrl?: string
  timeoutMs?: number
  fetch?: typeof globalThis.fetch
}

export interface SyncCursor {
  provider: InboxProviderType
  kind: 'history' | 'delta' | 'uid' | 'page'
  value: string
  folder?: MailFolder
  metadata?: Record<string, string>
}

export interface SyncOptions {
  folder?: MailFolder
  limit?: number
  mailboxScopes?: MailScope[]
}

export interface SyncResult {
  messages: MailMessage[]
  threads: MailThread[]
  deletedMessageIds: string[]
  cursor: SyncCursor | null
  hasMore: boolean
  fullSync: boolean
  recentCursor?: SyncCursor | null
  removedMessageIds?: string[]
  snapshotComplete?: boolean
}

export type Recipient = string | Participant

export interface SendAttachment {
  filename: string
  content: string | Uint8Array | ArrayBuffer
  contentType?: string
  encoding?: 'base64' | 'utf8'
  contentId?: string
  inline?: boolean
}

export interface SendInput {
  accountId?: string
  from?: Recipient
  to: Recipient | Recipient[]
  cc?: Recipient | Recipient[]
  bcc?: Recipient | Recipient[]
  subject: string
  body?: string
  text?: string
  html?: string
  bodyText?: string
  bodyHtml?: string
  attachments?: SendAttachment[]
  threadId?: string
  sourceMessageId?: string
  inReplyTo?: string
  references?: string[]
  replyAll?: boolean
  scheduledAt?: string
  headers?: Record<string, string>
}

export interface SendResult {
  id: string
  providerMessageId?: string
  threadId?: string
  messageId?: string
  accepted?: string[]
  rejected?: string[]
  scheduledAt?: string
}

export interface MessageMutation {
  isRead?: boolean
  isStarred?: boolean
  isArchived?: boolean
  folder?: MailFolder
  addLabels?: string[]
  removeLabels?: string[]
  snoozedUntil?: string | null
  deletePermanently?: boolean
}

export interface ListOptions {
  folder?: MailFolder
  cursor?: string | null
  limit?: number
  search?: string
  unreadOnly?: boolean
  mailboxScopes?: MailScope[]
}

export interface ProviderListResult<T> {
  items: T[]
  nextCursor: string | null
  hasMore: boolean
  total?: number
}

export interface ProviderFolder {
  id: string
  name: string
  folder: MailFolder
  kind?: 'folder' | 'label'
  path?: string
  custom?: boolean
  unreadCount?: number
  totalCount?: number
}

export interface AttachmentData {
  attachment: Attachment
  content: Uint8Array
  filename: string
  contentType: string
}

export interface InboxProvider {
  readonly type: InboxProviderType
  readonly accountId: string
  readonly capabilities: Readonly<ProviderCapabilities>
  getAccount(): Promise<MailAccount>
  listFolders(): Promise<ProviderFolder[]>
  createFolder(name: string): Promise<ProviderFolder>
  listMessages(options?: ListOptions): Promise<ProviderListResult<MailMessage>>
  listThreads(options?: ListOptions): Promise<ProviderListResult<MailThread>>
  getMessage(messageId: string): Promise<MailMessage>
  getThread(threadId: string): Promise<MailThread>
  sync(cursor?: SyncCursor | string | null, options?: SyncOptions): Promise<SyncResult>
  send(input: SendInput): Promise<SendResult>
  mutate(messageId: string, mutation: MessageMutation): Promise<MailMessage | null>
  getAttachment(messageId: string, attachmentId: string, contentId?: string,
    metadata?: Pick<Attachment, 'filename' | 'contentType' | 'inline'>): Promise<AttachmentData>
  disconnect(): Promise<void>
}

export type ProviderErrorCode =
  | 'AUTHENTICATION'
  | 'AUTHORIZATION'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'INVALID_CURSOR'
  | 'UNSUPPORTED_OPERATION'
  | 'VALIDATION'
  | 'NETWORK'
  | 'UPSTREAM'

export interface ProviderErrorOptions {
  status?: number
  retryable?: boolean
  retryAfter?: number
  details?: unknown
  cause?: unknown
}

export class ProviderError extends Error {
  readonly provider: InboxProviderType
  readonly code: ProviderErrorCode
  readonly status?: number
  readonly retryable: boolean
  readonly retryAfter?: number
  readonly details?: unknown

  constructor(
    provider: InboxProviderType,
    code: ProviderErrorCode,
    message: string,
    options: ProviderErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = this.constructor.name
    this.provider = provider
    this.code = code
    this.status = options.status
    this.retryable = options.retryable ?? false
    this.retryAfter = options.retryAfter
    this.details = options.details
  }
}

export class ProviderAuthenticationError extends ProviderError {
  constructor(provider: InboxProviderType, message = 'Provider authentication failed', options: ProviderErrorOptions = {}) {
    super(provider, 'AUTHENTICATION', message, { ...options, status: options.status ?? 401 })
  }
}

export class ProviderAuthorizationError extends ProviderError {
  constructor(provider: InboxProviderType, message = 'Provider access was denied', options: ProviderErrorOptions = {}) {
    super(provider, 'AUTHORIZATION', message, { ...options, status: options.status ?? 403 })
  }
}

export class ProviderNotFoundError extends ProviderError {
  constructor(provider: InboxProviderType, message = 'Provider resource was not found', options: ProviderErrorOptions = {}) {
    super(provider, 'NOT_FOUND', message, { ...options, status: options.status ?? 404 })
  }
}

export class ProviderRateLimitError extends ProviderError {
  constructor(provider: InboxProviderType, message = 'Provider rate limit exceeded', options: ProviderErrorOptions = {}) {
    super(provider, 'RATE_LIMITED', message, { ...options, status: options.status ?? 429, retryable: true })
  }
}

export class ProviderCursorExpiredError extends ProviderError {
  constructor(provider: InboxProviderType, message = 'Provider sync cursor has expired', options: ProviderErrorOptions = {}) {
    super(provider, 'INVALID_CURSOR', message, options)
  }
}

export class UnsupportedOperationError extends ProviderError {
  readonly operation: string

  constructor(provider: InboxProviderType, operation: string) {
    super(provider, 'UNSUPPORTED_OPERATION', `${provider} does not support ${operation}`)
    this.operation = operation
  }
}

export function parseParticipant(value: Recipient | null | undefined): Participant {
  if (!value) return { name: '', email: '' }
  if (typeof value !== 'string') return { name: value.name || value.email, email: value.email, ...(value.avatar === undefined ? {} : { avatar: value.avatar }) }

  const match = value.trim().match(/^(.*?)\s*<([^>]+)>$/)
  const email = (match?.[2] ?? value).trim().replace(/^mailto:/i, '')
  const name = (match?.[1] ?? '').trim().replace(/^"|"$/g, '')
  return { name: name || email, email }
}

export function parseParticipants(value: Recipient | Recipient[] | null | undefined): Participant[] {
  if (!value) return []
  const values: Recipient[] = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.match(/(?:"[^"]*"|[^,])+/g) ?? []
      : [value]
  return values.map((item) => parseParticipant(item)).filter((item) => item.email.length > 0)
}

export function formatParticipant(value: Recipient): string {
  const participant = parseParticipant(value)
  if (!participant.name || participant.name === participant.email) return participant.email
  const escaped = participant.name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `"${escaped}" <${participant.email}>`
}

export function attachmentContent(attachment: SendAttachment): Buffer {
  if (typeof attachment.content === 'string') {
    return Buffer.from(attachment.content, attachment.encoding === 'base64' ? 'base64' : 'utf8')
  }
  if (attachment.content instanceof ArrayBuffer) return Buffer.from(attachment.content)
  return Buffer.from(attachment.content)
}

export function encodeBase64Url(value: string | Uint8Array): string {
  return Buffer.from(value).toString('base64url')
}

export function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value, 'base64url')
}

export function normalizeDate(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined || value === '') return new Date(0).toISOString()
  const date = value instanceof Date ? value : new Date(typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value)
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString()
}

const convertEmailHtml = compile({
  wordwrap: false,
  selectors: [
    ...['head', 'script', 'style', 'textarea', 'option', 'xmp', 'noscript', 'template']
      .map((selector) => ({ selector, format: 'skip' })),
    ...[
      '[hidden]',
      '[aria-hidden="true" i]',
      '[style*="display:none" i]',
      '[style*="display: none" i]',
      '[style*="visibility:hidden" i]',
      '[style*="visibility: hidden" i]',
    ].map((selector) => ({ selector, format: 'skip' })),
    { selector: 'a', options: { ignoreHref: true } },
    { selector: 'img', format: 'skip' },
    { selector: 'ul', format: 'block' },
    { selector: 'ol', format: 'block' },
    { selector: 'li', format: 'block', options: { leadingLineBreaks: 2, trailingLineBreaks: 2 } },
    ...['h1', 'h2', 'h3', 'h4', 'h5', 'h6']
      .map((selector) => ({ selector, options: { uppercase: false } })),
    { selector: 'hr', format: 'block' },
  ],
})

export function htmlToPlainText(html: string): string {
  return convertEmailHtml(html)
}

export function previewText(value: string, limit = 200): string {
  const html = /<(?:\/?(?:html|head|body|address|article|aside|blockquote|div|dl|dt|dd|fieldset|figcaption|figure|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|tfoot|th|thead|tr|td|ul|br|a|span|strong|em|b|i|u|img)\b|!doctype\b)/i.test(value)
  return (html ? htmlToPlainText(value) : value).replace(/\s+/g, ' ').trim().slice(0, limit)
}

export function attachmentUrl(accountId: string, messageId: string, attachmentId: string): string {
  return `/api/accounts/${encodeURIComponent(accountId)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
}

export function createMailAccount(
  provider: InboxProviderType,
  credentials: ProviderCredentials,
  overrides: Partial<MailAccount> = {},
): MailAccount {
  const email = overrides.email ?? credentials.email ?? ''
  return {
    id: credentials.accountId,
    ...(credentials.userId ? { userId: credentials.userId } : {}),
    name: credentials.name ?? email,
    email,
    provider,
    color: credentials.color ?? '#64748b',
    syncStatus: 'connected',
    unreadCount: 0,
    ...overrides,
  }
}

export function buildThreads(messages: MailMessage[]): MailThread[] {
  const grouped = new Map<string, MailMessage[]>()
  for (const message of messages) {
    const group = grouped.get(message.threadId)
    if (group) group.push(message)
    else grouped.set(message.threadId, [message])
  }

  return [...grouped.entries()]
    .map(([id, threadMessages]): MailThread => {
      const ordered = [...threadMessages].sort((left, right) => left.receivedAt.localeCompare(right.receivedAt))
      const latest = ordered[ordered.length - 1]!
      const participants = new Map<string, Participant>()
      for (const message of ordered) {
        for (const participant of [message.from, ...message.to, ...message.cc]) {
          if (participant.email) participants.set(participant.email.toLowerCase(), participant)
        }
      }

      return {
        id,
        accountId: latest.accountId,
        subject: ordered[0]!.subject,
        preview: latest.preview,
        participants: [...participants.values()],
        messages: ordered,
        messageCount: ordered.length,
        lastMessageAt: latest.receivedAt,
        isRead: ordered.every((message) => message.isRead),
        isStarred: ordered.some((message) => message.isStarred),
        folder: latest.folder,
        labels: [...new Set(ordered.flatMap((message) => message.labels))],
        hasAttachments: ordered.some((message) => message.attachments.length > 0),
        ...(latest.snoozedUntil ? { snoozedUntil: latest.snoozedUntil } : {}),
        ...(latest.scheduledAt ? { scheduledAt: latest.scheduledAt } : {}),
      }
    })
    .sort((left, right) => right.lastMessageAt.localeCompare(left.lastMessageAt))
}

export function requireThread(provider: InboxProviderType, messages: MailMessage[], threadId: string): MailThread {
  const thread = buildThreads(messages)[0]
  if (!thread) throw new ProviderNotFoundError(provider, `Thread ${threadId} was not found`)
  return thread
}

export function normalizeCursor(
  provider: InboxProviderType,
  cursor: SyncCursor | string | null | undefined,
  kind: SyncCursor['kind'],
): SyncCursor | null {
  if (!cursor) return null
  if (typeof cursor === 'string') return { provider, kind, value: cursor }
  if (cursor.provider !== provider) {
    throw new ProviderCursorExpiredError(provider, `Cannot use a ${cursor.provider} cursor with ${provider}`)
  }
  return cursor
}

export function clampLimit(value: number | undefined, fallback = 50, maximum = 100): number {
  return Math.min(maximum, Math.max(1, Number.isFinite(value) ? Math.trunc(value!) : fallback))
}

function responseMessage(details: unknown, fallback: string): string {
  if (typeof details === 'string' && details.trim()) return details.trim().slice(0, 500)
  if (!details || typeof details !== 'object') return fallback
  const record = details as Record<string, unknown>
  if (typeof record.message === 'string') return record.message
  if (typeof record.error === 'string') return record.error
  if (record.error && typeof record.error === 'object') {
    const nested = record.error as Record<string, unknown>
    if (typeof nested.message === 'string') return nested.message
  }
  return fallback
}

function retryAfterSeconds(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds)
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? undefined : Math.max(0, Math.ceil((timestamp - Date.now()) / 1000))
}

export async function providerRequest(
  provider: InboxProviderType,
  fetcher: typeof globalThis.fetch,
  url: string,
  init: RequestInit = {},
  timeoutMs = 30_000,
): Promise<Response> {
  let response: Response
  try {
    response = await fetcher(url, {
      ...init,
      signal: init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new ProviderError(provider, 'NETWORK', `${provider} request failed`, {
      retryable: true,
      cause: error,
    })
  }

  if (response.ok) return response

  const text = new TextDecoder().decode(await providerBytes(provider, response))
  let details: unknown = text
  if (text) {
    try {
      details = JSON.parse(text) as unknown
    } catch {
      details = text
    }
  }

  const message = responseMessage(details, `${provider} request failed with HTTP ${response.status}`)
  const options: ProviderErrorOptions = {
    status: response.status,
    details,
    retryAfter: retryAfterSeconds(response.headers.get('retry-after')),
  }

  if (response.status === 401) throw new ProviderAuthenticationError(provider, message, options)
  if (response.status === 403) {
    const reasons = typeof details === 'object' && details !== null
      ? (details as { error?: { errors?: Array<{ reason?: string }> } }).error?.errors
      : undefined
    if (provider === 'gmail' && Array.isArray(reasons) && reasons.some((error) =>
      error && ['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded', 'quotaExceeded'].includes(error.reason ?? ''))) {
      throw new ProviderRateLimitError(provider, message, options)
    }
    throw new ProviderAuthorizationError(provider, message, options)
  }
  if (response.status === 404) throw new ProviderNotFoundError(provider, message, options)
  if (response.status === 429) throw new ProviderRateLimitError(provider, message, options)
  if (response.status === 400 || response.status === 422) {
    throw new ProviderError(provider, 'VALIDATION', message, options)
  }
  throw new ProviderError(provider, 'UPSTREAM', message, {
    ...options,
    retryable: response.status === 408 || response.status === 409 || response.status >= 500,
  })
}

export async function providerJson<T>(
  provider: InboxProviderType,
  fetcher: typeof globalThis.fetch,
  url: string,
  init: RequestInit = {},
  timeoutMs?: number,
): Promise<T> {
  const response = await providerRequest(provider, fetcher, url, init, timeoutMs)
  if (response.status === 204 || response.headers.get('content-length') === '0') return undefined as T
  const body = new TextDecoder().decode(await providerBytes(provider, response))
  if (!body.trim()) return undefined as T
  try {
    return JSON.parse(body) as T
  } catch (error) {
    throw new ProviderError(provider, 'UPSTREAM', `${provider} returned invalid JSON`, {
      status: response.status,
      cause: error,
    })
  }
}

export async function providerBytes(provider: InboxProviderType, response: Response): Promise<Uint8Array> {
  try {
    return new Uint8Array(await response.arrayBuffer())
  } catch (cause) {
    throw new ProviderError(provider, 'NETWORK', `${provider} response body was interrupted`, {
      status: response.status,
      retryable: true,
      cause,
    })
  }
}
