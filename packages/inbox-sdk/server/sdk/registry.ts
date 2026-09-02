import { GmailProvider, type GmailCredentials } from './gmail'
import { ImapProvider, type ImapCredentials } from './imap'
import { InboundProvider, type InboundCredentials } from './inbound'
import { OutlookProvider, type OutlookCredentials } from './outlook'
import {
  ProviderError,
  type InboxProvider,
  type InboxProviderType,
  type MailboxProviderDescriptor,
  type ProviderCredentials,
} from './types'

export * from './types'
export * from './gmail'
export * from './outlook'
export * from './imap'
export * from './inbound'

export interface ProviderCredentialsMap {
  [provider: string]: ProviderCredentials
  mock: ProviderCredentials
  gmail: GmailCredentials
  outlook: OutlookCredentials
  imap: ImapCredentials
  inbound: InboundCredentials
}

export type ProviderFactory<T extends InboxProviderType = InboxProviderType> = (
  credentials: ProviderCredentialsMap[T],
) => InboxProvider

export class ProviderRegistry {
  private readonly factories = new Map<InboxProviderType, (credentials: never) => InboxProvider>()

  register<T extends InboxProviderType>(type: T, factory: ProviderFactory<T>): this {
    this.factories.set(type, factory as (credentials: never) => InboxProvider)
    return this
  }

  has(type: InboxProviderType): boolean {
    return this.factories.has(type)
  }

  get<T extends InboxProviderType>(type: T): ProviderFactory<T> | undefined {
    return this.factories.get(type) as ProviderFactory<T> | undefined
  }

  list(): InboxProviderType[] {
    return [...this.factories.keys()]
  }

  create<T extends InboxProviderType>(type: T, credentials: ProviderCredentialsMap[T]): InboxProvider {
    const factory = this.factories.get(type)
    if (!factory) {
      throw new ProviderError(type, 'UNSUPPORTED_OPERATION', `No provider is registered for ${type}`)
    }
    return factory(credentials as never)
  }
}

export const providerRegistry = new ProviderRegistry()
  .register('gmail', (credentials) => new GmailProvider(credentials))
  .register('outlook', (credentials) => new OutlookProvider(credentials))
  .register('imap', (credentials) => new ImapProvider(credentials))
  .register('inbound', (credentials) => new InboundProvider(credentials))

const PROVIDER_DESCRIPTORS: Record<InboxProviderType, MailboxProviderDescriptor> = {
  mock: { id: 'mock', name: 'Demo', connection: 'credentials' },
  gmail: {
    id: 'gmail',
    name: 'Gmail',
    connection: 'oauth',
    authProvider: 'google',
    scopes: [
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.send',
    ],
  },
  outlook: { id: 'outlook', name: 'Outlook', connection: 'credentials' },
  imap: { id: 'imap', name: 'IMAP', connection: 'credentials' },
  inbound: { id: 'inbound', name: 'Inbound', connection: 'credentials' },
}

export function registerProvider<T extends InboxProviderType>(type: T, factory: ProviderFactory<T>): void {
  providerRegistry.register(type, factory)
}

export function getProviderFactory<T extends InboxProviderType>(type: T): ProviderFactory<T> | undefined {
  return providerRegistry.get(type)
}

export function listProviders(): InboxProviderType[] {
  return providerRegistry.list()
}

export function getProviderDescriptor(type: InboxProviderType): MailboxProviderDescriptor {
  const descriptor = PROVIDER_DESCRIPTORS[type]
  return {
    ...descriptor,
    ...(descriptor.scopes ? { scopes: [...descriptor.scopes] } : {}),
  }
}

export function createProvider<T extends InboxProviderType>(type: T, credentials: ProviderCredentialsMap[T]): InboxProvider {
  return providerRegistry.create(type, credentials)
}
