import { ProviderError, UnsupportedOperationError, type ProviderErrorCode } from './sdk'

export interface MailFailure {
  code: string
  error: string
  status: number
  stage: 'validation' | 'configuration' | 'dispatch' | 'recovery'
  diagnosticId: string
  retryable: boolean
  action: string
  field?: string
  retryAfterSeconds?: number
}

type FailureDescription = Pick<MailFailure, 'error' | 'status' | 'retryable' | 'action'>

const inputFailures = {
  INVALID_SEND_REQUEST: { error: 'The send request is invalid.', status: 400, action: 'fix_request' },
  INVALID_SEND_MODE: { error: 'Choose a supported send mode.', status: 400, action: 'fix_request' },
  ATTACHMENT_CONTENT_REQUIRED: { error: 'Attachment content is required.', status: 400, action: 'fix_attachment' },
  ATTACHMENT_INVALID: { error: 'An attachment is invalid.', status: 400, action: 'fix_attachment' },
  ATTACHMENT_LIMIT_EXCEEDED: { error: 'Attachments exceed the allowed limit.', status: 400, action: 'reduce_attachments' },
  ACCOUNT_NOT_FOUND: { error: 'The sending account was not found.', status: 404, action: 'select_account' },
  THREAD_NOT_FOUND: { error: 'The reply conversation was not found.', status: 404, action: 'select_thread' },
  SEND_UNSUPPORTED: { error: 'This account does not support sending mail.', status: 409, action: 'select_account' },
  REPLY_UNSUPPORTED: { error: 'This account does not support replies.', status: 409, action: 'select_account' },
  INVALID_SCHEDULE: { error: 'Choose a valid send time.', status: 400, action: 'fix_schedule' },
  INVALID_IDEMPOTENCY_KEY: { error: 'The idempotency key is invalid.', status: 400, action: 'fix_request' },
  IDEMPOTENCY_CONFLICT: { error: 'This idempotency key belongs to a different send request.', status: 409, action: 'check_status' },
  SEND_NOT_FOUND: { error: 'The send request was not found.', status: 404, action: 'check_request_id' },
} satisfies Record<string, Omit<FailureDescription, 'retryable'>>

type SendInputCode = keyof typeof inputFailures

// Only application field paths are public; never reflect arbitrary validation input.
const inputField = /^\/(?:accountId|threadId|mode|to|cc|bcc|subject|body|bodyHtml|scheduledAt|idempotencyKey|attachments(?:\/(?:0|[1-9][0-9]{0,5})(?:\/(?:contentBase64|filename|mimeType|size|contentId|isInline))?)?)(?![\s\S])/

export class SendInputError extends Error {
  readonly code: SendInputCode
  readonly field?: string

  constructor(code: string, field?: string) {
    const safeCode = Object.hasOwn(inputFailures, code) ? code as SendInputCode : 'INVALID_SEND_REQUEST'
    super(inputFailures[safeCode].error)
    this.name = 'SendInputError'
    this.code = safeCode
    if (typeof field === 'string' && inputField.test(field)) this.field = field
  }
}

const providerFailures: Record<ProviderErrorCode, FailureDescription> = {
  AUTHENTICATION: { error: 'Mailbox authentication failed.', status: 401, retryable: false, action: 'reconnect_account' },
  AUTHORIZATION: { error: 'The mailbox did not authorize this operation.', status: 403, retryable: false, action: 'review_permissions' },
  NOT_FOUND: { error: 'The requested mailbox resource was not found.', status: 404, retryable: false, action: 'refresh_mailbox' },
  RATE_LIMITED: { error: 'The mailbox provider rate limit was reached.', status: 429, retryable: true, action: 'wait_for_retry' },
  INVALID_CURSOR: { error: 'Mailbox synchronization must be refreshed.', status: 409, retryable: false, action: 'refresh_mailbox' },
  UNSUPPORTED_OPERATION: { error: 'This mailbox does not support the requested operation.', status: 409, retryable: false, action: 'select_account' },
  VALIDATION: { error: 'The mailbox rejected the request as invalid.', status: 400, retryable: false, action: 'fix_request' },
  NETWORK: { error: 'The mailbox provider could not be reached.', status: 502, retryable: true, action: 'check_status' },
  UPSTREAM: { error: 'The mailbox provider could not complete the operation.', status: 502, retryable: true, action: 'check_status' },
}

export function mailFailure(
  error: unknown,
  stage: MailFailure['stage'],
  diagnosticId: string,
): MailFailure {
  if (error instanceof UnsupportedOperationError && error.operation === 'thread replies with explicit CC or BCC recipients') {
    return { code: 'REPLY_RECIPIENTS_UNSUPPORTED', error: 'This account cannot preserve CC or BCC recipients in a threaded reply. Use a new message or another account.',
      status: 409, retryable: false, action: 'compose_new_message', stage, diagnosticId }
  }
  if (error instanceof SendInputError) {
    const code = Object.hasOwn(inputFailures, error.code) ? error.code : 'INVALID_SEND_REQUEST'
    return {
      code, ...inputFailures[code], retryable: false, stage, diagnosticId,
      ...(typeof error.field === 'string' && inputField.test(error.field) ? { field: error.field } : {}),
    }
  }

  if (error instanceof ProviderError) {
    const code = Object.hasOwn(providerFailures, error.code) ? error.code : 'UPSTREAM'
    const failure: MailFailure = { code, ...providerFailures[code], stage, diagnosticId }
    if ((stage === 'dispatch' || stage === 'recovery') && (code === 'NETWORK' || code === 'UPSTREAM')) {
      failure.error = 'Provider acceptance may be uncertain. Check send status before sending again.'
    }
    if (stage === 'recovery') {
      failure.retryable = false
      failure.action = 'check_status'
    }
    if (code === 'RATE_LIMITED' && typeof error.retryAfter === 'number' &&
      Number.isFinite(error.retryAfter) && error.retryAfter >= 0 && error.retryAfter <= Number.MAX_SAFE_INTEGER) {
      failure.retryAfterSeconds = Math.ceil(error.retryAfter)
    }
    return failure
  }

  if (stage === 'validation') {
    return { code: 'INVALID_SEND_REQUEST', ...inputFailures.INVALID_SEND_REQUEST, retryable: false, stage, diagnosticId }
  }
  if (stage === 'configuration') {
    return {
      code: 'CONFIGURATION_ERROR', error: 'Mail sending is not configured correctly.', status: 500,
      retryable: false, action: 'check_configuration', stage, diagnosticId,
    }
  }
  return {
    code: stage === 'recovery' ? 'RETRY_EXHAUSTED' : 'INTERNAL_ERROR',
    error: stage === 'recovery'
      ? 'Automatic retries have stopped. Provider acceptance may be uncertain. Check send status before sending again.'
      : 'The operation could not be completed. Provider acceptance may be uncertain. Check send status before sending again.',
    status: 500, retryable: stage !== 'recovery', action: 'check_status', stage, diagnosticId,
  }
}

/** Reconstruct only allowlisted diagnostics; legacy last_error text is never public. */
export function storedMailFailure(value: unknown, diagnosticId: string): MailFailure {
  let saved: Record<string, unknown> = {}
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : null
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) saved = parsed
  } catch { /* Legacy provider strings intentionally have no public detail. */ }
  const stage = saved.stage === 'validation' || saved.stage === 'configuration' || saved.stage === 'recovery'
    ? saved.stage : 'dispatch'
  const code = typeof saved.code === 'string' ? saved.code : ''
  if (Object.hasOwn(inputFailures, code)) {
    return mailFailure(new SendInputError(code, typeof saved.field === 'string' ? saved.field : undefined), stage, diagnosticId)
  }
  if (code === 'REPLY_RECIPIENTS_UNSUPPORTED') {
    return mailFailure(new UnsupportedOperationError('mock', 'thread replies with explicit CC or BCC recipients'), stage, diagnosticId)
  }
  if (Object.hasOwn(providerFailures, code)) {
    return mailFailure(new ProviderError('mock', code as ProviderErrorCode, '', {
      retryAfter: typeof saved.retryAfterSeconds === 'number' ? saved.retryAfterSeconds : undefined,
    }), stage, diagnosticId)
  }
  return mailFailure(new Error(), stage, diagnosticId)
}
