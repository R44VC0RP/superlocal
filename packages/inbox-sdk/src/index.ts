export { createInbox } from './core'
export { builtInProviders } from './providers'
export * from './contracts'
export { ProviderError, UnsupportedOperationError } from '../server/sdk/types'
// Trusted-host OAuth wiring for the built-in Google provider; browsers never reach these directly.
export { createGoogleOAuthHost, type GoogleOAuthConfig } from '../server/google-oauth'
export { createGoogleOAuthApi } from '../server/google-oauth-api'
export { createGoogleCredentialRefresh, verifyGoogleCredentials } from '../server/credential-refresh'
export type { InboxProvider, ProviderCredentials, SyncCursor, SyncOptions, SyncResult, SendInput, SendResult,
  MessageMutation, ProviderFolder, ProviderListResult, ListOptions, AttachmentData } from '../server/sdk/types'
