import type { Database } from 'bun:sqlite'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import * as oidc from 'openid-client'
import { InboxError, type Connection, type ConnectionIdentity, type Inbox } from '../src/contracts'
import { createCredentialCrypto } from './crypto'

export interface GoogleOAuthConfig {
  clientId: string
  clientSecret: string
  redirectUri: string
  scopes?: string[]
}

export interface OAuthAttempt {
  id: string
  providerId: 'gmail'
  status: 'pending' | 'authorizing' | 'exchanging' | 'completed' | 'failed'
  expiresAt: string
  connectionId: string | null
  authorizeUrl?: string
}

export interface OAuthRedirect { location: string; setCookie: string }
export interface OAuthCompletion { connection: Connection; setCookie: string }

export interface GoogleOAuthCoordinatorOptions {
  database: Database
  config: GoogleOAuthConfig
  now: () => number
  fetch?: typeof globalThis.fetch
  encrypt: (plaintext: string, owner: string, id: string) => string
  decrypt: (ciphertext: string, owner: string, id: string) => string
  finish: (owner: string, credentials: Record<string, unknown>, identity: ConnectionIdentity,
    reconnectConnectionId?: string, expectedGeneration?: number) => Promise<Connection>
  checkConnection: (owner: string, id: string) => Promise<Connection>
  listConnections: (owner: string) => Promise<Connection[]>
}

type AttemptRow = {
  id: string
  owner: string
  registration: string
  status: OAuthAttempt['status']
  expires_at: number
  reconnect_connection_id: string | null
  connection_id: string | null
  secrets: string | null
  ticket_hash: string | null
  state_hash: string | null
  binding_hash: string | null
  failure: string | null
}

type AttemptSecrets = {
  verifier: string
  nonce: string
  state: string
  handoff?: string
  identity: ConnectionIdentity | null
  generation?: number
  connections?: Array<{ id: string; identity: ConnectionIdentity; generation: number; status: Connection['status'] }>
}

const callbackPath = '/v1/oauth/google/callback'
const issuer = 'https://accounts.google.com'
const attemptLifetime = 10 * 60_000
const randomToken = /^[A-Za-z0-9_-]{43}$/
const scopeToken = /^[\x21\x23-\x5b\x5d-\x7e]+$/

function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }

function bounded(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max &&
    value.trim() === value && !/[\x00-\x1f\x7f]/.test(value)
}

function failure(): InboxError {
  return new InboxError('OAUTH_FAILED', 'The Google connection attempt could not be completed.', 400)
}

export function createGoogleOAuthCoordinator(options: GoogleOAuthCoordinatorOptions): {
  start(owner: string, input?: { connectionId?: string }): Promise<OAuthAttempt>
  attempt(owner: string, id: string): Promise<OAuthAttempt>
  authorize(id: string, ticket: string): Promise<OAuthRedirect>
  complete(callbackUrl: string, cookieHeader: string, currentOwner?: string): Promise<OAuthCompletion>
} {
  const { database: db, now, encrypt, decrypt, finish, checkConnection, listConnections } = options
  const { clientId, clientSecret, redirectUri } = options.config
  const transport = options.fetch ?? globalThis.fetch
  let redirect: URL
  let scopes: string[]
  try {
    if (!bounded(clientId, 1024) || !bounded(clientSecret, 4096) || !bounded(redirectUri, 2048)) throw failure()
    redirect = new URL(redirectUri)
    const loopback = redirect.hostname === 'localhost' || redirect.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(redirect.hostname)
    if (redirect.href !== redirectUri || !redirectUri.endsWith(callbackPath) || redirect.username || redirect.password || redirect.search || redirect.hash ||
      !redirect.pathname.endsWith(callbackPath) || /[;\s]/.test(redirect.pathname) ||
      (redirect.protocol !== 'https:' && !(redirect.protocol === 'http:' && loopback))) throw failure()
    const requested = options.config.scopes ?? ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly']
    if (!Array.isArray(requested) || requested.length > 64 ||
      requested.some(scope => !bounded(scope, 2048) || !scopeToken.test(scope)) ||
      !requested.includes('openid') || !requested.includes('email') || requested.join(' ').length > 8192) throw failure()
    scopes = [...new Set(requested)]
  } catch {
    throw new InboxError('VALIDATION', 'Google OAuth requires a valid client registration, callback URL, and OpenID email scopes.')
  }
  const registration = hash(JSON.stringify([clientId, redirectUri, scopes]))
  const baseUrl = redirectUri.slice(0, -callbackPath.length)

  function configuration(): oidc.Configuration {
    const config = new oidc.Configuration({
      issuer,
      authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      token_endpoint: 'https://oauth2.googleapis.com/token',
      jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
      userinfo_endpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['client_secret_post'],
      id_token_signing_alg_values_supported: ['RS256'],
      code_challenge_methods_supported: ['S256'],
    }, clientId, {
      client_secret: clientSecret,
      id_token_signed_response_alg: 'RS256',
      [oidc.clockTolerance]: 0,
      [oidc.clockSkew]: Math.floor(now() / 1000) - Math.floor(Date.now() / 1000),
    })
    config[oidc.customFetch] = (url, init) => transport(url, init as RequestInit)
    config.timeout = 30
    oidc.enableNonRepudiationChecks(config)
    return config
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS sdk_oauth_attempts (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, registration TEXT NOT NULL,
      status TEXT NOT NULL, expires_at INTEGER NOT NULL,
      reconnect_connection_id TEXT, connection_id TEXT, secrets TEXT,
      ticket_hash TEXT UNIQUE, state_hash TEXT UNIQUE, binding_hash TEXT, failure TEXT
    );
    CREATE INDEX IF NOT EXISTS sdk_oauth_attempt_expiry ON sdk_oauth_attempts(status,expires_at);
  `)

  function expire(): void {
    db.query(`UPDATE sdk_oauth_attempts SET status='failed', failure='OAUTH_FAILED',
      secrets=NULL, ticket_hash=NULL, state_hash=NULL, binding_hash=NULL
      WHERE expires_at<=? AND status IN ('pending','authorizing','exchanging')`).run(now())
  }

  function fail(id: string): void {
    try {
      db.query(`UPDATE sdk_oauth_attempts SET status='failed', failure='OAUTH_FAILED',
        secrets=NULL, ticket_hash=NULL, state_hash=NULL, binding_hash=NULL
        WHERE id=? AND status IN ('pending','authorizing','exchanging')`).run(id)
    } catch { /* A claimed capability stays consumed even if the database closes. */ }
  }

  function ownerId(owner: string): void {
    if (!bounded(owner, 1024)) throw new InboxError('UNAUTHORIZED', 'Authentication is required.', 401)
  }

  function attemptDTO(row: AttemptRow): OAuthAttempt {
    return { id: row.id, providerId: 'gmail', status: row.status,
      expiresAt: new Date(row.expires_at).toISOString(), connectionId: row.connection_id }
  }

  function secretsFor(row: AttemptRow): AttemptSecrets {
    if (!row.secrets || row.registration !== registration) throw failure()
    const secrets = JSON.parse(decrypt(row.secrets, row.owner, row.id)) as AttemptSecrets
    if (!secrets || !bounded(secrets.verifier, 128) || !randomToken.test(secrets.verifier) ||
      !bounded(secrets.nonce, 128) || !randomToken.test(secrets.nonce) ||
      !bounded(secrets.state, 128) || !randomToken.test(secrets.state)) throw failure()
    return secrets
  }

  function bindingCookie(id: string, value: string, maxAge: number): string {
    return `inbox_google_oauth_${id}=${value}; Path=${redirect.pathname}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}` +
      (redirect.protocol === 'https:' ? '; Secure' : '') +
      (maxAge === 0 ? '; Expires=Thu, 01 Jan 1970 00:00:00 GMT' : '')
  }

  return {
    async start(owner, input = {}) {
      ownerId(owner)
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(key => key !== 'connectionId') ||
        (input.connectionId !== undefined && !bounded(input.connectionId, 255))) {
        throw new InboxError('VALIDATION', 'Invalid Google connection input.')
      }
      let identity: ConnectionIdentity | null = null
      let generation: number | undefined
      const connections = input.connectionId === undefined ? (await listConnections(owner))
        .filter(connection => connection.providerId === 'gmail' && connection.identity?.issuer === issuer && connection.identity.registrationId === clientId)
        .map(connection => ({ id: connection.id, identity: { ...connection.identity! }, generation: connection.generation, status: connection.status })) : undefined
      if (input.connectionId !== undefined) {
        const connection = await checkConnection(owner, input.connectionId)
        if (connection.id !== input.connectionId || connection.providerId !== 'gmail' ||
          !connection.identity || connection.identity.issuer !== issuer || !bounded(connection.identity.subject, 255) ||
          connection.identity.registrationId !== clientId) {
          throw new InboxError('VALIDATION', 'This connection cannot be reconnected with this Google registration.')
        }
        identity = { ...connection.identity }
        generation = connection.generation
      }
      try {
        expire()
        const id = randomUUID()
        const handoff = oidc.randomState()
        const secrets: AttemptSecrets = { verifier: oidc.randomPKCECodeVerifier(), nonce: oidc.randomNonce(),
          state: oidc.randomState(), handoff, identity, ...(generation === undefined ? {} : { generation }), ...(connections ? { connections } : {}) }
        const expiresAt = now() + attemptLifetime
        db.query(`INSERT INTO sdk_oauth_attempts
          (id,owner,registration,status,expires_at,reconnect_connection_id,secrets,ticket_hash,state_hash)
          VALUES (?,?,?,'pending',?,?,?,?,?)`).run(id, owner, registration, expiresAt, input.connectionId ?? null,
          encrypt(JSON.stringify(secrets), owner, id), hash(handoff), hash(secrets.state))
        return { id, providerId: 'gmail', status: 'pending', expiresAt: new Date(expiresAt).toISOString(),
          connectionId: null, authorizeUrl: `${baseUrl}/v1/oauth/google/authorize/${id}?ticket=${handoff}` }
      } catch { throw failure() }
    },

    async attempt(owner, id) {
      ownerId(owner)
      if (!bounded(id, 128)) throw new InboxError('NOT_FOUND', 'OAuth attempt not found.', 404)
      expire()
      const row = db.query<AttemptRow, [string, string]>('SELECT * FROM sdk_oauth_attempts WHERE owner=? AND id=?').get(owner, id)
      if (!row) throw new InboxError('NOT_FOUND', 'OAuth attempt not found.', 404)
      return attemptDTO(row)
    },

    async authorize(id, ticket) {
      let claimed: AttemptRow | null = null
      try {
        if (!bounded(id, 128) || !bounded(ticket, 128) || !randomToken.test(ticket)) throw failure()
        expire()
        const binding = oidc.randomState()
        claimed = db.query<AttemptRow, [string, string, string, string, number]>(`UPDATE sdk_oauth_attempts
          SET status='authorizing', ticket_hash=NULL, binding_hash=?
          WHERE id=? AND registration=? AND ticket_hash=? AND status='pending' AND expires_at>? RETURNING *`)
          .get(hash(binding), id, registration, hash(ticket), now())
        if (!claimed) throw failure()
        const secrets = secretsFor(claimed)
        if (secrets.handoff !== ticket) throw failure()
        delete secrets.handoff
        db.query("UPDATE sdk_oauth_attempts SET secrets=? WHERE id=? AND status='authorizing'")
          .run(encrypt(JSON.stringify(secrets), claimed.owner, claimed.id), claimed.id)
        const location = oidc.buildAuthorizationUrl(configuration(), {
          redirect_uri: redirectUri,
          response_type: 'code',
          response_mode: 'query',
          scope: scopes.join(' '),
          state: secrets.state,
          nonce: secrets.nonce,
          code_challenge: await oidc.calculatePKCECodeChallenge(secrets.verifier),
          code_challenge_method: 'S256',
          access_type: 'offline',
          prompt: 'consent',
        }).href
        const active = db.query<{ status: string }, [string, number]>(
          "SELECT status FROM sdk_oauth_attempts WHERE id=? AND expires_at>? AND status='authorizing'").get(claimed.id, now())
        if (!active) throw failure()
        return { location, setCookie: bindingCookie(claimed.id, binding, Math.ceil((claimed.expires_at - now()) / 1000)) }
      } catch {
        if (claimed) fail(claimed.id)
        throw failure()
      }
    },

    async complete(callbackUrl, cookieHeader, currentOwner) {
      let claimed: AttemptRow | null = null
      try {
        if (!bounded(callbackUrl, 16_384) || callbackUrl.includes('#') ||
          callbackUrl.slice(0, callbackUrl.indexOf('?')) !== redirectUri) throw failure()
        const callback = new URL(callbackUrl)
        if (callback.hash || callback.username || callback.password || callback.origin !== redirect.origin ||
          callback.pathname !== redirect.pathname) throw failure()
        const state = callback.searchParams.get('state')
        if (!state || !randomToken.test(state) || callback.searchParams.getAll('state').length !== 1) throw failure()
        expire()
        const row = db.query<AttemptRow, [string, string]>(
          "SELECT * FROM sdk_oauth_attempts WHERE state_hash=? AND registration=? AND status='authorizing'").get(hash(state), registration)
        if (!row) throw failure()
        // Burn the state and encrypted verifier before any asynchronous provider work.
        const claim = db.query(`UPDATE sdk_oauth_attempts SET status='exchanging', secrets=NULL,
          ticket_hash=NULL, state_hash=NULL, binding_hash=NULL
          WHERE id=? AND state_hash=? AND status='authorizing' AND expires_at>?`).run(row.id, hash(state), now())
        if (claim.changes !== 1) throw failure()
        claimed = row
        if (currentOwner !== undefined && (!bounded(currentOwner, 1024) || currentOwner !== row.owner)) throw failure()
        if (typeof cookieHeader !== 'string' || cookieHeader.length > 16_384 || /[\x00-\x1f\x7f]/.test(cookieHeader)) throw failure()
        const cookieName = `inbox_google_oauth_${row.id}`
        const bindings = cookieHeader.split(';').map(part => part.trim()).filter(part => part.split('=', 1)[0] === cookieName)
        const binding = bindings[0]?.slice(cookieName.length + 1)
        if (bindings.length !== 1 || !binding || !randomToken.test(binding) || !row.binding_hash ||
          !timingSafeEqual(Buffer.from(hash(binding), 'hex'), Buffer.from(row.binding_hash, 'hex'))) throw failure()
        const keys = new Set<string>()
        for (const [key, value] of callback.searchParams) {
          if (keys.has(key) || keys.size >= 32 || !bounded(key, 128) || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) throw failure()
          keys.add(key)
        }
        const secrets = secretsFor(row)
        if (secrets.state !== state || callback.searchParams.has('error') || !bounded(callback.searchParams.get('code'), 8192)) throw failure()
        const config = configuration()
        const tokens = await oidc.authorizationCodeGrant(config, callback, {
          pkceCodeVerifier: secrets.verifier, expectedState: secrets.state, expectedNonce: secrets.nonce, idTokenExpected: true,
        })
        const tokenTime = now()
        const claims = tokens.claims()
        if (!claims || !bounded(claims.sub, 255) || claims.iss !== issuer || claims.exp * 1000 <= tokenTime ||
          !bounded(tokens.access_token, 16_384) || tokens.token_type !== 'bearer' ||
          (tokens.refresh_token !== undefined && !bounded(tokens.refresh_token, 16_384)) ||
          typeof tokens.expires_in !== 'number' || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) throw failure()
        const expiresAt = new Date(tokenTime + tokens.expires_in * 1000).toISOString()
        if (tokens.scope !== undefined && !bounded(tokens.scope, 8192)) throw failure()
        const grantedScopes = tokens.scope === undefined ? scopes : tokens.scope.split(' ')
        if (grantedScopes.length > 64 || grantedScopes.some(scope => !bounded(scope, 2048) || !scopeToken.test(scope)) ||
          !grantedScopes.includes('openid') ||
          !(grantedScopes.includes('email') || grantedScopes.includes('https://www.googleapis.com/auth/userinfo.email'))) throw failure()
        const userInfo = await oidc.fetchUserInfo(config, tokens.access_token, claims.sub)
        if (!bounded(userInfo.email, 320) || !/^[^@\s]+@[^@\s]+$/.test(userInfo.email) || userInfo.email_verified !== true) throw failure()
        const identity: ConnectionIdentity = { issuer, subject: claims.sub, registrationId: clientId }
        let targetId = row.reconnect_connection_id ?? undefined
        let expectedGeneration = secrets.generation
        if (row.reconnect_connection_id !== null) {
          const target = await checkConnection(row.owner, row.reconnect_connection_id)
          if (!secrets.identity || secrets.identity.issuer !== identity.issuer || secrets.identity.subject !== identity.subject ||
            secrets.identity.registrationId !== identity.registrationId || target.id !== row.reconnect_connection_id ||
            target.providerId !== 'gmail' || target.identity?.issuer !== identity.issuer ||
            target.identity.subject !== identity.subject || target.identity.registrationId !== identity.registrationId || target.generation !== secrets.generation) throw failure()
        } else {
          const previous = secrets.connections?.find(connection => connection.identity.subject === identity.subject && connection.identity.issuer === identity.issuer && connection.identity.registrationId === identity.registrationId)
          const current = (await listConnections(row.owner)).find(connection => connection.providerId === 'gmail' && connection.identity?.subject === identity.subject && connection.identity.issuer === identity.issuer && connection.identity.registrationId === identity.registrationId)
          if (previous) {
            if (previous.status !== 'connected' || current?.id !== previous.id || current.status !== 'connected' || current.generation !== previous.generation) throw failure()
            targetId = previous.id
            expectedGeneration = previous.generation
          } else if (current) {
            // Another attempt established this identity after ours began. Never replace its authority implicitly.
            throw failure()
          }
        }
        if (row.expires_at <= now() || claims.exp * 1000 <= now() || new Date(expiresAt).getTime() <= now()) throw failure()
        const credentials: Record<string, unknown> = { accessToken: tokens.access_token, expiresAt, scopes: [...new Set(grantedScopes)],
          ...(tokens.refresh_token === undefined ? {} : { refreshToken: tokens.refresh_token }) }
        const connection = await finish(row.owner, credentials, identity, targetId, expectedGeneration)
        // A finish already started before expiry may complete after a status poll expires the attempt.
        db.query("UPDATE sdk_oauth_attempts SET status='completed', connection_id=?, failure=NULL WHERE id=?")
          .run(connection.id, row.id)
        return { connection, setCookie: bindingCookie(row.id, '', 0) }
      } catch {
        if (claimed) fail(claimed.id)
        throw failure()
      }
    },
  }
}

export function createGoogleOAuthHost(options: {
  inbox: Inbox
  database: Database
  encryptionKey: string
  config: GoogleOAuthConfig
  now?: () => number
  fetch?: typeof globalThis.fetch
}): ReturnType<typeof createGoogleOAuthCoordinator> {
  const { inbox } = options
  if (!inbox.providers().some(provider => provider.id === 'gmail')) {
    throw new InboxError('UNSUPPORTED_PROVIDER', 'The Gmail provider is not enabled.', 409)
  }
  const crypto = createCredentialCrypto({ NODE_ENV: 'production', CREDENTIAL_ENCRYPTION_KEY: options.encryptionKey })
  return createGoogleOAuthCoordinator({ database: options.database, config: options.config, now: options.now ?? Date.now, fetch: options.fetch,
    encrypt: crypto.encryptCredential, decrypt: crypto.decryptCredential,
    checkConnection: (owner, id) => inbox.connection(owner, id),
    listConnections: owner => inbox.connections(owner),
    finish: async (owner, credentials, identity, reconnectConnectionId, expectedGeneration) => {
      if (reconnectConnectionId === undefined) return inbox.createConnection(owner, { providerId: 'gmail', credentials }, identity)
      const connection = await inbox.connection(owner, reconnectConnectionId)
      if (connection.id !== reconnectConnectionId || connection.providerId !== 'gmail' ||
        !connection.identity || connection.identity.issuer !== identity.issuer ||
        connection.identity.subject !== identity.subject || connection.identity.registrationId !== identity.registrationId) {
        throw new InboxError('ACCOUNT_MISMATCH', 'Reconnect must authorize the original Google identity.', 409)
      }
      if (connection.sourceIds.length !== 1) throw new InboxError('UNSUPPORTED_OPERATION', 'This connection requires explicit source selection.', 409)
      if (expectedGeneration === undefined) throw new InboxError('CONFLICT', 'Reconnect is missing its authorization generation.', 409)
      await inbox.reconnect(owner, connection.sourceIds[0]!, credentials, { identity, generation: expectedGeneration })
      return inbox.connection(owner, connection.id)
    },
  })
}
