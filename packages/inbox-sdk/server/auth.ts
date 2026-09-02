import { betterAuth } from 'better-auth'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { getMigrations } from 'better-auth/db/migration'
import { configuredAuthPlugins, configuredSocialProviders } from './auth-providers'
import { sqlite } from './db'
import { provisionGoogleMailbox } from './google-mailbox'

const isProduction = process.env.NODE_ENV === 'production'
const secret =
  process.env.BETTER_AUTH_SECRET ??
  process.env.AUTH_SECRET ??
  (isProduction ? undefined : 'openmail-development-secret-not-for-production-1234567890')

if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
  throw new Error('BETTER_AUTH_SECRET must contain at least 32 bytes')
}

function readOrigin(value: string, variable: string): string {
  let origin: URL

  try {
    origin = new URL(value.trim())
  } catch {
    throw new Error(`${variable} must contain a valid absolute origin`)
  }

  if (
    (origin.protocol !== 'https:' && origin.protocol !== 'http:') ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    origin.hostname.includes('*')
  ) {
    throw new Error(`${variable} must contain an exact HTTP or HTTPS origin without credentials, paths, or wildcards`)
  }

  if (isProduction && origin.protocol !== 'https:') {
    throw new Error(`${variable} must use HTTPS in production`)
  }

  if (
    isProduction &&
    (origin.hostname === 'localhost' ||
      origin.hostname.endsWith('.localhost') ||
      origin.hostname.startsWith('127.') ||
      origin.hostname === '[::1]')
  ) {
    throw new Error(`${variable} cannot trust localhost in production`)
  }

  return origin.origin
}

function readPositiveInteger(variable: string, fallback: number): number {
  const configured = process.env[variable]?.trim()
  if (!configured) return fallback

  if (!/^\d+$/.test(configured)) {
    throw new Error(`${variable} must be a positive integer`)
  }

  const value = Number(configured)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${variable} must be a positive integer`)
  }

  return value
}

function readBoolean(variable: string, fallback = false): boolean {
  const configured = process.env[variable]?.trim()
  if (!configured) return fallback
  if (configured !== 'true' && configured !== 'false') {
    throw new Error(`${variable} must be true or false`)
  }
  return configured === 'true'
}

const configuredBaseURL = process.env.BETTER_AUTH_URL?.trim() || process.env.APP_URL?.trim()
if (isProduction && !configuredBaseURL) {
  throw new Error('BETTER_AUTH_URL or APP_URL must specify an explicit HTTPS origin in production')
}

const baseURL = readOrigin(
  configuredBaseURL || `http://localhost:${process.env.PORT ?? '8788'}`,
  process.env.BETTER_AUTH_URL?.trim() ? 'BETTER_AUTH_URL' : configuredBaseURL ? 'APP_URL' : 'PORT',
)

const configuredOrigins = [
  ...(['FRONTEND_URL', 'APP_URL'] as const).map((variable) => ({
    variable,
    value: process.env[variable],
  })),
  ...(['TRUSTED_ORIGINS', 'BETTER_AUTH_TRUSTED_ORIGINS'] as const).flatMap((variable) =>
    (process.env[variable]?.split(',') ?? []).map((value) => ({ variable, value })),
  ),
].flatMap(({ value, variable }) =>
  typeof value === 'string' && value.trim() !== '' ? [readOrigin(value, variable)] : [],
)

const trustedOrigins = Array.from(
  new Set([
    new URL(baseURL).origin,
    ...configuredOrigins,
    ...(isProduction
      ? []
      : [
          'http://localhost:4321',
          'http://127.0.0.1:4321',
          'http://localhost:5173',
          'http://127.0.0.1:5173',
          'http://localhost:8787',
          'http://127.0.0.1:8787',
        ]),
  ]),
)

const minPasswordLength = readPositiveInteger('AUTH_PASSWORD_MIN_LENGTH', 12)
const maxPasswordLength = readPositiveInteger('AUTH_PASSWORD_MAX_LENGTH', 128)
if (minPasswordLength < 12 || maxPasswordLength > 128 || minPasswordLength > maxPasswordLength) {
  throw new Error('Auth password lengths must satisfy 12 <= minimum <= maximum <= 128')
}

const sessionExpiresIn = readPositiveInteger('AUTH_SESSION_EXPIRES_IN_SECONDS', 60 * 60 * 24 * 7)
const sessionUpdateAge = readPositiveInteger('AUTH_SESSION_UPDATE_AGE_SECONDS', 60 * 60 * 24)
const sessionFreshAge = readPositiveInteger('AUTH_SESSION_FRESH_AGE_SECONDS', 60 * 60)
if (sessionUpdateAge >= sessionExpiresIn || sessionFreshAge > sessionExpiresIn) {
  throw new Error('Auth session update and fresh ages must fit within the session lifetime')
}

const secureCookies = isProduction || baseURL.startsWith('https://')

export const auth = betterAuth({
  database: sqlite,
  baseURL,
  secret,
  trustedOrigins,
  emailAndPassword: {
    enabled: true,
    minPasswordLength,
    maxPasswordLength,
    requireEmailVerification: readBoolean('AUTH_REQUIRE_EMAIL_VERIFICATION'),
    autoSignIn: !readBoolean('AUTH_DISABLE_AUTO_SIGN_IN'),
    resetPasswordTokenExpiresIn: 60 * 30,
    revokeSessionsOnPasswordReset: true,
  },
  session: {
    expiresIn: sessionExpiresIn,
    updateAge: sessionUpdateAge,
    freshAge: sessionFreshAge,
    cookieCache: { enabled: false },
  },
  advanced: {
    useSecureCookies: secureCookies,
    trustedProxyHeaders: readBoolean('AUTH_TRUST_PROXY_HEADERS'),
    disableOriginCheck: false,
    disableCSRFCheck: false,
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookies,
      path: '/',
    },
  },
  hooks: {
    before: createAuthMiddleware(async (context) => {
      const request = context.request
      if (!request || request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') {
        return
      }

      const origin = request.headers.get('origin') || request.headers.get('referer')
      if (origin && !context.context.isTrustedOrigin(origin, { allowRelativePaths: false })) {
        throw new APIError('FORBIDDEN', { message: 'Invalid origin', code: 'INVALID_ORIGIN' })
      }
    }),
  },
  rateLimit: {
    enabled: isProduction || readBoolean('AUTH_RATE_LIMIT_ENABLED'),
    window: 60,
    max: 100,
    storage: 'memory',
    customRules: {
      '/sign-in/email': { window: 60, max: 5 },
      '/sign-up/email': { window: 60, max: 5 },
      '/sign-in/social': { window: 60, max: 10 },
      '/link-social': { window: 300, max: 10 },
      '/request-password-reset': { window: 300, max: 3 },
      '/forget-password': { window: 300, max: 3 },
    },
  },
  socialProviders: configuredSocialProviders,
  plugins: configuredAuthPlugins,
  account: {
    encryptOAuthTokens: true,
    accountLinking: {
      enabled: true,
      disableImplicitLinking: !readBoolean('AUTH_ALLOW_IMPLICIT_ACCOUNT_LINKING'),
      requireLocalEmailVerified: true,
      allowDifferentEmails: true,
    },
  },
  databaseHooks: {
    account: {
      create: { after: provisionGoogleMailbox },
      update: { after: provisionGoogleMailbox },
    },
  },
})

export async function initAuth(): Promise<void> {
  const { runMigrations } = await getMigrations(auth.options)
  await runMigrations()
}
