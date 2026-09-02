import { createHmac, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { createMockHost, type MockHost } from '@superlocal/mock-api'
import { createInbox, InboxError, type Inbox } from 'inbox-sdk'
import { createInboxApi } from 'inbox-sdk/http'
import { loadLocalConfig, object, type LocalConfig } from './config'
import { createRealRegistrations, type HostProvider, type HostProviderRegistration } from './providers'
import { openLocalRuntime } from './runtime'

const safeHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', Vary: 'Origin, Cookie' }
function problem(status: number, code: string, error: string): Response {
  return Response.json({ code, error, retryable: status >= 500 }, { status, headers: safeHeaders })
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) throw new InboxError('HOST_JSON_REQUIRED', 'Use application/json.', 415)
  const length = request.headers.get('content-length')
  if (length && (!/^\d+$/.test(length) || Number(length) > 16_384)) throw new InboxError('HOST_BODY_TOO_LARGE', 'Connection input exceeds the size limit.', 413)
  if (request.headers.has('content-encoding') && request.headers.get('content-encoding') !== 'identity') throw new InboxError('HOST_ENCODING_FORBIDDEN', 'Encoded connection input is not supported.', 415)
  if (!request.body) throw new InboxError('HOST_INVALID_INPUT', 'A JSON object is required.', 400)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 16_384) { await reader.cancel(); throw new InboxError('HOST_BODY_TOO_LARGE', 'Connection input exceeds the size limit.', 413) }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  let input: unknown
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
  catch { throw new InboxError('HOST_INVALID_JSON', 'Invalid JSON connection input.', 400) }
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
    if (typeof value !== 'string' || value.length > 4096 || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value) || field.required && !value) throw invalid()
    credentials[field.name] = value
  }
  return credentials
}

export async function createLocalHost(config: LocalConfig = loadLocalConfig(), environment: NodeJS.ProcessEnv = process.env) {
  const runtime = openLocalRuntime(config)
  let mock: MockHost | undefined
  let inbox: Inbox | undefined
  let registrations: HostProviderRegistration[] = []
  let owner = `local:${config.instanceId}`
  try {
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
  } catch (error) { try { if (mock) await mock.close(); else await inbox?.close() } finally { runtime.database.close() }; throw error }
  const liveInbox = inbox
  const origins = new Set(config.web.allowedOrigins)
  const hosts = new Set([`127.0.0.1:${config.backend.port}`, `localhost:${config.backend.port}`, ...config.web.allowedOrigins.map(value => new URL(value).host)])
  const cookieName = `superlocal_${config.instanceId.replaceAll('-', '')}_${config.mode}`
  const sessions = new Map<string, { expires: number; origin: string }>()
  const cookieHash = (value: string) => createHmac('sha256', runtime.sessionKey).update(value).digest('hex')
  const streamShutdown = new AbortController()
  const pending = new Set<Promise<Response>>()
  let closed = false
  let closing: Promise<void> | undefined

  const authenticate = (request: Request): { id: string } | null => {
    if (closed || request.headers.has('authorization')) return null
    const cookies = (request.headers.get('cookie') ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${cookieName}=`))
    if (cookies.length !== 1) return null
    const token = cookies[0]!.slice(cookieName.length + 1)
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null
    const session = sessions.get(cookieHash(token))
    const origin = request.headers.get('origin')
    return session && session.expires > Date.now() && (!origin || origin === session.origin) ? { id: owner } : null
  }
  const api = createInboxApi({ inbox: liveInbox, authenticate, allowedOrigins: config.web.allowedOrigins })
  const extensions = registrations.flatMap(registration => registration.mount ? [registration.mount(liveInbox, authenticate)] : [])

  function session(request: Request): Response {
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

  async function dispatch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (!['http:', 'https:'].includes(url.protocol) || !hosts.has(url.host)) return problem(403, 'HOST_LOOPBACK_REQUIRED', 'Use the configured loopback host or local alias.')
    if (closed) return problem(503, 'HOST_CLOSED', 'The local host is shutting down.')
    if (url.pathname === '/session') return url.search ? problem(400, 'HOST_INVALID_INPUT', 'Session initialization takes no query parameters.') : session(request)
    if (url.pathname === '/health' && request.method === 'GET') return Response.json({ ok: true }, { headers: safeHeaders })
    const extension = extensions.find(extension => extension.matches(url.pathname))
    const callback = extension?.callbackPath === url.pathname && request.method === 'GET'
    const origin = request.headers.get('origin')
    if (!callback && (origin && !origins.has(origin) || request.headers.get('sec-fetch-site') === 'cross-site')) return problem(403, 'HOST_ORIGIN_FORBIDDEN', 'This request origin is not permitted.')
    if (!authenticate(request)) {
      if (callback) return new Response(null, { status: 303, headers: { ...safeHeaders, Location: `${config.web.origin}/?connection=failed` } })
      return problem(401, 'UNAUTHENTICATED', 'Initialize a local browser session first.')
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && (!origin || !origins.has(origin))) return problem(403, 'HOST_ORIGIN_FORBIDDEN', 'An exact allowed Origin is required for changes.')
    if (url.pathname === '/host/config' && request.method === 'GET') {
      if (url.search) return problem(400, 'HOST_INVALID_INPUT', 'Host configuration takes no query parameters.')
      const connections = await liveInbox.connections(owner)
      const descriptors: Array<Omit<HostProvider, 'connectionIds'>> = config.mode === 'mock'
        ? [{ id: 'mock', name: 'Offline mock', connection: 'none', enabled: true, ready: true }]
        : registrations.map(registration => registration.onboarding)
      return Response.json({ mode: config.mode, allowProviderWrites: config.allowProviderWrites,
        providers: descriptors.map(provider => ({ ...provider, connectionIds: connections.filter(connection => connection.providerId === provider.id).map(connection => connection.id) })) }, { headers: safeHeaders })
    }
    const connect = /^\/host\/providers\/([a-z][a-z0-9-]*)\/connect$/.exec(url.pathname)
    if (connect && request.method === 'POST') {
      if (url.search) return problem(400, 'HOST_INVALID_INPUT', 'Connection input belongs in the JSON body.')
      const provider = registrations.find(provider => provider.onboarding.id === connect[1])
      if (!provider) return problem(404, 'HOST_PROVIDER_DISABLED', 'This provider is not enabled in the current mode.')
      if (!provider.onboarding.ready) return problem(409, 'HOST_PROVIDER_NOT_READY', provider.onboarding.setupMessage ?? 'Complete the provider configuration and restart.')
      const credentials = credentialsFor(provider, await jsonBody(request))
      return Response.json(await provider.connect(liveInbox, owner, credentials, origin!), { headers: safeHeaders })
    }
    // Browser credentials go ONLY through the declared host onboarding fields, never raw SDK connection APIs.
    let path: string
    try { path = decodeURIComponent(url.pathname).replace(/\/+$/, '') } catch { return problem(400, 'HOST_INVALID_PATH', 'Invalid request path.') }
    if (request.method === 'POST' && (['/v1/connections', '/v1/accounts'].includes(path) || /^\/v1\/accounts\/[^/]+\/reconnect$/.test(path)) ||
      request.method === 'PUT' && /^\/v1\/connections\/[^/]+\/credentials$/.test(path)) return problem(403, 'HOST_CONNECT_REQUIRED', 'Use the host provider connection flow, not raw SDK credential input.')
    if (extension) return extension.fetch(request)
    if (url.pathname.startsWith('/v1/')) {
      const forwarded = url.pathname === '/v1/events' ? new Request(request, { signal: AbortSignal.any([request.signal, streamShutdown.signal]) }) : request
      return api.fetch(forwarded)
    }
    return problem(404, 'NOT_FOUND', 'Route not found.')
  }

  return {
    config, inbox: liveInbox, owner,
    fetch(request: Request): Promise<Response> {
      const task = dispatch(request).catch(error => {
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
        await Promise.allSettled([...pending])
        try { if (mock) await mock.close(); else await liveInbox.close() } finally { runtime.database.close() }
      })()
    },
  }
}
