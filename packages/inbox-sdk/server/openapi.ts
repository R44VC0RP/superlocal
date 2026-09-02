import { z } from 'zod'
import type {
  Attachment, MailAccount, MailboxProviderDescriptor, MailFolder, MailMessage,
  MailPriority, MailThread, Participant, PersonalizationStatus, ProviderCapabilities,
  ProviderType, SendResult, SendStatus, ThreadListResponse, UserSettings,
} from '../src/types'

const provider = z.enum(['mock', 'gmail', 'outlook', 'imap', 'inbound']) satisfies z.ZodType<ProviderType>
const folder = z.enum(['inbox', 'starred', 'sent', 'drafts', 'archive', 'trash', 'spam', 'snoozed', 'scheduled']) satisfies z.ZodType<MailFolder>
const destination = z.enum(['inbox', 'archive', 'trash', 'spam', 'snoozed'])
const category = z.enum(['important', 'other'])
const mode = z.enum(['off', 'suggest', 'adaptive'])
const section = z.enum(['automatic', 'starred', 'needs-action', 'off'])
const count = z.number().int().nonnegative()
const nullableDate = z.string().nullable().describe('Stored timestamp, or null when unset.')
const capabilities = z.object({
  sync: z.boolean(), incrementalSync: z.boolean(), deltaSync: z.boolean(),
  send: z.boolean(), reply: z.boolean(), threads: z.boolean(), nativeThreads: z.boolean(),
  folders: z.boolean(), createFolders: z.boolean(), labels: z.boolean(), archive: z.boolean(),
  trash: z.boolean(), permanentDelete: z.boolean(), markRead: z.boolean(), markUnread: z.boolean(),
  star: z.boolean(), attachments: z.boolean(), attachmentDownload: z.boolean(), search: z.boolean(),
  drafts: z.boolean(), scheduledSend: z.boolean(), snooze: z.boolean(), readReceipts: z.boolean(),
  pushNotifications: z.boolean(),
}).describe('Negotiated native adapter capabilities for this account, not a list of HTTP endpoints. False native drafts, snooze, scheduledSend, or other flags do not prohibit application-local features. Needs action is local. Synchronization is pull-only; no push ingestion is exposed.') satisfies z.ZodType<ProviderCapabilities>

const participant = z.object({
  name: z.string(), email: z.string(), avatar: z.string().nullable().optional(),
}) satisfies z.ZodType<Participant>
const attachment = z.object({
  id: z.string(), filename: z.string(), contentType: z.string(), size: count, url: z.string(),
  inline: z.boolean().optional(), contentId: z.string().optional(),
}) satisfies z.ZodType<Attachment>
const account = z.object({
  id: z.string(), userId: z.string().optional(), name: z.string(), email: z.string(), provider,
  color: z.string(), syncStatus: z.enum(['idle', 'syncing', 'error', 'connected']),
  lastSyncAt: nullableDate.optional(), unreadCount: count, signature: z.string().optional(),
  avatar: z.string().nullable().optional(),
  capabilities: capabilities.nullable().optional().describe('Null when the provider instance is unavailable or unconfigured. Discover support per account, never from provider identity alone.'),
}) satisfies z.ZodType<MailAccount>
const priority = z.object({
  score: z.number().min(0).max(100), level: z.enum(['priority', 'important', 'other']),
  source: z.enum(['provider', 'manual', 'learned', 'protected']), reason: z.string(),
  sampleCount: count, providerImportant: z.boolean(), suggestedCategory: z.enum(['important', 'other', 'spam']).optional(),
}) satisfies z.ZodType<MailPriority>
const message = z.object({
  id: z.string(), threadId: z.string(), accountId: z.string(), from: participant,
  to: z.array(participant), cc: z.array(participant), bcc: z.array(participant),
  subject: z.string(), preview: z.string(), bodyText: z.string(),
  bodyHtml: z.string().describe('Server-sanitized email HTML; remote images and tracking follow owner settings.'),
  bodyStyles: z.string().optional(), receivedAt: z.string(), isRead: z.boolean(), isStarred: z.boolean(),
  isImportant: z.boolean().optional().describe('Provider importance, not the effective conversation category.'),
  folder, labels: z.array(z.string()), attachments: z.array(attachment),
  snoozedUntil: nullableDate.optional(), scheduledAt: nullableDate.optional(), readReceipt: z.boolean().optional(),
}) satisfies z.ZodType<MailMessage>
const thread = z.object({
  id: z.string(), accountId: z.string(), subject: z.string(), preview: z.string(),
  participants: z.array(participant), messages: z.array(message), messageCount: count, lastMessageAt: z.string(),
  isRead: z.boolean(), isStarred: z.boolean(),
  isImportant: z.boolean().optional().describe('Effective priority or Needs action. Inbox category membership additionally includes starred conversations even with an Other override; do not reconstruct list membership from this field alone.'),
  priorityOverride: category.nullable().optional(), needsAction: z.boolean().optional(),
  priority: priority.optional().describe('May be omitted when personalization is off, no manual override is set, and Needs action is false.'),
  isQuarantined: z.boolean().optional().describe('Local private quarantine overlay; absent means false.'),
  folder, labels: z.array(z.string()), hasAttachments: z.boolean(),
  snoozedUntil: nullableDate.optional(), scheduledAt: nullableDate.optional(),
}) satisfies z.ZodType<MailThread>
const settings = z.object({
  readingMode: z.enum(['fullscreen', 'sheet', 'sidebar']), remoteImages: z.boolean(), readReceipts: z.boolean(),
  keyboardShortcuts: z.boolean(), density: z.enum(['comfortable', 'compact']), signature: z.string(),
  undoSendSeconds: z.number().int().min(0).max(120), theme: z.enum(['light', 'dark', 'system']),
  fontFamily: z.enum(['circular', 'system', 'rounded', 'serif', 'mono']), notifications: z.boolean(),
  autoAdvance: z.boolean(), showAvatars: z.boolean(), personalizationMode: mode.optional(), prioritySection: section.optional(),
}) satisfies z.ZodType<UserSettings>
const personalization = z.object({
  mode, feedbackCount: count, readingCount: count, learnedAccounts: count, suggestionCount: count,
}) satisfies z.ZodType<PersonalizationStatus>
const descriptor = z.object({
  id: provider, name: z.string(), connection: z.enum(['oauth', 'credentials']),
  authProvider: z.string().optional(), scopes: z.array(z.string()).optional(),
}) satisfies z.ZodType<MailboxProviderDescriptor>
const threadList = z.object({
  threads: z.array(thread), nextCursor: z.string().nullable().describe('Opaque application cursor; null ends pagination. Not a provider cursor.'),
  counts: z.partialRecord(folder, count).describe('Account-scoped folder counts, independent of search, label and category. Quarantined conversations are excluded.'),
  categoryCounts: z.object({ important: count, other: count, quarantine: count.optional() }).optional()
    .describe('Present for inbox queries, across matching conversations before pagination and category selection. Zero quarantine may be omitted.'),
  priorityCount: count.optional().describe('Present only for a non-off prioritySection; count across the entire matching Important inbox.'),
  total: count.describe('Matching conversations before pagination; excludes quarantine unless explicitly selected.'),
}) satisfies z.ZodType<ThreadListResponse>

const changes = z.looseObject({
  messageIds: z.array(z.string().min(1)).min(1).max(5000).optional().describe('Exact delivery selection; required with inboxId. New arrivals and out-of-scope messages are not selected.'),
  isRead: z.boolean().optional(), isStarred: z.boolean().optional(), folder: destination.optional(),
  snoozedUntil: nullableDate.optional().describe('A Date.parse-compatible string or null. Setting the date alone does not change folder; use folder: snoozed as needed.'),
  labels: z.array(z.string()).optional().describe('Replaces labels; duplicates are removed.'),
  priorityOverride: category.nullable().optional().describe('Private manual override; null restores automatic classification. Does not rewrite provider importance.'),
  needsAction: z.boolean().optional().describe('Private action flag; false means Done. Does not archive, mark read, train, or enqueue a provider mutation.'),
  isQuarantined: z.boolean().optional().describe('Private overlay; does not delete mail. Quarantining spam/trash restores it to archive.'),
  clearIrrelevant: z.boolean().optional().describe('True removes private irrelevant feedback. False alone is not a supported change.'),
}).describe('At least one supported change is required; unknown properties are ignored. Local changes and supported provider jobs commit atomically. Pseudo-folder destinations sent, drafts, starred, and scheduled are not supported moves.')
const ids = z.array(z.string().min(1)).min(1).max(500)
const bulk = z.looseObject({
  messageIds: z.array(z.string().min(1)).min(1).max(5000).optional(),
  ids: ids.optional(), threadIds: ids.optional(), changes: changes.optional(),
  action: z.enum(['read', 'markRead', 'mark_read', 'unread', 'markUnread', 'mark_unread',
    'star', 'starred', 'unstar', 'archive', 'trash', 'spam', 'inbox', 'delete', 'move', 'folder',
    'snooze', 'unsnooze', 'label', 'labels']).optional(),
  value: z.union([z.boolean(), z.string(), z.array(z.string())]).optional(),
}).describe('Provide ids (or threadIds alias), plus changes or action. ids takes precedence and duplicates are removed after the 500-input limit. An object-valued changes takes precedence over action. All IDs must be owned or nothing changes. read/star aliases accept boolean value (default true); unread/unstar ignore value. delete means trash, not permanent deletion. move/folder require a supported destination; snooze requires a parseable date and also sets folder snoozed; unsnooze clears the date and restores inbox; label/labels replace labels using a string or string array.')

const sendProblem = z.object({
  error: z.string(), code: z.string(), status: z.number().int().min(400).max(599),
  stage: z.enum(['validation', 'configuration', 'dispatch', 'recovery']), diagnosticId: z.string(),
  retryable: z.boolean().describe('Whether automatic queue retry may still occur, not permission to submit another send.'),
  action: z.string().describe('Machine-readable next step: fix_request, fix_attachment, reduce_attachments, select_account, select_thread, fix_schedule, check_status, check_request_id, reconnect_account, review_permissions, refresh_mailbox, wait_for_retry, check_configuration, or compose_new_message.'),
  field: z.string().optional().describe('Safe JSON pointer; never contains the rejected value.'),
  retryAfterSeconds: count.optional(),
  type: z.string().optional(), title: z.string().optional(), detail: z.string().optional(), instance: z.string().optional(),
})
const sendState = z.enum(['pending', 'processing', 'completed', 'failed', 'cancelled'])
const sendRecipients = z.union([z.string(), z.array(z.object({ email: z.string(), name: z.string().optional() }))])
const sendRequest = z.object({
  inboxId: z.string().min(1).optional().describe('Owned saved inbox whose validated default sending identity is used.'),
  accountId: z.string().min(1), to: sendRecipients, cc: sendRecipients.optional(), bcc: sendRecipients.optional(),
  subject: z.string().optional(), body: z.string().optional(), threadId: z.string().optional(),
  mode: z.enum(['compose', 'reply', 'replyAll', 'forward']).optional(), scheduledAt: z.string().optional(),
  idempotencyKey: z.string().min(1).max(255).optional(),
  attachments: z.array(z.object({
    filename: z.string().min(1), contentType: z.string().optional(),
    contentBase64: z.string().describe('Required standard base64 bytes, padded or unpadded. Empty string is a zero-byte file. Metadata or a URL alone is not accepted.'),
    inline: z.boolean().optional(), contentId: z.string().optional(),
  })).max(20).optional().describe('At most 20 files, 25 MiB decoded total. Application JSON size limits may be lower; use multipart for larger files.'),
})

// These schemas describe and test the contract; route validation remains in routes.ts.
const inboxScope = z.object({ kind: z.enum(['domain', 'address']), value: z.string().min(1) })
const inboxInput = z.object({ accountId: z.string().min(1), name: z.string().min(1).max(100),
  scopes: z.array(inboxScope).min(1).max(100), defaultSender: z.string().nullable().optional() })
const savedInbox = inboxInput.extend({ id: z.string(), defaultSender: z.string().nullable() })
export const coreSchemas = {
  InboxInput: inboxInput, SavedInbox: savedInbox, InboxViews: z.array(savedInbox),
  ConnectionSources: z.object({ sources: z.array(inboxScope.extend({ canReceive: z.boolean(), canSend: z.boolean(),
    canFilter: z.boolean().optional(), unavailableReason: z.string().optional() })),
    identities: z.array(z.object({ email: z.string(), name: z.string().optional() })) }),
  Error: z.object({ error: z.string() }), ProviderCapabilities: capabilities,
  MailboxProviderDescriptor: descriptor, Providers: z.object({ providers: z.array(descriptor) }),
  MailAccount: account, Accounts: z.array(account),
  AccountCapabilities: z.object({ provider, capabilities }),
  SyncRequest: z.looseObject({
    folder: folder.optional().describe('Defaults to inbox.'),
    limit: z.number().optional().describe('Defaults to 50; clamped to 1-100. Non-number inputs use the default.'),
    reset: z.boolean().optional().describe('Only true resets the application-managed synchronization state.'),
  }),
  SyncResult: z.object({ accountId: z.string(), synchronized: count, deleted: count, hasMore: z.boolean(), fullSync: z.boolean() }),
  Participant: participant, Attachment: attachment, MailMessage: message, MailPriority: priority,
  MailThread: thread, ThreadListResponse: threadList, ThreadChanges: changes, BulkRequest: bulk,
  BulkResult: z.object({ updated: count, ids: z.array(z.string()) }),
  AttentionRequest: z.strictObject({ activeMilliseconds: z.number().int().min(0).max(120_000) }),
  PersonalizationStatus: personalization, ResetRequest: z.looseObject({ confirm: z.literal(true) }),
  UserSettings: settings, SettingsUpdate: settings.partial().strict(),
  SendProblem: sendProblem, SendRequest: sendRequest,
  SendMultipartRequest: sendRequest.omit({ attachments: true, to: true, cc: true, bcc: true }).extend({
    to: z.string(), cc: z.string().optional(), bcc: z.string().optional(), attachments: z.array(z.string()).max(20).optional(),
  }),
  SendResult: thread.extend({ thread, message, scheduled: z.boolean(),
    delivery: z.object({ jobId: z.string(), status: sendState, statusUrl: z.string() }),
  }) satisfies z.ZodType<SendResult>,
  SendStatus: z.object({
    messageId: z.string(), jobId: z.string(), status: sendState, attempts: count, nextAttemptAt: nullableDate,
    problem: sendProblem.nullable(),
  }) satisfies z.ZodType<SendStatus>,
  SendUndo: z.object({ canceled: z.boolean(), thread: thread.nullable() }),
}

type SchemaName = keyof typeof coreSchemas
const schemas = Object.fromEntries(Object.entries(coreSchemas).map(([name, schema]) => {
  const { $schema: _dialect, ...json } = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' })
  return [name, json]
}))
Object.assign(schemas.SendMultipartRequest.properties!.attachments, { items: { type: 'string', format: 'binary' } })
schemas.ThreadChanges.anyOf = [
  ...['isRead', 'isStarred', 'folder', 'snoozedUntil', 'labels', 'priorityOverride', 'needsAction', 'isQuarantined']
    .map((key) => ({ required: [key] })),
  { required: ['clearIrrelevant'], properties: { clearIrrelevant: { const: true } } },
]
schemas.BulkRequest.allOf = [
  { anyOf: [{ required: ['ids'] }, { required: ['threadIds'] }] },
  {
    if: { required: ['changes'] },
    then: { properties: { changes: { $ref: '#/components/schemas/ThreadChanges' } } },
    else: {
      required: ['action'],
      anyOf: [
        { properties: { action: { enum: ['read', 'markRead', 'mark_read', 'unread', 'markUnread', 'mark_unread', 'star', 'starred', 'unstar', 'archive', 'trash', 'spam', 'inbox', 'delete', 'unsnooze'] } } },
        { required: ['value'], properties: { action: { enum: ['move', 'folder'] }, value: { enum: destination.options } } },
        { required: ['value'], properties: { action: { const: 'snooze' }, value: { type: 'string', description: 'Date.parse-compatible date.' } } },
        { required: ['value'], properties: { action: { enum: ['label', 'labels'] }, value: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] } } },
      ],
    },
  },
]

function jsonResponse(name: SchemaName, description: string) {
  return { description, content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } } }
}
function requestBody(name: SchemaName, required = true) {
  return { required, content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } } }
}
const errors = {
  '400': jsonResponse('Error', 'Invalid request, cursor, settings, or provider configuration.'),
  '401': jsonResponse('Error', 'Missing/invalid session, or provider authentication requires reconnection where applicable.'),
  '403': jsonResponse('Error', 'Untrusted mutation Origin or provider authorization denied.'),
  '404': jsonResponse('Error', 'Resource missing or not owned by the authenticated user.'),
  '409': jsonResponse('Error', 'Requested provider mutation is unsupported or conflicts.'),
  '413': jsonResponse('Error', 'Request body exceeds the configured limit (JSON defaults to 2 MiB).'),
  '429': { ...jsonResponse('Error', 'Configured mutation rate budget or upstream provider rate limit exceeded.'), headers: {
    'Retry-After': { description: 'Seconds to wait; emitted by the application rate limiter, not guaranteed for provider errors.', schema: { type: 'integer', minimum: 1 } },
  } },
  '500': jsonResponse('Error', 'Internal server error.'),
  '502': jsonResponse('Error', 'Provider request or synchronization failed.'),
}
const readErrors = { '401': errors[401], '500': errors[500] }
const mutationErrors = { ...readErrors, '400': errors[400], '403': errors[403], '413': errors[413], '429': errors[429] }
const providerMutationErrors = { ...mutationErrors, '404': errors[404], '409': errors[409], '502': errors[502] }
const idParameter = { name: 'id', in: 'path', required: true, description: 'Opaque normalized resource ID from this owner\'s responses. URL-encode when inserting into the path.', schema: { type: 'string' } }
const inboxParameter = { name: 'inboxId', in: 'query', schema: { type: 'string' }, description: 'Owned saved inbox. Scopes messages, thread summaries, counts and mutation selections. Unknown or foreign views return 404.' }
const originParameter = { name: 'Origin', in: 'header', required: true, description: 'Trusted application origin for cookie-authenticated mutations. Browser clients supply this automatically; non-browser cookie clients must send it. No bearer/API-token authentication is provided.', schema: { type: 'string', format: 'uri' } }
const acknowledgement = 'Returns the locally committed optimistic state. Supported upstream mutations are queued for asynchronous execution and retry; this is not confirmation of provider completion or delivery.'
const sendErrors = Object.fromEntries(Object.entries({ ...providerMutationErrors, '500': errors[500] }).map(([status, response]) => [status, {
  ...response,
  headers: { ...(status === '429' ? errors[429].headers : {}), 'X-Request-ID': { description: 'Server-generated diagnostic ID for send-handler errors; not guaranteed for earlier authentication/security rejections.', schema: { type: 'string' } } },
  content: { ...response.content, 'application/problem+json': { schema: { $ref: '#/components/schemas/SendProblem' } } },
}]))

export const openApiDocument = {
  openapi: '3.1.0',
  jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
  info: {
    title: 'Inbox SDK Mailbox API', version: '0.1.0',
    description: 'Bounded owner-scoped mailbox contract, not a complete inventory of the server. Covers provider discovery, connected accounts/capabilities, pull sync, conversations, private feedback, settings, and queued sending/status/cancellation. Authentication/onboarding, account creation/deletion, custom folders, attachment downloads, drafts, brands, and operational endpoints are not documented here. Use an existing Better Auth cookie session; all resources are scoped to its user. Account filters never expand ownership. IDs and pagination cursors are opaque normalized application values. Cookie mutations must send a trusted Origin; deployment hardening may reject absent Origin, cross-site requests, oversized bodies, or rate excess. Native capabilities describe adapter support, not application-local feature availability.',
  },
  servers: [{ url: '/api' }],
  security: [{ sessionCookie: [] }, { secureSessionCookie: [] }],
  components: {
    securitySchemes: {
      sessionCookie: { type: 'apiKey', in: 'cookie', name: 'better-auth.session_token', description: 'Better Auth session on HTTP development deployments.' },
      secureSessionCookie: { type: 'apiKey', in: 'cookie', name: '__Secure-better-auth.session_token', description: 'Better Auth session in production or when the configured base URL uses HTTPS. Alternative to the development cookie, not an additional requirement.' },
    },
    schemas,
  },
  paths: {
    '/inboxes': {
      get: { operationId: 'listInboxViews', summary: 'List saved inbox views', responses: { '200': jsonResponse('InboxViews', 'Owned views, not copies of messages.'), ...readErrors } },
      post: { operationId: 'createInboxView', summary: 'Create a union of discovered domain/address scopes', parameters: [originParameter],
        requestBody: requestBody('InboxInput'), responses: { '201': jsonResponse('SavedInbox', 'Saved view. Source backfill continues asynchronously.'), ...providerMutationErrors } },
    },
    '/inboxes/{id}': { delete: { operationId: 'deleteInboxView', summary: 'Delete a view without deleting mail', parameters: [idParameter, originParameter],
      responses: { '204': { description: 'View deleted; canonical messages retained.' }, ...providerMutationErrors } } },
    '/accounts/{id}/sources': { get: { operationId: 'discoverMailSources', summary: 'Discover normalized mail sources and sending identities', parameters: [idParameter],
      responses: { '200': jsonResponse('ConnectionSources', 'Capabilities reported independently for receiving, filtering and sending.'), ...readErrors, '404': errors[404], '502': errors[502] } } },
    '/send': { post: {
      operationId: 'sendMail', summary: 'Queue an owned outbound message', parameters: [originParameter,
        { name: 'Idempotency-Key', in: 'header', schema: { type: 'string', minLength: 1, maxLength: 255 }, description: 'Owner-scoped key, preferred over body idempotencyKey. Reuse only for retrying the same logical send; an existing same-account send is returned rather than dispatched again. Never blindly resubmit with a new key after an uncertain response.' }],
      description: '201 acknowledges a local queued send, not delivery. mode defaults to compose; reply/replyAll require an owned threadId. Explicit recipient lists are authoritative. Providers that cannot preserve reply CC/BCC fail with REPLY_RECIPIENTS_UNSUPPORTED instead of dropping recipients or expanding the list. Attachments require bytes: multipart file parts or JSON base64, never metadata-only references. supplied file IDs, URLs and sizes are not trusted. scheduledAt delays queue execution. Poll delivery.statusUrl using the same owner session. Send-handler errors use RFC 9457 Problem Details with an error string retained for existing clients; earlier authentication/security errors may use ordinary JSON.',
      requestBody: { required: true, content: {
        'application/json': { schema: { $ref: '#/components/schemas/SendRequest' } },
        'multipart/form-data': { schema: { $ref: '#/components/schemas/SendMultipartRequest' } },
      } },
      responses: { '201': jsonResponse('SendResult', 'New send queued.'), '200': jsonResponse('SendResult', 'Existing send returned for the idempotency key.'), ...sendErrors },
    } },
    '/send/{id}/status': { get: {
      operationId: 'getSendStatus', summary: 'Inspect owner-scoped send progress and safe diagnostics', parameters: [idParameter],
      description: 'id is the normalized message.id from sendMail, not a native provider ID or job ID. completed means the provider accepted the operation (or mock completed), not recipient delivery. pending/processing may still run; failed has exhausted retries or a nonretryable error; cancelled is an undone scheduled send. problem contains only allowlisted diagnostics, never raw upstream errors or mail content. diagnosticId identifies the job for server log correlation. If acceptance is uncertain, inspect status/provider state before resubmitting; exactly-once external sending is not guaranteed.',
      responses: { '200': jsonResponse('SendStatus', 'Current state; no-store.'), '401': errors[401], '404': sendErrors[404], '500': sendErrors[500] },
    } },
    '/send/{id}/undo': { post: {
      operationId: 'cancelScheduledSend', summary: 'Cancel a pending send before its scheduled execution', parameters: [idParameter, originParameter],
      description: 'id is normalized message.id. The pending send becomes a draft; the job is cancelled. This does not recall mail already accepted by a provider. Available only while the future cancellation window remains open.',
      responses: { '200': jsonResponse('SendUndo', 'Pending send cancelled.'), ...providerMutationErrors },
    } },
    '/providers': { get: {
      operationId: 'listMailboxProviders', summary: 'Discover enabled mailbox connection descriptors',
      description: 'Deployment-filtered SDK descriptors; not the identity-authentication provider list.',
      responses: { '200': jsonResponse('Providers', 'Enabled mailbox providers.'), ...readErrors },
    } },
    '/accounts': { get: {
      operationId: 'listMailAccounts', summary: 'List connected accounts owned by the session user',
      description: 'Unread count counts unread inbox messages, excluding private quarantine. Capabilities are negotiated separately per account and may be null when unavailable.',
      responses: { '200': jsonResponse('Accounts', 'Owned accounts, newest-created first then name.'), ...readErrors },
    } },
    '/accounts/{id}/capabilities': { get: {
      operationId: 'getAccountCapabilities', summary: 'Get negotiated native account capabilities', parameters: [idParameter],
      description: 'Unlike the nullable capabilities on account listings, unavailable configuration here returns an error, not a successful null capability object.',
      responses: { '200': jsonResponse('AccountCapabilities', 'Current native capabilities.'), ...readErrors, '400': errors[400], '404': errors[404] },
    } },
    '/accounts/{id}/sync': { post: {
      operationId: 'syncMailAccount', summary: 'Pull one bounded synchronization batch', parameters: [idParameter, originParameter],
      description: 'Waits for this batch to be persisted. hasMore indicates additional work, not a provider cursor. Omitted or malformed JSON uses inbox, limit 50, reset false. Polling and application-managed continuation remain below the SDK boundary.',
      requestBody: requestBody('SyncRequest', false),
      responses: { '200': jsonResponse('SyncResult', 'Persisted synchronization batch counts.'), ...mutationErrors, '404': errors[404], '502': errors[502] },
    } },
    '/threads': { get: {
      operationId: 'listThreads', summary: 'List owner-scoped conversations',
      description: 'Without accountId, combines owned accounts. Unknown or foreign account filters produce an empty list. Categories are inbox-only. Important includes Needs action, stars, score >=85, or effective Important classification. Overrides precede learned categories (adaptive only), then provider importance. Quarantine is excluded unless requested. prioritySection groups the whole Important inbox before sorting: automatic uses Needs action, stars or score >=85; starred uses stars; needs-action uses only the local flag. This query defaults to off independently of the saved UI setting. A non-off section requires inbox + important and forbids even empty search/label parameters. Reuse cursors only with unchanged filters, sort and section; never decode native state.',
      parameters: [
        inboxParameter,
        { name: 'accountId', in: 'query', schema: { type: 'string' }, description: 'Optional owned account filter; whitespace is trimmed.' },
        { name: 'folder', in: 'query', schema: { type: 'string', enum: folder.options, default: 'inbox' } },
        { name: 'category', in: 'query', schema: { type: 'string', enum: ['important', 'other', 'quarantine'] }, description: 'Only valid with inbox; omitted returns Important and Other, not quarantine.' },
        { name: 'search', in: 'query', schema: { type: 'string' }, description: 'Application-normalized mail search; trimmed.' },
        { name: 'label', in: 'query', schema: { type: 'string' }, description: 'Normalized label filter; trimmed.' },
        { name: 'sort', in: 'query', schema: { type: 'string', enum: ['newest', 'oldest', 'priority'], default: 'newest' }, description: 'Priority sorts score descending, then newest. Date ties are resolved by normalized thread/account IDs.' },
        { name: 'prioritySection', in: 'query', schema: { type: 'string', enum: section.options, default: 'off' }, description: 'Must occur once; non-off groups ahead of the selected sort.' },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 30 }, description: 'Effective page size: finite numeric inputs are truncated and clamped to 1-100; nonfinite inputs fall back to 30.' },
        { name: 'cursor', in: 'query', schema: { type: 'string' }, description: 'Opaque nextCursor from a previous page; invalid/mismatched cursors return 400.' },
      ],
      responses: { '200': jsonResponse('ThreadListResponse', 'Page including complete normalized conversations, scoped counts and nullable continuation.'), ...readErrors, '400': errors[400] },
    } },
    '/threads/{id}': {
      get: { operationId: 'getThread', summary: 'Read a normalized owned conversation', parameters: [idParameter, inboxParameter],
        description: 'Does not mark the conversation read. Contains sanitized message presentation and owner-local overlays.',
        responses: { '200': jsonResponse('MailThread', 'Owned conversation.'), ...readErrors, '404': errors[404] } },
      patch: { operationId: 'updateThread', summary: 'Apply supported conversation changes', parameters: [idParameter, originParameter, inboxParameter],
        description: acknowledgement, requestBody: requestBody('ThreadChanges'),
        responses: { '200': jsonResponse('MailThread', 'Locally updated conversation; provider work may remain pending.'), ...providerMutationErrors } },
    },
    '/threads/bulk': { post: {
      operationId: 'bulkUpdateThreads', summary: 'Atomically update up to 500 input thread IDs', parameters: [originParameter, inboxParameter],
      description: acknowledgement + ' All requested IDs must exist for this owner. updated counts deduplicated thread IDs, not messages or upstream jobs.',
      requestBody: requestBody('BulkRequest'), responses: { '200': jsonResponse('BulkResult', 'Acknowledged local batch with deduplicated IDs.'), ...providerMutationErrors },
    } },
    '/threads/{id}/irrelevant': { post: {
      operationId: 'markThreadIrrelevant', summary: 'Privately label irrelevant mail and archive', parameters: [idParameter, originParameter],
      description: 'No body required. Stores owner-private normalized references and minimal sender/domain/subject/preview feedback; no external AI transmission. Undo using folder: inbox and clearIrrelevant: true. ' + acknowledgement,
      responses: { '200': jsonResponse('MailThread', 'Locally archived conversation.'), ...providerMutationErrors },
    } },
    '/threads/{id}/attention': { post: {
      operationId: 'recordThreadAttention', summary: 'Record bounded active reading time', parameters: [idParameter, originParameter],
      description: 'Less than 5000ms is accepted but not recorded. Learning collection is opt-in; quarantined and spam/trash-only conversations do not train. Does not change read state.',
      requestBody: requestBody('AttentionRequest'), responses: { '204': { description: 'Accepted, with no response body; not necessarily a recorded learning signal.' }, ...mutationErrors, '404': errors[404] },
    } },
    '/personalization': { get: {
      operationId: 'getPersonalization', summary: 'Get private learning status',
      responses: { '200': jsonResponse('PersonalizationStatus', 'Owner-scoped learning counters and mode.'), ...readErrors },
    } },
    '/personalization/reset': { post: {
      operationId: 'resetPersonalization', summary: 'Reset private learning and manual priority overrides', parameters: [originParameter],
      description: 'Requires explicit confirmation. Clears private priority feedback and computed priorities/overrides for this owner. Preserves mail, account data, settings, Needs action flags, quarantine, and separate irrelevant-message examples.',
      requestBody: requestBody('ResetRequest'), responses: { '200': jsonResponse('PersonalizationStatus', 'Learning status after reset.'), ...mutationErrors },
    } },
    '/settings': {
      get: { operationId: 'getSettings', summary: 'Get owner settings merged with defaults',
        description: 'Defaults: readingMode fullscreen, remoteImages/readReceipts/keyboardShortcuts true, density comfortable, empty signature, undoSendSeconds 10, theme light, fontFamily circular, notifications/autoAdvance/showAvatars true, personalizationMode off, prioritySection automatic. The thread-list prioritySection query still defaults to off.',
        responses: { '200': jsonResponse('UserSettings', 'Effective owner settings.'), ...readErrors } },
      put: { operationId: 'updateSettings', summary: 'Merge a partial owner settings update', parameters: [originParameter],
        description: 'PUT merges supplied keys rather than replacing the settings object. Empty object is allowed; unknown keys and invalid values return 400. No PATCH settings method is registered.',
        requestBody: requestBody('SettingsUpdate'), responses: { '200': jsonResponse('UserSettings', 'Complete merged settings.'), ...mutationErrors } },
    },
  },
}
