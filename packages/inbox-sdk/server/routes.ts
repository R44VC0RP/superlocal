import type { SQLQueryBindings } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { resolve, sep } from 'node:path'
import { Hono } from 'hono'
import { auth } from './auth'
import { encryptCredential } from './crypto'
import { sqlite } from './db'
import { requestMailJobProcessing } from './jobs'
import { enabledMailboxProviders, isMailboxProviderEnabled } from './mailbox-providers'
import { openApiDocument } from './openapi'
import { mailFailure, SendInputError, storedMailFailure } from './mail-errors'
import { normalizeSendAttachments } from './send-attachments'
import {
  clearPrioritySignal,
  getPersonalizationStatus,
  getThreadPriority,
  invalidatePriorities,
  recordPrioritySignal,
  refreshPriorities,
  resetPersonalization,
  setPriorityOverride,
} from './priority'
import {
  assertProviderMutationSupported,
  enableConnectionInboxViews,
  getAccountProvider,
  getReadyAccountProvider,
  synchronizeAccount,
} from './provider-service'
import * as emailSanitizer from './sanitize'
import { compileMailSearch } from './search'
import { htmlToPlainText, ProviderError, type MessageMutation } from './sdk'
import { discoverMailSources } from './sdk/mail-sources'
import { InboxViewStore, InboxViewError, inboxMessagePredicate } from './sdk/inbox-store'
import type { SavedInbox, SavedInboxInput } from '../src/inbox-views'
import {
  DEFAULT_SETTINGS,
  type Attachment,
  type InboxCategory,
  type MailAccount,
  type MailFolder,
  type MailMessage,
  type MailThread,
  type Participant,
  type PrioritySectionMode,
  type ProviderType,
  type UserSettings,
} from '../src/types'

type Row = Record<string, unknown>
type Variables = { userId: string; inbox: SavedInbox | null }
type Bindings = SQLQueryBindings[]
const inboxViews = new InboxViewStore(sqlite)

const MAX_PRESENTATION_CACHE_BYTES = 12 * 1024 * 1024
const MAX_PRESENTATION_CACHE_ENTRIES = 256
const PRESENTATION_CACHE_TTL_MS = 30_000
const presentationCache = new Map<string, {
  html: string
  styles: string
  plainText: string
  expiresAt: number
  bytes: number
}>()
let presentationCacheBytes = 0

const FOLDERS: MailFolder[] = [
  'inbox',
  'starred',
  'sent',
  'drafts',
  'archive',
  'trash',
  'spam',
  'snoozed',
  'scheduled',
]

const PROVIDERS: ProviderType[] = ['mock', 'gmail', 'outlook', 'imap', 'inbound']
const MUTATION_FOLDERS: MailFolder[] = ['inbox', 'archive', 'trash', 'spam', 'snoozed']
const EMAIL_ADDRESS = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/

export const router = new Hono<{ Variables: Variables }>()

function one(sql: string, bindings: Bindings = []): Row | null {
  return sqlite.query<Row, Bindings>(sql).get(...bindings)
}

function all(sql: string, bindings: Bindings = []): Row[] {
  return sqlite.query<Row, Bindings>(sql).all(...bindings)
}

function run(sql: string, bindings: Bindings = []) {
  return sqlite.query<unknown, Bindings>(sql).run(...bindings)
}

function mutationSelection(userId: string, inbox: SavedInbox | null, threadIds: string[], requested: unknown): { ids?: string[]; error?: string } {
  if (!inbox && requested === undefined) return {}
  if (!Array.isArray(requested) || !requested.length || requested.length > 5000 ||
    requested.some((id) => typeof id !== 'string' || !id)) {
    return { error: 'Provide the message IDs included in the selected conversations' }
  }
  const ids = [...new Set(requested as string[])]
  const scope = inbox ? inboxMessagePredicate(inbox, 'm') : null
  const rows = all(`SELECT m.id, m.thread_id FROM messages m WHERE m.user_id = ?
    AND m.thread_id IN (${threadIds.map(() => '?').join(',')})
    AND m.id IN (${ids.map(() => '?').join(',')})${scope ? ` AND (${scope.sql})` : ''}`,
  [userId, ...threadIds, ...ids, ...(scope?.params ?? [])])
  if (rows.length !== ids.length || new Set(rows.map((row) => row.thread_id)).size !== threadIds.length) {
    return { error: 'One or more selected messages are outside this inbox or conversation' }
  }
  return { ids }
}

function updateMessagesAndQueueMutations(
  userId: string,
  threadIds: string[],
  assignments: string[],
  bindings: Bindings,
  priorityChanges: { priorityOverride?: InboxCategory | null; clearIrrelevant?: boolean; isQuarantined?: boolean; needsAction?: boolean } = {},
  messageIds?: string[],
): number {
  const placeholders = threadIds.map(() => '?').join(', ')
  const selected = messageIds ? ` AND id IN (${messageIds.map(() => '?').join(', ')})` : ''
  const selectedBindings = messageIds ?? []

  return sqlite.transaction(() => {
    const providers = new Map<string, ReturnType<typeof getAccountProvider>>()
    const previous = all(
      `SELECT m.id, m.account_id, m.thread_id, m.provider_id, m.folder, m.is_read, m.is_starred,
              m.labels_json, a.provider
       FROM messages m
       JOIN mail_accounts a ON a.id = m.account_id AND a.user_id = m.user_id
        WHERE m.user_id = ? AND m.thread_id IN (${placeholders})${selected.replace(' AND id ', ' AND m.id ')}`,
      [userId, ...threadIds, ...selectedBindings],
    )

    const result = assignments.length ? run(
      `UPDATE messages SET ${assignments.join(', ')}
       WHERE user_id = ? AND thread_id IN (${placeholders})${selected}`,
      [...bindings, userId, ...threadIds, ...selectedBindings],
    ) : { changes: previous.length }
    if (priorityChanges.isQuarantined === true) {
      run(`UPDATE messages SET folder = 'archive' WHERE user_id = ? AND thread_id IN (${placeholders}) AND folder IN ('spam', 'trash')${selected}`,
        [userId, ...threadIds, ...selectedBindings])
    }
    if (priorityChanges.needsAction === true) {
      run(`INSERT INTO action_threads (user_id, account_id, thread_id)
        SELECT DISTINCT user_id, account_id, thread_id FROM messages
        WHERE user_id = ? AND thread_id IN (${placeholders}) ON CONFLICT DO NOTHING`,
      [userId, ...threadIds])
    } else if (priorityChanges.needsAction === false) {
      run(`DELETE FROM action_threads WHERE user_id = ? AND thread_id IN (${placeholders})`,
        [userId, ...threadIds])
    }

    for (const before of previous) {
      if (
        before.provider === 'mock' ||
        typeof before.provider_id !== 'string' ||
        !before.provider_id
      ) continue

      const after = one(
        `SELECT folder, is_read, is_starred, labels_json FROM messages
         WHERE id = ? AND user_id = ? AND account_id = ? AND provider_id = ?`,
        [String(before.id), userId, String(before.account_id), before.provider_id],
      )
      if (!after) continue

      const changes: MessageMutation = {}
      const previousState: Row = {}
      const optimisticState: Row = {}

      if (before.folder !== after.folder && ['archive', 'trash', 'inbox', 'spam'].includes(String(after.folder))) {
        changes.folder = after.folder as MailFolder
        previousState.folder = before.folder
        optimisticState.folder = after.folder
      }

      if (before.is_read !== after.is_read) {
        changes.isRead = Boolean(after.is_read)
        previousState.isRead = Boolean(before.is_read)
        optimisticState.isRead = Boolean(after.is_read)
      }

      if (before.is_starred !== after.is_starred) {
        changes.isStarred = Boolean(after.is_starred)
        previousState.isStarred = Boolean(before.is_starred)
        optimisticState.isStarred = Boolean(after.is_starred)
      }

      const previousLabels = parseJson<string[]>(before.labels_json, [])
      const optimisticLabels = parseJson<string[]>(after.labels_json, [])
      const addLabels = optimisticLabels.filter((label) => !previousLabels.includes(label))
      const removeLabels = previousLabels.filter((label) => !optimisticLabels.includes(label))
      if (addLabels.length || removeLabels.length) {
        if (addLabels.length) changes.addLabels = addLabels
        if (removeLabels.length) changes.removeLabels = removeLabels
        previousState.labels = previousLabels
        optimisticState.labels = optimisticLabels
      }

      if (!Object.keys(changes).length) continue

      const accountId = String(before.account_id)
      let provider = providers.get(accountId)
      if (!provider) {
        provider = getAccountProvider(userId, accountId)
        providers.set(accountId, provider)
      }
      assertProviderMutationSupported(provider, changes)

      run(
        `INSERT INTO mutation_jobs
           (id, user_id, account_id, type, payload_json, status, next_attempt_at)
         VALUES (?, ?, ?, 'message-mutation', ?, 'pending', ?)`,
        [
          crypto.randomUUID(),
          userId,
          accountId,
          JSON.stringify({
            messageId: before.id,
            accountId: before.account_id,
            providerId: before.provider_id,
            changes,
            previous: previousState,
            optimistic: optimisticState,
          }),
          new Date().toISOString(),
        ],
      )
    }

    const relevanceChanged = assignments.some((assignment) => /^(?:folder|is_starred|labels_json)\b/.test(assignment))
      || 'priorityOverride' in priorityChanges || priorityChanges.clearIrrelevant || 'isQuarantined' in priorityChanges
    if (relevanceChanged) {
      const conversations = new Map<string, Row[]>()
      for (const row of previous) {
        const key = `${row.account_id}\0${row.thread_id}`
        const entries = conversations.get(key) ?? []
        entries.push(row)
        conversations.set(key, entries)
      }
      for (const before of conversations.values()) {
        const accountId = String(before[0].account_id)
        const threadId = String(before[0].thread_id)
        const after = all('SELECT folder, is_starred FROM messages WHERE user_id = ? AND account_id = ? AND thread_id = ?',
          [userId, accountId, threadId])
        const wasStarred = before.some((message) => Boolean(message.is_starred))
        const isStarred = after.some((message) => Boolean(message.is_starred))
        if (wasStarred !== isStarred) {
          if (isStarred) recordPrioritySignal(userId, accountId, threadId, 'star')
          else clearPrioritySignal(userId, accountId, threadId, 'star')
        }
        const wasSpam = before.some((message) => message.folder === 'spam')
        const isSpam = after.some((message) => message.folder === 'spam')
        if (!wasSpam && isSpam) recordPrioritySignal(userId, accountId, threadId, 'spam')
        if (wasSpam && !isSpam) {
          clearPrioritySignal(userId, accountId, threadId, 'spam')
          if (after.some((message) => message.folder === 'inbox')) recordPrioritySignal(userId, accountId, threadId, 'not-spam')
        }
        if ('priorityOverride' in priorityChanges) {
          setPriorityOverride(userId, accountId, threadId, priorityChanges.priorityOverride ?? null)
        }
        const explicitlyDiscarded = after.every((message) => message.folder === 'spam' || message.folder === 'trash')
        if (priorityChanges.isQuarantined === true) {
          run('INSERT INTO quarantined_threads (user_id, account_id, thread_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
            [userId, accountId, threadId])
          recordPrioritySignal(userId, accountId, threadId, 'spam')
        } else if (priorityChanges.isQuarantined === false) {
          run('DELETE FROM quarantined_threads WHERE user_id = ? AND account_id = ? AND thread_id = ?',
            [userId, accountId, threadId])
          if (!explicitlyDiscarded) {
            clearPrioritySignal(userId, accountId, threadId, 'spam')
            recordPrioritySignal(userId, accountId, threadId, 'not-spam')
          }
        } else if (explicitlyDiscarded) {
          run('DELETE FROM quarantined_threads WHERE user_id = ? AND account_id = ? AND thread_id = ?',
            [userId, accountId, threadId])
        }
        if (priorityChanges.clearIrrelevant || priorityChanges.isQuarantined === false && !explicitlyDiscarded) {
          run('DELETE FROM irrelevant_messages WHERE user_id = ? AND account_id = ? AND thread_id = ?', [userId, accountId, threadId])
          clearPrioritySignal(userId, accountId, threadId, 'irrelevant')
        }
        invalidatePriorities(userId, accountId)
      }
    }

    return result.changes
  })()
}

function folderProviderStatus(error: unknown): 400 | 401 | 403 | 404 | 409 | 429 | 501 | 502 {
  if (!(error instanceof ProviderError)) return 502
  if (error.code === 'UNSUPPORTED_OPERATION') return 501
  if (error.code === 'AUTHENTICATION') return 401
  if (error.code === 'AUTHORIZATION') return 403
  if (error.code === 'NOT_FOUND') return 404
  if (error.code === 'RATE_LIMITED') return 429
  if (error.status === 409) return 409
  if (error.code === 'VALIDATION') return 400
  return 502
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback

  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function participant(value: unknown): Participant {
  if (!value || typeof value !== 'object') return { name: '', email: '' }

  const record = value as Row
  return {
    name: typeof record.name === 'string' ? record.name : '',
    email: typeof record.email === 'string' ? record.email : '',
    ...(typeof record.avatar === 'string' ? { avatar: record.avatar } : {}),
  }
}

function participants(value: unknown): Participant[] {
  const parsed = typeof value === 'string' ? parseJson<unknown>(value, []) : value
  return Array.isArray(parsed) ? parsed.map(participant) : []
}

function attachments(value: unknown): Attachment[] {
  const parsed = typeof value === 'string' ? parseJson<unknown>(value, []) : value
  if (!Array.isArray(parsed)) return []

  return parsed
    .filter((item): item is Row => Boolean(item) && typeof item === 'object')
    .map((item) => {
      const id = String(item.id ?? crypto.randomUUID())

      return {
        id,
        filename: String(item.filename ?? item.name ?? 'attachment'),
        contentType: String(item.contentType ?? item.content_type ?? 'application/octet-stream'),
        size: Number(item.size ?? 0),
        url: typeof item.url === 'string' ? item.url : `/api/attachments/${id}`,
        ...(typeof item.inline === 'boolean' ? { inline: item.inline } : {}),
        ...(typeof item.contentId === 'string'
          ? { contentId: item.contentId }
          : typeof item.content_id === 'string'
            ? { contentId: item.content_id }
            : {}),
      }
    })
}

function accountFromRow(row: Row): MailAccount {
  const status = String(row.sync_status ?? 'idle')
  let capabilities: MailAccount['capabilities'] = null
  try {
    capabilities = getAccountProvider(String(row.user_id), String(row.id)).capabilities
  } catch {
    // An unconfigured account must not advertise operations it cannot perform.
  }

  return {
    id: String(row.id),
    userId: String(row.user_id),
    name: String(row.name ?? ''),
    email: String(row.email ?? ''),
    provider: String(row.provider ?? 'mock') as ProviderType,
    color: String(row.color ?? '#6366f1'),
    syncStatus: ['idle', 'syncing', 'error', 'connected'].includes(status)
      ? (status as MailAccount['syncStatus'])
      : 'idle',
    lastSyncAt: typeof row.last_sync_at === 'string' ? row.last_sync_at : null,
    unreadCount: Number(row.unread_count ?? 0),
    signature: String(row.signature ?? ''),
    avatar: typeof row.avatar === 'string' ? row.avatar : null,
    capabilities,
  }
}

function settingsForUser(userId: string): UserSettings {
  const row = one('SELECT data_json FROM user_settings WHERE user_id = ?', [userId])
  const saved = parseJson<Partial<UserSettings>>(row?.data_json, {})
  return { ...DEFAULT_SETTINGS, ...saved }
}

function messageFromRow(row: Row, settings: UserSettings): MailMessage {
  const bodyHtml = String(row.body_html ?? '')
  const storedBodyText = String(row.body_text ?? '')
  let sanitizedHtml = ''
  let sanitizedStyles = ''
  let derivedBodyText = ''

  if (bodyHtml) {
    const sourceHash = createHash('sha256').update(bodyHtml).digest('base64url')
    const cacheKey = [
      String(row.user_id ?? ''),
      String(row.id),
      settings.remoteImages ? 'images' : 'no-images',
      settings.readReceipts ? 'receipts' : 'no-receipts',
      sourceHash,
    ].join('\0')
    const now = Date.now()
    const cached = presentationCache.get(cacheKey)

    if (cached && cached.expiresAt > now) {
      presentationCache.delete(cacheKey)
      presentationCache.set(cacheKey, cached)
      sanitizedHtml = cached.html
      sanitizedStyles = cached.styles
      derivedBodyText = storedBodyText ? '' : cached.plainText || htmlToPlainText(bodyHtml)
    } else {
      if (cached) {
        presentationCache.delete(cacheKey)
        presentationCacheBytes -= cached.bytes
      }

      sanitizedHtml = emailSanitizer.sanitizeEmailHtml(bodyHtml, settings.remoteImages, !settings.readReceipts)
      sanitizedStyles = emailSanitizer.sanitizeEmailStyles?.(bodyHtml) ?? ''
      derivedBodyText = storedBodyText ? '' : htmlToPlainText(bodyHtml)
      const bytes = Buffer.byteLength(sanitizedHtml) + Buffer.byteLength(sanitizedStyles)
        + Buffer.byteLength(derivedBodyText)

      if (bytes <= MAX_PRESENTATION_CACHE_BYTES) {
        presentationCache.set(cacheKey, {
          html: sanitizedHtml,
          styles: sanitizedStyles,
          plainText: derivedBodyText,
          expiresAt: now + PRESENTATION_CACHE_TTL_MS,
          bytes,
        })
        presentationCacheBytes += bytes

        while (
          presentationCache.size > MAX_PRESENTATION_CACHE_ENTRIES
          || presentationCacheBytes > MAX_PRESENTATION_CACHE_BYTES
        ) {
          const oldest = presentationCache.entries().next().value
          if (!oldest) break
          presentationCache.delete(oldest[0])
          presentationCacheBytes -= oldest[1].bytes
        }
      }
    }
  }

  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    accountId: String(row.account_id),
    from: participant(parseJson<unknown>(row.from_json, {})),
    to: participants(row.to_json),
    cc: participants(row.cc_json),
    bcc: participants(row.bcc_json),
    subject: String(row.subject ?? ''),
    preview: String(row.preview ?? ''),
    bodyText: storedBodyText || derivedBodyText,
    bodyHtml: sanitizedHtml,
    ...(sanitizedStyles ? { bodyStyles: sanitizedStyles } : {}),
    receivedAt: String(row.received_at ?? ''),
    isRead: Boolean(row.is_read),
    isStarred: Boolean(row.is_starred),
    isImportant: Boolean(row.is_important ?? 1),
    folder: String(row.folder ?? 'inbox') as MailFolder,
    labels: parseJson<string[]>(row.labels_json, []),
    attachments: attachments(row.attachments_json),
    snoozedUntil: typeof row.snoozed_until === 'string' ? row.snoozed_until : null,
    scheduledAt: typeof row.scheduled_at === 'string' ? row.scheduled_at : null,
    readReceipt: Boolean(row.read_receipt),
  }
}

function threadForUser(
  userId: string,
  threadId: string,
  settings?: UserSettings,
  accountId?: string,
  inbox?: SavedInbox | null,
): MailThread | null {
  const scope = inbox ? inboxMessagePredicate(inbox, 'messages') : null
  const rows = all(
    `SELECT * FROM messages
     WHERE user_id = ? AND thread_id = ?${accountId ? ' AND account_id = ?' : ''}${scope ? ` AND (${scope.sql})` : ''}
     ORDER BY received_at ASC, id ASC`,
    [userId, threadId, ...(accountId ? [accountId] : []), ...(scope?.params ?? [])],
  )

  if (rows.length === 0) return null

  const userSettings = settings ?? settingsForUser(userId)
  const uniqueRows = new Map<string, Row>()

  for (const row of rows) {
    const accountId = String(row.account_id)
    const providerId = typeof row.provider_id === 'string' && row.provider_id.trim()
      ? row.provider_id
      : ''
    const identity = providerId
      ? `provider\0${accountId}\0${providerId}`
      : `message\0${accountId}\0${String(row.id)}`
    const previous = uniqueRows.get(identity)

    if (!previous) {
      uniqueRows.set(identity, row)
      continue
    }

    const synchronizedId = `${accountId}:${providerId}`
    const preferred = String(row.id) === synchronizedId ? row : previous
    const fallback = preferred === row ? previous : row
    const stableId = String(previous.id) === synchronizedId ? row.id : previous.id
    const combinedAttachments = new Map<string, Attachment>()

    for (const attachment of [
      ...attachments(preferred.attachments_json),
      ...attachments(fallback.attachments_json),
    ]) {
      if (!combinedAttachments.has(attachment.id)) {
        combinedAttachments.set(attachment.id, attachment)
      }
    }

    const merged: Row = {
      ...preferred,
      id: stableId,
      received_at: String(previous.received_at ?? '') > String(row.received_at ?? '')
        ? previous.received_at
        : row.received_at,
      is_read: Number(Boolean(previous.is_read) && Boolean(row.is_read)),
      is_starred: Number(Boolean(previous.is_starred) || Boolean(row.is_starred)),
      is_important: Number(Boolean(previous.is_important ?? 1) || Boolean(row.is_important ?? 1)),
      read_receipt: Number(Boolean(previous.read_receipt) || Boolean(row.read_receipt)),
      labels_json: JSON.stringify(Array.from(new Set([
        ...parseJson<string[]>(preferred.labels_json, []),
        ...parseJson<string[]>(fallback.labels_json, []),
      ]))),
      attachments_json: JSON.stringify(Array.from(combinedAttachments.values())),
    }

    for (const field of ['subject', 'preview', 'body_text', 'body_html'] as const) {
      if (!String(preferred[field] ?? '').trim()) merged[field] = fallback[field]
    }

    for (const field of ['to_json', 'cc_json', 'bcc_json'] as const) {
      const recipients = new Map<string, Participant>()

      for (const person of [...participants(preferred[field]), ...participants(fallback[field])]) {
        const address = person.email.trim().toLowerCase()
        if (!recipients.has(address)) recipients.set(address, person)
      }

      merged[field] = JSON.stringify(Array.from(recipients.values()))
    }

    uniqueRows.set(identity, merged)
  }

  const messages = Array.from(uniqueRows.values())
    .sort((left, right) => {
      const leftReceivedAt = String(left.received_at ?? '')
      const rightReceivedAt = String(right.received_at ?? '')
      if (leftReceivedAt !== rightReceivedAt) return leftReceivedAt < rightReceivedAt ? -1 : 1

      const leftId = String(left.id)
      const rightId = String(right.id)
      return leftId === rightId ? 0 : leftId < rightId ? -1 : 1
    })
    .map((row) => messageFromRow(row, userSettings))
  const latest = messages[messages.length - 1]
  const uniqueParticipants = new Map<string, Participant>()

  for (const message of messages) {
    for (const person of [message.from, ...message.to]) {
      if (person.email) uniqueParticipants.set(person.email.toLowerCase(), person)
    }
  }
  const providerImportant = messages.some((message) => message.isImportant !== false)
  const isStarred = messages.some((message) => message.isStarred)
  const priority = getThreadPriority(userId, latest.accountId, threadId, providerImportant, isStarred)
  const needsAction = Boolean(one('SELECT 1 FROM action_threads WHERE user_id = ? AND account_id = ? AND thread_id = ?',
    [userId, latest.accountId, threadId]))
  const isQuarantined = Boolean(one('SELECT 1 FROM quarantined_threads WHERE user_id = ? AND account_id = ? AND thread_id = ?',
    [userId, latest.accountId, threadId]))

  return {
    id: threadId,
    accountId: latest.accountId,
    subject: latest.subject || messages[0].subject,
    preview: latest.preview,
    participants: Array.from(uniqueParticipants.values()),
    messages,
    messageCount: messages.length,
    lastMessageAt: latest.receivedAt,
    isRead: messages.every((message) => message.isRead),
    isStarred,
    isImportant: priority.isImportant || needsAction,
    needsAction,
    ...(isQuarantined ? { isQuarantined: true } : {}),
    ...((userSettings.personalizationMode ?? 'off') !== 'off' || priority.priorityOverride !== null || needsAction
      ? { priorityOverride: priority.priorityOverride, priority: priority.priority }
      : {}),
    folder: messages.some((message) => message.folder === 'inbox') ? 'inbox' : latest.folder,
    labels: Array.from(new Set(messages.flatMap((message) => message.labels))),
    hasAttachments: messages.some((message) => message.attachments.length > 0),
    snoozedUntil: latest.snoozedUntil ?? null,
    scheduledAt: latest.scheduledAt ?? null,
  }
}

async function composeBody(request: Request): Promise<Row | null> {
  const contentType = request.headers.get('content-type') ?? ''

  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    return request.json().then((body) => body as Row).catch(() => null)
  }

  try {
    const form = await request.formData()
    const body: Row = {}
    const uploaded: Row[] = []
    let totalSize = 0

    for (const [name, value] of form.entries() as IterableIterator<[string, Bun.FormDataEntryValue]>) {
      if (typeof value === 'string') {
        body[name] = value
        continue
      }

      if (name !== 'attachments') continue
      totalSize += value.size
      if (uploaded.length >= 20 || totalSize > 25 * 1024 * 1024) {
        throw new SendInputError('ATTACHMENT_LIMIT_EXCEEDED', '/attachments')
      }

      const id = crypto.randomUUID()
      uploaded.push({
        id,
        filename: value.name || 'attachment',
        contentType: value.type || 'application/octet-stream',
        size: value.size,
        url: `/api/attachments/${id}`,
        contentBase64: Buffer.from(await value.arrayBuffer()).toString('base64'),
      })
    }

    if (uploaded.length > 0) body.attachments = uploaded
    return body
  } catch (error) {
    if (error instanceof SendInputError) throw error
    return null
  }
}

function storedAttachments(value: unknown): Row[] {
  if (!Array.isArray(value)) return []

  return value
    .filter((item): item is Row => Boolean(item) && typeof item === 'object')
    .slice(0, 20)
    .map((item) => {
      const id = typeof item.id === 'string' && item.id ? item.id : crypto.randomUUID()
      const size = Number(item.size ?? 0)

      return {
        id,
        filename: String(item.filename ?? item.name ?? 'attachment'),
        contentType: String(item.contentType ?? item.content_type ?? 'application/octet-stream'),
        size: Number.isFinite(size) && size >= 0 ? size : 0,
        url: typeof item.url === 'string' ? item.url : `/api/attachments/${id}`,
        ...(typeof item.inline === 'boolean' ? { inline: item.inline } : {}),
        ...(typeof item.contentId === 'string' ? { contentId: item.contentId } : {}),
        ...(typeof item.contentBase64 === 'string' ? { contentBase64: item.contentBase64 } : {}),
      }
    })
}

function recipientList(value: unknown): Participant[] {
  if (Array.isArray(value)) return value.map(participant)
  if (typeof value !== 'string' || value.trim() === '') return []

  return value
    .split(/[,;]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const named = entry.match(/^(.*?)\s*<([^<>]+)>$/)
      const email = named?.[2].trim() ?? entry
      return { name: named?.[1].trim().replace(/^"|"$/g, '') ?? '', email }
    })
}

function plainText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .trim()
}

function htmlBody(value: string): string {
  if (/<[a-z][\s\S]*>/i.test(value)) return emailSanitizer.sanitizeEmailHtml(value)

  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')
}

function insertMessage(input: {
  id: string
  threadId: string
  accountId: string
  userId: string
  from: Participant
  to: Participant[]
  cc: Participant[]
  bcc: Participant[]
  subject: string
  body: string
  folder: MailFolder
  receivedAt: string
  scheduledAt?: string | null
  readReceipt?: boolean
  attachments?: Row[]
}): void {
  const text = plainText(input.body)

  run(
    `INSERT INTO messages (
       id, thread_id, account_id, user_id, from_json, to_json, cc_json, bcc_json,
       subject, preview, body_text, body_html, received_at, is_read, is_starred,
       folder, labels_json, attachments_json, scheduled_at, read_receipt
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.threadId,
      input.accountId,
      input.userId,
      JSON.stringify(input.from),
      JSON.stringify(input.to),
      JSON.stringify(input.cc),
      JSON.stringify(input.bcc),
      input.subject,
      text.slice(0, 240),
      text,
      htmlBody(input.body),
      input.receivedAt,
      1,
      0,
      input.folder,
      '[]',
      JSON.stringify(input.attachments ?? []),
      input.scheduledAt ?? null,
      input.readReceipt ? 1 : 0,
    ],
  )
}

function cursorFor(row: Row, prioritySection: PrioritySectionMode): string {
  return Buffer.from(
    JSON.stringify({
      lastMessageAt: row.last_message_at,
      id: row.thread_id,
      accountId: row.account_id,
      ...(typeof row.priority_score === 'number' ? { priorityScore: row.priority_score } : {}),
      ...(prioritySection !== 'off' ? { priorityGroup: row.priority_group, prioritySection } : {}),
    }),
  ).toString('base64url')
}

function readCursor(value: string): {
  lastMessageAt: string; id: string; accountId?: string; priorityScore?: number
  priorityGroup?: 0 | 1; prioritySection?: PrioritySectionMode
} | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Row
    if (typeof parsed.lastMessageAt !== 'string' || typeof parsed.id !== 'string') return null
    if (parsed.accountId !== undefined && typeof parsed.accountId !== 'string') return null
    if (parsed.priorityScore !== undefined && (typeof parsed.priorityScore !== 'number'
      || !Number.isFinite(parsed.priorityScore) || parsed.priorityScore < 0 || parsed.priorityScore > 100)) return null
    if (parsed.priorityGroup !== undefined && parsed.priorityGroup !== 0 && parsed.priorityGroup !== 1) return null
    if (parsed.prioritySection !== undefined && parsed.prioritySection !== 'automatic'
      && parsed.prioritySection !== 'starred' && parsed.prioritySection !== 'needs-action' && parsed.prioritySection !== 'off') return null
    return {
      lastMessageAt: parsed.lastMessageAt,
      id: parsed.id,
      accountId: parsed.accountId,
      priorityScore: parsed.priorityScore as number | undefined,
      priorityGroup: parsed.priorityGroup as 0 | 1 | undefined,
      prioritySection: parsed.prioritySection as PrioritySectionMode | undefined,
    }
  } catch {
    return null
  }
}

router.use('*', async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null)

  if (!session?.user?.id) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  c.set('userId', session.user.id)
  const inboxId = c.req.query('inboxId')
  const inbox = inboxId ? inboxViews.get(session.user.id, inboxId) : null
  if (inboxId && !inbox) return c.json({ error: 'Inbox view not found' }, 404)
  c.set('inbox', inbox)
  await next()
})

router.get('/providers', (c) => c.json({ providers: enabledMailboxProviders }))

router.get('/inboxes', (c) => c.json(inboxViews.list(c.get('userId'))))

router.get('/accounts/:id/sources', async (c) => {
  const userId = c.get('userId')
  const accountId = c.req.param('id')
  if (!one('SELECT id FROM mail_accounts WHERE id = ? AND user_id = ?', [accountId, userId])) {
    return c.json({ error: 'Account not found' }, 404)
  }
  try {
    return c.json(await discoverMailSources(await getReadyAccountProvider(userId, accountId)))
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Unable to discover mail sources' }, folderProviderStatus(error))
  }
})

router.post('/inboxes', async (c) => {
  const userId = c.get('userId')
  const input = await c.req.json<SavedInboxInput>().catch(() => null)
  if (!input || typeof input.accountId !== 'string') return c.json({ error: 'An account is required' }, 400)
  if (!one('SELECT id FROM mail_accounts WHERE id = ? AND user_id = ?', [input.accountId, userId])) {
    return c.json({ error: 'Account not found' }, 404)
  }
  try {
    const sources = await discoverMailSources(await getReadyAccountProvider(userId, input.accountId))
    const inbox = sqlite.transaction(() => {
      const view = inboxViews.create(userId, input, sources)
      enableConnectionInboxViews(userId, input.accountId)
      return view
    })()
    void synchronizeAccount(userId, input.accountId).catch(() => {})
    return c.json(inbox, 201)
  } catch (error) {
    if (error instanceof InboxViewError) return c.json({ error: error.message }, error.status)
    return c.json({ error: error instanceof Error ? error.message : 'Unable to create inbox' }, folderProviderStatus(error))
  }
})

router.delete('/inboxes/:id', (c) => {
  if (!inboxViews.delete(c.get('userId'), c.req.param('id'))) return c.json({ error: 'Inbox view not found' }, 404)
  return c.body(null, 204)
})

router.get('/openapi.json', (c) => c.json(openApiDocument))

router.get('/accounts', (c) => {
  const rows = all(
    `SELECT a.*,
       (SELECT COUNT(*) FROM messages m
         WHERE m.user_id = a.user_id AND m.account_id = a.id
           AND m.folder = 'inbox' AND m.is_read = 0
           AND NOT EXISTS (SELECT 1 FROM quarantined_threads q
             WHERE q.user_id = m.user_id AND q.account_id = m.account_id AND q.thread_id = m.thread_id)) AS unread_count
     FROM mail_accounts a
     WHERE a.user_id = ?
     ORDER BY a.created_at DESC, a.name ASC`,
    [c.get('userId')],
  )

  return c.json(rows.map(accountFromRow))
})

router.post('/accounts', async (c) => {
  const body = await c.req.json<Row>().catch(() => null)
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
  const provider = body?.provider

  if (!name || !EMAIL_ADDRESS.test(email) || !PROVIDERS.includes(provider as ProviderType)) {
    return c.json({ error: 'A valid name, email, and provider are required' }, 400)
  }

  if (!isMailboxProviderEnabled(provider as ProviderType)) {
    return c.json({ error: `The ${String(provider)} mailbox provider is not enabled` }, 403)
  }

  if (body?.color !== undefined && typeof body.color !== 'string') {
    return c.json({ error: 'Account color must be a string' }, 400)
  }

  const id = crypto.randomUUID()
  const userId = c.get('userId')
  const credentials = body?.credentials
  const encrypted =
    credentials === undefined || credentials === null
      ? null
      : encryptCredential(
          typeof credentials === 'string' ? credentials : JSON.stringify(credentials),
          userId,
          id,
        )

  run(
    `INSERT INTO mail_accounts
       (id, user_id, name, email, provider, color, credentials_encrypted, sync_status, signature)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      userId,
      name,
      email,
      provider as string,
      typeof body?.color === 'string' && body.color.trim() ? body.color.trim() : '#6366f1',
      encrypted,
      provider === 'mock' ? 'connected' : 'idle',
      typeof body?.signature === 'string' ? body.signature : '',
    ],
  )

  const account = one('SELECT * FROM mail_accounts WHERE id = ? AND user_id = ?', [id, userId])

  if (encrypted && provider !== 'mock') {
    void synchronizeAccount(userId, id, { folder: 'inbox', limit: 50 }).catch((error: unknown) => {
      console.error(`Initial ${String(provider)} synchronization failed:`,
        error instanceof Error ? error.message : 'Unknown provider error')
    })
  }

  return c.json(accountFromRow(account!), 201)
})

router.delete('/accounts/:id', (c) => {
  const result = run('DELETE FROM mail_accounts WHERE id = ? AND user_id = ?', [
    c.req.param('id'),
    c.get('userId'),
  ])

  if (result.changes === 0) return c.json({ error: 'Account not found' }, 404)
  return c.body(null, 204)
})

router.get('/accounts/:id/capabilities', (c) => {
  const userId = c.get('userId')
  const accountId = c.req.param('id')
  if (!one('SELECT id FROM mail_accounts WHERE id = ? AND user_id = ?', [accountId, userId])) {
    return c.json({ error: 'Account not found' }, 404)
  }

  try {
    const provider = getAccountProvider(userId, accountId)
    return c.json({ provider: provider.type, capabilities: provider.capabilities })
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'The provider is not configured',
    }, error instanceof ProviderError && error.code === 'AUTHENTICATION' ? 401 : 400)
  }
})

router.get('/accounts/:id/folders', async (c) => {
  const userId = c.get('userId')
  const accountId = c.req.param('id')
  if (!one('SELECT id FROM mail_accounts WHERE id = ? AND user_id = ?', [accountId, userId])) {
    return c.json({ error: 'Account not found' }, 404)
  }

  try {
    const provider = await getReadyAccountProvider(userId, accountId)
    const folders = await provider.listFolders()
    return c.json({
      provider: provider.type,
      capabilities: { createFolders: provider.capabilities.createFolders },
      folders,
    })
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Unable to list account folders' },
      folderProviderStatus(error))
  }
})

router.post('/accounts/:id/folders', async (c) => {
  const userId = c.get('userId')
  const accountId = c.req.param('id')
  if (!one('SELECT id FROM mail_accounts WHERE id = ? AND user_id = ?', [accountId, userId])) {
    return c.json({ error: 'Account not found' }, 404)
  }

  const body = await c.req.json<Row>().catch(() => null)
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) {
    return c.json({ error: 'Folder names must contain 1-100 characters and no control characters' }, 400)
  }

  try {
    const provider = await getReadyAccountProvider(userId, accountId)
    if (!provider.capabilities.createFolders) {
      return c.json({ error: 'This account does not support folder creation' }, 409)
    }
    return c.json(await provider.createFolder(name), 201)
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Unable to create the account folder' },
      folderProviderStatus(error))
  }
})

router.post('/accounts/:id/sync', async (c) => {
  const userId = c.get('userId')
  const accountId = c.req.param('id')
  if (!one('SELECT id FROM mail_accounts WHERE id = ? AND user_id = ?', [accountId, userId])) {
    return c.json({ error: 'Account not found' }, 404)
  }

  const body: Row = await c.req.json<Row>().catch((): Row => ({}))
  const folder = typeof body.folder === 'string' ? body.folder : 'inbox'
  if (!FOLDERS.includes(folder as MailFolder)) return c.json({ error: 'Invalid folder' }, 400)
  const limit = typeof body.limit === 'number' ? Math.max(1, Math.min(100, body.limit)) : 50

  try {
    const result = await synchronizeAccount(userId, accountId, {
      folder: folder as MailFolder,
      limit,
      reset: body.reset === true,
    })
    return c.json({
      accountId,
      synchronized: result.messages.length,
      deleted: result.deletedMessageIds.length,
      hasMore: result.hasMore,
      fullSync: result.fullSync,
    })
  } catch (error) {
    const status = error instanceof ProviderError && error.code === 'AUTHENTICATION' ? 401 : 502
    return c.json({ error: error instanceof Error ? error.message : 'Provider synchronization failed' }, status)
  }
})

router.get('/threads', (c) => {
  const userId = c.get('userId')
  const inbox = c.get('inbox')
  const scope = inbox ? inboxMessagePredicate(inbox, 'm') : null
  const prefix = scope ? `WITH messages AS (SELECT m.* FROM main.messages m WHERE ${scope.sql}) ` : ''
  const scopedAll = (sql: string, params: Bindings) => all(prefix + sql, [...(scope?.params ?? []), ...params])
  const scopedOne = (sql: string, params: Bindings) => one(prefix + sql, [...(scope?.params ?? []), ...params])
  const accountId = c.req.query('accountId')?.trim()
  const folder = c.req.query('folder')?.trim() || 'inbox'
  const category = c.req.query('category')
  const label = c.req.query('label')?.trim()
  const search = c.req.query('search')?.trim()
  const sort = c.req.query('sort')?.trim() || 'newest'
  const prioritySection = c.req.query('prioritySection') ?? 'off'
  const rawLimit = Number(c.req.query('limit') ?? '30')
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, Math.trunc(rawLimit))) : 30
  const cursorValue = c.req.query('cursor')
  const cursor = cursorValue ? readCursor(cursorValue) : null

  if (!FOLDERS.includes(folder as MailFolder)) {
    return c.json({ error: 'Invalid folder' }, 400)
  }
  if (category !== undefined && (folder !== 'inbox' || !['important', 'other', 'quarantine'].includes(category))) {
    return c.json({ error: 'Category must be important, other, or quarantine and is only available for the inbox' }, 400)
  }
  if (!['newest', 'oldest', 'priority'].includes(sort)) {
    return c.json({ error: 'Invalid sort order' }, 400)
  }
  if (prioritySection !== 'automatic' && prioritySection !== 'starred' && prioritySection !== 'needs-action' && prioritySection !== 'off'
    || (c.req.queries('prioritySection')?.length ?? 0) > 1) {
    return c.json({ error: 'Priority section must be automatic, starred, needs-action, or off' }, 400)
  }
  if (prioritySection !== 'off' && (folder !== 'inbox' || category !== 'important'
    || c.req.query('search') !== undefined || c.req.query('label') !== undefined)) {
    return c.json({ error: 'Priority section is only available for the Important inbox without search or labels' }, 400)
  }

  if (cursorValue && !cursor) return c.json({ error: 'Invalid cursor' }, 400)
  if (cursor && ((cursor.prioritySection ?? 'off') !== prioritySection
    || (prioritySection === 'off' ? cursor.priorityGroup !== undefined
      : cursor.priorityGroup === undefined || cursor.accountId === undefined))) {
    return c.json({ error: 'Invalid priority section cursor' }, 400)
  }
  if (sort === 'priority' && cursor && cursor.priorityScore === undefined) {
    return c.json({ error: 'Invalid priority cursor' }, 400)
  }
  const settings = settingsForUser(userId)
  refreshPriorities(userId, accountId)

  const conditions = ['m.user_id = ?']
  const bindings: Bindings = [userId]
  const quarantined = `EXISTS (SELECT 1 FROM quarantined_threads q
    WHERE q.user_id = m.user_id AND q.account_id = m.account_id AND q.thread_id = m.thread_id)`

  if (accountId) {
    conditions.push('m.account_id = ?')
    bindings.push(accountId)
  }

  if (folder === 'inbox') {
    conditions.push(`(m.folder = 'inbox' OR ${quarantined})`)
  } else if (folder === 'starred') {
    conditions.push('m.is_starred = 1', "m.folder NOT IN ('trash', 'spam')")
  } else if (folder === 'snoozed') {
    conditions.push("(m.folder = 'snoozed' OR m.snoozed_until > ?)")
    bindings.push(new Date().toISOString())
  } else if (folder === 'scheduled') {
    conditions.push("(m.folder = 'scheduled' OR m.scheduled_at IS NOT NULL)")
  } else {
    conditions.push('m.folder = ?')
    bindings.push(folder)
  }
  if (folder !== 'inbox') conditions.push(`NOT ${quarantined}`)

  if (search) {
    const compiled = compileMailSearch(search)
    if (compiled.sql) {
      conditions.push(`(${compiled.sql})`)
      bindings.push(...compiled.params)
    }
  }

  if (label) {
    conditions.push('EXISTS (SELECT 1 FROM json_each(m.labels_json) entry WHERE entry.value = ?)')
    bindings.push(label)
  }

  const where = conditions.join(' AND ')
  const starred = `EXISTS (
    SELECT 1 FROM messages conversation
    WHERE conversation.user_id = m.user_id AND conversation.account_id = m.account_id
      AND conversation.thread_id = m.thread_id AND conversation.is_starred = 1
  )`
  const providerImportant = `EXISTS (
    SELECT 1 FROM messages conversation
    WHERE conversation.user_id = m.user_id AND conversation.account_id = m.account_id
      AND conversation.thread_id = m.thread_id AND conversation.is_important = 1
  )`
  const priorityScore = `CASE WHEN p.override_category IS NULL AND ${starred}
    AND ${settings.personalizationMode === 'suggest' || settings.personalizationMode === 'adaptive' ? 1 : 0} THEN 95
    ELSE COALESCE(p.score, CASE WHEN ${providerImportant} THEN 70 ELSE 30 END) END`
  const needsAction = `EXISTS (SELECT 1 FROM action_threads action
    WHERE action.user_id = m.user_id AND action.account_id = m.account_id AND action.thread_id = m.thread_id)`
  const priorityGroup = prioritySection === 'needs-action' ? needsAction
    : prioritySection === 'automatic' ? `${needsAction} OR ${starred} OR (${priorityScore}) >= 85` : starred
  // Classification includes the entire owned conversation, not just matching inbox messages.
  const matchingThreads = `
    SELECT m.account_id, m.thread_id, (SELECT MAX(conversation.received_at) FROM messages conversation
      WHERE conversation.user_id = m.user_id AND conversation.account_id = m.account_id
        AND conversation.thread_id = m.thread_id) AS last_message_at
      ${folder === 'inbox' ? `, ${quarantined} AS in_quarantine` : ''}
      ${folder === 'inbox' ? `, (${needsAction} OR ${starred} OR (${priorityScore}) >= 85 OR COALESCE(
        p.override_category,
        ${settings.personalizationMode === 'adaptive' ? 'p.learned_category' : 'NULL'},
        CASE WHEN ${providerImportant} THEN 'important' ELSE 'other' END
      ) = 'important') AS in_important` : ''}
      ${sort === 'priority' ? `, ${priorityScore} AS priority_score` : ''}
      ${prioritySection !== 'off' ? `, (${priorityGroup}) AS priority_group` : ''}
    FROM messages m
    LEFT JOIN thread_priorities p ON p.user_id = m.user_id AND p.account_id = m.account_id AND p.thread_id = m.thread_id
    WHERE ${where}
    GROUP BY m.account_id, m.thread_id
  `
  const totals = scopedOne(
    `SELECT COUNT(*) AS total${folder === 'inbox'
      ? ', COALESCE(SUM(CASE WHEN NOT in_quarantine THEN in_important ELSE 0 END), 0) AS important, COALESCE(SUM(CASE WHEN NOT in_quarantine THEN 1 - in_important ELSE 0 END), 0) AS other, COALESCE(SUM(in_quarantine), 0) AS quarantine'
      : ''}
      ${prioritySection !== 'off' ? ', COALESCE(SUM(CASE WHEN NOT in_quarantine AND in_important THEN priority_group ELSE 0 END), 0) AS priority_count' : ''}
     FROM (${matchingThreads})`,
    bindings,
  )!
  const categoryCounts = folder === 'inbox'
    ? { important: Number(totals.important), other: Number(totals.other), ...(Number(totals.quarantine) > 0 ? { quarantine: Number(totals.quarantine) } : {}) }
    : undefined
  const total = categoryCounts
    ? category === 'quarantine' ? Number(totals.quarantine)
      : category === 'important' || category === 'other' ? categoryCounts[category]
        : categoryCounts.important + categoryCounts.other
    : Number(totals.total)

  const direction = sort === 'oldest' ? 'ASC' : 'DESC'
  const comparison = sort === 'oldest' ? '>' : '<'
  const pageConditions: string[] = []
  const pageBindings = [...bindings]
  if (folder === 'inbox') pageConditions.push(category === 'quarantine' ? 'in_quarantine = 1' : 'in_quarantine = 0')
  if (category === 'important' || category === 'other') {
    pageConditions.push('in_important = ?')
    pageBindings.push(Number(category === 'important'))
  }
  if (cursor) {
    let cursorCondition: string
    if (prioritySection !== 'off') pageBindings.push(cursor.priorityGroup!, cursor.priorityGroup!)
    if (sort === 'priority') {
      cursorCondition = cursor.accountId === undefined
        ? '(priority_score, last_message_at, thread_id) < (?, ?, ?)'
        : '(priority_score, last_message_at, thread_id, account_id) < (?, ?, ?, ?)'
      pageBindings.push(cursor.priorityScore!, cursor.lastMessageAt, cursor.id)
    } else {
      cursorCondition = cursor.accountId === undefined
        ? `(last_message_at, thread_id) ${comparison} (?, ?)`
        : `(last_message_at, thread_id, account_id) ${comparison} (?, ?, ?)`
      pageBindings.push(cursor.lastMessageAt, cursor.id)
    }
    if (cursor.accountId !== undefined) pageBindings.push(cursor.accountId)
    // The section always descends, even when the selected date order ascends.
    pageConditions.push(prioritySection !== 'off'
      ? `(priority_group < ? OR (priority_group = ? AND ${cursorCondition}))`
      : cursorCondition)
  }
  pageBindings.push(limit + 1)

  const page = scopedAll(
    `SELECT * FROM (${matchingThreads})
     ${pageConditions.length ? `WHERE ${pageConditions.join(' AND ')}` : ''}
      ORDER BY ${prioritySection !== 'off' ? 'priority_group DESC, ' : ''}${sort === 'priority' ? 'priority_score DESC, ' : ''}last_message_at ${direction}, thread_id ${direction}, account_id ${direction}
     LIMIT ?`,
    pageBindings,
  )

  const visible = page.slice(0, limit)
  const threads = visible
    .map((row) => threadForUser(userId, String(row.thread_id), settings, String(row.account_id), inbox))
    .filter((thread): thread is MailThread => thread !== null)

  const countConditions = ['user_id = ?', `NOT EXISTS (SELECT 1 FROM quarantined_threads q
    WHERE q.user_id = messages.user_id AND q.account_id = messages.account_id AND q.thread_id = messages.thread_id)`]
  const countBindings: Bindings = [userId]
  if (accountId) {
    countConditions.push('account_id = ?')
    countBindings.push(accountId)
  }

  const counts: Partial<Record<MailFolder, number>> = Object.fromEntries(
    FOLDERS.map((name) => [name, 0]),
  )

  for (const row of scopedAll(
    `SELECT folder, COUNT(DISTINCT thread_id) AS count
     FROM messages
     WHERE ${countConditions.join(' AND ')}
     GROUP BY folder`,
    countBindings,
  )) {
    if (FOLDERS.includes(row.folder as MailFolder)) {
      counts[row.folder as MailFolder] = Number(row.count)
    }
  }

  counts.starred = Number(
    scopedOne(
      `SELECT COUNT(DISTINCT thread_id) AS count FROM messages
       WHERE ${countConditions.join(' AND ')} AND is_starred = 1
         AND folder NOT IN ('trash', 'spam')`,
      countBindings,
    )?.count ?? 0,
  )

  return c.json({
    threads,
    nextCursor: page.length > limit ? cursorFor(visible[visible.length - 1], prioritySection) : null,
    counts,
    ...(categoryCounts ? { categoryCounts } : {}),
    ...(prioritySection !== 'off' ? { priorityCount: Number(totals.priority_count) } : {}),
    total,
  })
})

router.get('/threads/:id', (c) => {
  const thread = threadForUser(c.get('userId'), c.req.param('id'), undefined, undefined, c.get('inbox'))
  if (!thread) return c.json({ error: 'Thread not found' }, 404)
  return c.json(thread)
})

router.post('/threads/:id/attention', async (c) => {
  const body = await c.req.json<Row>().catch(() => null)
  if (!body || Array.isArray(body) || Object.keys(body).some((key) => key !== 'activeMilliseconds')
    || !Number.isInteger(body.activeMilliseconds) || Number(body.activeMilliseconds) < 0
    || Number(body.activeMilliseconds) > 120_000) {
    return c.json({ error: 'Provide between 0 and 120000 active milliseconds' }, 400)
  }
  const userId = c.get('userId')
  const threadId = c.req.param('id')
  const accounts = all('SELECT DISTINCT account_id FROM messages WHERE user_id = ? AND thread_id = ?', [userId, threadId])
  if (accounts.length === 0) return c.json({ error: 'Thread not found' }, 404)
  if (Number(body.activeMilliseconds) >= 5_000) {
    for (const account of accounts) {
      if (one('SELECT 1 FROM quarantined_threads WHERE user_id = ? AND account_id = ? AND thread_id = ?',
        [userId, String(account.account_id), threadId])) continue
      if (!one("SELECT 1 FROM messages WHERE user_id = ? AND account_id = ? AND thread_id = ? AND folder NOT IN ('spam', 'trash') LIMIT 1",
        [userId, String(account.account_id), threadId])) continue
      recordPrioritySignal(userId, String(account.account_id), threadId, 'attention', Number(body.activeMilliseconds))
    }
  }
  return c.body(null, 204)
})

router.post('/threads/:id/irrelevant', (c) => {
  if (c.get('inbox')) return c.json({ error: 'Use the connection view for conversation-wide feedback' }, 409)
  const userId = c.get('userId')
  const threadId = c.req.param('id')
  let updated: number

  try {
    updated = sqlite.transaction(() => {
      const changes = updateMessagesAndQueueMutations(userId, [threadId], ['folder = ?'], ['archive'])
      if (changes === 0) return 0

      const messages = all(
        `SELECT id, account_id, thread_id, from_json, subject, preview
         FROM messages WHERE user_id = ? AND thread_id = ?`,
        [userId, threadId],
      )
      const labeledAt = new Date().toISOString()

      for (const message of messages) {
        const senderEmail = participant(parseJson<unknown>(message.from_json, {}))
          .email.trim().toLowerCase()
        const separator = senderEmail.lastIndexOf('@')
        const senderDomain = separator < 0 ? '' : senderEmail.slice(separator + 1)

        run(
          `INSERT INTO irrelevant_messages
             (id, user_id, account_id, message_id, thread_id, sender_email,
              sender_domain, subject, preview, labeled_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, message_id) DO UPDATE SET
             account_id = excluded.account_id,
             thread_id = excluded.thread_id,
             sender_email = excluded.sender_email,
             sender_domain = excluded.sender_domain,
             subject = excluded.subject,
             preview = excluded.preview,
             labeled_at = excluded.labeled_at`,
          [
            crypto.randomUUID(),
            userId,
            String(message.account_id),
            String(message.id),
            String(message.thread_id),
            senderEmail,
            senderDomain,
            String(message.subject ?? ''),
            String(message.preview ?? ''),
            labeledAt,
          ],
        )
      }
      for (const accountId of new Set(messages.map((message) => String(message.account_id)))) {
        recordPrioritySignal(userId, accountId, threadId, 'irrelevant')
      }

      return changes
    })()
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error
    return c.json({ error: error.message },
      error.code === 'UNSUPPORTED_OPERATION' ? 409 : folderProviderStatus(error))
  }

  if (updated === 0) return c.json({ error: 'Thread not found' }, 404)
  requestMailJobProcessing()
  return c.json(threadForUser(userId, threadId)!)
})

router.get('/irrelevant', (c) => {
  const examples = all(
    `SELECT id, message_id, thread_id, account_id, sender_email, sender_domain,
            subject, preview, labeled_at
     FROM irrelevant_messages
     WHERE user_id = ?
     ORDER BY labeled_at DESC, id DESC`,
    [c.get('userId')],
  ).map((row) => ({
    id: String(row.id),
    messageId: String(row.message_id),
    threadId: String(row.thread_id),
    accountId: String(row.account_id),
    senderEmail: String(row.sender_email),
    senderDomain: String(row.sender_domain),
    subject: String(row.subject),
    preview: String(row.preview),
    labeledAt: String(row.labeled_at),
  }))

  return c.json({ examples })
})

router.get('/personalization', (c) => c.json(getPersonalizationStatus(c.get('userId'))))

router.post('/personalization/reset', async (c) => {
  const body = await c.req.json<Row>().catch(() => null)
  if (!body || body.confirm !== true) return c.json({ error: 'Confirm that you want to reset private learning' }, 400)
  const userId = c.get('userId')
  resetPersonalization(userId)
  return c.json(getPersonalizationStatus(userId))
})

router.patch('/threads/:id', async (c) => {
  const body = await c.req.json<Row>().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'A JSON object is required' }, 400)

  const changes: string[] = []
  const bindings: Bindings = []
  const priorityChanges: { priorityOverride?: InboxCategory | null; clearIrrelevant?: boolean; isQuarantined?: boolean; needsAction?: boolean } = {}
  if ('needsAction' in body) {
    if (typeof body.needsAction !== 'boolean') return c.json({ error: 'needsAction must be a boolean' }, 400)
    priorityChanges.needsAction = body.needsAction
  }
  if ('isQuarantined' in body) {
    if (typeof body.isQuarantined !== 'boolean') return c.json({ error: 'Invalid quarantine status' }, 400)
    priorityChanges.isQuarantined = body.isQuarantined
  }
  if ('priorityOverride' in body) {
    if (body.priorityOverride !== null && body.priorityOverride !== 'important' && body.priorityOverride !== 'other') {
      return c.json({ error: 'Priority must be important, other, or automatic' }, 400)
    }
    priorityChanges.priorityOverride = body.priorityOverride as InboxCategory | null
  }
  if ('clearIrrelevant' in body) {
    if (typeof body.clearIrrelevant !== 'boolean') return c.json({ error: 'Invalid irrelevant-feedback correction' }, 400)
    priorityChanges.clearIrrelevant = body.clearIrrelevant
  }

  if ('isRead' in body) {
    if (typeof body.isRead !== 'boolean') return c.json({ error: 'isRead must be a boolean' }, 400)
    changes.push('is_read = ?')
    bindings.push(body.isRead ? 1 : 0)
  }

  if ('isStarred' in body) {
    if (typeof body.isStarred !== 'boolean') {
      return c.json({ error: 'isStarred must be a boolean' }, 400)
    }
    changes.push('is_starred = ?')
    bindings.push(body.isStarred ? 1 : 0)
  }

  if ('folder' in body) {
    if (!MUTATION_FOLDERS.includes(body.folder as MailFolder)) return c.json({ error: 'Invalid mutation folder' }, 400)
    changes.push('folder = ?')
    bindings.push(body.folder as string)
  }

  if ('snoozedUntil' in body) {
    if (
      body.snoozedUntil !== null &&
      (typeof body.snoozedUntil !== 'string' || Number.isNaN(Date.parse(body.snoozedUntil)))
    ) {
      return c.json({ error: 'Invalid snooze date' }, 400)
    }
    changes.push('snoozed_until = ?')
    bindings.push(body.snoozedUntil as string | null)
  }

  if ('labels' in body) {
    if (!Array.isArray(body.labels) || !body.labels.every((label) => typeof label === 'string')) {
      return c.json({ error: 'labels must be an array of strings' }, 400)
    }
    changes.push('labels_json = ?')
    bindings.push(JSON.stringify(Array.from(new Set(body.labels))))
  }

  if (changes.length === 0 && !('priorityOverride' in priorityChanges) && !priorityChanges.clearIrrelevant && !('isQuarantined' in priorityChanges) && !('needsAction' in priorityChanges)) {
    return c.json({ error: 'No supported changes provided' }, 400)
  }

  const userId = c.get('userId')
  const threadId = c.req.param('id')
  let updated: number
  const selected = mutationSelection(userId, c.get('inbox'), [threadId], body.messageIds)
  if (selected.error) return c.json({ error: selected.error }, 400)
  if (c.get('inbox') && Object.keys(priorityChanges).length) {
    return c.json({ error: 'Use the connection view for conversation-wide feedback' }, 409)
  }
  try {
    updated = updateMessagesAndQueueMutations(userId, [threadId], changes, bindings, priorityChanges, selected.ids)
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error
    return c.json({ error: error.message },
      error.code === 'UNSUPPORTED_OPERATION' ? 409 : folderProviderStatus(error))
  }

  if (updated === 0) return c.json({ error: 'Thread not found' }, 404)
  if (changes.length || 'isQuarantined' in priorityChanges) requestMailJobProcessing()
  return c.json(threadForUser(userId, threadId, undefined, undefined, c.get('inbox'))!)
})

router.post('/threads/bulk', async (c) => {
  const body = await c.req.json<Row>().catch(() => null)
  const requestedIds = body?.ids ?? body?.threadIds

  if (
    !body ||
    !Array.isArray(requestedIds) ||
    requestedIds.length === 0 ||
    requestedIds.length > 500 ||
    !requestedIds.every((id) => typeof id === 'string' && id.length > 0)
  ) {
    return c.json({ error: 'Provide between 1 and 500 thread IDs' }, 400)
  }

  const ids = Array.from(new Set(requestedIds as string[]))
  const assignments: string[] = []
  const bindings: Bindings = []
  const priorityChanges: { priorityOverride?: InboxCategory | null; clearIrrelevant?: boolean; isQuarantined?: boolean; needsAction?: boolean } = {}
  const patch =
    body.changes && typeof body.changes === 'object' && !Array.isArray(body.changes)
      ? (body.changes as Row)
      : null

  if (patch) {
    if ('needsAction' in patch) {
      if (typeof patch.needsAction !== 'boolean') return c.json({ error: 'needsAction must be a boolean' }, 400)
      priorityChanges.needsAction = patch.needsAction
    }
    if ('isQuarantined' in patch) {
      if (typeof patch.isQuarantined !== 'boolean') return c.json({ error: 'Invalid quarantine status' }, 400)
      priorityChanges.isQuarantined = patch.isQuarantined
    }
    if ('priorityOverride' in patch) {
      if (patch.priorityOverride !== null && patch.priorityOverride !== 'important' && patch.priorityOverride !== 'other') {
        return c.json({ error: 'Priority must be important, other, or automatic' }, 400)
      }
      priorityChanges.priorityOverride = patch.priorityOverride as InboxCategory | null
    }
    if ('clearIrrelevant' in patch) {
      if (typeof patch.clearIrrelevant !== 'boolean') return c.json({ error: 'Invalid irrelevant-feedback correction' }, 400)
      priorityChanges.clearIrrelevant = patch.clearIrrelevant
    }
    if ('isRead' in patch) {
      if (typeof patch.isRead !== 'boolean') return c.json({ error: 'Invalid read status' }, 400)
      assignments.push('is_read = ?')
      bindings.push(Number(patch.isRead))
    }

    if ('isStarred' in patch) {
      if (typeof patch.isStarred !== 'boolean') return c.json({ error: 'Invalid star status' }, 400)
      assignments.push('is_starred = ?')
      bindings.push(Number(patch.isStarred))
    }

    if ('folder' in patch) {
      if (!MUTATION_FOLDERS.includes(patch.folder as MailFolder)) return c.json({ error: 'Invalid mutation folder' }, 400)
      assignments.push('folder = ?')
      bindings.push(patch.folder as string)
    }

    if ('snoozedUntil' in patch) {
      if (
        patch.snoozedUntil !== null &&
        (typeof patch.snoozedUntil !== 'string' || Number.isNaN(Date.parse(patch.snoozedUntil)))
      ) {
        return c.json({ error: 'Invalid snooze date' }, 400)
      }
      assignments.push('snoozed_until = ?')
      bindings.push(patch.snoozedUntil as string | null)
    }

    if ('labels' in patch) {
      if (!Array.isArray(patch.labels) || !patch.labels.every((label) => typeof label === 'string')) {
        return c.json({ error: 'Invalid labels' }, 400)
      }
      assignments.push('labels_json = ?')
      bindings.push(JSON.stringify(Array.from(new Set(patch.labels))))
    }

    if (assignments.length === 0 && !('priorityOverride' in priorityChanges) && !priorityChanges.clearIrrelevant && !('isQuarantined' in priorityChanges) && !('needsAction' in priorityChanges)) {
      return c.json({ error: 'No supported changes provided' }, 400)
    }
  } else {
    const action = typeof body.action === 'string' ? body.action : ''

    switch (action) {
      case 'read':
      case 'markRead':
      case 'mark_read':
        assignments.push('is_read = ?')
        bindings.push(typeof body.value === 'boolean' ? Number(body.value) : 1)
        break
      case 'unread':
      case 'markUnread':
      case 'mark_unread':
        assignments.push('is_read = 0')
        break
      case 'star':
      case 'starred':
        assignments.push('is_starred = ?')
        bindings.push(typeof body.value === 'boolean' ? Number(body.value) : 1)
        break
      case 'unstar':
        assignments.push('is_starred = 0')
        break
      case 'archive':
      case 'trash':
      case 'spam':
      case 'inbox':
        assignments.push('folder = ?')
        bindings.push(action)
        break
      case 'delete':
        assignments.push("folder = 'trash'")
        break
      case 'move':
      case 'folder':
        if (!MUTATION_FOLDERS.includes(body.value as MailFolder)) return c.json({ error: 'Invalid mutation folder' }, 400)
        assignments.push('folder = ?')
        bindings.push(body.value as string)
        break
      case 'snooze':
        if (typeof body.value !== 'string' || Number.isNaN(Date.parse(body.value))) {
          return c.json({ error: 'A valid snooze date is required' }, 400)
        }
        assignments.push('snoozed_until = ?', "folder = 'snoozed'")
        bindings.push(body.value)
        break
      case 'unsnooze':
        assignments.push('snoozed_until = NULL', "folder = 'inbox'")
        break
      case 'label':
      case 'labels': {
        const labels = Array.isArray(body.value)
          ? body.value
          : typeof body.value === 'string'
            ? [body.value]
            : null
        if (!labels || !labels.every((label) => typeof label === 'string')) {
          return c.json({ error: 'A label or array of labels is required' }, 400)
        }
        assignments.push('labels_json = ?')
        bindings.push(JSON.stringify(Array.from(new Set(labels))))
        break
      }
      default:
        return c.json({ error: 'Unsupported bulk action' }, 400)
    }
  }

  const userId = c.get('userId')
  const placeholders = ids.map(() => '?').join(', ')
  const owned = all(
    `SELECT DISTINCT thread_id FROM messages WHERE user_id = ? AND thread_id IN (${placeholders})`,
    [userId, ...ids],
  )

  if (owned.length !== ids.length) return c.json({ error: 'One or more threads were not found' }, 404)

  const selected = mutationSelection(userId, c.get('inbox'), ids, body.messageIds)
  if (selected.error) return c.json({ error: selected.error }, 400)
  if (c.get('inbox') && Object.keys(priorityChanges).length) {
    return c.json({ error: 'Use the connection view for conversation-wide feedback' }, 409)
  }
  try {
    updateMessagesAndQueueMutations(userId, ids, assignments, bindings, priorityChanges, selected.ids)
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error
    return c.json({ error: error.message },
      error.code === 'UNSUPPORTED_OPERATION' ? 409 : folderProviderStatus(error))
  }

  if (assignments.length || 'isQuarantined' in priorityChanges) requestMailJobProcessing()
  return c.json({ updated: ids.length, ids })
})

function sendProblem(error: unknown, stage: 'validation' | 'configuration' | 'dispatch', diagnosticId = crypto.randomUUID()) {
  const problem = mailFailure(error, stage, diagnosticId)
  console.warn('OpenMail send request failed', JSON.stringify({ diagnosticId, code: problem.code, stage }))
  return Response.json({
    type: `urn:openmail:problem:${problem.code.toLowerCase()}`,
    title: problem.error,
    detail: problem.error,
    instance: `urn:uuid:${diagnosticId}`,
    ...problem,
  }, { status: problem.status, headers: {
    'Content-Type': 'application/problem+json', 'X-Request-ID': diagnosticId,
    ...(problem.retryAfterSeconds !== undefined ? { 'Retry-After': String(problem.retryAfterSeconds) } : {}),
  } })
}

router.post('/send', async (c) => {
  const diagnosticId = crypto.randomUUID()
  c.header('X-Request-ID', diagnosticId)
  let body: Row | null
  let messageAttachments: ReturnType<typeof normalizeSendAttachments>
  try {
    body = await composeBody(c.req.raw)
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SendInputError('INVALID_SEND_REQUEST')
    messageAttachments = normalizeSendAttachments(body.attachments)
  } catch (error) {
    return sendProblem(error, 'validation', diagnosticId)
  }
  const userId = c.get('userId')
  const accountId = typeof body?.accountId === 'string' ? body.accountId : ''
  const to = recipientList(body?.to)
  const cc = recipientList(body?.cc)
  const bcc = recipientList(body?.bcc)

  for (const key of ['to', 'cc', 'bcc'] as const) {
    if (body[key] !== undefined && typeof body[key] !== 'string' && !Array.isArray(body[key])) {
      return sendProblem(new SendInputError('INVALID_SEND_REQUEST', `/${key}`), 'validation', diagnosticId)
    }
  }

  if (!accountId || to.length === 0) {
    return sendProblem(new SendInputError('INVALID_SEND_REQUEST', !accountId ? '/accountId' : '/to'), 'validation', diagnosticId)
  }
  for (const [key, recipients] of [['to', to], ['cc', cc], ['bcc', bcc]] as const) {
    if (!recipients.every((item) => EMAIL_ADDRESS.test(item.email) && !/[\r\n]/.test(item.name))) {
      return sendProblem(new SendInputError('INVALID_SEND_REQUEST', `/${key}`), 'validation', diagnosticId)
    }
  }

  if (body?.body !== undefined && typeof body.body !== 'string') {
    return sendProblem(new SendInputError('INVALID_SEND_REQUEST', '/body'), 'validation', diagnosticId)
  }
  if (body.subject !== undefined && typeof body.subject !== 'string') {
    return sendProblem(new SendInputError('INVALID_SEND_REQUEST', '/subject'), 'validation', diagnosticId)
  }
  const mode = body.mode === undefined ? 'compose' : body.mode
  if (typeof mode !== 'string' || !['compose', 'reply', 'replyAll', 'forward'].includes(mode)) {
    return sendProblem(new SendInputError('INVALID_SEND_MODE', '/mode'), 'validation', diagnosticId)
  }

  const account = one('SELECT * FROM mail_accounts WHERE id = ? AND user_id = ?', [accountId, userId])
  if (!account) return sendProblem(new SendInputError('ACCOUNT_NOT_FOUND', '/accountId'), 'validation', diagnosticId)
  let senderEmail = String(account.email)
  const inbox = typeof body.inboxId === 'string' ? inboxViews.get(userId, body.inboxId) : null
  if (body.inboxId !== undefined) {
    if (!inbox || inbox.accountId !== accountId) return sendProblem(new SendInputError('INVALID_SEND_REQUEST', '/inboxId'), 'validation', diagnosticId)
    if (!inbox.defaultSender) return sendProblem(new SendInputError('SEND_UNSUPPORTED', '/inboxId'), 'configuration', diagnosticId)
    try {
      const sources = await discoverMailSources(await getReadyAccountProvider(userId, accountId))
      if (!sources.identities.some((identity) => identity.email.toLowerCase() === inbox.defaultSender)) {
        return sendProblem(new SendInputError('SEND_UNSUPPORTED', '/inboxId'), 'configuration', diagnosticId)
      }
    } catch (error) { return sendProblem(error, 'configuration', diagnosticId) }
    senderEmail = inbox.defaultSender
  }

  if (account.provider !== 'mock') {
    try {
      const provider = getAccountProvider(userId, accountId)
      if (!provider.capabilities.send) {
        return sendProblem(new SendInputError('SEND_UNSUPPORTED', '/accountId'), 'configuration', diagnosticId)
      }
      if ((mode === 'reply' || mode === 'replyAll') && !provider.capabilities.reply) {
        return sendProblem(new SendInputError('REPLY_UNSUPPORTED', '/mode'), 'configuration', diagnosticId)
      }
    } catch (error) {
      return sendProblem(error, 'configuration', diagnosticId)
    }
  }

  const scheduledAt = typeof body?.scheduledAt === 'string' ? body.scheduledAt : null
  if (body.scheduledAt !== undefined && (typeof body.scheduledAt !== 'string' || !scheduledAt || Number.isNaN(Date.parse(scheduledAt)))) {
    return sendProblem(new SendInputError('INVALID_SCHEDULE', '/scheduledAt'), 'validation', diagnosticId)
  }

  const idempotencyKey =
    c.req.header('Idempotency-Key') ??
    (typeof body?.idempotencyKey === 'string' ? body.idempotencyKey : null)

  if ((body.idempotencyKey !== undefined && typeof body.idempotencyKey !== 'string') ||
    (idempotencyKey !== null && (!idempotencyKey.trim() || idempotencyKey.length > 255))) {
    return sendProblem(new SendInputError('INVALID_IDEMPOTENCY_KEY'), 'validation', diagnosticId)
  }

  if (idempotencyKey) {
    const previous = one(
      'SELECT id, account_id, type, status, payload_json FROM mutation_jobs WHERE user_id = ? AND idempotency_key = ?',
      [userId, idempotencyKey],
    )

    if (previous) {
      const payload = parseJson<Row>(previous.payload_json, {})
      if (previous.type !== 'send' || previous.account_id !== accountId
        || (payload.inboxId ?? null) !== (inbox?.id ?? null)
        || (body.threadId !== undefined && body.threadId !== payload.threadId)) {
        return sendProblem(new SendInputError('IDEMPOTENCY_CONFLICT'), 'validation', diagnosticId)
      }
      const thread =
        typeof payload.threadId === 'string' ? threadForUser(userId, payload.threadId, undefined, accountId, inbox) : null
      const message = thread?.messages.find((item) => item.id === payload.messageId)
      if (thread && message) {
        return c.json({ ...thread, thread, message, scheduled: Boolean(message.scheduledAt),
          delivery: { jobId: String(previous.id), status: String(previous.status), statusUrl: `/api/send/${encodeURIComponent(message.id)}/status` } })
      }
      return sendProblem(new SendInputError('IDEMPOTENCY_CONFLICT'), 'validation', diagnosticId)
    }
  }

  const requestedThreadId = typeof body?.threadId === 'string' ? body.threadId : null
  if ((body.threadId !== undefined && (!requestedThreadId || typeof body.threadId !== 'string'))
    || ((mode === 'reply' || mode === 'replyAll') && !requestedThreadId)) {
    return sendProblem(new SendInputError('INVALID_SEND_REQUEST', '/threadId'), 'validation', diagnosticId)
  }
  if (
    requestedThreadId &&
    !one('SELECT id FROM messages WHERE user_id = ? AND account_id = ? AND thread_id = ? LIMIT 1', [
      userId,
      accountId,
      requestedThreadId,
    ])
  ) {
    return sendProblem(new SendInputError('THREAD_NOT_FOUND', '/threadId'), 'validation', diagnosticId)
  }
  if (requestedThreadId && inbox && !threadForUser(userId, requestedThreadId, undefined, accountId, inbox)) {
    return sendProblem(new SendInputError('THREAD_NOT_FOUND', '/threadId'), 'validation', diagnosticId)
  }

  const threadId = requestedThreadId ?? crypto.randomUUID()
  const messageId = crypto.randomUUID()
  const now = new Date().toISOString()
  const subject = typeof body?.subject === 'string' ? body.subject : ''
  const content = typeof body?.body === 'string' ? body.body : ''
  const folder: MailFolder = scheduledAt ? 'scheduled' : 'sent'
  const jobId = crypto.randomUUID()
  const payload = {
    messageId,
    threadId,
    accountId,
    to,
    cc,
    bcc,
    subject,
    body: content,
    attachments: messageAttachments,
    scheduledAt,
    mode,
    diagnosticId,
    ...(inbox ? { senderEmail, inboxId: inbox.id } : {}),
  }

  try {
    sqlite.transaction(() => {
      insertMessage({
        id: messageId,
        threadId,
        accountId,
        userId,
        from: { name: String(account.name), email: senderEmail },
        to,
        cc,
        bcc,
        subject,
        body: content,
        folder,
        receivedAt: now,
        scheduledAt,
        readReceipt: settingsForUser(userId).readReceipts,
        attachments: messageAttachments,
      })
      inboxViews.recordMessageSources(userId, accountId, messageId, { folder: 'sent', from: { email: senderEmail } })

      run(
        `INSERT INTO mutation_jobs
           (id, user_id, account_id, type, payload_json, status, idempotency_key, next_attempt_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          jobId,
          userId,
          accountId,
          'send',
          JSON.stringify(payload),
          'pending',
          idempotencyKey,
          scheduledAt ?? now,
        ],
      )
    })()
  } catch (error) {
    if (idempotencyKey && String(error).includes('UNIQUE')) {
      return sendProblem(new SendInputError('IDEMPOTENCY_CONFLICT'), 'validation', diagnosticId)
    }
    return sendProblem(error, 'dispatch', diagnosticId)
  }

  if (!scheduledAt || Date.parse(scheduledAt) <= Date.now()) requestMailJobProcessing()
  const thread = threadForUser(userId, threadId, undefined, accountId, inbox)!
  const message = thread.messages.find((item) => item.id === messageId)!
  return c.json({ ...thread, thread, message, scheduled: Boolean(scheduledAt),
    delivery: { jobId, status: 'pending', statusUrl: `/api/send/${encodeURIComponent(messageId)}/status` } }, 201)
})

router.get('/send/:id/status', (c) => {
  const messageId = c.req.param('id')
  const job = one(`SELECT j.id, j.status, j.attempts, j.next_attempt_at, j.last_error
    FROM mutation_jobs j JOIN messages m ON m.id = json_extract(j.payload_json, '$.messageId')
      AND m.user_id = j.user_id AND m.account_id = j.account_id
    WHERE j.user_id = ? AND j.type = 'send' AND m.id = ?
    ORDER BY j.created_at DESC, j.rowid DESC LIMIT 1`, [c.get('userId'), messageId])
  if (!job) return sendProblem(new SendInputError('SEND_NOT_FOUND'), 'validation')
  const problem = job.last_error && (job.status === 'pending' || job.status === 'processing' || job.status === 'failed')
    ? storedMailFailure(job.last_error, String(job.id)) : null
  if (problem && job.status === 'failed') {
    problem.retryable = false
    if (problem.action === 'wait_for_retry') problem.action = 'check_status'
  }
  c.header('Cache-Control', 'no-store')
  return c.json({ messageId, jobId: String(job.id), status: String(job.status), attempts: Number(job.attempts),
    nextAttemptAt: job.status === 'pending' && typeof job.next_attempt_at === 'string' ? job.next_attempt_at : null, problem })
})

router.post('/send/:id/undo', (c) => {
  const userId = c.get('userId')
  const messageId = c.req.param('id')
  const message = one(
    `SELECT id, thread_id, scheduled_at FROM messages
     WHERE id = ? AND user_id = ? AND folder = 'scheduled'`,
    [messageId, userId],
  )

  if (!message) return c.json({ error: 'Scheduled message not found' }, 404)
  if (typeof message.scheduled_at !== 'string' || Date.parse(message.scheduled_at) <= Date.now()) {
    return c.json({ error: 'The cancellation window has expired' }, 409)
  }

  sqlite.transaction(() => {
    run(
      `UPDATE messages SET folder = 'drafts', scheduled_at = NULL
       WHERE id = ? AND user_id = ? AND folder = 'scheduled'`,
      [messageId, userId],
    )
    run(
      `UPDATE mutation_jobs SET status = 'cancelled', updated_at = ?
       WHERE user_id = ? AND type = 'send' AND status = 'pending'
         AND json_extract(payload_json, '$.messageId') = ?`,
      [new Date().toISOString(), userId, messageId],
    )
  })()

  return c.json({
    canceled: true,
    thread: threadForUser(userId, String(message.thread_id)),
  })
})

router.post('/drafts', async (c) => {
  const body = await composeBody(c.req.raw).catch(() => null)
  if (!body || Array.isArray(body)) return c.json({ error: 'A JSON object is required' }, 400)

  const userId = c.get('userId')
  const draftId = typeof body.id === 'string' ? body.id : null
  const current = draftId
    ? one(
        `SELECT * FROM messages
         WHERE user_id = ? AND folder = 'drafts' AND (id = ? OR thread_id = ?)
         LIMIT 1`,
        [userId, draftId, draftId],
      )
    : null

  if (draftId && !current) return c.json({ error: 'Draft not found' }, 404)

  const accountId =
    typeof body.accountId === 'string' ? body.accountId : typeof current?.account_id === 'string' ? current.account_id : ''
  const account = one('SELECT * FROM mail_accounts WHERE user_id = ? AND id = ?', [userId, accountId])
  if (!account) return c.json({ error: 'Account not found' }, 404)
  if (current && current.account_id !== accountId) {
    return c.json({ error: 'A draft cannot change accounts' }, 400)
  }
  const inbox = typeof body.inboxId === 'string' ? inboxViews.get(userId, body.inboxId) : null
  if (body.inboxId !== undefined && (!inbox || inbox.accountId !== accountId || !inbox.defaultSender)) {
    return c.json({ error: 'Choose a sending identity for this inbox' }, 400)
  }
  const senderEmail = inbox?.defaultSender ?? String(account.email)

  const now = new Date().toISOString()
  const content = typeof body.body === 'string' ? body.body : String(current?.body_html ?? '')
  const subject = typeof body.subject === 'string' ? body.subject : String(current?.subject ?? '')
  const to = body.to !== undefined ? recipientList(body.to) : participants(current?.to_json)
  const cc = body.cc !== undefined ? recipientList(body.cc) : participants(current?.cc_json)
  const bcc = body.bcc !== undefined ? recipientList(body.bcc) : participants(current?.bcc_json)
  const messageAttachments =
    body.attachments !== undefined
      ? storedAttachments(body.attachments)
      : parseJson<Row[]>(current?.attachments_json, [])

  if (current) {
    const text = plainText(content)
    run(
      `UPDATE messages
       SET to_json = ?, cc_json = ?, bcc_json = ?, subject = ?, preview = ?,
           body_text = ?, body_html = ?, attachments_json = ?, received_at = ?
       WHERE id = ? AND user_id = ? AND folder = 'drafts'`,
      [
        JSON.stringify(to),
        JSON.stringify(cc),
        JSON.stringify(bcc),
        subject,
        text.slice(0, 240),
        text,
        htmlBody(content),
        JSON.stringify(messageAttachments),
        now,
        String(current.id),
        userId,
      ],
    )

    const updated = one('SELECT * FROM messages WHERE id = ? AND user_id = ?', [
      String(current.id),
      userId,
    ])!
    inboxViews.recordMessageSources(userId, accountId, String(current.id), { folder: 'sent', from: { email: senderEmail } })
    return c.json(messageFromRow(updated, settingsForUser(userId)))
  }

  const threadId = typeof body.threadId === 'string' ? body.threadId : crypto.randomUUID()
  if (
    typeof body.threadId === 'string' &&
    !one('SELECT id FROM messages WHERE user_id = ? AND account_id = ? AND thread_id = ? LIMIT 1', [
      userId,
      accountId,
      threadId,
    ])
  ) {
    return c.json({ error: 'Thread not found' }, 404)
  }

  const messageId = crypto.randomUUID()
  insertMessage({
    id: messageId,
    threadId,
    accountId,
    userId,
    from: { name: String(account.name), email: senderEmail },
    to,
    cc,
    bcc,
    subject,
    body: content,
    folder: 'drafts',
    receivedAt: now,
    attachments: messageAttachments,
  })
  inboxViews.recordMessageSources(userId, accountId, messageId, { folder: 'sent', from: { email: senderEmail } })

  const draft = one('SELECT * FROM messages WHERE id = ? AND user_id = ?', [messageId, userId])!
  return c.json(messageFromRow(draft, settingsForUser(userId)), 201)
})

router.delete('/drafts/:id', (c) => {
  const id = c.req.param('id')
  const result = run(
    `DELETE FROM messages
     WHERE user_id = ? AND folder = 'drafts' AND (id = ? OR thread_id = ?)`,
    [c.get('userId'), id, id],
  )

  if (result.changes === 0) return c.json({ error: 'Draft not found' }, 404)
  return c.body(null, 204)
})

router.get('/settings', (c) => c.json(settingsForUser(c.get('userId'))))

router.put('/settings', async (c) => {
  const body = await c.req.json<Row>().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'A JSON object is required' }, 400)

  for (const [key, value] of Object.entries(body)) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, key)) return c.json({ error: `Unknown setting: ${key}` }, 400)
    const expected = DEFAULT_SETTINGS[key as keyof UserSettings]
    if (typeof value !== typeof expected) return c.json({ error: `Invalid setting: ${key}` }, 400)
  }

  if (
    ('readingMode' in body && !['fullscreen', 'sheet', 'sidebar'].includes(String(body.readingMode))) ||
    ('density' in body && !['comfortable', 'compact'].includes(String(body.density))) ||
    ('theme' in body && !['light', 'dark', 'system'].includes(String(body.theme))) ||
    ('personalizationMode' in body && !['off', 'suggest', 'adaptive'].includes(String(body.personalizationMode))) ||
    ('prioritySection' in body && !['automatic', 'starred', 'needs-action', 'off'].includes(String(body.prioritySection))) ||
    ('fontFamily' in body && !['circular', 'system', 'rounded', 'serif', 'mono'].includes(String(body.fontFamily))) ||
    ('undoSendSeconds' in body &&
      (!Number.isInteger(body.undoSendSeconds) ||
        Number(body.undoSendSeconds) < 0 ||
        Number(body.undoSendSeconds) > 120))
  ) {
    return c.json({ error: 'Invalid setting value' }, 400)
  }

  const userId = c.get('userId')
  const settings = { ...settingsForUser(userId), ...body } as UserSettings

  run(
    `INSERT INTO user_settings (user_id, data_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at`,
    [userId, JSON.stringify(settings), new Date().toISOString()],
  )
  if ('personalizationMode' in body) invalidatePriorities(userId)

  return c.json(settings)
})

router.get('/accounts/:accountId/messages/:messageId/attachments/:attachmentId', async (c) => {
  const userId = c.get('userId')
  const accountId = c.req.param('accountId')
  const messageId = c.req.param('messageId')
  const attachmentId = c.req.param('attachmentId')
  const message = one(
    `SELECT id, provider_id, attachments_json FROM messages
     WHERE user_id = ? AND account_id = ? AND (id = ? OR provider_id = ?)`,
    [userId, accountId, messageId, messageId],
  )

  if (!message) return c.json({ error: 'Attachment not found' }, 404)

  try {
    const provider = await getReadyAccountProvider(userId, accountId)
    const upstreamId = provider.type !== 'mock' && typeof message.provider_id === 'string'
      ? message.provider_id
      : String(message.id)
    const storedAttachment = attachments(message.attachments_json).find((item) => item.id === attachmentId)
    const attachment = await provider.getAttachment(upstreamId, attachmentId, storedAttachment?.contentId)
    const filename = attachment.filename.replace(/[\r\n"\\]/g, '_')
    const disposition = attachment.attachment.inline && attachment.contentType.startsWith('image/')
      ? 'inline'
      : 'attachment'
    return new Response(Buffer.from(attachment.content), {
      headers: {
        'Content-Type': attachment.contentType,
        'Content-Disposition': `${disposition}; filename="${filename}"`,
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (error) {
    const status = error instanceof ProviderError && error.status ? error.status : 502
    return c.json({ error: error instanceof Error ? error.message : 'Attachment download failed' },
      status >= 400 && status <= 599 ? status as 400 : 502)
  }
})

router.get('/attachments/:id', async (c) => {
  const id = c.req.param('id')
  const row = one(
    `SELECT attachments_json FROM messages
     WHERE user_id = ?
       AND EXISTS (
         SELECT 1 FROM json_each(attachments_json) attachment
         WHERE json_extract(attachment.value, '$.id') = ?
       )
     LIMIT 1`,
    [c.get('userId'), id],
  )

  if (!row) return c.json({ error: 'Attachment not found' }, 404)
  const attachment = attachments(row.attachments_json).find((item) => item.id === id)
  if (!attachment) return c.json({ error: 'Attachment not found' }, 404)

  const stored = parseJson<Row[]>(row.attachments_json, []).find((item) => item.id === id)
  const filename = attachment.filename.replace(/[\r\n"\\]/g, '_')
  const headers = {
    'Content-Type': attachment.contentType,
    'Content-Disposition': `${attachment.inline ? 'inline' : 'attachment'}; filename="${filename}"`,
  }

  if (typeof stored?.contentBase64 === 'string') {
    return new Response(Buffer.from(stored.contentBase64, 'base64'), { headers })
  }

  if (/^https?:\/\//i.test(attachment.url)) return c.redirect(attachment.url, 302)

  let pathname: string
  try {
    pathname = decodeURIComponent(new URL(attachment.url, 'http://openmail.local').pathname)
  } catch {
    return c.json({ error: 'Invalid attachment path' }, 400)
  }

  if (pathname.includes('\0') || pathname.split(/[\\/]/).includes('..')) {
    return c.json({ error: 'Invalid attachment path' }, 400)
  }

  for (const root of ['public', 'dist']) {
    const base = resolve(import.meta.dir, '..', root)
    const path = resolve(base, `.${pathname}`)
    if (!path.startsWith(`${base}${sep}`)) continue

    const file = Bun.file(path)
    if (!(await file.exists())) continue

    return new Response(file, { headers })
  }

  return c.json({ error: 'Attachment content not found' }, 404)
})

export default router
