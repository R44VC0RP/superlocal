import { GmailProvider, GMAIL_CATEGORY_ROLES } from '../server/sdk/gmail'
import { ImapProvider } from '../server/sdk/imap'
import { InboundProvider } from '../server/sdk/inbound'
import { OutlookProvider } from '../server/sdk/outlook'
import { ProviderError } from '../server/sdk/types'
import { CredentialError, type ProviderDefinition } from './contracts'

export const builtInProviders: readonly ProviderDefinition[] = Object.freeze([
  {
    id: 'gmail', name: 'Gmail', connection: 'oauth',
    nativeCategoryRoles: GMAIL_CATEGORY_ROLES,
    scopes: ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.send'],
    onboarding: { summary: 'Sign in with your Google account', actionLabel: 'Sign in with Google',
      redirectNote: 'You will be sent to Google to approve access, then brought back here while your mail loads.' },
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
    onboarding: { summary: 'Sign in with your Microsoft account', actionLabel: 'Sign in with Microsoft',
      redirectNote: 'You will be sent to Microsoft to approve access, then brought back here while your mail loads.' },
    create: (credentials) => {
      if (typeof credentials.accessToken !== 'string' || !credentials.accessToken) {
        throw new ProviderError('outlook', 'VALIDATION', 'Outlook requires an explicit OAuth access token')
      }
      return new OutlookProvider({ ...credentials, accessToken: credentials.accessToken })
    },
  },
  {
    id: 'imap', name: 'IMAP', connection: 'credentials', credentialReconnect: false,
    // Server endpoints are not fields: hosts pin them (presets) so browser input cannot redirect mail.
    onboarding: { summary: 'Email and mail password', actionLabel: 'Connect mailbox',
      fields: [
        { name: 'email', label: 'Email address', type: 'email', required: true },
        { name: 'password', label: 'Mail password', type: 'password', required: true },
        { name: 'imapUsername', label: 'IMAP username (defaults to email)', type: 'text', required: false, advanced: true },
        { name: 'smtpUsername', label: 'SMTP username (defaults to email)', type: 'text', required: false, advanced: true },
      ],
      advancedNote: 'Server endpoints and required TLS are set by the selected host preset. Change presets in the local host configuration.' },
    create: (credentials, context) => new ImapProvider({ ...credentials, signal: context?.signal }),
    // Passwords have no refresh protocol. Stop background authentication retries until
    // the trusted host replaces/re-authorizes the connection's credentials.
    refresh: async () => { throw new CredentialError('revoked', 'Reconnect with a valid mail password.') },
  },
  {
    id: 'inbound', name: 'Inbound', connection: 'credentials', mailboxSelection: 'manual', credentialReconnect: false,
    onboarding: { summary: 'Paste an API key', actionLabel: 'Connect Inbound',
      fields: [{ name: 'apiKey', label: 'API key', type: 'password', required: true }] },
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
  },
] satisfies ProviderDefinition[])
