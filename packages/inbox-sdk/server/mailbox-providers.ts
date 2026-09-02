import type { MailboxProviderDescriptor, ProviderType } from '../src/types'
import { resolveAuthProviders } from './auth-providers'
import { getProviderDescriptor, listProviders } from './sdk'

function configuredProviderIds(environment: NodeJS.ProcessEnv): ProviderType[] | null {
  const configured = environment.INBOX_PROVIDERS?.trim()
  if (!configured) return null

  const supportedProviders = listProviders()
  const providers: ProviderType[] = []

  for (const entry of configured.split(',')) {
    const provider = entry.trim().toLowerCase()

    if (!supportedProviders.includes(provider as ProviderType)) {
      throw new Error(
        `INBOX_PROVIDERS contains unsupported provider "${provider}"; supported providers: ${supportedProviders.join(', ')}`,
      )
    }

    if (providers.includes(provider as ProviderType)) {
      throw new Error(`INBOX_PROVIDERS contains duplicate provider "${provider}"`)
    }

    providers.push(provider as ProviderType)
  }

  return providers
}

export function resolveMailboxProviders(
  environment: NodeJS.ProcessEnv = process.env,
): MailboxProviderDescriptor[] {
  const authProviders = new Set(resolveAuthProviders(environment).providers.map(({ id }) => id))
  const explicitlyEnabled = configuredProviderIds(environment)
  const providers = explicitlyEnabled ?? []

  if (!explicitlyEnabled) {
    if (authProviders.has('google')) providers.push('gmail')

    if (environment.MICROSOFT_CLIENT_ID?.trim() && environment.MICROSOFT_CLIENT_SECRET?.trim()) {
      providers.push('outlook')
    }

    if (environment.INBOUND_API_KEY?.trim() || authProviders.has('inbound')) {
      providers.push('inbound')
    }

    if (providers.length === 0) {
      providers.push('imap')
      if (environment.SEED_DEMO === 'true') providers.push('mock')
    }
  }

  return providers.map((provider) => {
    const descriptor = getProviderDescriptor(provider)

    if (descriptor.connection === 'oauth' && !authProviders.has('google')) {
      return { id: descriptor.id, name: descriptor.name, connection: 'credentials' }
    }

    return descriptor
  })
}

export const enabledMailboxProviders = resolveMailboxProviders()

export function isMailboxProviderEnabled(
  provider: ProviderType,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const providers = environment === process.env
    ? enabledMailboxProviders
    : resolveMailboxProviders(environment)

  if (providers.some(({ id }) => id === provider)) return true

  const demoSeeded = environment.SEED_DEMO === 'true' ||
    (environment.SEED_DEMO === undefined && environment.NODE_ENV !== 'production')

  return provider === 'mock' &&
    !environment.INBOX_PROVIDERS?.trim() &&
    environment.NODE_ENV !== 'production' &&
    demoSeeded
}
