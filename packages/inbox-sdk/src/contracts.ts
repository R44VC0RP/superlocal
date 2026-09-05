import type { Database } from 'bun:sqlite'
import type { InboxProvider, ProviderCredentials, MessageMutation, SyncCursor, SendingIdentity } from '../server/sdk/types'
import type { Participant, ProviderCapabilities } from './types'
import type { ConnectionSources } from '../server/sdk/mail-sources'

export const API_VERSION = '1' as const
export type { Participant, ProviderCapabilities, SendingIdentity }

export interface SendingIdentities {
  sourceId: string
  identities: SendingIdentity[]
  /** Provider lookup completion time; null for legacy provider metadata. */
  checkedAt: string | null
}

export class InboxError extends Error {
  readonly name = 'InboxError'
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly retryable = false,
  ) { super(message) }
}

export class CredentialError extends InboxError {
  constructor(readonly reason: 'unavailable' | 'revoked', message = 'Provider credentials are unavailable.', readonly retryAfter?: number) {
    super(reason === 'revoked' ? 'CREDENTIALS_REVOKED' : 'CREDENTIALS_UNAVAILABLE', message, reason === 'revoked' ? 409 : 503, reason !== 'revoked')
  }
}

export interface CredentialContext {
  owner: string
  connection: Connection
  credentials: Readonly<Record<string, unknown>>
  reason: 'operation' | 'expired' | 'rejected' | 'update'
  signal: AbortSignal
}

export interface CredentialState {
  connectionId: string
  generation: number
  version: number
  status: Connection['status']
}

export interface ConnectionAuthorization {
  identity: ConnectionIdentity
  generation: number
}

export interface MediaTarget {
  /** Private source URL. Never log it or forward caller credentials/headers. */
  url: string
  address: string
  family: 4 | 6
  headers: Readonly<Record<string, string>>
}

export interface MediaNetwork {
  resolve(hostname: string, signal: AbortSignal): Promise<readonly string[]>
  /** Trusted host transport: connect ONLY to address, with the URL's Host/SNI and normal TLS verification. No redirects or automatic decompression. */
  request(target: Readonly<MediaTarget>, signal: AbortSignal): Promise<Response>
}

export interface MediaOptions {
  /** Explicit pinned transport for hosts with an injected fetch. Otherwise custom fetch makes uncached media fail closed. */
  network?: MediaNetwork
  timeoutMs?: number
  maxBytes?: number
  concurrency?: number
  cacheBytes?: number
  cacheEntries?: number
  cacheTtlMs?: number
}

export interface MediaContent { contentType: string; content: Uint8Array; noStore?: boolean }

export interface ProviderDefinition {
  id: string
  name: string
  /** Translate retained native folder roles into upstream category facts, without opening a provider connection. */
  nativeCategoryRoles?: Readonly<Record<string, string>>
  connection?: 'oauth' | 'credentials'
  scopes?: string[]
  /** Runtime cancellation is separate from provider-validated credential fields. */
  create(credentials: ProviderCredentials & Record<string, unknown>, context?: { signal: AbortSignal }): InboxProvider | Promise<InboxProvider>
  refresh?(credentials: Record<string, unknown>, signal: AbortSignal, context?: CredentialContext): Promise<Record<string, unknown>>
  discover?(provider: InboxProvider): Promise<ConnectionSources>
  mailboxSelection?: 'automatic' | 'manual'
  /** False when the provider cannot prove that replacement credentials address the same store. */
  credentialReconnect?: boolean
}

export interface InboxOptions {
  database?: string | Database
  encryptionKey: string
  providers: readonly ProviderDefinition[]
  now?: () => number
  fetch?: typeof fetch
  media?: MediaOptions
  syncIntervalMs?: number
  eventRetention?: number
  leaseMs?: number
  concurrency?: number
  log?: (event: { code: string; operation: string }) => void
  allowProviderWrites?: boolean
  /** Host defaults for owners without a saved policy; saved user choices always win. */
  defaultPolicy?: Partial<Policy>
  /** Trusted host callback returning complete, usable credentials for this connection. */
  resolveCredentials?(context: CredentialContext): Promise<Record<string, unknown>>
  /** Return true only after verifying replacement credentials address the same upstream store. */
  verifyCredentials?(context: CredentialContext): Promise<boolean> | boolean
}

export interface Account {
  id: string
  providerId: string
  email: string
  name: string
  generation: number
  status: 'connected' | 'disconnected' | 'reconnect_required'
  capabilities: Readonly<ProviderCapabilities>
  features: { localDrafts: true; localLabels: true; snooze: true; scheduledSend: boolean; undoSend: boolean }
  /** Coverage describes the primary inbox lane, not completion of every native folder. */
  sync: { lastSyncAt: string | null; coverage: 'empty' | 'partial' | 'complete'; problem: string | null }
  revision: number
  connectionId?: string
}

export interface ConnectionIdentity {
  issuer: string
  subject: string
  registrationId: string
}

export interface Connection {
  id: string
  providerId: string
  name: string
  status: Account['status']
  generation: number
  sourceIds: string[]
  identity: ConnectionIdentity | null
  createdAt: string
}

export type MailboxSelector = { kind: 'all' } | { kind: 'domain' | 'address'; value: string }
export interface MailboxCandidate {
  sourceId: string
  name: string
  selector: MailboxSelector
  canReceive: boolean
  canSend: boolean
  canFilter: boolean
  identities: string[]
  unavailableReason?: string
}

export interface Mailbox {
  id: string
  sourceId: string
  connectionId: string
  name: string
  selector: MailboxSelector
  status: 'active' | 'paused' | 'detached'
  defaultSender: string | null
  revision: number
  receiving: 'ready' | 'blocked' | 'unverified'
}

export interface MailboxInput {
  sourceId: string
  name: string
  selector: MailboxSelector
  defaultSender?: string | null
}

export interface MailboxMembership {
  mailboxId: string
  messageId: string
  revision: number
  done: boolean
  snoozedUntil: string | null
}

export interface MailboxMessageSummary extends Omit<MessageSummary, 'snoozedUntil'> {
  sourceId: string
  memberships: MailboxMembership[]
}

export interface MailboxQuery extends Omit<Query, 'accountId'> {
  mailboxIds: string[]
  done?: boolean
  snoozed?: boolean
}

export const MAILBOX_SYNC_PROBLEM_CODES = ['AUTHENTICATION', 'AUTHORIZATION', 'CREDENTIALS_REVOKED', 'CREDENTIALS_UNAVAILABLE',
  'RECONNECT_REQUIRED', 'NOT_FOUND', 'RATE_LIMITED', 'INVALID_CURSOR', 'UNSUPPORTED_OPERATION', 'VALIDATION',
  'NETWORK', 'UPSTREAM', 'INVALID_PROVIDER', 'INTERNAL'] as const
export type MailboxSyncProblemCode = typeof MAILBOX_SYNC_PROBLEM_CODES[number]
export interface MailboxSyncStatus {
  sourceId: string
  /** Opaque binding to the current effective source selection, not an individual mailbox view. */
  scopeKey: string
  state: 'syncing' | 'waiting' | 'error' | 'paused' | 'idle'
  activeLanes: Array<'latest' | 'backfill'>
  /** Earliest permitted retry, not a promise that a worker will run then. */
  retryAt: string | null
  problemCode: MailboxSyncProblemCode | null
  /** Records in the last successfully committed batch; not unique arrivals or cumulative progress. */
  lastBatch: { lane: 'latest' | 'backfill'; processed: number; completedAt: string; hasMore: boolean } | null
  /** Persisted source timestamp, including native folders; not proof this selection or inbox completed. */
  lastSyncAt: string | null
}

export interface MailboxThreadKey { sourceId: string; threadId: string }
export interface MailboxMessagePageInput { mailboxIds: string[]; limit?: number; cursor?: string; sourceId?: string; threadId?: string }
/** Live descending receivedAt/id keyset. Reconcile from the first state after paging; not a frozen inventory. */
export interface MailboxMessagePage { items: MailboxMessageSummary[]; nextCursor: string | null; state: string; scopeState: string }
export type MailboxConversationQuery = Omit<MailboxQuery, 'mailboxIds' | 'cursor' | 'limit' | 'sort'>
export interface MailboxConversationsInput { mailboxIds: string[]; limit?: number; cursor?: string; keys?: MailboxThreadKey[]; query?: MailboxConversationQuery }
export interface MailboxConversation extends MailboxThreadKey {
  /** Oldest selected message's subject/identity, ordered by receivedAt ASC then id ASC. */
  subject: string
  firstMessageId: string
  /** Aggregates cover every selected message, not only the query's matching messages or previews. */
  messageCount: number
  membershipCount: number
  doneMembershipCount: number
  /** Unique primary-inbox messages with any selected !done membership whose snooze is absent or <= read time. */
  awakeInboxMessageCount: number
  /** Minimum future snooze among all selected memberships, including Done memberships; otherwise null. */
  earliestSnoozedUntil: string | null
  lastMessageAt: string
  isRead: boolean
  isStarred: boolean
  hasAttachments: boolean
  /** Native primary folder or native folder-role presence, across the complete selected conversation. */
  nativeFolders: { inbox: boolean; archive: boolean; sent: boolean; drafts: boolean; spam: boolean; trash: boolean }
  mailboxStates: Array<{ mailboxId: string; messageCount: number; doneCount: number; snoozedCount: number }>
  /** Newest up to 50 cached summaries; fetch deeper messages using mailboxMessagePage. */
  messages: MailboxMessageSummary[]
  messagesComplete: boolean
  /** Captured conditional-action references, up to 500. Never infer targets for later replies. */
  targets: MailboxStateTarget[]
  targetsComplete: boolean
}
export interface MailboxConversationsPage { items: MailboxConversation[]; nextCursor: string | null; state: string; scopeState: string }
export interface MailboxCountsInput { mailboxIds: string[]; query?: MailboxConversationQuery }
/** Exact cached matching messages and distinct matching source/thread keys; overlapping mailboxes are deduplicated. */
export interface MailboxCounts { messages: number; conversations: number; asOfState: string; scopeState: string }

export interface MailboxSnapshotInput { mailboxIds: string[]; cursor?: string; limit?: number }
/** Stable ID inventory, live rows: finish paging, then catch up from the fixed state baseline. */
export interface MailboxSnapshotPage {
  items: MailboxMessageSummary[]
  total: number
  nextCursor: string | null
  state: string
  scopeState: string
  expiresAt: string
}
export interface MailboxChangesInput { mailboxIds: string[]; since: string; scopeState: string; limit?: number }
export interface MailboxChangesPage extends ChangePage {
  /** Includes retained identities of deleted/unselected messages. Empty on scope/history reset. */
  affectedThreads: MailboxThreadKey[]
  upserts: MailboxMessageSummary[]
  /** unselected removes only this scope's membership, not the canonical message. */
  removed: Array<{ sourceId: string; messageId: string; reason: 'deleted' | 'unselected'; revision: number | null }>
  resetReason?: 'history' | 'scope'
}

export interface BlobInfo {
  id: string
  accountId: string
  filename: string
  contentType: string
  size: number
  inline?: boolean
  contentId?: string
}

export interface MailFacts {
  version: 1
  listId?: boolean
  listUnsubscribe?: boolean
  listPost?: boolean
  bulk?: boolean
  automated?: boolean
  unsubscribeLink?: boolean
  reply?: boolean
  nativeCategories?: string[]
  nativeImportant?: boolean
}

export interface MailboxStateTarget {
  mailboxId: string
  messageId: string
  revision: number
  messageRevision?: number
}
export interface MailboxStateReceipt {
  id: string
  retracted: boolean
  states: MailboxMembership[]
}

export interface MessageSummary {
  id: string
  accountId: string
  threadId: string
  revision: number
  from: Participant
  to: Participant[]
  cc: Participant[]
  subject: string
  preview: string
  receivedAt: string
  isRead: boolean
  isStarred: boolean
  folder: string
  folderIds: string[]
  labelIds: string[]
  hasAttachments: boolean
  snoozedUntil: string | null
  facts?: MailFacts
  /** Opaque presentation/content identity. Legacy rows use a coarse revision fallback; older SDK responses may omit it. */
  bodyRevision?: string
}

export interface Message extends MessageSummary {
  bcc: Participant[]
  bodyText: string
  bodyHtml: string
  /** Selected display representation, not the original MIME type. */
  bodyFormat?: 'html' | 'text'
  /** Parse html as an isolated document; retains html/body attributes and unscoped sanitized CSS. */
  bodyDocument?: { html: string; styles: string }
  attachments: BlobInfo[]
  replyTo?: Participant[]
}

export interface ThreadSummary {
  id: string
  accountId: string
  subject: string
  preview: string
  messageCount: number
  matchingMessageCount: number
  isRead: boolean
  isStarred: boolean
  lastMessageAt: string
  hasAttachments: boolean
}

export interface Query {
  accountId?: string
  folder?: string
  labelId?: string
  search?: string
  unreadOnly?: boolean
  starredOnly?: boolean
  hasAttachments?: boolean
  from?: string
  to?: string
  before?: string
  after?: string
  sort?: 'newest' | 'oldest'
  cursor?: string
  limit?: number
}

export interface Page<T> {
  items: T[]
  nextCursor: string | null
  state: string
  total: number
}

export interface Folder {
  id: string
  accountId: string
  name: string
  role: string
  kind: 'folder' | 'label'
  scope: 'provider'
}

export interface Label {
  id: string
  accountId: string
  name: string
  scope: 'local'
  revision: number
}

export interface DraftInput {
  accountId: string
  mailboxId?: string
  from?: string
  to?: Participant[]
  cc?: Participant[]
  bcc?: Participant[]
  subject?: string
  bodyText?: string
  bodyHtml?: string
  attachmentIds?: string[]
  mode?: 'compose' | 'reply' | 'replyAll' | 'forward'
  sourceMessageId?: string
}

export interface Draft extends Required<Omit<DraftInput, 'sourceMessageId' | 'mailboxId'>> {
  id: string
  revision: number
  sourceMessageId?: string
  mailboxId?: string
  status: 'active' | 'submitted'
  updatedAt: string
}

export interface Changes extends MessageMutation {
  addLabelIds?: string[]
  removeLabelIds?: string[]
  folderId?: string
}

export interface MutationInput {
  messageIds: string[]
  changes: Changes
  idempotencyKey: string
  ifRevisions?: Record<string, number>
  viaMailboxId?: string
}

export interface Problem { code: string; message: string; retryable: boolean }
export interface Operation {
  id: string
  accountId: string
  type: 'mutation' | 'send'
  status: 'pending' | 'processing' | 'succeeded' | 'partial' | 'failed' | 'cancelled' | 'uncertain'
  createdAt: string
  sendAt: string | null
  attempts: number
  problem: Problem | null
  results: Array<{ messageId: string; status: 'succeeded' | 'failed'; problem?: Problem }>
  /** Stored, operation-owned revision transitions; unrelated changes remain gaps. At most 2,000 edges. */
  mutationRevisions?: Array<{ messageId: string; before: number; after: number }>
}

export interface ChangeEvent {
  id: string
  type: 'mail.changed' | 'account.updated' | 'draft.updated' | 'operation.updated' | 'label.updated' | 'policy.updated' | 'connection.updated' | 'mailbox.updated' | 'membership.updated'
  accountId: string | null
  entityId: string
  change: 'created' | 'updated' | 'deleted'
  reason: 'arrival' | 'initial' | 'backfill' | 'mutation'
  at: string
  mailboxId?: string
}

export interface ChangePage {
  events: ChangeEvent[]
  state: string
  hasMore: boolean
  resetRequired: boolean
}

export interface Policy { remoteImages: boolean; undoSendSeconds: number }

export interface SyncRequest {
  folder?: string
  lane?: 'latest' | 'backfill'
  reset?: boolean
  limit?: number
}

export interface Inbox {
  providers(): Array<{ id: string; name: string; connection: 'oauth' | 'credentials'; scopes: string[] }>
  connect(owner: string, input: { providerId: string; credentials: Record<string, unknown> }): Promise<Account>
  reconnect(owner: string, id: string, credentials: Record<string, unknown>, authorization?: ConnectionAuthorization): Promise<Account>
  disconnect(owner: string, id: string): Promise<void>
  accounts(owner: string): Promise<Account[]>
  account(owner: string, id: string): Promise<Account>
  sendingIdentities(owner: string, sourceId: string, input?: { refresh?: boolean }): Promise<SendingIdentities>
  connections(owner: string): Promise<Connection[]>
  connection(owner: string, id: string): Promise<Connection>
  /** identity is a trusted server-side assertion, never accepted from an unauthenticated request body. */
  createConnection(owner: string, input: { providerId: string; credentials: Record<string, unknown> }, identity?: ConnectionIdentity): Promise<Connection>
  credentialState(owner: string, connectionId: string): Promise<CredentialState>
  updateCredentials(owner: string, connectionId: string, credentials: Record<string, unknown>, version: number, identity?: ConnectionIdentity): Promise<CredentialState>
  disconnectConnection(owner: string, id: string): Promise<void>
  mailboxCandidates(owner: string, connectionId: string): Promise<MailboxCandidate[]>
  mailboxes(owner: string): Promise<Mailbox[]>
  mailbox(owner: string, id: string): Promise<Mailbox>
  createMailbox(owner: string, input: MailboxInput): Promise<Mailbox>
  updateMailbox(owner: string, id: string, input: { name?: string; status?: Mailbox['status']; defaultSender?: string | null }, revision: number): Promise<Mailbox>
  mailboxMessages(owner: string, query: MailboxQuery): Promise<Page<MailboxMessageSummary>>
  mailboxMessagePage(owner: string, input: MailboxMessagePageInput): Promise<MailboxMessagePage>
  mailboxConversations(owner: string, input: MailboxConversationsInput): Promise<MailboxConversationsPage>
  mailboxCounts(owner: string, input: MailboxCountsInput): Promise<MailboxCounts>
  /** Read-only primary-inbox activity, grouped by source; excludes detached mailbox selections. */
  mailboxSyncStatus(owner: string, input: { mailboxIds: string[] }): Promise<MailboxSyncStatus[]>
  mailboxSnapshot(owner: string, input: MailboxSnapshotInput): Promise<MailboxSnapshotPage>
  mailboxChanges(owner: string, input: MailboxChangesInput): Promise<MailboxChangesPage>
  /** Cached metadata only; never reads a body, including legacy fact enrichment. */
  mailboxMessageSummary(owner: string, mailboxId: string, messageId: string): Promise<MailboxMessageSummary>
  mailboxMessage(owner: string, mailboxId: string, messageId: string): Promise<Message & { sourceId: string; memberships: MailboxMembership[] }>
  setMailboxState(owner: string, mailboxId: string, messageId: string, input: { done?: boolean; snoozedUntil?: string | null }, revision: number): Promise<MailboxMembership>
  /** Atomic local-only state change with a durable idempotency receipt; no provider mutation.
   * At least one change is required. Snooze-only preserves Done; Done-only clears snooze as before. */
  setMailboxStates(owner: string, input: { id: string; targets: MailboxStateTarget[]; done?: boolean; snoozedUntil?: string | null }): Promise<MailboxStateReceipt>
  /** Read the owned historical receipt, even after its source is detached; never changes mailbox state. */
  mailboxStateReceipt(owner: string, id: string): Promise<MailboxStateReceipt>
  undoMailboxStates(owner: string, id: string): Promise<MailboxStateReceipt>
  syncMailbox(owner: string, mailboxId: string, options?: SyncRequest): Promise<{ synchronized: number; hasMore: boolean; state: string }>
  sync(owner: string, id: string, options?: SyncRequest): Promise<{ synchronized: number; hasMore: boolean; state: string }>
  folders(owner: string, accountId: string): Promise<Folder[]>
  /** Materialized folder metadata only; never initializes or calls a provider. */
  cachedFolders(owner: string, accountId: string): Promise<Folder[]>
  createFolder(owner: string, accountId: string, name: string): Promise<Folder>
  messages(owner: string, query?: Query): Promise<Page<MessageSummary>>
  message(owner: string, id: string): Promise<Message>
  /** Fetch an eligible image referenced by the current owned message, subject to current image policy. */
  media(owner: string, messageId: string, resource: string): Promise<MediaContent>
  threads(owner: string, query?: Query): Promise<Page<ThreadSummary>>
  thread(owner: string, id: string, query?: Pick<Query, 'cursor' | 'limit' | 'sort'>): Promise<Page<MessageSummary>>
  labels(owner: string, accountId?: string): Promise<Label[]>
  createLabel(owner: string, accountId: string, name: string): Promise<Label>
  updateLabel(owner: string, id: string, name: string, revision: number): Promise<Label>
  deleteLabel(owner: string, id: string): Promise<void>
  upload(owner: string, accountId: string, file: { filename: string; contentType: string; content: Uint8Array; inline?: boolean; contentId?: string }): Promise<BlobInfo>
  download(owner: string, id: string): Promise<{ info: BlobInfo; content: Uint8Array }>
  drafts(owner: string, accountId?: string): Promise<Draft[]>
  createDraft(owner: string, input: DraftInput): Promise<Draft>
  draft(owner: string, id: string): Promise<Draft>
  updateDraft(owner: string, id: string, input: Partial<DraftInput>, revision: number): Promise<Draft>
  deleteDraft(owner: string, id: string, revision: number): Promise<void>
  submit(owner: string, id: string, input: { revision: number; idempotencyKey: string; sendAt?: string }): Promise<Operation>
  mutate(owner: string, input: MutationInput): Promise<Operation>
  operation(owner: string, id: string): Promise<Operation>
  cancel(owner: string, id: string): Promise<Operation>
  reschedule(owner: string, id: string, sendAt: string): Promise<Operation>
  undo(owner: string, id: string): Promise<Operation>
  policy(owner: string): Promise<Policy>
  setPolicy(owner: string, input: Partial<Policy>): Promise<Policy>
  changes(owner: string, input?: { since?: string; limit?: number }): Promise<ChangePage>
  subscribe(owner: string, listener: () => void): () => void
  runDue(): Promise<void>
  poll(): Promise<void>
  start(): void
  close(): Promise<void>
}

export interface SyncCheckpoint { cursor: SyncCursor | null; initialized: boolean }
