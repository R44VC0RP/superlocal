import type { InboxProvider } from './types'

export interface MailScope {
  kind: 'domain' | 'address'
  value: string
  /** Optional discovery facts; selectors themselves need only kind/value. */
  canReceive?: boolean
  canSend?: boolean
  canFilter?: boolean
  unavailableReason?: string
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
  const identities = await provider.identities?.()
  return {
    sources: (identities?.receiving ?? []).map(scope => ({ ...scope,
      canReceive: scope.canReceive ?? true,
      canSend: scope.canSend ?? (provider.capabilities.send && !!identities?.sending.some(identity => scope.kind === 'address'
        ? identity.email.toLowerCase() === scope.value.toLowerCase() : identity.email.split('@').at(-1)?.toLowerCase() === scope.value.toLowerCase())),
      canFilter: scope.canFilter ?? true,
    })),
    identities: (identities?.sending ?? []).map(({ email }) => ({ email })),
  }
}
