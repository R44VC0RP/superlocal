import { createHash } from 'node:crypto'
import {
  htmlToPlainText, parseParticipants, ProviderError,
  type Participant, type Recipient, type SendAttachment, type SendInput,
} from 'inbox-sdk/provider'

export const PROVIDER_ID = 'mock'
export const MOCK_OWNER = 'superlocal-mock'
export const SYSTEM_FOLDERS = ['inbox', 'sent', 'archive', 'spam', 'trash'] as const
export const LOCAL_FOLDERS = ['drafts', 'scheduled', 'snoozed'] as const
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
const controls = /[\u0000-\u001f\u007f]/

export function invalid(message: string): never {
  throw new ProviderError(PROVIDER_ID, 'VALIDATION', message, { status: 400 })
}

export function object(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    invalid(`${field} must be an object.`)
  }
}

export function keys(value: object, allowed: readonly string[], field: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid(`${field} contains an unsupported field.`)
}

export function text(value: unknown, field: string, maximum = 512, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > maximum || controls.test(value)) {
    invalid(`Invalid ${field}.`)
  }
  return value
}

export function contextId(value: unknown, field: string): string {
  const result = text(value, field)
  if (result.trim() !== result || /[\/\\]/.test(result)) invalid(`Invalid ${field}.`)
  return result
}

export function storeId(value: unknown): string {
  if (typeof value !== 'string' || !new RegExp(`^${UUID}$`).test(value)) invalid('Invalid mock store identity.')
  return value
}

export function nativeId(value: unknown, kind: 'msg' | 'thr' | 'att' | 'fld' | 'lbl', store: string): string {
  if (typeof value !== 'string' || !new RegExp(`^${kind}_${UUID}_${UUID}$`).test(value)) invalid(`Invalid native ${kind} ID.`)
  if (!value.startsWith(`${kind}_${store}_`)) {
    throw new ProviderError(PROVIDER_ID, 'AUTHORIZATION', 'The native resource belongs to another mock store.', { status: 403 })
  }
  return value
}

export function email(value: unknown): string {
  const result = text(value, 'email address', 254).trim().toLowerCase()
  if (!/^[^\s<>(),;:"\\@]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(result)) invalid('Invalid email address.')
  return result
}

export function recipients(value: Recipient | Recipient[] | undefined, field: string): Participant[] {
  if (value === undefined) return []
  const values = Array.isArray(value) ? value : [value]
  if (values.length > 200) invalid(`Too many ${field}.`)
  for (const item of values) {
    if (typeof item === 'string') text(item, field, 4096)
    else {
      object(item, field)
      keys(item, ['name', 'email', 'avatar'], field)
      text(item.name, 'participant name', 1024, true)
      email(item.email)
      if (item.avatar !== undefined && item.avatar !== null) text(item.avatar, 'avatar', 4096)
    }
  }
  const parsed = parseParticipants(value)
  if (parsed.length > 200) invalid(`Too many ${field}.`)
  return parsed.map(item => ({ name: text(item.name, 'participant name', 1024, true), email: email(item.email) }))
}

export function uniqueRecipients(values: Participant[]): Participant[] {
  return [...new Map(values.map(value => [value.email, value])).values()]
}

export function rfcId(value: unknown, field = 'RFC Message-ID'): string {
  const result = text(value, field, 998)
  if (!/^<[^\s<>@]+@[^\s<>@]+>$/.test(result)) invalid(`Invalid ${field}.`)
  return result
}

export function references(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 200) invalid('Invalid References.')
  return [...new Set(value.map(item => rfcId(item, 'References')))]
}

const headerNames: Record<string, string> = {
  'message-id': 'Message-ID', 'in-reply-to': 'In-Reply-To', references: 'References',
  'reply-to': 'Reply-To', 'x-inbox-submission-id': 'X-Inbox-Submission-ID',
}

export function headers(value: unknown): Record<string, string> {
  if (value === undefined) return {}
  object(value, 'Headers')
  if (Object.keys(value).length > 100) invalid('Too many headers.')
  const result: Record<string, string> = Object.create(null)
  for (const [key, val] of Object.entries(value)) {
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/.test(key)) invalid('Invalid header name.')
    const lower = key.toLowerCase()
    if (['from', 'sender', 'to', 'cc', 'bcc', 'subject', 'return-path', 'received', 'date', 'content-type', 'content-transfer-encoding', 'mime-version'].includes(lower)) {
      invalid('Envelope and MIME headers cannot override structured message fields.')
    }
    const name = Object.hasOwn(headerNames, lower) ? headerNames[lower]! : lower
    if (Object.hasOwn(result, name)) invalid('Duplicate header name.')
    result[name] = text(val, 'header value', 4096)
  }
  if (result['Message-ID']) rfcId(result['Message-ID'])
  if (result['In-Reply-To']) rfcId(result['In-Reply-To'], 'In-Reply-To')
  if (result.References) references(result.References.split(/\s+/))
  if (result['Reply-To']) recipients(result['Reply-To'], 'Reply-To')
  if (result['X-Inbox-Submission-ID']) text(result['X-Inbox-Submission-ID'], 'submission ID', 200)
  return result
}

export function contentId(value: unknown): string {
  const result = text(value, 'Content-ID', 512).replace(/^<|>$/g, '')
  if (!result || /[\s<>]/.test(result)) invalid('Invalid Content-ID.')
  return result
}

export interface PreparedAttachment {
  filename: string
  contentType: string
  content: Uint8Array
  contentId?: string
  inline?: boolean
}

export function attachments(value: SendAttachment[] | undefined): PreparedAttachment[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 20) invalid('Invalid attachments.')
  const seen = new Set<string>()
  return value.map(item => {
    object(item, 'Attachment')
    keys(item, ['filename', 'content', 'contentType', 'encoding', 'contentId', 'inline'], 'Attachment')
    const filename = text(item.filename, 'attachment filename')
    const type = item.contentType === undefined ? 'application/octet-stream' : text(item.contentType, 'content type', 255)
    if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(type)) invalid('Invalid content type.')
    if (item.encoding !== undefined && item.encoding !== 'base64' && item.encoding !== 'utf8') invalid('Invalid attachment encoding.')
    if (item.inline !== undefined && typeof item.inline !== 'boolean') invalid('Invalid inline attachment flag.')
    let bytes: Uint8Array
    if (typeof item.content === 'string') {
      if (item.content.length > 35 * 1024 * 1024) invalid('Attachment exceeds 25 MiB.')
      if (item.encoding === 'base64') {
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.content)) invalid('Invalid base64 attachment.')
        bytes = new Uint8Array(Buffer.from(item.content, 'base64'))
        if (Buffer.from(bytes).toString('base64') !== item.content) invalid('Invalid base64 attachment.')
      } else bytes = new TextEncoder().encode(item.content)
    } else if (item.content instanceof Uint8Array) bytes = new Uint8Array(item.content)
    else if (item.content instanceof ArrayBuffer) bytes = new Uint8Array(item.content.slice(0))
    else invalid('Invalid attachment content.')
    if (typeof item.content !== 'string' && item.encoding !== undefined) invalid('Byte attachments do not use a text encoding.')
    if (bytes.byteLength > 25 * 1024 * 1024) invalid('Attachment exceeds 25 MiB.')
    const cid = item.contentId === undefined ? undefined : contentId(item.contentId)
    if (cid && seen.has(cid)) invalid('Duplicate Content-ID.')
    if (cid) seen.add(cid)
    return { filename, contentType: type, content: bytes,
      ...(cid ? { contentId: cid } : {}), ...(item.inline === undefined ? {} : { inline: item.inline }) }
  })
}

export function body(input: Pick<SendInput, 'text' | 'bodyText' | 'body' | 'html' | 'bodyHtml'>): { bodyText: string; bodyHtml: string } {
  const choose = (values: Array<string | undefined>, field: string) => {
    const supplied = values.filter((value): value is string => value !== undefined)
    if (supplied.some(value => typeof value !== 'string' || value.length > 1024 * 1024 || value.includes('\0'))) invalid(`Invalid ${field}.`)
    if (new Set(supplied).size > 1) invalid(`Conflicting ${field} aliases.`)
    return supplied[0]
  }
  const bodyHtml = choose([input.html, input.bodyHtml], 'HTML body') ?? ''
  return { bodyText: choose([input.text, input.bodyText, input.body], 'text body') ?? htmlToPlainText(bodyHtml), bodyHtml }
}

export function stableJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize)
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).filter(([, val]) => val !== undefined).sort(([a], [b]) => compare(a, b)).map(([key, val]) => [key, normalize(val)]))
    return item
  }
  return JSON.stringify(normalize(value))
}

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

export function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0 }

export function limit(value: unknown, fallback = 50): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 100) invalid('Limit must be an integer between 1 and 100.')
  return value
}
