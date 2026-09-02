import { genericOAuth, type GenericOAuthConfig } from 'better-auth/plugins'

export type AuthProviderId = 'google' | 'inbound'

export interface PublicAuthProvider {
  id: AuthProviderId
  name: string
}

interface ProviderCredentials {
  clientId: string
  clientSecret: string
}

export interface GoogleProviderConfig extends ProviderCredentials {
  scope: string[]
  accessType: 'offline'
  prompt: 'select_account consent'
}

interface AuthProviderPlugin {
  id: AuthProviderId
  name: string
  clientIdVariable: string
  clientSecretVariable: string
  configure: (credentials: ProviderCredentials, environment: NodeJS.ProcessEnv) =>
    | { kind: 'google'; config: GoogleProviderConfig }
    | { kind: 'generic'; config: GenericOAuthConfig }
}

function readOptionalUrl(
  environment: NodeJS.ProcessEnv,
  variable: string,
  fallback?: string,
): string | undefined {
  const value = environment[variable]?.trim() || fallback
  if (!value) return undefined

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${variable} must be a valid absolute URL`)
  }

  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && environment.NODE_ENV !== 'production')) {
    throw new Error(`${variable} must use HTTPS outside local development`)
  }

  return url.toString().replace(/\/$/, '')
}

const AUTH_PROVIDER_PLUGINS: readonly AuthProviderPlugin[] = [
  {
    id: 'google',
    name: 'Google',
    clientIdVariable: 'GOOGLE_CLIENT_ID',
    clientSecretVariable: 'GOOGLE_CLIENT_SECRET',
    configure: ({ clientId, clientSecret }, environment) => ({
      kind: 'google',
      config: {
        clientId,
        clientSecret,
        scope: !environment.INBOX_PROVIDERS?.trim() || environment.INBOX_PROVIDERS
          .split(',')
          .some((provider) => provider.trim().toLowerCase() === 'gmail')
          ? [
              'https://www.googleapis.com/auth/gmail.modify',
              'https://www.googleapis.com/auth/gmail.send',
            ]
          : [],
        accessType: 'offline',
        prompt: 'select_account consent',
      },
    }),
  },
  {
    id: 'inbound',
    name: 'Inbound',
    clientIdVariable: 'INBOUND_OAUTH_CLIENT_ID',
    clientSecretVariable: 'INBOUND_OAUTH_CLIENT_SECRET',
    configure: ({ clientId, clientSecret }, environment) => {
      const issuer = readOptionalUrl(
        environment,
        'INBOUND_OAUTH_ISSUER',
        'https://inbound.new/api/auth',
      )!
      const explicitEndpoints = Boolean(
        environment.INBOUND_OAUTH_AUTHORIZATION_URL?.trim() ||
        environment.INBOUND_OAUTH_TOKEN_URL?.trim() ||
        environment.INBOUND_OAUTH_USERINFO_URL?.trim(),
      )
      const discoveryUrl = readOptionalUrl(
        environment,
        'INBOUND_OAUTH_DISCOVERY_URL',
        explicitEndpoints ? undefined : `${issuer}/.well-known/openid-configuration`,
      )
      const authorizationUrl = readOptionalUrl(
        environment,
        'INBOUND_OAUTH_AUTHORIZATION_URL',
        discoveryUrl ? undefined : `${issuer}/oauth2/authorize`,
      )
      const tokenUrl = readOptionalUrl(
        environment,
        'INBOUND_OAUTH_TOKEN_URL',
        discoveryUrl ? undefined : `${issuer}/oauth2/token`,
      )
      const userInfoUrl = readOptionalUrl(
        environment,
        'INBOUND_OAUTH_USERINFO_URL',
        discoveryUrl ? undefined : `${issuer}/oauth2/userinfo`,
      )
      const scopes = (environment.INBOUND_OAUTH_SCOPES?.trim() || 'openid email profile')
        .split(/[\s,]+/)
        .filter(Boolean)

      return {
        kind: 'generic',
        config: {
          providerId: 'inbound',
          name: 'Inbound',
          clientId,
          clientSecret,
          accountIssuer: issuer,
          authentication: 'basic',
          pkce: true,
          scopes,
          ...(discoveryUrl ? { discoveryUrl, requireIdTokenVerification: true } : {}),
          ...(authorizationUrl ? { authorizationUrl } : {}),
          ...(tokenUrl ? { tokenUrl } : {}),
          ...(userInfoUrl ? { userInfoUrl } : {}),
        },
      }
    },
  },
]

export function resolveAuthProviders(environment: NodeJS.ProcessEnv = process.env) {
  const explicitlyEnabled = environment.AUTH_PROVIDERS?.trim()
  const allowList = explicitlyEnabled
    ? new Set(explicitlyEnabled.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean))
    : null
  const providers: PublicAuthProvider[] = []
  let google: GoogleProviderConfig | undefined
  const generic: GenericOAuthConfig[] = []

  for (const plugin of AUTH_PROVIDER_PLUGINS) {
    if (allowList && !allowList.has(plugin.id)) continue
    const clientId = environment[plugin.clientIdVariable]?.trim()
    const clientSecret = environment[plugin.clientSecretVariable]?.trim()
    if (!clientId || !clientSecret) continue

    const configured = plugin.configure({ clientId, clientSecret }, environment)
    if (configured.kind === 'google') google = configured.config
    else generic.push(configured.config)
    providers.push({ id: plugin.id, name: plugin.name })
  }

  return {
    providers,
    socialProviders: google ? { google } : {},
    plugins: generic.length > 0 ? [genericOAuth({ config: generic })] : [],
  }
}

const resolved = resolveAuthProviders()

export const enabledAuthProviders = resolved.providers
export const configuredSocialProviders = resolved.socialProviders
export const configuredAuthPlugins = resolved.plugins
