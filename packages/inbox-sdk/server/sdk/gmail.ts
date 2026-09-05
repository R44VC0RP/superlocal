import { parseDocument } from 'htmlparser2'
import nodemailer from 'nodemailer'
import sanitizeHtml from 'sanitize-html'
import {
  attachmentContent,
  attachmentUrl,
  buildThreads,
  clampLimit,
  createMailAccount,
  decodeBase64Url,
  encodeBase64Url,
  formatParticipant,
  htmlToPlainText,
  normalizeCursor,
  normalizeDate,
  parseParticipant,
  parseParticipants,
  previewText,
  providerJson,
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
  type SendingIdentity,
  type SendInput,
  type SendResult,
  type SyncCursor,
  type SyncOptions,
  type SyncResult,
} from './types'

export interface GmailCredentials extends ProviderCredentials {
  accessToken: string
  scopes?: string[]
}

interface GmailHeader {
  name: string
  value: string
}

interface GmailPart {
  partId?: string
  mimeType?: string
  filename?: string
  headers?: GmailHeader[]
  body?: { attachmentId?: string; data?: string; size?: number }
  parts?: GmailPart[]
}

interface GmailAttachmentPart {
  attachment: Attachment
  part: GmailPart
  contentLocation: string
}

interface GmailMessage {
  id: string
  threadId: string
  labelIds?: string[]
  snippet?: string
  internalDate?: string
  historyId?: string
  payload?: GmailPart
}

interface GmailListResponse {
  messages?: Array<{ id: string; threadId: string }>
  threads?: Array<{ id: string }>
  nextPageToken?: string
  resultSizeEstimate?: number
}

interface GmailHistoryResponse {
  history?: Array<{
    messages?: Array<{ id: string }>
    messagesAdded?: Array<{ message: { id: string } }>
    messagesDeleted?: Array<{ message: { id: string } }>
    labelsAdded?: Array<{ message: { id: string } }>
    labelsRemoved?: Array<{ message: { id: string } }>
  }>
  nextPageToken?: string
  historyId?: string
}

const GMAIL_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  sync: true,
  incrementalSync: true,
  deltaSync: true,
  send: true,
  reply: true,
  threads: true,
  nativeThreads: true,
  folders: true,
  createFolders: true,
  labels: true,
  archive: true,
  trash: true,
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

const GMAIL_FOLDER_LABELS: Partial<Record<MailFolder, string>> = {
  inbox: 'INBOX',
  starred: 'STARRED',
  sent: 'SENT',
  drafts: 'DRAFT',
  trash: 'TRASH',
  spam: 'SPAM',
}

export const GMAIL_CATEGORY_ROLES: Readonly<Record<string, string>> = Object.freeze({ CATEGORY_PROMOTIONS: 'promotions', CATEGORY_PERSONAL: 'personal', CATEGORY_SOCIAL: 'social', CATEGORY_UPDATES: 'updates', CATEGORY_FORUMS: 'forums' })
const GMAIL_LABEL_FOLDERS: Record<string, MailFolder> = {
  INBOX: 'inbox', STARRED: 'starred', SENT: 'sent', DRAFT: 'drafts', TRASH: 'trash', SPAM: 'spam', ARCHIVE: 'archive',
}

function header(part: GmailPart | undefined, name: string): string {
  return part?.headers?.find((item) => item.name.toLowerCase() === name.toLowerCase())?.value ?? ''
}

function normalizeContentId(value: string | undefined): string {
  if (!value) return ''

  let normalized = value.trim().replace(/^cid:/i, '')
  try {
    normalized = decodeURIComponent(normalized)
  } catch {
    return ''
  }

  normalized = normalized.trim().replace(/^<+|>+$/g, '').trim()
  if (!normalized || /[\u0000-\u0020\u007f<>]/.test(normalized)) return ''
  return normalized.toLowerCase()
}

function imageReferenceKey(value: string | undefined): string {
  const reference = value?.trim()
  if (!reference || /[\u0000-\u001f\u007f]/.test(reference)) return ''

  if (/^cid:/i.test(reference)) {
    const contentId = normalizeContentId(reference)
    return contentId ? `cid:${contentId}` : ''
  }

  if (/^[a-z][a-z\d+.-]*:/i.test(reference)) {
    try {
      const url = new URL(reference)
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
        ? `url:${url.href}`
        : ''
    } catch {
      return ''
    }
  }

  if (reference.startsWith('//')) return ''

  try {
    return `location:${decodeURIComponent(reference).toLowerCase()}`
  } catch {
    return ''
  }
}

function backgroundImage(style: string | undefined): {
  source: string
  width: string
  height: string
} | null {
  if (!style) return null

  const image = /(?:^|;)\s*background-image\s*:\s*url\(\s*(["']?)([^"'()\r\n]+)\1\s*\)\s*(?:!important)?\s*(?=;|$)/i
    .exec(style)
  const width = /(?:^|;)\s*width\s*:\s*(\d+(?:\.\d+)?)(?:px)?\s*(?:!important)?\s*(?=;|$)/i
    .exec(style)
  const height = /(?:^|;)\s*height\s*:\s*(\d+(?:\.\d+)?)(?:px)?\s*(?:!important)?\s*(?=;|$)/i
    .exec(style)
  if (!image || !width || !height) return null

  const source = image[2]!.trim()
  if (/^data:/i.test(source)) {
    if (!/^data:image\/(?:avif|bmp|gif|jpe?g|png|webp);base64,[a-z\d+/=\s]+$/i.test(source)) {
      return null
    }
  } else if (!/^(?:https?:\/\/|cid:)/i.test(source) || !imageReferenceKey(source)) {
    return null
  }

  return { source, width: width[1]!, height: height[1]! }
}

function normalizeInlineImageHtml(
  html: string,
  attachments: Attachment[],
  parts: GmailAttachmentPart[] = [],
): string {
  const hasBackgroundImages = /background-image\s*:/i.test(html)
  if (!html || (!hasBackgroundImages && attachments.length === 0)) return html

  const imageOnlySpans = new Set<number>()
  if (hasBackgroundImages) {
    const spanIndexes = new WeakMap<object, number>()
    let spanIndex = 0

    sanitizeHtml(html, {
      allowedTags: ['span', 'img'],
      allowedAttributes: false,
      parseStyleAttributes: false,
      onOpenTag: (name, attributes) => {
        if (name === 'span') spanIndexes.set(attributes, spanIndex++)
      },
      exclusiveFilter: (frame) => {
        const index = frame.tag === 'span' ? spanIndexes.get(frame.attribs) : undefined
        if (
          index !== undefined &&
          !frame.text.trim() &&
          frame.mediaChildren.length === 0 &&
          backgroundImage(frame.attribs.style)
        ) {
          imageOnlySpans.add(index)
        }
        return false
      },
    })
  }

  const references = new Map<string, GmailAttachmentPart>()
  const attachmentParts: GmailAttachmentPart[] = parts.length
    ? parts
    : attachments.map((attachment) => ({ attachment, part: {}, contentLocation: '' }))

  for (const entry of attachmentParts) {
    if (!entry.attachment.contentType.toLowerCase().startsWith('image/')) continue

    const candidates = [
      entry.attachment.contentId ? `cid:${entry.attachment.contentId}` : '',
      entry.contentLocation,
      entry.part.partId ? `cid:${entry.part.partId}` : '',
      entry.part.filename ? `cid:${entry.part.filename}` : '',
      entry.part.filename,
    ]

    for (const candidate of candidates) {
      const key = imageReferenceKey(candidate)
      if (key && !references.has(key)) references.set(key, entry)
    }
  }

  let changed = false
  let spanIndex = 0

  function resolve(source: string): string {
    const key = imageReferenceKey(source)
    const entry = key ? references.get(key) : undefined
    if (!entry) return source

    const contentId = normalizeContentId(entry.attachment.contentId)
      || normalizeContentId(entry.part.partId)
      || normalizeContentId(entry.part.filename)
      || (key.startsWith('cid:') ? key.slice(4) : '')
    if (!contentId) return source

    entry.attachment.inline = true
    entry.attachment.contentId = contentId
    return `cid:${contentId}`
  }

  const normalized = sanitizeHtml(html, {
    allowedTags: false,
    allowedAttributes: false,
    allowVulnerableTags: true,
    parseStyleAttributes: false,
    allowedSchemes: ['http', 'https', 'mailto', 'tel', 'cid', 'data'],
    allowProtocolRelative: false,
    transformTags: {
      img: (_tagName, attributes) => {
        const source = attributes.src
        const resolved = source ? resolve(source) : source
        if (resolved && resolved !== source) {
          changed = true
          return { tagName: 'img', attribs: { ...attributes, src: resolved } }
        }
        return { tagName: 'img', attribs: attributes }
      },
      span: (_tagName, attributes) => {
        const index = spanIndex++
        if (!imageOnlySpans.has(index)) return { tagName: 'span', attribs: attributes }

        const image = backgroundImage(attributes.style)
        if (!image) return { tagName: 'span', attribs: attributes }

        changed = true
        return {
          tagName: 'img',
          attribs: {
            ...attributes,
            src: resolve(image.source),
            width: image.width,
            height: image.height,
            ...(attributes['aria-label'] || attributes.title
              ? { alt: attributes['aria-label'] || attributes.title }
              : {}),
          },
        }
      },
    },
  })

  return changed ? normalized : html
}

export function recoverInlineMessageImages(html: string, attachments: Attachment[] = []): string {
  return normalizeInlineImageHtml(html, attachments)
}

function gmailFolder(labels: string[]): MailFolder {
  if (labels.includes('TRASH')) return 'trash'
  if (labels.includes('SPAM')) return 'spam'
  if (labels.includes('DRAFT')) return 'drafts'
  if (labels.includes('SENT') && !labels.includes('INBOX')) return 'sent'
  if (labels.includes('INBOX')) return 'inbox'
  return 'archive'
}

async function extractParts(part: GmailPart | undefined, messageId: string, accountId: string,
  readBody?: (attachmentId: string) => Promise<string>): Promise<{
  bodyText: string
  bodyHtml: string
  attachments: Attachment[]
  attachmentParts: GmailAttachmentPart[]
}> {
  let bodyText = ''
  let bodyHtml = ''
  const attachments: Attachment[] = []
  const attachmentParts: GmailAttachmentPart[] = []

  async function visit(current: GmailPart, insideAttachment = false): Promise<void> {
    const contentType = header(current, 'Content-Type')
    const mimeType = (current.mimeType || contentType || (
      current.body?.data && !current.parts?.length ? 'text/plain' : ''
    )).split(';', 1)[0]!.trim().toLowerCase()
    const disposition = header(current, 'Content-Disposition').split(';', 1)[0]!.trim().toLowerCase()
    const contentId = normalizeContentId(header(current, 'Content-ID'))
    const contentLocation = header(current, 'Content-Location').trim()
    const imageLocation = mimeType.startsWith('image/') && Boolean(imageReferenceKey(contentLocation))
    const filename = current.filename || ''
    const attachmentId = current.body?.attachmentId
    const isTextBody = mimeType === 'text/plain' || mimeType === 'text/html'
    const isAttachment = disposition === 'attachment' || mimeType === 'message/rfc822' || Boolean(
      filename || contentId || imageLocation ||
      (attachmentId && ((disposition === 'inline' && !isTextBody) || !mimeType.startsWith('text/'))) ||
      (current.body?.data && mimeType.startsWith('image/')),
    )

    if (isAttachment) {
      // MIME part IDs are immutable; Gmail download handles can change between reads.
      const id = typeof current.partId === 'string' ? `part:${current.partId}`
        : attachmentId || contentId || filename || `part-${attachments.length + 1}`
      const attachment: Attachment = {
        id,
        filename: filename || 'attachment',
        contentType: mimeType || 'application/octet-stream',
        size: current.body?.size ?? 0,
        url: attachmentUrl(accountId, messageId, id),
        ...(disposition === 'inline' || contentId || imageLocation ? { inline: true } : {}),
        ...(contentId ? { contentId } : {}),
      }
      attachments.push(attachment)
      attachmentParts.push({ attachment, part: current, contentLocation })
    } else if (!insideAttachment && (
      (mimeType === 'text/plain' && !bodyText) || (mimeType === 'text/html' && !bodyHtml)
    )) {
      const data = current.body?.data || (attachmentId && readBody ? await readBody(attachmentId) : undefined)
      if (data) {
        const charset = /(?:^|;)\s*charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\s]+))/i
          .exec(contentType || current.mimeType || '')
        let decoder: TextDecoder
        try {
          decoder = new TextDecoder(charset?.[1] ?? charset?.[2] ?? charset?.[3] ?? 'utf-8')
        } catch {
          decoder = new TextDecoder('utf-8')
        }
        const bytes = decodeBase64Url(data)
        let content = decoder.decode(bytes)
        if (mimeType === 'text/html' && decoder.encoding !== 'utf-8' && !decoder.encoding.startsWith('utf-16')) {
          // A conflicting head declaration or BOM can identify mislabeled UTF-8 HTML,
          // but only a strict decode of the original bytes may override the MIME charset.
          try {
            const utf8 = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
            let explicitUtf8 = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
            if (!explicitUtf8) {
              const document = parseDocument(utf8)
              const root = document.children.find(node => node.type === 'tag')
              const head = root?.type === 'tag' && root.name === 'html'
                ? root.children.find(node => node.type === 'tag') : root
              if (head?.type === 'tag' && head.name === 'head') for (const meta of head.children) {
                if (meta.type !== 'tag' || meta.name !== 'meta') continue
                const declared = meta.attribs.charset ?? (meta.attribs['http-equiv']?.trim().toLowerCase() === 'content-type'
                  ? /(?:^|;)\s*charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\s]+))/i.exec(meta.attribs.content ?? '')?.slice(1).find(Boolean)
                  : undefined)
                if (!declared) continue
                try {
                  explicitUtf8 = new TextDecoder(declared).encoding === 'utf-8'
                  break
                } catch { /* Ignore unsupported declarations, not the MIME charset. */ }
              }
            }
            if (explicitUtf8) content = utf8
          } catch { /* Invalid UTF-8 bytes retain their declared MIME decoding. */ }
        }
        if (content.trim()) {
          if (mimeType === 'text/plain') bodyText = content
          else bodyHtml = content
        }
      }
    }

    for (const child of current.parts ?? []) await visit(child, insideAttachment || isAttachment)
  }

  if (part) await visit(part)
  if (bodyHtml) bodyHtml = normalizeInlineImageHtml(bodyHtml, attachments, attachmentParts)
  if (!bodyText && bodyHtml) bodyText = htmlToPlainText(bodyHtml)
  return { bodyText, bodyHtml, attachments, attachmentParts }
}

function isRejectedPageToken(error: unknown): error is ProviderError {
  if (!(error instanceof ProviderError) || error.status !== 400) return false
  const errors = typeof error.details === 'object' && error.details !== null
    ? (error.details as { error?: { errors?: Array<{ reason?: string; location?: string }> } }).error?.errors
    : undefined
  return Array.isArray(errors) && errors.some(item => item && (
    ['invalidPageToken', 'expiredPageToken'].includes(item.reason ?? '') ||
    item.location === 'pageToken' && ['invalid', 'invalidArgument', 'badRequest'].includes(item.reason ?? '')
  )) || /^(?:(?:invalid|expired) (?:value for )?['"]?(?:pageToken|page token)['"]?|['"]?(?:pageToken|page token)['"]? (?:(?:is|has) )?(?:invalid|expired))(?:[.:]|$)/i.test(error.message)
}

export class GmailProvider implements InboxProvider {
  readonly type = 'gmail' as const
  readonly capabilities: Readonly<ProviderCapabilities>
  readonly accountId: string
  private readonly credentials: GmailCredentials
  private readonly baseUrl: string
  private readonly fetcher: typeof globalThis.fetch
  private readonly requests = new AbortController()

  constructor(credentials: GmailCredentials) {
    if (!credentials.accountId || !credentials.accessToken) {
      throw new ProviderError('gmail', 'VALIDATION', 'Gmail requires an account ID and OAuth access token')
    }
    if (credentials.scopes !== undefined && (!Array.isArray(credentials.scopes) ||
      credentials.scopes.some((scope) => typeof scope !== 'string'))) {
      throw new ProviderError('gmail', 'VALIDATION', 'Gmail OAuth scopes must be an explicit list of grants')
    }
    this.credentials = { ...credentials }
    // Unspecified manual scopes are legacy-unknown, not a verified OAuth grant.
    const legacyUnknown = credentials.scopes === undefined
    const scopes = credentials.scopes ?? []
    const fullMail = scopes.includes('https://mail.google.com/')
    const modify = legacyUnknown || fullMail || scopes.includes('https://www.googleapis.com/auth/gmail.modify')
    const read = modify || scopes.includes('https://www.googleapis.com/auth/gmail.readonly')
    const send = modify || scopes.some((scope) =>
      scope === 'https://www.googleapis.com/auth/gmail.send' || scope === 'https://www.googleapis.com/auth/gmail.compose')
    const manageLabels = modify || scopes.includes('https://www.googleapis.com/auth/gmail.labels')
    this.capabilities = Object.freeze({
      ...GMAIL_CAPABILITIES,
      sync: read,
      incrementalSync: read,
      deltaSync: read,
      send,
      reply: send,
      threads: read,
      nativeThreads: read,
      folders: read || manageLabels || scopes.includes('https://www.googleapis.com/auth/gmail.metadata'),
      createFolders: manageLabels,
      labels: modify,
      archive: modify,
      trash: modify,
      permanentDelete: fullMail,
      markRead: modify,
      markUnread: modify,
      star: modify,
      attachments: read,
      attachmentDownload: read,
      search: read,
    })
    this.accountId = credentials.accountId
    this.baseUrl = (credentials.baseUrl ?? 'https://gmail.googleapis.com/gmail/v1').replace(/\/$/, '')
    this.fetcher = credentials.fetch ?? globalThis.fetch
  }

  private request<T>(path: string, init: RequestInit = {}, maxBytes?: number): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${this.credentials.accessToken}`)
    headers.set('Accept', 'application/json')
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    return providerJson<T>('gmail', this.fetcher, `${this.baseUrl}${path}`, {
      ...init, headers, signal: init.signal ? AbortSignal.any([init.signal, this.requests.signal]) : this.requests.signal,
    }, this.credentials.timeoutMs, maxBytes)
  }

  private async attachmentData(messageId: string, attachmentId: string): Promise<string> {
    const result = await this.request<{ data: string }>(
      `/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    )
    if (typeof result?.data !== 'string') throw new ProviderError('gmail', 'UPSTREAM', 'Gmail returned invalid attachment data')
    return result.data
  }

  private async normalize(message: GmailMessage): Promise<MailMessage> {
    const labels = message.labelIds ?? []
    const parts = await extractParts(message.payload, message.id, this.accountId, async attachmentId => {
      try { return await this.attachmentData(message.id, attachmentId) }
      catch (error) {
        // A missing body part must not make list hydration silently discard its message.
        if (error instanceof ProviderNotFoundError) throw new ProviderError('gmail', 'UPSTREAM', 'Gmail message body was not found', {
          status: error.status, retryable: true, cause: error,
        })
        throw error
      }
    })
    return {
      id: message.id,
      threadId: message.threadId || message.id,
      accountId: this.accountId,
      from: parseParticipant(header(message.payload, 'From')),
      to: parseParticipants(header(message.payload, 'To')),
      cc: parseParticipants(header(message.payload, 'Cc')),
      bcc: parseParticipants(header(message.payload, 'Bcc')),
      replyTo: parseParticipants(header(message.payload, 'Reply-To')),
      ...(header(message.payload, 'Message-ID') ? { rfcMessageId: header(message.payload, 'Message-ID') } : {}),
      ...(header(message.payload, 'In-Reply-To') ? { inReplyTo: header(message.payload, 'In-Reply-To') } : {}),
      references: header(message.payload, 'References').match(/<[^>]+>/g) ?? [],
      headers: Object.fromEntries((message.payload?.headers ?? []).map(({ name, value }) => [name.toLowerCase(), value])),
      subject: header(message.payload, 'Subject'),
      preview: message.snippet === undefined
        ? previewText(parts.bodyText || parts.bodyHtml)
        : htmlToPlainText(message.snippet.replace(/</g, '&lt;').replace(/>/g, '&gt;')),
      bodyText: parts.bodyText,
      bodyHtml: parts.bodyHtml,
      receivedAt: normalizeDate(message.internalDate || header(message.payload, 'Date')),
      isRead: !labels.includes('UNREAD'),
      isStarred: labels.includes('STARRED'),
      isImportant: labels.includes('IMPORTANT') || labels.includes('CATEGORY_PERSONAL'),
      nativeCategories: labels.flatMap(label => Object.hasOwn(GMAIL_CATEGORY_ROLES, label) ? [GMAIL_CATEGORY_ROLES[label]!] : []),
      folder: gmailFolder(labels),
      folderIds: [...new Set([
        ...labels.filter((label) => label !== 'UNREAD').map((label) => GMAIL_LABEL_FOLDERS[label] ?? label),
        ...(gmailFolder(labels) === 'archive' ? ['archive'] : []),
      ])],
      labels: labels.filter((label) => !['INBOX', 'UNREAD', 'STARRED', 'SENT', 'DRAFT', 'TRASH', 'SPAM'].includes(label)),
      attachments: parts.attachments,
    }
  }

  private async hydrate(ids: string[]): Promise<MailMessage[]> {
    const unique = [...new Set(ids)]
    const messages: MailMessage[] = []

    for (let index = 0; index < unique.length; index += 5) {
      const settled = await Promise.allSettled(
        unique.slice(index, index + 5).map((id) => this.getMessage(id)),
      )
      for (const result of settled) {
        if (result.status === 'fulfilled') messages.push(result.value)
        else if (!(result.reason instanceof ProviderNotFoundError)) throw result.reason
      }
    }

    return messages
  }

  private query(options: ListOptions, threads = false): string {
    if (options.folder) options = { ...options, folder: GMAIL_LABEL_FOLDERS[options.folder] ?? options.folder }
    if (options.folder === 'scheduled' || options.folder === 'snoozed') {
      throw new UnsupportedOperationError('gmail', `the ${options.folder} folder`)
    }
    const params = new URLSearchParams({ maxResults: String(clampLimit(options.limit, 50, threads ? 100 : 500)) })
    if (options.cursor) params.set('pageToken', options.cursor)
    if (options.folder && options.folder !== 'archive' && options.folder !== 'ARCHIVE') {
      params.append('labelIds', GMAIL_FOLDER_LABELS[options.folder] ?? options.folder)
    }

    const queries: string[] = []
    if (options.search) queries.push(options.search)
    if (options.unreadOnly) queries.push('is:unread')
    if (options.folder === 'archive' || options.folder === 'ARCHIVE') queries.push('-in:inbox -in:sent -in:drafts -in:spam -in:trash')
    if (queries.length) params.set('q', queries.join(' '))
    if (options.folder === 'trash' || options.folder === 'spam') params.set('includeSpamTrash', 'true')
    return params.toString()
  }

  private async listPage(kind: 'messages' | 'threads', options: ListOptions): Promise<GmailListResponse & { nextCursor: string | null }> {
    const scope = [
      'gmail', this.accountId, kind,
      options.folder ? GMAIL_LABEL_FOLDERS[options.folder] ?? options.folder : '',
      options.search ?? '', Boolean(options.unreadOnly),
    ]
    let pageToken: string | undefined
    if (options.cursor !== undefined && options.cursor !== null) {
      try {
        if (typeof options.cursor !== 'string' || !/^[\w-]+$/.test(options.cursor)) throw new Error()
        const decoded = decodeBase64Url(options.cursor)
        if (encodeBase64Url(decoded) !== options.cursor) throw new Error()
        const cursor = JSON.parse(decoded.toString('utf8')) as unknown
        if (!Array.isArray(cursor) || cursor.length !== scope.length + 1 ||
          !scope.every((value, index) => cursor[index] === value) ||
          typeof cursor[scope.length] !== 'string' || !cursor[scope.length]) throw new Error()
        pageToken = cursor[scope.length]
      } catch {
        throw new ProviderCursorExpiredError('gmail', 'Invalid Gmail list cursor or query scope')
      }
    }
    let result: GmailListResponse
    try {
      result = await this.request<GmailListResponse>(
        `/users/me/${kind}?${this.query({ ...options, cursor: pageToken }, kind === 'threads')}`,
      )
    } catch (error) {
      if (pageToken && isRejectedPageToken(error)) throw new ProviderCursorExpiredError('gmail', 'Gmail list page token was rejected', {
        status: error.status, cause: error,
      })
      throw error
    }
    return {
      ...result,
      nextCursor: result.nextPageToken ? encodeBase64Url(JSON.stringify([...scope, result.nextPageToken])) : null,
    }
  }

  async getAccount(): Promise<MailAccount> {
    const [profile, inbox] = await Promise.all([
      this.request<{ emailAddress: string }>('/users/me/profile'),
      this.request<{ messagesUnread?: number }>('/users/me/labels/INBOX'),
    ])
    return createMailAccount('gmail', this.credentials, {
      email: profile.emailAddress,
      name: this.credentials.name ?? profile.emailAddress,
      unreadCount: inbox.messagesUnread ?? 0,
    })
  }

  async getSendingIdentities(): Promise<readonly SendingIdentity[]> {
    const validAddress = (value: unknown): value is string => {
      if (typeof value !== 'string' || value.length > 254) return false
      const parts = value.split('@')
      const local = parts[0]!
      const domain = parts[1]
      return parts.length === 2 && local.length <= 64 &&
        /^[a-z\d!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z\d!#$%&'*+/=?^_`{|}~-]+)*$/i.test(local) &&
        Boolean(domain && domain.split('.').every(label =>
          /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label)))
    }
    // The host stores the authenticated profile address in credentials, never a send-as default.
    const primary = this.credentials.email
    if (!validAddress(primary)) throw new ProviderError('gmail', 'VALIDATION', 'An authenticated primary email address is required')
    const result = await this.request<unknown>(
      '/users/me/settings/sendAs?fields=sendAs(sendAsEmail,isPrimary,isDefault,verificationStatus)',
      { method: 'GET' }, 64 * 1024,
    )
    const invalid = () => new ProviderError('gmail', 'UPSTREAM', 'Gmail returned invalid sending identities')
    if (!result || typeof result !== 'object' || Array.isArray(result) || !('sendAs' in result) ||
      !Array.isArray(result.sendAs)) throw invalid()
    if (result.sendAs.length > 100) throw new ProviderError('gmail', 'UPSTREAM', 'Gmail returned too many sending identities')
    const seen = new Map<string, { isPrimary: boolean; isDefault: boolean; verificationStatus: unknown }>()
    const identities: SendingIdentity[] = []
    let primaryCount = 0
    let defaultCount = 0
    for (const row of result.sendAs as unknown[]) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw invalid()
      const entry = row as Record<string, unknown>
      if (!validAddress(entry.sendAsEmail) ||
        entry.isPrimary !== undefined && typeof entry.isPrimary !== 'boolean' ||
        entry.isDefault !== undefined && typeof entry.isDefault !== 'boolean' ||
        entry.verificationStatus !== undefined && typeof entry.verificationStatus !== 'string') throw invalid()
      // Gmail may omit false flags. Do not coerce other values or infer primary/default from each other.
      const isPrimary = entry.isPrimary === true
      const isDefault = entry.isDefault === true
      const key = entry.sendAsEmail.toLowerCase()
      if (isPrimary !== (key === primary.toLowerCase())) throw invalid()
      const previous = seen.get(key)
      if (previous) {
        if (previous.isPrimary !== isPrimary || previous.isDefault !== isDefault ||
          previous.verificationStatus !== entry.verificationStatus) throw invalid()
        continue
      }
      seen.set(key, { isPrimary, isDefault, verificationStatus: entry.verificationStatus })
      if (isPrimary) primaryCount++
      if (isDefault && ++defaultCount > 1) throw invalid()
      if (isPrimary || entry.verificationStatus === 'accepted') identities.push({
        email: isPrimary ? primary : entry.sendAsEmail, isPrimary, isDefault,
      })
    }
    if (primaryCount !== 1) throw invalid()
    return identities
  }

  async listFolders(): Promise<ProviderFolder[]> {
    const result = await this.request<{ labels?: Array<{
      id: string
      name: string
      type?: 'system' | 'user'
      messagesUnread?: number
      messagesTotal?: number
    }> }>(
      '/users/me/labels',
    )
    const mapping: Record<string, MailFolder> = {
      INBOX: 'inbox',
      STARRED: 'starred',
      SENT: 'sent',
      DRAFT: 'drafts',
      TRASH: 'trash',
      SPAM: 'spam',
    }
    const folders = (result.labels ?? [])
      .filter((label) => mapping[label.id] || label.type === 'user' || (!label.type && !/^[A-Z_]+$/.test(label.id)))
      .map((label): ProviderFolder => ({
        id: label.id,
        name: label.name,
        folder: mapping[label.id] ?? 'inbox',
        kind: 'label',
        ...(mapping[label.id] ? {} : { path: label.name, custom: true }),
        ...(label.messagesUnread === undefined ? {} : { unreadCount: label.messagesUnread }),
        ...(label.messagesTotal === undefined ? {} : { totalCount: label.messagesTotal }),
      }))
    folders.push({ id: 'ARCHIVE', name: 'Archive', folder: 'archive' })
    return folders
  }

  async createFolder(name: string): Promise<ProviderFolder> {
    if (!this.capabilities.createFolders) throw new UnsupportedOperationError('gmail', 'folder creation with the granted OAuth scopes')
    const label = await this.request<{ id: string; name: string }>('/users/me/labels', {
      method: 'POST',
      body: JSON.stringify({
        name,
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show',
      }),
    })
    return { id: label.id, name: label.name, folder: 'inbox', kind: 'label', path: label.name, custom: true }
  }

  async listMessages(options: ListOptions = {}): Promise<ProviderListResult<MailMessage>> {
    const result = await this.listPage('messages', options)
    const messages = await this.hydrate((result.messages ?? []).map((message) => message.id))
    return {
      items: messages,
      nextCursor: result.nextCursor,
      hasMore: Boolean(result.nextPageToken),
      ...(result.resultSizeEstimate === undefined ? {} : { total: result.resultSizeEstimate }),
    }
  }

  async listThreads(options: ListOptions = {}): Promise<ProviderListResult<MailThread>> {
    const result = await this.listPage('threads', options)
    const references = result.threads ?? []
    const items: MailThread[] = []

    for (let index = 0; index < references.length; index += 5) {
      items.push(...await Promise.all(
        references.slice(index, index + 5).map((thread) => this.getThread(thread.id)),
      ))
    }

    return {
      items,
      nextCursor: result.nextCursor,
      hasMore: Boolean(result.nextPageToken),
      ...(result.resultSizeEstimate === undefined ? {} : { total: result.resultSizeEstimate }),
    }
  }

  async getMessage(messageId: string): Promise<MailMessage> {
    const message = await this.request<GmailMessage>(`/users/me/messages/${encodeURIComponent(messageId)}?format=full`)
    return this.normalize(message)
  }

  async getThread(threadId: string): Promise<MailThread> {
    const thread = await this.request<{ id: string; messages?: GmailMessage[] }>(
      `/users/me/threads/${encodeURIComponent(threadId)}?format=full`,
    )
    const messages: MailMessage[] = []
    const native = thread.messages ?? []
    for (let index = 0; index < native.length; index += 5) {
      messages.push(...await Promise.all(native.slice(index, index + 5).map(message => this.normalize(message))))
    }
    return requireThread('gmail', messages, threadId)
  }

  private async fullSync(cursor: SyncCursor | null, options: SyncOptions): Promise<SyncResult> {
    let historyId = cursor?.value
    if (!historyId) {
      const profile = await this.request<{ historyId: string }>('/users/me/profile')
      historyId = profile.historyId
    }

    // Qualified sync cursors keep native page tokens separate from public list continuations.
    let listing: GmailListResponse
    try {
      listing = await this.request<GmailListResponse>(`/users/me/messages?${this.query({
        folder: options.folder,
        limit: options.limit,
        cursor: cursor?.metadata?.pageToken,
      })}`)
    } catch (error) {
      if (cursor?.metadata?.pageToken && isRejectedPageToken(error)) return this.fullSync(null, options)
      throw error
    }
    const messages = await this.hydrate((listing.messages ?? []).map((message) => message.id))
    const hasMore = Boolean(listing.nextPageToken)
    const nextCursor: SyncCursor = {
      provider: 'gmail',
      kind: hasMore ? 'page' : 'history',
      value: historyId,
      ...(options.folder ? { folder: options.folder } : {}),
      metadata: {
        accountId: this.accountId,
        ...(listing.nextPageToken ? { pageToken: listing.nextPageToken, incrementalCursorKind: 'history' } : {}),
      },
    }
    return {
      messages,
      threads: buildThreads(messages),
      deletedMessageIds: [],
      cursor: nextCursor,
      hasMore,
      fullSync: true,
      snapshotComplete: !hasMore,
      recentCursor: { ...nextCursor, kind: 'history', metadata: { accountId: this.accountId } },
    }
  }

  async sync(cursor?: SyncCursor | string | null, options: SyncOptions = {}): Promise<SyncResult> {
    const current = normalizeCursor('gmail', cursor, 'history')
    if (current && current.kind !== 'history' && current.kind !== 'page') {
      throw new ProviderCursorExpiredError('gmail', 'Gmail synchronization requires a history or page cursor')
    }
    if (current?.metadata?.accountId && current.metadata.accountId !== this.accountId) {
      throw new ProviderCursorExpiredError('gmail', 'Gmail synchronization cursors belong to one account')
    }
    if (current && options.folder !== undefined && current.folder !== options.folder) {
      throw new ProviderCursorExpiredError('gmail', 'Gmail synchronization cursors cannot switch folders')
    }
    options = { ...options, folder: options.folder ?? current?.folder }
    if (!current || current.kind === 'page') return this.fullSync(current, options)

    const params = new URLSearchParams({
      startHistoryId: current.value,
      maxResults: String(clampLimit(options.limit, 100, 500)),
    })
    if (current.metadata?.pageToken) params.set('pageToken', current.metadata.pageToken)

    let history: GmailHistoryResponse
    try {
      history = await this.request<GmailHistoryResponse>(`/users/me/history?${params}`)
    } catch (error) {
      // Gmail permanently rejects expired history IDs with 404; replaying them cannot succeed.
      if (error instanceof ProviderNotFoundError) return this.fullSync(null, options)
      throw error
    }

    const changed = new Set<string>()
    const deleted = new Set<string>()
    for (const item of history.history ?? []) {
      for (const message of item.messages ?? []) changed.add(message.id)
      for (const itemChange of [...(item.messagesAdded ?? []), ...(item.labelsAdded ?? []), ...(item.labelsRemoved ?? [])]) {
        changed.add(itemChange.message.id)
      }
      for (const itemChange of item.messagesDeleted ?? []) {
        changed.delete(itemChange.message.id)
        deleted.add(itemChange.message.id)
      }
    }

    const hydrated = await this.hydrate([...changed])
    const folder = options.folder ? GMAIL_LABEL_FOLDERS[options.folder] ?? options.folder : undefined
    const messages = folder ? hydrated.filter((message) => message.folderIds?.includes(folder)) : hydrated
    const nextCursor: SyncCursor = {
      provider: 'gmail',
      kind: 'history',
      value: history.nextPageToken ? current.value : history.historyId ?? current.value,
      ...(options.folder ?? current.folder ? { folder: options.folder ?? current.folder } : {}),
      metadata: { accountId: this.accountId, ...(history.nextPageToken ? { pageToken: history.nextPageToken } : {}) },
    }
    return {
      messages,
      threads: buildThreads(messages),
      deletedMessageIds: [...deleted],
      removedMessageIds: folder ? hydrated.filter((message) => !message.folderIds?.includes(folder)).map((message) => message.id) : [],
      cursor: nextCursor,
      hasMore: Boolean(history.nextPageToken),
      fullSync: false,
    }
  }

  async send(input: SendInput): Promise<SendResult> {
    if (input.accountId !== undefined && input.accountId !== this.accountId) {
      throw new ProviderAuthorizationError('gmail', 'The message belongs to a different account')
    }
    if (!this.capabilities.send) throw new UnsupportedOperationError('gmail', 'sending with the granted OAuth scopes')
    if (input.scheduledAt) throw new UnsupportedOperationError('gmail', 'scheduled sending')
    const from = input.from ?? this.credentials.email
    if (!from) throw new ProviderError('gmail', 'VALIDATION', 'A sender email address is required')

    const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' })
    const result = await composer.sendMail({
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
    const source = result.message
    if (!Buffer.isBuffer(source)) throw new ProviderError('gmail', 'UPSTREAM', 'Failed to compose a MIME message')

    const sent = await this.request<GmailMessage>('/users/me/messages/send', {
      method: 'POST',
      body: JSON.stringify({
        raw: encodeBase64Url(source),
        ...(input.threadId ? { threadId: input.threadId } : {}),
      }),
    })
    return { id: sent.id, providerMessageId: sent.id, threadId: sent.threadId, messageId: result.messageId }
  }

  async mutate(messageId: string, mutation: MessageMutation): Promise<MailMessage | null> {
    if (mutation.snoozedUntil !== undefined) throw new UnsupportedOperationError('gmail', 'snoozing')
    if (mutation.folder && ['drafts', 'sent', 'DRAFT', 'SENT', 'scheduled', 'snoozed'].includes(mutation.folder)) {
      throw new UnsupportedOperationError('gmail', `moving messages to ${mutation.folder}`)
    }
    if (mutation.deletePermanently && !this.capabilities.permanentDelete) {
      throw new UnsupportedOperationError('gmail', 'permanent deletion without the full mail grant')
    }
    if (!this.capabilities.labels) throw new UnsupportedOperationError('gmail', 'message mutation with the granted OAuth scopes')
    if (mutation.folder) mutation = { ...mutation, folder: GMAIL_LABEL_FOLDERS[mutation.folder] ?? mutation.folder }
    const path = `/users/me/messages/${encodeURIComponent(messageId)}`
    if (mutation.deletePermanently) {
      await this.request<void>(path, { method: 'DELETE' })
      return null
    }

    const add = new Set(mutation.addLabels ?? [])
    const remove = new Set(mutation.removeLabels ?? [])
    if (mutation.isRead !== undefined) (mutation.isRead ? remove : add).add('UNREAD')
    if (mutation.isStarred !== undefined) (mutation.isStarred ? add : remove).add('STARRED')
    if (mutation.isArchived !== undefined) (mutation.isArchived ? remove : add).add('INBOX')

    let updated: GmailMessage | undefined
    if (mutation.folder === 'trash') {
      updated = await this.request<GmailMessage>(`${path}/trash`, { method: 'POST' })
    } else if (mutation.folder) {
      if (mutation.folder === 'archive') {
        remove.add('INBOX')
        remove.add('TRASH')
        remove.add('SPAM')
      }
      else if (mutation.folder === 'starred') add.add('STARRED')
      else if (mutation.folder === 'inbox') {
        add.add('INBOX')
        remove.add('TRASH')
        remove.add('SPAM')
      } else {
        const label = GMAIL_FOLDER_LABELS[mutation.folder] ?? mutation.folder
        add.add(label)
        if (mutation.folder === 'spam') remove.add('INBOX')
      }
    }

    for (const label of add) remove.delete(label)
    if (add.size || remove.size) {
      updated = await this.request<GmailMessage>(`${path}/modify`, {
        method: 'POST',
        body: JSON.stringify({ addLabelIds: [...add], removeLabelIds: [...remove] }),
      })
    }
    return updated?.payload && updated.internalDate
      ? this.normalize(updated)
      : this.getMessage(messageId)
  }

  async getAttachment(messageId: string, attachmentId: string, contentId?: string,
    metadata?: Pick<Attachment, 'filename' | 'contentType' | 'inline'>): Promise<AttachmentData> {
    const normalizedContentId = normalizeContentId(contentId)

    const find = async (): Promise<GmailAttachmentPart | undefined> => {
      const message = await this.request<GmailMessage>(
        `/users/me/messages/${encodeURIComponent(messageId)}?format=full`,
      )
      const parts = await extractParts(message.payload, message.id, this.accountId)
      const entry = parts.attachmentParts.find((item) => item.attachment.id === attachmentId)
        ?? parts.attachmentParts.find((item) => item.part.partId === attachmentId || item.part.body?.attachmentId === attachmentId)
        ?? (normalizedContentId
          ? parts.attachmentParts.find((item) =>
            normalizeContentId(item.attachment.contentId) === normalizedContentId,
          )
          : undefined)
      return entry
    }

    let entry = await find()
    if (!entry) {
      if (attachmentId.startsWith('part:')) throw new ProviderNotFoundError('gmail', 'Attachment was not found')
      // Existing cached blobs hold older handles. Let Gmail validate them; never guess a file by its name.
      const content = decodeBase64Url(await this.attachmentData(messageId, attachmentId))
      const attachment: Attachment = {
        id: attachmentId, filename: metadata?.filename ?? 'attachment',
        contentType: metadata?.contentType ?? 'application/octet-stream', size: content.byteLength,
        url: attachmentUrl(this.accountId, messageId, attachmentId),
        ...(metadata?.inline ? { inline: true } : {}),
        ...(normalizedContentId ? { contentId: normalizedContentId } : {}),
      }
      return { attachment, content, filename: attachment.filename, contentType: attachment.contentType }
    }
    let data = entry.part.body?.data

    if (data === undefined) {
      const nativeId = entry.part.body?.attachmentId
      if (!nativeId) throw new ProviderNotFoundError('gmail', 'Attachment content was not found')
      try {
        data = await this.attachmentData(messageId, nativeId)
      } catch (error) {
        if (!(error instanceof ProviderNotFoundError) || !normalizedContentId) throw error

        entry = await find()
        if (!entry || entry.part.body?.attachmentId === nativeId && entry.part.body?.data === undefined) throw error
        data = entry.part.body?.data

        if (data === undefined) {
          if (!entry.part.body?.attachmentId) throw error
          data = await this.attachmentData(messageId, entry.part.body.attachmentId)
        }
      }
    }

    return {
      attachment: entry.attachment,
      content: decodeBase64Url(data),
      filename: entry.attachment.filename,
      contentType: entry.attachment.contentType,
    }
  }

  async disconnect(): Promise<void> { this.requests.abort() }
}
