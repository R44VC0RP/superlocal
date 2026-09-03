import { Parser } from 'htmlparser2'

// These are per-message ceilings, independent of the caller's requested length.
const MAX_INPUT = 128 * 1024
const MAX_TEXT = 16 * 1024
const MAX_BLOCKS = 256
const MAX_EVENTS = 12_000
const MAX_DEPTH = 80
const BLOCKS = new Set(['address', 'article', 'blockquote', 'br', 'div', 'h1', 'h2', 'h3', 'h4', 'hr', 'li', 'p', 'section', 'table', 'td', 'th', 'tr'])
const OMIT = new Set(['head', 'script', 'style', 'template', 'noscript', 'svg', 'nav', 'footer', 'form', 'button'])
const NAV = /^(?:logo|home|women|men|kids|shop|shop now|new arrivals|sale|contact us|follow us|facebook|instagram|twitter|pinterest|view online|view in browser|unsubscribe|privacy policy|terms(?: and conditions)?)$/i

type Block = { text: string; links: number }
type Preheader = { text: string; explicit: boolean; invalid: boolean }

function spacing(value: string): string {
  return value.replace(/[\s\u00ad\u034f\u200b-\u200d\u2060\ufeff]+/gu, (run: string, offset: number, all: string) => {
    // A lone joiner within a word or emoji is content; repeated/space-adjacent
    // joiners are the padding used to fill the rest of an inbox preview.
    if (/^[\u200c\u200d]$/.test(run) && offset > 0 && offset + 1 < all.length &&
      !/[\s\u00ad\u034f\u200b-\u200d\u2060\ufeff]/u.test(all[offset - 1]! + all[offset + 1]!)) return run
    if (run.includes('\n') || run.includes('\r')) return '\n'
    return /\s/u.test(run) || run.length > 1 || run === '\u200b' ? ' ' : ''
  }).trim()
}

function clean(value: string): string {
  return spacing(value
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '')
    // Bounded labels avoid backtracking across arbitrarily many unmatched '['.
    .replace(/!?\[([^\]\r\n]{0,512})\]\([^\)\r\n]*(?:\)|$)/g, (match, label: string) => match.startsWith('!') ? '' : label)
    .replace(/!?\[([^\]\r\n]{0,512})\]\[[^\]\r\n]{0,128}\]/g, (match, label: string) => match.startsWith('!') ? '' : label)
    .replace(/(?:https?:\/\/|www\.|mailto:)[^\s<>\[\]]+/gi, '')
    .replace(/\[\s*\]|<\s*>|\(\s*\)/g, '')
    .replace(/^[ \t]*\[\d{1,3}\]:[ \t]*$/gm, '')
    .replace(/^[ \t]*[|•·][ \t]*|[ \t]*[|•·][ \t]*$/gm, ''))
}

function footer(value: string): boolean {
  return /^(?:unsubscribe(?: here| from (?:this|these) emails?)?|(?:manage|update) (?:your )?(?:email |subscription )?preferences|email preferences|privacy policy|terms (?:of (?:use|service)|and conditions)|all rights reserved)[.!]?(?:\s*[|•·].*)?$/i.test(value) ||
    /^(?:[©®]|copyright\s+\d{4}\b)/i.test(value) ||
    /^(?:you(?:['’]re| are) receiving|you (?:have )?received) (?:this email|this message|these emails) because (?:you(?:['’]ve| have)? (?:subscribed|signed up|opted in)|you(?:['’]re| are) subscribed|of your subscription)/i.test(value) ||
    /^(?:this (?:email|message) was sent to|sent to:)\s+\S+@\S+/i.test(value) ||
    /^(?:if you (?:no longer wish|do not wish|don't want) to receive|to (?:unsubscribe|stop receiving these emails))\b/i.test(value)
}

function webView(value: string): boolean {
  return /^(?:to view this email as a web page,? (?:please )?click(?: here| this link)?|view (?:the )?web version)[.!]?$/i.test(value) ||
    /^(?:(?:view|read|open) (?:this |the )?(?:email|message)(?: online| in (?:your |a )?browser)|(?:view|read) (?:online|in (?:your |a )?browser)|having trouble (?:viewing|reading) (?:this |the )?(?:email|message)|(?:can't|cannot) (?:see|view|read) (?:this |the )?(?:email|message))\b/i.test(value)
}

function htmlBlocks(source: string): { body: Block[]; preheaders: Preheader[] } {
  const body: Block[] = []
  const preheaders: Preheader[] = []
  const stack: { skip: boolean; preheader?: Preheader; block: boolean }[] = []
  let current: Block = { text: '', links: 0 }
  let events = 0
  let textSize = 0
  let visibleSize = 0
  let stopped = false
  const flush = () => {
    if (current.text.trim() && body.length < MAX_BLOCKS) body.push(current)
    current = { text: '', links: 0 }
  }
  const step = () => {
    if (stopped) return false
    if (++events <= MAX_EVENTS && body.length < MAX_BLOCKS && textSize < MAX_TEXT) return true
    stopped = true
    parser.pause()
    return false
  }
  const parser = new Parser({
    onopentag(name, attributes) {
      if (!step()) return
      if (stack.length >= MAX_DEPTH) { stopped = true; parser.pause(); return }
      const parent = stack.at(-1)
      const marker = `${attributes.class ?? ''} ${attributes.id ?? ''}`.slice(0, 2048)
      const style = (attributes.style ?? '').slice(0, 2048).toLowerCase()
      const explicit = /(?:^|[\s_-])(?:preheader|pre-header|preview[-_]?text|email[-_]?preview)(?:$|[\s_-])/i.test(marker)
      const hidden = attributes.hidden !== undefined || attributes['aria-hidden'] === 'true' ||
        /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:[;\s!]|$)|(?:max-)?height\s*:\s*0(?:px)?(?:[;\s!]|$)|mso-hide\s*:\s*all)/i.test(style)
      const omitted = OMIT.has(name) || attributes.role === 'navigation' ||
        /(?:^|[\s_-])(?:logo|navigation|navbar|footer|unsubscribe)(?:$|[\s_-])/i.test(marker)
      const leadingHidden = hidden && visibleSize < 80 && parser.startIndex < 24 * 1024 &&
        ['div', 'span', 'p', 'td'].includes(name) && !attributes['aria-hidden']
      let preheader = parent?.preheader
      if (!parent?.skip && !preheader && !omitted && (explicit || leadingHidden) && preheaders.length < 8) {
        preheader = { text: '', explicit, invalid: false }
        preheaders.push(preheader)
      }
      const skip = Boolean(parent?.skip || omitted || (hidden && !preheader))
      const block = BLOCKS.has(name)
      if (block && !skip && !preheader) flush()
      if (preheader && (name === 'img' || name === 'a') && !preheader.explicit) preheader.invalid = true
      if (name === 'a' && !skip && !preheader) current.links++
      stack.push({ skip, preheader, block })
    },
    ontext(text) {
      if (!step()) return
      const frame = stack.at(-1)
      if (frame?.skip) return
      const part = text.slice(0, MAX_TEXT - textSize)
      textSize += part.length
      if (frame?.preheader) {
        const candidate = frame.preheader
        if (candidate.text.length + part.length > 2048) candidate.invalid = true
        candidate.text += part.slice(0, 2048 - candidate.text.length)
      } else {
        current.text += part
        visibleSize += part.trim().length
      }
    },
    onclosetag() {
      if (!step()) return
      const frame = stack.pop()
      if (frame?.block && !frame.skip && !frame.preheader) flush()
    },
  }, { decodeEntities: true, lowerCaseTags: true })
  // Do not call end after pausing: that would close a pathological tag stack.
  parser.write(source.slice(0, MAX_INPUT))
  if (!stopped) parser.end()
  flush()
  return { body, preheaders }
}

function useful(blocks: Block[], sender: string): string[] {
  const result: string[] = []
  for (const block of blocks) {
    const value = clean(block.text)
    if (!value) continue
    if (footer(value)) break
    if (webView(value)) continue
    if (sender && value.toLowerCase() === sender) continue
    if (/^(?:logo|image|spacer)$/i.test(value)) continue
    const labels = value.split(/[|•·\n]+/).map((label) => label.trim()).filter(Boolean)
    if (labels.length && labels.every((label) => NAV.test(label)) &&
      (block.links > 0 || labels.length > 1 || value === value.toUpperCase())) continue
    if (!/[\p{L}\p{N}\p{S}]/u.test(value)) continue
    result.push(value)
  }
  return result
}

function textBlocks(text: string): Block[] {
  return spacing(text.slice(0, MAX_INPUT)).slice(0, MAX_TEXT).split(/\n/).slice(0, MAX_BLOCKS)
    .map((text) => ({ text, links: /\]\(/.test(text) ? 1 : 0 }))
}

function excerpt(parts: string[], subject: string, limit: number): string {
  if (!parts.length) return ''
  let value = parts.join('\n')
  if (subject && value.startsWith(subject)) {
    const rest = value.slice(subject.length)
    if (/^(?:\n|\s+[-–—|]\s+|:\s+|[.!?]\s+)/u.test(rest) || (/[.!?]$/.test(subject) && /^\s/.test(rest))) {
      const remainder = rest.replace(/^[\s:|.!?–—-]+/, '').trim()
      if (remainder && /[\p{L}\p{N}\p{S}]/u.test(remainder)) value = remainder
    }
  }
  let fitted = ''
  for (const paragraph of value.split('\n')) {
    const next = fitted ? `${fitted} ${paragraph}` : paragraph
    if (next.length > limit && fitted.length >= Math.min(80, limit / 2)) break
    fitted = next
    if (fitted.length >= limit) break
  }
  if (fitted.length <= limit) return fitted
  let end = limit
  if (end > 0 && /[\ud800-\udbff]/.test(fitted[end - 1]!)) end--
  const prefix = fitted.slice(0, end)
  const word = prefix.lastIndexOf(' ')
  return (word >= limit * 0.65 ? prefix.slice(0, word) : prefix).replace(/[\s\u200c\u200d]+$/u, '')
}

/** Extract display-only inbox text; never changes or sanitizes the message body. */
export function mailPreview(input: {
  readonly bodyText?: string
  readonly bodyHtml?: string
  readonly preview?: string
  readonly subject?: string
  readonly from?: { readonly name?: string }
}, limit = 200): string {
  const size = Number.isFinite(limit) ? Math.max(0, Math.min(MAX_TEXT, Math.floor(limit))) : 200
  if (!size) return ''
  const sender = clean((input.from?.name ?? '').slice(0, 512)).toLowerCase()
  const subject = clean((input.subject ?? '').slice(0, 1024))
  const html = input.bodyHtml ? htmlBlocks(input.bodyHtml) : undefined
  for (const candidate of html?.preheaders ?? []) {
    if (candidate.invalid || (!candidate.explicit && clean(candidate.text).length > 500)) continue
    const parts = useful(textBlocks(candidate.text), sender)
    if (parts.length) return excerpt(parts, subject, size)
  }
  const preview = (input.preview ?? '').slice(0, MAX_TEXT)
  const previewParts = useful(textBlocks(preview), sender)
  // Native snippets that already contain useful text should not be rewritten
  // merely because the HTML representation happens to be differently worded.
  if (previewParts.length && spacing(preview) === previewParts.join('\n')) return excerpt(previewParts, subject, size)
  const body = useful(html?.body ?? [], sender)
  if (body.length) return excerpt(body, subject, size)
  const plain = useful(textBlocks(input.bodyText ?? ''), sender)
  if (plain.length) return excerpt(plain, subject, size)
  return excerpt(previewParts, subject, size)
}
