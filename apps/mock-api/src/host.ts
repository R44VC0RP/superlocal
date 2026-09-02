import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createInbox, InboxError, type Inbox, type ConnectionIdentity } from 'inbox-sdk'
import { createInboxApi } from 'inbox-sdk/http'
import { MOCK_HOSTNAME, MOCK_UI_ORIGINS, MockConfigurationError, readMockConfig, type MockConfigOverrides } from './config'
import { createMockProviderDefinition, mockCredentialScope } from './provider'
import { seedMockMail } from './seed'
import { MockMailStore, type StoreScope } from './store'
import { MOCK_OWNER, PROVIDER_ID } from './validation'

const SYNC_INTERVAL_MS = 15_000
const SESSION_SECONDS = 12 * 60 * 60
const IDENTITY_ISSUER = 'superlocal.mock.offline'
const trustedOrigins = new Set<string>(MOCK_UI_ORIGINS)
const digest = (value: string) => createHash('sha256').update(value).digest()

export function logMockEvent(event: Record<string, string | number | boolean>): void {
  console.info(JSON.stringify(event))
}

function safeCode(value: string): string { return /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : 'MOCK_INTERNAL_ERROR' }

function safeProblem(status: number, code: string, message: string, headers?: HeadersInit): Response {
  return Response.json({ code, error: message, retryable: status >= 500 }, { status, headers: {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...Object.fromEntries(new Headers(headers)),
  } })
}

async function prepareSources(inbox: Inbox, store: MockMailStore): Promise<void> {
  let connections = await inbox.connections(MOCK_OWNER)
  const stores = store.mailboxes(MOCK_OWNER)
  if (connections.some(connection => connection.providerId !== PROVIDER_ID || connection.identity?.issuer !== IDENTITY_ISSUER ||
    connection.identity.registrationId !== store.identity || !stores.some(mailbox => mailbox.id === connection.identity?.subject))) {
    throw new MockConfigurationError('MOCK_CACHE_IDENTITY_MISMATCH', 'The mock cache and upstream store do not belong together. Use their original paired data directory.')
  }
  for (const mailbox of stores) {
    const identity: ConnectionIdentity = { issuer: IDENTITY_ISSUER, subject: mailbox.id, registrationId: store.identity }
    const saved = store.link(MOCK_OWNER, mailbox.id)
    let connection = connections.find(connection => connection.identity?.subject === mailbox.id)
    if (!connection && saved) throw new MockConfigurationError('MOCK_SOURCE_MISSING', 'A saved mock source is missing from its SDK cache. It was not silently recreated.')
    if (!connection) {
      connection = await inbox.createConnection(MOCK_OWNER, { providerId: PROVIDER_ID, credentials: { storeId: mailbox.id, databaseId: store.identity } }, identity)
      connections = [...connections, connection]
    }
    if (connection.sourceIds.length !== 1 || saved && (saved.connectionId !== connection.id || saved.accountId !== connection.sourceIds[0])) {
      throw new MockConfigurationError('MOCK_SOURCE_MISMATCH', 'The saved mock connection no longer addresses its original SDK source.')
    }
    const scope: StoreScope = { owner: MOCK_OWNER, storeId: mailbox.id, accountId: connection.sourceIds[0]! }
    store.linkSource(scope, connection.id)
    const account = await inbox.account(MOCK_OWNER, scope.accountId)
    // Disconnects and explicit pauses survive restarts; no reconnect/reset is performed here.
    if (connection.status !== 'connected' || account.status !== 'connected') continue
    const active = (await inbox.mailboxes(MOCK_OWNER)).filter(box => box.sourceId === scope.accountId && box.status === 'active')
    if (!active.length) continue
    await inbox.folders(MOCK_OWNER, scope.accountId)
    if (!saved?.cacheReady) {
      // Backfill must use the real SDK's backfill lane. The latest lane records recentCursor,
      // which intentionally does not walk a multi-page initial snapshot by itself.
      let more = true
      while (more) more = (await inbox.sync(MOCK_OWNER, scope.accountId, { folder: 'all', lane: 'backfill', limit: 32 })).hasMore
      for (const mailbox of active) {
        more = true
        while (more) more = (await inbox.syncMailbox(MOCK_OWNER, mailbox.id, { folder: 'inbox', lane: 'backfill', limit: 32 })).hasMore
      }
      store.markCacheReady(scope)
    }
    let more = true
    while (more) more = (await inbox.sync(MOCK_OWNER, scope.accountId, { folder: 'all', lane: 'latest', limit: 100 })).hasMore
  }
}

export interface MockHost {
  readonly inbox: Inbox
  readonly store: MockMailStore
  readonly owner: string
  readonly dataDir: string
  readonly port: number
  fetch(request: Request): Promise<Response>
  start(): void
  close(): Promise<void>
}

/** Importing this module does not bind a port or run background jobs. */
export async function createMockHost(overrides: MockConfigOverrides = {}): Promise<MockHost> {
  const config = readMockConfig(overrides)
  const store = new MockMailStore(config.upstreamPath)
  let inbox: Inbox | undefined
  try {
    seedMockMail(store)
    inbox = createInbox({
      database: config.cachePath, encryptionKey: config.encryptionKey,
      providers: [createMockProviderDefinition(store)], allowProviderWrites: config.allowProviderWrites,
      defaultPolicy: { remoteImages: true },
      syncIntervalMs: SYNC_INTERVAL_MS,
      // Fail closed if a future change accidentally tries to use the SDK-injected transport.
      fetch: Object.assign(async (_request: Parameters<typeof fetch>[0], _init?: RequestInit): Promise<Response> => {
        throw new Error('Network transport is disabled in the Superlocal mock.')
      }, { preconnect() { throw new Error('Network transport is disabled in the Superlocal mock.') } }),
      verifyCredentials(context) {
        if (context.connection.providerId !== PROVIDER_ID || context.owner !== MOCK_OWNER ||
          context.connection.identity?.issuer !== IDENTITY_ISSUER || context.connection.identity.registrationId !== store.identity) return false
        try {
          return context.connection.sourceIds.every(accountId => {
            const scope = mockCredentialScope(store, { ...context.credentials, accountId, userId: context.owner })
            const link = store.link(scope.owner, scope.storeId)
            return scope.storeId === context.connection.identity!.subject && link?.connectionId === context.connection.id
          })
        } catch { return false }
      },
      log: event => logMockEvent({ event: 'mock.sdk', code: safeCode(event.code), operation: /^[a-zA-Z0-9_.-]{1,80}$/.test(event.operation) ? event.operation : 'sdk' }),
    })
    await prepareSources(inbox, store)
  } catch (error) {
    try { await inbox?.close() } finally { store.close() }
    throw error
  }
  const liveInbox = inbox
  const expectedToken = digest(config.token)
  const cookieName = `superlocal_mock_${store.identity.replaceAll('-', '')}`
  const sessions = new Map<string, number>()
  let closed = false
  let closing: Promise<void> | undefined

  const authenticate = (request: Request): { id: string } | null => {
    if (closed) return null
    const authorization = request.headers.get('authorization')
    if (authorization !== null) {
      if (!authorization.startsWith('Bearer ') || authorization.length > 1031) return null
      return timingSafeEqual(expectedToken, digest(authorization.slice(7))) ? { id: MOCK_OWNER } : null
    }
    const origin = request.headers.get('origin')
    if (!(origin && trustedOrigins.has(origin)) && !(origin === null && request.headers.get('sec-fetch-site') === 'same-origin')) return null
    const cookies = (request.headers.get('cookie') ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${cookieName}=`))
    if (cookies.length !== 1) return null
    const value = cookies[0]!.slice(cookieName.length + 1)
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null
    const expires = sessions.get(digest(value).toString('hex'))
    return expires !== undefined && expires > Date.now() ? { id: MOCK_OWNER } : null
  }
  const api = createInboxApi({ inbox: liveInbox, authenticate, allowedOrigins: [...MOCK_UI_ORIGINS] })

  function browserSession(request: Request): Response {
    const origin = request.headers.get('origin')
    const trusted = origin !== null && trustedOrigins.has(origin)
    const cors = new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Vary': 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers' })
    if (trusted) {
      cors.set('Access-Control-Allow-Origin', origin)
      cors.set('Access-Control-Allow-Credentials', 'true')
    }
    if (request.method === 'OPTIONS') {
      const requested = (request.headers.get('access-control-request-headers') ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
      if (!trusted || request.headers.get('access-control-request-method') !== 'POST' || !requested.includes('x-superlocal-mock') || requested.some(header => !['x-superlocal-mock', 'content-type'].includes(header))) {
        return safeProblem(403, 'MOCK_ORIGIN_FORBIDDEN', 'This preflight is not permitted.', cors)
      }
      cors.set('Access-Control-Allow-Methods', 'POST')
      cors.set('Access-Control-Allow-Headers', 'X-Superlocal-Mock, Content-Type')
      return new Response(null, { status: 204, headers: cors })
    }
    if (request.method !== 'POST') { cors.set('Allow', 'POST, OPTIONS'); return safeProblem(405, 'MOCK_METHOD_NOT_ALLOWED', 'Use POST for local browser sessions.', cors) }
    if (!trusted || request.headers.get('x-superlocal-mock') !== '1') return safeProblem(403, 'MOCK_ORIGIN_FORBIDDEN', 'An exact trusted local Origin and X-Superlocal-Mock: 1 are required.', cors)
    const now = Date.now()
    for (const [key, expires] of sessions) if (expires <= now) sessions.delete(key)
    if (sessions.size >= 256) sessions.delete(sessions.keys().next().value!)
    const token = randomBytes(32).toString('base64url')
    sessions.set(digest(token).toString('hex'), now + SESSION_SECONDS * 1000)
    cors.set('Set-Cookie', `${cookieName}=${token}; Path=/v1; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}`)
    // The session credential travels only in HttpOnly Set-Cookie, never in JSON or logs.
    return new Response(null, { status: 204, headers: cors })
  }

  return {
    inbox: liveInbox, store, owner: MOCK_OWNER, dataDir: config.dataDir, port: config.port,
    async fetch(request) {
      const requestId = randomUUID(); const started = performance.now()
      const url = new URL(request.url)
      let response: Response
      try {
        if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.protocol !== 'http:') response = safeProblem(403, 'MOCK_LOOPBACK_REQUIRED', 'Use this mock service on loopback only.')
        else if (closed) response = safeProblem(503, 'MOCK_CLOSED', 'The local mock is shutting down.')
        else response = url.pathname === '/__mock/session' ? browserSession(request) : await api.fetch(request)
      } catch (error) {
        const code = error instanceof InboxError ? safeCode(error.code) : 'MOCK_INTERNAL_ERROR'
        logMockEvent({ event: 'mock.host', code, operation: 'request' })
        response = safeProblem(500, code, 'The local mock request failed.')
      }
      const responseHeaders = new Headers(response.headers)
      responseHeaders.set('X-Mock-Request-Id', requestId)
      responseHeaders.set('X-Request-Id', requestId)
      responseHeaders.set('Access-Control-Expose-Headers', [responseHeaders.get('Access-Control-Expose-Headers'), 'X-Request-Id'].filter(Boolean).join(', '))
      responseHeaders.set('X-Superlocal-Mock', 'offline')
      logMockEvent({ event: 'mock.request', method: request.method, path: url.pathname,
        status: response.status, elapsedMs: Math.round((performance.now() - started) * 100) / 100, requestId })
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders })
    },
    start() { if (!closed) liveInbox.start() },
    close() {
      if (closing) return closing
      closed = true
      sessions.clear()
      closing = (async () => { try { await liveInbox.close() } finally { store.close() } })()
      return closing
    },
  }
}

export async function startMockServer(overrides: MockConfigOverrides = {}) {
  const host = await createMockHost(overrides)
  try {
    const server = Bun.serve({ hostname: MOCK_HOSTNAME, port: host.port,
      fetch: request => host.fetch(request), idleTimeout: 0, maxRequestBodySize: 27 * 1024 * 1024 })
    host.start()
    let stopping: Promise<void> | undefined
    const close = () => stopping ??= (async () => { try { await server.stop(true) } finally { await host.close() } })()
    return { host, server, close }
  } catch (error) { await host.close(); throw error }
}
