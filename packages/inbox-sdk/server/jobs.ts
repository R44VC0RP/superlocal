import { sqlite } from './db'
import { mailFailure, SendInputError, type MailFailure } from './mail-errors'
import { ProviderError } from './sdk'

export interface ScheduledJobResult {
  unsnoozed: number
  sent: number
}

export interface MutationJob {
  id: string
  userId: string
  accountId: string
  type: string
  payload: unknown
  attempts: number
  idempotencyKey: string | null
}

export interface MailSchedulerStop {
  (options?: { timeoutMs?: number }): Promise<boolean>
  drain(options?: { timeoutMs?: number }): Promise<boolean>
}

interface JobRow {
  id: string
  user_id: string
  account_id: string
  type: string
  payload_json: string
  attempts: number
  idempotency_key: string | null
}

const accountCooldowns = new Map<string, number>()
const activeMutationJobs = new Set<string>()
const mutationJobWakeups = new Set<() => void>()
const schedulerWakeups = new Set<() => void>()
let schedulerWakeupQueued = false

function mutationJobLeaseMs(configured = Number(process.env.OPENMAIL_JOB_LEASE_MS ?? 30_000)): number {
  return Number.isFinite(configured) && configured > 0 ? Math.max(1, Math.floor(configured)) : 30_000
}

function mutationJobKey(row: JobRow): string {
  return `${row.user_id}\0${row.account_id}\0${row.id}`
}

function settleFailedMutationJob(
  row: JobRow,
  error: unknown,
  failedAt: Date,
  maxAttempts: number,
  expectedStatus: 'pending' | 'processing' = 'processing',
  stage: MailFailure['stage'] = 'dispatch',
): boolean {
  const terminal = row.attempts >= maxAttempts || error instanceof SendInputError || (error instanceof ProviderError && !error.retryable)
  const retryAfter = error instanceof ProviderError && error.retryAfter !== undefined
    ? error.retryAfter * 1_000
    : 0
  const nextAttemptAt = new Date(
    failedAt.getTime() + Math.max(Math.min(2 ** row.attempts * 1_000, 300_000), retryAfter),
  )
  const nextAttempt = nextAttemptAt.toISOString()
  const rateLimited = !terminal && error instanceof ProviderError &&
    (error.code === 'RATE_LIMITED' || error.status === 429)
  const failure = mailFailure(error, stage, row.id)
  if (terminal) {
    failure.retryable = false
    if (failure.action === 'wait_for_retry') failure.action = 'check_status'
  }

  const changed = sqlite.query(`
    UPDATE mutation_jobs SET status = ?, last_error = ?, next_attempt_at = ?, updated_at = ?
    WHERE id = ? AND user_id = ? AND account_id = ? AND status = ? AND attempts = ?
  `).run(
    terminal ? 'failed' : 'pending',
    JSON.stringify(failure),
    terminal ? null : nextAttempt,
    failedAt.toISOString(),
    row.id,
    row.user_id,
    row.account_id,
    expectedStatus,
    row.attempts,
  ).changes
  if (!changed) return false
  console.warn({ jobId: row.id, code: failure.code, stage, attempts: row.attempts, terminal })

  if (rateLimited) {
    const accountKey = `${row.user_id}\0${row.account_id}`
    accountCooldowns.set(accountKey, Math.max(accountCooldowns.get(accountKey) ?? 0, nextAttemptAt.getTime()))
    sqlite.query(`
      UPDATE mutation_jobs SET next_attempt_at = ?, updated_at = ?
      WHERE user_id = ? AND account_id = ? AND status = 'pending'
        AND (next_attempt_at IS NULL OR next_attempt_at < ?)
    `).run(nextAttempt, failedAt.toISOString(), row.user_id, row.account_id, nextAttempt)
  }

  if (!terminal || row.type !== 'message-mutation') return true

  let payload: {
    messageId?: unknown
    accountId?: unknown
    providerId?: unknown
    previous?: Record<string, unknown>
    optimistic?: Record<string, unknown>
  }
  try {
    payload = JSON.parse(row.payload_json) as typeof payload
  } catch {
    return true
  }
  if (
    typeof payload.messageId !== 'string' ||
    payload.accountId !== row.account_id ||
    typeof payload.providerId !== 'string' ||
    !payload.previous ||
    !payload.optimistic
  ) return true

  const superseded = new Set<string>()
  const newer = sqlite.query<{ payload_json: string }, [string, string, string]>(`
    SELECT payload_json FROM mutation_jobs
    WHERE user_id = ? AND account_id = ? AND type = 'message-mutation'
      AND status IN ('pending', 'processing')
      AND json_extract(payload_json, '$.messageId') = ?
  `).all(row.user_id, row.account_id, payload.messageId)
  for (const pending of newer) {
    try {
      const optimistic = (JSON.parse(pending.payload_json) as { optimistic?: unknown }).optimistic
      if (optimistic && typeof optimistic === 'object') {
        for (const key of Object.keys(optimistic)) superseded.add(key)
      }
    } catch {
      continue
    }
  }

  const assignments: string[] = []
  const bindings: Array<string | number> = []
  if (!superseded.has('folder') &&
    typeof payload.previous.folder === 'string' && typeof payload.optimistic.folder === 'string') {
    assignments.push('folder = CASE WHEN folder = ? THEN ? ELSE folder END')
    bindings.push(payload.optimistic.folder, payload.previous.folder)
  }
  if (!superseded.has('isRead') &&
    typeof payload.previous.isRead === 'boolean' && typeof payload.optimistic.isRead === 'boolean') {
    assignments.push('is_read = CASE WHEN is_read = ? THEN ? ELSE is_read END')
    bindings.push(Number(payload.optimistic.isRead), Number(payload.previous.isRead))
  }
  if (!superseded.has('isStarred') &&
    typeof payload.previous.isStarred === 'boolean' && typeof payload.optimistic.isStarred === 'boolean') {
    assignments.push('is_starred = CASE WHEN is_starred = ? THEN ? ELSE is_starred END')
    bindings.push(Number(payload.optimistic.isStarred), Number(payload.previous.isStarred))
  }
  if (!superseded.has('labels') &&
    Array.isArray(payload.previous.labels) && Array.isArray(payload.optimistic.labels)) {
    assignments.push('labels_json = CASE WHEN labels_json = ? THEN ? ELSE labels_json END')
    bindings.push(JSON.stringify(payload.optimistic.labels), JSON.stringify(payload.previous.labels))
  }

  if (assignments.length) {
    sqlite.query(`
      UPDATE messages SET ${assignments.join(', ')}
      WHERE id = ? AND user_id = ? AND account_id = ? AND provider_id = ?
    `).run(...bindings, payload.messageId, row.user_id, row.account_id, payload.providerId)
  }

  sqlite.query(`
    UPDATE mail_accounts SET sync_status = 'error'
    WHERE id = ? AND user_id = ?
  `).run(row.account_id, row.user_id)

  return true
}

function recoverMutationJobs(
  now: Date,
  maxAttempts: number,
  leaseMs: number,
  restarting = false,
): { recovered: number; failed: number } {
  return sqlite.transaction(() => {
    const abandoned = sqlite.query(`
      SELECT id, user_id, account_id, type, payload_json, attempts, idempotency_key, status
      FROM mutation_jobs
      WHERE (status = 'processing' AND (? = 1 OR updated_at <= ?))
        OR (status = 'pending' AND attempts >= ?)
      ORDER BY created_at ASC, rowid ASC
    `).all(
      Number(restarting),
      new Date(now.getTime() - leaseMs).toISOString(),
      maxAttempts,
    ) as Array<JobRow & { status: 'pending' | 'processing' }>

    let recovered = 0
    let failed = 0
    for (const row of abandoned) {
      if (activeMutationJobs.has(mutationJobKey(row))) continue
      if (row.attempts >= maxAttempts) {
        if (settleFailedMutationJob(
          row,
          new Error('Mutation job exhausted its retry attempts before recovery'),
          now,
          maxAttempts,
          row.status,
          'recovery',
        )) failed += 1
        continue
      }

      const changed = sqlite.query(`
        UPDATE mutation_jobs
        SET status = 'pending', next_attempt_at = NULL, updated_at = ?
        WHERE id = ? AND user_id = ? AND account_id = ?
          AND status = 'processing' AND attempts = ?
      `).run(now.toISOString(), row.id, row.user_id, row.account_id, row.attempts).changes
      if (changed) recovered += 1
    }

    return { recovered, failed }
  })()
}

export function requestMailJobProcessing(): void {
  if (schedulerWakeups.size === 0 || schedulerWakeupQueued) return
  schedulerWakeupQueued = true
  queueMicrotask(() => {
    schedulerWakeupQueued = false
    for (const wakeup of schedulerWakeups) wakeup()
    for (const wakeup of mutationJobWakeups) wakeup()
  })
}

export function processScheduledMail(now = new Date()): ScheduledJobResult {
  const timestamp = now.toISOString()
  const unsnoozed = sqlite.query(`
    UPDATE messages
    SET folder = 'inbox', snoozed_until = NULL
    WHERE folder = 'snoozed' AND snoozed_until IS NOT NULL AND snoozed_until <= ?
  `).run(timestamp).changes

  // Real providers must transmit before entering Sent; only local mock mail can settle here.
  const sent = sqlite.query(`
    UPDATE messages
    SET folder = 'sent', scheduled_at = NULL
    WHERE folder = 'scheduled'
      AND scheduled_at IS NOT NULL
      AND scheduled_at <= ?
      AND EXISTS (
        SELECT 1 FROM mail_accounts
        WHERE mail_accounts.id = messages.account_id
          AND mail_accounts.user_id = messages.user_id
          AND mail_accounts.provider = 'mock'
      )
  `).run(timestamp).changes

  return { unsnoozed, sent }
}

export async function processMutationJobs(
  handler: (job: MutationJob) => Promise<void>,
  options: {
    now?: Date
    limit?: number
    maxAttempts?: number
    concurrency?: number
    accountConcurrency?: number
    leaseMs?: number
    signal?: AbortSignal
  } = {},
): Promise<{ completed: number; failed: number }> {
  const now = options.now ?? new Date()
  const limit = Math.max(1, Math.min(options.limit ?? 50, 100))
  const maxAttempts = Math.max(1, options.maxAttempts ?? 5)
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 5, 10))
  const accountConcurrency = Math.max(1, Math.min(options.accountConcurrency ?? 3, concurrency))
  const leaseMs = mutationJobLeaseMs(options.leaseMs)
  const recovery = recoverMutationJobs(now, maxAttempts, leaseMs)
  for (const [accountKey, expiresAt] of accountCooldowns) {
    if (expiresAt <= now.getTime()) accountCooldowns.delete(accountKey)
  }
  const readyJobs = sqlite.query(`
    SELECT id, user_id, account_id, type, payload_json, attempts, idempotency_key
    FROM mutation_jobs
    WHERE status = 'pending'
      AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
    ORDER BY created_at ASC, rowid ASC
    LIMIT ?
  `)
  const jobs = readyJobs.all(now.toISOString(), limit) as JobRow[]

  let completed = 0
  let failed = recovery.failed

  async function processJob(row: JobRow): Promise<void> {
    const heartbeat = setInterval(() => {
      sqlite.query(`
        UPDATE mutation_jobs SET updated_at = ?
        WHERE id = ? AND user_id = ? AND account_id = ?
          AND status = 'processing' AND attempts = ?
      `).run(new Date().toISOString(), row.id, row.user_id, row.account_id, row.attempts)
    }, Math.max(1, Math.floor(leaseMs / 3)))
    heartbeat.unref?.()

    try {
      await handler({
        id: row.id,
        userId: row.user_id,
        accountId: row.account_id,
        type: row.type,
        payload: JSON.parse(row.payload_json) as unknown,
        attempts: row.attempts,
        idempotencyKey: row.idempotency_key,
      })
      const timestamp = options.now ? now.toISOString() : new Date().toISOString()
      const changed = sqlite.query(`
        UPDATE mutation_jobs SET status = 'completed', completed_at = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND account_id = ?
          AND status = 'processing' AND attempts = ?
      `).run(timestamp, timestamp, row.id, row.user_id, row.account_id, row.attempts).changes
      if (changed) completed += 1
    } catch (error) {
      const failedAt = options.now ?? new Date()
      const changed = sqlite.transaction(() => settleFailedMutationJob(row, error, failedAt, maxAttempts))()
      if (changed) failed += 1
    } finally {
      clearInterval(heartbeat)
      activeMutationJobs.delete(mutationJobKey(row))
    }
  }

  const active = new Set<Promise<void>>()
  const activeAccounts = new Map<string, number>()
  const selected = new Set(jobs.map(job => job.id))
  let notified = false
  let resolveWakeup: (() => void) | undefined
  const wakeup = () => {
    notified = true
    resolveWakeup?.()
  }
  mutationJobWakeups.add(wakeup)
  options.signal?.addEventListener('abort', wakeup)

  try {
    while (jobs.length > 0 || active.size > 0) {
      if (!options.signal?.aborted && notified && selected.size < limit) {
        const timestamp = options.now ? now.toISOString() : new Date().toISOString()
        for (const row of readyJobs.all(timestamp, limit) as JobRow[]) {
          if (selected.size >= limit) break
          if (selected.has(row.id)) continue
          selected.add(row.id)
          jobs.push(row)
        }
      }
      notified = false

      for (let index = 0; !options.signal?.aborted && index < jobs.length && active.size < concurrency;) {
        const row = jobs[index]
        const accountKey = `${row.user_id}\0${row.account_id}`
        const cooldown = accountCooldowns.get(accountKey)
        if (cooldown !== undefined && cooldown > (options.now ? now.getTime() : Date.now())) {
          jobs.splice(index, 1)
          continue
        }
        if (cooldown !== undefined) accountCooldowns.delete(accountKey)
        if ((activeAccounts.get(accountKey) ?? 0) >= accountConcurrency) {
          index += 1
          continue
        }

        const claimed = sqlite.query(`
          UPDATE mutation_jobs AS candidate
          SET status = 'processing', attempts = attempts + 1, updated_at = ?
          WHERE id = ? AND user_id = ? AND account_id = ? AND status = 'pending' AND attempts < ?
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
            AND (
              type <> 'message-mutation'
              OR NOT EXISTS (
                SELECT 1 FROM mutation_jobs AS earlier
                WHERE earlier.user_id = candidate.user_id
                  AND earlier.account_id = candidate.account_id
                  AND earlier.type = 'message-mutation'
                  AND earlier.status IN ('pending', 'processing')
                  AND json_extract(earlier.payload_json, '$.messageId') =
                      json_extract(candidate.payload_json, '$.messageId')
                  AND (
                    earlier.created_at < candidate.created_at
                    OR (earlier.created_at = candidate.created_at AND earlier.rowid < candidate.rowid)
                  )
              )
            )
        `).run(options.now ? now.toISOString() : new Date().toISOString(), row.id, row.user_id,
          row.account_id, maxAttempts,
          options.now ? now.toISOString() : new Date().toISOString())

        if (!claimed.changes) {
          index += 1
          continue
        }

        jobs.splice(index, 1)
        row.attempts += 1
        const current = sqlite.query<{ payload_json: string }, [string, string, string]>(`
          SELECT payload_json FROM mutation_jobs WHERE id = ? AND user_id = ? AND account_id = ?
        `).get(row.id, row.user_id, row.account_id)
        if (current) row.payload_json = current.payload_json
        activeAccounts.set(accountKey, (activeAccounts.get(accountKey) ?? 0) + 1)
        activeMutationJobs.add(mutationJobKey(row))

        const task = processJob(row).finally(() => {
          active.delete(task)
          const remaining = (activeAccounts.get(accountKey) ?? 1) - 1
          if (remaining === 0) activeAccounts.delete(accountKey)
          else activeAccounts.set(accountKey, remaining)
        })
        active.add(task)
      }

      if (active.size === 0) break
      const signal = new Promise<void>(resolve => { resolveWakeup = resolve })
      await Promise.race([...active, signal])
      resolveWakeup = undefined
    }
  } finally {
    mutationJobWakeups.delete(wakeup)
    options.signal?.removeEventListener('abort', wakeup)
  }

  return { completed, failed }
}

export function startMailScheduler(
  intervalMs = 5_000,
  mutationHandler?: (job: MutationJob) => Promise<void>,
  onHeartbeat?: () => void,
): MailSchedulerStop {
  recoverMutationJobs(new Date(), 5, mutationJobLeaseMs(), true)

  const controller = new AbortController()
  let processing = false
  let requested = false
  let stopped = false
  let resolveDrained: (() => void) | undefined
  const drained = new Promise<void>(resolve => { resolveDrained = resolve })

  async function tick(): Promise<void> {
    if (stopped) return
    if (processing) {
      requested = true
      return
    }
    processing = true
    onHeartbeat?.()
    try {
      let processed: number
      do {
        requested = false
        processScheduledMail()
        const result = mutationHandler
          ? await processMutationJobs(mutationHandler, { signal: controller.signal })
          : null
        processed = result ? result.completed + result.failed : 0
      } while (!stopped && (requested || processed > 0))
    } catch (error) {
      console.error('OpenMail scheduled mail processing failed', error)
    } finally {
      processing = false
      onHeartbeat?.()
      if (stopped) resolveDrained?.()
    }
  }

  const wakeup = () => { void tick() }
  schedulerWakeups.add(wakeup)
  void tick()
  const timer = setInterval(() => { void tick() }, Math.max(1_000, intervalMs))
  timer.unref?.()

  const stop: MailSchedulerStop = (options = {}) => {
    if (!stopped) {
      stopped = true
      controller.abort()
      schedulerWakeups.delete(wakeup)
      clearInterval(timer)
      if (!processing) resolveDrained?.()
    }

    const configuredTimeout = options.timeoutMs ?? 30_000
    const timeoutMs = Number.isFinite(configuredTimeout) ? Math.max(0, configuredTimeout) : 30_000
    if (timeoutMs === 0) return Promise.resolve(!processing)

    return new Promise<boolean>(resolve => {
      const timeout = setTimeout(() => { resolve(false) }, timeoutMs)
      void drained.then(() => {
        clearTimeout(timeout)
        resolve(true)
      })
    })
  }
  stop.drain = stop

  return stop
}
