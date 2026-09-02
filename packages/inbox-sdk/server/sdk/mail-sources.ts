import type { InboxProvider } from './types'

export interface MailScope {
  kind: 'domain' | 'address'
  value: string
}

export interface MailSource extends MailScope {
  canReceive: boolean
  canSend: boolean
  canFilter?: boolean
  unavailableReason?: string
}

export interface SendingIdentity {
  email: string
  name?: string
}

export interface ConnectionSources {
  sources: MailSource[]
  identities: SendingIdentity[]
}

export async function discoverMailSources(provider: InboxProvider): Promise<ConnectionSources> {
  const discoverable = provider as InboxProvider & { getMailSources?: () => Promise<ConnectionSources> }
  return typeof discoverable.getMailSources === 'function'
    ? discoverable.getMailSources()
    : { sources: [], identities: [] }
}
