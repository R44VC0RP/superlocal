import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { InboxError } from '../src/contracts'
import { createInbox } from '../src/core'
import { createInboxApi, type InboxApiOptions } from '../src/http'
import { builtInProviders } from '../src/providers'
import { createGoogleOAuthHost, type GoogleOAuthConfig } from './google-oauth'
import { createGoogleOAuthApi } from './google-oauth-api'
import { createGoogleCredentialRefresh, refreshOAuthCredentials, verifyGoogleCredentials } from './credential-refresh'

const token = process.env.INBOX_API_TOKEN?.trim()
const encryptionKey = process.env.CREDENTIAL_ENCRYPTION_KEY?.trim()
if (!token || token.length < 32 || !encryptionKey) {
  throw new Error('INBOX_API_TOKEN (at least 32 characters) and CREDENTIAL_ENCRYPTION_KEY are required. For local development use bun run dev.')
}
const expected = createHash('sha256').update(token).digest()
const configured = process.env.INBOX_PROVIDERS?.split(',').map(value => value.trim()).filter(Boolean)
if (configured?.some(id => !builtInProviders.some(provider => provider.id === id))) throw new Error('INBOX_PROVIDERS contains an unknown provider.')
const allowProviderWrites = process.env.INBOX_ALLOW_PROVIDER_WRITES === 'true'
if (process.env.INBOX_ALLOW_PROVIDER_WRITES && !['true', 'false'].includes(process.env.INBOX_ALLOW_PROVIDER_WRITES)) throw new Error('INBOX_ALLOW_PROVIDER_WRITES must be true or false.')
const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim()
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim()
if (Boolean(googleClientId) !== Boolean(googleClientSecret)) throw new Error('Configure both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or neither.')
const localUi = process.env.NODE_ENV === 'development' && ['127.0.0.1', 'localhost', '::1'].includes(process.env.HOST || '127.0.0.1')
const uiOrigin = `http://localhost:${process.env.PORT || 8788}`
const uiCookieName = `inbox_pilot_${process.env.PORT || 8788}`
const uiSession = randomBytes(32).toString('base64url')
const uiSessionHash = createHash('sha256').update(uiSession).digest()

function localUiRequest(request: Request): boolean {
  return localUi && new URL(request.url).origin === uiOrigin && request.headers.get('x-inbox-pilot') === '1' &&
    request.headers.get('sec-fetch-site') === 'same-origin' &&
    (!request.headers.has('origin') || request.headers.get('origin') === uiOrigin)
}

const databasePath = process.env.DATABASE_PATH || './data/inbox-v1.sqlite'
const googleConfig: GoogleOAuthConfig | undefined = googleClientId && googleClientSecret ? {
  clientId: googleClientId,
  clientSecret: googleClientSecret,
  redirectUri: process.env.GOOGLE_REDIRECT_URI || `http://localhost:${process.env.PORT || 8788}/v1/oauth/google/callback`,
  scopes: ['openid', 'email', ...(allowProviderWrites
    ? ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.send']
    : ['https://www.googleapis.com/auth/gmail.readonly'])],
} : undefined
const providers = (configured ? builtInProviders.filter(provider => configured.includes(provider.id)) : builtInProviders)
  .map(provider => provider.id === 'gmail' ? { ...provider, refresh: createGoogleCredentialRefresh(googleConfig) }
    : provider.id === 'outlook' ? { ...provider, refresh: (credentials: Record<string, unknown>, signal: AbortSignal) => refreshOAuthCredentials('outlook', credentials, signal) }
      : provider)
const inbox = createInbox({
  database: databasePath,
  encryptionKey,
  providers,
  syncIntervalMs: Number(process.env.INBOX_SYNC_INTERVAL_MS || 15_000),
  allowProviderWrites,
  verifyCredentials: context => verifyGoogleCredentials(context, googleConfig),
  log: event => console.error(JSON.stringify(event)),
})

const authenticate: InboxApiOptions['authenticate'] = request => {
    const authorization = request.headers.get('authorization')
    if (authorization) {
      if (!authorization.startsWith('Bearer ')) return null
      const actual = createHash('sha256').update(authorization.slice(7)).digest()
      return timingSafeEqual(expected, actual) ? { id: process.env.INBOX_OWNER_ID || 'local' } : null
    }
    if (!localUiRequest(request)) return null
    const cookies = (request.headers.get('cookie') || '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${uiCookieName}=`))
    if (cookies.length !== 1) return null
    const actual = createHash('sha256').update(cookies[0]!.slice(uiCookieName.length + 1)).digest()
    return timingSafeEqual(uiSessionHash, actual) ? { id: process.env.INBOX_OWNER_ID || 'local' } : null
}
const allowedOrigins = process.env.TRUSTED_ORIGINS?.split(',').map(value => value.trim()).filter(Boolean)
const api = createInboxApi({ inbox, authenticate, allowedOrigins })
let oauthDatabase: Database | undefined
let oauth: ReturnType<typeof createGoogleOAuthHost> | undefined
const googleApi = createGoogleOAuthApi({ authenticate, allowedOrigins, oauth: () => {
  if (!googleConfig) throw new InboxError('OAUTH_NOT_CONFIGURED', 'Google OAuth is not configured in this host.', 503)
  oauthDatabase ??= new Database(databasePath, { create: true })
  return oauth ??= createGoogleOAuthHost({ inbox, database: oauthDatabase, encryptionKey, config: googleConfig })
} })

export const app = new Hono()
if (localUi) {
  for (const path of ['/', '/pilot.js', '/pilot.css', '/favicon.ico', '/ui/session']) {
    app.use(path, async (c, next) => {
      c.header('Cache-Control', 'no-store')
      c.header('Referrer-Policy', 'no-referrer')
      c.header('X-Content-Type-Options', 'nosniff')
      c.header('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
      if (new URL(c.req.url).origin !== uiOrigin) {
        return c.req.path === '/' && c.req.method === 'GET' ? c.redirect(`${uiOrigin}/`, 302) : c.text('Use the localhost pilot origin.', 403)
      }
      await next()
    })
  }
  app.get('/', () => new Response(Bun.file(new URL('../public/index.html', import.meta.url))))
  app.get('/favicon.ico', () => new Response(null, { status: 204 }))
  app.get('/pilot.css', () => new Response(Bun.file(new URL('../public/pilot.css', import.meta.url))))
  app.get('/pilot.js', async (c) => {
    const bundle = await Bun.build({ entrypoints: [new URL('../public/pilot.ts', import.meta.url).pathname], target: 'browser' })
    if (!bundle.success) return c.text('Could not build the pilot interface.', 500)
    return new Response(bundle.outputs[0], { headers: { 'Content-Type': 'text/javascript; charset=utf-8' } })
  })
  app.post('/ui/session', (c) => {
    // This tokenless entry point is only available on a loopback-bound development server.
    if (!localUiRequest(c.req.raw) || c.req.header('origin') !== uiOrigin) return c.json({ error: 'Same-origin browser access required.' }, 403)
    c.header('Set-Cookie', `${uiCookieName}=${uiSession}; Path=/v1; HttpOnly; SameSite=Strict; Max-Age=43200`)
    return c.json({ googleConfigured: Boolean(googleClientId) && (!configured || configured.includes('gmail')), inboundEnabled: !configured || configured.includes('inbound'), allowProviderWrites })
  })
  app.use('/v1/oauth/google/callback', async (c, next) => {
    await next()
    if (c.req.method === 'GET' && new URL(c.req.url).origin === uiOrigin && c.req.header('accept')?.includes('text/html')) {
      const headers = new Headers(c.res.headers)
      headers.set('Location', `/?google=${c.res.ok ? 'connected' : 'failed'}`)
      headers.delete('Content-Type')
      headers.delete('Content-Length')
      c.res = new Response(null, { status: 303, headers })
    }
  })
}
app.route('/', googleApi)
app.route('/', api)

if (import.meta.main) {
  inbox.start()
  const server = Bun.serve({
    hostname: process.env.HOST || '127.0.0.1',
    port: Number(process.env.PORT || 8788),
    fetch: app.fetch,
    idleTimeout: 0,
  })
  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    await server.stop(true)
    await inbox.close()
    oauthDatabase?.close()
  }
  process.once('SIGTERM', () => { void stop() })
  process.once('SIGINT', () => { void stop() })
  console.info(`Inbox SDK API listening on http://${server.hostname}:${server.port}`)
  console.info(`Provider writes: ${allowProviderWrites ? 'enabled' : 'disabled (read-only pilot)'}. Google OAuth: ${googleClientId ? 'configured' : 'not configured'}.`)
  if (localUi) console.info(`Local pilot UI: ${uiOrigin}`)
}
