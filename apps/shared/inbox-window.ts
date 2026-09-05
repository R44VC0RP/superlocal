import type { MailboxMessageSummary, MailboxStateTarget } from '../../packages/inbox-sdk/src/contracts'
import type { Mail, Message } from '../web/src/data'
import type { SenderContact, SenderWeek } from '../web/src/sender-context'
import type { ZeroBatchCandidate, ZeroDecision } from '../web/src/mail-view'

/** Transport/cache bounds, not limits on the server's indexed corpus or Zero capture. */
export const INBOX_FIRST_PAGE_LIMIT = 100
export const INBOX_PAGE_LIMIT = 100
export const INBOX_AUTO_PREFETCH_LIMIT = 300
export const INBOX_WINDOW_LIMIT = 1000
export const INBOX_WINDOW_BYTE_LIMIT = 32 * 1024 * 1024
export const INBOX_RESPONSE_BYTE_LIMIT = 4 * 1024 * 1024
export const INBOX_LOOKUP_LIMIT = 100
export const INBOX_SELECTED_PIN_LIMIT = 100
export const INBOX_PREVIEW_MESSAGE_LIMIT = 50
export const INBOX_ACTION_TARGET_LIMIT = 500
export const INBOX_DETAIL_PAGE_LIMIT = 100
export const INBOX_SENDER_RECENT_LIMIT = 5
export const INBOX_ZERO_PAGE_LIMIT = 100
export const INBOX_SEARCH_LENGTH_LIMIT = 4096

/** All operations use authenticated POST JSON; IDs/cursors are opaque and owner-bound. */
export const inboxWindowPaths = {
  query: '/host/inbox/query',
  page: '/host/inbox/page',
  counts: '/host/inbox/counts',
  lookup: '/host/inbox/lookup',
  changes: '/host/inbox/changes',
  messages: '/host/inbox/messages',
  sender: '/host/inbox/sender',
  contacts: '/host/inbox/contacts',
  selectionCreate: '/host/inbox/selection/create',
  selectionPage: '/host/inbox/selection/page',
  zeroCreate: '/host/inbox/zero/create',
  zeroResume: '/host/inbox/zero/resume',
  zeroPage: '/host/inbox/zero/page',
  zeroProgress: '/host/inbox/zero/progress',
  zeroUndo: '/host/inbox/zero/undo',
} as const

export type MailFilter = 'Unread' | 'Starred' | 'Important' | 'No reply' | 'Needs reply'
  | 'Action requested' | 'Time-sensitive' | 'Suspicious' | 'Unassessed'

/** Matches selectMailView: search mode ignores folder/split, not the active filter.
 * Host resolves saved receiving scope, split aliases/rules, AI policy and hold times.
 * Search retains mail-search syntax, including explicit Spam/Trash inclusion.
 * Never evaluate these predicates over only the browser's resident rows.
 */
export type InboxViewQuery = {
  account: string
  folder: string
  split: string
  search: boolean
  query: string
  filter: MailFilter | null
}
export type InboxQueryInput = InboxViewQuery & { limit?: number }
export type InboxThreadKey = { sourceId: string; threadId: string }

/** SDK state belongs to a receiving scope; revisions below belong to the derived app index.
 * Invalidate old responses on query/scope/source generation changes. A current index
 * describes cached SDK mail, not a promise that upstream provider backfill is finished.
 */
export type InboxWindowState = {
  queryId: string
  queryGeneration: number
  indexRevision: number
  scopeState: string
  preferenceRevision: string
  sources: Array<{ sourceId: string; generation: number }>
  sdkState: string | null
  indexing: boolean
  catchup: 'pending' | 'catching-up' | 'current' | 'blocked'
}

/** Exact scoped counts at indexRevision, or null when unknown. Never coerce null to 0. */
export type InboxTotals = {
  conversations: number | null
  messages: number | null
  inbox: number | null
  splits: Record<string, number | null>
  folders: Record<string, number | null>
  holding: boolean | null
}
export type InboxConversationCounts = {
  messages: number | null
  memberships: number | null
  unread: number | null
  done: number | null
  snoozed: number | null
}

export type InboxWindowRow = InboxThreadKey & {
  /** Stable existing app Mail.id, deduplicated by source/thread within this query. */
  key: string
  sourceGeneration: number
  revision: number
  /** App projection, with only body-free preview messages (body: '', loaded: false).
   * Whole-conversation flags/folder/attention come from the host, not this preview.
   */
  mail: Mail
  /** The same selected preview messages, including SDK revision and scoped memberships.
   * Keep for InboxStore optimistic state, body validators and receipt reconciliation.
   */
  summaries: MailboxMessageSummary[]
  messagesComplete: boolean
  counts: InboxConversationCounts
  /** Complete captured membership references only up to the existing 500-target bound.
   * A false completeness flag must not authorize an action on the returned subset.
   */
  targets: MailboxStateTarget[]
  targetsComplete: boolean
  /** Includes message/content context needed by W/category, not merely Done targets.
   * Detail paging does not itself rebase captured action context onto later replies.
   */
  actionContextComplete: boolean
  contextVersion: string
}

export type InboxWindowPage = {
  state: InboxWindowState
  rows: InboxWindowRow[]
  totals: InboxTotals
  nextCursor: string | null
  /** True only after complete indexed matching coverage; an empty indexing page is not exhaustion. */
  exhausted: boolean
}
export type InboxPageInput = { queryId: string; cursor?: string; limit?: number; direction?: 'older' | 'newer'; seek?: 'start' | 'end' }
export type InboxCountsInput = { queryId: string }
export type InboxCountsResult = { state: InboxWindowState; totals: InboxTotals }

/** At most 100 owned IDs, independent of active folder/search. Account still resolves
 * the receiving scope. No broadening ownership via deep links, drafts, selection or Undo.
 */
export type InboxLookupInput = { account: string; ids: string[] }
export type InboxLookupEntry =
  | { id: string; status: 'found'; row: InboxWindowRow }
  | { id: string; status: 'absent' }
  | { id: string; status: 'unknown' }
export type InboxLookupResult = {
  state: InboxWindowState
  /** One explicit result per requested ID; unknown is neither deleted nor out-of-scope. */
  entries: InboxLookupEntry[]
}

/** The resident and pinned sets together stay within the window/byte budget.
 * Keep only a bounded set of selected projections pinned; larger selections live as
 * captured server references, never silently dropped or broadened on page eviction.
 * Auto-prefetch stops at 300 combined conversations; subsequent paging is demand-driven.
 */
export type InboxChangesInput = {
  queryId: string
  sinceRevision: number
  residentKeys: string[]
  pinnedKeys: string[]
  cursor?: string
  limit?: number
}
export type InboxWindowChanges = {
  state: InboxWindowState
  /** Upserts + newHead contain at most 100 rows in total and obey the response byte cap. */
  upserts: InboxWindowRow[]
  newHead: InboxWindowRow[]
  removed: Array<{ key: string; reason: 'deleted' | 'unselected' | 'not-matching' }>
  totals: InboxTotals
  nextCursor: string | null
  /** Advance sinceRevision only after all bounded resident-change pages are applied. */
  throughRevision: number
  /** Refetch the active window, never drain a full-corpus delta into the browser. */
  resetReason: 'query' | 'scope' | 'source' | 'history' | null
}

/** Body-free detail paging for giant conversations; bodies keep their existing SDK API.
 * Cursors bind to the captured thread/scope/context. A stale context must be explicit,
 * never silently combined with another generation. Keep detail residency byte-bounded.
 */
export type InboxMessagesInput = { account: string; id: string; cursor?: string; limit?: number }
export type InboxMessagesPage = {
  state: InboxWindowState
  key: string
  contextVersion: string
  summaries: MailboxMessageSummary[]
  messages: Message[]
  total: number | null
  nextCursor: string | null
  exhausted: boolean
}

/** Same local evidence as senderActivity: deduplicate source/message and receiving
 * memberships; exclude drafts, queued sends, Spam and Trash. Opens/Done add no level.
 * Domain information/logo policy remains on the existing sender-domains endpoint.
 */
export type InboxSenderInput = {
  account: string
  id: string
  selectedMessageId?: string
  /** Null selects the contact address; host validates root-domain grouping. */
  domain?: string | null
}
export type InboxSenderActivity = {
  received: number
  sent: number
  conversations: number
  twoWay: number
  level: 0 | 1 | 2 | 3 | 4 | 5
  /** Exactly the existing trailing 12 weeks. */
  weeks: SenderWeek[]
  firstMessage: number | null
  lastMessage: number | null
  lastSent: number | null
}
export type InboxSenderResult = {
  state: InboxWindowState
  status: 'ready' | 'unknown' | 'absent'
  contact: SenderContact | null
  /** Null while incomplete, never a fabricated level 0 or empty-history aggregate. */
  activity: InboxSenderActivity | null
  /** At most five recent scoped conversations; never return the whole sender history. */
  recent: InboxWindowRow[]
}

export type InboxContactsInput = { account: string; query: string; limit?: number }
export type InboxContactsResult = { state: InboxWindowState; contacts: SenderContact[]; complete: boolean }

/** Selection freezes identities and review versions, not the live matching query.
 * Resolve compact action plans in bounded pages; existing mail-command limits remain.
 */
export type InboxSelectionInput = { id: string; account: string } & (
  | { queryId: string; allMatching: true; ids?: never }
  | { ids: string[]; queryId?: never; allMatching?: false }
)
export type InboxSelection = { id: string; account: string; scopeKey: string; revision: number; count: number | null; captureComplete: boolean }
export type InboxSelectionPageInput = { selectionId: string; cursor?: string; limit?: number }
export type InboxSelectionPage = {
  selection: InboxSelection
  entries: Array<{ id: string; status: 'found'; row: InboxWindowRow } | { id: string; status: 'changed' | 'absent' | 'unknown' }>
  nextCursor: string | null
  exhausted: boolean
}

/** The only Zero object persisted in the browser. Frozen receiving scope/source
 * generations and captured IDs live on the server, with no 100k capture ceiling.
 * Saved-scope changes invalidate rather than silently widening an existing session.
 */
export type InboxZeroSession = {
  version: 2
  id: string
  account: string
  scopeKey: string
  revision: number
  startedAt: number
  phase: 'batches' | 'review'
  paused: boolean
  currentId: string | null
  status: 'capturing' | 'ready' | 'complete' | 'invalidated'
  progress: {
    initialCount: number | null
    remainingCount: number | null
    decidedCount: number
    ineligibleCount: number
    unknownCount: number | null
    captureComplete: boolean
  }
}
export type InboxZeroCreateInput = { id: string; account: string }
export type InboxZeroResumeInput = { sessionId: string; account: string }
export type InboxZeroResumeResult =
  | { status: 'found'; session: InboxZeroSession }
  | { status: 'unknown' | 'absent' }
export type InboxZeroPageInput = { sessionId: string; cursor?: string; limit?: number }
export type InboxZeroItem = {
  id: string
  eligibility: 'eligible' | 'ineligible' | 'unknown'
  reviewVersion: string | null
  batchEligibility: 'eligible' | 'ineligible' | 'unknown'
  /** Existing safety/provenance checks and 500-membership limit still apply. */
  batchCandidate: ZeroBatchCandidate | null
}
export type InboxZeroPage = {
  session: InboxZeroSession
  items: InboxZeroItem[]
  nextCursor: string | null
  /** Not true while capture or eligibility is unknown. Unloaded rows remain queued. */
  exhausted: boolean
}

/** References to accepted existing APIs only; these are NOT new mail commands.
 * Single-membership state receipts cover the existing Later/reminder API.
 * The host verifies persisted receipts/revisions and captured coverage before credit.
 */
export type InboxActionReceiptReference =
  | { kind: 'mailbox-state' | 'attention-feedback' | 'category' | 'operation'; id: string }
  | { kind: 'mailbox-membership'; target: MailboxStateTarget }
export type InboxZeroDecisionInput = {
  id: string
  decision: ZeroDecision
  reviewVersion: string
  receipts: InboxActionReceiptReference[]
}
export type InboxZeroProgressInput = {
  sessionId: string
  /** Idempotency key for this progress update, not a mail-action command ID. */
  id: string
  ifRevision: number
  /** At most 100 decisions; merely opening/advancing/pausing never counts as a decision. */
  decisions: InboxZeroDecisionInput[]
  /** Explicit batch exclusions remain reserved for individual review across reloads. */
  reviewOnlyIds?: string[]
  currentId?: string | null
  phase?: 'batches' | 'review'
  paused?: boolean
}
export type InboxZeroUndoReference = { sessionId: string; progressId: string }
export type InboxZeroProgressResult = {
  session: InboxZeroSession
  results: Array<{ id: string; status: 'accepted' | 'pending' | 'rejected' }>
  /** References only decisions actually credited; pending acknowledgement is not failure. */
  undo: InboxZeroUndoReference | null
}
export type InboxZeroUndoInput = {
  id: string
  reference: InboxZeroUndoReference
  /** Existing action Undo runs first; host verifies its accepted inverse receipts/state.
   * This endpoint restores progress only, never performs an independent mail mutation.
   */
  receipts: InboxActionReceiptReference[]
}
export type InboxZeroUndoResult = { session: InboxZeroSession; status: 'accepted' | 'pending' | 'rejected' }

/** Named application operations; implementation uses the paths above, not SDK RPC aliases. */
export type InboxWindowTransport = {
  query(input: InboxQueryInput): Promise<InboxWindowPage>
  page(input: InboxPageInput): Promise<InboxWindowPage>
  counts(input: InboxCountsInput): Promise<InboxCountsResult>
  lookup(input: InboxLookupInput): Promise<InboxLookupResult>
  changes(input: InboxChangesInput): Promise<InboxWindowChanges>
  messages(input: InboxMessagesInput): Promise<InboxMessagesPage>
  sender(input: InboxSenderInput): Promise<InboxSenderResult>
  contacts(input: InboxContactsInput): Promise<InboxContactsResult>
  selectionCreate(input: InboxSelectionInput): Promise<InboxSelection>
  selectionPage(input: InboxSelectionPageInput): Promise<InboxSelectionPage>
  zeroCreate(input: InboxZeroCreateInput): Promise<InboxZeroSession>
  zeroResume(input: InboxZeroResumeInput): Promise<InboxZeroResumeResult>
  zeroPage(input: InboxZeroPageInput): Promise<InboxZeroPage>
  zeroProgress(input: InboxZeroProgressInput): Promise<InboxZeroProgressResult>
  zeroUndo(input: InboxZeroUndoInput): Promise<InboxZeroUndoResult>
}

/** HTTP errors must not be turned into empty successful pages. Retry/reopen only the
 * indicated bounded query; stale context never triggers an implicit full inventory.
 */
export type InboxWindowErrorCode = 'HOST_INBOX_INVALID' | 'HOST_INBOX_TOO_LARGE'
  | 'HOST_INBOX_QUERY_EXPIRED' | 'HOST_INBOX_CURSOR_INVALID' | 'HOST_INBOX_SCOPE_CHANGED'
  | 'HOST_INBOX_CONTEXT_CHANGED' | 'HOST_INBOX_UNAVAILABLE' | 'HOST_ZERO_SESSION_CONFLICT'
  | 'HOST_ZERO_SESSION_NOT_FOUND'
