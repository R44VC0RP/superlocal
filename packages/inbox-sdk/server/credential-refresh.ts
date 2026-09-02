import { CredentialError, type CredentialContext, type ProviderDefinition } from '../src/contracts'
import type { GoogleOAuthConfig } from './google-oauth'
import { ProviderError, providerJson } from './sdk/types'

export async function refreshOAuthCredentials(
  provider: 'gmail' | 'outlook',
  credentials: Record<string, unknown>,
  signal: AbortSignal,
  now: () => number = Date.now,
): Promise<Record<string, unknown>> {
  if (typeof credentials.refreshToken !== 'string' || !credentials.refreshToken ||
    typeof credentials.clientId !== 'string' || !credentials.clientId) {
    throw new CredentialError('unavailable', 'Token refresh requires explicit refreshToken and clientId credentials.')
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: credentials.refreshToken, client_id: credentials.clientId,
  })
  if (typeof credentials.clientSecret === 'string') body.set('client_secret', credentials.clientSecret)
  const tenant = typeof credentials.tenantId === 'string' ? credentials.tenantId : 'common'
  const url = provider === 'gmail'
    ? 'https://oauth2.googleapis.com/token'
    : `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`
  let result: { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string }
  try {
    result = await providerJson(provider, typeof credentials.fetch === 'function' ? credentials.fetch as typeof fetch : fetch,
      url, { method: 'POST', signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })
  } catch (error) {
    const code = error instanceof ProviderError && error.details && typeof error.details === 'object'
      ? (error.details as { error?: string }).error : undefined
    if (code === 'invalid_client') {
      throw new CredentialError('unavailable', 'OAuth client configuration is unavailable.')
    }
    if (code === 'invalid_grant') {
      throw new CredentialError('revoked', 'OAuth credentials must be reconnected.')
    }
    throw error
  }
  if (!result || typeof result.access_token !== 'string' || !result.access_token) {
    throw new ProviderError(provider, 'UPSTREAM', 'OAuth token response omitted the access token')
  }
  return {
    accessToken: result.access_token,
    ...(result.refresh_token ? { refreshToken: result.refresh_token } : {}),
    ...(typeof result.expires_in === 'number' && Number.isFinite(result.expires_in) && result.expires_in > 0
      ? { expiresAt: new Date(now() + result.expires_in * 1000).toISOString() } : {}),
    ...(typeof result.scope === 'string' ? { scopes: result.scope.split(/\s+/).filter(Boolean) } : {}),
  }
}

export function createGoogleCredentialRefresh(
  config: GoogleOAuthConfig | undefined,
  fetcher?: typeof fetch,
  now: () => number = Date.now,
): ProviderDefinition['refresh'] {
  return async (credentials, signal, context) => {
    const identity = context?.connection.identity
    if (context && context.connection.providerId !== 'gmail') {
      throw new CredentialError('unavailable', 'Google credential refresh requires a Gmail connection.')
    }
    if (identity && (!config?.clientId || !config.clientSecret || identity.issuer !== 'https://accounts.google.com' ||
      identity.registrationId !== config.clientId)) {
      throw new CredentialError('unavailable', 'The Google client registration for this connection is unavailable.')
    }
    return refreshOAuthCredentials('gmail', { ...credentials,
      ...(identity ? { clientId: config!.clientId, clientSecret: config!.clientSecret } : {}),
      ...(fetcher ? { fetch: fetcher } : {}),
    }, signal, now)
  }
}

export async function verifyGoogleCredentials(
  context: CredentialContext,
  config: GoogleOAuthConfig | undefined,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<boolean> {
  const { connection, credentials, signal } = context
  const identity = connection.identity
  if (connection.providerId !== 'gmail' || !identity) return false
  if (!config?.clientId || !config.clientSecret || identity.issuer !== 'https://accounts.google.com' ||
    identity.registrationId !== config.clientId) {
    throw new CredentialError('unavailable', 'The Google client registration for this connection is unavailable.')
  }
  if (typeof credentials.accessToken !== 'string' || !credentials.accessToken || credentials.accessToken.length > 16_384 ||
    credentials.accessToken.trim() !== credentials.accessToken || /[\x00-\x1f\x7f]/.test(credentials.accessToken)) {
    throw new CredentialError('unavailable', 'Google identity verification requires an access token.')
  }
  const userInfo = await providerJson<{ sub?: unknown; email?: unknown; email_verified?: unknown }>('gmail', fetcher,
    'https://openidconnect.googleapis.com/v1/userinfo', {
      method: 'GET', signal, redirect: 'error', cache: 'no-store', headers: { Authorization: `Bearer ${credentials.accessToken}` },
    })
  return !!userInfo && typeof userInfo.sub === 'string' && userInfo.sub.length > 0 && userInfo.sub.length <= 255 &&
    userInfo.sub === identity.subject && typeof userInfo.email === 'string' && userInfo.email.length <= 320 &&
    /^[^@\s]+@[^@\s]+$/.test(userInfo.email) && !/[\x00-\x1f\x7f]/.test(userInfo.email) && userInfo.email_verified === true
}
