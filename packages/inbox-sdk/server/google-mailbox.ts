import type { Account, GenericEndpointContext } from 'better-auth'
import { getOAuthState } from 'better-auth/api'
import { decryptOAuthToken } from 'better-auth/oauth2'
import { decryptCredential, encryptCredential } from './crypto'
import { sqlite } from './db'

interface MailboxRow {
  id: string
  credentials_encrypted: string | null
}

interface GoogleIdentity {
  email: string
  name?: string
}

const GMAIL_READ_SCOPES = new Set([
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://mail.google.com/',
])

export async function provisionGoogleMailbox(
  account: Account,
  context: GenericEndpointContext | null,
): Promise<void> {
  if (
    account.providerId !== 'google' ||
    !context ||
    !account.accessToken ||
    !account.scope?.split(/[\s,]+/).some((scope) => GMAIL_READ_SCOPES.has(scope))
  ) return

  try {
    const authAccount = sqlite.query<{
      userId: string
      providerId: string
      accountId: string
    }, [string]>('SELECT userId, providerId, accountId FROM account WHERE id = ?').get(account.id)

    if (
      !authAccount ||
      authAccount.userId !== account.userId ||
      authAccount.providerId !== 'google' ||
      authAccount.accountId !== account.accountId
    ) {
      console.warn('Google mailbox onboarding skipped because the OAuth account ownership was invalid')
      return
    }

    const user = sqlite.query<{ name: string; email: string }, [string]>(
      'SELECT name, email FROM "user" WHERE id = ?',
    ).get(account.userId)
    if (!user) return

    const accessToken = await decryptOAuthToken(account.accessToken, context.context)
    const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })

    if (!response.ok) {
      console.warn(`Google mailbox profile request failed with status ${response.status}`)
      return
    }

    const profile = await response.json() as { emailAddress?: unknown }
    if (typeof profile.emailAddress !== 'string' || !profile.emailAddress.trim()) {
      console.warn('Google mailbox onboarding skipped because the Gmail profile was invalid')
      return
    }

    const email = profile.emailAddress.trim().toLowerCase()
    let identity: GoogleIdentity | null = null
    if (account.idToken) {
      const idToken = await decryptOAuthToken(account.idToken, context.context)
      const encodedPayload = idToken.split('.')[1]
      if (!encodedPayload) {
        console.warn('Google mailbox onboarding skipped because the OAuth identity was invalid')
        return
      }

      const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as {
        sub?: unknown
        email?: unknown
        name?: unknown
      }
      if (
        payload.sub !== account.accountId ||
        typeof payload.email !== 'string' ||
        payload.email.trim().toLowerCase() !== email
      ) {
        console.warn('Google mailbox onboarding skipped because the Gmail profile did not match its OAuth identity')
        return
      }
      identity = {
        email,
        ...(typeof payload.name === 'string' && payload.name.trim() ? { name: payload.name.trim() } : {}),
      }
    }

    const existing = sqlite.query<MailboxRow, [string, string]>(`
      SELECT id, credentials_encrypted FROM mail_accounts
      WHERE user_id = ? AND provider = 'gmail' AND email = ? COLLATE NOCASE
      ORDER BY created_at ASC, id ASC LIMIT 1
    `).get(account.userId, email)

    let previousCredentials: Record<string, unknown> = {}
    if (existing?.credentials_encrypted) {
      const parsed: unknown = JSON.parse(
        decryptCredential(existing.credentials_encrypted, account.userId, existing.id),
      )
      if (parsed && typeof parsed === 'object') previousCredentials = parsed as Record<string, unknown>
    }

    if (
      typeof previousCredentials.googleAuthAccountId === 'string' &&
      previousCredentials.googleAuthAccountId !== account.id
    ) {
      console.warn('Google mailbox onboarding skipped because the mailbox belongs to another OAuth identity')
      return
    }

    if (email !== user.email.trim().toLowerCase()) {
      const oauthState = await getOAuthState().catch(() => null)
      const explicitlyLinked = oauthState?.link?.userId === account.userId &&
        oauthState.link.email.trim().toLowerCase() === user.email.trim().toLowerCase()
      const previouslyLinked = previousCredentials.googleAuthAccountId === account.id
      if (!identity || (!explicitlyLinked && !previouslyLinked)) {
        console.warn('Google mailbox onboarding skipped because the Gmail address was not explicitly linked')
        return
      }
    }

    const refreshToken = account.refreshToken
      ? await decryptOAuthToken(account.refreshToken, context.context)
      : typeof previousCredentials.refreshToken === 'string'
        ? previousCredentials.refreshToken
        : undefined
    const expiry = account.accessTokenExpiresAt
      ? new Date(account.accessTokenExpiresAt).toISOString()
      : null

    const result = sqlite.transaction(() => {
      const current = sqlite.query<MailboxRow, [string, string]>(`
        SELECT id, credentials_encrypted FROM mail_accounts
        WHERE user_id = ? AND provider = 'gmail' AND email = ? COLLATE NOCASE
        ORDER BY created_at ASC, id ASC LIMIT 1
      `).get(account.userId, email)
      const id = current?.id ?? crypto.randomUUID()
      let currentCredentials = previousCredentials

      if (current && (!existing || current.id !== existing.id) && current.credentials_encrypted) {
        const parsed: unknown = JSON.parse(
          decryptCredential(current.credentials_encrypted, account.userId, current.id),
        )
        if (parsed && typeof parsed === 'object') currentCredentials = parsed as Record<string, unknown>
      }

      if (
        typeof currentCredentials.googleAuthAccountId === 'string' &&
        currentCredentials.googleAuthAccountId !== account.id
      ) return null

      const preservedRefreshToken = refreshToken ?? (
        typeof currentCredentials.refreshToken === 'string' ? currentCredentials.refreshToken : undefined
      )
      const credentials = {
        accessToken,
        ...(preservedRefreshToken ? { refreshToken: preservedRefreshToken } : {}),
        accessTokenExpiresAt: expiry,
        googleAuthAccountId: account.id,
      }
      const encrypted = encryptCredential(JSON.stringify(credentials), account.userId, id)
      const name = identity?.name ?? user.name ?? email

      if (current) {
        sqlite.query(`
          UPDATE mail_accounts SET name = ?, email = ?, credentials_encrypted = ?, sync_status = 'idle'
          WHERE id = ? AND user_id = ? AND provider = 'gmail'
        `).run(name, email, encrypted, id, account.userId)
      } else {
        sqlite.query(`
          INSERT INTO mail_accounts (id, user_id, name, email, provider, color, credentials_encrypted)
          VALUES (?, ?, ?, ?, 'gmail', '#696a70', ?)
        `).run(id, account.userId, name, email, encrypted)
      }

      return { id, created: !current }
    })()

    if (result) {
      void import('./provider-service')
        .then(({ synchronizeAccount }) => synchronizeAccount(account.userId, result.id, {
          folder: 'inbox',
          limit: 50,
        }))
        .catch(() => console.warn('Gmail mailbox synchronization failed after authorization'))
    }
  } catch {
    console.warn('Google mailbox onboarding was skipped after an OAuth provider error')
  }
}
