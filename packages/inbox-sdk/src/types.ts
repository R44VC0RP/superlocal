export type ProviderType = 'mock' | 'gmail' | 'outlook' | 'imap' | 'inbound' | (string & {})

export interface MailboxProviderDescriptor {
  id: ProviderType
  name: string
  connection: 'oauth' | 'credentials'
  authProvider?: string
  scopes?: string[]
}

export type MailFolder =
  | 'inbox'
  | 'starred'
  | 'sent'
  | 'drafts'
  | 'archive'
  | 'trash'
  | 'spam'
  | 'snoozed'
  | 'scheduled'
  | (string & {})

export type ReadingMode = 'fullscreen' | 'sheet' | 'sidebar'
export type MailSortOrder = 'newest' | 'oldest' | 'priority'
export type InboxCategory = 'important' | 'other'
export type InboxView = InboxCategory | 'quarantine'
export type PersonalizationMode = 'off' | 'suggest' | 'adaptive'
export type PrioritySectionMode = 'automatic' | 'starred' | 'needs-action' | 'off'
export interface MailPriority {
  score: number
  level: 'priority' | 'important' | 'other'
  source: 'provider' | 'manual' | 'learned' | 'protected'
  reason: string
  sampleCount: number
  providerImportant: boolean
  suggestedCategory?: InboxCategory | 'spam'
}
export interface PersonalizationStatus {
  mode: PersonalizationMode
  feedbackCount: number
  readingCount: number
  learnedAccounts: number
  suggestionCount: number
}
export type FontFamily = 'circular' | 'system' | 'rounded' | 'serif' | 'mono'

export interface Participant {
  name: string
  email: string
  avatar?: string | null
}

export interface Attachment {
  id: string
  filename: string
  contentType: string
  size: number
  url: string
  inline?: boolean
  contentId?: string
}

/** Native adapter operations, not locally implemented views or workflows. */
export interface ProviderCapabilities {
  sync: boolean
  incrementalSync: boolean
  deltaSync: boolean
  send: boolean
  reply: boolean
  threads: boolean
  nativeThreads: boolean
  folders: boolean
  createFolders: boolean
  labels: boolean
  archive: boolean
  trash: boolean
  permanentDelete: boolean
  markRead: boolean
  markUnread: boolean
  star: boolean
  attachments: boolean
  attachmentDownload: boolean
  search: boolean
  drafts: boolean
  scheduledSend: boolean
  snooze: boolean
  readReceipts: boolean
  pushNotifications: boolean
}

export interface MailAccount {
  id: string
  userId?: string
  name: string
  email: string
  aliases?: string[]
  provider: ProviderType
  color: string
  syncStatus: 'idle' | 'syncing' | 'error' | 'connected'
  lastSyncAt?: string | null
  unreadCount: number
  signature?: string
  avatar?: string | null
  /** Absent in older persisted caches; null when the adapter cannot be configured. */
  capabilities?: Readonly<ProviderCapabilities> | null
}

export interface AccountFolder {
  id: string
  name: string
  folder: MailFolder
  path?: string
  custom?: boolean
  unreadCount?: number
  totalCount?: number
}

export interface AccountFoldersResponse {
  provider: ProviderType
  capabilities: { createFolders: boolean }
  folders: AccountFolder[]
}

export interface MailMessage {
  id: string
  threadId: string
  accountId: string
  /** Authenticated delivery provenance, supplied by the SDK rather than recipient headers. */
  sourceDomains?: string[]
  deliveryRecipients?: string[]
  from: Participant
  to: Participant[]
  cc: Participant[]
  bcc: Participant[]
  replyTo?: Participant[]
  rfcMessageId?: string
  inReplyTo?: string
  references?: string[]
  headers?: Record<string, string>
  /** Upstream categories only; adapters must not infer application attention categories. */
  nativeCategories?: string[]
  subject: string
  preview: string
  bodyText: string
  bodyHtml: string
  bodyStyles?: string
  receivedAt: string
  isRead: boolean
  isStarred: boolean
  isImportant?: boolean
  folder: MailFolder
  folderIds?: string[]
  labels: string[]
  attachments: Attachment[]
  snoozedUntil?: string | null
  scheduledAt?: string | null
  readReceipt?: boolean
}

export interface MailThread {
  id: string
  accountId: string
  subject: string
  preview: string
  participants: Participant[]
  messages: MailMessage[]
  messageCount: number
  lastMessageAt: string
  isRead: boolean
  isStarred: boolean
  isImportant?: boolean
  priorityOverride?: InboxCategory | null
  needsAction?: boolean
  priority?: MailPriority
  isQuarantined?: boolean
  folder: MailFolder
  labels: string[]
  hasAttachments: boolean
  snoozedUntil?: string | null
  scheduledAt?: string | null
}

export interface UserSettings {
  readingMode: ReadingMode
  remoteImages: boolean
  readReceipts: boolean
  keyboardShortcuts: boolean
  density: 'comfortable' | 'compact'
  signature: string
  undoSendSeconds: number
  theme: 'light' | 'dark' | 'system'
  fontFamily: FontFamily
  notifications: boolean
  autoAdvance: boolean
  showAvatars: boolean
  personalizationMode?: PersonalizationMode
  prioritySection?: PrioritySectionMode
}

export const DEFAULT_SETTINGS: UserSettings = {
  readingMode: 'fullscreen',
  remoteImages: true,
  readReceipts: true,
  keyboardShortcuts: true,
  density: 'comfortable',
  signature: '',
  undoSendSeconds: 10,
  theme: 'light',
  fontFamily: 'circular',
  notifications: true,
  autoAdvance: true,
  showAvatars: true,
  personalizationMode: 'off',
  prioritySection: 'automatic',
}

export interface ThreadListResponse {
  threads: MailThread[]
  nextCursor: string | null
  counts: Partial<Record<MailFolder, number>>
  categoryCounts?: Record<InboxCategory, number> & { quarantine?: number }
  priorityCount?: number
  total: number
}

export interface ComposeDraft {
  accountId: string
  inboxId?: string
  to: string
  cc: string
  bcc: string
  subject: string
  body: string
  threadId?: string
  mode: 'compose' | 'reply' | 'replyAll' | 'forward'
  scheduledAt?: string
  attachments?: File[]
}

export interface SendResult extends MailThread {
  thread: MailThread
  message: MailMessage
  scheduled: boolean
  delivery: {
    jobId: string
    status: SendStatus['status']
    statusUrl: string
  }
}

export interface SendStatus {
  messageId: string
  jobId: string
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled'
  attempts: number
  nextAttemptAt: string | null
  problem: {
    code: string
    error: string
    status: number
    stage: 'validation' | 'configuration' | 'dispatch' | 'recovery'
    diagnosticId: string
    retryable: boolean
    action: string
    field?: string
    retryAfterSeconds?: number
  } | null
}
