import { Parser } from 'htmlparser2'
import type { Participant } from './contracts'

/** Cached evidence only: no fetching, rendering, sanitization, or canonical mutations. */
export interface ForwardingBody {
  bodyText?: string
  bodyHtml?: string
  attachments?: unknown[]
  replyTo?: Participant[]
  rfcMessageId?: string
  inReplyTo?: string
}
export interface ForwardingMessage {
  from: Participant
  to: Participant[]
  subject: string
  hasAttachments: boolean
}
export const FORWARDING_BODY_BYTES = 256 * 1024
export const FORWARDING_DEPTH = 8
export function forwardingRfcId(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 998 && /^<[^<>\s]+>$/.test(value) ? value : null
}
const address = (value: string) => value.trim().toLowerCase()
const normalized = (value: string) => value.replace(/\r\n?/g, '\n').replace(/[\s\u00a0]+/g, ' ').trim()
const bannerStyle = "text-align: center; margin: 20px 0; padding: 10px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; font-size: 12px; color: #6b7280; border-top: 1px solid #e5e7eb;"
const linkStyle = 'color: #8b5cf6; text-decoration: none;'

function inboundTrailingMarkup(value: string): string | null {
  let retained = '', pixels = 0
  const tokens = value.match(/<[^>]*>|\s+|[^<\s]+/g) ?? []
  if (tokens.join('') !== value) return null
  for (const token of tokens) {
    if (!token.trim() || /^<\/(?:body|html)\s*>$/i.test(token)) { retained += token; continue }
    if (!/^<img\b[^>]*>$/i.test(token) || ++pixels > 1) return null
    let valid = false
    const parser = new Parser({ onopentag(name, attrs) {
      if (name !== 'img' || Object.keys(attrs).sort().join(',') !== 'alt,src,style' || attrs.alt !== '' ||
        attrs.style?.replace(/\s/g, '').replace(/;$/, '').toLowerCase() !== 'display:none;width:1px;height:1px') return
      try {
        const url = new URL(attrs.src!)
        valid = url.protocol === 'https:' && /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.awstrack\.me$/i.test(url.hostname) &&
          !url.username && !url.password && !url.port && url.pathname.split('/').filter(Boolean).length === 3
      } catch { /* Unrecognized resources are content, never removable tracking. */ }
    } }, { decodeEntities: true })
    parser.end(token)
    if (!valid) return null
  }
  return retained
}

function stripInboundBanner(html: string, sender: string): string | null {
  // Public Inbound generateEmailBannerHTML: exact final div, two exact links,
  // no extra descendants or attributes. A footer phrase alone is not authority.
  const block = `https://inbound.new/addtoblocklist?email=${encodeURIComponent(sender)}`
  const expected = JSON.stringify([
    ['div', { style: bannerStyle }],
    ['a', { href: 'https://inbound.new', style: linkStyle }],
    ['a', { href: block, rel: 'noopener noreferrer', style: linkStyle, target: '_blank' }],
  ])
  const stack: Array<{ start: number; tags: unknown[]; text: string }> = []
  let cleaned: string | null = null, invalid = false
  const parser = new Parser({
    onopentag(name, attrs) {
      if (stack.length > 128) { invalid = true; return }
      const tag = [name, Object.fromEntries(Object.entries(attrs).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, key === 'style' ? normalized(value) : value]))]
      for (const item of stack) if (item.tags.length < 4) item.tags.push(tag)
      stack.push({ start: parser.startIndex, tags: [tag], text: '' })
    },
    ontext(value) { for (const item of stack) if (item.text.length <= 4096) item.text += value.slice(0, 4097 - item.text.length) },
    oncomment() { for (const item of stack) if (item.tags.length < 4) item.tags.push(['comment']) },
    onclosetag() {
      const item = stack.pop()
      if (!item || invalid || item.text.length > 4096 || JSON.stringify(item.tags) !== expected || normalized(item.text) !== `sent via inbound.new, block ${sender}`) return
      const tail = inboundTrailingMarkup(html.slice(parser.endIndex + 1))
      if (tail !== null) cleaned = html.slice(0, item.start) + tail
    },
    onerror() { invalid = true },
  }, { decodeEntities: true })
  parser.end(html)
  return invalid ? null : cleaned
}

/** Strip only the verified public Inbound automation suffix, never quoted content/comments. */
export function forwardingContent(body: ForwardingBody, sender: string): { text: string; html: string } | null {
  if (typeof body.bodyText !== 'string' || typeof body.bodyHtml !== 'string') return null
  const suffix = `\n\n---\nsent via inbound.new, block ${sender}: https://inbound.new/addtoblocklist?email=${encodeURIComponent(sender)}`
  const text = body.bodyText.replace(/\r\n?/g, '\n').trimEnd()
  if (!text.endsWith(suffix)) return { text, html: body.bodyHtml }
  if (!body.bodyHtml.trim()) return { text: text.slice(0, -suffix.length), html: '' }
  const html = stripInboundBanner(body.bodyHtml, sender)
  return html === null ? null : { text: text.slice(0, -suffix.length), html }
}

function htmlEvidence(html: string): string | null {
  // Preserve structure and every attribute: alt/title text, hidden/display rules,
  // classes/IDs, CSS selectors and destinations can all change rendered meaning.
  // Only attribute-free html/body transport wrappers are ignored. This is not a
  // browser/computed-style equivalence engine; uncertain formatting fails open.
  const evidence: unknown[] = [], ignored: boolean[] = []
  let text = '', hidden = 0, invalid = false
  const flush = () => { const value = normalized(text); if (value) evidence.push(['text', value]); text = '' }
  const parser = new Parser({
    onopentag(name, attributes) {
      flush()
      if (ignored.length >= 128) invalid = true
      const attrs = Object.entries(attributes).sort(([a], [b]) => a.localeCompare(b))
      const skip = (name === 'html' || name === 'body') && !attrs.length
      ignored.push(skip)
      if (!skip) evidence.push(['open', name, attrs])
      if (name === 'style' || name === 'script') hidden++
    },
    onclosetag(name) {
      flush()
      if (!ignored.pop()) evidence.push(['close', name])
      if (name === 'style' || name === 'script') hidden--
    },
    ontext(value) { if (hidden) evidence.push(['code', value.replace(/\r\n?/g, '\n')]); else text += value },
    oncomment(value) { flush(); evidence.push(['comment', value.replace(/\r\n?/g, '\n')]) },
    onerror() { invalid = true },
  }, { decodeEntities: true })
  parser.end(html); flush()
  return invalid ? null : JSON.stringify(evidence)
}

export function isForwardedCopy(forward: ForwardingMessage, forwardedBody: ForwardingBody,
  original: ForwardingMessage, originalBody: ForwardingBody, deliveredToForwarder: boolean): boolean {
  const sender = address(forward.from.email), author = address(original.from.email)
  if (!sender || !author || sender === author || forward.subject !== original.subject ||
    forward.hasAttachments || original.hasAttachments || forwardedBody.attachments?.length || originalBody.attachments?.length ||
    forwardedBody.replyTo?.length !== 1 || address(forwardedBody.replyTo[0]!.email) !== author ||
    !original.to.some(person => address(person.email) === sender) && !deliveredToForwarder) return false
  const a = forwardingContent(forwardedBody, forward.from.email.trim()), b = forwardingContent(originalBody, original.from.email.trim())
  if (!a || !b || !normalized(a.text) || normalized(a.text) !== normalized(b.text)) return false
  // Genuine text-only pairs have no HTML destinations to compare. One-sided
  // missing HTML remains unproven, even when the plain-text alternatives match.
  if (!!a.html.trim() !== !!b.html.trim()) return false
  if (!a.html.trim()) return true
  const left = htmlEvidence(a.html), right = htmlEvidence(b.html)
  return left !== null && right !== null && left === right
}
