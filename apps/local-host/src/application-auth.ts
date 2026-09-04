import { Database } from 'bun:sqlite'
import { betterAuth } from 'better-auth'
import { APIError } from 'better-auth/api'
import { getMigrations } from 'better-auth/db/migration'
import { verifyGoogleIdToken, type GoogleProfile } from 'better-auth/social-providers'
import { createHmac } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { InboxError } from 'inbox-sdk'
import { LocalConfigurationError, normalizeAllowedEmails, resolveSecret, type LocalConfig } from './config'
import type { openLocalRuntime } from './runtime'

const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', Vary: 'Origin, Cookie' }
const googleIssuer = 'https://accounts.google.com'
const validSubject = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,255}$/.test(value)

/** Auth sessions are paired with the existing runtime keys, never grounds to regenerate them. */
export function assertApplicationAuthRuntime(config: LocalConfig): void {
  const directory = join(config.dataDir, config.mode)
  const exists = (path: string) => {
    try { lstatSync(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  }
  if (['', '-wal', '-shm', '-journal'].some(suffix => exists(join(directory, `auth.sqlite${suffix}`))) &&
    (!exists(join(directory, 'runtime-secrets.json')) || !exists(join(directory, 'host.sqlite')))) {
    throw new LocalConfigurationError('LOCAL_AUTH_RUNTIME_MISSING', 'Application auth data exists without its paired runtime identity and keys. Restore the original runtime; no replacement keys were generated.')
  }
}

function privateFile(path: string, create = false): void {
  let fd: number | undefined
  try {
    try { lstatSync(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (!create) return
      fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    }
    fd ??= openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || process.platform !== 'win32' && ((stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.())) throw new Error('permissions')
  } catch {
    throw new LocalConfigurationError('LOCAL_AUTH_DATABASE_INVALID', 'The application auth database and its journals must be owner-only regular files (chmod 600), never symlinks. Existing files were not replaced.')
  } finally { if (fd !== undefined) closeSync(fd) }
}

/** Installation access only. This store never provisions or changes the fixed SDK mail owner. */
export async function createApplicationAuth(config: LocalConfig, runtime: ReturnType<typeof openLocalRuntime>, environment: NodeJS.ProcessEnv) {
  const clientId = resolveSecret(config.providers.gmail.oauth.clientId, environment)
  const clientSecret = resolveSecret(config.providers.gmail.oauth.clientSecret, environment)
  if (!clientId || !clientSecret) throw new LocalConfigurationError('LOCAL_GOOGLE_AUTH_NOT_CONFIGURED', 'Google application login requires the configured Gmail OAuth clientId and clientSecret, even when the Gmail provider is disabled. Configure them and restart; loopback authentication was not enabled.')
  // Snapshot configuration. Reload/restart is required; every later request rechecks this set.
  const allowed = new Set(normalizeAllowedEmails(config.auth.allowedEmails ?? []))
  const permits = (email: unknown, verified: unknown) => verified === true && typeof email === 'string' && allowed.has(email.trim().toLowerCase())
  const path = join(runtime.dataDir, 'auth.sqlite')
  for (const suffix of ['-wal', '-shm', '-journal', '']) privateFile(`${path}${suffix}`, suffix === '')
  const database = new Database(path, { readwrite: true, create: false })
  let closed = false
  const storedUserAllowed = (id: string) => {
    const user = database.query<{ email: string; emailVerified: number }, [string]>('SELECT email, emailVerified FROM user WHERE id = ?').get(id)
    const accounts = database.query<{ providerId: string; issuer: string; accountId: string }, [string]>('SELECT providerId, issuer, accountId FROM account WHERE userId = ?').all(id)
    return !!user && permits(user.email, user.emailVerified === 1) && accounts.length === 1 && accounts[0]!.providerId === 'google' && accounts[0]!.issuer === googleIssuer && validSubject(accounts[0]!.accountId)
  }
  try {
    database.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;')
    const auth = betterAuth({
      appName: 'Superlocal', baseURL: config.web.origin, basePath: '/api/auth', database,
      secret: createHmac('sha256', runtime.sessionKey).update('superlocal:application-auth:v1').digest('hex'),
      trustedOrigins: [config.web.origin],
      logger: { disabled: true }, telemetry: { enabled: false },
      emailAndPassword: { enabled: false },
      socialProviders: { google: {
        clientId, clientSecret, disableIdTokenSignIn: true, disableDefaultScope: true,
        scope: ['openid', 'email', 'profile'], includeGrantedScopes: false, accessType: 'online', prompt: 'select_account',
        overrideUserInfoOnSignIn: true,
        // The Google redirect provider otherwise only decodes claims in 1.7.2. Use its
        // official verifier as well: signature, issuer, audience, expiry and token age.
        async getUserInfo(tokens) {
          if (!tokens.idToken) return null
          const profile = await verifyGoogleIdToken({ token: tokens.idToken, audience: clientId })
          if (!profile || typeof profile.exp !== 'number' || !Number.isFinite(profile.exp) || profile.exp * 1000 <= Date.now() || !validSubject(profile.sub) || !permits(profile.email, profile.email_verified)) return null
          // Google's optional display fields are declared required in the upstream type;
          // retain its verified raw claims rather than inventing missing profile data.
          return { user: { name: typeof profile.name === 'string' ? profile.name : '', email: String(profile.email).trim().toLowerCase(), emailVerified: true }, data: profile as unknown as GoogleProfile }
        },
      } },
      user: {
        validateUserInfo({ user, source }) {
          const profile = source.oauth?.profile
          if (source.method !== 'oauth' || source.oauth?.providerId !== 'google' || source.action === 'link-account' ||
            !profile || !validSubject(profile.sub) || ![googleIssuer, 'accounts.google.com'].includes(String(profile.iss)) ||
            !permits(profile.email, profile.email_verified) || !permits(user.email, user.emailVerified)) return { error: 'access_denied' }
        },
      },
      account: { accountLinking: { enabled: false }, encryptOAuthTokens: true, storeStateStrategy: 'database', skipStateCookieCheck: false, storeAccountCookie: false },
      session: { expiresIn: config.auth.sessionHours * 3600, disableSessionRefresh: true, cookieCache: { enabled: false } },
      advanced: { cookiePrefix: `superlocal_app_${config.instanceId.replaceAll('-', '')}_${config.mode}`, useSecureCookies: config.web.origin.startsWith('https:'),
        ipAddress: { ipAddressHeaders: [] }, defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', path: '/' } },
      // Do not trust arbitrary forwarded-IP headers. One bounded installation-wide bucket.
      // Callback state comes from throttled sign-in; bogus states must not block valid callbacks.
      rateLimit: { enabled: true, window: 60, max: 60, storage: 'database', customRules: { '/sign-in/social': { window: 60, max: 20 }, '/callback/google': false } },
      onAPIError: { errorURL: `${config.web.origin}/?auth=denied` },
      databaseHooks: {
        user: { create: { async before(user) { if (!permits(user.email, user.emailVerified)) throw new APIError('FORBIDDEN', { code: 'access_denied', message: 'Access denied' }) } } },
        account: {
          create: { async before(account) {
            if (account.providerId !== 'google' || account.issuer !== googleIssuer || !validSubject(account.accountId)) throw new APIError('FORBIDDEN', { code: 'access_denied', message: 'Access denied' })
            // Login never needs provider tokens after identity verification. In particular,
            // do not retain the ID token (the upstream encrypt flag covers access/refresh).
            return { data: { ...account, accessToken: null, refreshToken: null, idToken: null } }
          } },
          update: { async before(account) { return { data: { ...account, accessToken: null, refreshToken: null, idToken: null } } } },
        },
        session: { create: { async before(session) { if (!storedUserAllowed(session.userId)) throw new APIError('FORBIDDEN', { code: 'access_denied', message: 'Access denied' }) } } },
      },
    })
    await (await getMigrations(auth.options)).runMigrations()
    await auth.$context
    for (const suffix of ['', '-wal', '-shm', '-journal']) privateFile(`${path}${suffix}`)

    async function identity(request: Request) {
      if (closed || request.headers.has('authorization') || (request.headers.get('cookie')?.length ?? 0) > 16_384) return null
      const result = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true, disableRefresh: true } })
      if (!result || !permits(result.user.email, result.user.emailVerified) || !storedUserAllowed(result.user.id)) return null
      return { sessionId: result.session.id, name: result.user.name, email: result.user.email }
    }
    const canonical = (request: Request, route: string, body?: object) => new Request(`${config.web.origin}/api/auth${route}`, {
      method: body ? 'POST' : 'GET', headers: { ...(request.headers.get('cookie') ? { Cookie: request.headers.get('cookie')! } : {}),
        ...(request.headers.get('origin') ? { Origin: request.headers.get('origin')! } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: request.signal,
    })
    async function handle(request: Request): Promise<Response> {
      const url = new URL(request.url)
      let response: Response
      if (url.pathname === '/api/auth/callback/google') {
        if (request.method !== 'GET') throw new InboxError('HOST_METHOD_NOT_ALLOWED', 'Use the Google redirect callback.', 405)
        if (url.search.length > 8192) throw new InboxError('HOST_BODY_TOO_LARGE', 'Authentication input exceeds the size limit.', 413)
        response = await auth.handler(canonical(request, `/callback/google${url.search}`))
        // Never forward provider error details into the application URL or access logs.
        const location = response.headers.get('location')
        if (location && new URL(location, config.web.origin).searchParams.has('auth')) response.headers.set('Location', `${config.web.origin}/?auth=denied`)
      } else {
        if (url.search) throw new InboxError('HOST_INVALID_INPUT', 'Authentication takes no query parameters.', 400)
        if (request.headers.get('origin') && request.headers.get('origin') !== config.web.origin || request.headers.get('sec-fetch-site') === 'cross-site') throw new InboxError('HOST_ORIGIN_FORBIDDEN', 'Use the configured application origin.', 403)
        if (url.pathname === '/host/auth' && request.method === 'GET') {
          const user = await identity(request)
          return Response.json({ method: 'google', authenticated: !!user, user: user ? { name: user.name, email: user.email } : null }, { headers })
        }
        if (!['/host/auth/sign-in', '/host/auth/sign-out'].includes(url.pathname)) throw new InboxError('HOST_AUTH_ROUTE_FORBIDDEN', 'Authentication route not available.', 404)
        if (request.method !== 'POST') throw new InboxError('HOST_METHOD_NOT_ALLOWED', 'Use POST for authentication.', 405)
        if (request.headers.get('origin') !== config.web.origin || request.headers.get('x-superlocal') !== '1') throw new InboxError('HOST_ORIGIN_FORBIDDEN', 'An exact Origin and X-Superlocal: 1 are required.', 403)
        await emptyBody(request)
        response = await auth.handler(canonical(request, url.pathname.endsWith('/sign-in') ? '/sign-in/social' : '/sign-out',
          url.pathname.endsWith('/sign-in') ? { provider: 'google', callbackURL: `${config.web.origin}/`, errorCallbackURL: `${config.web.origin}/?auth=denied`, disableRedirect: true } : {}))
        // Better Auth deliberately catches storage errors during sign-out. Never report a
        // successful revocation while the submitted, verified session still exists.
        if (url.pathname.endsWith('/sign-out') && response.ok && await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true, disableRefresh: true } })) {
          return Response.json({ code: 'HOST_AUTH_REVOCATION_FAILED', error: 'Sign-out could not be completed.', retryable: true }, { status: 503, headers })
        }
      }
      for (const [key, value] of Object.entries(headers)) response.headers.set(key, value)
      return response
    }
    return {
      identity, handle,
      close() { closed = true; database.close() },
    }
  } catch (error) { database.close(); throw error }
}

async function emptyBody(request: Request): Promise<void> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '') || request.headers.has('content-encoding')) throw new InboxError('HOST_JSON_REQUIRED', 'Use unencoded application/json.', 415)
  const length = request.headers.get('content-length')
  if (length && (!/^\d+$/.test(length) || Number(length) > 1024)) throw new InboxError('HOST_BODY_TOO_LARGE', 'Authentication input exceeds the size limit.', 413)
  if (!request.body) throw new InboxError('HOST_INVALID_INPUT', 'An empty JSON object is required.', 400)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0, expired = false
  const timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => {}) }, 2000)
  try {
    while (true) {
      const next = await reader.read()
      if (expired) throw new InboxError('HOST_BODY_TIMEOUT', 'Authentication input timed out.', 408)
      if (next.done) break
      size += next.value.length
      if (size > 1024) { void reader.cancel().catch(() => {}); throw new InboxError('HOST_BODY_TOO_LARGE', 'Authentication input exceeds the size limit.', 413) }
      chunks.push(next.value)
    }
    let value: unknown
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) } catch { throw new InboxError('HOST_INVALID_INPUT', 'An empty JSON object is required.', 400) }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length) throw new InboxError('HOST_INVALID_INPUT', 'An empty JSON object is required.', 400)
  } finally { clearTimeout(timer); reader.releaseLock() }
}
