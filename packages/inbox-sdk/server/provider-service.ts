import { decryptCredential, encryptCredential } from './crypto'
import { sqlite } from './db'
import { InboxViewStore } from './sdk/inbox-store'
import { discoverMailSources } from './sdk/mail-sources'
import type { MutationJob } from './jobs'
import { SendInputError } from './mail-errors'
import { invalidatePriorities, recordPrioritySignal } from './priority'
import { normalizeSendAttachments } from './send-attachments'
import {
  buildThreads,
  createProvider,
  ProviderError,
  recoverInlineMessageImages,
  type Attachment,
  type InboxProvider,
  type InboxProviderType,
  type MailFolder,
  type MailMessage,
  type MessageMutation,
  type SyncCursor,
  type SyncResult,
  UnsupportedOperationError,
} from './sdk'

interface AccountRow {
  id: string
  user_id: string
  name: string
  email: string
  provider: InboxProviderType
  credentials_encrypted: string | null
}

const inboxViews = new InboxViewStore(sqlite)

export function enableConnectionInboxViews(userId: string, accountId: string): void {
  const account = accountForUser(userId, accountId)
  if (!account?.credentials_encrypted) throw new Error('Connect this account before creating inboxes')
  const credentials = JSON.parse(decryptCredential(account.credentials_encrypted, userId, accountId))
  if (credentials.connectionMode === true) return
  sqlite.transaction(() => {
    sqlite.query('UPDATE mail_accounts SET credentials_encrypted = ? WHERE user_id = ? AND id = ?').run(
      encryptCredential(JSON.stringify({ ...credentials, connectionMode: true }), userId, accountId), userId, accountId)
    sqlite.query('DELETE FROM sync_cursors WHERE account_id = ?').run(accountId)
  })()
}

function accountForUser(userId: string, accountId: string): AccountRow | null {
  return sqlite.query<AccountRow, [string, string]>(`
    SELECT id, user_id, name, email, provider, credentials_encrypted
    FROM mail_accounts WHERE id = ? AND user_id = ?
  `).get(accountId, userId)
}

export function recoverStoredGmailInlineImages(userId: string, accountId: string): number {
  if (accountForUser(userId, accountId)?.provider !== 'gmail') return 0

  const messages = sqlite.query<{
    id: string
    body_html: string
    attachments_json: string
  }, [string, string]>(`
    SELECT id, body_html, attachments_json FROM messages
    WHERE user_id = ? AND account_id = ?
      AND (body_html LIKE '%background-image%' OR body_html LIKE '%cid:%')
  `).all(userId, accountId)

  return sqlite.transaction(() => {
    let recovered = 0

    for (const message of messages) {
      let attachments: Attachment[] = []
      let parsedAttachments: unknown[] | null = null
      try {
        const parsed: unknown = JSON.parse(message.attachments_json)
        if (Array.isArray(parsed)) {
          parsedAttachments = parsed
          attachments = parsed.filter((item): item is Attachment =>
            Boolean(item) && typeof item === 'object' &&
            typeof (item as Record<string, unknown>).id === 'string' &&
            typeof (item as Record<string, unknown>).contentType === 'string',
          )
        }
      } catch {}

      const previousAttachments = parsedAttachments ? JSON.stringify(parsedAttachments) : ''
      const html = recoverInlineMessageImages(message.body_html, attachments)
      const nextAttachments = parsedAttachments ? JSON.stringify(parsedAttachments) : ''
      const attachmentsChanged = Boolean(parsedAttachments && nextAttachments !== previousAttachments)
      if (html === message.body_html && !attachmentsChanged) continue

      const updated = sqlite.query(`
        UPDATE messages SET body_html = ?, attachments_json = ?
        WHERE id = ? AND user_id = ? AND account_id = ?
          AND body_html = ? AND attachments_json = ?
      `).run(
        html,
        attachmentsChanged ? nextAttachments : message.attachments_json,
        message.id,
        userId,
        accountId,
        message.body_html,
        message.attachments_json,
      )
      recovered += updated.changes
    }

    return recovered
  })()
}

const pendingGmailRefreshes = new Map<string, Promise<void>>()
const recoveredGmailInlineAccounts = new Set<string>()

async function refreshGmailAccessToken(userId: string, accountId: string): Promise<void> {
  const account = accountForUser(userId, accountId)
  if (account?.provider !== 'gmail' || !account.credentials_encrypted) return

  const parsed: unknown = JSON.parse(
    decryptCredential(account.credentials_encrypted, userId, accountId),
  )
  if (!parsed || typeof parsed !== 'object') return
  const credentials = parsed as Record<string, unknown>
  const expiresAt = typeof credentials.accessTokenExpiresAt === 'number'
    ? credentials.accessTokenExpiresAt
    : typeof credentials.accessTokenExpiresAt === 'string'
      ? Date.parse(credentials.accessTokenExpiresAt)
      : NaN
  if (!Number.isFinite(expiresAt) || expiresAt - Date.now() > 60_000) return

  const key = `${userId}\0${accountId}`
  const pending = pendingGmailRefreshes.get(key)
  if (pending) return pending

  const refresh = (async () => {
    if (typeof credentials.refreshToken !== 'string' || !credentials.refreshToken) {
      throw new ProviderError(
        'gmail',
        'AUTHENTICATION',
        'Gmail access expired and no refresh token is available; reconnect your Google account',
      )
    }

    const clientId = process.env.GOOGLE_CLIENT_ID?.trim()
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim()
    if (!clientId || !clientSecret) {
      throw new ProviderError(
        'gmail',
        'AUTHENTICATION',
        'Google OAuth credentials are unavailable; reconnect your Google account',
      )
    }

    let response: Response
    try {
      response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: credentials.refreshToken,
          grant_type: 'refresh_token',
        }),
        signal: AbortSignal.timeout(10_000),
      })
    } catch {
      throw new ProviderError('gmail', 'NETWORK', 'Google OAuth token refresh request failed', {
        retryable: true,
      })
    }

    if (!response.ok) {
      if ([400, 401, 403].includes(response.status)) {
        throw new ProviderError(
          'gmail',
          'AUTHENTICATION',
          'Gmail access could not be renewed; reconnect your Google account',
          { status: response.status },
        )
      }
      throw new ProviderError('gmail', 'UPSTREAM', 'Google OAuth token refresh failed', {
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
      })
    }

    let refreshed: { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown }
    try {
      refreshed = await response.json() as typeof refreshed
    } catch {
      throw new ProviderError('gmail', 'UPSTREAM', 'Google OAuth token refresh returned an invalid response')
    }
    if (
      typeof refreshed.access_token !== 'string' ||
      !refreshed.access_token ||
      typeof refreshed.expires_in !== 'number' ||
      !Number.isFinite(refreshed.expires_in) ||
      refreshed.expires_in <= 0
    ) {
      throw new ProviderError('gmail', 'UPSTREAM', 'Google OAuth token refresh returned invalid credentials')
    }
    const expiresIn = refreshed.expires_in

    sqlite.transaction(() => {
      const current = accountForUser(userId, accountId)
      if (current?.provider !== 'gmail' || !current.credentials_encrypted) {
        throw new ProviderError('gmail', 'AUTHENTICATION', 'The Gmail account is no longer connected')
      }

      const currentParsed: unknown = JSON.parse(
        decryptCredential(current.credentials_encrypted, userId, accountId),
      )
      if (!currentParsed || typeof currentParsed !== 'object') {
        throw new ProviderError('gmail', 'AUTHENTICATION', 'The Gmail account must be reconnected')
      }
      const currentCredentials = currentParsed as Record<string, unknown>
      const currentExpiry = typeof currentCredentials.accessTokenExpiresAt === 'number'
        ? currentCredentials.accessTokenExpiresAt
        : typeof currentCredentials.accessTokenExpiresAt === 'string'
          ? Date.parse(currentCredentials.accessTokenExpiresAt)
          : NaN
      if (Number.isFinite(currentExpiry) && currentExpiry - Date.now() > 60_000) return

      const encrypted = encryptCredential(JSON.stringify({
        ...currentCredentials,
        accessToken: refreshed.access_token,
        refreshToken: typeof refreshed.refresh_token === 'string' && refreshed.refresh_token
          ? refreshed.refresh_token
          : currentCredentials.refreshToken ?? credentials.refreshToken,
        accessTokenExpiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      }), userId, accountId)

      sqlite.query(`
        UPDATE mail_accounts SET credentials_encrypted = ?
        WHERE id = ? AND user_id = ? AND provider = 'gmail'
      `).run(encrypted, accountId, userId)
    })()
  })()

  pendingGmailRefreshes.set(key, refresh)
  try {
    await refresh
  } finally {
    if (pendingGmailRefreshes.get(key) === refresh) pendingGmailRefreshes.delete(key)
  }
}

export function getAccountProvider(userId: string, accountId: string): InboxProvider {
  const account = accountForUser(userId, accountId)
  if (!account) throw new Error('Mail account was not found for this user')

  let credentials: Record<string, unknown> = {}
  if (account.credentials_encrypted) {
    const decrypted = decryptCredential(account.credentials_encrypted, userId, accountId)
    try {
      const parsed: unknown = JSON.parse(decrypted)
      credentials = parsed && typeof parsed === 'object'
        ? parsed as Record<string, unknown>
        : { apiKey: decrypted }
    } catch {
      credentials = { apiKey: decrypted }
    }
  }

  const common = { ...credentials, accountId, userId, email: account.email, name: account.name }

  switch (account.provider) {
    case 'mock':
      return createProvider('mock', common)
    case 'gmail':
      if (typeof credentials.accessToken !== 'string' || !credentials.accessToken) {
        throw new ProviderError('gmail', 'AUTHENTICATION', 'Connect a Gmail OAuth access token before syncing')
      }
      return createProvider('gmail', { ...common, accessToken: credentials.accessToken })
    case 'outlook':
      if (typeof credentials.accessToken !== 'string' || !credentials.accessToken) {
        throw new ProviderError('outlook', 'AUTHENTICATION', 'Connect a Microsoft Graph OAuth access token before syncing')
      }
      return createProvider('outlook', { ...common, accessToken: credentials.accessToken })
    case 'inbound':
      if (typeof credentials.apiKey !== 'string' || !credentials.apiKey) {
        throw new ProviderError('inbound', 'AUTHENTICATION', 'An Inbound API key is required before syncing')
      }
      return createProvider('inbound', { ...common, apiKey: credentials.apiKey })
    case 'imap':
      return createProvider('imap', common)
    default:
      throw new Error('The requested mail provider is not registered')
  }
}

export async function getReadyAccountProvider(userId: string, accountId: string): Promise<InboxProvider> {
  await refreshGmailAccessToken(userId, accountId)
  return getAccountProvider(userId, accountId)
}

export function assertProviderMutationSupported(provider: InboxProvider, changes: MessageMutation): void {
  if (changes.isRead === true && !provider.capabilities.markRead) {
    throw new UnsupportedOperationError(provider.type, 'marking messages as read')
  }
  if (changes.isRead === false && !provider.capabilities.markUnread) {
    throw new UnsupportedOperationError(provider.type, 'marking messages as unread')
  }
  if (changes.isStarred !== undefined && !provider.capabilities.star) {
    throw new UnsupportedOperationError(provider.type, 'starring')
  }
  if ((changes.addLabels?.length || changes.removeLabels?.length) && !provider.capabilities.labels) {
    throw new UnsupportedOperationError(provider.type, 'labels')
  }
  if (changes.folder === 'archive' && !provider.capabilities.archive) {
    throw new UnsupportedOperationError(provider.type, 'archiving')
  }
  if (changes.folder === 'trash' && !provider.capabilities.trash) {
    throw new UnsupportedOperationError(provider.type, 'moving messages to trash')
  }
  if (changes.folder === 'spam' && !provider.capabilities.folders) {
    throw new UnsupportedOperationError(provider.type, 'moving messages to spam')
  }
  if (changes.folder === 'inbox' && !provider.capabilities.folders && !provider.capabilities.archive) {
    throw new UnsupportedOperationError(provider.type, 'moving messages to the inbox')
  }
}

function persistProviderMessage(userId: string, accountId: string, message: MailMessage): void {
  const localId = `${accountId}:${message.id}`
  const threadId = `${accountId}:${message.threadId}`
  sqlite.query(`
    INSERT INTO messages (
      id, thread_id, account_id, user_id, from_json, to_json, cc_json, bcc_json,
      subject, preview, body_text, body_html, received_at, is_read, is_starred, is_important,
      folder, labels_json, attachments_json, snoozed_until, scheduled_at,
      read_receipt, provider_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      thread_id = excluded.thread_id,
      from_json = excluded.from_json,
      to_json = excluded.to_json,
      cc_json = excluded.cc_json,
      bcc_json = excluded.bcc_json,
      subject = excluded.subject,
      preview = excluded.preview,
      body_text = excluded.body_text,
      body_html = excluded.body_html,
      received_at = excluded.received_at,
      is_read = CASE WHEN EXISTS (
        SELECT 1 FROM mutation_jobs job
        WHERE job.user_id = messages.user_id AND job.account_id = messages.account_id
          AND job.type = 'message-mutation' AND job.status IN ('pending', 'processing')
          AND json_extract(job.payload_json, '$.messageId') = messages.id
          AND json_extract(job.payload_json, '$.providerId') = messages.provider_id
          AND json_type(job.payload_json, '$.optimistic.isRead') IS NOT NULL
      ) THEN messages.is_read ELSE excluded.is_read END,
      is_starred = CASE WHEN EXISTS (
        SELECT 1 FROM mutation_jobs job
        WHERE job.user_id = messages.user_id AND job.account_id = messages.account_id
          AND job.type = 'message-mutation' AND job.status IN ('pending', 'processing')
          AND json_extract(job.payload_json, '$.messageId') = messages.id
          AND json_extract(job.payload_json, '$.providerId') = messages.provider_id
          AND json_type(job.payload_json, '$.optimistic.isStarred') IS NOT NULL
      ) THEN messages.is_starred ELSE excluded.is_starred END,
      is_important = excluded.is_important,
      folder = CASE WHEN EXISTS (
        SELECT 1 FROM mutation_jobs job
        WHERE job.user_id = messages.user_id AND job.account_id = messages.account_id
          AND job.type = 'message-mutation' AND job.status IN ('pending', 'processing')
          AND json_extract(job.payload_json, '$.messageId') = messages.id
          AND json_extract(job.payload_json, '$.providerId') = messages.provider_id
          AND json_type(job.payload_json, '$.optimistic.folder') IS NOT NULL
      ) THEN messages.folder ELSE excluded.folder END,
      labels_json = CASE WHEN EXISTS (
        SELECT 1 FROM mutation_jobs job
        WHERE job.user_id = messages.user_id AND job.account_id = messages.account_id
          AND job.type = 'message-mutation' AND job.status IN ('pending', 'processing')
          AND json_extract(job.payload_json, '$.messageId') = messages.id
          AND json_extract(job.payload_json, '$.providerId') = messages.provider_id
          AND json_type(job.payload_json, '$.optimistic.labels') IS NOT NULL
      ) THEN messages.labels_json ELSE excluded.labels_json END,
      attachments_json = excluded.attachments_json,
      snoozed_until = excluded.snoozed_until,
      scheduled_at = excluded.scheduled_at,
      read_receipt = excluded.read_receipt,
      provider_id = excluded.provider_id
    WHERE messages.user_id = excluded.user_id
      AND messages.account_id = excluded.account_id
  `).run(
    localId,
    threadId,
    accountId,
    userId,
    JSON.stringify(message.from),
    JSON.stringify(message.to),
    JSON.stringify(message.cc),
    JSON.stringify(message.bcc),
    message.subject,
    message.preview,
    message.bodyText,
    message.bodyHtml,
    message.receivedAt,
    Number(message.isRead),
    Number(message.isStarred),
    Number(message.isImportant !== false),
    message.folder,
    JSON.stringify(message.labels),
    JSON.stringify(message.attachments),
    message.snoozedUntil ?? null,
    message.scheduledAt ?? null,
    Number(message.readReceipt === true),
    message.id,
  )
  inboxViews.recordMessageSources(userId, accountId, localId, message)
}

const pendingAccountSynchronizations = new Map<string, Promise<SyncResult>>()

export function synchronizeAccount(
  userId: string,
  accountId: string,
  options: { folder?: MailFolder; limit?: number; reset?: boolean } = {},
): Promise<SyncResult> {
  const key = `${userId}\0${accountId}`
  const pending = pendingAccountSynchronizations.get(key)
  if (pending) return pending

  const synchronization = (async (): Promise<SyncResult> => {
    let provider: InboxProvider
    try {
      provider = await getReadyAccountProvider(userId, accountId)
    } catch (error) {
      sqlite.query(`
        UPDATE mail_accounts SET sync_status = 'error' WHERE id = ? AND user_id = ?
      `).run(accountId, userId)
      throw error
    }

    if (provider.type === 'gmail') {
      const recoveryKey = `${userId}\0${accountId}`
      if (!recoveredGmailInlineAccounts.has(recoveryKey)) {
        recoverStoredGmailInlineImages(userId, accountId)
        recoveredGmailInlineAccounts.add(recoveryKey)
      }
    }

    const scope = options.folder ?? 'inbox'
    const backfillScope = `${scope}:backfill`
    const syncOptions = { folder: options.folder, limit: options.limit ?? 50 }

    function readCursor(cursorScope: string): SyncCursor | null {
      const saved = sqlite.query<{ cursor_json: string }, [string, string]>(`
        SELECT cursor_json FROM sync_cursors WHERE account_id = ? AND scope = ?
      `).get(accountId, cursorScope)
      if (!saved) return null
      try {
        return JSON.parse(saved.cursor_json) as SyncCursor
      } catch {
        return null
      }
    }

    function writeCursor(cursorScope: string, cursor: SyncCursor | null, timestamp: string): void {
      if (!cursor) {
        sqlite.query('DELETE FROM sync_cursors WHERE account_id = ? AND scope = ?').run(accountId, cursorScope)
        return
      }

      sqlite.query(`
        INSERT INTO sync_cursors (account_id, scope, cursor_json, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(account_id, scope) DO UPDATE SET
          cursor_json = excluded.cursor_json, updated_at = excluded.updated_at
      `).run(accountId, cursorScope, JSON.stringify(cursor), timestamp)
    }

    function incrementalCursor(cursor: SyncCursor): SyncCursor | null {
      if (!provider.capabilities.incrementalSync || cursor.kind !== 'page') return null
      const declaredKind = cursor.metadata?.incrementalCursorKind
      const kind = declaredKind === 'history' || declaredKind === 'delta' || declaredKind === 'uid'
        ? declaredKind
        : provider.capabilities.deltaSync ? 'history' : 'uid'
      const metadata = { ...cursor.metadata }
      delete metadata.pageToken
      delete metadata.beforeUid
      delete metadata.incrementalCursorKind
      return {
        ...cursor,
        kind,
        ...(Object.keys(metadata).length ? { metadata } : { metadata: undefined }),
      }
    }

    let live = options.reset ? null : readCursor(scope)
    let backfill = options.reset ? null : readCursor(backfillScope)

    if (live?.kind === 'page' && !backfill) {
      backfill = live
      live = incrementalCursor(live)
      const timestamp = new Date().toISOString()
      sqlite.transaction(() => {
        writeCursor(scope, live, timestamp)
        writeCursor(backfillScope, backfill, timestamp)
      })()
    }

    sqlite.query(`
      UPDATE mail_accounts SET sync_status = 'syncing' WHERE id = ? AND user_id = ?
    `).run(accountId, userId)

    function persist(result: SyncResult, phase: 'live' | 'backfill', existingBackfill: boolean): void {
      const timestamp = new Date().toISOString()

      sqlite.transaction(() => {
        if (provider.type !== 'mock') {
          for (const message of result.messages) persistProviderMessage(userId, accountId, message)
          for (const providerId of result.deletedMessageIds) {
            sqlite.query(`
              DELETE FROM messages WHERE user_id = ? AND account_id = ? AND provider_id = ?
            `).run(userId, accountId, providerId)
          }
        }

        if (phase === 'backfill') {
          writeCursor(backfillScope, result.hasMore ? result.cursor : null, timestamp)
          if (!live && provider.capabilities.incrementalSync && result.cursor && !result.hasMore) {
            live = result.cursor
            writeCursor(scope, live, timestamp)
          }
        } else if (result.hasMore && result.cursor && result.fullSync) {
          const nextLive = incrementalCursor(result.cursor)
          if (nextLive || !provider.capabilities.incrementalSync || result.cursor.kind === 'delta') {
            live = nextLive
            writeCursor(scope, live, timestamp)
            if (!existingBackfill || provider.capabilities.incrementalSync) {
              writeCursor(backfillScope, result.cursor, timestamp)
            }
          } else {
            live = result.cursor
            writeCursor(scope, live, timestamp)
          }
        } else {
          live = provider.capabilities.incrementalSync ? result.cursor : null
          writeCursor(scope, live, timestamp)
          if (result.fullSync && provider.capabilities.incrementalSync) {
            writeCursor(backfillScope, null, timestamp)
          }
        }

        sqlite.query(`
          UPDATE mail_accounts SET sync_status = 'connected', last_sync_at = ?
          WHERE id = ? AND user_id = ?
        `).run(timestamp, accountId, userId)
      })()
      if (result.messages.length > 0 || result.deletedMessageIds.length > 0) invalidatePriorities(userId, accountId)
    }

    try {
      if (options.reset) {
        sqlite.query('DELETE FROM sync_cursors WHERE account_id = ? AND scope IN (?, ?)')
          .run(accountId, scope, backfillScope)
      }

      const hadBackfill = Boolean(backfill)
      let result: SyncResult
      if (backfill && !live && provider.capabilities.incrementalSync) {
        const recent = await provider.listMessages(syncOptions)
        result = {
          messages: recent.items,
          threads: buildThreads(recent.items),
          deletedMessageIds: [],
          cursor: null,
          hasMore: false,
          fullSync: false,
        }
      } else {
        result = await provider.sync(live, syncOptions)
      }
      persist(result, 'live', hadBackfill)

      if (hadBackfill) {
        const nextBackfill = readCursor(backfillScope)
        if (nextBackfill) {
          const historical = await provider.sync(nextBackfill, syncOptions)
          persist(historical, 'backfill', true)
          const messages = [...new Map(
            [...historical.messages, ...result.messages].map((message) => [message.id, message]),
          ).values()]
          result = {
            messages,
            threads: buildThreads(messages),
            deletedMessageIds: [...new Set([...result.deletedMessageIds, ...historical.deletedMessageIds])],
            cursor: live ?? historical.cursor,
            hasMore: historical.hasMore,
            fullSync: result.fullSync || historical.fullSync,
          }
        }
      }

      return result
    } catch (error) {
      sqlite.query(`
        UPDATE mail_accounts SET sync_status = 'error' WHERE id = ? AND user_id = ?
      `).run(accountId, userId)
      throw error
    }
  })()

  pendingAccountSynchronizations.set(key, synchronization)
  void synchronization.finally(() => {
    if (pendingAccountSynchronizations.get(key) === synchronization) {
      pendingAccountSynchronizations.delete(key)
    }
  }).catch(() => {})
  return synchronization
}

export function startProviderSynchronization(intervalMs = 15_000): () => void {
  let processing = false
  const interval = Number.isFinite(intervalMs) ? Math.max(5_000, intervalMs) : 15_000
  const retries = new Map<string, { failures: number; nextAttemptAt: number }>()

  async function tick(): Promise<void> {
    if (processing) return
    processing = true
    try {
      const accounts = sqlite.query<{ id: string; user_id: string }, []>(`
        SELECT id, user_id FROM mail_accounts
        WHERE provider <> 'mock' AND credentials_encrypted IS NOT NULL
        ORDER BY last_sync_at IS NOT NULL, last_sync_at ASC
      `).all()

      for (const account of accounts) {
        const retry = retries.get(account.id)
        if (retry && retry.nextAttemptAt > Date.now()) continue
        try {
          await synchronizeAccount(account.user_id, account.id, { folder: 'inbox', limit: 50 })
          retries.delete(account.id)
        } catch (error) {
          const failures = (retry?.failures ?? 0) + 1
          const delay = Math.min(300_000, interval * 2 ** Math.min(failures - 1, 8))
          const retryAfter = error instanceof ProviderError && error.retryAfter !== undefined
            ? error.retryAfter * 1_000
            : 0
          retries.set(account.id, {
            failures,
            nextAttemptAt: Date.now() + Math.max(delay, retryAfter),
          })
          console.error('Background mailbox synchronization failed:',
            error instanceof Error ? error.message : 'Unknown provider error')
        }
      }
    } finally {
      processing = false
    }
  }

  void tick()
  const timer = setInterval(() => { void tick() }, interval)
  timer.unref?.()
  return () => clearInterval(timer)
}

function recordConfirmedReply(job: MutationJob): void {
  const payload = job.payload as { mode?: unknown; threadId?: unknown; messageId?: unknown }
  if (!payload || !['reply', 'replyAll'].includes(String(payload.mode))
    || typeof payload.threadId !== 'string' || typeof payload.messageId !== 'string') return
  // Learning is best-effort after delivery; it must never cause an outbound send retry.
  try {
    const sent = sqlite.query(`SELECT id FROM messages
      WHERE id = ? AND user_id = ? AND account_id = ? AND thread_id = ? AND folder = 'sent' AND scheduled_at IS NULL`)
      .get(payload.messageId, job.userId, job.accountId, payload.threadId)
    if (sent) recordPrioritySignal(job.userId, job.accountId, payload.threadId, 'reply')
  } catch {
    console.warn('Private priority feedback was skipped after confirmed sending')
  }
}

export async function dispatchProviderMutation(job: MutationJob): Promise<void> {
  if (job.type !== 'send' && job.type !== 'message-mutation') {
    throw new Error(`Unsupported mailbox mutation job type: ${job.type}`)
  }
  const account = accountForUser(job.userId, job.accountId)
  if (!account) throw new Error('The queued mailbox no longer belongs to its original user')
  if (job.type === 'message-mutation') {
    if (account.provider === 'mock') return
    const payload = job.payload as {
      messageId?: unknown
      accountId?: unknown
      providerId?: unknown
      changes?: MessageMutation
    }
    if (
      typeof payload.messageId !== 'string' ||
      payload.accountId !== job.accountId ||
      typeof payload.providerId !== 'string' ||
      !payload.providerId ||
      !payload.changes ||
      typeof payload.changes !== 'object' ||
      Array.isArray(payload.changes)
    ) {
      throw new ProviderError(account.provider, 'VALIDATION', 'The queued message mutation has an invalid payload')
    }

    const messageId = payload.messageId
    const providerId = payload.providerId
    const message = sqlite.query<{ id: string }, [string, string, string, string]>(`
      SELECT id FROM messages
      WHERE id = ? AND user_id = ? AND account_id = ? AND provider_id = ?
    `).get(messageId, job.userId, job.accountId, providerId)
    if (!message) {
      throw new ProviderError(account.provider, 'NOT_FOUND', 'The queued message no longer belongs to its original account')
    }

    const provider = await getReadyAccountProvider(job.userId, job.accountId)
    const changes = payload.changes
    assertProviderMutationSupported(provider, changes)
    const result = await provider.mutate(providerId, changes)
    if (result && result.id !== providerId) {
      sqlite.transaction(() => {
        const updated = sqlite.query(`
          UPDATE messages SET provider_id = ?
          WHERE id = ? AND user_id = ? AND account_id = ? AND provider_id = ?
        `).run(result.id, messageId, job.userId, job.accountId, providerId)
        if (!updated.changes) return

        sqlite.query(`
          UPDATE mutation_jobs SET payload_json = json_set(payload_json, '$.providerId', ?)
          WHERE user_id = ? AND account_id = ? AND type = 'message-mutation'
            AND status = 'pending'
            AND json_extract(payload_json, '$.messageId') = ?
            AND json_extract(payload_json, '$.providerId') = ?
        `).run(result.id, job.userId, job.accountId, messageId, providerId)
      })()
    }
    return
  }

  if (!job.payload || typeof job.payload !== 'object' || Array.isArray(job.payload)) {
    throw new SendInputError('INVALID_SEND_REQUEST')
  }
  const payload = job.payload as Record<string, unknown>
  if (typeof payload.messageId !== 'string' || !payload.messageId ||
    (payload.accountId !== undefined && payload.accountId !== job.accountId) ||
    (payload.subject !== undefined && typeof payload.subject !== 'string') ||
    (payload.body !== undefined && typeof payload.body !== 'string') ||
    (payload.threadId !== undefined && typeof payload.threadId !== 'string')) {
    throw new SendInputError('INVALID_SEND_REQUEST')
  }
  const recipients = (value: unknown, field: string): Array<{ name: string; email: string }> => {
    if (value === undefined && field !== 'to') return []
    if (!Array.isArray(value) || (field === 'to' && !value.length) || value.some((item) =>
      !item || typeof item !== 'object' || typeof item.email !== 'string' ||
      !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(item.email) ||
      (item.name !== undefined && (typeof item.name !== 'string' || /[\r\n]/.test(item.name))))) {
      throw new SendInputError('INVALID_SEND_REQUEST', `/${field}`)
    }
    return value.map((item) => ({ name: item.name ?? item.email, email: item.email }))
  }
  const to = recipients(payload.to, 'to')
  const cc = recipients(payload.cc, 'cc')
  const bcc = recipients(payload.bcc, 'bcc')
  const message = sqlite.query<{ thread_id: string }, [string, string, string]>(`
    SELECT thread_id FROM messages WHERE id = ? AND user_id = ? AND account_id = ?
  `).get(payload.messageId, job.userId, job.accountId)
  if (!message) {
    throw new ProviderError(account.provider, 'NOT_FOUND', 'The queued message no longer belongs to its original account')
  }

  // Older persisted jobs used an account-prefixed thread ID as their only reply intent.
  const mode = payload.mode === undefined
    ? typeof payload.threadId === 'string' && payload.threadId.startsWith(`${job.accountId}:`) ? 'reply' : 'compose'
    : payload.mode
  if (mode !== 'compose' && mode !== 'forward' && mode !== 'reply' && mode !== 'replyAll') {
    throw new SendInputError('INVALID_SEND_MODE', '/mode')
  }
  const attachments = normalizeSendAttachments(payload.attachments)
  if ((mode === 'reply' || mode === 'replyAll') &&
    (typeof payload.threadId !== 'string' || payload.threadId !== message.thread_id)) {
    throw new SendInputError('INVALID_SEND_REQUEST', '/threadId')
  }
  if (account.provider === 'mock') {
    recordConfirmedReply(job)
    return
  }

  const provider = await getReadyAccountProvider(job.userId, job.accountId)
  let nativeThreadId: string | undefined
  if (mode === 'reply' || mode === 'replyAll') {
    if (message.thread_id.startsWith(`${job.accountId}:`)) {
      nativeThreadId = message.thread_id.slice(job.accountId.length + 1)
    } else {
      // Locally composed conversations retain application IDs after sending.
      const reference = sqlite.query<{ provider_id: string }, [string, string, string, string]>(`
        SELECT provider_id FROM messages
        WHERE user_id = ? AND account_id = ? AND thread_id = ? AND id <> ?
          AND provider_id IS NOT NULL AND provider_id <> ''
        ORDER BY received_at DESC LIMIT 1
      `).get(job.userId, job.accountId, message.thread_id, payload.messageId)
      if (reference) nativeThreadId = (await provider.getMessage(reference.provider_id)).threadId
    }
    if (!nativeThreadId) throw new SendInputError('INVALID_SEND_REQUEST', '/threadId')
  }

  let senderEmail = account.email
  if (payload.senderEmail !== undefined) {
    if (typeof payload.senderEmail !== 'string' || !(await discoverMailSources(provider)).identities
      .some((identity) => identity.email.toLowerCase() === payload.senderEmail)) {
      throw new SendInputError('INVALID_SEND_REQUEST', '/senderEmail')
    }
    senderEmail = payload.senderEmail
  }
  const result = await provider.send({
    accountId: job.accountId,
    from: { name: account.name, email: senderEmail },
    to,
    cc,
    bcc,
    subject: payload.subject ?? '',
    body: payload.body ?? '',
    ...(nativeThreadId ? { threadId: nativeThreadId, replyAll: mode === 'replyAll' } : {}),
    attachments: attachments.map((attachment) => ({
      filename: attachment.filename,
      contentType: attachment.contentType,
      content: attachment.contentBase64,
      encoding: 'base64' as const,
      inline: attachment.inline,
      contentId: attachment.contentId,
    })),
  })

  sqlite.query(`
    UPDATE messages SET folder = 'sent', scheduled_at = NULL, provider_id = ?
    WHERE id = ? AND user_id = ? AND account_id = ?
  `).run(result.id, payload.messageId, job.userId, job.accountId)
  recordConfirmedReply(job)
  invalidatePriorities(job.userId, job.accountId)
}
