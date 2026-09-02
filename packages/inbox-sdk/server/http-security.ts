import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Context, MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'

/**
 * OpenMail HTTP application security.
 *
 * This module owns the browser-facing hardening for the API/static server:
 *
 * - A hash-based Content-Security-Policy that only permits same-origin
 *   scripts plus the exact SHA-256 hash of the inline appearance bootstrap
 *   script shipped in `dist/index.html` (never `unsafe-inline` for scripts).
 * - A trusted-origin (CSRF) guard for cookie-authenticated mutation routes.
 * - Bounded in-memory owner/IP rate limits with distinct auth, mutation,
 *   send, and upload budgets.
 * - Request body size limits for JSON and multipart uploads.
 *
 * Everything is configured through `resolveHttpSecurityConfig`, driven by
 * environment variables that are documented in docs/HTTP_SECURITY.md.
 */

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export interface RateBudget {
  /** Maximum requests inside one window. Zero or negative disables the budget. */
  max: number
  /** Fixed window length in milliseconds. */
  windowMs: number
}

export type RateBucket = 'auth' | 'mutation' | 'send' | 'upload'

export interface HttpSecurityConfig {
  production: boolean
  /** Exact origins that may issue cookie-authenticated mutations. */
  trustedOrigins: ReadonlySet<string>
  /** Outside production, any localhost/127.0.0.1/[::1] origin is accepted. */
  allowLoopbackOrigins: boolean
  /** Strict marker: cookie-carrying mutations must present a trusted Origin. */
  requireOriginForCookies: boolean
  /** Only honor X-Forwarded-For / X-Real-IP when explicitly enabled. */
  trustProxy: boolean
  rateLimitsEnabled: boolean
  budgets: Record<RateBucket, RateBudget>
  /** Upper bound of tracked rate-limit keys kept in memory. */
  maxTrackedKeys: number
  jsonBodyLimitBytes: number
  multipartBodyLimitBytes: number
  /** CSP source tokens, e.g. 'sha256-…', for allowed inline scripts. */
  scriptHashes: readonly string[]
  /** Emit upgrade-insecure-requests (production behind HTTPS only). */
  upgradeInsecureRequests: boolean
}

export interface HttpSecurityEnv {
  server?: {
    requestIP?: (request: Request) => { address?: string } | null
  }
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback
}

function parseOrigin(value: string | undefined | null): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  try {
    return new URL(value.trim()).origin
  } catch {
    return null
  }
}

/**
 * Derives the set of trusted browser origins from the same configuration the
 * authentication layer uses: BETTER_AUTH_URL, APP_URL, FRONTEND_URL, and the
 * TRUSTED_ORIGINS comma list. Invalid entries are ignored instead of throwing
 * so a bad optional origin can never take the server down.
 */
export function resolveTrustedOrigins(env: Record<string, string | undefined> = process.env): Set<string> {
  const production = env.NODE_ENV === 'production'
  const baseUrl = env.BETTER_AUTH_URL ?? env.APP_URL ?? `http://localhost:${env.PORT ?? '8788'}`
  const candidates = [
    baseUrl,
    env.APP_URL,
    env.FRONTEND_URL,
    ...(env.TRUSTED_ORIGINS?.split(',') ?? []),
    ...(production
      ? []
      : [
          'http://localhost:4321',
          'http://127.0.0.1:4321',
          'http://localhost:5173',
          'http://127.0.0.1:5173',
          'http://localhost:8787',
          'http://127.0.0.1:8787',
        ]),
  ]

  const origins = new Set<string>()
  for (const candidate of candidates) {
    const origin = parseOrigin(candidate)
    if (origin) origins.add(origin)
  }

  return origins
}

/**
 * Extracts every inline (src-less) script body from the given HTML documents
 * and returns unique CSP 'sha256-…' source tokens for them. The built
 * `dist/index.html` is read first so the served bootstrap script is always
 * covered; the source `index.html` keeps parity for fresh checkouts.
 */
export function readInlineScriptHashes(
  projectRoot: string,
  files: readonly string[] = ['dist/index.html', 'index.html'],
): string[] {
  const hashes = new Set<string>()

  for (const file of files) {
    let html: string
    try {
      html = readFileSync(resolve(projectRoot, file), 'utf8')
    } catch {
      continue
    }

    for (const match of html.matchAll(/<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)) {
      const body = match[1]
      if (!body || body.trim() === '') continue
      hashes.add(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`)
    }
  }

  return Array.from(hashes)
}

export function resolveHttpSecurityConfig(
  env: Record<string, string | undefined> = process.env,
  options: { projectRoot?: string } = {},
): HttpSecurityConfig {
  const production = env.NODE_ENV === 'production'
  const projectRoot = options.projectRoot ?? resolve(import.meta.dir, '..')
  const baseOrigin = parseOrigin(env.BETTER_AUTH_URL ?? env.APP_URL ?? undefined)

  return {
    production,
    trustedOrigins: resolveTrustedOrigins(env),
    allowLoopbackOrigins: !production,
    requireOriginForCookies: parseBoolean(env.CSRF_REQUIRE_ORIGIN, false),
    trustProxy: parseBoolean(env.TRUST_PROXY, false),
    // Rate limits protect production by default. Development, tests, and the
    // synthetic browser audits opt in explicitly with RATE_LIMIT_ENABLED=true.
    rateLimitsEnabled: parseBoolean(env.RATE_LIMIT_ENABLED, production),
    budgets: {
      auth: {
        max: parsePositiveInt(env.RATE_LIMIT_AUTH_MAX, 30),
        windowMs: parsePositiveInt(env.RATE_LIMIT_AUTH_WINDOW_MS, 600_000),
      },
      mutation: {
        max: parsePositiveInt(env.RATE_LIMIT_MUTATION_MAX, 600),
        windowMs: parsePositiveInt(env.RATE_LIMIT_MUTATION_WINDOW_MS, 60_000),
      },
      send: {
        max: parsePositiveInt(env.RATE_LIMIT_SEND_MAX, 60),
        windowMs: parsePositiveInt(env.RATE_LIMIT_SEND_WINDOW_MS, 3_600_000),
      },
      upload: {
        max: parsePositiveInt(env.RATE_LIMIT_UPLOAD_MAX, 30),
        windowMs: parsePositiveInt(env.RATE_LIMIT_UPLOAD_WINDOW_MS, 600_000),
      },
    },
    maxTrackedKeys: parsePositiveInt(env.RATE_LIMIT_MAX_KEYS, 10_000),
    jsonBodyLimitBytes: parsePositiveInt(env.HTTP_JSON_BODY_LIMIT_BYTES, 2 * 1024 * 1024),
    // 25 MiB of attachments plus a small allowance for multipart framing so a
    // legitimate maximum upload never fails at the transport layer first.
    multipartBodyLimitBytes: parsePositiveInt(
      env.HTTP_MULTIPART_BODY_LIMIT_BYTES,
      25 * 1024 * 1024 + 256 * 1024,
    ),
    scriptHashes: readInlineScriptHashes(projectRoot),
    upgradeInsecureRequests:
      production && (env.BETTER_AUTH_URL ?? env.APP_URL ?? '').startsWith('https://'),
  }
}

/* ------------------------------------------------------------------------ *
 * Content-Security-Policy
 * ------------------------------------------------------------------------ */

export function buildContentSecurityPolicy(config: HttpSecurityConfig): string {
  const scriptSources = ["'self'", ...config.scriptHashes]
  const directives = [
    "default-src 'self'",
    `script-src ${scriptSources.join(' ')}`,
    // Sanitized email presentation and React both rely on inline style
    // attributes; scripts stay hash-locked so this does not weaken XSS
    // protection for executable content.
    "style-src 'self' 'unsafe-inline'",
    // Sanitized remote email images may point at http(s) hosts and safe
    // data: URIs; cid: references are rewritten to same-origin attachment
    // URLs before rendering.
    "img-src 'self' data: http: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "worker-src 'self'",
    "manifest-src 'self'",
  ]

  if (config.upgradeInsecureRequests) directives.push('upgrade-insecure-requests')

  return directives.join('; ')
}

/**
 * Applies the application CSP to every response that does not already carry
 * its own policy. Routes with stricter response-specific policies (for
 * example the sandboxed brand icon proxy) keep theirs untouched.
 */
export function contentSecurityPolicy(config: HttpSecurityConfig): MiddlewareHandler {
  const policy = buildContentSecurityPolicy(config)

  return async (c, next) => {
    await next()
    if (!c.res.headers.has('Content-Security-Policy')) {
      c.res.headers.set('Content-Security-Policy', policy)
    }
  }
}

/* ------------------------------------------------------------------------ *
 * Trusted-origin / CSRF guard
 * ------------------------------------------------------------------------ */

export function isTrustedOrigin(origin: string, config: HttpSecurityConfig): boolean {
  const normalized = parseOrigin(origin)
  if (!normalized) return false
  if (config.trustedOrigins.has(normalized)) return true
  if (!config.allowLoopbackOrigins) return false

  try {
    return LOOPBACK_HOSTS.has(new URL(normalized).hostname)
  } catch {
    return false
  }
}

/**
 * Rejects cross-origin browser mutations before any handler runs.
 *
 * - A present Origin header must match a trusted origin exactly (or a
 *   loopback origin outside production). `Origin: null` never matches.
 * - Without an Origin header, `Sec-Fetch-Site: cross-site` is rejected.
 * - Requests with neither header (server-to-server clients, tests, curl)
 *   pass unless CSRF_REQUIRE_ORIGIN demands an Origin for requests that
 *   carry cookies.
 *
 * Safe methods (GET/HEAD/OPTIONS) are never blocked, so OAuth redirect
 * callbacks arriving cross-site keep working.
 */
export function trustedOriginGuard(config: HttpSecurityConfig): MiddlewareHandler {
  return async (c, next) => {
    if (!MUTATION_METHODS.has(c.req.method)) return next()

    const reject = () => c.json({ error: 'Cross-origin request rejected' }, 403)
    const origin = c.req.header('origin')

    if (origin !== undefined) {
      return isTrustedOrigin(origin, config) ? next() : reject()
    }

    const fetchSite = c.req.header('sec-fetch-site')?.trim().toLowerCase()
    if (fetchSite === 'cross-site') return reject()
    if (fetchSite) return next()

    if (config.requireOriginForCookies && c.req.header('cookie')) return reject()
    return next()
  }
}

/* ------------------------------------------------------------------------ *
 * Rate limiting
 * ------------------------------------------------------------------------ */

interface RateWindow {
  count: number
  resetAt: number
}

export interface RateDecision {
  allowed: boolean
  retryAfterSeconds: number
}

/**
 * Fixed-window in-memory limiter with a hard upper bound on tracked keys.
 * Expired windows are swept opportunistically; when the bound is still
 * exceeded the oldest entries are evicted, so memory can never grow without
 * limit even under key-churn attacks.
 */
export class MemoryRateLimiter {
  private readonly windows = new Map<string, RateWindow>()

  constructor(private readonly maxTrackedKeys = 10_000) {}

  get size(): number {
    return this.windows.size
  }

  hit(key: string, budget: RateBudget, now = Date.now()): RateDecision {
    if (budget.max <= 0 || budget.windowMs <= 0) {
      return { allowed: true, retryAfterSeconds: 0 }
    }

    let window = this.windows.get(key)
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + budget.windowMs }
    } else {
      this.windows.delete(key)
    }

    window.count += 1
    this.windows.set(key, window)

    if (this.windows.size > this.maxTrackedKeys) this.prune(now)

    if (window.count > budget.max) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000)),
      }
    }

    return { allowed: true, retryAfterSeconds: 0 }
  }

  prune(now = Date.now()): void {
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key)
    }

    while (this.windows.size > this.maxTrackedKeys) {
      const oldest = this.windows.keys().next()
      if (oldest.done) break
      this.windows.delete(oldest.value)
    }
  }

  clear(): void {
    this.windows.clear()
  }
}

/**
 * Resolves the client address for rate limiting. Forwarding headers are
 * honored only when TRUST_PROXY is explicitly enabled; the right-most
 * X-Forwarded-For entry is used because it is the only hop appended by the
 * operator's own proxy. Otherwise the socket address reported by Bun.serve
 * is used, and 'local' when no socket exists (in-process tests).
 */
export function clientAddress(c: Context, config: HttpSecurityConfig): string {
  if (config.trustProxy) {
    const forwarded = c.req.header('x-forwarded-for')
    const lastHop = forwarded?.split(',').at(-1)?.trim()
    if (lastHop) return lastHop.replace(/^\[|\]$/g, '').toLowerCase()

    const realIp = c.req.header('x-real-ip')?.trim()
    if (realIp) return realIp.replace(/^\[|\]$/g, '').toLowerCase()
  }

  const env = c.env as HttpSecurityEnv | undefined
  const address = env?.server?.requestIP?.(c.req.raw)?.address
  return address ? address.toLowerCase() : 'local'
}

const SESSION_COOKIE = /(?:^|;\s*)(?:__Secure-|__Host-)?better-auth\.session_token=([^;]+)/i

/**
 * Rate-limit keys prefer the session owner (a one-way hash of the session
 * token, never the raw token) so one abusive account cannot consume another
 * account's budget behind a shared NAT. Requests without a session cookie
 * fall back to the client address. Authentication attempts are always keyed
 * by address because they happen before any identity exists.
 */
export function rateLimitKey(c: Context, bucket: RateBucket, config: HttpSecurityConfig): string {
  if (bucket !== 'auth') {
    const token = c.req.header('cookie')?.match(SESSION_COOKIE)?.[1]
    if (token) {
      const owner = createHash('sha256').update(token).digest('base64url').slice(0, 24)
      return `${bucket}:owner:${owner}`
    }
  }

  return `${bucket}:ip:${clientAddress(c, config)}`
}

export function classifyRequest(method: string, path: string, contentType: string): RateBucket | null {
  if (!MUTATION_METHODS.has(method)) return null
  if (path === '/api/auth' || path.startsWith('/api/auth/')) return 'auth'
  if (/multipart\/form-data/i.test(contentType)) return 'upload'
  if (path === '/api/send') return 'send'
  return 'mutation'
}

export function rateLimitGuard(
  config: HttpSecurityConfig,
  limiter: MemoryRateLimiter = new MemoryRateLimiter(config.maxTrackedKeys),
): MiddlewareHandler {
  return async (c, next) => {
    if (!config.rateLimitsEnabled) return next()

    const bucket = classifyRequest(c.req.method, c.req.path, c.req.header('content-type') ?? '')
    if (!bucket) return next()

    const decision = limiter.hit(rateLimitKey(c, bucket, config), config.budgets[bucket])
    if (decision.allowed) return next()

    c.header('Retry-After', String(decision.retryAfterSeconds))
    return c.json({ error: 'Too many requests' }, 429)
  }
}

/* ------------------------------------------------------------------------ *
 * Request body size limits
 * ------------------------------------------------------------------------ */

/**
 * Enforces transport-level body limits before any handler parses a request:
 * a JSON/general budget and a larger multipart budget sized for the 25 MiB
 * attachment contract. Oversized requests receive a constant 413 without
 * echoing request contents.
 */
export function requestBodyLimits(config: HttpSecurityConfig): MiddlewareHandler {
  const payloadTooLarge = (c: Context) => c.json({ error: 'Request body is too large' }, 413)
  const jsonLimit = bodyLimit({ maxSize: config.jsonBodyLimitBytes, onError: payloadTooLarge })
  const multipartLimit = bodyLimit({
    maxSize: config.multipartBodyLimitBytes,
    onError: payloadTooLarge,
  })

  return (c, next) => {
    if (!MUTATION_METHODS.has(c.req.method)) return next()

    const contentType = c.req.header('content-type') ?? ''
    return /multipart\/form-data/i.test(contentType)
      ? multipartLimit(c, next)
      : jsonLimit(c, next)
  }
}

/* ------------------------------------------------------------------------ *
 * Composition
 * ------------------------------------------------------------------------ */

/**
 * The middlewares in application order. Rate limiting runs first so floods
 * are bounded before any other work; the origin guard rejects cross-origin
 * mutations before their bodies are read; body limits protect every parser
 * behind them. The CSP wrapper runs outermost so it can respect stricter
 * response-specific policies set by inner routes.
 */
export function httpSecurityMiddlewares(
  config: HttpSecurityConfig,
  limiter?: MemoryRateLimiter,
): MiddlewareHandler[] {
  return [
    contentSecurityPolicy(config),
    rateLimitGuard(config, limiter ?? new MemoryRateLimiter(config.maxTrackedKeys)),
    trustedOriginGuard(config),
    requestBodyLimits(config),
  ]
}
