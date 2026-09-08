export type ProviderType = 'mock' | 'gmail' | 'outlook' | 'imap' | 'inbound' | (string & {})

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
  search: boolean
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

export interface MailMessage {
  id: string
  threadId: string
  accountId: string
  /** Authenticated delivery provenance, supplied by the SDK rather than recipient headers. */
  sourceDomains?: string[]
  deliveryRecipients?: string[]
  /** Untrusted Delivered-To header hints. Never use these as mailbox or sending authority. */
  deliveredTo?: string[]
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
  folder: MailFolder
  labels: string[]
  hasAttachments: boolean
  snoozedUntil?: string | null
  scheduledAt?: string | null
}
