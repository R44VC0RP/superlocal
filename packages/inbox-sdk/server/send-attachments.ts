import { SendInputError } from './mail-errors'

const MAX_BYTES = 25 * 1024 * 1024

export function normalizeSendAttachments(value: unknown) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new SendInputError('ATTACHMENT_INVALID', '/attachments')
  if (value.length > 20) throw new SendInputError('ATTACHMENT_LIMIT_EXCEEDED', '/attachments')
  let totalBytes = 0
  return value.map((entry, index) => {
    const field = `/attachments/${index}`
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new SendInputError('ATTACHMENT_INVALID', field)
    }
    const item = entry as Record<string, unknown>
    if (typeof item.contentBase64 !== 'string') {
      throw new SendInputError('ATTACHMENT_CONTENT_REQUIRED', `${field}/contentBase64`)
    }
    if (item.contentBase64.length > Math.ceil(MAX_BYTES / 3) * 4) {
      throw new SendInputError('ATTACHMENT_LIMIT_EXCEEDED', field)
    }
    const bytes = Buffer.from(item.contentBase64, 'base64')
    const canonical = bytes.toString('base64')
    if (item.contentBase64 !== canonical && item.contentBase64 !== canonical.replace(/=+$/, '')) {
      throw new SendInputError('ATTACHMENT_INVALID', `${field}/contentBase64`)
    }
    totalBytes += bytes.length
    if (totalBytes > MAX_BYTES) throw new SendInputError('ATTACHMENT_LIMIT_EXCEEDED', '/attachments')
    const filename = item.filename ?? item.name
    const contentType = item.contentType ?? item.content_type ?? 'application/octet-stream'
    if (typeof filename !== 'string' || !filename.trim() || /[\r\n\0]/.test(filename)
      || typeof contentType !== 'string' || !contentType.trim() || /[\r\n\0]/.test(contentType)
      || (item.inline !== undefined && typeof item.inline !== 'boolean')
      || (item.contentId !== undefined && (typeof item.contentId !== 'string' || /[\r\n\0]/.test(item.contentId)))) {
      throw new SendInputError('ATTACHMENT_INVALID', field)
    }
    const id = crypto.randomUUID()
    return {
      id, filename, contentType, size: bytes.length, contentBase64: canonical,
      url: `/api/attachments/${id}`,
      ...(typeof item.inline === 'boolean' ? { inline: item.inline } : {}),
      ...(typeof item.contentId === 'string' ? { contentId: item.contentId } : {}),
    }
  })
}
