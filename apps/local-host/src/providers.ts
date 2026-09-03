import { InboxError, type Inbox, type ProviderDefinition } from 'inbox-sdk'
import type { InboxApiOptions } from 'inbox-sdk/http'
import { builtInProviders } from 'inbox-sdk/providers'
import { createHash } from 'node:crypto'
import { ImapProvider } from '../../../packages/inbox-sdk/server/sdk/imap'
import { createGoogleCredentialRefresh, verifyGoogleCredentials } from '../../../packages/inbox-sdk/server/credential-refresh'
import { createGoogleOAuthApi } from '../../../packages/inbox-sdk/server/google-oauth-api'
import { createGoogleOAuthHost, type GoogleOAuthConfig } from '../../../packages/inbox-sdk/server/google-oauth'
import { resolveSecret, type ImapHostPreset, type LocalConfig } from './config'
import type { openLocalRuntime } from './runtime'

export interface HostProvider {
  id: string
  name: string
  connection: 'oauth' | 'credentials' | 'none'
  enabled: boolean
  ready: boolean
  setupMessage?: string
  actionLabel?: string
  fields?: Array<{ name: string; label: string; type: 'password' | 'text' | 'email' | 'select'; required: boolean; advanced?: boolean; defaultValue?: string; options?: Array<{ value: string; label: string }> }>
  mailboxSelection?: 'automatic' | 'manual'
  credentialHelp?: { text: string; url: string }
  reconnect?: boolean
  connectionIds: string[]
}

export type ConnectResult = { connectionId: string } | { authorizeUrl: string }
export interface HostProviderRegistration {
  definition: ProviderDefinition
  onboarding: Omit<HostProvider, 'connectionIds'>
  connect(inbox: Inbox, owner: string, credentials: Record<string, string>, origin: string): Promise<ConnectResult>
  reconnect?(inbox: Inbox, owner: string, connectionId: string, credentials: Record<string, string>): Promise<ConnectResult>
  mount?(inbox: Inbox, authenticate: InboxApiOptions['authenticate']): {
    matches(path: string): boolean
    callbackPath: string
    fetch(request: Request): Promise<Response>
  }
}

function builtIn(id: string, baseUrl: string): ProviderDefinition {
  const provider = builtInProviders.find(provider => provider.id === id)
  if (!provider) throw new Error('Required built-in provider is unavailable')
  // Even trusted SDK credential reloads cannot change a built-in provider's upstream.
  return { ...provider, create: credentials => provider.create({ ...credentials, baseUrl }) }
}

export function createRealRegistrations(config: LocalConfig, runtime: ReturnType<typeof openLocalRuntime>, environment: NodeJS.ProcessEnv) {
  const registrations: HostProviderRegistration[] = []
  let googleConfig: GoogleOAuthConfig | undefined
  if (config.providers.gmail.enabled) {
    const clientId = resolveSecret(config.providers.gmail.oauth.clientId, environment)
    const clientSecret = resolveSecret(config.providers.gmail.oauth.clientSecret, environment)
    if (clientId && clientSecret) googleConfig = { clientId, clientSecret, scopes: config.providers.gmail.oauth.scopes,
      redirectUri: `${config.web.origin}/v1/oauth/google/callback` }
    let coordinator: ReturnType<typeof createGoogleOAuthHost> | undefined
    const oauth = (inbox: Inbox) => {
      if (!googleConfig) throw new InboxError('HOST_PROVIDER_NOT_READY', 'Configure the Gmail OAuth client in superlocal.local.json or its explicitly named environment variables, then restart.', 409)
      return coordinator ??= createGoogleOAuthHost({ inbox, database: runtime.database, encryptionKey: runtime.encryptionKey, config: googleConfig })
    }
    registrations.push({
      definition: { ...builtIn('gmail', 'https://gmail.googleapis.com/gmail/v1'), scopes: config.providers.gmail.oauth.scopes, refresh: createGoogleCredentialRefresh(googleConfig) },
      onboarding: { id: 'gmail', name: 'Gmail', connection: 'oauth', enabled: true, ready: !!googleConfig, actionLabel: 'Sign in with Google',
        ...(!googleConfig ? { setupMessage: 'Set providers.gmail.oauth.clientId and clientSecret in superlocal.local.json (or their explicit environment references), register web.origin + /v1/oauth/google/callback with Google, then restart.' } : {}) },
      async connect(inbox, owner, _credentials, origin) {
        if (origin !== config.web.origin) throw new InboxError('HOST_OAUTH_ORIGIN_REQUIRED', 'Open the configured web.origin before starting OAuth so its session and callback stay on the same origin.', 409)
        const attempt = await oauth(inbox).start(owner)
        if (!attempt.authorizeUrl) throw new InboxError('HOST_OAUTH_UNAVAILABLE', 'OAuth could not be started.', 503)
        const url = new URL(attempt.authorizeUrl)
        if (url.origin !== config.web.origin) throw new InboxError('HOST_OAUTH_UNAVAILABLE', 'OAuth origin does not match the local web origin.', 503)
        return { authorizeUrl: `${url.pathname}${url.search}` }
      },
      mount(inbox, authenticate) {
        const api = createGoogleOAuthApi({ oauth: () => oauth(inbox), authenticate, allowedOrigins: config.web.allowedOrigins })
        const callbackPath = '/v1/oauth/google/callback'
        return {
          matches: path => path.startsWith('/v1/oauth/google/'), callbackPath,
          async fetch(request) {
            const incoming = new URL(request.url)
            // Vite may rewrite Host. The coordinator must see its exact registered callback URL.
            const canonical = new Request(new URL(`${incoming.pathname}${incoming.search}`, config.web.origin), request)
            const response = await api.fetch(canonical)
            if (incoming.pathname !== callbackPath || request.method !== 'GET') return response
            const headers = new Headers(response.headers)
            headers.delete('Content-Type')
            headers.delete('Content-Length')
            // Tell the web app which provider finished so it can resume onboarding for that connection.
            const params = new URLSearchParams({ connection: response.ok ? 'connected' : 'failed', provider: 'gmail' })
            if (response.ok) {
              const body = await response.clone().json().catch(() => null) as { id?: unknown } | null
              if (typeof body?.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(body.id)) params.set('connectionId', body.id)
            }
            headers.set('Location', `${config.web.origin}/?${params}`)
            return new Response(null, { status: 303, headers })
          },
        }
      },
    })
  }
  if (config.providers.inbound.enabled) registrations.push({
    definition: builtIn('inbound', 'https://inbound.new/api/e2'),
    onboarding: { id: 'inbound', name: 'Inbound', connection: 'credentials', enabled: true, ready: true, actionLabel: 'Connect Inbound',
      fields: [{ name: 'apiKey', label: 'API key', type: 'password', required: true }] },
    async connect(inbox, owner, credentials) {
      const connection = await inbox.createConnection(owner, { providerId: 'inbound', credentials })
      return { connectionId: connection.id }
    },
  })
  if (config.providers.imap.enabled) {
    const presets: ImapHostPreset[] = [{ id: 'icloud', name: 'iCloud Mail',
      imap: { host: 'imap.mail.me.com', port: 993, secure: true },
      smtp: { host: 'smtp.mail.me.com', port: 587, secure: false }, sentCopy: 'append' }, ...config.providers.imap.servers]
    const prepare = (credentials: Record<string, unknown>) => {
      const preset = presets.find(preset => preset.id === (credentials.preset || 'icloud'))
      if (!preset) throw new InboxError('HOST_IMAP_ENDPOINT_FORBIDDEN', 'Select a mail server preset configured by this host.', 400)
      const { email, password } = credentials
      if (typeof email !== 'string' || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email) || typeof password !== 'string' || !password.length) {
        throw new InboxError('HOST_INVALID_CREDENTIALS', 'Enter the mailbox email and its mail password. For iCloud, use an app-specific password.', 400)
      }
      // Endpoints, TLS, and Sent policy are host-owned. Browser fields cannot override them.
      // The full iCloud address is Apple's documented alternative IMAP username and required SMTP username.
      const address = email.toLowerCase()
      const imapUser = preset.id === 'icloud' ? address : typeof credentials.imapUsername === 'string' && credentials.imapUsername || address
      const smtpUser = preset.id === 'icloud' ? address : typeof credentials.smtpUsername === 'string' && credentials.smtpUsername || address
      const identity = { issuer: `imaps://${preset.imap.host}:${preset.imap.port}`, subject: imapUser,
        registrationId: createHash('sha256').update(JSON.stringify([preset, address, smtpUser])).digest('hex') }
      return { identity, email: address, imap: { ...preset.imap, user: imapUser, password },
        ...(preset.smtp ? { smtp: { ...preset.smtp, user: smtpUser, password } } : {}), sentCopy: preset.sentCopy }
    }
    const connectError = (error: unknown): never => {
      if (error instanceof InboxError && error.code.startsWith('HOST_')) throw error
      const code = error instanceof InboxError ? error.code : 'NETWORK'
      if (code === 'CONNECTION_EXISTS') throw new InboxError('HOST_IMAP_ALREADY_CONNECTED', 'This mailbox is already connected. Choose its Reconnect option to replace the password.', 409)
      const message = code === 'AUTHENTICATION' || code === 'CREDENTIALS_UNAVAILABLE' ? 'Mail sign-in failed. Check the mailbox email and use a valid app-specific password for iCloud. Revoked passwords must be replaced.'
        : code === 'ACCOUNT_MISMATCH' ? 'Reconnect using the same mailbox, server preset and usernames. A different account needs a new connection.'
        : 'The mail server could not be reached securely. Check the configured servers and connection, then try again; certificate verification cannot be disabled.'
      throw new InboxError(`HOST_IMAP_${code === 'AUTHENTICATION' || code === 'CREDENTIALS_UNAVAILABLE' ? 'AUTHENTICATION' : code === 'ACCOUNT_MISMATCH' ? 'ACCOUNT_MISMATCH' : 'CONNECTION_FAILED'}`, message, 409)
    }
    registrations.push({
      definition: { ...builtInProviders.find(provider => provider.id === 'imap')!, create(credentials, context) {
        const prepared = prepare(credentials)
        return new ImapProvider({ accountId: credentials.accountId, userId: credentials.userId, signal: context?.signal,
          email: prepared.email, imap: prepared.imap, smtp: prepared.smtp, sentCopy: prepared.sentCopy })
      } },
      onboarding: { id: 'imap', name: presets.length === 1 ? 'iCloud Mail' : 'iCloud Mail / IMAP', connection: 'credentials', enabled: true, ready: true,
        actionLabel: 'Connect mailbox', mailboxSelection: 'automatic', reconnect: true,
        credentialHelp: { text: 'For iCloud, create a dedicated app-specific password with two-factor authentication enabled. Do not use your Apple Account password.', url: 'https://support.apple.com/en-us/102654' },
        fields: [
          ...(presets.length > 1 ? [{ name: 'preset', label: 'Mail service', type: 'select' as const, required: true, defaultValue: 'icloud', options: presets.map(preset => ({ value: preset.id, label: preset.name })) }] : []),
          { name: 'email', label: 'Email address', type: 'email', required: true },
          { name: 'password', label: 'App-specific password', type: 'password', required: true },
          ...(presets.length > 1 ? [{ name: 'imapUsername', label: 'IMAP username (defaults to email)', type: 'text' as const, required: false, advanced: true },
            { name: 'smtpUsername', label: 'SMTP username (defaults to email)', type: 'text' as const, required: false, advanced: true }] : []),
        ] },
      async connect(inbox, owner, credentials) {
        try {
          const prepared = prepare(credentials)
          const connection = await inbox.createConnection(owner, { providerId: 'imap', credentials }, prepared.identity)
          return { connectionId: connection.id }
        } catch (error) { return connectError(error) }
      },
      async reconnect(inbox, owner, connectionId, credentials) {
        const connection = await inbox.connection(owner, connectionId)
        if (connection.providerId !== 'imap') throw new InboxError('HOST_IMAP_ACCOUNT_MISMATCH', 'This is not an IMAP connection.', 409)
        try {
          const prepared = prepare(credentials)
          if (!connection.identity || JSON.stringify(connection.identity) !== JSON.stringify(prepared.identity)) throw new InboxError('ACCOUNT_MISMATCH', 'Connection identity differs.', 409)
          if (connection.status === 'disconnected') await inbox.reconnect(owner, connection.sourceIds[0]!, credentials, { identity: prepared.identity, generation: connection.generation })
          else {
            const state = await inbox.credentialState(owner, connectionId)
            await inbox.updateCredentials(owner, connectionId, credentials, state.version, prepared.identity)
          }
          return { connectionId }
        } catch (error) { return connectError(error) }
      },
    })
  }
  return { registrations, verifyCredentials: (context: Parameters<typeof verifyGoogleCredentials>[0]) => verifyGoogleCredentials(context, googleConfig) }
}
