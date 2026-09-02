import { GmailProvider } from '../server/sdk/gmail'
import { ImapProvider } from '../server/sdk/imap'
import { InboundProvider } from '../server/sdk/inbound'
import { OutlookProvider } from '../server/sdk/outlook'
import { ProviderError } from '../server/sdk/types'
import type { ProviderDefinition } from './contracts'

export const builtInProviders: readonly ProviderDefinition[] = Object.freeze([
  {
    id: 'gmail', name: 'Gmail', connection: 'oauth',
    scopes: ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.send'],
    create: (credentials) => {
      if (typeof credentials.accessToken !== 'string' || !credentials.accessToken) {
        throw new ProviderError('gmail', 'VALIDATION', 'Gmail requires an explicit OAuth access token')
      }
      return new GmailProvider({ ...credentials, accessToken: credentials.accessToken })
    },
  },
  {
    id: 'outlook', name: 'Outlook', connection: 'oauth',
    scopes: ['offline_access', 'User.Read', 'Mail.ReadWrite', 'Mail.Send'],
    create: (credentials) => {
      if (typeof credentials.accessToken !== 'string' || !credentials.accessToken) {
        throw new ProviderError('outlook', 'VALIDATION', 'Outlook requires an explicit OAuth access token')
      }
      return new OutlookProvider({ ...credentials, accessToken: credentials.accessToken })
    },
  },
  {
    id: 'imap', name: 'IMAP', connection: 'credentials',
    create: (credentials) => new ImapProvider(credentials),
  },
  {
    id: 'inbound', name: 'Inbound', connection: 'credentials', mailboxSelection: 'manual', credentialReconnect: false,
    create: (credentials) => {
      if (typeof credentials.apiKey !== 'string' || !credentials.apiKey) {
        throw new ProviderError('inbound', 'VALIDATION', 'Inbound requires an explicit API key')
      }
      return new InboundProvider({
        ...credentials, apiKey: credentials.apiKey,
        connectionMode: credentials.connectionMode === true ||
          ![credentials.address, credentials.email, credentials.domain].some((value) => typeof value === 'string' && value.length > 0),
      })
    },
    discover: (provider) => {
      if (!(provider instanceof InboundProvider)) {
        throw new ProviderError('inbound', 'VALIDATION', 'Inbound discovery requires an Inbound provider')
      }
      return provider.getMailSources()
    },
  },
] satisfies ProviderDefinition[])
