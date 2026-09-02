export { createInbox } from './core'
export { builtInProviders } from './providers'
export * from './contracts'
export { ProviderError, UnsupportedOperationError } from '../server/sdk/types'
export type { InboxProvider, ProviderCredentials, SyncCursor, SyncOptions, SyncResult, SendInput, SendResult,
  MessageMutation, ProviderFolder, ProviderListResult, ListOptions, AttachmentData } from '../server/sdk/types'
