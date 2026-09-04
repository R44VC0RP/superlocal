import { createHmac, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { createMockHost, type MockHost } from '@superlocal/mock-api'
import { createInbox, InboxError, type Inbox } from 'inbox-sdk'
import { createInboxApi } from 'inbox-sdk/http'
import { loadLocalConfig, object, type LocalConfig } from './config'
import { createInboxViewPreferencesStore, INBOX_PREFERENCES_BODY_LIMIT } from './inbox-preferences'
import { createRealRegistrations, type HostProvider, type HostProviderRegistration } from './providers'
import { openLocalRuntime } from './runtime'
import { createSenderDomainHost } from './sender-domains'
import { createSplitPreferencesStore } from './split-preferences'
import { createAttentionFeedbackStore } from './attention-feedback'
import { isPerformanceSample } from '../../shared/performance'
import { createPerformanceLog } from './performance-log'
import { assertApplicationAuthRuntime, createApplicationAuth } from './application-auth'

const safeHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', Vary: 'Origin, Cookie' }
function problem(status: number, code: string, error: string): Response {
  return Response.json({ code, error, retryable: status >= 500 }, { status, headers: safeHeaders })
}

async function jsonBody(request: Request, kind: 'connection' | 'preferences' | 'performance' = 'connection'): Promise<Record<string, unknown>> {
  const limit = kind === 'performance' ? 32 * 1024 : kind === 'preferences' ? INBOX_PREFERENCES_BODY_LIMIT : 16_384
  const description = kind === 'performance' ? 'Performance' : kind === 'preferences' ? 'Preferences' : 'Connection'
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) throw new InboxError('HOST_JSON_REQUIRED', 'Use application/json.', 415)
  const length = request.headers.get('content-length')
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) throw new InboxError('HOST_BODY_TOO_LARGE', `${description} input exceeds the size limit.`, 413)
  if (request.headers.has('content-encoding') && (kind === 'performance' || request.headers.get('content-encoding') !== 'identity')) throw new InboxError('HOST_ENCODING_FORBIDDEN', `Encoded ${kind} input is not supported.`, 415)
  if (!request.body) throw new InboxError('HOST_INVALID_INPUT', 'A JSON object is required.', 400)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let expired = false
  const timer = kind === 'performance' ? setTimeout(() => { expired = true; void reader.cancel().catch(() => {}) }, 2000) : undefined
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (expired) throw new InboxError('HOST_BODY_TIMEOUT', 'Performance input timed out.', 408)
      if (done) break
      size += value.byteLength
      if (size > limit) {
        if (kind === 'performance') void reader.cancel().catch(() => {})
        else await reader.cancel()
        throw new InboxError('HOST_BODY_TOO_LARGE', `${description} input exceeds the size limit.`, 413)
      }
      chunks.push(value)
    }
  } finally { clearTimeout(timer); reader.releaseLock() }
  let input: unknown
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
  catch { throw new InboxError('HOST_INVALID_JSON', `Invalid JSON ${kind} input.`, 400) }
  if (!object(input)) throw new InboxError('HOST_INVALID_INPUT', 'A JSON object is required.', 400)
  return input
}

function credentialsFor(provider: HostProviderRegistration, input: Record<string, unknown>): Record<string, string> {
  const invalid = () => new InboxError('HOST_INVALID_CREDENTIALS', 'Only the declared provider credential fields are accepted.', 400)
  if (provider.onboarding.connection !== 'credentials') {
    if (Object.keys(input).length) throw invalid()
    return {}
  }
  if (Object.keys(input).join(',') !== 'credentials' || !object(input.credentials)) throw invalid()
  const fields = provider.onboarding.fields ?? []
  if (Object.keys(input.credentials).some(name => !fields.some(field => field.name === name))) throw invalid()
  const credentials: Record<string, string> = Object.create(null)
  for (const field of fields) {
    const value = input.credentials[field.name]
    if (value === undefined && !field.required) continue
    // Mail passwords are opaque. Spaces are significant; never trim or normalize them.
    if (typeof value !== 'string' || value.length > 4096 || field.type !== 'password' && (value.trim() !== value || /[\x00-\x1f\x7f]/.test(value)) || field.required && !value) throw invalid()
    if (field.type === 'select' && !field.options?.some(option => option.value === value)) throw invalid()
    credentials[field.name] = value
  }
  return credentials
}

export async function createLocalHost(config: LocalConfig = loadLocalConfig(), environment: NodeJS.ProcessEnv = process.env) {
  assertApplicationAuthRuntime(config)
  const runtime = openLocalRuntime(config)
  let applicationAuth: Awaited<ReturnType<typeof createApplicationAuth>> | undefined
  let mock: MockHost | undefined
  let inbox: Inbox | undefined
  let registrations: HostProviderRegistration[] = []
  let owner = `local:${config.instanceId}`
  try {
    if (config.auth.method === 'google') applicationAuth = await createApplicationAuth(config, runtime, environment)
    if (config.mode === 'mock') {
      mock = await createMockHost({ dataDir: runtime.dataDir, port: config.backend.port, encryptionKey: runtime.encryptionKey,
        token: createHmac('sha256', runtime.sessionKey).update('unused-private-mock-bearer').digest('hex'), allowProviderWrites: config.allowProviderWrites })
      inbox = mock.inbox
      owner = mock.owner
    } else {
      const real = createRealRegistrations(config, runtime, environment)
      registrations = real.registrations
      inbox = createInbox({ database: join(runtime.dataDir, 'inbox.sqlite'), encryptionKey: runtime.encryptionKey,
        providers: registrations.map(registration => registration.definition), allowProviderWrites: config.allowProviderWrites,
        defaultPolicy: { remoteImages: true },
        verifyCredentials: real.verifyCredentials, log: event => console.info(JSON.stringify({ event: 'local.sdk', code: /^[A-Z][A-Z0-9_]{0,79}$/.test(event.code) ? event.code : 'SDK_ERROR' })) })
    }
  } catch (error) { try { if (mock) await mock.close(); else await inbox?.close() } finally { applicationAuth?.close(); runtime.database.close() }; throw error }
  const liveInbox = inbox
  const performanceLog = createPerformanceLog(runtime.dataDir, config.mode)
  const ownerContexts = new Map<string, {
    inboxPreferences: ReturnType<typeof createInboxViewPreferencesStore>
    splitPreferences: ReturnType<typeof createSplitPreferencesStore>
    attentionFeedback: ReturnType<typeof createAttentionFeedbackStore>
    senderDomains: ReturnType<typeof createSenderDomainHost>
  }>()
  function contextFor(owner: string) {
    if (closed) throw new InboxError('HOST_CLOSED', 'The local host is shutting down.', 503)
    let context = ownerContexts.get(owner)
    if (!context) {
      // Auth admission is capped at 256 durable identities. Never evict a live owner's queue.
      if (ownerContexts.size >= 256) throw new InboxError('HOST_OWNER_LIMIT', 'This host has reached its active-user limit.', 503)
      context = {
        inboxPreferences: createInboxViewPreferencesStore(runtime.database, liveInbox, owner),
        splitPreferences: createSplitPreferencesStore(runtime.database, owner),
        attentionFeedback: createAttentionFeedbackStore(runtime.database, liveInbox, owner),
        senderDomains: createSenderDomainHost({ inbox: liveInbox, owner, offline: config.mode === 'mock' }),
      }
      ownerContexts.set(owner, context)
    }
    return context
  }
  const allowedOrigins = applicationAuth ? [config.web.origin] : config.web.allowedOrigins
  const origins = new Set(allowedOrigins)
  const hosts = new Set([`127.0.0.1:${config.backend.port}`, `localhost:${config.backend.port}`, ...allowedOrigins.map(value => new URL(value).host)])
  const cookieName = `superlocal_${config.instanceId.replaceAll('-', '')}_${config.mode}`
  const sessions = new Map<string, { expires: number; origin: string }>()
  const cookieHash = (value: string) => createHmac('sha256', runtime.sessionKey).update(value).digest('hex')
  const streamShutdown = new AbortController()
  const pending = new Set<Promise<Response>>()
  let closed = false
  let closing: Promise<void> | undefined

  const currentIdentity = async (request: Request): Promise<{ id: string; scope?: string } | null> => {
    if (closed || request.headers.has('authorization')) return null
    if (applicationAuth) {
      const identity = await applicationAuth.identity(request)
      return identity ? { id: identity.owner, scope: identity.scope } : null
    }
    const cookies = (request.headers.get('cookie') ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${cookieName}=`))
    if (cookies.length !== 1) return null
    const token = cookies[0]!.slice(cookieName.length + 1)
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null
    const session = sessions.get(cookieHash(token))
    const origin = request.headers.get('origin')
    return session && session.expires > Date.now() && (!origin || origin === session.origin) ? { id: owner } : null
  }
  function scopeMatches(request: Request, scope: string | undefined): boolean {
    if (!applicationAuth) return true
    const supplied = request.headers.get('x-superlocal-scope')
    if (supplied !== null) return supplied === scope
    const path = new URL(request.url).pathname
    // Only native element/download URLs have no custom header. Their opaque IDs remain
    // owner-checked by the SDK; never exempt a generic JSON GET or an encoded path alias.
    return ['GET', 'HEAD'].includes(request.method) && (/^\/v1\/messages\/[^/%]+\/media\/[^/%]+$/.test(path) || /^\/v1\/blobs\/[^/%]+$/.test(path)) ||
      request.method === 'GET' && (/^\/host\/sender-domains\/[^/%]+\/icon$/.test(path) || path === '/v1/oauth/google/callback' || !!mailboxAuthorizationId(request))
  }
  const mailboxAuthorizationId = (request: Request) => request.method === 'GET' ? /^\/v1\/oauth\/google\/authorize\/([^/%]+)$/.exec(new URL(request.url).pathname)?.[1] : undefined
  function ownsMailboxAuthorization(request: Request, owner: string): boolean {
    const id = mailboxAuthorizationId(request)
    if (!applicationAuth || !id) return true
    // The SDK's redirect handoff consumes a one-use ticket; check its owner before
    // consumption, including native navigations that cannot supply the document scope.
    return !!runtime.database.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sdk_oauth_attempts'").get() &&
      !!runtime.database.query('SELECT 1 FROM sdk_oauth_attempts WHERE id=? AND owner=?').get(id, owner)
  }
  const authenticate = async (request: Request): Promise<{ id: string } | null> => {
    const identity = await currentIdentity(request)
    return identity && scopeMatches(request, identity.scope) && ownsMailboxAuthorization(request, identity.id) ? { id: identity.id } : null
  }
  const api = createInboxApi({ inbox: liveInbox, authenticate, allowedOrigins })
  const extensions = registrations.flatMap(registration => registration.mount ? [registration.mount(liveInbox, authenticate)] : [])

  function session(request: Request): Response {
    if (applicationAuth) return authRequired()
    if (request.method !== 'POST') return problem(405, 'HOST_METHOD_NOT_ALLOWED', 'Use POST to initialize a loopback session.')
    const origin = request.headers.get('origin')
    if (!origin || !origins.has(origin) || request.headers.get('x-superlocal') !== '1') return problem(403, 'HOST_ORIGIN_FORBIDDEN', 'An exact allowed Origin and X-Superlocal: 1 are required.')
    const now = Date.now()
    for (const [key, value] of sessions) if (value.expires <= now) sessions.delete(key)
    if (sessions.size >= 256) sessions.delete(sessions.keys().next().value!)
    const token = randomBytes(32).toString('base64url')
    const seconds = config.auth.sessionHours * 3600
    sessions.set(cookieHash(token), { origin, expires: now + seconds * 1000 })
    return new Response(null, { status: 204, headers: { ...safeHeaders,
      'Set-Cookie': `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${origin.startsWith('https:') ? '; Secure' : ''}` } })
  }

  function authRequired(): Response {
    const response = problem(401, 'UNAUTHENTICATED', applicationAuth ? 'Sign in to this installation first.' : 'Initialize a local browser session first.')
    if (applicationAuth) response.headers.set('X-Superlocal-Auth', 'required')
    return response
  }

  async function dispatch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (!['http:', 'https:'].includes(url.protocol) || !hosts.has(url.host)) return problem(403, 'HOST_LOOPBACK_REQUIRED', 'Use the configured loopback host or local alias.')
    if (closed) return problem(503, 'HOST_CLOSED', 'The local host is shutting down.')
    // Never route encoded or trailing-slash auth aliases through a more permissive handler.
    let normalized: string
    try { normalized = decodeURIComponent(url.pathname).replace(/\/+$/, '') } catch { return problem(400, 'HOST_INVALID_PATH', 'Invalid request path.') }
    if (normalized !== url.pathname && (normalized === '/session' || normalized.startsWith('/api/auth') || normalized.startsWith('/host/auth') || applicationAuth && normalized.startsWith('/v1/oauth/google/authorize/'))) return problem(400, 'HOST_INVALID_PATH', 'Use the exact authentication path.')
    if (url.pathname === '/session') return url.search ? problem(400, 'HOST_INVALID_INPUT', 'Session initialization takes no query parameters.') : session(request)
    if (url.pathname === '/health' && request.method === 'GET') return Response.json({ ok: true }, { headers: safeHeaders })
    if (url.pathname.startsWith('/api/auth')) return applicationAuth && url.pathname === '/api/auth/callback/google' ? applicationAuth.handle(request) : problem(404, 'NOT_FOUND', 'Route not found.')
    if (url.pathname === '/host/auth' || url.pathname.startsWith('/host/auth/')) {
      if (applicationAuth) return applicationAuth.handle(request)
      const origin = request.headers.get('origin')
      if (origin && !origins.has(origin) || request.headers.get('sec-fetch-site') === 'cross-site') return problem(403, 'HOST_ORIGIN_FORBIDDEN', 'This request origin is not permitted.')
      if (url.pathname === '/host/auth' && request.method === 'GET' && !url.search) return Response.json({ method: 'loopback' }, { headers: safeHeaders })
      return problem(404, 'NOT_FOUND', 'Route not found.')
    }
    const extension = extensions.find(extension => extension.matches(url.pathname))
    const callback = extension?.callbackPath === url.pathname && request.method === 'GET'
    const origin = request.headers.get('origin')
    if (!callback && (origin && !origins.has(origin) || request.headers.get('sec-fetch-site') === 'cross-site')) return problem(403, 'HOST_ORIGIN_FORBIDDEN', 'This request origin is not permitted.')
    const identity = await currentIdentity(request)
    if (!identity) {
      if (applicationAuth) return authRequired()
      if (callback) return new Response(null, { status: 303, headers: { ...safeHeaders, Location: `${config.web.origin}/?connection=failed` } })
      return authRequired()
    }
    if (!scopeMatches(request, identity.scope)) {
      const response = problem(409, 'HOST_SCOPE_CHANGED', 'The signed-in user changed. Reload before continuing.')
      response.headers.set('X-Superlocal-Auth', 'required')
      return response
    }
    if (!ownsMailboxAuthorization(request, identity.id)) return problem(404, 'NOT_FOUND', 'OAuth attempt not found.')
    const owner = identity.id
    const { inboxPreferences, splitPreferences, attentionFeedback, senderDomains } = contextFor(owner)
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && (!origin || !origins.has(origin))) return problem(403, 'HOST_ORIGIN_FORBIDDEN', 'An exact allowed Origin is required for changes.')
    if (url.pathname === '/host/performance') {
      if (url.search) return problem(400, 'HOST_INVALID_INPUT', 'Performance batches take no query parameters.')
      if (request.method !== 'POST') return problem(405, 'HOST_METHOD_NOT_ALLOWED', 'Use POST for performance samples.')
      const input = await jsonBody(request, 'performance')
      if (Object.keys(input).join(',') !== 'samples' || !Array.isArray(input.samples) || !input.samples.length || input.samples.length > 50 || !input.samples.every(isPerformanceSample)) {
        return problem(400, 'HOST_INVALID_PERFORMANCE', 'Provide 1–50 content-free timing samples.')
      }
      if (!performanceLog.write(input.samples)) return problem(429, 'HOST_PERFORMANCE_DROPPED', 'Timing samples were dropped.')
      return new Response(null, { status: 204, headers: safeHeaders })
    }
    if (url.pathname.startsWith('/host/sender-domains/')) return senderDomains.fetch(request)
    if (url.pathname === '/host/split-preferences') {
      if (url.search) return problem(400, 'HOST_INVALID_INPUT', 'Split preferences take no query parameters.')
      if (request.method === 'GET') return Response.json(splitPreferences.read(), { headers: safeHeaders })
      if (request.method === 'PUT') return Response.json(splitPreferences.write(await jsonBody(request, 'preferences')), { headers: safeHeaders })
      return problem(405, 'HOST_METHOD_NOT_ALLOWED', 'Use GET or PUT for split preferences.')
    }
    if (url.pathname === '/host/attention-feedback' || /^\/host\/attention-feedback\/[a-zA-Z0-9-]{16,80}\/undo$/.test(url.pathname)) {
      if (url.search) return problem(400, 'HOST_INVALID_INPUT', 'Feedback takes no query parameters.')
      if (request.method === 'GET' && url.pathname === '/host/attention-feedback') return Response.json(await attentionFeedback.list(), { headers: safeHeaders })
      if (request.method === 'POST' && url.pathname.endsWith('/undo')) return Response.json(await attentionFeedback.undo(url.pathname.split('/')[3]!), { headers: safeHeaders })
      if (request.method === 'POST') return Response.json(await attentionFeedback.record(await jsonBody(request, 'preferences')), { headers: safeHeaders })
      return problem(405, 'HOST_METHOD_NOT_ALLOWED', 'Use GET or POST for feedback.')
    }
    if (url.pathname === '/host/inbox-preferences') {
      if (url.search) return problem(400, 'HOST_INVALID_INPUT', 'Inbox preferences take no query parameters.')
      if (request.method === 'GET') return Response.json(await inboxPreferences.read(), { headers: safeHeaders })
      if (request.method === 'PUT') return Response.json(await inboxPreferences.write(await jsonBody(request, 'preferences')), { headers: safeHeaders })
      return problem(405, 'HOST_METHOD_NOT_ALLOWED', 'Use GET or PUT for inbox preferences.')
    }
    if (url.pathname === '/host/config' && request.method === 'GET') {
      if (url.search) return problem(400, 'HOST_INVALID_INPUT', 'Host configuration takes no query parameters.')
      const connections = await liveInbox.connections(owner)
      const descriptors: Array<Omit<HostProvider, 'connectionIds'>> = config.mode === 'mock'
        ? [{ id: 'mock', name: 'Offline mock', connection: 'none', enabled: true, ready: true }]
        : registrations.map(registration => registration.onboarding)
      return Response.json({ mode: config.mode, allowProviderWrites: config.allowProviderWrites, performanceLogging: true,
        preferenceScope: createHmac('sha256', runtime.sessionKey).update(`split-preferences:${owner}`).digest('hex'),
        providers: descriptors.map(provider => ({ ...provider, connectionIds: connections.filter(connection => connection.providerId === provider.id).map(connection => connection.id) })) }, { headers: safeHeaders })
    }
    const connect = /^\/host\/providers\/([a-z][a-z0-9-]*)\/(?:connect|connections\/([^/]+)\/reconnect)$/.exec(url.pathname)
    if (connect && request.method === 'POST') {
      if (url.search) return problem(400, 'HOST_INVALID_INPUT', 'Connection input belongs in the JSON body.')
      const provider = registrations.find(provider => provider.onboarding.id === connect[1])
      if (!provider) return problem(404, 'HOST_PROVIDER_DISABLED', 'This provider is not enabled in the current mode.')
      if (!provider.onboarding.ready) return problem(409, 'HOST_PROVIDER_NOT_READY', provider.onboarding.setupMessage ?? 'Complete the provider configuration and restart.')
      const credentials = credentialsFor(provider, await jsonBody(request))
      if (connect[2] && !provider.reconnect) return problem(409, 'HOST_RECONNECT_UNAVAILABLE', 'This provider requires a new authorization flow.')
      return Response.json(await (connect[2] ? provider.reconnect!(liveInbox, owner, connect[2], credentials) : provider.connect(liveInbox, owner, credentials, origin!)), { headers: safeHeaders })
    }
    // Browser credentials go ONLY through the declared host onboarding fields, never raw SDK connection APIs.
    let path: string
    try { path = decodeURIComponent(url.pathname).replace(/\/+$/, '') } catch { return problem(400, 'HOST_INVALID_PATH', 'Invalid request path.') }
    if (request.method === 'POST' && (['/v1/connections', '/v1/accounts'].includes(path) || /^\/v1\/accounts\/[^/]+\/reconnect$/.test(path)) ||
      request.method === 'PUT' && /^\/v1\/connections\/[^/]+\/credentials$/.test(path)) return problem(403, 'HOST_CONNECT_REQUIRED', 'Use the host provider connection flow, not raw SDK credential input.')
    if (extension) return extension.fetch(request)
    if (url.pathname.startsWith('/v1/')) {
      // SDK events reauthenticate on every page and the one-second poll, against the
      // same uncached application session lookup. Revocation also terminates open SSE.
      const forwarded = url.pathname === '/v1/events' ? new Request(request, { signal: AbortSignal.any([request.signal, streamShutdown.signal]) }) : request
      return api.fetch(forwarded)
    }
    return problem(404, 'NOT_FOUND', 'Route not found.')
  }

  return {
    config, inbox: liveInbox,
    get owner() {
      if (applicationAuth) throw new InboxError('HOST_OWNER_REQUIRED', 'Google mail access requires an authenticated user owner.', 400)
      return owner
    },
    fetch(request: Request): Promise<Response> {
      const task = dispatch(request).then(async response => {
        if (applicationAuth && response.status === 401 && !await applicationAuth.identity(request)) response.headers.set('X-Superlocal-Auth', 'required')
        return response
      }).catch(error => {
        if (error instanceof InboxError && /^HOST_[A-Z_]+$/.test(error.code)) return problem(error.status, error.code, error.message)
        const known = error instanceof InboxError
        const status = known && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500
        return problem(status, known && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : 'HOST_REQUEST_FAILED', 'The local host request could not be completed.')
      })
      pending.add(task)
      void task.then(() => pending.delete(task), () => pending.delete(task))
      return task
    },
    start() { if (!closed) liveInbox.start() },
    close() {
      if (closing) return closing
      closed = true
      sessions.clear()
      streamShutdown.abort()
      return closing = (async () => {
        await Promise.all([...ownerContexts.values()].map(context => context.senderDomains.close()))
        await Promise.allSettled([...pending])
        ownerContexts.clear()
        await performanceLog.close()
        try { if (mock) await mock.close(); else await liveInbox.close() } finally { applicationAuth?.close(); runtime.database.close() }
      })()
    },
  }
}
