import { InboxError, type Inbox, type ProviderDefinition } from 'inbox-sdk'
import type { InboxApiOptions } from 'inbox-sdk/http'
import { builtInProviders } from 'inbox-sdk/providers'
import { createGoogleCredentialRefresh, verifyGoogleCredentials } from '../../../packages/inbox-sdk/server/credential-refresh'
import { createGoogleOAuthApi } from '../../../packages/inbox-sdk/server/google-oauth-api'
import { createGoogleOAuthHost, type GoogleOAuthConfig } from '../../../packages/inbox-sdk/server/google-oauth'
import { resolveSecret, type LocalConfig } from './config'
import type { openLocalRuntime } from './runtime'

export interface HostProvider {
  id: string
  name: string
  connection: 'oauth' | 'credentials' | 'none'
  enabled: boolean
  ready: boolean
  setupMessage?: string
  actionLabel?: string
  fields?: Array<{ name: string; label: string; type: 'password' | 'text'; required: boolean }>
  connectionIds: string[]
}

export type ConnectResult = { connectionId: string } | { authorizeUrl: string }
export interface HostProviderRegistration {
  definition: ProviderDefinition
  onboarding: Omit<HostProvider, 'connectionIds'>
  connect(inbox: Inbox, owner: string, credentials: Record<string, string>, origin: string): Promise<ConnectResult>
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
            headers.set('Location', `${config.web.origin}/?connection=${response.ok ? 'connected' : 'failed'}`)
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
  return { registrations, verifyCredentials: (context: Parameters<typeof verifyGoogleCredentials>[0]) => verifyGoogleCredentials(context, googleConfig) }
}
