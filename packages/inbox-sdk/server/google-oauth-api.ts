import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { InboxError } from '../src/contracts'
import type { InboxApiOptions } from '../src/http'
import type { createGoogleOAuthHost } from './google-oauth'

type Environment = { Variables: { owner: string; body: Uint8Array<ArrayBuffer> } }
type ApiContext = Context<Environment>

const JSON_LIMIT = 1024 * 1024
const id = z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f/\\]+$/)
const opaque = z.string().min(1).max(4096).regex(/^[^\u0000-\u001f\u007f]+$/)
const name = z.string().min(1).max(512)
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const emptyQuery = z.strictObject({})
const startInput = z.strictObject({ connectionId: id.optional() })
const authorizeQuery = z.strictObject({ ticket: opaque })
const callbackQuery = z.strictObject({
  state: opaque, code: opaque.optional(), error: opaque.optional(),
  error_description: z.string().max(4096).optional(), error_uri: z.string().max(4096).optional(),
  scope: z.string().max(8192).optional(), authuser: z.string().max(100).optional(),
  prompt: z.string().max(100).optional(), hd: name.optional(), iss: opaque.optional(),
})
const connection = z.object({
  id, providerId: name, name: z.string(), status: z.enum(['connected', 'disconnected', 'reconnect_required']),
  generation: revision, sourceIds: z.array(id),
  identity: z.object({ issuer: z.string(), subject: z.string(), registrationId: z.string() }).nullable(),
  createdAt: z.string(),
})
const attempt = z.object({
  id, providerId: z.literal('gmail'), status: z.enum(['pending', 'authorizing', 'exchanging', 'completed', 'failed']),
  expiresAt: z.string(), connectionId: id.nullable(), authorizeUrl: z.string().max(8192).nullable().optional(),
})

function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new InboxError('INVALID_INPUT', 'Invalid request input', 400)
  return parsed.data
}

function query<T>(c: ApiContext, schema: z.ZodType<T>): T {
  const input: Record<string, unknown> = Object.create(null)
  for (const [key, value] of new URL(c.req.url).searchParams) {
    if (Object.hasOwn(input, key)) throw new InboxError('INVALID_QUERY', 'Repeated query parameter', 400)
    input[key] = value
  }
  return validate(schema, input)
}

async function boundedBody(request: Request): Promise<Uint8Array<ArrayBuffer>> {
  const length = request.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > JSON_LIMIT)) {
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
      if (size > JSON_LIMIT) {
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

function body(c: ApiContext): z.infer<typeof startInput> {
  const bytes = c.get('body')
  if (bytes.byteLength === 0) return validate(startInput, {})
  if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('content-type') ?? '')) {
    throw new InboxError('UNSUPPORTED_MEDIA_TYPE', 'Use application/json', 415)
  }
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { throw new InboxError('INVALID_JSON', 'Invalid JSON body', 400) }
  return validate(startInput, value)
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

export function createGoogleOAuthApi(options: {
  oauth: () => ReturnType<typeof createGoogleOAuthHost>
  authenticate: InboxApiOptions['authenticate']
  allowedOrigins?: string[]
}) {
  const app = new Hono<Environment>()
  const origins = new Set(options.allowedOrigins ?? [])
  for (const origin of origins) {
    let parsed: URL
    try { parsed = new URL(origin) } catch { throw new TypeError('allowedOrigins must contain exact HTTP(S) origins') }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new TypeError('allowedOrigins must contain exact HTTP(S) origins')
    }
  }
  const corsHeaders = ['authorization', 'content-type', 'if-match', 'if-none-match', 'idempotency-key', 'last-event-id', 'range', 'if-range']

  async function currentOwner(c: ApiContext): Promise<string | undefined> {
    let identity: { id: string } | null
    try { identity = await options.authenticate(c.req.raw) }
    catch { throw new InboxError('AUTHENTICATION_UNAVAILABLE', 'Authentication unavailable', 503, true) }
    if (identity === null) return undefined
    if (!identity || typeof identity.id !== 'string' || !identity.id) throw new InboxError('UNAUTHENTICATED', 'Authentication required', 401)
    return identity.id
  }

  function route(method: 'GET' | 'POST', path: string, publicOAuth: boolean, handler: (c: ApiContext) => Promise<Response>) {
    app.on(publicOAuth ? [method] : [method, 'OPTIONS'], path, async (c, next) => {
      const preflight = !publicOAuth && c.req.method === 'OPTIONS' && c.req.header('access-control-request-method') === method
      // Hono dispatches HEAD through GET; neither it nor unknown methods may redeem a capability.
      if (c.req.method !== method && !preflight) return next()
      c.header('Cache-Control', 'no-store')
      c.header('Referrer-Policy', 'no-referrer')
      c.header('X-Content-Type-Options', 'nosniff')
      c.header('Vary', 'Origin, Authorization, Cookie')
      c.header('ETag', undefined)
      try {
        const origin = c.req.header('origin')
        if (origin && origins.has(origin)) {
          c.header('Access-Control-Allow-Origin', origin)
          c.header('Access-Control-Allow-Credentials', 'true')
          c.header('Access-Control-Expose-Headers', 'ETag, Content-Disposition, Content-Range, Accept-Ranges, X-Inbox-Blob-Info, Retry-After')
        }
        if (preflight) {
          const requested = (c.req.header('access-control-request-headers') ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
          if (!origin || !origins.has(origin) || requested.some(header => !corsHeaders.includes(header))) {
            throw new InboxError('ORIGIN_FORBIDDEN', 'Origin not permitted', 403)
          }
          c.header('Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers')
          c.header('Access-Control-Allow-Methods', 'GET, HEAD, POST, PATCH, DELETE')
          c.header('Access-Control-Allow-Headers', corsHeaders.join(', '))
          return c.newResponse(null, 204)
        }
        if (!publicOAuth) {
          const owner = await currentOwner(c)
          if (owner === undefined) throw new InboxError('UNAUTHENTICATED', 'Authentication required', 401)
          c.set('owner', owner)
          if (method === 'POST') {
            if (c.req.header('cookie') && (!origin || origin !== new URL(c.req.url).origin && !origins.has(origin))) {
              throw new InboxError('ORIGIN_FORBIDDEN', 'A trusted Origin is required for cookie-authenticated mutations', 403)
            }
            c.set('body', await boundedBody(c.req.raw))
          }
        }
        return await handler(c)
      } catch (error) {
        const { status, ...result } = safeError(error)
        c.header('Cache-Control', 'no-store')
        c.header('ETag', undefined)
        return c.newResponse(JSON.stringify(publicOAuth
          ? { code: 'OAUTH_FAILED', error: 'OAuth request could not be completed', retryable: result.retryable }
          : result), status as 400, { 'Content-Type': 'application/json; charset=utf-8' })
      }
    })
  }

  route('GET', '/v1/oauth/google/authorize/:id', true, async c => {
    const input = query(c, authorizeQuery)
    const attemptId = validate(id, c.req.param('id'))
    const redirect = await options.oauth().authorize(attemptId, input.ticket)
    return c.newResponse(null, 302, { Location: redirect.location, 'Set-Cookie': redirect.setCookie })
  })
  route('GET', '/v1/oauth/google/callback', true, async c => {
    query(c, callbackQuery)
    const owner = await currentOwner(c)
    const result = await options.oauth().complete(c.req.url, c.req.header('cookie') ?? '', owner)
    return c.newResponse(JSON.stringify(validate(connection, result.connection)), 200, {
      'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': result.setCookie,
    })
  })
  route('POST', '/v1/connections/google/start', false, async c => {
    query(c, emptyQuery)
    const input = body(c)
    return c.json(validate(attempt, await options.oauth().start(c.get('owner'), input)))
  })
  route('GET', '/v1/connections/google/attempts/:id', false, async c => {
    query(c, emptyQuery)
    const attemptId = validate(id, c.req.param('id'))
    return c.json(validate(attempt.omit({ authorizeUrl: true }), await options.oauth().attempt(c.get('owner'), attemptId)))
  })
  return app
}
