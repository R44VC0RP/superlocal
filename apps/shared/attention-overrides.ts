export type AttentionCategory = 'Important' | 'Other'
export type CategoryKey = { sourceId: string; threadId: string }
export type CategoryContext = CategoryKey & {
  sourceGeneration: number
  mailboxIds: string[]
  latestMessageId: string
  messages: Array<{
    messageId: string
    revision: number
    bodyRevision: string | null
    memberships: Array<{ mailboxId: string; revision: number }>
  }>
}
export type CategoryOverride = { category: AttentionCategory; context: CategoryContext }
export type CategoryEntry = CategoryKey & { revision: number; override: CategoryOverride | null }
export type CategoryCommand = { id: string; category: AttentionCategory; targets: Array<{ context: CategoryContext; ifRevision: number }> }
export type CategoryReceipt = { id: string; retracted: boolean; entries: CategoryEntry[] }
export type CategoryPage = { entries: CategoryEntry[]; cursor: number; hasMore: boolean; resetRequired: boolean }
export type CategoryTransport = {
  changes(after: number): Promise<CategoryPage>
  lookup(keys: CategoryKey[]): Promise<{ entries: CategoryEntry[] }>
  classify(input: CategoryCommand): Promise<CategoryReceipt>
  undo(id: string): Promise<CategoryReceipt>
}
export const CATEGORY_BATCH_LIMIT = 50
export const CATEGORY_MEMBERSHIP_LIMIT = 500
export const CATEGORY_BODY_LIMIT = 64 * 1024
export const CATEGORY_RESPONSE_LIMIT = 256 * 1024
export const categoryErrorMessages = {
  HOST_CATEGORY_INVALID: 'The category selection is invalid.',
  HOST_CATEGORY_TOO_LARGE: 'This selection is too large for one category change.',
  HOST_CATEGORY_NOT_FOUND: 'The selected conversation is no longer available.',
  HOST_CATEGORY_CONTEXT_CHANGED: 'The selected mail changed. Review it before choosing its category again.',
  HOST_CATEGORY_CONFLICT: 'A category changed elsewhere. Review it before choosing again.',
  HOST_CATEGORY_IDEMPOTENCY_CONFLICT: 'This category request already describes a different selection.',
  HOST_CATEGORY_UNDO_CONFLICT: 'A newer category change prevents this Undo.',
  HOST_CATEGORY_UNAVAILABLE: 'Category changes are temporarily unavailable.',
  HOST_CATEGORY_STORAGE_FULL: 'Saved category storage is full. Use Done or Later for now; existing category Undo remains available.',
  HOST_CATEGORY_ACK_PENDING: 'The category acknowledgement was interrupted. Retry checks the same request.',
} as const
export type CategoryErrorCode = keyof typeof categoryErrorMessages
export const categoryKey = (value: CategoryKey) => `${value.sourceId}\0${value.threadId}`
export const categoryId = (value: unknown): value is string => typeof value === 'string' && /^[^\s\x00-\x1f\x7f]{1,512}$/.test(value)
export const categoryCommandId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9-]{16,80}$/.test(value)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const fields = (value: Record<string, unknown>, names: string[]) => Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name))
const revision = (value: unknown, zero = false) => Number.isSafeInteger(value) && Number(value) >= (zero ? 0 : 1)
export function isCategoryKey(value: unknown): value is CategoryKey {
  return object(value) && fields(value, ['sourceId', 'threadId']) && categoryId(value.sourceId) && categoryId(value.threadId)
}
export function isCategoryContext(value: unknown): value is CategoryContext {
  if (!object(value) || !fields(value, ['sourceId', 'threadId', 'sourceGeneration', 'mailboxIds', 'latestMessageId', 'messages']) || !categoryId(value.sourceId) || !categoryId(value.threadId) || !revision(value.sourceGeneration) || !categoryId(value.latestMessageId)) return false
  if (!Array.isArray(value.mailboxIds) || !value.mailboxIds.length || value.mailboxIds.length > CATEGORY_MEMBERSHIP_LIMIT || !value.mailboxIds.every(categoryId) || new Set(value.mailboxIds).size !== value.mailboxIds.length) return false
  if (!Array.isArray(value.messages) || !value.messages.length || value.messages.length > CATEGORY_MEMBERSHIP_LIMIT) return false
  const boxes = new Set(value.mailboxIds), ids = new Set<string>()
  let memberships = 0
  for (const message of value.messages) {
    if (!object(message) || !fields(message, ['messageId', 'revision', 'bodyRevision', 'memberships']) || !categoryId(message.messageId) || ids.has(message.messageId) || !revision(message.revision) || !(message.bodyRevision === null || categoryId(message.bodyRevision))) return false
    ids.add(message.messageId)
    if (!Array.isArray(message.memberships) || !message.memberships.length || message.memberships.length > CATEGORY_MEMBERSHIP_LIMIT) return false
    const seen = new Set<string>()
    for (const state of message.memberships) {
      if (!object(state) || !fields(state, ['mailboxId', 'revision']) || !categoryId(state.mailboxId) || !boxes.has(state.mailboxId) || seen.has(state.mailboxId) || !revision(state.revision)) return false
      seen.add(state.mailboxId)
      if (++memberships > CATEGORY_MEMBERSHIP_LIMIT) return false
    }
  }
  return ids.has(value.latestMessageId)
}
export function isCategoryEntry(value: unknown): value is CategoryEntry {
  if (!object(value) || !fields(value, ['sourceId', 'threadId', 'revision', 'override']) || !categoryId(value.sourceId) || !categoryId(value.threadId) || !revision(value.revision, true)) return false
  if (value.override === null) return true
  const override = value.override
  return Number(value.revision) > 0 && object(override) && fields(override, ['category', 'context']) && (override.category === 'Important' || override.category === 'Other') && isCategoryContext(override.context) && override.context.sourceId === value.sourceId && override.context.threadId === value.threadId
}
export function isCategoryCommand(value: unknown): value is CategoryCommand {
  if (!object(value) || !fields(value, ['id', 'category', 'targets']) || !categoryCommandId(value.id) || (value.category !== 'Important' && value.category !== 'Other') || !Array.isArray(value.targets) || !value.targets.length || value.targets.length > CATEGORY_BATCH_LIMIT) return false
  let memberships = 0
  const keys = new Set<string>()
  for (const target of value.targets) {
    if (!object(target) || !fields(target, ['context', 'ifRevision']) || !revision(target.ifRevision, true) || !isCategoryContext(target.context)) return false
    const key = categoryKey(target.context)
    if (keys.has(key)) return false
    keys.add(key)
    memberships += target.context.messages.reduce((sum, message) => sum + message.memberships.length, 0)
  }
  return memberships <= CATEGORY_MEMBERSHIP_LIMIT
}
