import type { Database } from 'bun:sqlite'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Hono, type MiddlewareHandler } from 'hono'
import { routePath } from 'hono/route'
import { sqlite } from './db'

const DEFAULT_LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
const MAX_HTTP_SERIES = 256
const KNOWN_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
const KNOWN_ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'TimeoutError', 'AbortError'])
const KNOWN_ERROR_CODES = new Set([
  'EACCES', 'ECONNREFUSED', 'ECONNRESET', 'ENOSPC', 'ENOENT', 'EROFS', 'ETIMEDOUT',
  'SQLITE_BUSY', 'SQLITE_CANTOPEN', 'SQLITE_CORRUPT', 'SQLITE_FULL', 'SQLITE_IOERR', 'SQLITE_READONLY',
])

type CheckStatus = 'ok' | 'error' | 'starting' | 'not_monitored' | 'not_applicable'

interface JobCounts {
  pending: number
  processing: number
  failed: number
  stale: number
}

interface AccountCounts {
  monitored: number
  errors: number
  stale: number
  statuses: Record<string, number>
}

interface HttpSeries {
  method: string
  route: string
  statusGroup: string
  count: number
  sum: number
  buckets: number[]
}

export interface OperationalLogEvent {
  event: 'operational_check_failed'
  check: 'database' | 'disk' | 'jobs' | 'synchronization'
  error: { type: string; code: string }
}

export interface ObservabilityOptions {
  database?: Database
  metricsToken?: string
  jobStaleMs?: number
  syncStaleMs?: number
  schedulerStaleMs?: number
  startupGraceMs?: number
  schedulerExpected?: boolean
  latencyBuckets?: readonly number[]
  now?: () => number
  elapsed?: () => number
  checkDisk?: () => boolean
  log?: (event: OperationalLogEvent) => void
}

export interface OperationalSnapshot {
  jobs: JobCounts
  synchronization: AccountCounts
  scheduler: { monitored: boolean; lagSeconds: number }
  http: Array<{
    method: string
    route: string
    statusGroup: string
    count: number
    sumSeconds: number
    buckets: Array<{ le: string; count: number }>
  }>
}

function configuredMilliseconds(value: number | string | undefined, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function safeError(error: unknown): { type: string; code: string } {
  const type = error instanceof Error && KNOWN_ERROR_NAMES.has(error.name) ? error.name : 'Error'
  const rawCode = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  const code = typeof rawCode === 'string' && KNOWN_ERROR_CODES.has(rawCode) ? rawCode : 'UNKNOWN'
  return { type, code }
}

export function redactOperationalError(error: unknown): { type: string; code: string } {
  return safeError(error)
}

export function normalizeRouteLabel(pattern: string): string {
  if (!pattern || pattern === '*' || pattern === '/*' || !pattern.startsWith('/')) return '/unmatched'

  const segments = pattern.split('/').filter(Boolean)
  if (segments.length > 10) return '/unmatched'

  return `/${segments.map((segment) => {
    if (segment.startsWith(':')) return ':param'
    if (segment === '*') return ':rest'
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(segment)) return ':param'
    return segment
  }).join('/')}`
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')
}

function labels(entries: Record<string, string>): string {
  return `{${Object.entries(entries).map(([name, value]) => `${name}="${escapeLabel(value)}"`).join(',')}}`
}

function verifyToken(expected: string, received: string): boolean {
  const expectedHash = createHash('sha256').update(expected).digest()
  const receivedHash = createHash('sha256').update(received).digest()
  return timingSafeEqual(expectedHash, receivedHash)
}

export function createObservability(options: ObservabilityOptions = {}) {
  const database = options.database ?? sqlite
  const token = options.metricsToken ?? process.env.METRICS_TOKEN ?? ''
  const jobStaleMs = configuredMilliseconds(options.jobStaleMs ?? process.env.OBSERVABILITY_JOB_STALE_MS, 300_000)
  const syncStaleMs = configuredMilliseconds(options.syncStaleMs ?? process.env.OBSERVABILITY_SYNC_STALE_MS, 300_000)
  const schedulerStaleMs = configuredMilliseconds(
    options.schedulerStaleMs ?? process.env.OBSERVABILITY_SCHEDULER_STALE_MS,
    30_000,
  )
  const startupGraceMs = configuredMilliseconds(
    options.startupGraceMs ?? process.env.OBSERVABILITY_STARTUP_GRACE_MS,
    60_000,
  )
  const now = options.now ?? Date.now
  const elapsed = options.elapsed ?? (() => performance.now())
  const startedAt = now()
  const boundaries = [...new Set((options.latencyBuckets ?? DEFAULT_LATENCY_BUCKETS)
    .filter((bucket) => Number.isFinite(bucket) && bucket > 0))]
    .sort((left, right) => left - right)
  boundaries.push(Number.POSITIVE_INFINITY)
  const requests = new Map<string, HttpSeries>()
  let lastSchedulerHeartbeat: number | null = null
  let schedulerExpected = options.schedulerExpected ?? false

  function report(check: OperationalLogEvent['check'], error: unknown): void {
    options.log?.({ event: 'operational_check_failed', check, error: safeError(error) })
  }

  function queryJobs(timestamp: number): JobCounts {
    const cutoff = new Date(timestamp - jobStaleMs).toISOString()
    return database.query<JobCounts, [string]>(`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
        COALESCE(SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END), 0) AS processing,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
        COALESCE(SUM(CASE
          WHEN status = 'processing' AND updated_at < ?1 THEN 1
          WHEN status = 'pending' AND COALESCE(next_attempt_at, created_at) < ?1 THEN 1
          ELSE 0
        END), 0) AS stale
      FROM mutation_jobs
    `).get(cutoff) ?? { pending: 0, processing: 0, failed: 0, stale: 0 }
  }

  function queryAccounts(timestamp: number): AccountCounts {
    const cutoff = new Date(timestamp - syncStaleMs).toISOString()
    const counts = database.query<Omit<AccountCounts, 'statuses'>, [string]>(`
      SELECT
        COALESCE(SUM(CASE
          WHEN provider <> 'mock' AND credentials_encrypted IS NOT NULL THEN 1
          ELSE 0
        END), 0) AS monitored,
        COALESCE(SUM(CASE WHEN sync_status = 'error' THEN 1 ELSE 0 END), 0) AS errors,
        COALESCE(SUM(CASE
          WHEN provider <> 'mock'
            AND credentials_encrypted IS NOT NULL
            AND sync_status IN ('connected', 'syncing')
            AND COALESCE(last_sync_at, created_at) < ?
          THEN 1 ELSE 0
        END), 0) AS stale
      FROM mail_accounts
    `).get(cutoff) ?? { monitored: 0, errors: 0, stale: 0 }

    const statuses = database.query<{ status: string; count: number }, []>(`
      SELECT
        CASE
          WHEN sync_status IN ('idle', 'connected', 'syncing', 'error', 'disconnected')
          THEN sync_status ELSE 'other'
        END AS status,
        COUNT(*) AS count
      FROM mail_accounts
      GROUP BY 1
    `).all()

    return { ...counts, statuses: Object.fromEntries(statuses.map(({ status, count }) => [status, count])) }
  }

  function scheduler(timestamp: number): { status: CheckStatus; monitored: boolean; lagSeconds: number } {
    if (lastSchedulerHeartbeat === null) {
      if (!schedulerExpected) return { status: 'not_monitored', monitored: false, lagSeconds: 0 }
      const age = Math.max(0, timestamp - startedAt)
      return {
        status: age <= startupGraceMs ? 'starting' : 'error',
        monitored: true,
        lagSeconds: age / 1_000,
      }
    }

    const age = Math.max(0, timestamp - lastSchedulerHeartbeat)
    return { status: age <= schedulerStaleMs ? 'ok' : 'error', monitored: true, lagSeconds: age / 1_000 }
  }

  function checkDisk(): CheckStatus {
    if (options.checkDisk) return options.checkDisk() ? 'ok' : 'error'
    if (database.filename === ':memory:' || database.filename === '') return 'not_applicable'

    const probe = join(dirname(resolve(database.filename)), `.openmail-health-${randomUUID()}`)
    try {
      writeFileSync(probe, '1', { flag: 'wx', mode: 0o600 })
      unlinkSync(probe)
      return 'ok'
    } catch (error) {
      try {
        unlinkSync(probe)
      } catch {
        // The probe may never have been created.
      }
      report('disk', error)
      return 'error'
    }
  }

  function recordHttp(method: string, pattern: string, status: number, durationSeconds: number): void {
    const safeMethod = KNOWN_METHODS.has(method) ? method : 'OTHER'
    const route = normalizeRouteLabel(pattern)
    const statusGroup = status >= 100 && status <= 599 ? `${Math.floor(status / 100)}xx` : 'unknown'
    let key = JSON.stringify([safeMethod, route, statusGroup])
    let entry = requests.get(key)

    if (!entry && requests.size >= MAX_HTTP_SERIES) {
      key = JSON.stringify(['OTHER', '/overflow', 'unknown'])
      entry = requests.get(key)
      if (!entry && requests.size >= MAX_HTTP_SERIES) {
        const oldest = requests.keys().next().value
        if (oldest !== undefined) requests.delete(oldest)
      }
    }

    if (!entry) {
      const [entryMethod, entryRoute, entryStatus] = JSON.parse(key) as [string, string, string]
      entry = {
        method: entryMethod,
        route: entryRoute,
        statusGroup: entryStatus,
        count: 0,
        sum: 0,
        buckets: boundaries.map(() => 0),
      }
      requests.set(key, entry)
    }

    entry.count += 1
    entry.sum += durationSeconds
    for (let index = 0; index < boundaries.length; index += 1) {
      if (durationSeconds <= boundaries[index]) entry.buckets[index] += 1
    }
  }

  const middleware: MiddlewareHandler = async (context, next) => {
    const started = elapsed()
    let failed = false

    try {
      await next()
    } catch (error) {
      failed = true
      throw error
    } finally {
      const status = failed ? 500 : context.res.status
      const duration = Math.max(0, elapsed() - started) / 1_000
      recordHttp(context.req.method, routePath(context), status, duration)
    }
  }

  function snapshot(): OperationalSnapshot {
    const timestamp = now()
    const heartbeat = scheduler(timestamp)
    return {
      jobs: queryJobs(timestamp),
      synchronization: queryAccounts(timestamp),
      scheduler: { monitored: heartbeat.monitored, lagSeconds: heartbeat.lagSeconds },
      http: [...requests.values()].map((entry) => ({
        method: entry.method,
        route: entry.route,
        statusGroup: entry.statusGroup,
        count: entry.count,
        sumSeconds: entry.sum,
        buckets: boundaries.map((boundary, index) => ({
          le: Number.isFinite(boundary) ? String(boundary) : '+Inf',
          count: entry.buckets[index],
        })),
      })),
    }
  }

  function prometheus(): string {
    const current = snapshot()
    const lines = [
      '# HELP openmail_http_requests_total Total HTTP requests grouped by bounded route and status.',
      '# TYPE openmail_http_requests_total counter',
    ]

    for (const entry of current.http) {
      const dimensions = { method: entry.method, route: entry.route, status_group: entry.statusGroup }
      lines.push(`openmail_http_requests_total${labels(dimensions)} ${entry.count}`)
    }

    lines.push(
      '# HELP openmail_http_request_duration_seconds HTTP request latency in seconds.',
      '# TYPE openmail_http_request_duration_seconds histogram',
    )

    for (const entry of current.http) {
      const dimensions = { method: entry.method, route: entry.route, status_group: entry.statusGroup }
      for (const bucket of entry.buckets) {
        lines.push(`openmail_http_request_duration_seconds_bucket${labels({ ...dimensions, le: bucket.le })} ${bucket.count}`)
      }
      lines.push(`openmail_http_request_duration_seconds_sum${labels(dimensions)} ${entry.sumSeconds}`)
      lines.push(`openmail_http_request_duration_seconds_count${labels(dimensions)} ${entry.count}`)
    }

    lines.push(
      '# HELP openmail_mutation_jobs Current durable mutation jobs by bounded status.',
      '# TYPE openmail_mutation_jobs gauge',
      `openmail_mutation_jobs${labels({ status: 'pending' })} ${current.jobs.pending}`,
      `openmail_mutation_jobs${labels({ status: 'processing' })} ${current.jobs.processing}`,
      `openmail_mutation_jobs${labels({ status: 'failed' })} ${current.jobs.failed}`,
      '# HELP openmail_mutation_queue_depth Pending and processing mutation jobs.',
      '# TYPE openmail_mutation_queue_depth gauge',
      `openmail_mutation_queue_depth ${current.jobs.pending + current.jobs.processing}`,
      '# HELP openmail_mutation_jobs_stale Mutation jobs older than the configured stale threshold.',
      '# TYPE openmail_mutation_jobs_stale gauge',
      `openmail_mutation_jobs_stale ${current.jobs.stale}`,
      '# HELP openmail_accounts_sync_status Account count by bounded normalized synchronization status.',
      '# TYPE openmail_accounts_sync_status gauge',
    )

    for (const [status, count] of Object.entries(current.synchronization.statuses)) {
      lines.push(`openmail_accounts_sync_status${labels({ status })} ${count}`)
    }

    lines.push(
      '# HELP openmail_accounts_sync_errors Accounts currently reporting synchronization errors.',
      '# TYPE openmail_accounts_sync_errors gauge',
      `openmail_accounts_sync_errors ${current.synchronization.errors}`,
      '# HELP openmail_accounts_sync_stale Eligible provider accounts past the synchronization threshold.',
      '# TYPE openmail_accounts_sync_stale gauge',
      `openmail_accounts_sync_stale ${current.synchronization.stale}`,
      '# HELP openmail_scheduler_lag_seconds Seconds since the latest scheduler heartbeat.',
      '# TYPE openmail_scheduler_lag_seconds gauge',
      `openmail_scheduler_lag_seconds ${current.scheduler.lagSeconds}`,
      '# HELP openmail_scheduler_heartbeat_observed Whether scheduler heartbeat monitoring is armed.',
      '# TYPE openmail_scheduler_heartbeat_observed gauge',
      `openmail_scheduler_heartbeat_observed ${Number(current.scheduler.monitored)}`,
    )

    return `${lines.join('\n')}\n`
  }

  const router = new Hono()

  router.use('*', async (context, next) => {
    await next()
    context.header('cache-control', 'no-store')
  })

  router.get('/health/live', (context) => context.json({ status: 'ok' }))

  router.get('/health/ready', (context) => {
    const timestamp = now()
    const checks: {
      database: { status: CheckStatus }
      disk: { status: CheckStatus }
      scheduler: { status: CheckStatus; lagSeconds: number }
      jobs: { status: CheckStatus } & JobCounts
      synchronization: { status: CheckStatus; monitored: number; errors: number; stale: number }
    } = {
      database: { status: 'ok' },
      disk: { status: 'ok' },
      scheduler: { status: 'ok', lagSeconds: 0 },
      jobs: { status: 'ok', pending: 0, processing: 0, failed: 0, stale: 0 },
      synchronization: { status: 'ok', monitored: 0, errors: 0, stale: 0 },
    }

    try {
      const result = database.query<{ ok: number }, []>('SELECT 1 AS ok').get()
      if (result?.ok !== 1) checks.database.status = 'error'
    } catch (error) {
      checks.database.status = 'error'
      report('database', error)
    }

    try {
      checks.disk.status = checkDisk()
    } catch (error) {
      checks.disk.status = 'error'
      report('disk', error)
    }

    const heartbeat = scheduler(timestamp)
    checks.scheduler = { status: heartbeat.status, lagSeconds: heartbeat.lagSeconds }

    if (checks.database.status === 'ok') {
      try {
        const jobs = queryJobs(timestamp)
        checks.jobs = { ...jobs, status: jobs.failed > 0 || jobs.stale > 0 ? 'error' : 'ok' }
      } catch (error) {
        checks.jobs.status = 'error'
        report('jobs', error)
      }

      try {
        const accounts = queryAccounts(timestamp)
        const starting = accounts.stale > 0 && timestamp - startedAt < startupGraceMs
        checks.synchronization = {
          monitored: accounts.monitored,
          errors: accounts.errors,
          stale: accounts.stale,
          status: accounts.errors > 0 ? 'error' : starting ? 'starting' : accounts.stale > 0 ? 'error' : 'ok',
        }
      } catch (error) {
        checks.synchronization.status = 'error'
        report('synchronization', error)
      }
    }

    const healthy = Object.values(checks).every((check) => check.status !== 'error')
    return context.json({ status: healthy ? 'ok' : 'error', checks }, healthy ? 200 : 503)
  })

  router.get('/metrics', (context) => {
    if (!token) return context.json({ error: 'Not found' }, 404)

    const authorization = context.req.header('authorization')
    const bearer = authorization?.match(/^Bearer[ \t]+([^ \t,]+)$/i)?.[1]
    const received = bearer ?? context.req.header('x-metrics-token') ?? ''

    if (!verifyToken(token, received)) {
      context.header('www-authenticate', 'Bearer realm="metrics"')
      return context.json({ error: 'Unauthorized' }, 401)
    }

    try {
      if (context.req.query('format') === 'json' || context.req.header('accept')?.includes('application/json')) {
        return context.json(snapshot())
      }
      return context.text(prometheus(), 200, {
        'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      })
    } catch (error) {
      report('database', error)
      return context.json({ error: 'Metrics unavailable' }, 503)
    }
  })

  function recordSchedulerHeartbeat(timestamp = now()): void {
    lastSchedulerHeartbeat = timestamp
    schedulerExpected = true
  }

  function expectScheduler(): void {
    schedulerExpected = true
  }

  return { middleware, router, snapshot, prometheus, recordSchedulerHeartbeat, expectScheduler }
}

const defaultObservability = createObservability()

export const observabilityMiddleware = defaultObservability.middleware
export const observabilityRouter = defaultObservability.router
export const recordSchedulerHeartbeat = defaultObservability.recordSchedulerHeartbeat
export const expectSchedulerHeartbeat = defaultObservability.expectScheduler

export function registerObservability(app: Hono): void {
  app.use('*', observabilityMiddleware)
  app.route('/', observabilityRouter)
}
