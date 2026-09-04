import { Hono, type Context } from 'hono'
import busboy from 'busboy'
import { z } from 'zod'
import { InboxError, type ChangeEvent, type ChangePage, type Inbox } from './contracts'

export interface InboxApiOptions {
  inbox: Inbox
  authenticate: (request: Request) => Promise<{ id: string } | null> | { id: string } | null
  allowedOrigins?: string[]
  heartbeatMs?: number
  streamPollMs?: number
  maxStreamsPerOwner?: number
}

type Environment = { Variables: { owner: string; body: Uint8Array<ArrayBuffer> } }
type ApiContext = Context<Environment>
type Method = 'get' | 'post' | 'put' | 'patch' | 'delete'
type RouteDoc = {
  summary: string
  input?: string
  output?: string
  query?: z.ZodType
  status?: 200 | 201 | 202 | 204
  conditional?: boolean
  idempotent?: boolean
  description?: string
  mediaType?: string
  noStore?: boolean
}

const JSON_LIMIT = 1024 * 1024
const FILE_LIMIT = 25 * 1024 * 1024
const STREAM_PAGE_SIZE = 100
const STREAM_LIFETIME_MS = 5 * 60 * 1000
const encoder = new TextEncoder()
const id = z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f/\\]+$/)
const opaque = z.string().min(1).max(4096).regex(/^[^\u0000-\u001f\u007f]+$/)
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const limit = z.number().int().min(1).max(100)
const date = z.string().min(1).max(100).refine((value) => Number.isFinite(Date.parse(value)))
  .describe('A valid date or timestamp accepted by Date.parse.')
const name = z.string().min(1).max(512)
const credentials = z.record(z.string(), z.unknown())
const participant = z.strictObject({
  name: z.string().max(1024), email: z.string().min(1).max(1024), avatar: z.string().nullable().optional(),
})
const draftInput = z.strictObject({
  accountId: id,
  mailboxId: id.optional(),
  from: z.string().max(1024).optional(),
  to: z.array(participant).max(200).optional(),
  cc: z.array(participant).max(200).optional(),
  bcc: z.array(participant).max(200).optional(),
  subject: z.string().max(998).regex(/^[^\r\n\u0000]*$/).optional(),
  bodyText: z.string().max(JSON_LIMIT).optional(),
  bodyHtml: z.string().max(JSON_LIMIT).optional(),
  attachmentIds: z.array(id).max(20).optional(),
  mode: z.enum(['compose', 'reply', 'replyAll', 'forward']).optional(),
  sourceMessageId: id.optional(),
})
const querySchema = z.strictObject({
  accountId: id.optional(), folder: name.optional(), labelId: id.optional(),
  search: z.string().max(2000).optional(), unreadOnly: z.boolean().optional(),
  starredOnly: z.boolean().optional(), hasAttachments: z.boolean().optional(),
  from: name.optional(), to: name.optional(), before: date.optional(), after: date.optional(),
  sort: z.enum(['newest', 'oldest']).optional(), cursor: opaque.optional(), limit: limit.optional(),
})
const mailboxQuery = querySchema.omit({ accountId: true }).extend({
  mailboxIds: z.array(id).min(1).max(50), done: z.boolean().optional(), snoozed: z.boolean().optional(),
})
const pageQuery = querySchema.pick({ cursor: true, limit: true, sort: true })
const accountQuery = querySchema.pick({ accountId: true })
const folderQuery = z.strictObject({ cached: z.boolean().optional() })
const changesQuery = z.strictObject({ since: opaque.optional(), limit: z.number().int().min(1).max(1000).optional() })
const eventsQuery = changesQuery.pick({ since: true })
const emptyQuery = z.strictObject({})
const changesInput = z.strictObject({
  isRead: z.boolean().optional(), isStarred: z.boolean().optional(), isArchived: z.boolean().optional(),
  folder: name.optional(), folderId: id.optional(),
  addLabels: z.array(name).max(1000).optional(), removeLabels: z.array(name).max(1000).optional(),
  addLabelIds: z.array(id).max(1000).optional(), removeLabelIds: z.array(id).max(1000).optional(),
  snoozedUntil: date.nullable().optional(), deletePermanently: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0)
const policy = z.strictObject({ remoteImages: z.boolean(), undoSendSeconds: z.number().int().min(0).max(120) })
const blobInfo = z.object({
  id, accountId: id, filename: z.string(), contentType: z.string(), size: revision,
  inline: z.boolean().optional(), contentId: z.string().optional(),
})
const label = z.object({ id, accountId: id, name: z.string(), scope: z.literal('local'), revision })
const problem = z.object({ code: z.string(), message: z.string(), retryable: z.boolean() })
const sourceFacts = z.object({
  version: z.literal(1), listId: z.boolean().optional(), listUnsubscribe: z.boolean().optional(),
  listPost: z.boolean().optional(), bulk: z.boolean().optional(), automated: z.boolean().optional(),
  unsubscribeLink: z.boolean().optional(), reply: z.boolean().optional(),
  nativeCategories: z.array(z.string().regex(/^[a-z_]{1,40}$/)).max(8).optional(),
  nativeImportant: z.boolean().optional(),
})
const messageSummary = z.object({
  id, accountId: id, threadId: id, revision, from: participant, to: z.array(participant), cc: z.array(participant),
  subject: z.string(), preview: z.string(), receivedAt: z.string(), isRead: z.boolean(), isStarred: z.boolean(),
  folder: z.string(), folderIds: z.array(id), labelIds: z.array(id), hasAttachments: z.boolean(),
  snoozedUntil: z.string().nullable(), facts: sourceFacts.optional(), bodyRevision: opaque.optional(),
})
const message = messageSummary.extend({
  bcc: z.array(participant), bodyText: z.string(), bodyHtml: z.string(),
  bodyFormat: z.enum(['html', 'text']).optional(),
  bodyDocument: z.object({ html: z.string(), styles: z.string() }).optional(),
  attachments: z.array(blobInfo), replyTo: z.array(participant).optional(),
})
const mailboxSelector = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('all') }),
  z.strictObject({ kind: z.enum(['domain', 'address']), value: name }),
])
const membership = z.object({ mailboxId: id, messageId: id, revision, done: z.boolean(), snoozedUntil: z.string().nullable() })
const mailboxMessageSummary = messageSummary.omit({ snoozedUntil: true }).extend({ sourceId: id, memberships: z.array(membership) })
const mailboxReadInput = z.strictObject({ mailboxIds: z.array(id).min(1).max(1000), limit: z.number().int().min(1).max(500).optional() })
const threadSummary = z.object({
  id, accountId: id, subject: z.string(), preview: z.string(), messageCount: revision,
  matchingMessageCount: revision, isRead: z.boolean(), isStarred: z.boolean(), lastMessageAt: z.string(),
  hasAttachments: z.boolean(),
})
const changeEvent = z.object({
  id: opaque,
  type: z.enum(['mail.changed', 'account.updated', 'draft.updated', 'operation.updated', 'label.updated', 'policy.updated', 'connection.updated', 'mailbox.updated', 'membership.updated']),
  accountId: id.nullable(), entityId: z.string(), change: z.enum(['created', 'updated', 'deleted']),
  reason: z.enum(['arrival', 'initial', 'backfill', 'mutation']), at: z.string(), mailboxId: id.optional(),
})
const schemas = {
  Error: z.object({ code: z.string(), error: z.string(), retryable: z.boolean() }),
  Provider: z.object({ id: name, name: z.string(), connection: z.enum(['oauth', 'credentials']), scopes: z.array(z.string()) }),
  Account: z.object({
    id, providerId: name, email: z.string(), name: z.string(), generation: revision,
    status: z.enum(['connected', 'disconnected', 'reconnect_required']),
    capabilities: z.record(z.string(), z.boolean()),
    features: z.object({ localDrafts: z.literal(true), localLabels: z.literal(true), snooze: z.literal(true), scheduledSend: z.boolean(), undoSend: z.boolean() }),
    sync: z.object({ lastSyncAt: z.string().nullable(), coverage: z.enum(['empty', 'partial', 'complete']), problem: z.string().nullable() }),
    revision, connectionId: id.optional(),
  }),
  Connection: z.object({
    id, providerId: name, name: z.string(), status: z.enum(['connected', 'disconnected', 'reconnect_required']),
    generation: revision, sourceIds: z.array(id),
    identity: z.object({ issuer: z.string(), subject: z.string(), registrationId: z.string() }).nullable(),
    createdAt: z.string(),
  }),
  MailboxSelector: mailboxSelector,
  MailboxCandidate: z.object({
    sourceId: id, name: z.string(), selector: mailboxSelector,
    canReceive: z.boolean(), canSend: z.boolean(), canFilter: z.boolean(),
    identities: z.array(z.string()), unavailableReason: z.string().optional(),
  }),
  Mailbox: z.object({
    id, sourceId: id, connectionId: id, name: z.string(), selector: mailboxSelector,
    status: z.enum(['active', 'paused', 'detached']), defaultSender: z.string().nullable(), revision,
    receiving: z.enum(['ready', 'blocked', 'unverified']),
  }),
  MailboxInput: z.strictObject({ sourceId: id, name, selector: mailboxSelector, defaultSender: z.string().min(1).max(1024).nullable().optional() }),
  MailboxPatch: z.strictObject({
    name: name.optional(), status: z.enum(['active', 'paused', 'detached']).optional(),
    defaultSender: z.string().min(1).max(1024).nullable().optional(),
  }).refine((value) => Object.keys(value).length > 0),
  MailboxState: z.strictObject({ done: z.boolean().optional(), snoozedUntil: date.nullable().optional() }).refine((value) => Object.keys(value).length > 0),
  MailboxAction: z.strictObject({ id: id.max(128), done: z.boolean(), targets: z.array(z.strictObject({
    mailboxId: id, messageId: id, revision: revision.min(1), messageRevision: revision.min(1).optional(),
  })).min(1).max(500) }),
  MailboxStateReceipt: z.object({ id: id.max(128), retracted: z.boolean(), states: z.array(membership).max(500) }),
  Membership: membership,
  MailboxMessageSummary: mailboxMessageSummary,
  MailboxMessage: message.extend({ sourceId: id, memberships: z.array(membership) }),
  MailboxMessagePage: z.object({ items: z.array(mailboxMessageSummary), nextCursor: opaque.nullable(), state: opaque, total: revision }),
  MailboxSnapshotInput: mailboxReadInput.extend({ cursor: opaque.optional() }),
  MailboxSnapshotPage: z.object({ items: z.array(mailboxMessageSummary).max(500), nextCursor: opaque.nullable(), state: opaque, total: revision, scopeState: opaque, expiresAt: date }),
  MailboxChangesInput: mailboxReadInput.extend({ since: opaque, scopeState: opaque }),
  MailboxChangesPage: z.object({ events: z.array(changeEvent).max(500), upserts: z.array(mailboxMessageSummary).max(500),
    removed: z.array(z.object({ sourceId: id, messageId: id, reason: z.enum(['deleted', 'unselected']), revision: revision.nullable() })).max(500),
    state: opaque, hasMore: z.boolean(), resetRequired: z.boolean(), resetReason: z.enum(['history', 'scope']).optional() }),
  CredentialState: z.object({ connectionId: id, generation: revision, version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    status: z.enum(['connected', 'disconnected', 'reconnect_required']) }),
  CredentialUpdate: z.strictObject({ credentials }),
  Connect: z.strictObject({ providerId: name, credentials }),
  Reconnect: credentials,
  SyncRequest: z.strictObject({ folder: name.optional(), lane: z.enum(['latest', 'backfill']).optional(), reset: z.boolean().optional(), limit: limit.optional() }),
  SyncResult: z.object({ synchronized: revision, hasMore: z.boolean(), state: opaque }),
  Name: z.strictObject({ name: name.max(255) }),
  Folder: z.object({ id, accountId: id, name: z.string(), role: z.string(), kind: z.enum(['folder', 'label']), scope: z.literal('provider') }),
  LabelInput: z.strictObject({ accountId: id, name: name.max(255) }),
  Label: label,
  BlobInfo: blobInfo,
  Message: message,
  MessagePage: z.object({ items: z.array(messageSummary), nextCursor: opaque.nullable(), state: opaque, total: revision }),
  ThreadPage: z.object({ items: z.array(threadSummary), nextCursor: opaque.nullable(), state: opaque, total: revision }),
  DraftInput: draftInput,
  DraftPatch: draftInput.partial().refine((value) => Object.keys(value).length > 0),
  Draft: draftInput.required().extend({ id, revision, sourceMessageId: id.optional(), mailboxId: id.optional(), status: z.enum(['active', 'submitted']), updatedAt: z.string() }),
  Submit: z.strictObject({ revision, sendAt: date.optional() }),
  Mutation: z.strictObject({ messageIds: z.array(id).min(1).max(500), changes: changesInput, ifRevisions: z.record(id, revision).optional(), viaMailboxId: id.optional() }),
  Operation: z.object({
    id, accountId: id, type: z.enum(['mutation', 'send']),
    status: z.enum(['pending', 'processing', 'succeeded', 'partial', 'failed', 'cancelled', 'uncertain']),
    createdAt: z.string(), sendAt: z.string().nullable(), attempts: revision, problem: problem.nullable(),
    results: z.array(z.object({ messageId: id, status: z.enum(['succeeded', 'failed']), problem: problem.optional() })),
    mutationRevisions: z.array(z.object({ messageId: id, before: revision, after: revision }).refine(edge => edge.after > edge.before)).max(2000).optional(),
  }),
  Reschedule: z.strictObject({ sendAt: date }),
  Policy: policy,
  PolicyPatch: policy.partial().refine((value) => Object.keys(value).length > 0),
  ChangeEvent: changeEvent,
  ChangePage: z.object({ events: z.array(changeEvent), state: opaque, hasMore: z.boolean(), resetRequired: z.boolean() }),
}

function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new InboxError('INVALID_INPUT', 'Invalid request input', 400)
  return parsed.data
}

function pathId(c: ApiContext): string { return validate(id, c.req.param('id')) }

function query<T>(c: ApiContext, schema: z.ZodType<T>): T {
  const input: Record<string, unknown> = Object.create(null)
  for (const [key, value] of new URL(c.req.url).searchParams) {
    if (Object.hasOwn(input, key)) throw new InboxError('INVALID_QUERY', 'Repeated query parameter', 400)
    if (key === 'limit') {
      if (!/^[1-9]\d*$/.test(value)) throw new InboxError('INVALID_QUERY', 'Invalid limit', 400)
      input[key] = Number(value)
    } else if (['unreadOnly', 'starredOnly', 'hasAttachments', 'done', 'snoozed', 'cached'].includes(key)) {
      if (value !== 'true' && value !== 'false') throw new InboxError('INVALID_QUERY', 'Boolean query values must be true or false', 400)
      input[key] = value === 'true'
    } else if (key === 'mailboxIds') {
      if (value.length > 50 * 512 + 49) throw new InboxError('INVALID_QUERY', 'Invalid mailbox selection', 400)
      input[key] = value.split(',')
    } else input[key] = value
  }
  return validate(schema, input)
}

async function boundedBody(request: Request, maximum: number): Promise<Uint8Array<ArrayBuffer>> {
  const length = request.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) {
    throw new InboxError('BODY_TOO_LARGE', 'Request body exceeds the size limit', 413)
  }
  if (request.headers.has('content-encoding') && request.headers.get('content-encoding') !== 'identity') {
    throw new InboxError('UNSUPPORTED_MEDIA_TYPE', 'Encoded request bodies are not supported', 415)
  }
  if (!request.body) return new Uint8Array(0)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maximum) {
        await reader.cancel().catch(() => {})
        throw new InboxError('BODY_TOO_LARGE', 'Request body exceeds the size limit', 413)
      }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
  return body
}

function body<T>(c: ApiContext, schema: z.ZodType<T>, allowEmpty = false): T {
  const bytes = c.get('body')
  if (allowEmpty && bytes.byteLength === 0) return validate(schema, {})
  if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('content-type') ?? '')) {
    throw new InboxError('UNSUPPORTED_MEDIA_TYPE', 'Use application/json', 415)
  }
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { throw new InboxError('INVALID_JSON', 'Invalid JSON body', 400) }
  return validate(schema, value)
}

async function etag(owner: string, value: string, bytes?: Uint8Array): Promise<string> {
  const prefix = encoder.encode(`${JSON.stringify(owner)}\n${value}`)
  const input = new Uint8Array(prefix.byteLength + (bytes?.byteLength ?? 0))
  input.set(prefix)
  if (bytes) input.set(bytes, prefix.byteLength)
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', input))
  return `"${Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('')}"`
}

function matches(value: string | undefined, tag: string, weak = false): boolean {
  return !!value && value.length <= 8192 && value.split(',').some((part) => {
    const candidate = part.trim()
    return weak && candidate === '*' || (weak ? candidate.replace(/^W\//, '') : candidate) === tag
  })
}

function ifMatch(c: ApiContext): string {
  const value = c.req.header('if-match')
  if (!value) throw new InboxError('PRECONDITION_REQUIRED', 'If-Match is required', 428)
  return value
}

async function matchEntity(c: ApiContext, entity: unknown, representation?: unknown): Promise<void> {
  const supplied = ifMatch(c)
  const text = JSON.stringify(entity)
  if (matches(supplied, await etag(c.get('owner'), representation === undefined ? text : `${JSON.stringify(representation)}\n${text}`))) return
  throw new InboxError('PRECONDITION_FAILED', 'The resource has changed', 412)
}

function idempotencyKey(c: ApiContext): string {
  const key = c.req.header('idempotency-key')
  if (!key || key.length > 200 || /[^\x21-\x7e]/.test(key)) {
    throw new InboxError('IDEMPOTENCY_KEY_REQUIRED', 'A valid Idempotency-Key header is required', 400)
  }
  return key
}

function safeError(error: unknown): { status: number; code: string; error: string; retryable: boolean } {
  const known = error instanceof InboxError
  const status = known && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500
  const code = known && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : 'INTERNAL_ERROR'
  const messages: Record<number, string> = {
    400: 'Invalid request', 401: 'Authentication required', 403: 'Request not permitted',
    404: 'Resource not found', 405: 'Method not allowed', 409: 'The request conflicts with the current state',
    410: 'The requested state is no longer available', 412: 'The resource has changed',
    413: 'Request body exceeds the size limit', 415: 'Unsupported request media type',
    416: 'Requested byte range is not satisfiable', 422: 'Invalid request', 428: 'If-Match is required',
    429: 'Too many requests', 501: 'Operation not supported', 502: 'Upstream service unavailable',
    503: 'Service temporarily unavailable', 504: 'Upstream service timed out',
  }
  return { status, code, error: messages[status] ?? 'Request failed', retryable: known ? error.retryable : true }
}

/** A versioned, owner-scoped adapter. The host supplies authentication and owns the Inbox lifecycle. */
export function createInboxApi(options: InboxApiOptions) {
  const { inbox } = options
  const app = new Hono<Environment>()
  const origins = new Set(options.allowedOrigins ?? [])
  for (const origin of origins) {
    let parsed: URL
    try { parsed = new URL(origin) } catch { throw new TypeError('allowedOrigins must contain exact HTTP(S) origins') }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new TypeError('allowedOrigins must contain exact HTTP(S) origins')
    }
  }
  const heartbeatMs = options.heartbeatMs ?? 15000
  const streamPollMs = options.streamPollMs ?? 1000
  const maxStreams = options.maxStreamsPerOwner ?? 4
  for (const value of [heartbeatMs, streamPollMs, maxStreams]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new RangeError('Stream limits must be positive integers')
  }
  const streams = new Map<string, number>()
  const paths: Record<string, Record<string, unknown>> = {}
  const ref = (schema: string) => schema.endsWith('[]')
    ? { type: 'array', items: { $ref: `#/components/schemas/${schema.slice(0, -2)}` } }
    : { $ref: `#/components/schemas/${schema}` }
  const errorResponse = { description: 'Safe error; authentication and errors are never cached.', content: { 'application/json': { schema: ref('Error') } } }
  const corsHeaders = ['authorization', 'content-type', 'if-match', 'if-none-match', 'idempotency-key', 'last-event-id', 'range', 'if-range']

  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Vary', 'Origin, Authorization, Cookie')
    const origin = c.req.header('origin')
    if (origin && origins.has(origin)) {
      c.header('Access-Control-Allow-Origin', origin)
      c.header('Access-Control-Allow-Credentials', 'true')
      c.header('Access-Control-Expose-Headers', 'ETag, Content-Disposition, Content-Range, Accept-Ranges, X-Inbox-Blob-Info, Retry-After')
    }
    if (c.req.method === 'OPTIONS' && c.req.header('access-control-request-method')) {
      const method = c.req.header('access-control-request-method')!
      const requested = (c.req.header('access-control-request-headers') ?? '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean)
      if (!origin || !origins.has(origin) || !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || requested.some((header) => !corsHeaders.includes(header))) {
        throw new InboxError('ORIGIN_FORBIDDEN', 'Origin not permitted', 403)
      }
      c.header('Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers')
      c.header('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE')
      c.header('Access-Control-Allow-Headers', corsHeaders.join(', '))
      return c.newResponse(null, 204)
    }
    await next()
  })

  app.get('/health', (c) => c.json({ ok: true }, 200, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }))
  app.use('*', async (c, next) => {
    let identity: { id: string } | null
    try { identity = await options.authenticate(c.req.raw) }
    catch { throw new InboxError('AUTHENTICATION_UNAVAILABLE', 'Authentication unavailable', 503, true) }
    if (!identity || typeof identity.id !== 'string' || !identity.id) throw new InboxError('UNAUTHENTICATED', 'Authentication required', 401)
    c.set('owner', identity.id)
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const origin = c.req.header('origin')
      if (c.req.header('cookie') && (!origin || origin !== new URL(c.req.url).origin && !origins.has(origin))) {
        throw new InboxError('ORIGIN_FORBIDDEN', 'A trusted Origin is required for cookie-authenticated mutations', 403)
      }
      const maximum = c.req.path.endsWith('/v1/blobs') && c.req.method === 'POST' ? FILE_LIMIT + JSON_LIMIT : JSON_LIMIT
      c.set('body', await boundedBody(c.req.raw, maximum))
    }
    await next()
  })
  app.onError((error, c) => {
    const { status, ...result } = safeError(error)
    c.header('Cache-Control', 'no-store')
    c.header('ETag', undefined)
    return c.newResponse(JSON.stringify(result), status as 400, { 'Content-Type': 'application/json; charset=utf-8' })
  })
  app.notFound((c) => c.newResponse(JSON.stringify({ code: 'NOT_FOUND', error: 'Resource not found', retryable: false }), 404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }))

  async function json(c: ApiContext, value: unknown, status: 200 | 201 | 202 = 200, representation?: unknown) {
    const text = JSON.stringify(value)
    const tag = await etag(c.get('owner'), representation === undefined ? text : `${JSON.stringify(representation)}\n${text}`)
    c.header('ETag', tag)
    if (['GET', 'HEAD'].includes(c.req.method)) {
      c.header('Cache-Control', 'private, no-cache')
      if (matches(c.req.header('if-none-match'), tag, true)) return c.newResponse(null, 304)
    }
    return c.newResponse(text, status, { 'Content-Type': 'application/json; charset=utf-8' })
  }

  function route(method: Method, path: string, doc: RouteDoc, handler: (c: ApiContext) => Response | Promise<Response>) {
    const parameters: Array<Record<string, unknown>> = [...path.matchAll(/:([A-Za-z]+)/g)].map((match) => ({ name: match[1], in: 'path', required: true, schema: { type: 'string' } }))
    if (doc.query) {
      const converted = z.toJSONSchema(doc.query, { io: 'input' })
      for (const [key, schema] of Object.entries(converted.properties ?? {})) parameters.push({
        name: key, in: 'query', schema, ...(converted.required?.includes(key) ? { required: true } : {}),
        ...(key === 'mailboxIds' ? { style: 'form', explode: false } : {}),
      })
    }
    if (method === 'get' && !doc.noStore && doc.mediaType !== 'text/event-stream') parameters.push({ name: 'If-None-Match', in: 'header', schema: { type: 'string' } })
    if (doc.conditional) parameters.push({ name: 'If-Match', in: 'header', required: true, description: 'A current strong opaque entity ETag. Weak tags and * are not accepted.', schema: { type: 'string' } })
    if (doc.idempotent) parameters.push({ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 1, maxLength: 200 } })
    if (path === '/v1/events') parameters.push({ name: 'Last-Event-ID', in: 'header', description: 'Opaque resume state; takes precedence over since.', schema: { type: 'string' } })
    if (path === '/v1/blobs/:id') parameters.push(...['Range', 'If-Range'].map((key) => ({ name: key, in: 'header', schema: { type: 'string' } })))
    const status = doc.status ?? 200
    const success = { description: doc.mediaType === 'text/event-stream' ? 'Durable, metadata-only SSE stream.' : 'Success',
      ...(status === 204 ? {} : { content: { [doc.mediaType ?? 'application/json']: { schema: doc.output ? ref(doc.output) : { type: 'string' } } } }),
      ...(doc.noStore ? { headers: { 'Cache-Control': { schema: { const: 'no-store' } }, 'Referrer-Policy': { schema: { const: 'no-referrer' } } } }
        : doc.mediaType === 'text/event-stream' || status === 204 ? {} : { headers: { ETag: { description: 'Opaque, owner-scoped representation validator.', schema: { type: 'string' } } } }),
    }
    const responses: Record<string, unknown> = { [status]: success, default: errorResponse }
    if (method === 'get' && !doc.noStore && !doc.mediaType) responses['304'] = { description: 'Authenticated representation has not changed.' }
    if (doc.conditional) { responses['412'] = errorResponse; responses['428'] = errorResponse }
    if (path === '/v1/blobs/:id') { responses['206'] = success; responses['304'] = { description: 'Not modified' }; responses['416'] = errorResponse }
    if (path === '/v1/messages/:id/media/:resource') responses['304'] = { description: 'Current policy and message authorization checked before the validator.' }
    const openapiPath = path.replace(/:([A-Za-z]+)/g, '{$1}')
    paths[openapiPath] ??= {}
    paths[openapiPath][method] = {
      summary: doc.summary, description: doc.description, parameters, responses,
      ...(doc.input ? { requestBody: { required: !['/v1/accounts/:id/sync', '/v1/mailboxes/:id/sync'].includes(path), content: { [path === '/v1/blobs' ? 'multipart/form-data' : 'application/json']: { schema: ref(doc.input) } } } } : {}),
    }
    app.on(method.toUpperCase(), path, async (c) => {
      query(c, doc.query ?? emptyQuery)
      for (const match of path.matchAll(/:([A-Za-z]+)/g)) validate(id, c.req.param(match[1]!))
      return handler(c)
    })
  }

  route('get', '/v1/providers', { summary: 'List configured providers', output: 'Provider[]' }, (c) => json(c, inbox.providers()))
  route('get', '/v1/connections', { summary: 'List owned connections', output: 'Connection[]' }, async (c) => json(c, validate(z.array(schemas.Connection), await inbox.connections(c.get('owner')))))
  route('post', '/v1/connections', { summary: 'Create a connection', input: 'Connect', output: 'Connection', status: 201 }, async (c) => json(c, validate(schemas.Connection, await inbox.createConnection(c.get('owner'), body(c, schemas.Connect))), 201))
  route('get', '/v1/connections/:id', { summary: 'Get an owned connection', output: 'Connection' }, async (c) => json(c, validate(schemas.Connection, await inbox.connection(c.get('owner'), pathId(c)))))
  route('get', '/v1/connections/:id/credentials', { summary: 'Get credential version metadata without secrets', output: 'CredentialState' }, async (c) => json(c, validate(schemas.CredentialState, await inbox.credentialState(c.get('owner'), pathId(c)))))
  route('put', '/v1/connections/:id/credentials', { summary: 'Replace credentials for the same upstream store', input: 'CredentialUpdate', output: 'CredentialState', conditional: true,
    description: 'Use the ETag from the credential metadata GET. Replaces the complete credential record without changing source/message IDs. Disconnected connections cannot be revived. Verified or opaque-key stores require host identity verification.' }, async (c) => {
    ifMatch(c)
    const input = body(c, schemas.CredentialUpdate)
    const current = validate(schemas.CredentialState, await inbox.credentialState(c.get('owner'), pathId(c)))
    await matchEntity(c, current)
    return json(c, validate(schemas.CredentialState, await inbox.updateCredentials(c.get('owner'), current.connectionId, input.credentials, current.version)))
  })
  route('delete', '/v1/connections/:id', { summary: 'Disconnect an owned connection', status: 204 }, async (c) => { await inbox.disconnectConnection(c.get('owner'), pathId(c)); return c.newResponse(null, 204) })
  route('get', '/v1/connections/:id/mailbox-candidates', { summary: 'List selectable mailboxes for a connection', output: 'MailboxCandidate[]' }, async (c) => json(c, validate(z.array(schemas.MailboxCandidate), await inbox.mailboxCandidates(c.get('owner'), pathId(c)))))
  route('get', '/v1/mailboxes', { summary: 'List owned mailboxes', output: 'Mailbox[]' }, async (c) => json(c, validate(z.array(schemas.Mailbox), await inbox.mailboxes(c.get('owner')))))
  route('post', '/v1/mailboxes', { summary: 'Create a mailbox from an owned source', input: 'MailboxInput', output: 'Mailbox', status: 201 }, async (c) => json(c, validate(schemas.Mailbox, await inbox.createMailbox(c.get('owner'), body(c, schemas.MailboxInput))), 201))
  route('get', '/v1/mailboxes/:id', { summary: 'Get an owned mailbox', output: 'Mailbox' }, async (c) => json(c, validate(schemas.Mailbox, await inbox.mailbox(c.get('owner'), pathId(c)))))
  route('patch', '/v1/mailboxes/:id', { summary: 'Update a mailbox', input: 'MailboxPatch', output: 'Mailbox', conditional: true }, async (c) => {
    ifMatch(c)
    const input = body(c, schemas.MailboxPatch)
    const current = validate(schemas.Mailbox, await inbox.mailbox(c.get('owner'), pathId(c)))
    await matchEntity(c, current)
    return json(c, validate(schemas.Mailbox, await inbox.updateMailbox(c.get('owner'), current.id, input, current.revision)))
  })
  route('post', '/v1/mailboxes/:id/sync', { summary: 'Synchronize an owned mailbox', input: 'SyncRequest', output: 'SyncResult' }, async (c) => json(c, await inbox.syncMailbox(c.get('owner'), pathId(c), body(c, schemas.SyncRequest, true))))
  route('post', '/v1/mailbox-actions', { summary: 'Apply an atomic mailbox-local Done action', input: 'MailboxAction', output: 'MailboxStateReceipt',
    description: 'Body-free local state only. Targets carry membership revisions and optional message revisions. id is an owner-scoped idempotency key: the same input returns its stored receipt, not current state; conflicting reuse is rejected.' }, async (c) => json(c, validate(schemas.MailboxStateReceipt, await inbox.setMailboxStates(c.get('owner'), body(c, schemas.MailboxAction)))))
  route('post', '/v1/mailbox-actions/:id/undo', { summary: 'Undo an owned mailbox-local action', output: 'MailboxStateReceipt',
    description: 'Restores only unchanged action-owned memberships. Newer revisions conflict; repeated Undo returns the stored retracted receipt without applying it again.' }, async (c) => {
    body(c, emptyQuery, true)
    return json(c, validate(schemas.MailboxStateReceipt, await inbox.undoMailboxStates(c.get('owner'), pathId(c))))
  })
  route('get', '/v1/mailbox-messages', { summary: 'Query messages across selected mailboxes', query: mailboxQuery, output: 'MailboxMessagePage', description: 'mailboxIds is a comma-separated selection of 1 to 50 owned mailbox IDs. All IDs are validated before querying. Membership state is local to each mailbox; accountId is not accepted.' }, async (c) => {
    const owner = c.get('owner')
    const input = query(c, mailboxQuery)
    await Promise.all(input.mailboxIds.map((mailboxId) => inbox.mailbox(owner, mailboxId)))
    return json(c, validate(schemas.MailboxMessagePage, await inbox.mailboxMessages(owner, input)))
  })
  route('post', '/v1/mailbox-snapshot', { summary: 'Page a stable mailbox ID inventory with live body-free rows', input: 'MailboxSnapshotInput', output: 'MailboxSnapshotPage',
    description: 'Read-only POST; no Idempotency-Key. Select 1–1000 owned attached mailboxes, up to 500 rows/page. IDs/order and state baseline are fixed for five minutes; row and membership values are current when each page is read. Finish the inventory then apply mailbox-changes from that baseline, merging canonical and membership revisions independently. A 100,000-ID and bounded shared-memory budget applies; expired/evicted/restarted inventories return SNAPSHOT_EXPIRED (410). Scope revocation returns no rows. No query filters; legacy filtered queries remain unchanged.' }, async c => json(c, validate(schemas.MailboxSnapshotPage, await inbox.mailboxSnapshot(c.get('owner'), body(c, schemas.MailboxSnapshotInput)))))
  route('post', '/v1/mailbox-changes', { summary: 'Reconcile a scoped body-free mailbox view from owner change history', input: 'MailboxChangesInput', output: 'MailboxChangesPage',
    description: 'Read-only POST; scopeState comes from mailbox-snapshot. At most 500 event-prefix entries are consumed, with current upserts and scoped removals; state advances only through that prefix when hasMore. Current rows may be newer than their events: merge canonical and membership revisions independently and apply deltas in order after initial inventory paging. Metadata events permit targeted metadata refresh. Scope/history resets contain no rows; start a new authorized inventory. Each response has encoded-byte and membership-row budgets.' }, async c => json(c, validate(schemas.MailboxChangesPage, await inbox.mailboxChanges(c.get('owner'), body(c, schemas.MailboxChangesInput)))))
  route('get', '/v1/mailboxes/:id/messages/:messageId', { summary: 'Read a message in an owned mailbox', output: 'MailboxMessage' }, async (c) => {
    const policy = await inbox.policy(c.get('owner'))
    c.header('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
    c.header('Referrer-Policy', 'no-referrer')
    return json(c, validate(schemas.MailboxMessage, await inbox.mailboxMessage(c.get('owner'), pathId(c), c.req.param('messageId')!)), 200, policy)
  })
  route('patch', '/v1/mailboxes/:id/messages/:messageId/state', { summary: 'Update mailbox-local message state', input: 'MailboxState', output: 'Membership', conditional: true, description: 'Use the ETag from GET /v1/mailboxes/{id}/messages/{messageId}. The full representation is checked, then the selected membership revision fences the update. Other mailbox memberships and provider state are unchanged.' }, async (c) => {
    ifMatch(c)
    const input = body(c, schemas.MailboxState)
    const owner = c.get('owner')
    const mailboxId = pathId(c)
    const messageId = c.req.param('messageId')!
    const policy = await inbox.policy(owner)
    const current = validate(schemas.MailboxMessage, await inbox.mailboxMessage(owner, mailboxId, messageId))
    const selected = current.memberships.find((item) => item.mailboxId === mailboxId && item.messageId === messageId)
    if (!selected) throw new InboxError('NOT_FOUND', 'Membership not found', 404)
    await matchEntity(c, current, policy)
    return json(c, validate(schemas.Membership, await inbox.setMailboxState(owner, mailboxId, messageId, input, selected.revision)))
  })
  route('get', '/v1/accounts', { summary: 'List owned accounts', output: 'Account[]' }, async (c) => json(c, await inbox.accounts(c.get('owner'))))
  route('post', '/v1/accounts', { summary: 'Connect an account', input: 'Connect', output: 'Account', status: 201 }, async (c) => json(c, await inbox.connect(c.get('owner'), body(c, schemas.Connect)), 201))
  route('get', '/v1/accounts/:id', { summary: 'Get an owned account', output: 'Account' }, async (c) => json(c, await inbox.account(c.get('owner'), pathId(c))))
  route('delete', '/v1/accounts/:id', { summary: 'Disconnect an account', status: 204 }, async (c) => { await inbox.disconnect(c.get('owner'), pathId(c)); return c.newResponse(null, 204) })
  route('post', '/v1/accounts/:id/reconnect', { summary: 'Reconnect an account', input: 'Reconnect', output: 'Account' }, async (c) => json(c, await inbox.reconnect(c.get('owner'), pathId(c), body(c, schemas.Reconnect))))
  route('post', '/v1/accounts/:id/sync', { summary: 'Synchronize an account', input: 'SyncRequest', output: 'SyncResult' }, async (c) => json(c, await inbox.sync(c.get('owner'), pathId(c), body(c, schemas.SyncRequest, true))))
  route('get', '/v1/accounts/:id/folders', { summary: 'List provider folders', query: folderQuery, output: 'Folder[]', description: 'cached=true reads only owned materialized folder metadata, without calling a provider. Default and cached=false retain native folder discovery.' }, async (c) => json(c, query(c, folderQuery).cached ? await inbox.cachedFolders(c.get('owner'), pathId(c)) : await inbox.folders(c.get('owner'), pathId(c))))
  route('post', '/v1/accounts/:id/folders', { summary: 'Create a provider folder', input: 'Name', output: 'Folder', status: 201 }, async (c) => json(c, await inbox.createFolder(c.get('owner'), pathId(c), body(c, schemas.Name).name), 201))
  route('get', '/v1/messages', { summary: 'Query messages', query: querySchema, output: 'MessagePage' }, async (c) => json(c, await inbox.messages(c.get('owner'), query(c, querySchema))))
  route('get', '/v1/messages/:id', { summary: 'Read a message without marking it read', output: 'Message' }, async (c) => {
    const policy = await inbox.policy(c.get('owner'))
    c.header('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
    c.header('Referrer-Policy', 'no-referrer')
    return json(c, await inbox.message(c.get('owner'), pathId(c)), 200, policy)
  })
  route('get', '/v1/messages/:id/media/:resource', { summary: 'Read an authorized remote email image', mediaType: 'application/octet-stream',
    description: 'Opaque references from sanitized message output only; no URL parameters. Current ownership, original message and image policy are checked before cache/validators/network. PNG, JPEG, GIF, WebP and rebuilt static UTF-8 SVG. Active XML, external SVG resources, animation and filters are rejected. Private caches must revalidate.' }, async c => {
    const result = await inbox.media(c.get('owner'), pathId(c), c.req.param('resource')!)
    const tag = await etag(c.get('owner'), `${pathId(c)}\n${c.req.param('resource')}\n${result.contentType}`, result.content)
    if (!result.noStore) c.header('ETag', tag)
    c.header('Cache-Control', result.noStore ? 'no-store' : 'private, no-cache, must-revalidate')
    c.header('Content-Security-Policy', `sandbox; default-src 'none'; ${result.contentType === 'image/svg+xml' ? "style-src 'unsafe-inline'; " : ''}base-uri 'none'; frame-ancestors 'none'; form-action 'none'`)
    c.header('Cross-Origin-Resource-Policy', 'same-origin')
    c.header('X-Frame-Options', 'DENY')
    c.header('Referrer-Policy', 'no-referrer')
    c.header('Content-Disposition', 'inline; filename="image"')
    c.header('Content-Type', result.contentType)
    if (!result.noStore && matches(c.req.header('if-none-match'), tag, true)) return c.newResponse(null, 304)
    c.header('Content-Length', String(result.content.byteLength))
    return c.newResponse(new Uint8Array(result.content), 200)
  })
  route('get', '/v1/threads', { summary: 'Query threads', query: querySchema, output: 'ThreadPage' }, async (c) => json(c, await inbox.threads(c.get('owner'), query(c, querySchema))))
  route('get', '/v1/threads/:id', { summary: 'Page through a thread', query: pageQuery, output: 'MessagePage' }, async (c) => json(c, await inbox.thread(c.get('owner'), pathId(c), query(c, pageQuery))))
  route('get', '/v1/labels', { summary: 'List local labels', query: accountQuery, output: 'Label[]' }, async (c) => json(c, await inbox.labels(c.get('owner'), query(c, accountQuery).accountId)))
  route('post', '/v1/labels', { summary: 'Create a local label', input: 'LabelInput', output: 'Label', status: 201 }, async (c) => { const input = body(c, schemas.LabelInput); return json(c, await inbox.createLabel(c.get('owner'), input.accountId, input.name), 201) })
  route('get', '/v1/labels/:id', { summary: 'Get a local label', output: 'Label' }, async (c) => {
    const current = (await inbox.labels(c.get('owner'))).find((item) => item.id === c.req.param('id'))
    if (!current) throw new InboxError('NOT_FOUND', 'Label not found', 404)
    return json(c, current)
  })
  route('patch', '/v1/labels/:id', { summary: 'Update a local label', input: 'Name', output: 'Label', conditional: true }, async (c) => {
    ifMatch(c)
    const input = body(c, schemas.Name)
    const labels = await inbox.labels(c.get('owner'))
    const current = labels.find((item) => item.id === c.req.param('id'))
    if (!current) throw new InboxError('NOT_FOUND', 'Label not found', 404)
    await matchEntity(c, current)
    return json(c, await inbox.updateLabel(c.get('owner'), current.id, input.name, current.revision))
  })
  route('delete', '/v1/labels/:id', { summary: 'Delete a local label', status: 204 }, async (c) => { await inbox.deleteLabel(c.get('owner'), pathId(c)); return c.newResponse(null, 204) })

  route('post', '/v1/blobs', { summary: 'Upload an attachment', input: 'BlobUpload', output: 'BlobInfo', status: 201, description: 'Multipart accountId and file, up to 25 MiB. Optional inline and contentId metadata.' }, async (c) => {
    const contentType = c.req.header('content-type') ?? ''
    if (!/^multipart\/form-data(?:\s*;|$)/i.test(contentType)) throw new InboxError('UNSUPPORTED_MEDIA_TYPE', 'Use multipart/form-data', 415)
    // Bun 1.4 drops File.name on zero-byte multipart files; use the same parser for all uploads.
    const form = await new Promise<{ fields: Record<string, string>; file: { name: string; type: string; content: Uint8Array } }>((resolve, reject) => {
      const fields: Record<string, string> = Object.create(null)
      let file: { name: string; type: string; content: Uint8Array } | undefined
      let issue: InboxError | undefined
      const invalid = () => { issue ??= new InboxError('INVALID_MULTIPART', 'Invalid multipart body', 400) }
      let parser: ReturnType<typeof busboy>
      try { parser = busboy({ headers: { 'content-type': contentType }, defParamCharset: 'utf8', preservePath: true,
        limits: { files: 1, fields: 3, parts: 5, fileSize: FILE_LIMIT + 1, fieldSize: 4096, headerPairs: 100 } }) }
      catch { reject(new InboxError('INVALID_MULTIPART', 'Invalid multipart body', 400)); return }
      parser.on('field', (key, value, info) => {
        if (!['accountId', 'inline', 'contentId'].includes(key) || Object.hasOwn(fields, key) || info.nameTruncated || info.valueTruncated) invalid()
        else fields[key] = value
      })
      parser.on('file', (key, stream, info) => {
        if (key !== 'file' || file || !info.filename) invalid()
        const chunks: Uint8Array[] = []
        stream.on('data', (chunk: Buffer) => chunks.push(chunk))
        stream.on('limit', () => { issue = new InboxError('BODY_TOO_LARGE', 'Attachment exceeds the size limit', 413) })
        stream.on('error', invalid)
        stream.on('end', () => {
          file = { name: info.filename, type: info.mimeType, content: new Uint8Array(Buffer.concat(chunks)) }
          if (file.content.byteLength > FILE_LIMIT) issue = new InboxError('BODY_TOO_LARGE', 'Attachment exceeds the size limit', 413)
        })
      })
      parser.on('filesLimit', invalid).on('fieldsLimit', invalid).on('partsLimit', invalid)
      parser.on('error', () => reject(new InboxError('INVALID_MULTIPART', 'Invalid multipart body', 400)))
      parser.on('close', () => { if (issue || !file) reject(issue ?? new InboxError('INVALID_INPUT', 'A file is required', 400)); else resolve({ fields, file }) })
      parser.end(c.get('body'))
    })
    const accountId = validate(id, form.fields.accountId)
    const file = form.file
    const inline = form.fields.inline
    if (inline !== undefined && inline !== 'true' && inline !== 'false') throw new InboxError('INVALID_INPUT', 'Invalid inline flag', 400)
    const contentId = form.fields.contentId === undefined ? undefined : validate(name, form.fields.contentId)
    return json(c, await inbox.upload(c.get('owner'), accountId, {
      filename: validate(name, file.name), contentType: file.type || 'application/octet-stream', content: file.content,
      ...(inline === undefined ? {} : { inline: inline === 'true' }), ...(contentId === undefined ? {} : { contentId }),
    }), 201)
  })
  route('get', '/v1/blobs/:id', { summary: 'Download attachment bytes', mediaType: 'application/octet-stream', description: 'Single byte ranges are supported. Downloads use attachment disposition and nosniff. X-Inbox-Blob-Info contains percent-encoded BlobInfo JSON.' }, async (c) => {
    const { info, content } = await inbox.download(c.get('owner'), pathId(c))
    const metadata = validate(blobInfo, info)
    const tag = await etag(c.get('owner'), JSON.stringify(metadata), content)
    c.header('ETag', tag)
    c.header('Cache-Control', 'private, no-cache')
    c.header('Accept-Ranges', 'bytes')
    c.header('Content-Security-Policy', 'sandbox')
    const filename = (info.filename.split(/[\\/]/).pop() || 'attachment').replace(/[\u0000-\u001f\u007f\ud800-\udfff]/g, '_').slice(0, 180)
    const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, '_') || 'attachment'
    c.header('Content-Disposition', `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`)}`)
    c.header('X-Inbox-Blob-Info', encodeURIComponent(JSON.stringify(metadata)))
    if (matches(c.req.header('if-none-match'), tag, true)) return c.newResponse(null, 304)
    let start = 0
    let end = content.byteLength - 1
    let partial = false
    const range = c.req.header('range')
    if (range && (!c.req.header('if-range') || c.req.header('if-range') === tag)) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range)
      const first = match?.[1] ? Number(match[1]) : undefined
      const last = match?.[2] ? Number(match[2]) : undefined
      if (!match || first === undefined && last === undefined || first !== undefined && !Number.isSafeInteger(first) || last !== undefined && !Number.isSafeInteger(last)) {
        c.header('Content-Range', `bytes */${content.byteLength}`)
        throw new InboxError('INVALID_RANGE', 'Invalid byte range', 416)
      }
      if (first === undefined) { start = Math.max(0, content.byteLength - last!); if (last === 0) start = content.byteLength }
      else { start = first; if (last !== undefined) end = Math.min(last, end) }
      if (start > end || start >= content.byteLength) {
        c.header('Content-Range', `bytes */${content.byteLength}`)
        throw new InboxError('INVALID_RANGE', 'Invalid byte range', 416)
      }
      partial = true
      c.header('Content-Range', `bytes ${start}-${end}/${content.byteLength}`)
    }
    const bytes = new Uint8Array(content.subarray(start, end + 1))
    c.header('Content-Length', String(bytes.byteLength))
    const contentType = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(info.contentType) ? info.contentType : 'application/octet-stream'
    return c.newResponse(bytes.buffer, partial ? 206 : 200, { 'Content-Type': contentType })
  })

  route('get', '/v1/drafts', { summary: 'List local drafts', query: accountQuery, output: 'Draft[]' }, async (c) => json(c, await inbox.drafts(c.get('owner'), query(c, accountQuery).accountId)))
  route('post', '/v1/drafts', { summary: 'Create a local draft', input: 'DraftInput', output: 'Draft', status: 201 }, async (c) => json(c, await inbox.createDraft(c.get('owner'), body(c, schemas.DraftInput)), 201))
  route('get', '/v1/drafts/:id', { summary: 'Get a local draft', output: 'Draft' }, async (c) => json(c, await inbox.draft(c.get('owner'), pathId(c))))
  route('patch', '/v1/drafts/:id', { summary: 'Update a local draft', input: 'DraftPatch', output: 'Draft', conditional: true }, async (c) => {
    ifMatch(c)
    const input = body(c, schemas.DraftPatch)
    const current = await inbox.draft(c.get('owner'), pathId(c))
    await matchEntity(c, current)
    return json(c, await inbox.updateDraft(c.get('owner'), current.id, input, current.revision))
  })
  route('delete', '/v1/drafts/:id', { summary: 'Delete a local draft', status: 204, conditional: true }, async (c) => {
    ifMatch(c)
    const current = await inbox.draft(c.get('owner'), pathId(c))
    await matchEntity(c, current)
    await inbox.deleteDraft(c.get('owner'), current.id, current.revision)
    return c.newResponse(null, 204)
  })
  route('post', '/v1/drafts/:id/submit', { summary: 'Queue a draft for sending', input: 'Submit', output: 'Operation', status: 202, idempotent: true }, async (c) => json(c, await inbox.submit(c.get('owner'), pathId(c), { ...body(c, schemas.Submit), idempotencyKey: idempotencyKey(c) }), 202))
  route('post', '/v1/operations', { summary: 'Queue a message mutation', input: 'Mutation', output: 'Operation', status: 202, idempotent: true }, async (c) => json(c, await inbox.mutate(c.get('owner'), { ...body(c, schemas.Mutation), idempotencyKey: idempotencyKey(c) }), 202))
  route('get', '/v1/operations/:id', { summary: 'Get an operation', output: 'Operation' }, async (c) => json(c, await inbox.operation(c.get('owner'), pathId(c))))
  route('post', '/v1/operations/:id/cancel', { summary: 'Cancel an operation', output: 'Operation' }, async (c) => { body(c, emptyQuery, true); return json(c, await inbox.cancel(c.get('owner'), pathId(c))) })
  route('post', '/v1/operations/:id/reschedule', { summary: 'Reschedule a send', input: 'Reschedule', output: 'Operation' }, async (c) => json(c, await inbox.reschedule(c.get('owner'), pathId(c), body(c, schemas.Reschedule).sendAt)))
  route('post', '/v1/operations/:id/undo', { summary: 'Undo a pending send or reversible mutation', output: 'Operation' }, async (c) => { body(c, emptyQuery, true); return json(c, await inbox.undo(c.get('owner'), pathId(c))) })
  route('get', '/v1/policy', { summary: 'Get owner policy', output: 'Policy' }, async (c) => json(c, await inbox.policy(c.get('owner'))))
  route('patch', '/v1/policy', { summary: 'Update owner policy', input: 'PolicyPatch', output: 'Policy' }, async (c) => json(c, await inbox.setPolicy(c.get('owner'), body(c, schemas.PolicyPatch))))
  route('get', '/v1/changes', { summary: 'Read durable change history', query: changesQuery, output: 'ChangePage', description: 'Opaque state is owner-scoped. An expired state returns resetRequired with the current state; callers must refresh their snapshot.' }, async (c) => json(c, await inbox.changes(c.get('owner'), query(c, changesQuery))))

  route('get', '/v1/events', { summary: 'Stream durable change notifications', query: eventsQuery, mediaType: 'text/event-stream', description: 'Resumes from Last-Event-ID or since. First, ready contains {state}: the requested starting cursor or the current baseline for a new stream, never the end of undelivered replay. Change events have id, event type, and ChangeEvent JSON data. reset.required contains the current {state} and closes the stream. Heartbeats are comments. Connections rotate after five minutes and errors never contain provider diagnostics.' }, async (c) => {
    const owner = c.get('owner')
    let cursor = c.req.header('last-event-id') || query(c, eventsQuery).since
    if (cursor !== undefined) validate(opaque, cursor)
    if (c.req.method === 'HEAD') {
      await inbox.changes(owner, { since: cursor, limit: STREAM_PAGE_SIZE })
      return c.newResponse(null, 200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
    }
    const active = streams.get(owner) ?? 0
    if (active >= maxStreams) { c.header('Retry-After', '1'); throw new InboxError('STREAM_LIMIT', 'Too many active streams', 429, true) }
    streams.set(owner, active + 1)
    let page: ChangePage | undefined
    let index = 0
    let closed = false
    let ready = false
    let readNeeded = true
    let heartbeat = false
    let waiting: (() => void) | undefined
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    let unsubscribe: (() => void) | undefined
    let pollTimer: ReturnType<typeof setInterval> | undefined
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined
    let lifetimeTimer: ReturnType<typeof setTimeout> | undefined
    const resume = () => { const resolve = waiting; waiting = undefined; resolve?.() }
    const wake = () => { readNeeded = true; resume() }
    const cleanup = () => {
      if (closed) return
      closed = true
      clearInterval(pollTimer)
      clearInterval(heartbeatTimer)
      clearTimeout(lifetimeTimer)
      c.req.raw.signal.removeEventListener('abort', cleanup)
      try { unsubscribe?.() } catch { /* Cleanup must still release the owner's stream slot. */ }
      const remaining = (streams.get(owner) ?? 1) - 1
      if (remaining > 0) streams.set(owner, remaining)
      else streams.delete(owner)
      resume()
      try { controller?.close() } catch { /* Cancellation may already have closed the stream. */ }
    }
    const frame = (event: string, data: unknown, eventId?: string) => encoder.encode(`${eventId ? `id: ${eventId}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    try {
      // Setup can await storage: cancellation and the lifetime bound must own the slot
      // before that await, not only after the first page eventually resolves.
      lifetimeTimer = setTimeout(cleanup, STREAM_LIFETIME_MS)
      c.req.raw.signal.addEventListener('abort', cleanup, { once: true })
      if (c.req.raw.signal.aborted) cleanup()
      if (!closed) page = await inbox.changes(owner, { since: cursor, limit: STREAM_PAGE_SIZE })
      if (!closed) {
        // A reread after subscribing closes the read/subscribe race; notifications carry no data.
        unsubscribe = inbox.subscribe(owner, wake)
        pollTimer = setInterval(wake, streamPollMs)
        heartbeatTimer = setInterval(() => { heartbeat = true; resume() }, heartbeatMs)
      }
    } catch (error) { cleanup(); throw error }
    const stream = new ReadableStream<Uint8Array>({
      start(value) { controller = value; if (closed) value.close() },
      async pull(value) {
        try {
          while (!closed) {
            if (!ready) { ready = true; value.enqueue(frame('ready', { state: cursor ?? page!.state })); return }
            if (page) {
              if (page.resetRequired) {
                value.enqueue(frame('reset.required', { state: page.state }))
                cleanup()
                return
              }
              if (index < page.events.length) {
                // Project the durable event schema so bodies or credentials can never enter SSE.
                const event: ChangeEvent = validate(changeEvent, page.events[index++])
                cursor = event.id
                value.enqueue(frame(event.type, event, event.id))
                return
              }
              const hasMore = page.hasMore
              if (hasMore && index === 0) throw new InboxError('INVALID_CHANGE_PAGE', 'Change history could not advance', 500, true)
              if (!hasMore) cursor = page.state
              page = undefined
              if (hasMore) readNeeded = true
            }
            if (readNeeded) {
              readNeeded = false
              const identity = await options.authenticate(c.req.raw)
              if (closed) return
              if (identity?.id !== owner) throw new InboxError('UNAUTHENTICATED', 'Authentication required', 401)
              page = await inbox.changes(owner, { since: cursor, limit: STREAM_PAGE_SIZE })
              index = 0
              continue
            }
            if (heartbeat) { heartbeat = false; value.enqueue(encoder.encode(': heartbeat\n\n')); return }
            await new Promise<void>((resolve) => { waiting = resolve })
          }
        } catch (error) {
          if (!closed) { const { status: _status, ...result } = safeError(error); value.enqueue(frame('error', result)); cleanup() }
        }
      },
      cancel() { cleanup() },
    }, { highWaterMark: 1 })
    return c.newResponse(stream, 200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' })
  })

  route('get', '/v1/openapi.json', { summary: 'Read the authenticated API contract', output: 'OpenAPI' }, (c) => json(c, openapi))
  const components = Object.fromEntries(Object.entries(schemas).map(([key, schema]) => {
    const { $schema: _dialect, ...result } = z.toJSONSchema(schema, { io: 'input', target: 'draft-2020-12' })
    return [key, result]
  }))
  const openapi = {
    openapi: '3.1.0', info: { title: 'Inbox API', version: '1', description: 'Owner-scoped inbox API. JSON requests are limited to 1 MiB; attachments to 25 MiB. Query keys are strict; booleans must be true or false. Authentication is supplied by the host. Cookie mutations require a trusted Origin; token requests do not. Conditional GETs always authenticate and load the current representation before returning 304. CORS preflight has no application data.' },
    security: [{ bearerAuth: [] }, { sessionCookie: [] }],
    paths: { '/health': { get: { summary: 'Public liveness check', security: [], responses: { '200': { description: 'Alive', content: { 'application/json': { schema: { type: 'object', required: ['ok'], properties: { ok: { const: true } }, additionalProperties: false } } } } } } }, ...paths },
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' }, sessionCookie: { type: 'apiKey', in: 'cookie', name: 'session', description: 'Example only; the host chooses the cookie name and authentication mechanism.' } },
      schemas: { ...components,
        BlobUpload: { type: 'object', required: ['accountId', 'file'], additionalProperties: false, properties: { accountId: { type: 'string' }, file: { type: 'string', format: 'binary' }, inline: { type: 'string', enum: ['true', 'false'] }, contentId: { type: 'string' } } },
        OpenAPI: { type: 'object', description: 'OpenAPI 3.1 document for these routes.' },
      },
    },
  }
  return app
}
