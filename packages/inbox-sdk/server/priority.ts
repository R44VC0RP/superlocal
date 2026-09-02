import type { InboxCategory, MailPriority, PersonalizationMode, PersonalizationStatus } from '../src/types'
import { sqlite } from './db'

type PrioritySignal = 'attention' | 'star' | 'reply' | 'irrelevant' | 'important' | 'other' | 'spam' | 'not-spam' | 'archive'
type Feedback = { thread_id: string; signal: PrioritySignal; value: number; updated_at: string }
type PriorityRow = {
  thread_id: string
  score: number
  learned_category: InboxCategory | null
  suggested_category: InboxCategory | 'spam' | null
  override_category: InboxCategory | null
  reason: string
  sample_count: number
}
type Metadata = {
  thread_id: string
  from_json: string
  subject: string
  preview: string
  folder: string
  scheduled_at: string | null
  provider_id: string | null
  received_at: string
  is_starred: number
  is_important: number
}
type Evidence = { positive: number; negative: number; spam: number; notSpam: number; samples: number; explicit: number; spamSamples: number; reading: number }

const DAY = 86_400_000
const cache = new Map<string, Map<string, { mode: PersonalizationMode; refreshedAt: number }>>()
const providerReason = 'Provider importance'
const learnedReason = 'Repeated explicit feedback on similar messages'
const starReason = 'Starred conversation protected'
const replyReason = 'Recently replied conversation protected'
const safetyReason = 'Sensitive message safeguard'
const safetyKeywords = /\b(security|verification|verify|password|passcode|authentication|login|sign[ -]?in|one[ -]?time|2fa|fraud|suspicious|billing|payment[ -]?(?:failed|failure|declined|overdue)|receipt|invoice|legal|court|subpoena|tax|emergency|urgent)\b/i

function modeForUser(userId: string): PersonalizationMode {
  const row = sqlite.query<{ data_json: string }, [string]>('SELECT data_json FROM user_settings WHERE user_id = ?').get(userId)
  try {
    const mode = JSON.parse(row?.data_json ?? '{}')?.personalizationMode
    return mode === 'suggest' || mode === 'adaptive' ? mode : 'off'
  } catch {
    return 'off'
  }
}

function senderEmail(value: string): string {
  try {
    const email = JSON.parse(value)?.email
    return typeof email === 'string' && /^[^\s@<>]+@[^\s@<>]+$/.test(email.trim()) ? email.trim().toLowerCase() : ''
  } catch {
    return ''
  }
}

function hasThread(userId: string, accountId: string, threadId: string, inboundOnly = false): boolean {
  const rows = sqlite.query<{ from_json: string; folder: string; scheduled_at: string | null }, [string, string, string]>(`
    SELECT m.from_json, m.folder, m.scheduled_at FROM messages m
    JOIN mail_accounts a ON a.id = m.account_id AND a.user_id = m.user_id
    WHERE m.user_id = ? AND m.account_id = ? AND m.thread_id = ?
  `).all(userId, accountId, threadId)
  if (!inboundOnly) return rows.length > 0
  const ownEmails = new Set(sqlite.query<{ email: string }, [string]>('SELECT email FROM mail_accounts WHERE user_id = ?')
    .all(userId).map((row) => row.email.trim().toLowerCase()))
  return rows.some((row) => {
    const sender = senderEmail(row.from_json)
    return sender && !ownEmails.has(sender) && !row.scheduled_at && !['sent', 'drafts', 'scheduled'].includes(row.folder)
  })
}

export function invalidatePriorities(userId: string, accountId?: string): void {
  if (accountId === undefined) cache.delete(userId)
  else cache.get(userId)?.delete(accountId)
}

export function recordPrioritySignal(userId: string, accountId: string, threadId: string, signal: PrioritySignal, value = 1): void {
  if (!Number.isFinite(value) || signal === 'archive') return
  if (value <= 0) {
    if (signal !== 'attention') clearPrioritySignal(userId, accountId, threadId, signal)
    return
  }
  if (signal === 'important' || signal === 'other') {
    setPriorityOverride(userId, accountId, threadId, signal)
    return
  }
  const changed = sqlite.transaction(() => {
    if (modeForUser(userId) === 'off' || !hasThread(userId, accountId, threadId, true)) return false
    let removed = 0
    if (signal === 'spam' || signal === 'not-spam') {
      removed = sqlite.query('DELETE FROM priority_feedback WHERE user_id = ? AND account_id = ? AND thread_id = ? AND signal = ?')
        .run(userId, accountId, threadId, signal === 'spam' ? 'not-spam' : 'spam').changes
    }
    // Attention is a cumulative high-water mark, not a stream of elapsed-time events.
    const saved = sqlite.query(`
      INSERT INTO priority_feedback (user_id, account_id, thread_id, signal, value)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (user_id, account_id, thread_id, signal) DO UPDATE SET
        value = excluded.value, updated_at = excluded.updated_at
      WHERE excluded.signal = 'attention' AND excluded.value > priority_feedback.value
    `).run(userId, accountId, threadId, signal, signal === 'attention' ? Math.min(120_000, Math.floor(value)) : 1)
    return removed > 0 || saved.changes > 0
  }).immediate()
  if (changed) invalidatePriorities(userId, accountId)
}

export function clearPrioritySignal(userId: string, accountId: string, threadId: string, signal: PrioritySignal): void {
  sqlite.transaction(() => {
    sqlite.query('DELETE FROM priority_feedback WHERE user_id = ? AND account_id = ? AND thread_id = ? AND signal = ?')
      .run(userId, accountId, threadId, signal)
    if (signal === 'important' || signal === 'other') {
      sqlite.query(`UPDATE thread_priorities SET override_category = NULL
        WHERE user_id = ? AND account_id = ? AND thread_id = ? AND override_category = ?`)
        .run(userId, accountId, threadId, signal)
    }
  }).immediate()
  invalidatePriorities(userId, accountId)
}

export function setPriorityOverride(userId: string, accountId: string, threadId: string, category: InboxCategory | null): void {
  if (category !== null && category !== 'important' && category !== 'other') throw new Error('Invalid priority category')
  sqlite.transaction(() => {
    if (!hasThread(userId, accountId, threadId)) return
    sqlite.query(`DELETE FROM priority_feedback WHERE user_id = ? AND account_id = ? AND thread_id = ?
      AND signal IN ('important', 'other') AND (? IS NULL OR signal <> ?)`)
      .run(userId, accountId, threadId, category, category)
    if (category === null) {
      sqlite.query('DELETE FROM thread_priorities WHERE user_id = ? AND account_id = ? AND thread_id = ?')
        .run(userId, accountId, threadId)
      return
    }
    sqlite.query(`
      INSERT INTO thread_priorities (user_id, account_id, thread_id, score, override_category, reason)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id, account_id, thread_id) DO UPDATE SET
        score = excluded.score, override_category = excluded.override_category, reason = excluded.reason,
        learned_category = NULL, suggested_category = NULL, sample_count = 0, updated_at = excluded.updated_at
    `).run(userId, accountId, threadId, category === 'important' ? 90 : 10, category, `Manually marked ${category}`)
    if (modeForUser(userId) !== 'off' && hasThread(userId, accountId, threadId, true)) {
      sqlite.query(`INSERT INTO priority_feedback (user_id, account_id, thread_id, signal, value)
        VALUES (?, ?, ?, ?, 1) ON CONFLICT DO NOTHING`).run(userId, accountId, threadId, category)
    }
  }).immediate()
  invalidatePriorities(userId, accountId)
}

export function refreshPriorities(userId: string, accountId?: string | null): void {
  const mode = modeForUser(userId)
  const now = Date.now()
  const accounts = sqlite.query<{ id: string; email: string }, [string]>('SELECT id, email FROM mail_accounts WHERE user_id = ?').all(userId)
  const ownEmails = new Set(accounts.map((account) => account.email.trim().toLowerCase()))
  const accountCache = cache.get(userId) ?? new Map<string, { mode: PersonalizationMode; refreshedAt: number }>()
  cache.set(userId, accountCache)
  const nested = sqlite.inTransaction
  for (const account of accounts) {
    if (accountId != null && account.id !== accountId) continue
    const cached = accountCache.get(account.id)
    if (!nested && cached?.mode === mode && now - cached.refreshedAt < 60 * 60 * 1000) continue
    sqlite.transaction(() => {
      if (mode === 'off') {
        sqlite.query('DELETE FROM thread_priorities WHERE user_id = ? AND account_id = ? AND override_category IS NULL').run(userId, account.id)
        sqlite.query(`UPDATE thread_priorities SET learned_category = NULL, suggested_category = NULL, sample_count = 0,
          score = CASE override_category WHEN 'important' THEN 90 ELSE 10 END,
          reason = 'Manually marked ' || override_category
          WHERE user_id = ? AND account_id = ?`).run(userId, account.id)
        return
      }
      // Only current metadata is read. Topic keys are ephemeral and never persisted or logged.
      const metadata = sqlite.query<Metadata, [string, string]>(`
        SELECT thread_id, from_json, subject, preview, folder, scheduled_at, provider_id,
          received_at, is_starred, is_important FROM messages
        WHERE user_id = ? AND account_id = ? ORDER BY received_at DESC, id DESC
      `).all(userId, account.id)
      const threads = new Map<string, { stream: string; important: boolean; starred: boolean; sensitive: boolean }>()
      const sourceVersions = new Map<string, Array<{ stream: string; receivedAt: number }>>()
      const replies = new Set<string>()
      for (const row of metadata) {
        const sender = senderEmail(row.from_json)
        if (row.folder === 'sent' && !row.scheduled_at && row.provider_id?.trim() && ownEmails.has(sender)
          && now - Date.parse(row.received_at) <= 30 * DAY) replies.add(row.thread_id)
        if (!sender || ownEmails.has(sender) || row.scheduled_at || ['sent', 'drafts', 'scheduled'].includes(row.folder)) continue
        const subject = row.subject.normalize('NFKC').toLowerCase().replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/, '')
        const head = subject.split(/:\s+|\s+[|\-]\s+/)[0]!
        const words = (text: string) => (text.match(/[\p{L}]+/gu) ?? [])
          .filter((word) => !/^(the|a|an|and|for|of|to|in|on|at|your|our|with|from|is|this|that|issue|edition|january|february|march|april|may|june|july|august|september|october|november|december)$/.test(word))
        const prefix = words(head)
        const topic = (prefix.length >= 2 ? prefix : words(subject)).slice(0, 4).join(' ')
        const stream = topic ? `${sender}\0${topic}` : ''
        const versions = sourceVersions.get(row.thread_id) ?? []
        versions.push({ stream, receivedAt: Date.parse(row.received_at) })
        sourceVersions.set(row.thread_id, versions)
        const existing = threads.get(row.thread_id)
        if (existing) {
          existing.important ||= Boolean(row.is_important)
          existing.starred ||= Boolean(row.is_starred)
          existing.sensitive ||= safetyKeywords.test(`${row.subject} ${row.preview}`)
          continue
        }
        threads.set(row.thread_id, {
          stream,
          important: Boolean(row.is_important), starred: Boolean(row.is_starred),
          sensitive: safetyKeywords.test(`${row.subject} ${row.preview}`),
        })
      }
      const feedback = new Map<string, Feedback[]>()
      for (const row of sqlite.query<Feedback, [string, string]>(
        'SELECT thread_id, signal, value, updated_at FROM priority_feedback WHERE user_id = ? AND account_id = ?',
      ).all(userId, account.id)) {
        const entries = feedback.get(row.thread_id) ?? []
        entries.push(row)
        feedback.set(row.thread_id, entries)
      }
      const groups = new Map<string, Evidence>()
      const protectedThreads = new Map<string, string>()
      for (const [threadId, thread] of threads) {
        let positive = 0, negative = 0, spam = 0, notSpam = 0, reading = 0
        let starred = thread.starred, replied = replies.has(threadId)
        for (const signal of feedback.get(threadId) ?? []) {
          if (signal.value <= 0) continue
          const age = now - Date.parse(signal.updated_at)
          const weight = Number.isFinite(age) ? 2 ** (-Math.max(0, age) / (30 * DAY)) : 0
          // A later incoming message must not inherit an earlier participant's training label.
          const observedSource = sourceVersions.get(threadId)
            ?.find((version) => version.receivedAt <= Date.parse(signal.updated_at))?.stream === thread.stream
          if (observedSource && ['important', 'star', 'reply'].includes(signal.signal)) positive = Math.max(positive, weight)
          if (observedSource && ['irrelevant', 'other'].includes(signal.signal)) negative = Math.max(negative, weight)
          if (observedSource && signal.signal === 'spam') spam = weight
          if (observedSource && signal.signal === 'not-spam') notSpam = weight
          if (observedSource && signal.signal === 'attention') reading = Math.min(1, signal.value / 120_000) * weight
          if (signal.signal === 'star') starred = true
          if (signal.signal === 'reply' && weight >= 0.5) replied = true
        }
        if (starred || replied || thread.sensitive) protectedThreads.set(threadId, starred ? starReason : replied ? replyReason : safetyReason)
        if (!thread.stream) continue
        const group = groups.get(thread.stream) ?? { positive: 0, negative: 0, spam: 0, notSpam: 0, samples: 0, explicit: 0, spamSamples: 0, reading: 0 }
        // Each thread contributes at most one independent explicit sample, even with several signals/messages.
        if (positive && negative) {
          group.positive += Math.max(positive, negative) / 2
          group.negative += Math.max(positive, negative) / 2
        } else {
          group.positive += positive
          group.negative += negative
        }
        group.spam += spam
        group.notSpam += notSpam
        group.explicit += Number(Math.max(positive, negative) >= 0.25)
        group.spamSamples += Number(spam >= 0.25)
        group.samples += Number(Math.max(positive, negative, spam, notSpam) >= 0.25)
        group.reading = Math.min(0.5, group.reading + reading * 0.1)
        groups.set(thread.stream, group)
      }
      const previous = new Map(sqlite.query<PriorityRow, [string, string]>(
        'SELECT thread_id, score, learned_category, suggested_category, override_category, reason, sample_count FROM thread_priorities WHERE user_id = ? AND account_id = ?',
      ).all(userId, account.id).map((row) => [row.thread_id, row]))
      const save = sqlite.query(`
        INSERT INTO thread_priorities (user_id, account_id, thread_id, score, learned_category, suggested_category, override_category, reason, sample_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (user_id, account_id, thread_id) DO UPDATE SET
          score = excluded.score, learned_category = excluded.learned_category, suggested_category = excluded.suggested_category,
          reason = excluded.reason, sample_count = excluded.sample_count, updated_at = excluded.updated_at
        WHERE thread_priorities.score IS NOT excluded.score OR thread_priorities.learned_category IS NOT excluded.learned_category
          OR thread_priorities.suggested_category IS NOT excluded.suggested_category OR thread_priorities.reason IS NOT excluded.reason
          OR thread_priorities.sample_count IS NOT excluded.sample_count
      `)
      for (const [threadId, thread] of threads) {
        const override = previous.get(threadId)?.override_category ?? null
        const group = groups.get(thread.stream)
        const total = (group?.positive ?? 0) + (group?.negative ?? 0)
        const posterior = (2 + (group?.positive ?? 0)) / (4 + total)
        const agreement = total ? Math.max(group!.positive, group!.negative) / total : 0
        const candidate = group && group.explicit >= 4 && total >= 3 && agreement >= 0.9
          ? posterior >= 0.7 ? 'important' : posterior <= 0.3 ? 'other' : null : null
        const highEvidence = group && group.explicit >= 6 && total >= 5 && agreement >= 0.95
          && (posterior >= 0.78 || posterior <= 0.22)
        const protectedReason = protectedThreads.get(threadId)
        const learned = !override && !protectedReason && mode === 'adaptive' && highEvidence ? candidate : null
        let suggestion: InboxCategory | 'spam' | null = !learned && candidate !== (thread.important ? 'important' : 'other') ? candidate : null
        if (group && group.spamSamples >= 4 && group.spam >= 3 && group.positive < 0.25 && group.notSpam < 0.25) suggestion = 'spam'
        if (override || protectedReason) suggestion = null
        // A relative ranking score, not a calibrated probability. Reading cannot open either classification gate.
        const score = override ? override === 'important' ? 90 : 10
          : protectedReason ? protectedReason === safetyReason ? 70 : 95
          : candidate ? Math.round(20 + 60 * posterior)
          : (thread.important ? 70 : 30) + Math.round((group?.reading ?? 0) * 6)
        const reason = override ? `Manually marked ${override}` : protectedReason ?? (candidate || suggestion ? learnedReason : providerReason)
        save.run(userId, account.id, threadId, score, learned, suggestion, override, reason, group?.samples ?? 0)
      }
      for (const [threadId, row] of previous) {
        if (threads.has(threadId)) continue
        if (!row.override_category || !hasThread(userId, account.id, threadId)) {
          sqlite.query('DELETE FROM thread_priorities WHERE user_id = ? AND account_id = ? AND thread_id = ?').run(userId, account.id, threadId)
        }
      }
    }).immediate()
    if (!nested) accountCache.set(account.id, { mode, refreshedAt: now })
  }
}

export function getThreadPriority(userId: string, accountId: string, threadId: string, providerImportant: boolean, isStarred: boolean): {
  isImportant: boolean; priorityOverride: InboxCategory | null; priority?: MailPriority
} {
  refreshPriorities(userId, accountId)
  const mode = modeForUser(userId)
  const row = sqlite.query<PriorityRow, [string, string, string]>(
    'SELECT thread_id, score, learned_category, suggested_category, override_category, reason, sample_count FROM thread_priorities WHERE user_id = ? AND account_id = ? AND thread_id = ?',
  ).get(userId, accountId, threadId)
  const override = row?.override_category ?? null
  const starred = mode !== 'off' && isStarred && !override
  const learned = mode === 'adaptive' && !starred ? row?.learned_category : null
  const score = starred ? 95 : row?.score ?? (providerImportant ? 70 : 30)
  const isImportant = score >= 85 || (override ?? learned ?? (providerImportant ? 'important' : 'other')) === 'important'
  const reason = starred ? starReason : row?.reason ?? providerReason
  const source = override ? 'manual' : [starReason, replyReason, safetyReason].includes(reason) ? 'protected' : reason === learnedReason ? 'learned' : 'provider'
  return {
    isImportant, priorityOverride: override,
    priority: {
      score, level: score >= 85 ? 'priority' : isImportant ? 'important' : 'other', source, reason,
      sampleCount: mode === 'off' ? 0 : row?.sample_count ?? 0, providerImportant,
      ...(mode !== 'off' && !starred && row?.suggested_category ? { suggestedCategory: row.suggested_category } : {}),
    },
  }
}

export function getPersonalizationStatus(userId: string): PersonalizationStatus {
  refreshPriorities(userId)
  const mode = modeForUser(userId)
  const counts = sqlite.query<{ feedbackCount: number; readingCount: number }, [string]>(`
    SELECT COUNT(*) FILTER (WHERE explicit) AS feedbackCount, COUNT(*) FILTER (WHERE attention) AS readingCount
    FROM (SELECT account_id, thread_id, MAX(signal NOT IN ('attention', 'archive')) AS explicit,
      MAX(signal = 'attention' AND value > 0) AS attention FROM priority_feedback WHERE user_id = ? GROUP BY account_id, thread_id)
  `).get(userId)!
  const learned = sqlite.query<{ learnedAccounts: number; suggestionCount: number }, [string]>(`
    SELECT COUNT(DISTINCT CASE WHEN sample_count >= 4 THEN account_id END) AS learnedAccounts,
      COUNT(*) FILTER (WHERE suggested_category IS NOT NULL AND EXISTS (
        SELECT 1 FROM messages m WHERE m.user_id = thread_priorities.user_id AND m.account_id = thread_priorities.account_id
          AND m.thread_id = thread_priorities.thread_id AND m.folder = 'inbox'
      )) AS suggestionCount FROM thread_priorities WHERE user_id = ?
  `).get(userId)!
  return { mode, ...counts, learnedAccounts: mode === 'off' ? 0 : learned.learnedAccounts, suggestionCount: mode === 'off' ? 0 : learned.suggestionCount }
}

export function resetPersonalization(userId: string): void {
  sqlite.transaction(() => {
    sqlite.query('DELETE FROM priority_feedback WHERE user_id = ?').run(userId)
    sqlite.query('DELETE FROM thread_priorities WHERE user_id = ?').run(userId)
  }).immediate()
  invalidatePriorities(userId)
}
