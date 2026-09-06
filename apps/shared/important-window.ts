import type { Mail } from '../web/src/data'

export const IMPORTANT_WINDOW_DAYS = 45
export const IMPORTANT_WINDOW_MS = IMPORTANT_WINDOW_DAYS * 86_400_000
export const IMPORTANT_WINDOW_VERSION = 'recent-important-1'

/** A view boundary, never a category change or a mailbox mutation. */
export function importantReceivedAt(mail: Pick<Mail, 'importantReceivedAt' | 'messages'>, now = Date.now()): number | null {
  // The SDK aggregate covers deep conversations beyond the bounded preview.
  if (mail.importantReceivedAt !== undefined) return mail.importantReceivedAt
  let latest: number | null = null
  for (const message of mail.messages) {
    if (message.pending || message.outgoing || message.nativeFolder && message.nativeFolder !== 'inbox') continue
    if (message.memberships?.length && !message.memberships.some(state => !state.done && (!state.snoozedUntil || Date.parse(state.snoozedUntil) <= now))) continue
    const at = Date.parse(message.receivedAt ?? '')
    if (Number.isFinite(at)) latest = Math.max(latest ?? -Infinity, at)
  }
  return latest
}

export function recentImportant(mail: Pick<Mail, 'importantReceivedAt' | 'messages'>, now = Date.now()): boolean {
  const received = importantReceivedAt(mail, now)
  // Legacy/unverified timestamps are not evidence that a message is old.
  return received === null ? mail.importantReceivedAt === undefined : received + IMPORTANT_WINDOW_MS > now
}

export function importantExpiry(mail: Pick<Mail, 'importantReceivedAt' | 'messages'>, now = Date.now()): number {
  const received = importantReceivedAt(mail, now)
  const expires = received === null ? Infinity : received + IMPORTANT_WINDOW_MS
  return expires > now ? expires : Infinity
}
