import type { MailboxSelector, Participant, SendingIdentity } from './contracts'

const nonIncomingFolders = new Set(['sent', 'draft', 'drafts', 'scheduled', 'outbox', 'unsent', 'queued'])

/** Outgoing mail is not evidence for a receiving address or an inferred reply sender. */
export const isIncomingRecipientFolder = (folder: string): boolean => !nonIncomingFolders.has(folder.toLowerCase())

/** Filter an authorized catalog for UI selection. SDK sender validation remains authoritative. */
export function sendingIdentityMatchesMailbox(email: string, selector: { kind?: MailboxSelector['kind']; value?: string }): boolean {
  if (selector.kind === 'address') return email.toLowerCase() === selector.value?.toLowerCase()
  if (selector.kind === 'domain') return email.split('@').at(-1)?.toLowerCase() === selector.value?.toLowerCase()
  return true
}

/**
 * Select within an already authorized, mailbox-scoped catalog. Headers grant no authority.
 * To order wins, then Cc order. Only a unique Delivered-To match may fill missing recipients.
 * Explicit From, sent-message continuation and the default sender remain caller-owned.
 */
export function senderFromRecipients(message: {
  folder: string
  to: readonly Pick<Participant, 'email'>[]
  cc: readonly Pick<Participant, 'email'>[]
  deliveredTo?: readonly string[]
}, identities: readonly Pick<SendingIdentity, 'email'>[]): string | undefined {
  if (!isIncomingRecipientFolder(message.folder)) return undefined
  const own = new Map(identities.map(identity => [identity.email.toLowerCase(), identity.email]))
  for (const recipient of [...message.to, ...message.cc]) {
    const sender = own.get(recipient.email.toLowerCase())
    if (sender !== undefined) return sender
  }
  // Repeated Delivered-To headers can describe distinct forwarding hops, not recipient order.
  const delivered = new Set((message.deliveredTo ?? []).flatMap(email => own.get(email.toLowerCase()) ?? []))
  return delivered.size === 1 ? delivered.values().next().value : undefined
}
