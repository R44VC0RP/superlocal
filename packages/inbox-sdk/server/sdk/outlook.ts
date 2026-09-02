import {
  attachmentContent,
  attachmentUrl,
  buildThreads,
  clampLimit,
  createMailAccount,
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

export interface OutlookCredentials extends ProviderCredentials {
  accessToken: string
}

interface GraphRecipient {
  emailAddress?: { name?: string; address?: string }
}

interface GraphAttachment {
  id: string
  name?: string
  contentType?: string
  size?: number
  isInline?: boolean
  contentId?: string
}

interface GraphMessage {
  id: string
  conversationId?: string
  internetMessageId?: string
  parentFolderId?: string
  from?: GraphRecipient
  sender?: GraphRecipient
  toRecipients?: GraphRecipient[]
  ccRecipients?: GraphRecipient[]
  bccRecipients?: GraphRecipient[]
  replyTo?: GraphRecipient[]
  internetMessageHeaders?: Array<{ name: string; value: string }>
  subject?: string
  bodyPreview?: string
  body?: { contentType?: string; content?: string }
  receivedDateTime?: string
  sentDateTime?: string
  createdDateTime?: string
  isRead?: boolean
  isDraft?: boolean
  hasAttachments?: boolean
  attachments?: GraphAttachment[]
  categories?: string[]
  flag?: { flagStatus?: 'notFlagged' | 'complete' | 'flagged' }
  '@removed'?: { reason?: string }
}

interface GraphCollection<T> {
  value: T[]
  '@odata.nextLink'?: string
  '@odata.deltaLink'?: string
  '@odata.count'?: number
}

interface GraphFolder {
  id: string
  displayName: string
  unreadItemCount?: number
  totalItemCount?: number
}

const MESSAGE_FIELDS = [
  'id',
  'conversationId',
  'internetMessageId',
  'parentFolderId',
  'from',
  'sender',
  'toRecipients',
  'ccRecipients',
  'bccRecipients',
  'replyTo',
  'internetMessageHeaders',
  'subject',
  'bodyPreview',
  'body',
  'receivedDateTime',
  'sentDateTime',
  'createdDateTime',
  'isRead',
  'isDraft',
  'hasAttachments',
  'categories',
  'flag',
].join(',')

const GRAPH_FOLDERS: Partial<Record<MailFolder, string>> = {
  inbox: 'inbox',
  sent: 'sentitems',
  drafts: 'drafts',
  archive: 'archive',
  trash: 'deleteditems',
  spam: 'junkemail',
}

const OUTLOOK_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
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

function graphParticipant(recipient: GraphRecipient | undefined): Participant {
  const address = recipient?.emailAddress
  const email = typeof address?.address === 'string' ? address.address : ''
  return parseParticipant({ name: typeof address?.name === 'string' ? address.name : email, email })
}

function graphRecipients(values: GraphRecipient[] | undefined): Participant[] {
  return (Array.isArray(values) ? values : []).map(graphParticipant).filter((participant) => participant.email)
}

function recipientPayload(values: SendInput['to'] | SendInput['cc']): GraphRecipient[] {
  return parseParticipants(values).map((participant) => ({
    emailAddress: { address: participant.email, ...(participant.name ? { name: participant.name } : {}) },
  }))
}

function classifyFolder(name: string): MailFolder | null {
  const normalized = name.toLowerCase().replace(/[\s_-]/g, '')
  if (normalized === 'inbox') return 'inbox'
  if (normalized === 'sentitems' || normalized === 'sent') return 'sent'
  if (normalized === 'drafts') return 'drafts'
  if (normalized === 'archive') return 'archive'
  if (normalized === 'deleteditems' || normalized === 'trash' || normalized === 'deleted') return 'trash'
  if (normalized === 'junkemail' || normalized === 'junk' || normalized === 'spam') return 'spam'
  return null
}

export class OutlookProvider implements InboxProvider {
  readonly type = 'outlook' as const
  readonly capabilities = OUTLOOK_CAPABILITIES
  readonly accountId: string
  private readonly credentials: OutlookCredentials
  private readonly baseUrl: string
  private readonly fetcher: typeof globalThis.fetch
  private readonly folderIds = new Map<string, MailFolder>()
  private readonly requests = new AbortController()

  constructor(credentials: OutlookCredentials) {
    if (!credentials.accountId || !credentials.accessToken) {
      throw new ProviderError('outlook', 'VALIDATION', 'Outlook requires an account ID and OAuth access token')
    }
    this.credentials = { ...credentials }
    this.accountId = credentials.accountId
    this.baseUrl = (credentials.baseUrl ?? 'https://graph.microsoft.com/v1.0').replace(/\/$/, '')
    this.fetcher = credentials.fetch ?? globalThis.fetch
  }

  private resolveUrl(pathOrUrl: string): string {
    if (pathOrUrl.startsWith('/')) return `${this.baseUrl}${pathOrUrl}`
    let target: URL
    try {
      target = new URL(pathOrUrl)
    } catch {
      throw new ProviderCursorExpiredError('outlook', 'Graph pagination cursor is not a valid API URL')
    }
    const base = new URL(this.baseUrl)
    if (target.origin !== base.origin || !target.pathname.startsWith(`${base.pathname.replace(/\/$/, '')}/`)) {
      throw new ProviderCursorExpiredError('outlook', 'Graph pagination cursor points outside the configured API')
    }
    return target.toString()
  }

  private headers(init: RequestInit = {}, pageSize?: number): Headers {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${this.credentials.accessToken}`)
    headers.set('Accept', 'application/json')
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')

    // Immutable identifiers must be requested on every Graph call, including delta pages and moves.
    const preferences = ['IdType="ImmutableId"']
    if (pageSize) preferences.push(`odata.maxpagesize=${pageSize}`)
    const existing = headers.get('Prefer')
    if (existing) preferences.push(existing)
    headers.set('Prefer', preferences.join(', '))
    return headers
  }

  private request<T>(pathOrUrl: string, init: RequestInit = {}, pageSize?: number): Promise<T> {
    return providerJson<T>(
      'outlook',
      this.fetcher,
      this.resolveUrl(pathOrUrl),
      {
        ...init, headers: this.headers(init, pageSize),
        signal: init.signal ? AbortSignal.any([init.signal, this.requests.signal]) : this.requests.signal,
      },
      this.credentials.timeoutMs,
    )
  }

  private async collection<T extends { id: string }>(
    pathOrUrl: string,
    init: RequestInit = {},
    pageSize?: number,
  ): Promise<GraphCollection<T>> {
    const result = await this.request<GraphCollection<T>>(pathOrUrl, init, pageSize)
    if (!result || typeof result !== 'object' || !Array.isArray(result.value)) {
      throw new ProviderError('outlook', 'UPSTREAM', 'Graph returned an invalid collection')
    }
    if (result.value.some((item) => !item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id)) {
      throw new ProviderError('outlook', 'UPSTREAM', 'Graph returned a collection item without a valid identifier')
    }
    for (const key of ['@odata.nextLink', '@odata.deltaLink'] as const) {
      const link = result[key]
      if (link !== undefined && (typeof link !== 'string' || !link)) {
        throw new ProviderCursorExpiredError('outlook', 'Graph returned an invalid pagination cursor')
      }
      if (link) this.resolveUrl(link)
    }
    return result
  }

  private normalizeAttachment(attachment: GraphAttachment, messageId: string): Attachment {
    if (!attachment || typeof attachment.id !== 'string' || !attachment.id) {
      throw new ProviderError('outlook', 'UPSTREAM', 'Graph returned an attachment without a valid identifier')
    }
    return {
      id: attachment.id,
      filename: typeof attachment.name === 'string' && attachment.name ? attachment.name : 'attachment',
      contentType: typeof attachment.contentType === 'string' && attachment.contentType
        ? attachment.contentType
        : 'application/octet-stream',
      size: typeof attachment.size === 'number' && Number.isFinite(attachment.size) && attachment.size >= 0
        ? attachment.size
        : 0,
      url: attachmentUrl(this.accountId, messageId, attachment.id),
      ...(attachment.isInline ? { inline: true } : {}),
      ...(typeof attachment.contentId === 'string' && attachment.contentId ? { contentId: attachment.contentId } : {}),
    }
  }

  private normalize(message: GraphMessage, folderHint?: MailFolder): MailMessage {
    if (!message || typeof message.id !== 'string' || !message.id) {
      throw new ProviderError('outlook', 'UPSTREAM', 'Graph returned a message without a valid identifier')
    }
    const body = typeof message.body?.content === 'string' ? message.body.content : ''
    const isHtml = typeof message.body?.contentType === 'string' && message.body.contentType.toLowerCase() === 'html'
    const folder = message.isDraft
      ? 'drafts'
      : message.parentFolderId
        ? this.folderIds.get(message.parentFolderId) ?? folderHint ?? 'inbox'
        : folderHint ?? 'inbox'
    return {
      id: message.id,
      threadId: typeof message.conversationId === 'string' && message.conversationId ? message.conversationId : message.id,
      accountId: this.accountId,
      from: graphParticipant(message.from ?? message.sender),
      to: graphRecipients(message.toRecipients),
      cc: graphRecipients(message.ccRecipients),
      bcc: graphRecipients(message.bccRecipients),
      replyTo: graphRecipients(message.replyTo),
      ...(message.internetMessageId ? { rfcMessageId: message.internetMessageId } : {}),
      headers: Object.fromEntries((message.internetMessageHeaders ?? []).map(({ name, value }) => [name.toLowerCase(), value])),
      ...(message.internetMessageHeaders?.find((header) => header.name.toLowerCase() === 'in-reply-to')?.value
        ? { inReplyTo: message.internetMessageHeaders.find((header) => header.name.toLowerCase() === 'in-reply-to')!.value } : {}),
      references: message.internetMessageHeaders?.find((header) => header.name.toLowerCase() === 'references')?.value.match(/<[^>]+>/g) ?? [],
      subject: typeof message.subject === 'string' ? message.subject : '',
      preview: typeof message.bodyPreview === 'string' ? message.bodyPreview : previewText(body),
      bodyText: isHtml ? htmlToPlainText(body) : body,
      bodyHtml: isHtml ? body : '',
      receivedAt: normalizeDate(message.receivedDateTime ?? message.sentDateTime ?? message.createdDateTime),
      isRead: message.isRead ?? false,
      isStarred: message.flag?.flagStatus === 'flagged',
      folder,
      folderIds: message.parentFolderId ? [message.parentFolderId] : [folder],
      labels: Array.isArray(message.categories)
        ? message.categories.filter((category): category is string => typeof category === 'string')
        : [],
      attachments: (Array.isArray(message.attachments) ? message.attachments : [])
        .map((attachment) => this.normalizeAttachment(attachment, message.id)),
    }
  }

  private async hydrate(message: GraphMessage, folderHint?: MailFolder): Promise<MailMessage> {
    const hasInlineAttachments = typeof message.body?.contentType === 'string'
      && message.body.contentType.toLowerCase() === 'html'
      && typeof message.body.content === 'string'
      && /\bcid\s*:/i.test(message.body.content)
    if ((message.hasAttachments || hasInlineAttachments) && !Array.isArray(message.attachments)) {
      const attachments: GraphAttachment[] = []
      let path: string | undefined = `/me/messages/${encodeURIComponent(message.id)}/attachments?$select=id,name,contentType,size,isInline,contentId`
      const seen = new Set<string>()
      while (path) {
        const url = this.resolveUrl(path)
        if (seen.has(url)) throw new ProviderCursorExpiredError('outlook', 'Graph attachment pagination cursor repeated')
        seen.add(url)
        const page: GraphCollection<GraphAttachment> = await this.collection<GraphAttachment>(path)
        attachments.push(...page.value)
        path = page['@odata.nextLink']
      }
      message = { ...message, attachments }
    }
    return this.normalize(message, folderHint)
  }

  private async hydrateMessages(
    messages: GraphMessage[],
    folderHint?: MailFolder,
    search = false,
  ): Promise<MailMessage[]> {
    const unique = [...new Map(messages.map((message) => [message.id, message])).values()]
    const hydrated: MailMessage[] = []

    for (let index = 0; index < unique.length; index += 5) {
      const settled = await Promise.allSettled(
        unique.slice(index, index + 5).map((message) =>
          search ? this.getMessage(message.id) : this.hydrate(message, folderHint),
        ),
      )
      for (const result of settled) {
        if (result.status === 'fulfilled') hydrated.push(result.value)
        else if (!(result.reason instanceof ProviderNotFoundError)) throw result.reason
      }
    }

    return hydrated
  }

  private folderPath(folder: MailFolder | undefined): string {
    if (!folder) return '/me/messages'
    if (folder === 'starred') return '/me/messages'
    if (folder === 'scheduled' || folder === 'snoozed') throw new UnsupportedOperationError('outlook', `the ${folder} folder`)
    const id = GRAPH_FOLDERS[folder] ?? folder
    return `/me/mailFolders/${encodeURIComponent(id)}/messages`
  }

  async getAccount(): Promise<MailAccount> {
    const [profile, inbox] = await Promise.all([
      this.request<{ displayName?: string; mail?: string; userPrincipalName?: string }>('/me?$select=displayName,mail,userPrincipalName'),
      this.request<GraphFolder>('/me/mailFolders/inbox?$select=id,displayName,unreadItemCount'),
    ])
    this.folderIds.set(inbox.id, 'inbox')
    const email = profile.mail ?? profile.userPrincipalName ?? this.credentials.email ?? ''
    return createMailAccount('outlook', this.credentials, {
      email,
      name: this.credentials.name ?? profile.displayName ?? email,
      unreadCount: inbox.unreadItemCount ?? 0,
    })
  }

  async listFolders(): Promise<ProviderFolder[]> {
    const folders: ProviderFolder[] = []
    let path: string | undefined = '/me/mailFolders?$top=100&$select=id,displayName,unreadItemCount,totalItemCount'
    const seen = new Set<string>()
    while (path) {
      const url = this.resolveUrl(path)
      if (seen.has(url)) throw new ProviderCursorExpiredError('outlook', 'Graph folder pagination cursor repeated')
      seen.add(url)
      const result: GraphCollection<GraphFolder> = await this.collection<GraphFolder>(path)
      for (const item of result.value) {
        if (typeof item.displayName !== 'string') {
          throw new ProviderError('outlook', 'UPSTREAM', 'Graph returned a folder without a valid display name')
        }
        const classified = this.folderIds.get(item.id) ?? classifyFolder(item.displayName)
        const folder = classified ?? 'inbox'
        this.folderIds.set(item.id, folder)
        folders.push({
          id: item.id,
          name: item.displayName,
          folder,
          kind: 'folder',
          ...(classified ? {} : { path: item.displayName, custom: true }),
          unreadCount: item.unreadItemCount ?? 0,
          totalCount: item.totalItemCount ?? 0,
        })
      }
      path = result['@odata.nextLink']
    }
    folders.push({ id: 'flagged', name: 'Flagged', folder: 'starred' })
    return folders
  }

  async createFolder(name: string): Promise<ProviderFolder> {
    let folder: GraphFolder
    try {
      folder = await this.request<GraphFolder>('/me/mailFolders', {
        method: 'POST',
        body: JSON.stringify({ displayName: name }),
      })
    } catch (error) {
      const details = error instanceof ProviderError && error.details && typeof error.details === 'object'
        ? error.details as { error?: { code?: string } }
        : undefined
      if (error instanceof ProviderError && ['ErrorFolderExists', 'ErrorNameAlreadyExists', 'nameAlreadyExists']
        .includes(details?.error?.code ?? '')) {
        throw new ProviderError('outlook', 'VALIDATION', 'A folder with that name already exists', {
          status: 409,
          details: error.details,
          cause: error,
        })
      }
      throw error
    }
    if (!folder || typeof folder.id !== 'string' || !folder.id || typeof folder.displayName !== 'string') {
      throw new ProviderError('outlook', 'UPSTREAM', 'Graph returned an invalid created folder')
    }
    this.folderIds.set(folder.id, 'inbox')
    return { id: folder.id, name: folder.displayName, folder: 'inbox', kind: 'folder', path: folder.displayName, custom: true }
  }

  async listMessages(options: ListOptions = {}): Promise<ProviderListResult<MailMessage>> {
    const limit = clampLimit(options.limit)
    const params = new URLSearchParams({ $top: String(limit), $select: MESSAGE_FIELDS })
    const filters: string[] = []
    if (options.unreadOnly) filters.push('isRead eq false')
    if (options.folder === 'starred') filters.push("flag/flagStatus eq 'flagged'")
    if (filters.length) params.set('$filter', filters.join(' and '))
    if (options.search) params.set('$search', `"${options.search.replace(/"/g, '\\"')}"`)
    else params.set('$orderby', 'receivedDateTime desc')

    const path = options.cursor ?? `${this.folderPath(options.folder)}?${params}`
    const result = await this.collection<GraphMessage>(path, {}, limit)

    // Graph search can ignore the immutable-ID preference, so re-fetch search hits individually.
    const items = await this.hydrateMessages(result.value, options.folder, Boolean(options.search))
    return {
      items,
      nextCursor: result['@odata.nextLink'] ?? null,
      hasMore: Boolean(result['@odata.nextLink']),
      ...(result['@odata.count'] === undefined ? {} : { total: result['@odata.count'] }),
    }
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

  async getMessage(messageId: string): Promise<MailMessage> {
    const message = await this.request<GraphMessage>(
      `/me/messages/${encodeURIComponent(messageId)}?$select=${encodeURIComponent(MESSAGE_FIELDS)}`,
    )
    return this.hydrate(message)
  }

  async getThread(threadId: string): Promise<MailThread> {
    const escaped = threadId.replace(/'/g, "''")
    const params = new URLSearchParams({
      $filter: `conversationId eq '${escaped}'`,
      $select: MESSAGE_FIELDS,
      $top: '100',
    })
    const messages: MailMessage[] = []
    let path: string | undefined = `/me/messages?${params}`
    const seen = new Set<string>()
    while (path) {
      const url = this.resolveUrl(path)
      if (seen.has(url)) throw new ProviderCursorExpiredError('outlook', 'Graph thread pagination cursor repeated')
      seen.add(url)
      const page: GraphCollection<GraphMessage> = await this.collection<GraphMessage>(path)
      messages.push(...await this.hydrateMessages(page.value))
      path = page['@odata.nextLink']
    }
    return requireThread('outlook', [...new Map(messages.map((message) => [message.id, message])).values()], threadId)
  }

  async sync(cursor?: SyncCursor | string | null, options: SyncOptions = {}): Promise<SyncResult> {
    const current = normalizeCursor('outlook', cursor, 'delta')
    if (current && current.kind !== 'delta') {
      throw new ProviderCursorExpiredError('outlook', 'Graph synchronization requires a delta cursor')
    }
    if (current?.metadata?.accountId && current.metadata.accountId !== this.accountId) {
      throw new ProviderCursorExpiredError('outlook', 'Graph delta cursors cannot be reused for another account')
    }
    const folder = options.folder ?? current?.folder ?? 'inbox'
    if (['starred', 'scheduled', 'snoozed'].includes(folder)) throw new UnsupportedOperationError('outlook', `delta synchronization for ${folder}`)
    const folderId = GRAPH_FOLDERS[folder] ?? folder
    if (current?.folder && current.folder !== folder) {
      throw new ProviderCursorExpiredError('outlook', 'Graph delta cursors can only be reused for their original folder')
    }

    const limit = clampLimit(options.limit)
    const initialPath = `/me/mailFolders/${encodeURIComponent(folderId)}/messages/delta?$select=${encodeURIComponent(MESSAGE_FIELDS)}`
    let result: GraphCollection<GraphMessage>
    let fullSync = !current || current.metadata?.snapshot === 'true'
    try {
      result = await this.collection<GraphMessage>(current?.value ?? initialPath, {}, limit)
    } catch (error) {
      const details = error instanceof ProviderError && error.details && typeof error.details === 'object'
        ? error.details as { error?: { code?: string } }
        : undefined
      if (current && error instanceof ProviderError && (error.status === 410 || details?.error?.code === 'syncStateNotFound')) {
        result = await this.collection<GraphMessage>(initialPath, {}, limit)
        fullSync = true
      } else {
        throw error
      }
    }

    const changes = [...new Map(result.value.map((message) => [message.id, message])).values()]
    const removedMessageIds = changes.filter((message) => message['@removed']).map((message) => message.id)
    const messages = await this.hydrateMessages(changes.filter((message) => !message['@removed']), folder)
    const nextLink = result['@odata.nextLink']
    const deltaLink = result['@odata.deltaLink']
    const nextCursor = nextLink || deltaLink
      ? {
        provider: 'outlook' as const,
        kind: 'delta' as const,
        value: (nextLink ?? deltaLink)!,
        folder,
        metadata: { accountId: this.accountId, ...(nextLink && fullSync ? { snapshot: 'true' } : {}) },
      }
      : null
    return {
      messages,
      threads: buildThreads(messages),
      deletedMessageIds: [],
      removedMessageIds,
      cursor: nextCursor,
      hasMore: Boolean(nextLink),
      fullSync,
      snapshotComplete: fullSync && !nextLink,
      ...(!nextLink && deltaLink ? { recentCursor: nextCursor } : {}),
    }
  }

  async send(input: SendInput): Promise<SendResult> {
    if (input.accountId !== undefined && input.accountId !== this.accountId) {
      throw new ProviderAuthorizationError('outlook', 'The message belongs to a different account')
    }
    if (input.scheduledAt) throw new UnsupportedOperationError('outlook', 'scheduled sending')
    const html = input.bodyHtml ?? input.html
    const payload: Record<string, unknown> = {
      subject: input.subject,
      body: { contentType: html === undefined ? 'Text' : 'HTML', content: html ?? input.bodyText ?? input.text ?? input.body ?? '' },
      toRecipients: recipientPayload(input.to),
      ccRecipients: recipientPayload(input.cc),
      bccRecipients: recipientPayload(input.bcc),
      ...(input.from ? { from: recipientPayload(input.from)[0] } : {}),
      ...(!input.threadId && !input.sourceMessageId && input.headers ? {
        internetMessageHeaders: Object.entries(input.headers).map(([name, value]) => ({ name, value })),
      } : {}),
    }
    const attachments = (input.attachments ?? []).map((attachment) => ({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: attachment.filename,
      contentType: attachment.contentType ?? 'application/octet-stream',
      contentBytes: attachmentContent(attachment).toString('base64'),
      ...(attachment.inline ? { isInline: true } : {}),
      ...(attachment.contentId ? { contentId: attachment.contentId } : {}),
    }))

    let draft: GraphMessage
    if (input.sourceMessageId || input.threadId) {
      const original = input.sourceMessageId ? await this.getMessage(input.sourceMessageId)
        : (await this.getThread(input.threadId!)).messages.at(-1)!
      const action = input.replyAll ? 'createReplyAll' : 'createReply'
      draft = await this.request<GraphMessage>(`/me/messages/${encodeURIComponent(original.id)}/${action}`, { method: 'POST' })
      draft = await this.request<GraphMessage>(`/me/messages/${encodeURIComponent(draft.id)}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      })
      for (const attachment of attachments) {
        await this.request<GraphAttachment>(`/me/messages/${encodeURIComponent(draft.id)}/attachments`, {
          method: 'POST',
          body: JSON.stringify(attachment),
        })
      }
    } else {
      if (attachments.length) payload.attachments = attachments
      draft = await this.request<GraphMessage>('/me/messages', { method: 'POST', body: JSON.stringify(payload) })
    }

    await this.request<void>(`/me/messages/${encodeURIComponent(draft.id)}/send`, { method: 'POST' })
    return {
      id: draft.id,
      ...(draft.conversationId ? { threadId: draft.conversationId } : {}),
      ...(draft.internetMessageId ? { messageId: draft.internetMessageId } : {}),
    }
  }

  async mutate(messageId: string, mutation: MessageMutation): Promise<MailMessage | null> {
    if (mutation.snoozedUntil !== undefined) throw new UnsupportedOperationError('outlook', 'snoozing')
    if (mutation.deletePermanently) throw new UnsupportedOperationError('outlook', 'permanent deletion')
    const destination = mutation.folder ?? (mutation.isArchived === undefined ? undefined : mutation.isArchived ? 'archive' : 'inbox')
    if (destination === 'scheduled' || destination === 'snoozed') {
      throw new UnsupportedOperationError('outlook', `moving messages to ${destination}`)
    }

    const path = `/me/messages/${encodeURIComponent(messageId)}`
    const changes: Record<string, unknown> = {}
    if (mutation.isRead !== undefined) changes.isRead = mutation.isRead
    if (mutation.isStarred !== undefined) changes.flag = { flagStatus: mutation.isStarred ? 'flagged' : 'notFlagged' }
    if (mutation.addLabels?.length || mutation.removeLabels?.length) {
      const message = await this.getMessage(messageId)
      const categories = new Set(message.labels)
      for (const label of mutation.addLabels ?? []) categories.add(label)
      for (const label of mutation.removeLabels ?? []) categories.delete(label)
      changes.categories = [...categories]
    }
    if (Object.keys(changes).length) {
      await this.request<GraphMessage>(path, { method: 'PATCH', body: JSON.stringify(changes) })
    }

    if (destination) {
      if (destination === 'starred') {
        await this.request<GraphMessage>(path, {
          method: 'PATCH',
          body: JSON.stringify({ flag: { flagStatus: 'flagged' } }),
        })
      } else {
        const destinationId = GRAPH_FOLDERS[destination] ?? destination
        const moved = await this.request<GraphMessage>(`${path}/move`, {
          method: 'POST',
          body: JSON.stringify({ destinationId }),
        })
        if (moved.parentFolderId) this.folderIds.set(moved.parentFolderId, destination)
        return this.hydrate(moved, destination)
      }
    }
    return this.getMessage(messageId)
  }

  async getAttachment(messageId: string, attachmentId: string): Promise<AttachmentData> {
    const attachment = await this.request<GraphAttachment>(
      `/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}?$select=id,name,contentType,size,isInline,contentId`,
    )
    const path = `/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}/$value`
    const response = await providerRequest(
      'outlook',
      this.fetcher,
      this.resolveUrl(path),
      { headers: this.headers(), signal: this.requests.signal },
      this.credentials.timeoutMs,
    )
    const normalized = this.normalizeAttachment(attachment, messageId)
    return {
      attachment: normalized,
      content: await providerBytes('outlook', response),
      filename: normalized.filename,
      contentType: response.headers.get('content-type') ?? normalized.contentType,
    }
  }

  async disconnect(): Promise<void> { this.requests.abort() }
}
