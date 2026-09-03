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
  parseParticipant,
  parseParticipants,
  previewText,
  providerBytes,
  providerJson,
  providerRequest,
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
import type { ConnectionSources, MailScope, MailSource } from './mail-sources'

export interface InboundCredentials extends ProviderCredentials {
  apiKey: string
  address?: string
  domain?: string
  connectionMode?: boolean
  sdkMailboxScopes?: MailScope[]
}

type SourcedMessage = MailMessage & { sourceDomains?: string[]; deliveryRecipients?: string[] }

interface SnapshotSource {
  params: URLSearchParams
  domain?: string
  address?: string
  ids: string[]
  total?: number
  seed?: InboundEmailList
  complete: boolean
}

interface SnapshotEntry {
  summary: InboundEmail
  domain?: string
}

interface InboundSnapshot {
  scope: string
  folder?: MailFolder
  expiresAt: number
  connectionMode: boolean
  sources: SnapshotSource[]
  entries: Array<SnapshotEntry | null>
  seen: Set<string>
  bytes: number
  nextSource: number
  pending?: Promise<void>
  threads?: SnapshotEntry[][]
}

const SNAPSHOT_TTL_MS = 15 * 60_000
const MAX_SNAPSHOTS = 4
const MAX_SNAPSHOT_ITEMS = 10_000
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024
const MAX_SCAN_PAGES = 200
const MAX_MAILBOX_SCOPE_INPUTS = 5_000
const MAX_RECEIVING_SOURCES = 1_000
const SOURCE_HEAD_CONCURRENCY = 4

type MessageEvidence = Pick<InboundEmail, 'is_archived' | 'envelope_recipient' | 'thread_id' | 'message_id' | 'from_name'> & { domain?: string }

interface InboundAttachment {
  id?: string
  filename?: string
  name?: string
  contentType?: string
  content_type?: string
  size?: number
  contentId?: string | null
  content_id?: string | null
  inline?: boolean
}

interface InboundEmail {
  id: string
  thread_id?: string | null
  from?: string
  from_address?: string | null
  from_name?: string | null
  to?: string | string[] | null
  cc?: string | string[] | null
  bcc?: string | string[] | null
  reply_to?: string | string[] | null
  message_id?: string | null
  headers?: Record<string, unknown>
  envelope_recipient?: string | null
  subject?: string | null
  preview?: string | null
  text?: string | null
  text_body?: string | null
  html?: string | null
  html_body?: string | null
  created_at?: string
  received_at?: string | null
  sent_at?: string | null
  date?: string | null
  scheduled_at?: string | null
  type?: 'received' | 'sent' | 'scheduled' | 'inbound' | 'outbound'
  status?: string
  is_read?: boolean
  is_archived?: boolean
  has_attachments?: boolean
  attachments?: InboundAttachment[]
}

interface InboundEmailList {
  data: InboundEmail[]
  pagination: { has_more: boolean; limit: number; offset: number; total: number }
}

interface InboundThreadDetail {
  messages: InboundEmail[]
  thread: {
    id: string
    normalized_subject?: string | null
    last_message_at: string
    message_count: number
    participant_emails?: string[]
    participant_names?: string[]
    is_archived?: boolean
  }
}

const INBOUND_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  sync: true,
  incrementalSync: false,
  deltaSync: false,
  send: true,
  reply: true,
  threads: true,
  nativeThreads: true,
  folders: false,
  createFolders: false,
  labels: false,
  archive: true,
  trash: false,
  permanentDelete: false,
  markRead: true,
  markUnread: true,
  star: false,
  attachments: true,
  attachmentDownload: true,
  search: true,
  drafts: false,
  scheduledSend: true,
  snooze: false,
  readReceipts: false,
  pushNotifications: false,
})

function inboundFolder(email: InboundEmail): MailFolder {
  if (email.type === 'scheduled' || email.status === 'scheduled') return 'scheduled'
  if (email.type === 'sent' || email.type === 'outbound') return 'sent'
  return email.is_archived ? 'archive' : 'inbox'
}

export class InboundProvider implements InboxProvider {
  readonly type = 'inbound' as const
  readonly accountId: string
  readonly capabilities = INBOUND_CAPABILITIES
  private readonly credentials: InboundCredentials
  private readonly baseUrl: string
  private readonly fetcher: typeof globalThis.fetch
  private readonly timeoutMs: number
  private nextRequestAt = 0
  private sources: ConnectionSources | undefined
  private sourceDiscovery: Promise<ConnectionSources> | undefined
  private sourcesExpireAt = 0
  private envelopeRecipients = false
  private readonly requests = new AbortController()
  private readonly snapshots = new Map<string, InboundSnapshot>()
  private headPin: Promise<void> | undefined
  private readonly evidence = new Map<string, MessageEvidence>()
  private evidenceBytes = 0

  constructor(credentials: InboundCredentials) {
    if (!credentials.accountId || !credentials.apiKey) {
      throw new ProviderError('inbound', 'VALIDATION', 'Inbound requires an account ID and API key')
    }
    if (credentials.sdkMailboxScopes !== undefined && (!Array.isArray(credentials.sdkMailboxScopes) ||
      credentials.sdkMailboxScopes.length > MAX_MAILBOX_SCOPE_INPUTS ||
      credentials.sdkMailboxScopes.some((scope) => !scope || !['domain', 'address'].includes(scope.kind) ||
        typeof scope.value !== 'string' || !scope.value.trim() || scope.value.length > 320))) {
      throw new ProviderError('inbound', 'VALIDATION', 'Inbound mailbox scopes must contain at most 5000 explicit domain or address selectors')
    }
    this.credentials = {
      ...credentials,
      ...(credentials.sdkMailboxScopes === undefined ? {} : {
        connectionMode: true,
        sdkMailboxScopes: credentials.sdkMailboxScopes.map((scope) => ({ kind: scope.kind, value: scope.value.trim().toLowerCase() })),
      }),
    }
    this.accountId = credentials.accountId
    this.baseUrl = (credentials.baseUrl ?? 'https://inbound.new/api/e2').replace(/\/$/, '')
    this.fetcher = credentials.fetch ?? globalThis.fetch
    this.timeoutMs = Number.isFinite(credentials.timeoutMs)
      ? Math.min(30_000, Math.max(1, Math.trunc(credentials.timeoutMs!)))
      : 30_000
  }

  private headers(init: RequestInit = {}): Headers {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${this.credentials.apiKey}`)
    headers.set('Accept', 'application/json')
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    return headers
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const signal = init.signal ? AbortSignal.any([init.signal, this.requests.signal]) : this.requests.signal
    const cancelled = () => new ProviderError('inbound', 'NETWORK', this.requests.signal.aborted
      ? 'Inbound provider is disconnected' : 'Inbound request was cancelled', { retryable: true })
    if (signal.aborted) throw cancelled()
    if (this.credentials.connectionMode) {
      // E2 allows ten requests/second per owner; preserve Retry-After for the sync scheduler.
      const now = Date.now()
      const scheduled = Math.max(now, this.nextRequestAt)
      this.nextRequestAt = scheduled + 110
      if (scheduled > now) await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(cancelled()) }
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, scheduled - now)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })
    }
    if (signal.aborted) throw cancelled()
    const result = await providerJson<T>(
      'inbound',
      this.fetcher,
      `${this.baseUrl}${path}`,
      {
        ...init, headers: this.headers(init),
        signal,
      },
      this.timeoutMs,
    )
    if (signal.aborted) throw cancelled()
    return result
  }

  private addressFilter(params: URLSearchParams): void {
    if (this.credentials.connectionMode) return
    const address = this.credentials.address ?? this.credentials.email
    if (address) params.set('address', address)
    if (this.credentials.domain) params.set('domain', this.credentials.domain)
  }

  async getMailSources(): Promise<ConnectionSources> {
    if (this.sources && Date.now() < this.sourcesExpireAt) return structuredClone(this.sources)
    if (!this.sourceDiscovery) {
      this.sourceDiscovery = (async () => {
        const records: Record<string, unknown>[][] = []
        let envelopeRecipients = true
        for (const path of ['/domains', '/email-addresses']) {
          const items: Record<string, unknown>[] = []
          let offset = 0
          for (;;) {
            const page = await this.request<{
              data: Record<string, unknown>[]
              pagination: { hasMore: boolean; offset: number; limit: number; total: number }
              capabilities?: { envelopeRecipients?: boolean }
            }>(`${path}?limit=100&offset=${offset}`)
            if (!page || !Array.isArray(page.data) || !page.pagination ||
              typeof page.pagination.hasMore !== 'boolean' ||
              !Number.isSafeInteger(page.pagination.limit) || page.pagination.limit < 1 || page.pagination.limit > 100 ||
              !Number.isSafeInteger(page.pagination.total) || page.pagination.total < 0 ||
              page.data.length > page.pagination.limit ||
              page.data.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
              throw new ProviderError('inbound', 'UPSTREAM', 'Inbound returned an invalid mail source listing')
            }
            if (page.pagination.offset !== offset ||
              (page.pagination.hasMore && (!page.data.length || offset + page.data.length >= page.pagination.total)) ||
              !Number.isSafeInteger(offset + page.pagination.limit)) {
              throw new ProviderCursorExpiredError('inbound', 'Inbound returned a non-advancing source offset')
            }
            if (path === '/domains') envelopeRecipients &&= page.capabilities?.envelopeRecipients === true
            items.push(...page.data)
            if (!page.pagination.hasMore) break
            offset += page.pagination.limit
          }
          records.push(items)
        }
        const sources = new Map<string, MailSource>()
        const domains = new Map<string, MailSource>()
        for (const domain of records[0]!) {
          if (typeof domain.id !== 'string' || typeof domain.domain !== 'string' ||
            !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(domain.domain.trim())) {
            throw new ProviderError('inbound', 'UPSTREAM', 'Inbound returned an invalid source domain')
          }
          const source: MailSource = {
            kind: 'domain', value: domain.domain.trim().toLowerCase(),
            canReceive: domain.canReceiveEmails === true,
            canSend: domain.status === 'verified',
            canFilter: true,
          }
          domains.set(domain.id, source)
          sources.set(`domain:${source.value}`, source)
        }
        for (const address of records[1]!) {
          if (typeof address.address !== 'string' || !/^[^\s@<>]+@[^\s@<>]+$/.test(address.address.trim())) {
            throw new ProviderError('inbound', 'UPSTREAM', 'Inbound returned an invalid source address')
          }
          const value = address.address.trim().toLowerCase()
          const domain = typeof address.domainId === 'string' ? domains.get(address.domainId) : undefined
          // Only exact owner-listed domains grant a source; never infer one from To or participant data.
          const exactDomain = domain?.value === value.split('@')[1] ? domain : undefined
          sources.set(`address:${value}`, {
            kind: 'address', value,
            canReceive: Boolean(exactDomain?.canReceive && address.isActive === true && address.isReceiptRuleConfigured === true),
            canSend: Boolean(exactDomain?.canSend && address.isActive === true),
            canFilter: envelopeRecipients,
            ...(!envelopeRecipients ? {
              unavailableReason: 'This Inbound API does not expose envelope recipients. Exact-address filtering requires an upstream API update.',
            } : {}),
          })
        }
        const result: ConnectionSources = {
          sources: [...sources.values()],
          identities: [...sources.values()].filter((source) => source.kind === 'address' && source.canSend)
            .map((source) => ({ email: source.value })),
        }
        this.sources = result
        this.envelopeRecipients = envelopeRecipients
        this.sourcesExpireAt = Date.now() + 60_000
        return result
      })()
    }
    try {
      return structuredClone(await this.sourceDiscovery)
    } finally {
      this.sourceDiscovery = undefined
    }
  }

  private normalizeAttachment(attachment: InboundAttachment, messageId: string): Attachment {
    const filename = [attachment.filename, attachment.name, attachment.id]
      .find((value): value is string => typeof value === 'string' && value.length > 0) ?? 'attachment'
    const contentId = [attachment.contentId, attachment.content_id]
      .find((value): value is string => typeof value === 'string' && value.length > 0)
    const contentType = [attachment.contentType, attachment.content_type]
      .find((value): value is string => typeof value === 'string' && value.length > 0)
    return {
      // The API identifies attachments by filename rather than an opaque attachment ID.
      id: filename,
      filename,
      contentType: contentType ?? 'application/octet-stream',
      size: Number.isSafeInteger(attachment.size) && attachment.size! >= 0 ? attachment.size! : 0,
      url: attachmentUrl(this.accountId, messageId, filename),
      ...(attachment.inline || contentId ? { inline: true } : {}),
      ...(contentId ? { contentId } : {}),
    }
  }

  private normalize(email: InboundEmail, threadId?: string, sourceDomain?: string, connectionMode = this.credentials.connectionMode): SourcedMessage {
    email = { ...this.evidence.get(email.id), ...email }
    const headers: Record<string, string> = Object.fromEntries(Object.entries(
      email.headers && typeof email.headers === 'object' && !Array.isArray(email.headers) ? email.headers : {},
    ).flatMap(([name, value]) => {
      const text = typeof value === 'string' ? value : Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string').join('\n') : undefined
      return text === undefined ? [] : [[name.toLowerCase(), text]]
    }))
    const bodyHtml = typeof email.html === 'string'
      ? email.html
      : typeof email.html_body === 'string' ? email.html_body : ''
    const text = typeof email.text === 'string' ? email.text : ''
    const textBody = typeof email.text_body === 'string' ? email.text_body : ''
    const bodyText = text || textBody || htmlToPlainText(bodyHtml)
    const sender = typeof email.from_address === 'string' && email.from_address
      ? {
        name: typeof email.from_name === 'string' && email.from_name ? email.from_name : email.from_address,
        email: email.from_address,
      }
      : parseParticipant(typeof email.from === 'string' ? email.from : undefined)
    if (email.from_name && (!sender.name || sender.name === sender.email)) sender.name = email.from_name
    const formattedSender = parseParticipant(email.from)
    if (formattedSender.email.toLowerCase() === sender.email.toLowerCase() && sender.name === sender.email) sender.name = formattedSender.name
    const namedSender = parseParticipant(headers.from)
    if (namedSender.email && namedSender.email.toLowerCase() === sender.email.toLowerCase() && (!sender.name || sender.name === sender.email)) {
      sender.name = namedSender.name
    }
    const outbound = email.type === 'sent' || email.type === 'outbound' || email.type === 'scheduled'
    const senderDomain = sender.email.toLowerCase().split('@')[1]
    const authorizedSenderDomain = outbound && this.sources?.sources.some((source) =>
      source.kind === 'domain' && source.value === senderDomain)
    const deliveryRecipient = connectionMode && this.envelopeRecipients &&
      (email.type === 'received' || email.type === 'inbound') && typeof email.envelope_recipient === 'string' &&
      /^[^\s@<>,;]+@[^\s@<>,;]+$/.test(email.envelope_recipient.trim())
      ? email.envelope_recipient.trim().toLowerCase() : undefined
    const recipientDomain = deliveryRecipient?.split('@')[1]
    const authorizedRecipientDomain = recipientDomain && this.sources?.sources.some((source) =>
      source.kind === 'domain' && source.value === recipientDomain)
    const knownSourceDomain = sourceDomain ?? this.evidence.get(email.id)?.domain ?? (authorizedSenderDomain ? senderDomain
      : authorizedRecipientDomain ? recipientDomain : undefined)
    const participants = (value: InboundEmail['to'], header: string) => {
      const named = parseParticipants(headers[header])
      if (value === undefined) return named
      const parsed = parseParticipants(typeof value === 'string' ? value
        : Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined)
      // Headers enrich display names, not structured recipient lists or delivery evidence.
      return parsed.map(person => {
        const match = named.find(item => item.email.toLowerCase() === person.email.toLowerCase())
        return match && (!person.name || person.name === person.email) ? { ...person, name: match.name } : person
      })
    }
    const rfcMessageId = (typeof email.message_id === 'string' ? email.message_id.trim() : '') || headers['message-id']?.trim()
    const inReplyTo = headers['in-reply-to']?.trim()
    return {
      id: email.id,
      threadId: threadId ?? email.thread_id ?? email.id,
      accountId: this.accountId,
      ...(connectionMode && knownSourceDomain ? { sourceDomains: [knownSourceDomain] } : {}),
      ...(deliveryRecipient ? { deliveryRecipients: [deliveryRecipient] } : {}),
      from: sender,
      to: participants(email.to, 'to'),
      cc: participants(email.cc, 'cc'),
      bcc: participants(email.bcc, 'bcc'),
      replyTo: participants(email.reply_to, 'reply-to'),
      ...(rfcMessageId ? { rfcMessageId } : {}),
      ...(inReplyTo ? { inReplyTo } : {}),
      references: headers.references?.match(/<[^>]+>/g) ?? [],
      ...(Object.keys(headers).length ? { headers } : {}),
      subject: typeof email.subject === 'string' ? email.subject : '',
      preview: typeof email.preview === 'string' ? email.preview : previewText(bodyText || bodyHtml),
      bodyText,
      bodyHtml,
      receivedAt: normalizeDate(email.received_at ?? email.sent_at ?? email.date ?? email.created_at),
      isRead: typeof email.is_read === 'boolean' ? email.is_read : outbound,
      isStarred: false,
      folder: inboundFolder(email),
      folderIds: [inboundFolder(email)],
      labels: [],
      attachments: (Array.isArray(email.attachments) ? email.attachments : [])
        .filter((attachment): attachment is InboundAttachment =>
          attachment !== null && typeof attachment === 'object' && !Array.isArray(attachment))
        .map((attachment) => this.normalizeAttachment(attachment, email.id)),
      ...(typeof email.scheduled_at === 'string' && email.scheduled_at ? { scheduledAt: email.scheduled_at } : {}),
    }
  }

  private assertOwnedMessage(email: InboundEmail): void {
    // Connection mode relies on the API's authenticated owner check, not untrusted header recipients.
    if (this.credentials.connectionMode) return
    const configured = this.credentials.address?.includes('@')
      ? this.credentials.address
      : this.credentials.email
    if (!configured) return

    const normalized = this.normalize(email)
    const outbound = email.type === 'sent' || email.type === 'outbound' || email.type === 'scheduled'
    const addresses = outbound
      ? [normalized.from.email]
      : [...normalized.to, ...normalized.cc, ...normalized.bcc].map((participant) => participant.email)
    if (!addresses.some((address) => address.toLowerCase() === configured.toLowerCase())) {
      throw new ProviderNotFoundError('inbound', 'Message was not found for this mailbox address')
    }
  }

  private async emailPage(path: string, expectedOffset: number, signal?: AbortSignal): Promise<InboundEmailList> {
    const result = await this.request<InboundEmailList>(path, { signal })
    if (!result || typeof result !== 'object' || !Array.isArray(result.data) ||
      !result.pagination || typeof result.pagination !== 'object' ||
      typeof result.pagination.has_more !== 'boolean' ||
      !Number.isSafeInteger(result.pagination.limit) || result.pagination.limit < 1 ||
      result.pagination.limit > 100 || !Number.isSafeInteger(result.pagination.offset) ||
      result.pagination.offset < 0 || !Number.isSafeInteger(result.pagination.total) ||
      result.pagination.total < 0 || result.data.some((email) =>
        !email || typeof email !== 'object' || typeof email.id !== 'string' || !email.id)) {
      throw new ProviderError('inbound', 'UPSTREAM', 'Inbound returned an invalid email listing')
    }
    if (result.pagination.offset !== expectedOffset ||
      (result.pagination.has_more && result.data.length === 0) ||
      (result.pagination.has_more && !Number.isSafeInteger(expectedOffset + result.pagination.limit))) {
      throw new ProviderCursorExpiredError('inbound', 'Inbound returned a non-advancing pagination offset')
    }
    return result
  }

  private async getRawMessage(messageId: string, connectionMode = this.credentials.connectionMode): Promise<InboundEmail> {
    const email = await this.request<InboundEmail>(`/emails/${encodeURIComponent(messageId)}`)
    if (!email || typeof email !== 'object' || typeof email.id !== 'string' || email.id !== messageId) {
      throw new ProviderError('inbound', 'UPSTREAM', 'Inbound returned an invalid email message')
    }
    if (!connectionMode) this.assertOwnedMessage(email)
    this.remember(email)
    return { ...this.evidence.get(messageId), ...email }
  }

  private remember(email: InboundEmail, domain?: string): void {
    if (this.requests.signal.aborted) throw new ProviderError('inbound', 'NETWORK', 'Inbound provider is disconnected', { retryable: true })
    if (email.id.length > 2048) throw new ProviderError('inbound', 'UPSTREAM', 'Inbound returned an oversized message identifier')
    const previous = this.evidence.get(email.id) ?? {}
    const evidence: MessageEvidence = { ...previous }
    for (const key of ['is_archived', 'envelope_recipient', 'thread_id', 'message_id', 'from_name'] as const) {
      const value = email[key]
      if (value !== undefined) {
        if (typeof value === 'string' && value.length > 2048) throw new ProviderError('inbound', 'UPSTREAM', 'Inbound returned oversized message metadata')
        Object.assign(evidence, { [key]: value })
      }
    }
    const recipient = this.deliveryRecipient(email)
    if (recipient && evidence.domain !== recipient.split('@')[1]) delete evidence.domain
    if (domain) evidence.domain = domain
    if (this.evidence.has(email.id)) this.evidenceBytes -= (JSON.stringify(previous).length + email.id.length) * 2
    this.evidence.delete(email.id)
    this.evidence.set(email.id, evidence)
    this.evidenceBytes += (JSON.stringify(evidence).length + email.id.length) * 2
    while (this.evidence.size > MAX_SNAPSHOT_ITEMS || this.evidenceBytes > MAX_SNAPSHOT_BYTES) {
      const [id, value] = this.evidence.entries().next().value!
      this.evidenceBytes -= (JSON.stringify(value).length + id.length) * 2
      this.evidence.delete(id)
    }
  }

  private snapshotSummary(email: InboundEmail): InboundEmail {
    const summary: InboundEmail = { id: email.id }
    if (email.id.length > 2048) throw new ProviderError('inbound', 'UPSTREAM', 'Inbound returned an oversized message identifier')
    for (const key of ['type', 'thread_id', 'created_at', 'received_at', 'sent_at', 'is_read', 'is_archived', 'envelope_recipient', 'message_id', 'from_name'] as const) {
      const value = email[key]
      if (value === undefined) continue
      if (key === 'is_read' || key === 'is_archived' ? typeof value !== 'boolean'
        : value !== null && (typeof value !== 'string' || value.length > 2048)) {
        throw new ProviderError('inbound', 'UPSTREAM', 'Inbound returned invalid snapshot metadata')
      }
      Object.assign(summary, { [key]: value })
    }
    return summary
  }

  private assertFolder(folder: MailFolder | undefined): void {
    if (folder && !['inbox', 'archive', 'sent', 'scheduled'].includes(folder)) {
      throw new UnsupportedOperationError('inbound', `the ${folder} folder`)
    }
  }

  private mailboxScopes(options: ListOptions = {}): MailScope[] | undefined {
    const scopes = options.mailboxScopes ?? this.credentials.sdkMailboxScopes
    if (scopes === undefined) return undefined
    if (!Array.isArray(scopes) || scopes.length > MAX_MAILBOX_SCOPE_INPUTS || scopes.some(scope => !scope ||
      !['domain', 'address'].includes(scope.kind) || typeof scope.value !== 'string' || !scope.value.trim() || scope.value.length > 320)) {
      throw new ProviderError('inbound', 'VALIDATION', 'Inbound mailbox scopes must contain at most 5000 explicit domain or address selectors')
    }
    return [...new Map(scopes.map(scope => {
      const value = { kind: scope.kind, value: scope.value.trim().toLowerCase() }
      return [`${value.kind}:${value.value}`, value] as const
    })).values()].sort((a, b) => `${a.kind}:${a.value}`.localeCompare(`${b.kind}:${b.value}`))
  }

  private async receivingSources(scopes: MailScope[] | undefined): Promise<MailSource[]> {
    const discovery = await this.getMailSources()
    const grants = new Map(discovery.sources.map(source => [`${source.kind}:${source.value}`, source]))
    const selected = scopes === undefined ? discovery.sources.filter(source => source.kind === 'domain')
      : scopes.map(scope => {
        const source = grants.get(`${scope.kind}:${scope.value}`)
        if (!source) throw new ProviderAuthorizationError('inbound', 'The selected mailbox source is no longer authorized')
        if (source.kind === 'address' && source.canFilter !== true) {
          throw new UnsupportedOperationError('inbound', 'exact-address filtering for the selected mailbox')
        }
        return source
      })
    return selected.filter(source => source.canReceive && source.canFilter !== false)
  }

  private async pinSnapshotHeads(snapshot: InboundSnapshot): Promise<void> {
    // Limit heads across concurrent queries too; a failed batch must not poison the next one.
    while (this.headPin) await this.headPin.catch(() => {})
    if (this.requests.signal.aborted) throw new ProviderError('inbound', 'NETWORK', 'Inbound provider is disconnected', { retryable: true })
    const cancel = new AbortController()
    const signal = AbortSignal.any([cancel.signal, this.requests.signal])
    let nextSource = 0
    let total = 0
    let failure: { error: unknown } | undefined
    const worker = async () => {
      while (!signal.aborted) {
        const source = snapshot.sources[nextSource++]
        if (!source) return
        try {
          const params = new URLSearchParams(source.params)
          params.set('offset', '0'); params.set('limit', '1')
          const seed = await this.emailPage(`/emails?${params}`, 0, signal)
          if (seed.pagination.limit !== 1 || seed.data.length !== Math.min(1, seed.pagination.total) ||
            seed.pagination.has_more !== (seed.pagination.total > 1)) {
            throw new ProviderCursorExpiredError('inbound', 'Inbound returned inconsistent snapshot totals')
          }
          total += seed.pagination.total
          if (total > MAX_SNAPSHOT_ITEMS) throw new ProviderError('inbound', 'UPSTREAM', 'Inbound snapshot exceeds 10000 records; select a narrower scope')
          const pinned = { data: seed.data.map(email => this.snapshotSummary(email)), pagination: {
            offset: 0, limit: 1, total: seed.pagination.total, has_more: seed.pagination.has_more,
          } }
          // Reserve head metadata for the snapshot lifetime, even after a seed is consumed.
          const bytes = JSON.stringify(pinned).length * 2
          if (snapshot.bytes + bytes > MAX_SNAPSHOT_BYTES) {
            throw new ProviderError('inbound', 'UPSTREAM', 'Inbound snapshot exceeded its bounded metadata cache')
          }
          snapshot.bytes += bytes
          source.total = seed.pagination.total
          source.seed = pinned
          source.complete = source.total === 0
        } catch (error) {
          failure ??= { error }
          cancel.abort()
        }
      }
    }
    // Only the fixed worker set is eager, not one promise (or paced timer) per source.
    const pending = Promise.all(Array.from({ length: Math.min(SOURCE_HEAD_CONCURRENCY, snapshot.sources.length) }, worker)).then(() => {
      if (failure) throw failure.error
      if (signal.aborted) throw new ProviderError('inbound', 'NETWORK', 'Inbound provider is disconnected', { retryable: true })
    })
    this.headPin = pending
    try { await pending } finally { if (this.headPin === pending) this.headPin = undefined }
  }

  private async snapshotFor(kind: 'messages' | 'threads', options: ListOptions) {
    this.assertFolder(options.folder)
    if (this.requests.signal.aborted) throw new ProviderError('inbound', 'NETWORK', 'Inbound provider is disconnected', { retryable: true })
    for (const [key, value] of this.snapshots) if (value.expiresAt <= Date.now()) this.snapshots.delete(key)
    let token = crypto.randomUUID() as string
    let offset = 0
    let snapshot: InboundSnapshot | undefined
    if (options.cursor !== undefined && options.cursor !== null) {
      try {
        if (options.cursor.length > 128) throw new Error()
        const value: unknown = JSON.parse(options.cursor)
        if (!Array.isArray(value) || value.length !== 3 || value[0] !== 2 || typeof value[1] !== 'string' ||
          !Number.isSafeInteger(value[2]) || value[2] < 0 || value[2] > MAX_SNAPSHOT_ITEMS) throw new Error()
        token = value[1]; offset = value[2]
        snapshot = this.snapshots.get(token)
        if (!snapshot) throw new Error()
      } catch { throw new ProviderCursorExpiredError('inbound', 'Inbound snapshot expired or belongs to another provider instance') }
    }
    const scopes = this.mailboxScopes(options)
    const connectionMode = Boolean(this.credentials.connectionMode || scopes !== undefined)
    const sources: SnapshotSource[] = []
    let descriptorBytes = 0
    const add = (type?: string, domain?: string, address?: string) => {
      const params = new URLSearchParams({ time_range: 'all' })
      if (type) params.set('type', type)
      if (domain) params.set('domain', domain)
      if (address) params.set('address', address)
      if (!connectionMode) this.addressFilter(params)
      if (options.search) params.set('search', options.search)
      if (options.folder === 'archive') params.set('status', 'archived')
      else if (options.unreadOnly) params.set('status', 'unread')
      descriptorBytes += JSON.stringify({ params: params.toString(), domain, address, ids: [],
        total: MAX_SNAPSHOT_ITEMS, complete: false }).length * 2
      if (descriptorBytes > MAX_SNAPSHOT_BYTES) {
        throw new ProviderError('inbound', 'UPSTREAM', 'Inbound snapshot exceeded its bounded metadata cache')
      }
      sources.push({ params, domain, address, ids: [], complete: false })
    }
    if (connectionMode) {
      const receiving = await this.receivingSources(scopes)
      const domains = new Set(receiving.filter(source => source.kind === 'domain').map(source => source.value))
      if (options.folder !== 'sent' && options.folder !== 'scheduled') {
        for (const source of receiving) {
          if (source.kind === 'address' && domains.has(source.value.split('@')[1]!)) continue
          if (sources.length >= MAX_RECEIVING_SOURCES) {
            throw new ProviderError('inbound', 'VALIDATION', 'Select at most 1000 Inbound receiving sources per snapshot')
          }
          if (source.kind === 'domain') add('received', source.value)
          else add('received', source.value.split('@')[1], source.value)
        }
      }
      // Receiving selectors never grant membership to an outbound record merely because its sender matches.
      if (scopes === undefined) {
        if (!options.folder || options.folder === 'sent') add('sent')
        if (!options.folder || options.folder === 'scheduled') add('scheduled')
      }
    } else {
      add(options.folder === 'sent' || options.folder === 'scheduled' ? options.folder : options.folder ? 'received' : undefined)
    }
    sources.sort((a, b) => a.params.toString().localeCompare(b.params.toString()))
    const scope = JSON.stringify([this.accountId, kind, connectionMode, scopes ?? null, options.folder ?? null,
      options.search ?? null, options.unreadOnly ?? false, sources.map(source => source.params.toString())])
    const bytes = descriptorBytes + scope.length * 2
    if (bytes > MAX_SNAPSHOT_BYTES) throw new ProviderError('inbound', 'UPSTREAM', 'Inbound snapshot exceeded its bounded metadata cache')
    if (snapshot) {
      if (snapshot.scope !== scope) throw new ProviderCursorExpiredError('inbound', 'Inbound snapshot query or receiving grants changed')
      snapshot.expiresAt = Date.now() + SNAPSHOT_TTL_MS
    } else {
      snapshot = { scope, folder: options.folder, connectionMode, sources, entries: [], seen: new Set(), bytes, nextSource: 0,
        expiresAt: Date.now() + SNAPSHOT_TTL_MS }
      // Pin every source head before returning the first page, without importing bodies or whole mailboxes.
      await this.pinSnapshotHeads(snapshot)
      if (this.requests.signal.aborted) throw new ProviderError('inbound', 'NETWORK', 'Inbound provider is disconnected', { retryable: true })
      snapshot.expiresAt = Date.now() + SNAPSHOT_TTL_MS
      while (this.snapshots.size >= MAX_SNAPSHOTS) this.snapshots.delete(this.snapshots.keys().next().value!)
      this.snapshots.set(token, snapshot)
    }
    return { snapshot, offset, next: (index: number) => JSON.stringify([2, token, index]) }
  }

  private async readSnapshotSource(snapshot: InboundSnapshot, source: SnapshotSource, size: number, budget: { requests: number }): Promise<void> {
    const pending: InboundEmail[] = []
    const known = new Set(source.ids)
    let pendingBytes = 0
    let offset = 0
    let skippedHeads = 0
    let matched = 0
    let foundHead = source.ids.length === 0
    let total: number | undefined
    for (;;) {
      const params = new URLSearchParams(source.params)
      params.set('offset', String(offset)); params.set('limit', '100')
      const seed = source.seed
      if (!seed && ++budget.requests > MAX_SCAN_PAGES) throw new ProviderCursorExpiredError('inbound', 'Inbound snapshot verification exceeded its bounded scan')
      const page = seed ?? await this.emailPage(`/emails?${params}`, offset)
      source.seed = undefined
      if (page.data.length > page.pagination.limit || (total !== undefined && total !== page.pagination.total) ||
        page.data.length !== Math.min(page.pagination.limit, page.pagination.total - offset) ||
        page.pagination.has_more !== (offset + page.data.length < page.pagination.total)) {
        throw new ProviderCursorExpiredError('inbound', 'Inbound snapshot changed during enumeration')
      }
      total = page.pagination.total
      for (const email of page.data) {
        if (!foundHead) {
          if (email.id !== source.ids[0]) { skippedHeads++; continue }
          foundHead = true
          if (total - skippedHeads !== source.total) throw new ProviderCursorExpiredError('inbound', 'Inbound snapshot membership changed')
        }
        if (matched < source.ids.length) {
          if (email.id !== source.ids[matched++]) throw new ProviderCursorExpiredError('inbound', 'Inbound snapshot prefix changed')
          continue
        }
        if (known.has(email.id)) {
          throw new ProviderCursorExpiredError('inbound', 'Inbound returned duplicate snapshot records')
        }
        known.add(email.id)
        const summary = this.snapshotSummary(email)
        pendingBytes += JSON.stringify(summary).length * 2
        if (snapshot.bytes + pendingBytes > MAX_SNAPSHOT_BYTES) throw new ProviderError('inbound', 'UPSTREAM', 'Inbound snapshot exceeded its bounded metadata cache')
        pending.push(summary)
        if (pending.length === size) break
      }
      if (pending.length === size || !page.pagination.has_more) break
      offset += page.pagination.limit
    }
    if (!foundHead || matched !== source.ids.length || !pending.length || source.ids.length + pending.length > source.total!) {
      throw new ProviderCursorExpiredError('inbound', 'Inbound snapshot ended before its pinned membership was enumerated')
    }
    for (const raw of pending) {
      if (source.domain && raw.type !== 'received') throw new ProviderError('inbound', 'UPSTREAM', 'Inbound returned a non-received email in a receiving listing')
      let email = raw
      if (source.address && !this.deliveryRecipient(email)) email = { ...raw, ...await this.getRawMessage(raw.id, true) }
      if (source.address && !this.deliveryRecipient(email)) {
        throw new ProviderError('inbound', 'UPSTREAM', 'Inbound omitted delivery evidence required to complete this address snapshot')
      }
      const summary = this.snapshotSummary(email)
      const bytes = JSON.stringify(summary).length * 2
      if (snapshot.entries.length >= MAX_SNAPSHOT_ITEMS || snapshot.bytes + bytes > MAX_SNAPSHOT_BYTES) {
        throw new ProviderError('inbound', 'UPSTREAM', 'Inbound snapshot exceeded its bounded metadata cache')
      }
      const recipient = this.deliveryRecipient(summary)
      const domainMatches = !source.domain || !recipient || recipient.split('@')[1] === source.domain
      this.remember(summary, domainMatches ? source.domain : undefined)
      source.ids.push(summary.id)
      snapshot.bytes += bytes
      const matches = domainMatches && (!source.address || recipient === source.address) &&
        !(summary.is_archived && snapshot.folder === 'inbox')
      if (!matches || snapshot.seen.has(summary.id)) snapshot.entries.push(null)
      else {
        snapshot.seen.add(summary.id)
        snapshot.entries.push({ summary, domain: source.domain })
      }
    }
    source.complete = source.ids.length === source.total
  }

  private deliveryRecipient(email: InboundEmail): string | undefined {
    return typeof email.envelope_recipient === 'string' && /^[^\s@<>,;]+@[^\s@<>,;]+$/.test(email.envelope_recipient.trim())
      ? email.envelope_recipient.trim().toLowerCase() : undefined
  }

  private async fillSnapshot(snapshot: InboundSnapshot, target: number): Promise<void> {
    while (snapshot.pending) await snapshot.pending
    const pending = (async () => {
      const budget = { requests: 0 }
      while (snapshot.entries.length < target && snapshot.sources.some(source => !source.complete)) {
        const index = snapshot.nextSource++ % snapshot.sources.length
        const source = snapshot.sources[index]!
        if (!source.complete) await this.readSnapshotSource(snapshot, source, Math.min(MAX_SNAPSHOT_ITEMS, target - snapshot.entries.length), budget)
      }
      if (this.requests.signal.aborted) throw new ProviderError('inbound', 'NETWORK', 'Inbound provider is disconnected', { retryable: true })
    })()
    snapshot.pending = pending
    try { await pending } finally { if (snapshot.pending === pending) snapshot.pending = undefined }
  }

  private async hydrate(entries: SnapshotEntry[], connectionMode: boolean): Promise<MailMessage[]> {
    const messages: MailMessage[] = []
    for (let start = 0; start < entries.length; start += 5) {
      const batch = await Promise.all(entries.slice(start, start + 5).map(async ({ summary, domain }) => {
        let full: InboundEmail
        try { full = await this.getRawMessage(summary.id, connectionMode) }
        catch (error) {
          if (error instanceof ProviderNotFoundError) throw new ProviderCursorExpiredError('inbound', 'An Inbound snapshot record is no longer readable')
          throw error
        }
        if (domain && full.type !== 'received') throw new ProviderError('inbound', 'UPSTREAM', 'Inbound returned a non-received email in a receiving snapshot')
        if (summary.envelope_recipient && this.deliveryRecipient(full) !== this.deliveryRecipient(summary)) {
          throw new ProviderCursorExpiredError('inbound', 'Inbound snapshot delivery evidence changed')
        }
        if (summary.thread_id && full.thread_id && summary.thread_id !== full.thread_id) {
          throw new ProviderCursorExpiredError('inbound', 'Inbound snapshot thread identity changed')
        }
        return this.normalize({ ...summary, ...full }, undefined, domain, connectionMode)
      }))
      messages.push(...batch)
    }
    return messages
  }

  async getAccount(): Promise<MailAccount> {
    if (this.credentials.connectionMode) await this.getMailSources()
    let unreadCount = 0
    if (this.credentials.sdkMailboxScopes === undefined) {
      const params = new URLSearchParams({ type: 'received', status: 'unread', limit: '1', offset: '0', time_range: 'all' })
      this.addressFilter(params)
      unreadCount = (await this.emailPage(`/emails?${params}`, 0)).pagination.total
    }
    const email = this.credentials.email ?? this.credentials.address ?? ''
    return createMailAccount('inbound', this.credentials, {
      email, name: this.credentials.name ?? (email || 'Inbound'), unreadCount,
    })
  }

  async listFolders(): Promise<ProviderFolder[]> {
    // These are application views, not server-managed folders; capabilities.folders remains false.
    return [
      { id: 'inbox', name: 'Inbox', folder: 'inbox' },
      { id: 'archive', name: 'Archive', folder: 'archive' },
      { id: 'sent', name: 'Sent', folder: 'sent' },
      { id: 'scheduled', name: 'Scheduled', folder: 'scheduled' },
    ]
  }

  async createFolder(_name: string): Promise<ProviderFolder> {
    throw new UnsupportedOperationError('inbound', 'folder creation')
  }

  async listMessages(options: ListOptions = {}): Promise<ProviderListResult<MailMessage>> {
    const cursor = await this.snapshotFor('messages', options)
    const { snapshot, offset } = cursor
    const limit = clampLimit(options.limit)
    if (offset > snapshot.entries.length) throw new ProviderCursorExpiredError('inbound', 'Invalid Inbound snapshot position')
    await this.fillSnapshot(snapshot, offset + limit)
    const end = Math.min(offset + limit, snapshot.entries.length)
    const items = await this.hydrate(snapshot.entries.slice(offset, end).filter((entry): entry is SnapshotEntry => entry !== null), snapshot.connectionMode)
    const hasMore = end < snapshot.entries.length || snapshot.sources.some(source => !source.complete)
    return {
      items: options.unreadOnly ? items.filter(message => !message.isRead) : items,
      nextCursor: hasMore ? cursor.next(end) : null,
      hasMore,
    }
  }

  async listThreads(options: ListOptions = {}): Promise<ProviderListResult<MailThread>> {
    const cursor = await this.snapshotFor('threads', options)
    const { snapshot, offset } = cursor
    const limit = clampLimit(options.limit, 25)
    if (!snapshot.threads) {
      await this.fillSnapshot(snapshot, MAX_SNAPSHOT_ITEMS + 1)
      const grouped = new Map<string, SnapshotEntry[]>()
      for (const entry of snapshot.entries) {
        if (!entry) continue
        if (entry.summary.thread_id === undefined) {
          const summary = this.snapshotSummary({ ...entry.summary,
            thread_id: (await this.getRawMessage(entry.summary.id, snapshot.connectionMode)).thread_id ?? null })
          const bytes = (JSON.stringify(summary).length - JSON.stringify(entry.summary).length) * 2
          if (snapshot.bytes + bytes > MAX_SNAPSHOT_BYTES) throw new ProviderError('inbound', 'UPSTREAM', 'Inbound snapshot exceeded its bounded metadata cache')
          snapshot.bytes += bytes
          entry.summary = summary
        }
        const id = entry.summary.thread_id ?? entry.summary.id
        const group = grouped.get(id) ?? []
        group.push(entry); grouped.set(id, group)
      }
      snapshot.threads = [...grouped.values()]
    }
    if (offset > snapshot.threads.length) throw new ProviderCursorExpiredError('inbound', 'Invalid Inbound thread snapshot position')
    const items: MailThread[] = []
    const end = Math.min(offset + limit, snapshot.threads.length)
    for (const group of snapshot.threads.slice(offset, end)) {
      const id = group[0]!.summary.thread_id
      if (!id) items.push(...buildThreads(await this.hydrate(group, snapshot.connectionMode)))
      else {
        const thread = await this.getThread(id, this.mailboxScopes(options))
        items.push(options.folder === 'archive' ? { ...thread, folder: 'archive' } : thread)
      }
    }
    return {
      items,
      nextCursor: end < snapshot.threads.length ? cursor.next(end) : null,
      hasMore: end < snapshot.threads.length,
      total: snapshot.threads.length,
    }
  }

  async getMessage(messageId: string): Promise<MailMessage> {
    if (this.credentials.connectionMode) await this.getMailSources()
    return this.normalize(await this.getRawMessage(messageId))
  }

  async getThread(threadId: string, mailboxScopes?: MailScope[]): Promise<MailThread> {
    if (this.credentials.connectionMode) await this.getMailSources()
    const scopes = this.mailboxScopes({ mailboxScopes })
    const receiving = scopes === undefined ? undefined : await this.receivingSources(scopes)
    const result = await this.request<InboundThreadDetail>(`/mail/threads/${encodeURIComponent(threadId)}`)
    if (!result || typeof result !== 'object' || !Array.isArray(result.messages) ||
      !result.thread || typeof result.thread !== 'object' || result.thread.id !== threadId ||
      result.messages.some((message) =>
        !message || typeof message !== 'object' || typeof message.id !== 'string' || !message.id)) {
      throw new ProviderError('inbound', 'UPSTREAM', 'Inbound returned an invalid email thread')
    }
    const seen = new Set<string>()
    const messages = result.messages.filter((message) => {
      if (seen.has(message.id)) return false
      seen.add(message.id)
      if (receiving === undefined) this.assertOwnedMessage(message)
      return true
    }).map((message) => {
      const archived = message.is_archived ?? this.evidence.get(message.id)?.is_archived ??
        (result.thread.is_archived && (message.type === 'received' || message.type === 'inbound') ? true : undefined)
      const merged = { ...message, ...(archived === undefined ? {} : { is_archived: archived }) }
      this.remember(merged)
      return { raw: message, normalized: this.normalize(merged, result.thread.id, undefined, Boolean(this.credentials.connectionMode || receiving !== undefined)) }
    }).filter(({ raw, normalized }) => {
      if (receiving === undefined) return true
      if (!receiving.length || (raw.type !== 'received' && raw.type !== 'inbound')) return false
      if (!normalized.deliveryRecipients?.length && !normalized.sourceDomains?.length) {
        throw new ProviderError('inbound', 'UPSTREAM', 'Inbound omitted delivery evidence required to scope this thread')
      }
      return receiving.some(source => source.kind === 'address'
        ? normalized.deliveryRecipients?.includes(source.value) : normalized.sourceDomains?.includes(source.value))
    }).map(message => message.normalized)
    const normalized = requireThread('inbound', messages, threadId)
    if (receiving !== undefined) return normalized
    return {
      ...normalized,
      subject: typeof result.thread.normalized_subject === 'string'
        ? result.thread.normalized_subject : normalized.subject,
      messageCount: Number.isSafeInteger(result.thread.message_count) && result.thread.message_count >= 0
        ? result.thread.message_count : normalized.messageCount,
      lastMessageAt: typeof result.thread.last_message_at === 'string'
        ? normalizeDate(result.thread.last_message_at) : normalized.lastMessageAt,
    }
  }

  async sync(cursor?: SyncCursor | string | null, options: SyncOptions = {}): Promise<SyncResult> {
    // Inbound exposes pagination and webhooks, but no replayable mailbox-history or delta API.
    const current = normalizeCursor('inbound', cursor, 'page')
    if (current && current.kind !== 'page') {
      throw new ProviderCursorExpiredError('inbound', 'Inbound supports only full-sync pagination cursors')
    }
    if (current?.metadata?.accountId && current.metadata.accountId !== this.accountId) {
      throw new ProviderCursorExpiredError('inbound', 'Inbound synchronization cursors belong to one account')
    }
    if (current?.folder && options.folder && current.folder !== options.folder) {
      throw new ProviderCursorExpiredError('inbound', 'Inbound pagination cursors cannot switch folders')
    }
    const mailboxScopes = options.mailboxScopes ?? this.credentials.sdkMailboxScopes
    const folder = options.folder ?? current?.folder ?? (mailboxScopes === undefined ? undefined : 'inbox')
    // Unscoped connection sync remains a whole-source refresh.
    const result = await this.listMessages({
      folder: this.credentials.connectionMode && mailboxScopes === undefined ? undefined : folder,
      limit: options.limit, cursor: current?.value, mailboxScopes,
    })
    return {
      messages: result.items,
      threads: buildThreads(result.items),
      deletedMessageIds: [],
      cursor: result.nextCursor
        ? { provider: 'inbound', kind: 'page', value: result.nextCursor, metadata: { accountId: this.accountId }, ...(folder ? { folder } : {}) }
        : null,
      hasMore: result.hasMore,
      fullSync: true,
      snapshotComplete: !result.hasMore,
    }
  }

  async send(input: SendInput): Promise<SendResult> {
    if (input.accountId !== undefined && input.accountId !== this.accountId) {
      throw new ProviderAuthorizationError('inbound', 'The message belongs to a different account')
    }
    const from = input.from ?? this.credentials.email ?? this.credentials.address
    const replyId = input.sourceMessageId ?? input.threadId
    if (!from) throw new ProviderError('inbound', 'VALIDATION', 'Inbound requires a verified sender email address')
    if (replyId && input.scheduledAt) {
      throw new UnsupportedOperationError('inbound', 'scheduling thread replies')
    }
    if (input.attachments?.some(attachment => attachment.inline && !attachment.contentId)) {
      throw new ProviderError('inbound', 'VALIDATION', 'Inbound inline attachments require an explicit Content-ID')
    }
    if ((replyId || input.scheduledAt) && input.attachments?.some(attachment => attachment.contentId)) {
      // These upstream paths omit Content-ID from their schema or stored attachment representation.
      throw new UnsupportedOperationError('inbound', 'inline attachments on replies or scheduled messages')
    }
    const configured = this.credentials.address?.includes('@')
      ? this.credentials.address
      : this.credentials.email
    if (!this.credentials.connectionMode && configured && parseParticipant(from).email.toLowerCase() !== configured.toLowerCase()) {
      throw new ProviderError('inbound', 'VALIDATION', 'Sender does not belong to this mailbox address')
    }
    const to = parseParticipants(input.to).map(formatParticipant)
    const cc = parseParticipants(input.cc).map(formatParticipant)
    const bcc = parseParticipants(input.bcc).map(formatParticipant)
    if (!to.length) {
      throw new ProviderError('inbound', 'VALIDATION', 'Inbound requires explicit recipient addresses')
    }
    // EmailReplyParams has no CC/BCC overrides. Never replace explicit lists with reply_all expansion.
    if (replyId && (cc.length || bcc.length)) {
      throw new UnsupportedOperationError('inbound', 'thread replies with explicit CC or BCC recipients')
    }
    if (this.credentials.connectionMode) {
      const discovery = await this.getMailSources()
      const sender = parseParticipant(from).email.toLowerCase()
      if (!discovery.identities.some((identity) => identity.email === sender)) {
        throw new ProviderError('inbound', 'VALIDATION', 'Sender is not a verified sending identity for this connection')
      }
    }
    if (configured || this.credentials.connectionMode) {
      if (input.sourceMessageId) await this.getRawMessage(input.sourceMessageId)
      else if (input.threadId) await this.getThread(input.threadId)
    }
    const attachments = input.attachments?.map((attachment) => ({
      filename: attachment.filename,
      content: attachmentContent(attachment).toString('base64'),
      ...(attachment.contentType ? { content_type: attachment.contentType } : {}),
      ...(attachment.contentId ? { content_id: attachment.contentId } : {}),
    }))
    const body: Record<string, unknown> = {
      from: formatParticipant(from),
      subject: input.subject,
      to,
      ...(input.bodyText ?? input.text ?? input.body ? { text: input.bodyText ?? input.text ?? input.body } : {}),
      ...(input.bodyHtml ?? input.html ? { html: input.bodyHtml ?? input.html } : {}),
      ...(attachments?.length ? { attachments } : {}),
      ...(input.headers ? { headers: input.headers } : {}),
    }
    if (cc.length) body.cc = cc
    if (bcc.length) body.bcc = bcc
    if (input.scheduledAt) body.scheduled_at = input.scheduledAt
    if (replyId) body.reply_all = false

    const path = replyId ? `/emails/${encodeURIComponent(replyId)}/reply` : '/emails'
    const sent = await this.request<{
      id: string
      message_id?: string
      scheduled_at?: string
      replied_to_thread_id?: string
    }>(path, { method: 'POST', body: JSON.stringify(body) })
    // A submission receipt is not necessarily a retrievable email ID, especially for scheduled mail.
    const providerMessageId = !sent.scheduled_at && !input.scheduledAt && typeof sent.id === 'string'
      ? await this.getRawMessage(sent.id).then((message) => message.id, () => undefined)
      : undefined
    return {
      id: sent.id,
      ...(providerMessageId ? { providerMessageId } : {}),
      ...(sent.replied_to_thread_id ?? input.threadId ? { threadId: sent.replied_to_thread_id ?? input.threadId } : {}),
      ...(sent.message_id ? { messageId: sent.message_id } : {}),
      ...(sent.scheduled_at ?? input.scheduledAt ? { scheduledAt: sent.scheduled_at ?? input.scheduledAt } : {}),
    }
  }

  async mutate(messageId: string, mutation: MessageMutation): Promise<MailMessage | null> {
    if (mutation.isStarred !== undefined) throw new UnsupportedOperationError('inbound', 'starring')
    if (mutation.addLabels?.length || mutation.removeLabels?.length) throw new UnsupportedOperationError('inbound', 'labels')
    if (mutation.snoozedUntil !== undefined) throw new UnsupportedOperationError('inbound', 'snoozing')
    if (mutation.deletePermanently) throw new UnsupportedOperationError('inbound', 'message deletion')
    if (mutation.folder && mutation.folder !== 'archive' && mutation.folder !== 'inbox') {
      throw new UnsupportedOperationError('inbound', `moving messages to ${mutation.folder}`)
    }
    if (this.credentials.connectionMode) await this.getMailSources()

    const body: { is_read?: boolean; is_archived?: boolean } = {}
    if (mutation.isRead !== undefined) body.is_read = mutation.isRead
    if (mutation.isArchived !== undefined) body.is_archived = mutation.isArchived
    if (mutation.folder) body.is_archived = mutation.folder === 'archive'
    if (!Object.keys(body).length) return this.getMessage(messageId)
    if (this.credentials.address?.includes('@') || this.credentials.email) {
      await this.getRawMessage(messageId)
    }

    // inboundemail@0.20 omits emails.update even though the documented PATCH endpoint exists.
    const updated = await this.request<{ id: string; is_read: boolean; is_archived: boolean }>(
      `/emails/${encodeURIComponent(messageId)}`,
      { method: 'PATCH', body: JSON.stringify(body) },
    )
    this.remember(updated)
    const message = await this.getRawMessage(messageId)
    return this.normalize({ ...message, is_read: updated.is_read, is_archived: updated.is_archived })
  }

  async getAttachment(messageId: string, attachmentId: string): Promise<AttachmentData> {
    const message = await this.getMessage(messageId)
    const attachment = message.attachments.find((item) => item.id === attachmentId || item.filename === attachmentId)
    if (!attachment) throw new ProviderNotFoundError('inbound', `Attachment ${attachmentId} was not found`)

    // The generated SDK types attachment downloads as void, discarding the binary response.
    const path = `/attachments/${encodeURIComponent(messageId)}/${encodeURIComponent(attachment.filename)}`
    const headers = this.headers()
    headers.set('Accept', '*/*')
    const response = await providerRequest(
      'inbound',
      this.fetcher,
      `${this.baseUrl}${path}`,
      { headers, signal: this.requests.signal },
      this.timeoutMs,
    )
    return {
      attachment,
      content: await providerBytes('inbound', response),
      filename: attachment.filename,
      contentType: response.headers.get('content-type') ?? attachment.contentType,
    }
  }

  async disconnect(): Promise<void> {
    this.requests.abort()
    await this.headPin?.catch(() => {})
    this.snapshots.clear()
    this.evidence.clear()
    this.evidenceBytes = 0
    this.sources = undefined
    this.sourcesExpireAt = 0
  }
}
