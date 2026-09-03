import { Parser } from 'htmlparser2'
import type { MailFacts } from './contracts'

/** Bounded source evidence, never an attention/spam decision. No URL is retained or fetched. */
export function mailFacts(input: {
  headers?: Record<string, string>; bodyHtml?: string; bodyText?: string;
  inReplyTo?: string; references?: string[]; nativeCategories?: string[]; isImportant?: boolean;
}): MailFacts {
  const headers = Object.fromEntries(Object.entries(input.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]))
  let unsubscribeLink = false, inLink = false, label = ''
  const parser = new Parser({
    onopentag(name, attributes) {
      if (name !== 'a') return
      inLink = /^(https?:|mailto:)/i.test(attributes.href ?? ''); label = ''
      if (inLink && /(?:[/=?&_-])unsubscribe(?:[/=?&#_-]|$)/i.test(attributes.href ?? '')) unsubscribeLink = true
    },
    ontext(text) { if (inLink && label.length < 128) label += text.slice(0, 128) },
    onclosetag(name) {
      if (name !== 'a') return
      if (inLink && /^\s*(?:unsubscribe|unsubscribe here|manage (?:email |your )?preferences|opt out)\s*$/i.test(label)) unsubscribeLink = true
      inLink = false
    },
  })
  // Inspect a bounded head and tail, which includes normal message footers.
  const html = input.bodyHtml ?? ''
  parser.write(html.slice(0, 32_768)); if (html.length > 32_768) parser.write(html.slice(-32_768)); parser.end()
  if (!html) unsubscribeLink = /https?:\/\/\S{1,1024}(?:[/=?&_-])unsubscribe(?:[/=?&#_-]|\b)/i.test((input.bodyText ?? '').slice(-32_768))
  const precedence = headers.precedence?.trim().toLowerCase()
  const submitted = headers['auto-submitted']?.trim().toLowerCase().split(';')[0]
  return {
    version: 1,
    ...(input.headers ? {
      listId: !!headers['list-id']?.trim(),
      listUnsubscribe: /(?:https?:|mailto:)/i.test(headers['list-unsubscribe'] ?? ''),
      listPost: !!headers['list-post'] && headers['list-post'].trim().toLowerCase() !== 'no',
      bulk: precedence === 'bulk' || precedence === 'list' || precedence === 'junk',
      automated: !!submitted && submitted !== 'no',
    } : {}),
    unsubscribeLink,
    reply: !!input.inReplyTo || !!input.references?.length,
    ...(input.nativeCategories ? { nativeCategories: input.nativeCategories.filter(value => /^[a-z_]{1,40}$/.test(value)).slice(0, 8) } : {}),
    ...(input.isImportant !== undefined ? { nativeImportant: input.isImportant } : {}),
  }
}
