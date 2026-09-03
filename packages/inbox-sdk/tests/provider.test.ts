import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ImapFlow } from 'imapflow'
import type SMTPTransport from 'nodemailer/lib/smtp-transport'
import { builtInProviders } from '../src/providers'
import { mailPreview } from '../src/mail-preview'
import type { ProviderDefinition } from '../src/contracts'
import { ImapProvider, type ImapCredentials } from '../server/sdk/imap'
import type {
  InboxProvider, MailMessage, MessageMutation, ProviderCapabilities, ProviderCredentials,
  ProviderFolder, SendInput, SendResult, SyncCursor,
} from '../server/sdk/types'

describe('mail preview', () => {
  test('prefers sender preheaders over logos, navigation and tracking links', () => {
    const cases = [
      { from: 'Harbor Aroma', preview: '![Harbor Aroma](https://track.example.test/logo) [WOMEN](https://track.example.test/women) [MEN](https://track.example.test/men)', html: '<div style="display:none;max-height:0">Try two discovery sprays for $3 through Sunday.</div>', expected: 'Try two discovery sprays for $3 through Sunday.' },
      { from: 'Lantern Hotel', preview: `https://track.example.test/${'fictional/'.repeat(30)}`, html: '<div class="preheader">Book early for 22% off your next stay.</div>', expected: 'Book early for 22% off your next stay.' },
      { from: 'Northline', preview: `Northline${'\u200c\u00a0'.repeat(150)}`, html: `<span class="preheader" style="display:none">Soft layers made for slow mornings.${'\u200c&nbsp;'.repeat(150)}</span>`, expected: 'Soft layers made for slow mornings.' },
      { from: 'Home Team', preview: 'View this email in your browser https://track.example.test/webview', html: '<div id="preview-text">Meet the vacuum and mop that work together.</div>', expected: 'Meet the vacuum and mop that work together.' },
    ]
    for (const item of cases) {
      expect(mailPreview({ preview: item.preview, bodyText: item.preview, bodyHtml: `${item.html}<a href="https://example.test"><img alt="Logo"></a><nav>WOMEN MEN</nav><p>Other body content.</p>`, from: { name: item.from } })).toBe(item.expected)
    }
  })

  test('skips standalone web-version prompts without removing technical discussion', () => {
    for (const prompt of ['To view this email as a web page, click here.', 'View web version']) {
      expect(mailPreview({ preview: prompt, bodyHtml: `<div><a href="https://track.example.test/webview">${prompt}</a></div><p>The revised plan is ready for review.</p>` })).toBe('The revised plan is ready for review.')
      expect(mailPreview({ bodyText: `${prompt}\nThe revised plan is ready for review.` })).toBe('The revised plan is ready for review.')
    }
    for (const bodyText of [
      'To view this email as a web page, click the export button in the debugger.',
      'View web version is the label we need to rename.',
      'We should discuss viewing email as a web page at the technical review.',
    ]) expect(mailPreview({ bodyText })).toBe(bodyText)
  })

  test('does not use subscription footers or image-only alt as a made-up summary', () => {
    const footer = 'You are receiving this email because you subscribed to Bayview Sports.\nUnsubscribe\n123 Fictional Road, Example, CA 90000'
    expect(mailPreview({ preview: footer, bodyText: footer, bodyHtml: '<a href="https://example.test"><img alt=""></a><footer>' + footer + '</footer>' })).toBe('')
    expect(mailPreview({ bodyHtml: '<img alt="Logo"><img alt="Buy now"><footer>Privacy policy</footer>' })).toBe('')
    for (const footer of [
      "You're receiving this email because you've subscribed to service from Bayview Sports. 123 Fictional Road. If you do not wish to receive these emails, unsubscribe.",
      'You’re receiving this email because you’ve subscribed to service from Bayview Sports.',
      'You are receiving this email because you have subscribed to Bayview Sports.',
    ]) expect(mailPreview({ preview: footer, bodyText: footer, bodyHtml: `<img alt=""><p>${footer}</p>` })).toBe('')
    expect(mailPreview({ bodyHtml: '<p>Your ticket is ready.</p><p>Unsubscribe</p><p>123 Fictional Road, Example, CA 90000</p>' })).toBe('Your ticket is ready.')
  })

  test('preserves conversational text, short replies, security and transaction details', () => {
    for (const bodyText of [
      'Could you review the proposal before Friday? The notes are ready.', 'OK', 'Thanks!', '👍', 'はい',
      'Please unsubscribe me from the newsletter when you have a moment.',
      'The privacy policy needs your review before Friday.',
      'Privacy policy changes require your review.',
      'You are receiving this security alert because your password changed.',
      'Your order will ship to 123 Fictional Road tomorrow.',
    ]) expect(mailPreview({ bodyText })).toBe(bodyText)
    expect(mailPreview({ preview: 'Already useful provider text.', bodyHtml: '<p>Different complete body text.</p>' })).toBe('Already useful provider text.')
    expect(mailPreview({ bodyHtml: '<p><a href="https://example.test/reset">Reset your password</a> or <a href="https://example.test/support">contact our support team</a>.</p>' })).toBe('Reset your password or contact our support team.')
  })

  test('keeps meaningful link labels without Markdown or hrefs, even a single link', () => {
    const bodyText = '[Read the proposal](https://docs.example.test/proposal?tracking=fictional)\nThe revised budget is ready for your review.'
    const expected = 'Read the proposal The revised budget is ready for your review.'
    expect(mailPreview({ preview: bodyText, bodyText })).toBe(expected)
    expect(mailPreview({ preview: bodyText, bodyHtml: '<a href="https://docs.example.test/proposal?tracking=fictional">Read the proposal</a><p>The revised budget is ready for your review.</p>' })).toBe(expected)
    expect(mailPreview({ bodyText: '[Read the proposal](https://docs.example.test/proposal)' })).toBe('Read the proposal')
    expect(mailPreview({ bodyText: '[Read the proposal](https://track.example.test/truncated' })).toBe('Read the proposal')
    expect(mailPreview({ bodyText: '![Brand](https://track.example.test/logo)\n[WOMEN](https://example.test/w) | [MEN](https://example.test/m)\nThe new collection is here.' })).toBe('The new collection is here.')
  })

  test('preserves emoji joiners and multilingual words while removing inbox padding', () => {
    const bodyText = '👩🏽‍💻 The design review is ready. 明日の会議で確認しましょう。'
    expect(mailPreview({ bodyText, preview: bodyText })).toBe(bodyText)
    expect(mailPreview({ bodyText: 'می\u200cروم و क्\u200dष — مرحبًا بالعالم' })).toBe('می\u200cروم و क्\u200dष — مرحبًا بالعالم')
    expect(mailPreview({ bodyText: `${'\u200c\u00a0\u200b\u034f'.repeat(150)}A useful sentence.${'\u200d\u00a0'.repeat(150)}` })).toBe('A useful sentence.')
    expect(mailPreview({ bodyHtml: '<div class="preheader">Caf&eacute; &amp; tea&nbsp;for 明日.</div>' })).toBe('Café & tea for 明日.')
  })

  test('recognizes small hidden leading preheaders but not arbitrary hidden content', () => {
    for (const style of ['display:none', 'opacity:0', 'max-height:0px;overflow:hidden', 'mso-hide:all']) {
      expect(mailPreview({ bodyHtml: `<div style="${style}">The sender’s useful introduction.${'&nbsp;\u200c'.repeat(150)}</div><p>The visible body.</p>` })).toBe('The sender’s useful introduction.')
    }
    expect(mailPreview({ bodyHtml: '<head><title>Not a preheader</title><style>arbitrary CSS</style></head><script>not a preview</script><div aria-hidden="true">An accessible duplicate</div><p>The actual body.</p><div style="display:none">' + 'Hidden implementation detail. '.repeat(100) + '</div>' })).toBe('The actual body.')
    expect(mailPreview({ bodyHtml: '<div style="display:none"><a href="https://example.test">Hidden navigation</a></div><p>The visible content.</p>' })).toBe('The visible content.')
  })

  test('drops only clear leading exact subject duplicates with a useful remainder', () => {
    expect(mailPreview({ subject: 'Project update', bodyText: 'Project update\nThe revised plan is ready.' })).toBe('The revised plan is ready.')
    expect(mailPreview({ subject: 'Project update', bodyText: 'Project update — The revised plan is ready.' })).toBe('The revised plan is ready.')
    expect(mailPreview({ subject: 'Project update', bodyText: 'Project update' })).toBe('Project update')
    expect(mailPreview({ subject: 'Project update', bodyText: 'Project update is ready.' })).toBe('Project update is ready.')
    expect(mailPreview({ subject: 'Updated project', bodyText: 'Project update is ready.' })).toBe('Project update is ready.')
  })

  test('prefers paragraph boundaries and enforces UTF-16 safe caller limits', () => {
    expect(mailPreview({ bodyText: 'The short opening paragraph is complete.\n' + 'The following paragraph is longer. '.repeat(10) }, 60)).toBe('The short opening paragraph is complete.')
    const text = '👩🏽‍💻 明日の会議で確認しましょう。'.repeat(30)
    for (let limit = 0; limit <= 200; limit++) {
      const output = mailPreview({ bodyText: text }, limit)
      expect(output.length).toBeLessThanOrEqual(limit)
      expect(() => encodeURIComponent(output)).not.toThrow()
    }
    expect(mailPreview({ bodyText: 'Thanks' }, -5)).toBe('')
    expect(mailPreview({ bodyText: 'Thanks' }, 2.5)).toBe('Th')
    expect(() => encodeURIComponent(mailPreview({ bodyText: 'A'.repeat(16 * 1024 - 1) + '👩' }, 16 * 1024))).not.toThrow()
    expect(mailPreview({ bodyText: '\ud800Thanks\udc00' })).toBe('Thanks')
  })

  test('handles malformed, deeply nested and oversized inputs deterministically within bounded work', () => {
    const cases = [
      '<p>A useful opening.<div><a href="https://example.test">Read the details',
      '<div>'.repeat(20_000) + 'Unreachable deep text' + '</div>'.repeat(20_000),
      '<!--' + 'hidden'.repeat(200_000),
      '<div class="preheader">A useful introduction.</div>' + '<p>Extra text.</p>'.repeat(100_000),
      '<script>' + 'x'.repeat(2_000_000) + '</script><p>Outside the bounded input.</p>',
      '<div title="' + '['.repeat(500_000),
    ]
    const start = performance.now()
    for (const bodyHtml of cases) {
      const input = Object.freeze({ bodyHtml, preview: 'Safe provider fallback.' })
      const output = mailPreview(input)
      expect(output).toBe(mailPreview(input))
      expect(output.length).toBeLessThanOrEqual(200)
      expect(() => encodeURIComponent(output)).not.toThrow()
    }
    expect(mailPreview({ bodyText: '['.repeat(200_000) })).toBe('')
    expect(mailPreview({ bodyHtml: '<div class="preheader">A useful introduction.</div>' + '<p>Extra text.</p>'.repeat(100_000) })).toBe('A useful introduction.')
    // A coarse runaway guard, not an accuracy or user-visible latency claim.
    expect(performance.now() - start).toBeLessThan(2_000)
  })
})

const TEXT = 'Plain caf\u00e9, \u65e5\u672c\u8a9e and a literal <tag>.\nSecond line.'
const HTML = '<p>HTML caf\u00e9, <strong>\u65e5\u672c\u8a9e</strong></p><img src="cid:contract-inline">'
const BINARY = new Uint8Array([0, 255, 128, 13, 10, 1, 254, 42])
const FILE = 'r\u00e9sum\u00e9-\u65e5\u672c\u8a9e.bin'
const ZERO_FILE = 'empty.txt'
const PRIMARY = 'reader@example.test'
const SECONDARY = 'other@example.test'
const WRITER = 'writer@example.test'
const CAPABILITY_KEYS = [
  'sync', 'incrementalSync', 'deltaSync', 'send', 'reply', 'threads', 'nativeThreads', 'folders',
  'createFolders', 'labels', 'archive', 'trash', 'permanentDelete', 'markRead', 'markUnread', 'star',
  'attachments', 'attachmentDownload', 'search', 'drafts', 'scheduledSend', 'snooze', 'readReceipts', 'pushNotifications',
] as const

type BuiltIn = 'gmail' | 'outlook' | 'imap' | 'inbound'
type Wire = Record<string, any>
type Credentials = ProviderCredentials & Record<string, unknown>
type Fault = { status: number; body?: unknown; retryAfter?: string } | 'abort' | 'network' | 'json' | 'body' | 'hang'

interface MimePart {
  headers: Record<string, string>
  content: Buffer
  parts: MimePart[]
  type: string
  filename: string
}

interface ContractHarness {
  provider: InboxProvider
  other?: InboxProvider
  definition: ProviderDefinition
  credentials: Credentials
  email: string
  sender: string
  recipient: string
  recipientProvider: InboxProvider
  otherEmail?: string
  token: string
  scope: string
  ids: string[]
  rootId: string
  rootThread: string
  rootRfc: string
  expectedSender: string
  expectedReplyTo: string[]
  ownedMessages: boolean
  isolatedSnapshot: boolean
  fault?: (fault: Fault) => void
  entered?: () => Promise<void>
  writes?: () => number
  nativeArrival?: () => Promise<string>
  nativeRemove?: (id: string) => Promise<void>
  nativeUidReset?: () => void
  resources?: () => { locks: number; connections: number; transports: number }
  send: (input: SendInput) => Promise<SendResult>
  track: (message: MailMessage, provider?: InboxProvider) => void
  removeMessage: (provider: InboxProvider, id: string) => Promise<void>
  removeFolder?: (folder: ProviderFolder) => Promise<void>
  close: () => Promise<void>
}

interface ContractProfile {
  name: string
  live: boolean
  expected?: readonly (keyof ProviderCapabilities)[]
  harness: () => Promise<ContractHarness>
  capabilities: Readonly<ProviderCapabilities>
  ownedMessages: boolean
  isolatedSnapshot: boolean
  secondAccount: boolean
  nativeFailures: boolean
  nativeArrival: boolean
  cleanupFolders: boolean
}

async function failure(action: () => Promise<unknown>, code: string, retryable?: boolean): Promise<void> {
  let caught: unknown
  try { await action() } catch (error) { caught = error }
  expect(caught).toMatchObject({ code, ...(retryable === undefined ? {} : { retryable }) })
}

// This decoder is a native test peer, not the adapter's MIME implementation or expected-value generator.
function readMime(source: Buffer): MimePart {
  const raw = source.toString('utf8')
  const split = raw.search(/\r?\n\r?\n/)
  if (split < 0) throw new Error('Native peer received MIME without a header/body separator')
  const head = raw.slice(0, split).replace(/\r?\n[ \t]+/g, ' ')
  const body = raw.slice(split).replace(/^\r?\n\r?\n/, '')
  // RFC 2047 folding whitespace between adjacent encoded words is not message text.
  const decodeWord = (value: string) => value.replace(/(=\?[^?]+\?[bq]\?[^?]*\?=)[ \t]+(?==\?[^?]+\?[bq]\?)/gi, '$1')
    .replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_, charset, encoding, data) => {
    const bytes = encoding.toLowerCase() === 'b' ? Buffer.from(data, 'base64')
      : Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (_: string, hex: string) => String.fromCharCode(parseInt(hex, 16))), 'latin1')
    return new TextDecoder(charset).decode(bytes)
  })
  const headers: Record<string, string> = {}
  for (const line of head.split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon > 0) {
      const name = line.slice(0, colon).toLowerCase()
      let value = line.slice(colon + 1).trim()
      if (['from', 'to', 'cc', 'bcc', 'reply-to'].includes(name)) {
        value = value.replace(/((?:=\?[^?]+\?[bq]\?[^?]*\?=[ \t]*)+)(?=<)/gi, (_, phrase: string) =>
          `"${decodeWord(phrase.trim()).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" `)
      }
      headers[name] = decodeWord(value)
    }
  }
  const contentType = headers['content-type'] ?? 'text/plain'
  const type = contentType.split(';')[0]!.trim().toLowerCase()
  const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)
  const parts = boundary ? body.split(`--${boundary[1] ?? boundary[2]}`).slice(1)
    .filter((part) => !part.startsWith('--')).map((part) => readMime(Buffer.from(part.replace(/^\r?\n/, '').replace(/\r?\n$/, '')))) : []
  const encoding = headers['content-transfer-encoding']?.toLowerCase()
  const content = encoding === 'base64' ? Buffer.from(body, 'base64')
    : encoding === 'quoted-printable' ? Buffer.from(body.replace(/=\r?\n/g, '')
      .replace(/=([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))), 'latin1') : Buffer.from(body)
  const disposition = headers['content-disposition'] ?? ''
  const chunks = [...disposition.matchAll(/filename\*(\d+)\*?=(?:"([^"]*)"|([^;\s]*))/gi)]
    .sort((left, right) => Number(left[1]) - Number(right[1]))
  const extended = chunks.length ? chunks.map((part) => part[2] ?? part[3]).join('')
    : /filename\*=(?:"([^"]*)"|([^;\s]*))/i.exec(disposition)?.slice(1).find(Boolean)
  const plainFilename = /(?:^|;)\s*filename=(?:"([^"]*)"|([^;\s]+))/i.exec(disposition)
    ?? /(?:^|;)\s*name=(?:"([^"]*)"|([^;\s]+))/i.exec(contentType)
  const filename = extended ? decodeURIComponent(extended.replace(/^[^']*'[^']*'/, ''))
    : plainFilename?.[1] ?? plainFilename?.[2] ?? ''
  return { headers, content, parts, type, filename }
}

async function httpHarness(id: Exclude<BuiltIn, 'imap'>): Promise<ContractHarness> {
  const token = `inbox-contract-${crypto.randomUUID()}`
  const rootRfc = `<root-${token}@example.test>`
  const accounts = new Map<string, { email: string; messages: Map<string, Wire>; folders: Map<string, string>; changes: Wire[] }>()
  const pages = new Map<string, { account: string; ids: string[]; position: number; delta?: boolean }>()
  const attachments = new Map<string, Buffer>()
  let serial = 10
  let writeCount = 0
  let nextFault: Fault | undefined
  let enteredResolve: (() => void) | undefined
  let enteredPromise = Promise.resolve()
  const base = id === 'gmail' ? '/gmail/v1' : id === 'outlook' ? '/v1.0' : '/api/e2'
  const folderId = (role: string) => id === 'gmail'
    ? ({ inbox: 'INBOX', archive: 'ARCHIVE', trash: 'TRASH', sent: 'SENT', drafts: 'DRAFT', spam: 'SPAM' } as Record<string, string>)[role] ?? role
    : id === 'outlook' ? ({ inbox: 'f-inbox', archive: 'f-archive', trash: 'f-trash', sent: 'f-sent', drafts: 'f-drafts', spam: 'f-spam' } as Record<string, string>)[role] ?? role : role
  const graphRole = (value: string) => ({ inbox: 'inbox', archive: 'archive', sentitems: 'sent', deleteditems: 'trash', junkemail: 'spam', drafts: 'drafts' } as Record<string, string>)[value]
  const rawSeed = (account: string, suffix: string, subject: string, options: { thread?: string; folder?: string; mime?: MimePart; from?: string; to?: string[]; cc?: string[]; bcc?: string[] } = {}): Wire => {
    const email = accounts.get(account)!.email
    const nativeId = `${account}-${suffix}`
    const role = options.folder ?? 'inbox'
    const thread = options.thread ?? `${account}-thread`
    const mime = options.mime
    const headers = mime?.headers ?? {
      from: `"Writer, Ren\u00e9" <${WRITER}>`, to: email, cc: '', subject,
      'message-id': suffix === '1' ? rootRfc : `<${suffix}-${token}@example.test>`,
      ...(suffix === '2' ? { 'in-reply-to': rootRfc, references: rootRfc } : {}),
      'reply-to': `"Replies" <${WRITER}>`, 'x-inbox-contract': token,
    }
    const leaves = (part: MimePart): MimePart[] => part.parts.length ? part.parts.flatMap(leaves) : [part]
    const parsed = mime ? leaves(mime) : []
    const text = mime ? parsed.find((part) => part.type === 'text/plain' && !part.filename)?.content.toString('utf8') ?? '' : TEXT
    const html = mime ? parsed.find((part) => part.type === 'text/html' && !part.filename)?.content.toString('utf8') ?? '' : HTML
    const files = mime ? parsed.filter((part) => part.filename || part.headers['content-id']).map((part, index) => ({
      id: `a${index}`, filename: part.filename || 'inline.png', bytes: part.content, type: part.type,
      cid: part.headers['content-id']?.replace(/^<|>$/g, ''), inline: part.headers['content-disposition']?.startsWith('inline'),
    })) : [
      { id: 'binary', filename: FILE, bytes: Buffer.from(BINARY), type: 'application/octet-stream', cid: undefined, inline: false },
      { id: 'zero', filename: ZERO_FILE, bytes: Buffer.alloc(0), type: 'text/plain', cid: undefined, inline: false },
      { id: 'inline', filename: 'inline.png', bytes: Buffer.from(BINARY), type: 'image/png', cid: 'contract-inline', inline: true },
    ]
    for (const file of files) attachments.set(`${nativeId}/${file.id}`, file.bytes)
    const from = options.from ?? WRITER
    const to = options.to ?? [email]
    const cc = options.cc ?? []
    const bcc = options.bcc ?? []
    const when = new Date(Date.UTC(2026, 0, 1, 0, 0, Number(suffix) || serial)).toISOString()
    let message: Wire
    if (id === 'gmail') {
      const mimePart = (part: MimePart, partId: string): Wire => ({
        partId, mimeType: part.type, filename: part.filename,
        headers: Object.entries(part.headers).map(([name, value]) => ({ name, value })),
        body: { data: part.content.toString('base64url'), size: part.content.length },
        parts: part.parts.map((child, index) => mimePart(child, `${partId}.${index}`)),
      })
      message = { id: nativeId, threadId: thread, internalDate: String(Date.parse(when)),
        labelIds: role === 'archive' ? ['UNREAD'] : [folderId(role), 'UNREAD'],
        payload: mime ? mimePart(mime, '0') : { mimeType: 'multipart/mixed',
          headers: Object.entries(headers).map(([name, value]) => ({ name, value })), parts: [
            { mimeType: 'multipart/alternative', parts: [
              { partId: '0.0', mimeType: 'text/plain', body: { data: Buffer.from(text).toString('base64url') } },
              { partId: '0.1', mimeType: 'text/html', body: { data: Buffer.from(html).toString('base64url') } },
            ] }, ...files.map((file) => ({ partId: file.id, mimeType: file.type, filename: file.filename,
              headers: [{ name: 'Content-Disposition', value: file.inline ? 'inline' : 'attachment' },
                ...(file.cid ? [{ name: 'Content-ID', value: `<${file.cid}>` }] : [])],
              body: { size: file.bytes.length, ...(file.id === 'zero' ? { data: '' } : { attachmentId: file.id }) },
            })),
          ] },
      }
    } else if (id === 'outlook') {
      const recipients = (values: string[]) => values.map((address) => ({ emailAddress: { name: address, address } }))
      message = { id: nativeId, conversationId: thread, internetMessageId: headers['message-id'], parentFolderId: folderId(role),
        from: { emailAddress: { name: 'Writer, Ren\u00e9', address: from } }, toRecipients: recipients(to), ccRecipients: recipients(cc), bccRecipients: recipients(bcc),
        replyTo: recipients([WRITER]), internetMessageHeaders: Object.entries(headers).map(([name, value]) => ({ name, value })),
        subject, body: { contentType: 'html', content: html }, bodyPreview: 'A native preview', receivedDateTime: when,
        isRead: false, isDraft: false, flag: { flagStatus: 'notFlagged' }, categories: [], hasAttachments: true,
        attachments: files.map((file) => ({ id: file.id, name: file.filename, size: file.bytes.length, contentType: file.type,
          isInline: file.inline, ...(file.cid ? { contentId: file.cid } : {}) })),
      }
    } else {
      message = { id: nativeId, thread_id: thread, from_address: from, from_name: 'Writer, Ren\u00e9', to, cc, bcc,
        subject, text, html, received_at: when, type: role === 'sent' ? 'sent' : role === 'scheduled' ? 'scheduled' : 'received',
        is_read: false, is_archived: role === 'archive', headers, message_id: headers['message-id'],
        attachments: files.map((file) => ({ filename: file.filename, content_type: file.type, size: file.bytes.length,
          ...(file.inline ? { inline: true } : {}), ...(file.cid ? { content_id: file.cid } : {}) })),
      }
      for (const file of files) attachments.set(`${nativeId}/${file.filename}`, file.bytes)
    }
    accounts.get(account)!.messages.set(nativeId, message)
    accounts.get(account)!.changes.push(message)
    return message
  }
  for (const [account, email] of [['primary', PRIMARY], ['secondary', SECONDARY]]) {
    accounts.set(account!, { email: email!, messages: new Map(), folders: new Map([
      [folderId('inbox'), 'Inbox'], [folderId('archive'), 'Archive'], [folderId('trash'), 'Trash'], [folderId('sent'), 'Sent'],
    ]), changes: [] })
    for (let index = 1; index <= 3; index++) rawSeed(account!, String(index), `${index === 2 ? 'Re: ' : ''}${token}${account === 'secondary' ? ' secondary' : ''}${index === 3 ? ' separate' : ' \u65e5\u672c\u8a9e'}`, {
      thread: index === 3 ? `${account}-separate` : `${account}-thread`,
    })
    accounts.get(account!)!.changes = []
  }
  const json = (body: unknown, status = 200, headers?: HeadersInit) => Response.json(body, { status, headers })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const accountId = request.headers.get('authorization')?.replace('Bearer offline-', '') ?? ''
    const account = accounts.get(accountId)
    if (!account) return json({ error: { message: 'Invalid native credentials' } }, 401)
    const url = new URL(request.url)
    const path = decodeURIComponent(url.pathname.slice(base.length))
    const method = request.method
    const body: Wire = ['POST', 'PATCH'].includes(method) ? await request.json().catch(() => ({})) as Wire : {}
    if (method !== 'GET') writeCount++
    const gmailLabels = (message: Wire) => message.labelIds as string[]
    const subject = (message: Wire): string => id === 'gmail' ? message.payload.headers.find((item: Wire) => item.name.toLowerCase() === 'subject')?.value ?? '' : message.subject
    const belongs = (message: Wire, folder: string | undefined) => !folder || (id === 'gmail'
      ? folder === 'ARCHIVE' ? !gmailLabels(message).some((label) => ['INBOX', 'SENT', 'TRASH', 'SPAM', 'DRAFT'].includes(label)) : gmailLabels(message).includes(folder)
      : id === 'outlook' ? message.parentFolderId === folder : folder === 'archive' ? message.is_archived : folder === 'sent' ? message.type === 'sent' : !message.is_archived && message.type === 'received')
    const selection = (folder?: string): Wire[] => {
      const query = url.searchParams.get('q') ?? url.searchParams.get('$search')?.replace(/^"|"$/g, '') ?? url.searchParams.get('search') ?? ''
      const all = [...account.messages.values()].filter((message) => belongs(message, folder))
      return all.filter((message) => !query || query.startsWith('-in:') || subject(message).includes(query.replace(/is:unread/g, '').trim()))
        .filter((message) => !(query.includes('is:unread') || url.searchParams.get('status') === 'unread' || url.searchParams.get('$filter')?.includes('isRead eq false')) ||
          (id === 'gmail' ? gmailLabels(message).includes('UNREAD') : id === 'outlook' ? !message.isRead : !message.is_read))
        .sort((left, right) => String(right.internalDate ?? right.receivedDateTime ?? right.received_at).localeCompare(String(left.internalDate ?? left.receivedDateTime ?? left.received_at)))
    }
    const paged = (values: Wire[], size: number, delta = false) => {
      const previous = url.searchParams.get('pageToken') ?? url.searchParams.get('$skiptoken')
      let page = previous ? pages.get(previous) : undefined
      if (previous && (!page || page.account !== accountId)) return json({ error: { message: 'Invalid native page token' } }, 400)
      if (!page) page = { account: accountId, ids: values.map((message) => message.id), position: 0, delta }
      const slice = page.ids.slice(page.position, page.position + size).map((nativeId) => account.messages.get(nativeId)).filter(Boolean)
      const position = page.position + size
      const key = position < page.ids.length ? crypto.randomUUID() : null
      if (key) pages.set(key, { ...page, position })
      if (id === 'gmail') return json({ messages: slice.map((message) => ({ id: message!.id, threadId: message!.threadId })),
        resultSizeEstimate: page.ids.length, ...(key ? { nextPageToken: key } : {}) })
      const next = new URL(url)
      next.searchParams.set('$skiptoken', key ?? '')
      const deltaUrl = new URL(url)
      deltaUrl.search = '?$deltatoken=checkpoint'
      return json({ value: slice, ...(key ? { '@odata.nextLink': next.href } : delta ? { '@odata.deltaLink': deltaUrl.href } : {}) })
    }
    if (id === 'gmail') {
      if (path === '/users/me/profile') return json({ emailAddress: account.email, historyId: '100' })
      if (path === '/users/me/labels/INBOX' && method === 'GET') return json({ id: 'INBOX', messagesUnread: 3 })
      if (path === '/users/me/labels' && method === 'GET') return json({ labels: [...account.folders].map(([id, name]) => ({ id, name, type: /^[A-Z]+$/.test(id) ? 'system' : 'user' })) })
      if (path === '/users/me/labels' && method === 'POST') {
        const created = `label-${++serial}`; account.folders.set(created, body.name); return json({ id: created, name: body.name })
      }
      if (path.startsWith('/users/me/labels/') && method === 'DELETE') { account.folders.delete(path.split('/').at(-1)!); return new Response(null, { status: 204 }) }
      if (path === '/users/me/history') return json({ historyId: '101', history: account.changes.map((message) => ({ messages: [{ id: message.id }] })) })
      if (path === '/users/me/messages' && method === 'GET') return paged(selection(url.searchParams.get('labelIds') ?? (url.searchParams.get('q')?.startsWith('-in:') ? 'ARCHIVE' : undefined)), Number(url.searchParams.get('maxResults') ?? 50))
      if (path === '/users/me/threads') {
        const groups = [...new Set(selection(url.searchParams.get('labelIds') ?? undefined).map((message) => message.threadId))]
        const offset = Number(url.searchParams.get('pageToken') ?? 0)
        const limit = Number(url.searchParams.get('maxResults') ?? 50)
        return json({ threads: groups.slice(offset, offset + limit).map((id) => ({ id })), ...(offset + limit < groups.length ? { nextPageToken: String(offset + limit) } : {}) })
      }
      if (path.startsWith('/users/me/threads/')) {
        const threadId = path.split('/').at(-1)!; return json({ id: threadId, messages: [...account.messages.values()].filter((message) => message.threadId === threadId) })
      }
      if (path === '/users/me/messages/send' && method === 'POST') {
        const mime = readMime(Buffer.from(body.raw, 'base64url'))
        const sent = rawSeed(accountId, `sent-${++serial}`, mime.headers.subject!, { mime, folder: 'sent', thread: body.threadId })
        for (const [destination, target] of accounts) {
          if (![mime.headers.to, mime.headers.cc, mime.headers.bcc].some((list) => list?.includes(target.email))) continue
          const delivered = { ...mime, headers: { ...mime.headers } }; delete delivered.headers.bcc
          rawSeed(destination, `delivered-${serial}`, mime.headers.subject!, { mime: delivered, thread: body.threadId })
        }
        return json({ id: sent.id, threadId: sent.threadId })
      }
      const match = /^\/users\/me\/messages\/([^/]+)(?:\/(.*))?$/.exec(path)
      if (match) {
        const message = account.messages.get(match[1]!)
        if (!message) return json({ error: { message: 'Not found' } }, 404)
        if (match[2]?.startsWith('attachments/')) {
          const bytes = attachments.get(`${message.id}/${match[2].slice(12)}`)
          return bytes ? json({ data: bytes.toString('base64url'), size: bytes.length }) : json({ error: 'Missing attachment' }, 404)
        }
        if (method === 'DELETE') { account.messages.delete(message.id); return new Response(null, { status: 204 }) }
        if (method === 'POST') {
          if (match[2] === 'trash') message.labelIds = [...new Set([...message.labelIds.filter((label: string) => label !== 'INBOX'), 'TRASH'])]
          if (match[2] === 'modify') message.labelIds = [...new Set([...message.labelIds.filter((label: string) => !body.removeLabelIds?.includes(label)), ...(body.addLabelIds ?? [])])]
          account.changes.push(message)
        }
        return json(message)
      }
    } else if (id === 'outlook') {
      if (path === '/me') return json({ mail: account.email, displayName: 'Native account' })
      if (path === '/me/mailFolders/inbox') return json({ id: 'f-inbox', displayName: 'Inbox', unreadItemCount: 3 })
      if (path === '/me/mailFolders' && method === 'GET') return json({ value: [...account.folders].map(([id, displayName]) => ({ id, displayName })) })
      if (path === '/me/mailFolders' && method === 'POST') {
        const created = `folder-${++serial}`; account.folders.set(created, body.displayName); return json({ id: created, displayName: body.displayName }, 201)
      }
      if (/^\/me\/mailFolders\/[^/]+$/.test(path) && method === 'DELETE') { account.folders.delete(path.split('/').at(-1)!); return new Response(null, { status: 204 }) }
      const listing = /^\/me(?:\/mailFolders\/([^/]+))?\/messages(\/delta)?$/.exec(path)
      if (listing && method === 'GET') {
        const folder = listing[1] ? folderId(graphRole(listing[1]) ?? listing[1]) : undefined
        if (url.searchParams.has('$deltatoken')) return json({ value: account.changes, '@odata.deltaLink': url.href })
        const thread = /conversationId eq '([^']+)'/.exec(url.searchParams.get('$filter') ?? '')?.[1]
        const values = selection(folder).filter((message) => !thread || message.conversationId === thread)
        const preference = /odata.maxpagesize=(\d+)/.exec(request.headers.get('prefer') ?? '')?.[1]
        return paged(values, thread ? 1 : Number(preference ?? url.searchParams.get('$top') ?? 50), Boolean(listing[2]))
      }
      if (path === '/me/messages' && method === 'POST') {
        const created = rawSeed(accountId, `draft-${++serial}`, body.subject, { folder: 'drafts' })
        Object.assign(created, body, { isDraft: true }); return json(created, 201)
      }
      const match = /^\/me\/messages\/([^/]+)(?:\/(.*))?$/.exec(path)
      if (match) {
        const message = account.messages.get(match[1]!)
        if (!message) return json({ error: { code: 'ErrorItemNotFound', message: 'Not found' } }, 404)
        if (match[2] === 'attachments' && method === 'GET') return json({ value: message.attachments ?? [] })
        if (match[2]?.startsWith('attachments/')) {
          const attachmentId = match[2].split('/')[1]!
          const file = message.attachments?.find((file: Wire) => file.id === attachmentId)
          if (!file) return json({ error: 'Missing attachment' }, 404)
          return match[2].endsWith('/$value') ? new Response(new Uint8Array(attachments.get(`${message.id}/${attachmentId}`) ?? Buffer.from(file.contentBytes ?? '', 'base64')).buffer, { headers: { 'Content-Type': file.contentType } }) : json(file)
        }
        if (method === 'DELETE') { account.messages.delete(message.id); return new Response(null, { status: 204 }) }
        if (method === 'PATCH') { Object.assign(message, body); account.changes.push(message) }
        if (match[2] === 'move' && method === 'POST') {
          account.changes.push({ id: message.id, '@removed': { reason: 'deleted' } })
          message.parentFolderId = folderId(graphRole(body.destinationId) ?? body.destinationId)
          if (!request.headers.get('prefer')?.includes('IdType="ImmutableId"')) {
            account.messages.delete(message.id); message.id = `${accountId}-moved-${++serial}`; account.messages.set(message.id, message)
          }
        }
        if (match[2] === 'createReply' || match[2] === 'createReplyAll') {
          const reply = rawSeed(accountId, `draft-${++serial}`, `Re: ${message.subject}`, { folder: 'drafts', thread: message.conversationId })
          reply.internetMessageHeaders.push({ name: 'In-Reply-To', value: message.internetMessageId }, { name: 'References', value: message.internetMessageId })
          return json(reply, 201)
        }
        if (match[2] === 'send') {
          message.isDraft = false; message.parentFolderId = 'f-sent'
          for (const [destination, target] of accounts) {
            if (![...message.toRecipients, ...message.ccRecipients, ...message.bccRecipients].some((recipient: Wire) => recipient.emailAddress.address === target.email)) continue
            const delivered = structuredClone(message); delivered.id = `${destination}-delivered-${++serial}`; delivered.parentFolderId = 'f-inbox'; delivered.bccRecipients = []
            delivered.from = message.from ?? { emailAddress: { address: account.email, name: account.email } }
            for (const [index, attachment] of (delivered.attachments ?? []).entries()) {
              attachment.id ??= `sent-attachment-${index}`
              attachment.size = Buffer.from(attachment.contentBytes ?? '', 'base64').length
            }
            accounts.get(destination)!.messages.set(delivered.id, delivered)
          }
          return new Response(null, { status: 202 })
        }
        return json(message)
      }
    } else {
      if (path === '/emails' && method === 'GET') {
        const offset = Number(url.searchParams.get('offset') ?? 0); const limit = Number(url.searchParams.get('limit') ?? 50)
        const folder = url.searchParams.get('status') === 'archived' ? 'archive' : url.searchParams.get('type') === 'sent' ? 'sent' : undefined
        const values = selection(folder)
        return json({ data: values.slice(offset, offset + limit), pagination: { offset, limit, total: values.length, has_more: offset + limit < values.length } })
      }
      if (path === '/mail/threads') {
        const values = selection(); const groups = [...new Set(values.map((message) => message.thread_id))]
        const offset = Number(url.searchParams.get('cursor') ?? 0); const limit = Number(url.searchParams.get('limit') ?? 25)
        return json({ threads: groups.slice(offset, offset + limit).map((thread) => ({ id: thread, normalized_subject: values.find((message) => message.thread_id === thread)!.subject,
          message_count: values.filter((message) => message.thread_id === thread).length, last_message_at: '2026-01-01T00:00:03.000Z', has_unread: true, is_archived: false })),
          pagination: { has_more: offset + limit < groups.length, next_cursor: String(offset + limit) } })
      }
      if (path.startsWith('/mail/threads/')) {
        const thread = path.split('/').at(-1)!; const messages = [...account.messages.values()].filter((message) => message.thread_id === thread)
        return json({ messages, thread: { id: thread, message_count: messages.length, last_message_at: '2026-01-01T00:00:03.000Z' } })
      }
      if ((path === '/emails' || /^\/emails\/[^/]+\/reply$/.test(path)) && method === 'POST') {
        const original = path === '/emails' ? undefined : account.messages.get(path.split('/')[2]!)
        if (path !== '/emails' && !original) return json({ error: 'Reply parent not found' }, 404)
        const files = body.attachments ?? []
        if (!Array.isArray(files) || files.some((file: Wire) => !file || typeof file.filename !== 'string' || typeof file.content !== 'string')) {
          return json({ error: 'Native peer requires filename and base64 content for inline attachments' }, 400)
        }
        const fileContents = new Map<string, Buffer>(files.map((file: Wire) => [file.filename, Buffer.from(file.content, 'base64')]))
        const created = rawSeed(accountId, `sent-${++serial}`, body.subject, { from: account.email, to: body.to, cc: body.cc, bcc: body.bcc,
          folder: body.scheduled_at ? 'scheduled' : 'sent', thread: original?.thread_id })
        Object.assign(created, body, { text: body.text ?? '', html: body.html ?? '', attachments: files.map((file: Wire) => {
          const { content, ...metadata } = file
          return { ...metadata, size: fileContents.get(file.filename)!.length }
        }) })
        for (const [filename, content] of fileContents) attachments.set(`${created.id}/${filename}`, content)
        const sender = /^(.*?)\s*<([^>]+)>$/.exec(body.from)
        created.from_address = sender?.[2] ?? body.from; created.from_name = sender?.[1]?.replace(/^"|"$/g, '') ?? body.from
        if (original) created.headers = { ...created.headers, 'in-reply-to': original.message_id, references: original.message_id }
        for (const [destination, target] of accounts) {
          if (body.scheduled_at || ![...(body.to ?? []), ...(body.cc ?? []), ...(body.bcc ?? [])].some((recipient: unknown) =>
            typeof recipient === 'string' && (recipient.match(/<([^<>]+)>\s*$/)?.[1] ?? recipient).trim().toLowerCase() === target.email.toLowerCase())) continue
          const delivered = structuredClone(created); delivered.id = `${destination}-delivered-${serial}`; delivered.type = 'received'; delivered.bcc = []
          for (const [filename, content] of fileContents) attachments.set(`${delivered.id}/${filename}`, content)
          accounts.get(destination)!.messages.set(delivered.id, delivered)
        }
        return json({ id: created.id, message_id: `<submission-${serial}@example.test>`, ...(original ? { replied_to_thread_id: original.thread_id } : {}), ...(body.scheduled_at ? { scheduled_at: body.scheduled_at } : {}) })
      }
      const match = /^\/emails\/([^/]+)$/.exec(path)
      if (match) {
        const message = account.messages.get(match[1]!); if (!message) return json({ error: 'Not found' }, 404)
        if (method === 'DELETE') { account.messages.delete(message.id); return new Response(null, { status: 204 }) }
        if (method === 'PATCH') Object.assign(message, body)
        return json(message)
      }
      const file = /^\/attachments\/([^/]+)\/(.+)$/.exec(path)
      if (file && account.messages.has(file[1]!)) {
        const bytes = attachments.get(`${file[1]}/${file[2]}`)
        return bytes ? new Response(new Uint8Array(bytes).buffer) : json({ error: 'Missing attachment' }, 404)
      }
    }
    return json({ error: { message: `Native peer does not implement ${method} ${path}` } }, 404)
  } })
  const nativeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const fault = nextFault; nextFault = undefined
    if (fault === 'abort') throw new DOMException('Native request cancelled', 'AbortError')
    if (fault === 'network') throw new TypeError('Native socket closed')
    if (fault === 'json') return new Response('{', { headers: { 'Content-Type': 'application/json' } })
    if (fault === 'body') return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([123])); controller.error(new Error('Native body interrupted')) } }))
    if (fault === 'hang') {
      enteredResolve?.()
      return await new Promise<Response>((_, reject) => {
        if (init?.signal?.aborted) reject(init.signal.reason)
        else init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
      })
    }
    if (fault && typeof fault === 'object') return json(fault.body ?? { error: { message: 'Controlled native failure' } }, fault.status,
      fault.retryAfter ? { 'Retry-After': fault.retryAfter } : undefined)
    const target = new URL(url instanceof Request ? url.url : String(url))
    if (target.origin !== `http://127.0.0.1:${server.port}`) throw new Error('Offline native peer refused external network access')
    return fetch(url, init)
  }) as typeof fetch
  const definition = builtInProviders.find((provider) => provider.id === id)!
  const credentials: Credentials = { accountId: 'primary', email: PRIMARY, baseUrl: `http://127.0.0.1:${server.port}${base}`,
    fetch: nativeFetch, accessToken: 'offline-primary', apiKey: 'offline-primary', timeoutMs: 500 }
  const provider = await definition.create(credentials)
  const other = await definition.create({ ...credentials, accountId: 'secondary', email: SECONDARY, accessToken: 'offline-secondary', apiKey: 'offline-secondary' })
  return {
    provider, other, definition, credentials, email: PRIMARY, sender: PRIMARY, recipient: SECONDARY, recipientProvider: other, otherEmail: SECONDARY, token, scope: 'inbox',
    ids: ['primary-1', 'primary-2', 'primary-3'], rootId: 'primary-1', rootThread: 'primary-thread', rootRfc, expectedSender: WRITER, expectedReplyTo: [WRITER],
    ownedMessages: true, isolatedSnapshot: true,
    fault(fault) { nextFault = fault; enteredPromise = new Promise((resolve) => { enteredResolve = resolve }) },
    entered: () => enteredPromise, writes: () => writeCount,
    nativeArrival: async () => rawSeed('primary', String(++serial), `${token} arrival`, { thread: 'primary-arrival' }).id,
    nativeRemove: async (nativeId) => {
      const account = accounts.get('primary')!; const message = account.messages.get(nativeId)!
      if (id === 'gmail') { message.labelIds = ['UNREAD']; account.changes.push(message) }
      else if (id === 'outlook') { message.parentFolderId = 'f-archive'; account.changes.push({ id: nativeId, '@removed': { reason: 'deleted' } }) }
      else message.is_archived = true
    },
    send: (input) => provider.send(input), track() {},
    removeMessage: async (target, nativeId) => { accounts.get(target.accountId)!.messages.delete(nativeId) },
    removeFolder: async (folder) => { accounts.get('primary')!.folders.delete(folder.id) },
    close: async () => { await Promise.all([provider.disconnect(), other.disconnect()]); server.stop(true) },
  }
}

async function imapHarness(smtp: boolean): Promise<ContractHarness> {
  const token = `inbox-contract-${crypto.randomUUID()}`
  const rootRfc = `<root-${token}@example.test>`
  const accounts = new Map<string, Map<string, Map<number, Wire>>>()
  const changes = new Map<string, number>()
  const clients = new Set<NativeImap>()
  let uidValidity = 100n
  let modseq = 1n
  let serial = 10
  let writeCount = 0
  let locks = 0
  let transports = 0
  let nextFault: Fault | undefined
  let enteredResolve: (() => void) | undefined
  let enteredPromise = Promise.resolve()
  const seed = (account: string, path: string, uid: number, subject: string, options: Wire = {}) => {
    const text = options.text ?? TEXT
    const html = options.html ?? HTML
    const files: Wire[] = options.attachments ?? [
      { filename: FILE, content: Buffer.from(BINARY), contentType: 'application/octet-stream' },
      { filename: ZERO_FILE, content: Buffer.alloc(0), contentType: 'text/plain' },
      { filename: 'inline.png', content: Buffer.from(BINARY), contentType: 'image/png', cid: 'contract-inline', contentDisposition: 'inline' },
    ]
    const mailbox = accounts.get(account)!.get(path)!
    const recipient = (value: any) => {
      const values = Array.isArray(value) ? value : value ? [value] : []
      return values.map((item) => {
        if (typeof item !== 'string') return { name: item.name, address: item.address ?? item.email }
        const match = /^(.*?)\s*<([^>]+)>$/.exec(item)
        return { name: match?.[1]?.replace(/^"|"$/g, '') ?? item, address: match?.[2] ?? item }
      })
    }
    const parts = new Map<string, Buffer>([['1', Buffer.from(text)], ['2', Buffer.from(html)]])
    files.forEach((file, index) => parts.set(String(index + 3), Buffer.from(file.content)))
    const message: Wire = {
      uid, seq: uid, flags: new Set<string>(), internalDate: new Date(Date.UTC(2026, 0, 1, 0, 0, uid)),
      envelope: { subject, from: recipient(options.from ?? `"Writer, Ren\u00e9" <${WRITER}>`),
        to: recipient(options.to ?? account), cc: recipient(options.cc), bcc: recipient(options.bcc), replyTo: recipient(WRITER),
        messageId: options.messageId ?? (uid === 1 ? rootRfc : `<${uid}-${token}@example.test>`),
        ...(options.inReplyTo || uid === 2 ? { inReplyTo: options.inReplyTo ?? rootRfc } : {}),
      },
      bodyStructure: { type: 'multipart/mixed', childNodes: [
        { part: '1', type: 'text/plain', size: Buffer.byteLength(text), parameters: { charset: 'utf-8' } },
        { part: '2', type: 'text/html', size: Buffer.byteLength(html), parameters: { charset: 'utf-8' } },
        ...files.map((file, index) => ({ part: String(index + 3), type: file.contentType ?? 'application/octet-stream',
          size: Buffer.byteLength(file.content), disposition: file.contentDisposition ?? 'attachment',
          dispositionParameters: { filename: file.filename }, ...(file.cid ? { id: `<${file.cid}>` } : {}),
        })),
      ] },
      parts,
    }
    mailbox.set(uid, message)
    changes.set(`${account}:${path}:${uid}`, Number(++modseq))
    return message
  }
  for (const email of [PRIMARY, SECONDARY]) {
    accounts.set(email, new Map(['INBOX', 'Archive', 'Trash', 'Sent'].map((path) => [path, new Map()])))
    for (let uid = 1; uid <= 3; uid++) seed(email, 'INBOX', uid, `${uid === 2 ? 'Re: ' : ''}${token}${email === SECONDARY ? ' secondary' : ''}${uid === 3 ? ' separate' : ' \u65e5\u672c\u8a9e'}`,
      email === SECONDARY ? { messageId: `<secondary-${uid}-${token}@example.test>`, ...(uid === 2 ? { inReplyTo: `<secondary-1-${token}@example.test>` } : {}) } : {})
  }
  const rejectFault = () => {
    if (!nextFault || nextFault === 'body' || nextFault === 'hang') return
    const fault = nextFault; nextFault = undefined
    if (fault === 'abort') throw new DOMException('Native IMAP cancelled', 'AbortError')
    if (fault === 'network') throw Object.assign(new Error('Native socket closed'), { code: 'ECONNRESET' })
    if (typeof fault === 'object' && fault.status === 401) throw Object.assign(new Error('LOGIN rejected'), { authenticationFailed: true, code: 'EAUTH' })
    throw Object.assign(new Error('Native IMAP command rejected'), { code: 'NO' })
  }
  class NativeImap extends EventEmitter {
    usable = false
    mailbox: Wire | false = false
    constructor(readonly account: string) { super(); clients.add(this) }
    async connect() {
      rejectFault()
      if (nextFault === 'hang') {
        nextFault = undefined; enteredResolve?.()
        await new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('Connection timed out'), { code: 'ETIMEDOUT' })), 100))
      }
      this.usable = true
    }
    async logout() { this.close() }
    close() { this.usable = false; clients.delete(this); this.emit('close') }
    async status(path: string) { rejectFault(); return { unseen: [...accounts.get(this.account)!.get(path)!.values()].filter((item) => !item.flags.has('\\Seen')).length } }
    async list() {
      rejectFault()
      return [...accounts.get(this.account)!.entries()].map(([path, box]) => ({ path, name: path,
        ...({ INBOX: { specialUse: '\\Inbox' }, Archive: { specialUse: '\\Archive' }, Trash: { specialUse: '\\Trash' }, Sent: { specialUse: '\\Sent' } } as Wire)[path],
        status: { messages: box.size, unseen: box.size },
      }))
    }
    async mailboxCreate(path: string) {
      rejectFault(); writeCount++
      const exists = accounts.get(this.account)!.has(path)
      if (!exists) accounts.get(this.account)!.set(path, new Map())
      return { path, created: !exists }
    }
    async getMailboxLock(path: string) {
      rejectFault()
      if (!accounts.get(this.account)!.has(path)) throw new Error('Native mailbox missing')
      this.mailbox = { path, uidValidity, highestModseq: modseq, exists: accounts.get(this.account)!.get(path)!.size }
      locks++
      let released = false
      return { release() { if (!released) { locks--; released = true } } }
    }
    async search(query: Wire) {
      rejectFault()
      const messages = [...accounts.get(this.account)!.get(this.mailbox && this.mailbox.path)!.values()]
      return messages.filter((message) => {
        if (query.seen === false && message.flags.has('\\Seen')) return false
        if (query.flagged && !message.flags.has('\\Flagged')) return false
        if (query.text && !`${message.envelope.subject} ${message.parts.get('1').toString()}`.includes(query.text)) return false
        if (query.uid && message.uid < Number(query.uid.split(':')[0])) return false
        const matches = (header: Wire) => Object.entries(header).every(([key, value]) => key.toLowerCase() === 'message-id'
          ? message.envelope.messageId === value : message.envelope.inReplyTo === value)
        if (query.header && !matches(query.header)) return false
        if (query.or && !query.or.some((item: Wire) => matches(item.header))) return false
        return true
      }).map((message) => message.uid)
    }
    async fetchAll(uids: number[] | string, _query: Wire, options?: Wire) {
      rejectFault()
      const path = this.mailbox && this.mailbox.path
      const messages = [...accounts.get(this.account)!.get(path)!.values()]
      return messages.filter((message) => (typeof uids === 'string' || uids.includes(message.uid)) &&
        (!options?.changedSince || BigInt(changes.get(`${this.account}:${path}:${message.uid}`) ?? 0) > options.changedSince))
    }
    async fetchOne(uid: string) { rejectFault(); return accounts.get(this.account)!.get(this.mailbox && this.mailbox.path)!.get(Number(uid)) ?? false }
    async download(uid: string, part: string) {
      const message = await this.fetchOne(uid)
      if (!message) throw new Error('Native UID missing')
      const bytes = message.parts.get(part) as Buffer | undefined
      if (!bytes) throw new Error('Native MIME part missing')
      const broken = nextFault === 'body'; if (broken) nextFault = undefined
      const item = message.bodyStructure.childNodes.find((item: Wire) => item.part === part)
      return { meta: { charset: 'utf-8', contentType: item.type, filename: item.dispositionParameters?.filename },
        content: broken ? Readable.from((async function* () { yield bytes.subarray(0, 1); throw new Error('Native literal truncated') })()) : Readable.from([bytes]),
      }
    }
    async messageFlagsAdd(uid: string, flags: string[]) {
      writeCount++; const message = await this.fetchOne(uid); if (!message) return false
      flags.forEach((flag) => message.flags.add(flag)); changes.set(`${this.account}:${this.mailbox && this.mailbox.path}:${uid}`, Number(++modseq)); return true
    }
    async messageFlagsRemove(uid: string, flags: string[]) {
      writeCount++; const message = await this.fetchOne(uid); if (!message) return false
      flags.forEach((flag) => message.flags.delete(flag)); changes.set(`${this.account}:${this.mailbox && this.mailbox.path}:${uid}`, Number(++modseq)); return true
    }
    async messageDelete(uid: string) {
      writeCount++; const path = this.mailbox && this.mailbox.path
      accounts.get(this.account)!.get(path)!.delete(Number(uid)); this.emit('expunge', { path, uid: Number(uid), vanished: true }); return true
    }
    async messageMove(uid: string, destination: string) {
      const message = await this.fetchOne(uid); if (!message) return false
      await this.messageDelete(uid)
      const moved = ++serial
      accounts.get(this.account)!.get(destination)!.set(moved, { ...message, uid: moved })
      return { uidMap: new Map([[Number(uid), moved]]), uidValidity }
    }
  }
  const definition: ProviderDefinition = {
    ...builtInProviders.find((provider) => provider.id === 'imap')!,
    create: (credentials) => new ImapProvider(credentials as ImapCredentials, {
      createClient: (options) => new NativeImap(options.auth!.user) as unknown as ImapFlow,
      createTransport: () => {
        transports++
        let closed = false
        return {
          async sendMail(input: SMTPTransport.MailOptions) {
            rejectFault(); writeCount++
            const messageId = `<smtp-${++serial}-${token}@example.test>`
            const addresses = [input.to, input.cc, input.bcc].flatMap((value) => Array.isArray(value) ? value : [value])
              .map((value) => typeof value === 'string' ? /<([^>]+)>/.exec(value)?.[1] ?? value : value?.address)
            for (const email of [PRIMARY, SECONDARY]) {
              if (addresses.includes(email)) seed(email, 'INBOX', serial, input.subject ?? '', { ...input, bcc: [], messageId })
            }
            const accepted = addresses.filter((email): email is string => typeof email === 'string')
            const sender = Array.isArray(input.from) ? input.from[0] : input.from
            return {
              messageId, accepted, rejected: [], pending: [], response: '250 2.0.0 queued',
              envelope: { from: typeof sender === 'string' ? /<([^>]+)>/.exec(sender)?.[1] ?? sender : sender?.address ?? '', to: accepted },
            } satisfies SMTPTransport.SentMessageInfo
          },
          close() { if (!closed) { transports--; closed = true } },
        }
      },
    }),
  }
  const credentials: Credentials = { accountId: 'primary', email: PRIMARY, imap: { host: 'native-peer.invalid', user: PRIMARY, password: 'offline' },
    ...(smtp ? { smtp: { host: 'native-peer.invalid', user: PRIMARY, password: 'offline' } } : {}), timeoutMs: 200 }
  const provider = await definition.create(credentials)
  const other = await definition.create({ ...credentials, accountId: 'secondary', email: SECONDARY, imap: { host: 'native-peer.invalid', user: SECONDARY, password: 'offline' } })
  const remove = (target: InboxProvider, id: string) => {
    const [box, , uid] = id.split(':')
    accounts.get(target.accountId === 'primary' ? PRIMARY : SECONDARY)!.get(decodeURIComponent(box!))?.delete(Number(uid))
  }
  return {
    provider, other, definition, credentials, email: PRIMARY, sender: PRIMARY, recipient: SECONDARY, recipientProvider: other, otherEmail: SECONDARY, token, scope: 'inbox',
    ids: ['INBOX:100:1', 'INBOX:100:2', 'INBOX:100:3'], rootId: 'INBOX:100:1', rootThread: rootRfc, rootRfc, expectedSender: WRITER, expectedReplyTo: [WRITER],
    ownedMessages: true, isolatedSnapshot: true,
    fault(fault) { nextFault = fault; enteredPromise = new Promise((resolve) => { enteredResolve = resolve }) }, entered: () => enteredPromise,
    writes: () => writeCount,
    nativeArrival: async () => { const uid = ++serial; seed(PRIMARY, 'INBOX', uid, `${token} arrival`); return `INBOX:${uidValidity}:${uid}` },
    nativeRemove: async (id) => {
      const uid = Number(id.split(':')[2]); const message = accounts.get(PRIMARY)!.get('INBOX')!.get(uid)!
      accounts.get(PRIMARY)!.get('INBOX')!.delete(uid); accounts.get(PRIMARY)!.get('Archive')!.set(++serial, { ...message, uid: serial })
      for (const client of clients) if (client.account === PRIMARY && client.mailbox && client.mailbox.path === 'INBOX') client.emit('expunge', { path: 'INBOX', uid, vanished: true })
    },
    nativeUidReset: () => { uidValidity++ },
    resources: () => ({ locks, connections: [...clients].filter((client) => client.usable).length, transports }),
    send: (input) => provider.send(input), track() {},
    removeMessage: async (target, id) => { remove(target, id) },
    removeFolder: async (folder) => { accounts.get(PRIMARY)!.delete(folder.id) },
    close: async () => { await Promise.all([provider.disconnect(), other.disconnect()]); for (const client of clients) client.close() },
  }
}

function runProviderContract(profile: ContractProfile): void {
  describe(profile.name, () => {
    let h: ContractHarness
    const caps = profile.capabilities
    beforeAll(async () => { if (profile.live) h = await profile.harness() }, 180_000)
    beforeEach(async () => { if (!profile.live) h = await profile.harness() })
    afterEach(async () => { if (!profile.live && h) await h.close() })
    afterAll(async () => { if (profile.live && h) await h.close() }, 90_000)

    const delivered = async (subject: string, receiver = h.recipientProvider): Promise<MailMessage> => {
      const deadline = Date.now() + (profile.live ? 45_000 : 1_000)
      do {
        const page = await receiver.listMessages({ folder: 'inbox', limit: 100, ...(receiver.capabilities.search ? { search: subject } : {}) })
        const message = page.items.find((message) => message.subject === subject)
        if (message) { h.track(message, receiver); return receiver.getMessage(message.id) }
        await Bun.sleep(profile.live ? 1_000 : 10)
      } while (Date.now() < deadline)
      throw new Error('An owned message did not arrive before the bounded delivery deadline')
    }
    const unchanged = async (mutation: MessageMutation) => {
      const before = await h.provider.getMessage(h.rootId)
      const writes = h.writes?.()
      await failure(() => h.provider.mutate(h.rootId, mutation), 'UNSUPPORTED_OPERATION', false)
      expect(await h.provider.getMessage(h.rootId)).toEqual(before)
      if (h.writes) expect(h.writes()).toBe(writes!)
    }

    test('registration creates isolated authenticated account identities and honest capabilities', async () => {
      const account = await h.provider.getAccount()
      expect(account.id).toBe(h.provider.accountId)
      expect(account.email.toLowerCase()).toBe(h.email.toLowerCase())
      expect(account.provider).toBe(h.provider.type)
      expect(Number.isFinite(account.unreadCount) && account.unreadCount >= 0).toBe(true)
      for (const key of CAPABILITY_KEYS) expect(typeof h.provider.capabilities[key]).toBe('boolean')
      if (profile.expected) {
        const expected = Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, profile.expected!.includes(key)])) as Record<keyof ProviderCapabilities, boolean>
        expect(h.provider.capabilities).toEqual(expected)
      }
      if (!h.provider.capabilities.send) expect(h.provider.capabilities.reply).toBe(false)
      if (h.provider.capabilities.deltaSync) expect(h.provider.capabilities.incrementalSync).toBe(true)
      if (h.provider.capabilities.attachmentDownload) expect(h.provider.capabilities.attachments).toBe(true)
      if (h.other) {
        const other = await h.other.getAccount()
        expect(other.id).not.toBe(account.id)
        expect(other.email.toLowerCase()).toBe(h.otherEmail!.toLowerCase())
        expect(other.email.toLowerCase()).not.toBe(account.email.toLowerCase())
      }
    })

    test('bounded read and synchronization do not mutate native messages', async () => {
      const writes = h.writes?.()
      const page = await h.provider.listMessages({ folder: h.scope, limit: 1 })
      expect(page.items.length).toBeLessThanOrEqual(1)
      for (const message of page.items) {
        expect(message.accountId).toBe(h.provider.accountId)
        expect((await h.provider.getMessage(message.id)).id).toBe(message.id)
      }
      const sync = await h.provider.sync(null, { folder: h.scope, limit: 1 })
      expect(sync.messages.every((message) => message.accountId === h.provider.accountId)).toBe(true)
      expect(sync.fullSync).toBe(true)
      expect(sync.deletedMessageIds).toEqual([])
      if (h.writes) expect(h.writes()).toBe(writes!)
    })

    test('foreign-account send input is rejected before any submission or draft write', async () => {
      const writes = h.writes?.()
      await failure(() => h.send({ accountId: `${h.provider.accountId}-foreign`, from: h.sender, to: h.recipient,
        subject: `${h.token} foreign-account`, bodyText: TEXT }), 'AUTHORIZATION', false)
      if (h.writes) expect(h.writes()).toBe(writes!)
    })

    if (!caps.send) test('a read-only profile rejects send rather than pretending to submit mail', async () => {
      const writes = h.writes?.()
      await failure(() => h.send({ from: h.sender, to: h.recipient, subject: `${h.token} unsupported-send`, bodyText: TEXT }), 'UNSUPPORTED_OPERATION', false)
      if (h.writes) expect(h.writes()).toBe(writes!)
    })

    if (!caps.createFolders) test('unsupported folder creation has no native effect', async () => {
      const before = caps.folders ? await h.provider.listFolders() : undefined
      const writes = h.writes?.()
      await failure(() => h.provider.createFolder(`${h.token}-unsupported-folder`), 'UNSUPPORTED_OPERATION', false)
      if (before) expect(await h.provider.listFolders()).toEqual(before)
      if (h.writes) expect(h.writes()).toBe(writes!)
    })

    if (profile.ownedMessages) {
      test('native reads preserve MIME content, recipient privacy, dates and account ownership', async () => {
        const message = await h.provider.getMessage(h.rootId)
        expect(message.accountId).toBe(h.provider.accountId)
        expect(message.id).toBe(h.rootId)
        expect(message.from.email.toLowerCase()).toBe(h.expectedSender.toLowerCase())
        expect(message.to.map((participant) => participant.email.toLowerCase())).toContain(h.email.toLowerCase())
        expect(message.bodyText).toContain('caf\u00e9')
        expect(message.bodyText).toContain('\u65e5\u672c\u8a9e')
        expect(message.bodyHtml).toContain('cid:contract-inline')
        expect(message.subject).toContain(h.token)
        expect(message.receivedAt).toBe(new Date(message.receivedAt).toISOString())
        expect(Date.parse(message.receivedAt)).toBeGreaterThan(0)
        expect(message.folderIds?.length).toBeGreaterThan(0)
        if (caps.attachments) expect(message.attachments.map((attachment) => attachment.filename)).toContain(FILE)
      })

      test('reply metadata retains the RFC chain and custom correlation header', async () => {
        const root = await h.provider.getMessage(h.rootId)
        const reply = await h.provider.getMessage(h.ids[1]!)
        expect(root.rfcMessageId).toBe(h.rootRfc)
        expect(root.headers?.['x-inbox-contract']).toBe(h.token)
        expect((root.replyTo ?? []).map((participant) => participant.email)).toEqual(h.expectedReplyTo)
        expect(reply.inReplyTo).toBe(h.rootRfc)
        expect(reply.references).toContain(h.rootRfc)
      })

      test('attachments return exact binary bytes, Unicode filenames, empty files and inline CIDs', async () => {
        const message = await h.provider.getMessage(h.rootId)
        if (!caps.attachmentDownload) {
          await failure(() => h.provider.getAttachment(message.id, message.attachments[0]?.id ?? FILE), 'UNSUPPORTED_OPERATION')
          return
        }
        for (const [filename, bytes] of [[FILE, BINARY], [ZERO_FILE, new Uint8Array()], ['inline.png', BINARY]] as const) {
          const metadata = message.attachments.find((attachment) => attachment.filename === filename)
          expect(metadata).toBeDefined()
          const result = await h.provider.getAttachment(message.id, metadata!.id)
          expect(result.content).toBeInstanceOf(Uint8Array)
          expect([...result.content]).toEqual([...bytes])
          expect(result.filename).toBe(filename)
          expect(metadata!.size).toBe(bytes.length)
          if (filename === 'inline.png') {
            expect(metadata!.inline).toBe(true)
            expect(metadata!.contentId).toBe('contract-inline')
          }
        }
        await failure(() => h.provider.getAttachment(message.id, `${h.token}-missing-attachment`), 'NOT_FOUND', false)
      })

      test('search is scoped to the selected mailbox and returns complete hydrated messages', async () => {
        if (!caps.search) { await failure(() => h.provider.listMessages({ folder: h.scope, search: h.token }), 'UNSUPPORTED_OPERATION'); return }
        const page = await h.provider.listMessages({ folder: h.scope, search: h.token, limit: 100 })
        expect(page.items.map((message) => message.id)).toContain(h.rootId)
        expect(page.items.every((message) => message.subject.includes(h.token))).toBe(true)
        expect(page.items.every((message) => message.accountId === h.provider.accountId)).toBe(true)
        expect(page.items.find((message) => message.id === h.rootId)!.attachments.length).toBeGreaterThan(0)
        expect((await h.provider.listMessages({ folder: h.scope, search: `${h.token}-no-match` })).items).toEqual([])
      })

      for (const [capability, mutation, field, value] of [
        ['markRead', { isRead: true }, 'isRead', true], ['markUnread', { isRead: false }, 'isRead', false], ['star', { isStarred: true }, 'isStarred', true],
      ] as const) test(`${capability} is observable when supported and has no effect otherwise`, async () => {
        if (!caps[capability]) { await unchanged(mutation); return }
        const original = await h.provider.getMessage(h.rootId)
        if (capability === 'markUnread' && caps.markRead) await h.provider.mutate(original.id, { isRead: true })
        try {
          const updated = await h.provider.mutate(original.id, mutation)
          expect(updated?.[field]).toBe(value)
          expect((await h.provider.getMessage(updated!.id))[field]).toBe(value)
        } finally { await h.provider.mutate(original.id, { [field]: original[field] }) }
      })

      test('a mixed supported and unsupported mutation is validated before the first write', async () => {
        if (!caps.snooze) await unchanged({ isRead: true, snoozedUntil: '2099-01-01T00:00:00.000Z' })
        if (!caps.permanentDelete) await unchanged({ isRead: true, deletePermanently: true })
        if (!caps.labels) await unchanged({ isRead: true, addLabels: [`${h.token}-not-supported`] })
        if (!caps.scheduledSend) await unchanged({ isRead: true, folder: 'scheduled' })
      })

      if (caps.snooze) test('advertised native snooze changes and clears the actual message state', async () => {
        const until = new Date(Date.now() + 3_600_000).toISOString()
        try {
          await h.provider.mutate(h.rootId, { snoozedUntil: until })
          expect((await h.provider.getMessage(h.rootId)).snoozedUntil).toBe(until)
        } finally { await h.provider.mutate(h.rootId, { snoozedUntil: null }) }
        expect((await h.provider.getMessage(h.rootId)).snoozedUntil ?? null).toBeNull()
      })

      for (const [capability, folder] of [['archive', 'archive'], ['trash', 'trash']] as const) {
        test(`${capability} updates native membership and preserves a fetchable identity`, async () => {
          if (!caps[capability]) { await unchanged({ folder }); return }
          const index = h.ids.length - 1
          const original = await h.provider.getMessage(h.ids[index]!)
          let current = original.id
          try {
            const moved = await h.provider.mutate(current, { folder })
            expect(moved).not.toBeNull()
            current = moved!.id; h.ids[index] = current; h.track(moved!)
            const fetched = await h.provider.getMessage(current)
            expect(fetched.folder).toBe(folder)
            expect(fetched.subject).toBe(original.subject)
            if (h.provider.type === 'imap') { expect(current).not.toBe(original.id); await failure(() => h.provider.getMessage(original.id), 'NOT_FOUND') }
            if (h.provider.type === 'gmail' || h.provider.type === 'outlook') expect(current).toBe(original.id)
          } finally {
            const restored = await h.provider.mutate(current, { folder: h.scope })
            if (restored) { h.ids[index] = restored.id; h.track(restored) }
          }
        })
      }

      if (caps.createFolders && profile.cleanupFolders) test('custom native folders can be created, listed, selected and used as destinations', async () => {
        const name = `${h.token}-folder`
        const folder = await h.provider.createFolder(name)
        const index = h.ids.length - 1
        let current = h.ids[index]!
        try {
          expect(folder.name).toBe(name)
          expect((await h.provider.listFolders()).find((item) => item.id === folder.id)?.name).toBe(name)
          const moved = await h.provider.mutate(current, { folder: folder.id })
          expect(moved).not.toBeNull()
          current = moved!.id; h.ids[index] = current; h.track(moved!)
          expect((await h.provider.listMessages({ folder: folder.id })).items.map((message) => message.id)).toContain(current)
          expect((await h.provider.getMessage(current)).folderIds).toContain(folder.id)
        } finally {
          const restored = await h.provider.mutate(current, { folder: h.scope })
          if (restored) { h.ids[index] = restored.id; h.track(restored) }
          await h.removeFolder!(folder)
        }
      })

      test('native labels are independent of read state and removable without deleting mail', async () => {
        if (!caps.labels) { await unchanged({ isRead: true, addLabels: [h.token] }); return }
        let folder: ProviderFolder | undefined
        let label = h.token
        if (caps.createFolders && profile.cleanupFolders) {
          folder = await h.provider.createFolder(`${h.token}-label`)
          if (folder.kind === 'label') label = folder.id
        }
        const original = await h.provider.getMessage(h.rootId)
        try {
          const tagged = await h.provider.mutate(original.id, { addLabels: [label] })
          expect(tagged!.labels).toContain(label)
          expect(tagged!.isRead).toBe(original.isRead)
          expect((await h.provider.getMessage(tagged!.id)).labels).toContain(label)
          const untagged = await h.provider.mutate(tagged!.id, { removeLabels: [label] })
          expect(untagged!.labels).not.toContain(label)
          expect(untagged!.subject).toBe(original.subject)
        } finally {
          await h.provider.mutate(original.id, { removeLabels: [label] })
          if (folder) await h.removeFolder!(folder)
        }
      })

      test('thread reads include messages across native pages without duplicates', async () => {
        if (!caps.threads) { await failure(() => h.provider.getThread(h.rootThread), 'UNSUPPORTED_OPERATION'); return }
        const thread = await h.provider.getThread(h.rootThread)
        expect(thread.accountId).toBe(h.provider.accountId)
        expect(thread.messages.map((message) => message.id)).toEqual(expect.arrayContaining(h.ids.slice(0, 2)))
        expect(new Set(thread.messages.map((message) => message.id)).size).toBe(thread.messages.length)
        expect(thread.messageCount).toBe(thread.messages.length)
        expect(thread.messages.every((message) => message.threadId === thread.id)).toBe(true)
      })
    }

    if (profile.isolatedSnapshot) {
      test('list continuations are stable, complete, bounded and permit a changed page size', async () => {
        let cursor: string | null = null
        const ids: string[] = []
        for (let page = 0; page < 20; page++) {
          const result = await h.provider.listMessages({ folder: h.scope, cursor, limit: page ? 2 : 1 })
          expect(result.items.length).toBeLessThanOrEqual(page ? 2 : 1)
          ids.push(...result.items.map((message) => message.id))
          expect(Boolean(result.nextCursor)).toBe(result.hasMore)
          if (!result.hasMore) { cursor = null; break }
          expect(result.nextCursor).not.toBe(cursor)
          cursor = result.nextCursor
        }
        expect(cursor).toBeNull()
        expect(ids).toEqual(expect.arrayContaining(h.ids))
        expect(new Set(ids).size).toBe(ids.length)
      })

      for (const changed of ['folder', 'search', 'unreadOnly'] as const) test(`list cursors reject a changed ${changed} scope`, async () => {
        const first = await h.provider.listMessages({ folder: h.scope, limit: 1 })
        expect(first.nextCursor).not.toBeNull()
        const options = changed === 'folder' ? { folder: 'archive' } : changed === 'search' ? { search: `${h.token}-other` } : { unreadOnly: true }
        await failure(() => h.provider.listMessages({ folder: h.scope, cursor: first.nextCursor, limit: 1, ...options }), 'INVALID_CURSOR')
      })

      test('snapshot synchronization marks every continuation and only marks completion at the end', async () => {
        const ids: string[] = []
        let cursor: SyncCursor | null = null
        let finished = false
        for (let index = 0; index < 20; index++) {
          const page = await h.provider.sync(cursor, { folder: h.scope, limit: index ? 2 : 1 })
          expect(page.fullSync).toBe(true)
          expect(page.snapshotComplete).toBe(!page.hasMore)
          expect(page.deletedMessageIds).toEqual([])
          ids.push(...page.messages.map((message) => message.id))
          cursor = page.cursor
          if (!page.hasMore) { finished = true; break }
          expect(cursor).not.toBeNull()
        }
        expect(finished).toBe(true)
        expect(ids).toEqual(expect.arrayContaining(h.ids))
        expect(new Set(ids).size).toBe(ids.length)
        if (caps.incrementalSync) expect(cursor).not.toBeNull()
      })

      test('synchronization cursors cannot change folder or provider', async () => {
        const first = await h.provider.sync(null, { folder: h.scope, limit: 1 })
        expect(first.cursor).not.toBeNull()
        await failure(() => h.provider.sync(first.cursor, { folder: 'archive', limit: 1 }), 'INVALID_CURSOR')
        await failure(() => h.provider.sync({ ...first.cursor!, provider: 'a-different-registration' }, { folder: h.scope }), 'INVALID_CURSOR')
      })

      if (caps.threads) test('thread-list pagination does not split or duplicate a conversation across message pages', async () => {
        const threads: string[] = []
        let cursor: string | null = null
        let completed = false
        for (let index = 0; index < 20; index++) {
          const page = await h.provider.listThreads({ folder: h.scope, cursor, limit: 1 })
          threads.push(...page.items.map((thread) => thread.id))
          for (const thread of page.items) if (thread.id === h.rootThread) {
            expect(thread.messageCount).toBeGreaterThanOrEqual(2)
            expect(thread.messages.map((message) => message.id)).toEqual(expect.arrayContaining(h.ids.slice(0, 2)))
          }
          if (!page.hasMore) { completed = true; break }
          expect(page.nextCursor).not.toBe(cursor)
          cursor = page.nextCursor
        }
        expect(completed).toBe(true)
        expect(threads).toContain(h.rootThread)
        expect(new Set(threads).size).toBe(threads.length)
      })
    }

    if (profile.secondAccount && profile.ownedMessages) {
      test('message and attachment ownership follows the authenticated account, not copied identifiers', async () => {
        const first = await h.provider.getMessage(h.rootId)
        let observed: MailMessage | undefined
        try { observed = await h.other!.getMessage(first.id) } catch (error) { expect(error).toMatchObject({ code: 'NOT_FOUND' }) }
        if (observed) {
          expect(observed.accountId).toBe(h.other!.accountId)
          expect(observed.subject).not.toBe(first.subject)
          expect(observed.rfcMessageId).not.toBe(first.rfcMessageId)
        }
        const attachment = first.attachments[0]!
        if (!observed) await failure(() => h.other!.getAttachment(first.id, attachment.id), 'NOT_FOUND')
      })

      if (profile.isolatedSnapshot) for (const mode of ['list', 'sync'] as const) {
        test(`${mode} cursors belong to one account even under the same provider`, async () => {
          if (mode === 'list') {
            const listing = await h.provider.listMessages({ folder: h.scope, limit: 1 })
            expect(listing.nextCursor).not.toBeNull()
            await failure(() => h.other!.listMessages({ folder: h.scope, cursor: listing.nextCursor }), 'INVALID_CURSOR')
          } else {
            const syncing = await h.provider.sync(null, { folder: h.scope, limit: 1 })
            expect(syncing.cursor).not.toBeNull()
            await failure(() => h.other!.sync(syncing.cursor, { folder: h.scope }), 'INVALID_CURSOR')
          }
        })
      }
    }

    if (profile.nativeArrival && profile.isolatedSnapshot) test('new arrivals cannot displace or duplicate snapshot pages and remain visible to recent sync', async () => {
      const original = [...h.ids]
      const first = await h.provider.sync(null, { folder: h.scope, limit: 1 })
      const arrival = await h.nativeArrival!()
      const snapshotIds = first.messages.map((message) => message.id)
      let cursor = first.cursor
      let completed = false
      for (let page = 0; page < 20; page++) {
        const next = await h.provider.sync(cursor, { folder: h.scope, limit: 1 })
        expect(next.fullSync).toBe(true)
        snapshotIds.push(...next.messages.map((message) => message.id))
        cursor = next.cursor
        if (!next.hasMore) { completed = true; break }
      }
      expect(completed).toBe(true)
      expect([...snapshotIds].sort()).toEqual(original.sort())
      if (caps.incrementalSync) {
        const recent = await h.provider.sync(first.recentCursor ?? cursor, { folder: h.scope, limit: 100 })
        expect(recent.fullSync).toBe(false)
        expect(recent.messages.map((message) => message.id)).toContain(arrival)
      }
    })

    if (profile.nativeFailures) {
      for (const fault of ['abort', 'network', 'body'] as const) test(`native ${fault} failures have a normalized retryable error and release resources`, async () => {
        h.fault!(fault)
        await failure(() => h.provider.getMessage(h.rootId), 'NETWORK', true)
        if (h.resources) expect(h.resources().locks).toBe(0)
        expect((await h.provider.getMessage(h.rootId)).id).toBe(h.rootId)
      })

      test('disconnect cancels an outstanding request and leaves no lock or SMTP transport behind', async () => {
        h.fault!('hang')
        const pending = h.provider.getMessage(h.rootId)
        const checked = failure(() => pending, 'NETWORK', true)
        await h.entered!()
        const started = Date.now()
        await h.provider.disconnect()
        await checked
        expect(Date.now() - started).toBeLessThan(1_000)
        if (h.resources) expect(h.resources()).toEqual({ locks: 0, connections: 0, transports: 0 })
      }, 3_000)

      test('invalid native authentication does not degrade into a successful empty mailbox', async () => {
        h.fault!({ status: 401 })
        await failure(() => h.provider.getAccount(), 'AUTHENTICATION', false)
      })

      if (!profile.name.includes('imap')) {
        for (const [status, code, retryable] of [[403, 'AUTHORIZATION', false], [404, 'NOT_FOUND', false], [429, 'RATE_LIMITED', true], [503, 'UPSTREAM', true]] as const) {
          test(`HTTP ${status} preserves its provider error class and retry policy`, async () => {
            h.fault!({ status, retryAfter: '7' })
            let caught: any
            try { await h.provider.getMessage(h.rootId) } catch (error) { caught = error }
            expect(caught).toMatchObject({ code, status, retryable, retryAfter: 7 })
          })
        }
        test('malformed upstream JSON is not accepted as empty data', async () => {
          h.fault!('json')
          await failure(() => h.provider.getMessage(h.rootId), 'UPSTREAM', false)
        })
      }

      if (caps.incrementalSync) test('folder removals are not misreported as global deletions', async () => {
        const snapshot = await h.provider.sync(null, { folder: h.scope, limit: 100 })
        await h.nativeRemove!(h.rootId)
        const change = await h.provider.sync(snapshot.cursor, { folder: h.scope, limit: 100 })
        expect(change.removedMessageIds).toContain(h.rootId)
        expect(change.deletedMessageIds).not.toContain(h.rootId)
        expect(change.messages.map((message) => message.id)).not.toContain(h.rootId)
      })
    }

    if (caps.send && profile.ownedMessages) {
      test('send round-trips multipart text, HTML, Unicode names, zero bytes and inline attachments', async () => {
        const subject = `${h.token} MIME \u65e5\u672c\u8a9e`
        if (!caps.attachments) {
          const writes = h.writes?.()
          await failure(() => h.send({ from: h.sender, to: h.recipient, subject, bodyText: TEXT,
            attachments: [{ filename: FILE, content: BINARY }] }), 'UNSUPPORTED_OPERATION')
          if (h.writes) expect(h.writes()).toBe(writes!)
          return
        }
        const sent = await h.send({ accountId: h.provider.accountId, from: { name: 'Writer, Ren\u00e9', email: h.sender },
          to: { name: 'Reader, \u65e5\u672c\u8a9e', email: h.recipient }, subject, bodyText: TEXT, bodyHtml: HTML,
          headers: { 'X-Inbox-Contract': h.token }, attachments: [
            { filename: FILE, content: BINARY, contentType: 'application/octet-stream' },
            { filename: ZERO_FILE, content: new Uint8Array(), contentType: 'text/plain' },
            { filename: 'inline.png', content: BINARY, contentType: 'image/png', contentId: 'contract-inline', inline: true },
          ] })
        expect(typeof sent.id === 'string' && sent.id.length > 0).toBe(true)
        if (sent.providerMessageId) expect((await h.provider.getMessage(sent.providerMessageId)).id).toBe(sent.providerMessageId)
        const message = await delivered(subject)
        expect(message.from.email.toLowerCase()).toBe(h.sender.toLowerCase())
        expect(message.from.name).toBe('Writer, Ren\u00e9')
        expect(message.to).toEqual(expect.arrayContaining([{ name: 'Reader, \u65e5\u672c\u8a9e', email: h.recipient }]))
        expect(message.bodyText.trim()).toBe(TEXT)
        expect(message.bodyHtml).toContain('cid:contract-inline')
        expect(message.headers?.['x-inbox-contract']).toBe(h.token)
        for (const [filename, expected] of [[FILE, BINARY], [ZERO_FILE, new Uint8Array()], ['inline.png', BINARY]] as const) {
          const attachment = message.attachments.find((attachment) => attachment.filename === filename)
          expect(attachment).toBeDefined()
          const data = await h.recipientProvider.getAttachment(message.id, attachment!.id)
          expect([...data.content]).toEqual([...expected])
          if (filename === 'inline.png') expect(attachment!.contentId).toBe('contract-inline')
        }
      }, 60_000)

      if (profile.secondAccount) test('explicit To/CC/BCC envelopes reach the recipient without exposing BCC', async () => {
        const subject = `${h.token} recipient privacy`
        await h.send({ from: h.sender, to: h.otherEmail!, cc: h.email, bcc: h.email, subject,
          bodyText: TEXT, headers: { 'X-Inbox-Contract': h.token } })
        const received = await delivered(subject, h.other!)
        expect(received.to.map((participant) => participant.email)).toEqual([h.otherEmail!])
        expect(received.cc.map((participant) => participant.email)).toEqual([h.email])
        expect(received.bcc).toEqual([])
        expect(received.headers?.bcc).toBeUndefined()
      }, 60_000)

      test('reply targets the exact parent and preserves explicit recipients rather than expanding reply-all', async () => {
        const subject = `${h.token} explicit reply`
        if (!caps.reply) {
          await failure(() => h.send({ from: h.sender, to: h.recipient, subject, bodyText: TEXT, sourceMessageId: h.rootId,
            threadId: h.rootThread, inReplyTo: h.rootRfc }), 'UNSUPPORTED_OPERATION')
          return
        }
        await h.send({ from: h.sender, to: h.recipient, cc: [], bcc: [], subject, bodyText: TEXT,
          sourceMessageId: h.rootId, threadId: h.rootThread, inReplyTo: h.rootRfc, references: [h.rootRfc], replyAll: false,
          headers: { 'X-Inbox-Contract': h.token } })
        const received = await delivered(subject)
        expect(received.to.map((participant) => participant.email.toLowerCase())).toEqual([h.recipient.toLowerCase()])
        expect(received.cc).toEqual([])
        expect(received.bcc).toEqual([])
        expect(received.inReplyTo).toBe(h.rootRfc)
        expect(received.references).toContain(h.rootRfc)
      }, 60_000)

      test('native scheduling is either explicit and cancellable or rejected before submission', async () => {
        const subject = `${h.token} scheduled`
        const scheduledAt = new Date(Date.now() + 86_400_000).toISOString()
        const input: SendInput = { from: h.sender, to: h.recipient, subject, bodyText: TEXT, scheduledAt, headers: { 'X-Inbox-Contract': h.token } }
        if (!caps.scheduledSend) {
          const writes = h.writes?.()
          await failure(() => h.send(input), 'UNSUPPORTED_OPERATION', false)
          if (h.writes) expect(h.writes()).toBe(writes!)
          return
        }
        const sent = await h.send(input)
        try {
          expect(sent.scheduledAt).toBe(scheduledAt)
          expect((await h.recipientProvider.listMessages({ folder: 'inbox', search: subject })).items).toEqual([])
        } finally { await h.removeMessage(h.provider, sent.providerMessageId ?? sent.id) }
      })
    }

    if (profile.ownedMessages) test('permanent deletion is verified on an owned message or rejected without altering it', async () => {
      if (!caps.permanentDelete) { await unchanged({ isRead: true, deletePermanently: true }); return }
      const id = h.ids.at(-1)!
      expect(await h.provider.mutate(id, { deletePermanently: true })).toBeNull()
      await failure(() => h.provider.getMessage(id), 'NOT_FOUND')
      h.ids = h.ids.filter((item) => item !== id)
    })

    test('disconnect is idempotent and releases every provider-owned connection', async () => {
      await h.provider.getAccount()
      await h.provider.disconnect()
      await h.provider.disconnect()
      if (h.resources) expect(h.resources()).toEqual({ locks: 0, connections: 0, transports: 0 })
    })
  })
}

async function liveProfile(): Promise<ContractProfile> {
  const id = process.env.INBOX_TEST_PROVIDER
  if (!id) throw new Error('INBOX_TEST_LIVE=true requires INBOX_TEST_PROVIDER before any mail is sent')
  const parseCredentials = (value: string | undefined, variable: string): Record<string, unknown> => {
    try {
      const parsed: unknown = JSON.parse(value ?? '')
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
      return parsed as Record<string, unknown>
    } catch { throw new Error(`${variable} must contain a JSON credentials object; its value is deliberately not logged`) }
  }
  const first = parseCredentials(process.env.INBOX_TEST_CREDENTIALS, 'INBOX_TEST_CREDENTIALS')
  const secondValue = process.env.INBOX_TEST_SECOND_CREDENTIALS ?? process.env.SECOND_CREDENTIALS
  const second = secondValue ? parseCredentials(secondValue, 'INBOX_TEST_SECOND_CREDENTIALS') : undefined
  let definition = builtInProviders.find((provider) => provider.id === id)
  if (process.env.INBOX_TEST_PROVIDER_MODULE) {
    let candidate: unknown
    try { candidate = (await import(pathToFileURL(resolve(process.env.INBOX_TEST_PROVIDER_MODULE)).href)).default }
    catch { throw new Error('INBOX_TEST_PROVIDER_MODULE could not be loaded; it must default-export a ProviderDefinition') }
    if (!candidate || typeof candidate !== 'object' || (candidate as ProviderDefinition).id !== id ||
      typeof (candidate as ProviderDefinition).name !== 'string' || typeof (candidate as ProviderDefinition).create !== 'function') {
      throw new Error('The candidate module must default-export a ProviderDefinition with the requested id, name, and create factory')
    }
    definition = candidate as ProviderDefinition
  }
  if (!definition) throw new Error('INBOX_TEST_PROVIDER is not registered; supply INBOX_TEST_PROVIDER_MODULE for a new implementation')
  const registration = definition
  const token = `inbox-contract-${crypto.randomUUID()}`
  const credentials: Credentials = { ...first, accountId: typeof first.accountId === 'string' ? first.accountId : `${token}-primary` }
  const secondCredentials: Credentials | undefined = second
    ? { ...second, accountId: typeof second.accountId === 'string' ? second.accountId : `${token}-secondary` } : undefined
  let raw: InboxProvider
  let rawOther: InboxProvider | undefined
  let account: Awaited<ReturnType<InboxProvider['getAccount']>>
  let otherAccount: Awaited<ReturnType<InboxProvider['getAccount']>> | undefined
  try {
    raw = await registration.create(credentials)
    account = await raw.getAccount()
    if (!/^[^\s@<>]+@[^\s@<>]+$/.test(account.email)) throw new Error()
    if (secondCredentials) { rawOther = await registration.create(secondCredentials); otherAccount = await rawOther.getAccount() }
  } catch {
    await Promise.allSettled([raw!?.disconnect(), rawOther?.disconnect()])
    throw new Error('Live preflight failed while creating or authenticating the registered adapter; no test mail was sent and credentials are redacted')
  }
  const address = (value: string) => value.trim().toLowerCase()
  const primaryIdentities = [account.email, ...(account.aliases ?? [])].map(address)
  const secondaryIdentities = otherAccount ? [otherAccount.email, ...(otherAccount.aliases ?? [])].map(address) : []
  const sender = process.env.INBOX_TEST_SENDER ?? account.email
  const recipient = process.env.INBOX_TEST_RECIPIENT ?? account.email
  const invalid = !primaryIdentities.includes(address(sender)) ? 'INBOX_TEST_SENDER must be the account email or an adapter-verified alias'
    : !primaryIdentities.includes(address(recipient)) && !secondaryIdentities.includes(address(recipient))
      ? 'A different INBOX_TEST_RECIPIENT requires readable INBOX_TEST_SECOND_CREDENTIALS for that mailbox'
      : otherAccount && (primaryIdentities.some((identity) => secondaryIdentities.includes(identity)) || rawOther!.accountId === raw.accountId)
        ? 'Second-account isolation requires a different authenticated mailbox and accountId' : undefined
  if (invalid) { await Promise.allSettled([raw.disconnect(), rawOther?.disconnect()]); throw new Error(`${invalid}; no test mail was sent`) }
  const native = ['gmail', 'outlook', 'imap', 'inbound'].includes(raw.type)
  const cleanupFolders = native && raw.type !== 'inbound'
  const canCleanupMessages = native || raw.capabilities.permanentDelete || raw.capabilities.trash
  const ownedMessages = raw.capabilities.send && raw.capabilities.reply && canCleanupMessages
  const isolatedSnapshot = ownedMessages && raw.capabilities.createFolders && cleanupFolders
  const limitations: string[] = []
  if (!rawOther) limitations.push('two-account isolation and recipient privacy were not exercised')
  if (!ownedMessages) limitations.push('receive-only or unseedable profile: send/MIME/mutation workflows are unqualified')
  if (!isolatedSnapshot) limitations.push('no isolated native folder: complete live snapshot qualification is unavailable')
  if (raw.capabilities.createFolders && !cleanupFolders) limitations.push('folder creation lacks a safe native cleanup protocol')
  for (const key of ['drafts', 'readReceipts', 'pushNotifications'] as const) {
    if (raw.capabilities[key]) limitations.push(`${key} is advertised but cannot be exercised through InboxProvider`)
  }
  console.info(`[provider qualification] Live conformance opted in for ${id}. Controlled failures run against native peers, not live credentials.`)
  if (limitations.length) console.warn(`[provider qualification] INCOMPLETE: ${limitations.join('; ')}. This is not full provider qualification.`)

  const owned = new Map<InboxProvider, Set<string>>()
  const folders = new Map<string, { owner: InboxProvider; folder: ProviderFolder }>()
  const receipts = new Map<string, { owner: InboxProvider; scheduled: boolean; subject: string; nativeId?: string; observed: boolean }>()
  const configs = new Map<InboxProvider, Credentials>()
  const origins = new Map<InboxProvider, InboxProvider>()
  let attempts = 0
  let closed = false
  let h: ContractHarness
  const track = (message: MailMessage, target: InboxProvider) => {
    if (!message.subject.includes(token) || !primaryIdentities.includes(address(message.from.email))) {
      throw new Error('Live safety guard refused to claim a message without this run token and authorized sender')
    }
    owned.get(target)!.add(message.id)
    for (const receipt of receipts.values()) if (receipt.subject === message.subject) receipt.observed = true
  }
  const protect = (instance: InboxProvider, config: Credentials): InboxProvider => {
    let proxy: InboxProvider
    proxy = new Proxy(instance, {
      get(target, key) {
        if (key === 'createFolder') return async (name: string) => {
          if (!name.includes(token) || target.capabilities.createFolders && !cleanupFolders) throw new Error('Live safety guard requires an owned folder name and a cleanup protocol')
          const folder = await target.createFolder(name)
          folders.set(`${target.accountId}:${folder.id}`, { owner: proxy, folder })
          return folder
        }
        if (key === 'mutate') return async (id: string, mutation: MessageMutation) => {
          if (!owned.get(proxy)!.has(id)) throw new Error('Live safety guard refused to mutate an unowned message')
          const message = await target.mutate(id, mutation)
          if (message) track(message, proxy)
          return message
        }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    owned.set(proxy, new Set()); configs.set(proxy, config); origins.set(proxy, instance)
    return proxy
  }
  const provider = protect(raw, credentials)
  const other = rawOther ? protect(rawOther, secondCredentials!) : undefined
  const recipientProvider = primaryIdentities.includes(address(recipient)) ? provider : other!
  const nativeDelete = async (owner: InboxProvider, resource: 'message' | 'folder', nativeId: string) => {
    const config = configs.get(owner)!
    const defaults: Record<string, string> = {
      gmail: 'https://gmail.googleapis.com/gmail/v1', outlook: 'https://graph.microsoft.com/v1.0', inbound: 'https://inbound.new/api/e2',
    }
    const base = typeof config.baseUrl === 'string' ? config.baseUrl.replace(/\/$/, '') : defaults[owner.type]
    const path = owner.type === 'gmail' ? `/users/me/${resource === 'folder' ? 'labels' : 'messages'}/${encodeURIComponent(nativeId)}`
      : owner.type === 'outlook' ? `/me/${resource === 'folder' ? 'mailFolders' : 'messages'}/${encodeURIComponent(nativeId)}`
        : `/emails/${encodeURIComponent(nativeId)}`
    const response = await fetch(`${base}${path}`, { method: 'DELETE', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${owner.type === 'inbound' ? config.apiKey : config.accessToken}`, Prefer: 'IdType="ImmutableId"' } })
    if (!response.ok && response.status !== 404) throw new Error(`Native cleanup was rejected with HTTP ${response.status}`)
  }
  const removeMessage = async (owner: InboxProvider, nativeId: string, fresh?: InboxProvider) => {
    const receipt = receipts.get(`${owner.accountId}:${nativeId}`) ?? [...receipts.values()].find((receipt) => receipt.owner === owner && receipt.nativeId === nativeId)
    if (!owned.get(owner)!.has(nativeId) && (!receipt || receipt.owner !== owner)) throw new Error('Refused cleanup of an untracked message ID')
    const target = fresh ?? await registration.create(configs.get(owner)!)
    try {
      if (!(owner.type === 'inbound' && receipt?.scheduled)) {
        let message: MailMessage
        try { message = await target.getMessage(nativeId) } catch (error) {
          if ((error as { code?: string })?.code === 'NOT_FOUND') {
            owned.get(owner)!.delete(nativeId)
            if (receipt?.observed) receipts.delete(`${owner.accountId}:${nativeId}`)
            return
          }
          throw error
        }
        track(message, owner)
      }
      if (owner.type === 'inbound' || owner.type === 'outlook') await nativeDelete(owner, 'message', nativeId)
      else if (target.capabilities.permanentDelete) await target.mutate(nativeId, { deletePermanently: true })
      else if (target.capabilities.trash) await target.mutate(nativeId, { folder: 'trash' })
      else throw new Error('No safe native cleanup operation is available for this tracked receipt')
      owned.get(owner)!.delete(nativeId); receipts.delete(`${owner.accountId}:${nativeId}`)
    } finally { if (!fresh) await target.disconnect() }
  }
  const removeFolder = async (folder: ProviderFolder) => {
    const key = `${provider.accountId}:${folder.id}`
    const tracked = folders.get(key)
    if (!tracked || tracked.folder.name !== folder.name || !folder.name.includes(token)) throw new Error('Refused cleanup of an untracked folder ID')
    const fresh = await registration.create(credentials)
    try {
      if (folder.kind !== 'label' && (await fresh.listMessages({ folder: folder.id, limit: 1 })).items.length) {
        throw new Error('Refused to delete a nonempty native folder')
      }
      if (provider.type === 'imap') {
        const config = credentials as ImapCredentials
        const server = config.imap ?? { host: config.imapHost ?? config.host!, port: config.imapPort ?? config.port, secure: config.secure,
          user: config.user ?? config.username ?? config.email, password: config.password, accessToken: config.accessToken }
        const secure = server.secure ?? server.port !== 143
        const client = new ImapFlow({ host: server.host, port: server.port ?? (secure ? 993 : 143), secure,
          ...(secure ? {} : { doSTARTTLS: true }), logger: false, connectionTimeout: 10_000, socketTimeout: 10_000,
          auth: { user: server.user ?? server.username ?? account.email,
            ...(server.accessToken ? { accessToken: server.accessToken } : { pass: server.password ?? config.password }) },
          tls: { minVersion: 'TLSv1.2', ...server.tls, rejectUnauthorized: server.tls?.rejectUnauthorized ?? true } })
        try {
          await client.connect()
          const status = await client.status(folder.path ?? folder.id, { messages: true })
          if (status.messages !== 0) throw new Error('Refused to delete an IMAP mailbox containing messages')
          await client.mailboxDelete(folder.path ?? folder.id)
        } finally { if (client.usable) await client.logout(); else client.close() }
      } else await nativeDelete(provider, 'folder', folder.id)
      folders.delete(key)
    } finally { await fresh.disconnect() }
  }
  const send = async (input: SendInput): Promise<SendResult> => {
    if (++attempts > 12) throw new Error('Live conformance exhausted its 12-attempt send budget')
    if (!input.subject.includes(token)) throw new Error('Live safety guard requires the per-run subject token')
    const addresses = (value: SendInput['to'] | undefined) => (Array.isArray(value) ? value : value ? [value] : []).map((item) =>
      address(typeof item === 'string' ? /<([^>]+)>/.exec(item)?.[1] ?? item : item.email))
    const allowed = [...primaryIdentities, ...secondaryIdentities]
    if ([...addresses(input.to), ...addresses(input.cc), ...addresses(input.bcc)].some((email) => !allowed.includes(email))) {
      throw new Error('Live safety guard requires readable test recipients')
    }
    if (input.scheduledAt && !native && raw.capabilities.scheduledSend) throw new Error('Native scheduling cannot be exercised without a safe cancellation protocol')
    const result = await raw.send({ ...input, headers: { ...input.headers, 'X-Inbox-Contract': token } })
    receipts.set(`${provider.accountId}:${result.id}`, { owner: provider, scheduled: Boolean(input.scheduledAt),
      subject: input.subject, nativeId: result.providerMessageId, observed: false })
    if (result.providerMessageId) {
      try { track(await raw.getMessage(result.providerMessageId), provider) } catch { /* Eventual visibility is checked by the contract and cleanup discovery. */ }
    }
    return result
  }
  const find = async (subject: string): Promise<MailMessage> => {
    const deadline = Date.now() + 45_000
    do {
      const page = await provider.listMessages({ folder: 'inbox', search: provider.capabilities.search ? subject : undefined, limit: 100 })
      const message = page.items.find((message) => message.subject === subject)
      if (message) { track(message, provider); return provider.getMessage(message.id) }
      await Bun.sleep(1_000)
    } while (Date.now() < deadline)
    throw new Error('Live owned fixture did not arrive within 45 seconds')
  }
  const close = async () => {
    if (closed) return
    closed = true
    const problems: string[] = []
    for (const [owner, config] of configs) {
      let fresh: InboxProvider | undefined
      try {
        fresh = await registration.create(config)
        for (const scope of new Set([undefined, 'inbox', 'sent', 'scheduled', h?.scope])) {
          try {
            let cursor: string | null = null
            for (let page = 0; page < 3; page++) {
              const result = await fresh.listMessages({ folder: scope, search: fresh.capabilities.search ? token : undefined, limit: 100, cursor })
              for (const message of result.items) if (message.subject.includes(token) && primaryIdentities.includes(address(message.from.email))) track(message, owner)
              if (!result.hasMore) break
              cursor = result.nextCursor
            }
          } catch (error) {
            if (!['UNSUPPORTED_OPERATION', 'NOT_FOUND'].includes((error as { code?: string })?.code ?? '')) problems.push(`discovery:${owner.accountId}`)
          }
        }
        const submittedIds = [...receipts].filter(([, receipt]) => receipt.owner === owner).map(([key, receipt]) =>
          receipt.nativeId ?? (owner.type === 'inbound' && receipt.scheduled ? key.slice(owner.accountId.length + 1) : undefined))
          .filter((nativeId): nativeId is string => Boolean(nativeId))
        const ids = new Set([...owned.get(owner)!, ...submittedIds])
        for (const nativeId of ids) {
          try { await removeMessage(owner, nativeId, fresh) } catch { problems.push(`message:${nativeId}`) }
        }
      } catch { problems.push(`account:${owner.accountId}`) }
      finally { await fresh?.disconnect() }
    }
    for (const { folder } of [...folders.values()]) {
      try { await removeFolder(folder) } catch { problems.push(`folder:${folder.id}`) }
    }
    await Promise.allSettled([...origins.values()].map((instance) => instance.disconnect()))
    for (const [id, receipt] of receipts) if (!receipt.observed) problems.push(`unlocated-submission:${id}`)
    if (problems.length) throw new Error(`Cleanup incomplete for owned test resources only: ${[...new Set(problems)].join(', ')}`)
    console.info(`[provider qualification] Cleanup completed for tracked resources from ${token}; trash-only grants retain test messages in Trash.`)
  }
  return {
    name: `${id} live conformance${limitations.length ? ' (qualification incomplete)' : ''}`, live: true,
    capabilities: raw.capabilities, ownedMessages, isolatedSnapshot, secondAccount: Boolean(other), nativeFailures: false,
    nativeArrival: isolatedSnapshot, cleanupFolders,
    harness: async () => {
      h = { provider, other, definition: registration, credentials, email: account.email, sender, recipient, recipientProvider,
        otherEmail: otherAccount?.email, token, scope: 'inbox', ids: [], rootId: '', rootThread: '', rootRfc: '', expectedSender: sender,
        expectedReplyTo: [], ownedMessages, isolatedSnapshot, send, track: (message, target = provider) => track(message, target),
        removeMessage, ...(cleanupFolders ? { removeFolder } : {}), close }
      try {
        if (ownedMessages) {
          // Fixture mail goes only to the primary mailbox; delivery cases use INBOX_TEST_RECIPIENT.
          const subject = `${token} \u65e5\u672c\u8a9e`
          const sent = await send({ from: sender, to: account.email, subject, bodyText: TEXT, bodyHtml: HTML,
            attachments: raw.capabilities.attachments ? [
              { filename: FILE, content: BINARY, contentType: 'application/octet-stream' },
              { filename: ZERO_FILE, content: new Uint8Array(), contentType: 'text/plain' },
              { filename: 'inline.png', content: BINARY, contentType: 'image/png', contentId: 'contract-inline', inline: true },
            ] : [] })
          const root = await find(subject)
          h.rootId = root.id; h.rootThread = root.threadId; h.rootRfc = sent.messageId ?? root.rfcMessageId ?? ''
          if (!h.rootRfc) throw new Error('The provider did not expose an RFC message ID for the live reply fixture')
          const replySubject = `Re: ${subject}`
          await send({ from: sender, to: account.email, subject: replySubject, bodyText: TEXT, sourceMessageId: root.id,
            threadId: root.threadId, inReplyTo: h.rootRfc, references: [h.rootRfc], replyAll: false })
          const reply = await find(replySubject)
          await send({ from: sender, to: account.email, subject: `${token} separate`, bodyText: TEXT })
          const control = await find(`${token} separate`)
          h.ids = [root.id, reply.id, control.id]
          if (isolatedSnapshot) {
            const folder = await provider.createFolder(`${token}-snapshot`)
            h.scope = folder.id
            for (let index = 0; index < h.ids.length; index++) {
              const moved = await provider.mutate(h.ids[index]!, { folder: folder.id })
              if (!moved) throw new Error('Moving an owned fixture did not return its current native ID')
              h.ids[index] = moved.id
            }
            h.rootId = h.ids[0]!
            h.nativeArrival = async () => {
              const subject = `${token} arrival`
              await send({ from: sender, to: account.email, subject, bodyText: TEXT })
              const arrival = await find(subject)
              const moved = await provider.mutate(arrival.id, { folder: h.scope })
              if (!moved) throw new Error('The arrival fixture lost its native ID')
              return moved.id
            }
          }
        }
        return h
      } catch (error) {
        await close()
        throw new Error(`Live fixture setup failed after ${attempts} bounded send attempts; provider payloads are redacted. ${
          error instanceof Error && /^(Live owned|The provider|Moving an owned)/.test(error.message) ? error.message : 'See the failed provider contract.'}`)
      }
    },
  }
}

const advertised: Record<BuiltIn, readonly (keyof ProviderCapabilities)[]> = {
  gmail: ['sync', 'incrementalSync', 'deltaSync', 'send', 'reply', 'threads', 'nativeThreads', 'folders', 'createFolders', 'labels', 'archive', 'trash', 'markRead', 'markUnread', 'star', 'attachments', 'attachmentDownload', 'search'],
  outlook: ['sync', 'incrementalSync', 'deltaSync', 'send', 'reply', 'threads', 'nativeThreads', 'folders', 'createFolders', 'labels', 'archive', 'trash', 'markRead', 'markUnread', 'star', 'attachments', 'attachmentDownload', 'search'],
  imap: ['sync', 'incrementalSync', 'send', 'reply', 'threads', 'folders', 'createFolders', 'archive', 'trash', 'permanentDelete', 'markRead', 'markUnread', 'star', 'attachments', 'attachmentDownload', 'search'],
  inbound: ['sync', 'send', 'reply', 'threads', 'nativeThreads', 'archive', 'markRead', 'markUnread', 'attachments', 'attachmentDownload', 'search', 'scheduledSend'],
}
for (const id of ['gmail', 'outlook', 'imap', 'inbound'] as const) {
  const expected = advertised[id]
  runProviderContract({ name: `${id} deterministic native peer`, live: false, expected,
    capabilities: Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, expected.includes(key)])) as unknown as ProviderCapabilities,
    ownedMessages: true, isolatedSnapshot: true, secondAccount: true, nativeFailures: true, nativeArrival: true, cleanupFolders: id !== 'inbound',
    harness: () => id === 'imap' ? imapHarness(true) : httpHarness(id),
  })
}
const receiveOnly: readonly (keyof ProviderCapabilities)[] = advertised.imap.filter((key) => key !== 'send' && key !== 'reply')
runProviderContract({ name: 'imap receive-only deterministic native peer (not full send qualification)', live: false, expected: receiveOnly,
  capabilities: Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, receiveOnly.includes(key)])) as unknown as ProviderCapabilities,
  ownedMessages: true, isolatedSnapshot: true, secondAccount: true, nativeFailures: true, nativeArrival: true, cleanupFolders: true,
  harness: () => imapHarness(false),
})

describe('provider-specific native failures and effective grants', () => {
  for (const reason of ['rateLimitExceeded', 'userRateLimitExceeded']) test(`Gmail HTTP 403 ${reason} is retryable throttling, not revoked authorization`, async () => {
    const h = await httpHarness('gmail')
    try {
      h.fault!({ status: 403, retryAfter: '9', body: { error: { errors: [{ reason }], message: 'Quota exceeded' } } })
      let caught: any
      try { await h.provider.getMessage(h.rootId) } catch (error) { caught = error }
      expect(caught).toMatchObject({ code: 'RATE_LIMITED', status: 403, retryable: true, retryAfter: 9 })
    } finally { await h.close() }
  })

  test('Gmail permanent deletion requires the explicit full-mail grant and otherwise writes nothing', async () => {
    const h = await httpHarness('gmail')
    const full = await h.definition.create({ ...h.credentials, scopes: ['https://mail.google.com/'] })
    try {
      const writes = h.writes!()
      await failure(() => h.provider.mutate(h.rootId, { deletePermanently: true, isRead: true }), 'UNSUPPORTED_OPERATION')
      expect(h.writes!()).toBe(writes)
      expect((await h.provider.getMessage(h.rootId)).isRead).toBe(false)
      expect(full.capabilities.permanentDelete).toBe(true)
      expect(await full.mutate(h.rootId, { deletePermanently: true })).toBeNull()
      await failure(() => full.getMessage(h.rootId), 'NOT_FOUND')
    } finally { await full.disconnect(); await h.close() }
  })

  for (const id of ['gmail', 'outlook', 'imap'] as const) test(`${id} expired native checkpoints restart an explicitly marked snapshot`, async () => {
    const h = id === 'imap' ? await imapHarness(true) : await httpHarness(id)
    try {
      const initial = await h.provider.sync(null, { folder: 'inbox', limit: 100 })
      if (id === 'imap') h.nativeUidReset!()
      else h.fault!({ status: id === 'gmail' ? 404 : 410 })
      const reset = await h.provider.sync(initial.cursor, { folder: 'inbox', limit: 1 })
      expect(reset.fullSync).toBe(true)
      expect(reset.snapshotComplete).toBe(false)
      expect(reset.deletedMessageIds).toEqual([])
      expect(reset.messages).toHaveLength(1)
    } finally { await h.close() }
  })

  for (const id of ['outlook', 'inbound'] as const) test(`${id} binary attachment stream failures remain normalized`, async () => {
    const h = await httpHarness(id)
    const fetcher = h.credentials.fetch!
    const broken = (async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(url instanceof Request ? url.url : String(url)).pathname
      if (path.endsWith('/$value') || id === 'inbound' && path.includes('/attachments/')) {
        return new Response(new ReadableStream({ start(controller) { controller.error(new Error('Interrupted native bytes')) } }))
      }
      return fetcher(url, init)
    }) as typeof fetch
    const provider = await h.definition.create({ ...h.credentials, fetch: broken })
    try {
      const message = await provider.getMessage(h.rootId)
      await failure(() => provider.getAttachment(message.id, message.attachments[0]!.id), 'NETWORK', true)
    } finally { await provider.disconnect(); await h.close() }
  })

  for (const id of ['gmail', 'outlook'] as const) test(`${id} refresh uses explicit credentials, preserves rotation and honors abort`, async () => {
    const { refreshOAuthCredentials } = await import('../server/credential-refresh')
    const refresh = (credentials: Record<string, unknown>, signal: AbortSignal) => refreshOAuthCredentials(id, credentials, signal)
    let calls = 0
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls++
      if (init?.signal?.aborted) throw init.signal.reason
      const form = new URLSearchParams(String(init?.body))
      expect(form.get('refresh_token')).toBe('old-refresh')
      expect(form.get('client_id')).toBe('explicit-client')
      return Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3_600 })
    }) as typeof fetch
    const before = Date.now()
    const refreshed = await refresh({ refreshToken: 'old-refresh', clientId: 'explicit-client', fetch: fetcher }, new AbortController().signal)
    expect(refreshed).toMatchObject({ accessToken: 'new-access', refreshToken: 'new-refresh' })
    expect(Date.parse(String(refreshed.expiresAt))).toBeGreaterThan(before + 3_590_000)
    await failure(() => refresh({ clientId: 'explicit-client', fetch: fetcher }, new AbortController().signal), 'CREDENTIALS_UNAVAILABLE', true)
    expect(calls).toBe(1)
    await failure(() => refresh({ refreshToken: 'old-refresh', clientId: 'explicit-client', fetch: fetcher }, AbortSignal.abort()), 'NETWORK', true)
  })
})

if (process.env.INBOX_TEST_LIVE === 'true') {
  runProviderContract(await liveProfile())
} else if (process.env.INBOX_TEST_LIVE && process.env.INBOX_TEST_LIVE !== 'false') {
  throw new Error('INBOX_TEST_LIVE must be exactly true to authorize real-mail tests; no live calls were made')
} else {
  console.info('[provider qualification] UNQUALIFIED: live mail was not run. These are deterministic native-peer checks, not full provider compatibility. Opt in with INBOX_TEST_LIVE=true, INBOX_TEST_PROVIDER, and INBOX_TEST_CREDENTIALS; a second readable account is required for full isolation qualification.')
}

describe('credential capabilities and source discovery', () => {
  test('Gmail explicit read-only scopes retain reads and reject every write before fetch', async () => {
    const nonce = crypto.randomUUID()
    const definition = builtInProviders.find((provider) => provider.id === 'gmail')!
    const calls: string[] = []
    const native = { id: `message-${nonce}`, threadId: `thread-${nonce}`, internalDate: '1767225600000',
      labelIds: ['INBOX', 'UNREAD'], payload: { headers: [{ name: 'Subject', value: nonce }] } }
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      expect(url.origin).toBe('https://gmail.invalid')
      expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${nonce}`)
      calls.push(`${init?.method ?? 'GET'} ${url.pathname}`)
      expect(init?.method ?? 'GET').toBe('GET')
      if (url.pathname.endsWith('/profile')) return Response.json({ emailAddress: PRIMARY })
      if (url.pathname.endsWith('/labels/INBOX')) return Response.json({ messagesUnread: 1 })
      if (url.pathname.endsWith(`/messages/${native.id}`)) return Response.json(native)
      throw new Error('Unexpected read-only native request')
    }) as typeof fetch
    const provider = await definition.create({ accountId: nonce, accessToken: nonce, fetch: fetcher,
      baseUrl: 'https://gmail.invalid/gmail/v1', scopes: ['https://www.googleapis.com/auth/gmail.readonly'] })
    try {
      const supported: readonly (keyof ProviderCapabilities)[] = [
        'sync', 'incrementalSync', 'deltaSync', 'threads', 'nativeThreads', 'folders', 'attachments', 'attachmentDownload', 'search',
      ]
      expect(provider.capabilities).toEqual(Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, supported.includes(key)])) as Record<keyof ProviderCapabilities, boolean>)
      expect(await provider.getAccount()).toMatchObject({ id: nonce, email: PRIMARY })
      const before = await provider.getMessage(native.id)
      const reads = calls.length
      for (const mutation of [
        { isRead: true }, { isRead: false }, { isStarred: true }, { isArchived: true },
        { folder: 'trash' }, { folder: `label-${nonce}` }, { addLabels: [nonce] }, { removeLabels: [nonce] },
        { deletePermanently: true }, { folder: 'trash', isRead: true, snoozedUntil: null },
      ] satisfies MessageMutation[]) {
        await failure(() => provider.mutate(native.id, mutation), 'UNSUPPORTED_OPERATION', false)
      }
      await failure(() => provider.send({ from: PRIMARY, to: SECONDARY, subject: nonce, bodyText: nonce }), 'UNSUPPORTED_OPERATION', false)
      await failure(() => provider.createFolder(nonce), 'UNSUPPORTED_OPERATION', false)
      expect(calls).toHaveLength(reads)
      expect(await provider.getMessage(native.id)).toEqual(before)
    } finally { await provider.disconnect() }
  })

  test('Gmail capability negotiation distinguishes explicit grants from legacy-unknown manual scopes', async () => {
    const definition = builtInProviders.find((provider) => provider.id === 'gmail')!
    const nonce = crypto.randomUUID()
    let calls = 0
    const fetcher = Object.assign(async () => { calls++; throw new Error('Grant negotiation must not call Google') }, {
      preconnect: () => { calls++; throw new Error('Grant negotiation must not call Google') },
    }) as typeof fetch
    for (const [scopes, read, modify, send, permanentDelete, createFolders] of [
      [undefined, true, true, true, false, true],
      [[], false, false, false, false, false],
      [['https://www.googleapis.com/auth/gmail.modify'], true, true, true, false, true],
      [['https://mail.google.com/'], true, true, true, true, true],
      [['https://www.googleapis.com/auth/gmail.send'], false, false, true, false, false],
      [['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'], true, false, true, false, false],
      [['https://www.googleapis.com/auth/gmail.labels'], false, false, false, false, true],
    ] as const) {
      const provider = await definition.create({ accountId: nonce, accessToken: nonce,
        scopes: scopes === undefined ? undefined : [...scopes], fetch: fetcher })
      try {
        expect(provider.capabilities).toMatchObject({ sync: read, incrementalSync: read, deltaSync: read,
          threads: read, nativeThreads: read, attachments: read, attachmentDownload: read, search: read,
          send, reply: send, createFolders, labels: modify, archive: modify, trash: modify,
          markRead: modify, markUnread: modify, star: modify, permanentDelete })
      } finally { await provider.disconnect() }
    }
    expect(calls).toBe(0)
  })

  test('Inbound key-only discovery validates credentials without inventing a primary email or aliases', async () => {
    const definition = builtInProviders.find((provider) => provider.id === 'inbound')!
    const nonce = crypto.randomUUID()
    const domain = `${nonce}.example.test`
    const sender = `support@${domain}`
    const calls: URL[] = []
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      expect(url.origin).toBe('https://inbound.invalid')
      expect(init?.method ?? 'GET').toBe('GET')
      calls.push(url)
      if (new Headers(init?.headers).get('Authorization') !== `Bearer ${nonce}`) {
        return Response.json({ error: 'Revoked API key' }, { status: 401 })
      }
      if (url.pathname.endsWith('/domains')) return Response.json({
        data: [{ id: nonce, domain, status: 'verified', canReceiveEmails: true }],
        pagination: { hasMore: false, offset: 0, limit: 100, total: 1 },
      })
      if (url.pathname.endsWith('/email-addresses')) return Response.json({
        data: [
          { address: sender, domainId: nonce, isActive: true, isReceiptRuleConfigured: true },
          { address: `inactive@${domain}`, domainId: nonce, isActive: false, isReceiptRuleConfigured: true },
          { address: `foreign@other.example.test`, domainId: nonce, isActive: true, isReceiptRuleConfigured: true },
        ], pagination: { hasMore: false, offset: 0, limit: 100, total: 3 },
      })
      if (url.pathname.endsWith('/emails')) return Response.json({
        data: [], pagination: { has_more: false, offset: 0, limit: 1, total: 0 },
      })
      throw new Error('Unexpected Inbound discovery request')
    }) as typeof fetch
    const credentials = { accountId: nonce, apiKey: nonce, baseUrl: 'https://inbound.invalid/api/e2', fetch: fetcher }
    const provider = await definition.create(credentials)
    const selected = await definition.create({ ...credentials, email: PRIMARY })
    const revoked = await definition.create({ ...credentials, apiKey: `revoked-${nonce}` })
    try {
      expect(definition.mailboxSelection).toBe('manual')
      const account = await provider.getAccount()
      expect(account).toMatchObject({ id: nonce, name: 'Inbound', email: '' })
      expect(account.aliases).toBeUndefined()
      expect(calls.map((url) => url.pathname)).toEqual(['/api/e2/domains', '/api/e2/email-addresses', '/api/e2/emails'])
      expect(calls.at(-1)!.searchParams.has('address')).toBe(false)
      const discovered = await definition.discover!(provider)
      expect(discovered.sources.find((source) => source.kind === 'domain')).toMatchObject({ value: domain, canReceive: true, canSend: true, canFilter: true })
      expect(discovered.sources.find((source) => source.value === sender)).toMatchObject({ canReceive: true, canSend: true, canFilter: false, unavailableReason: expect.any(String) })
      expect(discovered.identities).toEqual([{ email: sender }])
      expect(calls).toHaveLength(3)
      expect(await selected.getAccount()).toMatchObject({ email: PRIMARY })
      expect(calls).toHaveLength(4)
      expect(calls.at(-1)!.searchParams.get('address')).toBe(PRIMARY)
      await failure(() => revoked.getAccount(), 'AUTHENTICATION', false)
      expect(calls.at(-1)!.pathname).toBe('/api/e2/domains')
    } finally { await Promise.all([provider.disconnect(), selected.disconnect(), revoked.disconnect()]) }
  })

  test('Inbound connection cursors expire when refreshed receiving source grants change', async () => {
    const definition = builtInProviders.find((provider) => provider.id === 'inbound')!
    const nonce = crypto.randomUUID()
    const domain = `${nonce}.example.test`
    let canReceive = true
    let emailPages = 0
    const native = { id: nonce, type: 'received', received_at: '2026-01-01T00:00:00.000Z',
      to: [PRIMARY], envelope_recipient: `support@${domain}` }
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      expect(url.origin).toBe('https://inbound.invalid')
      expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${nonce}`)
      expect(init?.method ?? 'GET').toBe('GET')
      if (url.pathname.endsWith('/domains')) return Response.json({ data: [
        { id: nonce, domain, status: 'verified', canReceiveEmails: canReceive },
        { id: `blocked-${nonce}`, domain: `blocked.${domain}`, status: 'verified', canReceiveEmails: false },
      ], pagination: { hasMore: false, offset: 0, limit: 100, total: 2 }, capabilities: { envelopeRecipients: true } })
      if (url.pathname.endsWith('/email-addresses')) return Response.json({
        data: [], pagination: { hasMore: false, offset: 0, limit: 100, total: 0 },
      })
      if (url.pathname.endsWith('/emails')) {
        expect(url.searchParams.get('domain')).toBe(domain)
        emailPages++
        return Response.json({ data: [native], pagination: { has_more: true, offset: 0, limit: 1, total: 2 } })
      }
      if (url.pathname.endsWith(`/emails/${nonce}`)) return Response.json(native)
      throw new Error('Unexpected Inbound connection request')
    }) as typeof fetch
    const credentials = { accountId: nonce, apiKey: nonce, baseUrl: 'https://inbound.invalid/api/e2', fetch: fetcher }
    const provider = await definition.create(credentials)
    const refreshed = await definition.create(credentials)
    try {
      const first = await provider.listMessages({ folder: 'inbox', limit: 1 })
      expect(first.nextCursor).not.toBeNull()
      expect(first.items[0]).toMatchObject({ sourceDomains: [domain], deliveryRecipients: [`support@${domain}`] })
      canReceive = false
      await failure(() => refreshed.listMessages({ folder: 'inbox', cursor: first.nextCursor, limit: 2 }), 'INVALID_CURSOR', false)
      expect(await refreshed.listMessages({ folder: 'inbox', limit: 2 })).toMatchObject({ items: [], hasMore: false, nextCursor: null })
      expect(emailPages).toBe(1)
    } finally { await Promise.all([provider.disconnect(), refreshed.disconnect()]) }
  })
})

describe('Inbound bounded multi-source snapshots', () => {
  const definition = builtInProviders.find(provider => provider.id === 'inbound')!
  const peer = (count: number) => {
    const domains = Array.from({ length: count }, (_, index) => ({
      id: `domain-${index}`, domain: `source-${String(index).padStart(4, '0')}.example.test`,
      status: 'verified', canReceiveEmails: true,
    }))
    const addresses = domains.map(domain => ({ address: `support@${domain.domain}`, domainId: domain.id,
      isActive: true, isReceiptRuleConfigured: true }))
    const mail = new Map<string, Wire[]>(domains.map((domain, index) => [domain.domain, [{
      id: `source-message-${index}`, thread_id: `source-thread-${index}`, type: 'received',
      from: WRITER, to: ['header-only@unselected.example.test'], cc: [],
      envelope_recipient: addresses[index]!.address, is_read: index % 2 === 0, is_archived: false,
      created_at: '2026-01-01T00:00:00.000Z', subject: `Source ${index}`,
    }]]))
    const stats = { heads: [] as URL[], listings: [] as URL[], discoveries: [] as URL[], details: 0,
      activeHeads: 0, maxHeads: 0, settledHeads: 0 }
    const controls: { head?: (url: URL, signal: AbortSignal) => Promise<Response | void>; envelopeRecipients?: boolean } = {}
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      expect(url.origin).toBe('https://inbound.invalid')
      expect(init?.method ?? 'GET').toBe('GET')
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer offline-multi-source')
      if (init?.signal?.aborted) throw init.signal.reason
      const offset = Number(url.searchParams.get('offset'))
      const limit = Number(url.searchParams.get('limit'))
      if (url.pathname.endsWith('/domains') || url.pathname.endsWith('/email-addresses')) {
        stats.discoveries.push(url)
        const values = url.pathname.endsWith('/domains') ? domains : addresses
        return Response.json({ data: values.slice(offset, offset + limit),
          pagination: { offset, limit, total: values.length, hasMore: offset + limit < values.length },
          capabilities: { envelopeRecipients: controls.envelopeRecipients ?? true } })
      }
      if (url.pathname.endsWith('/emails')) {
        stats.listings.push(url)
        const head = offset === 0 && limit === 1
        if (head) {
          stats.heads.push(url); stats.activeHeads++
          stats.maxHeads = Math.max(stats.maxHeads, stats.activeHeads)
        }
        try {
          if (head) {
            const override = await controls.head?.(url, init!.signal!)
            if (override) return override
          }
          const domain = url.searchParams.get('domain')
          const type = url.searchParams.get('type')
          expect(url.searchParams.get('time_range')).toBe('all')
          if (type === 'received') expect(domain && mail.has(domain)).toBeTruthy()
          else expect(['sent', 'scheduled']).toContain(type!)
          let values = domain ? mail.get(domain)! : []
          const address = url.searchParams.get('address')
          if (address) values = values.filter(message => message.envelope_recipient === address)
          if (url.searchParams.get('status') === 'archived') values = values.filter(message => message.is_archived)
          if (url.searchParams.get('status') === 'unread') values = values.filter(message => !message.is_read)
          return Response.json({ data: values.slice(offset, offset + limit),
            pagination: { offset, limit, total: values.length, has_more: offset + limit < values.length } })
        } finally {
          if (head) { stats.activeHeads--; stats.settledHeads++ }
        }
      }
      for (const values of mail.values()) {
        const message = values.find(message => url.pathname.endsWith(`/emails/${message.id}`))
        if (message) { stats.details++; return Response.json(message) }
      }
      if (url.pathname.includes('/mail/threads/')) {
        const id = url.pathname.split('/').at(-1)!
        const messages = [...mail.values()].flat().filter(message => message.thread_id === id)
        return Response.json({ thread: { id, message_count: messages.length }, messages })
      }
      throw new Error('Unexpected multi-source Inbound request')
    }) as typeof fetch
    return { domains, addresses, mail, stats, controls,
      create: (scopes?: Array<{ kind: 'domain' | 'address'; value: string }>) => definition.create({
        accountId: 'multi-source', apiKey: 'offline-multi-source',
        ...(scopes === undefined ? {} : { sdkMailboxScopes: scopes }),
        baseUrl: 'https://inbound.invalid/api/e2', fetch: fetcher,
      }) }
  }

  for (const count of [101, 1_000]) test(`syncs all ${count} selected sources exactly once across pages`, async () => {
    const h = peer(count + 1)
    const scopes = h.domains.slice(0, count).map((domain, index) => index % 2 === 0
      ? { kind: 'domain' as const, value: domain.domain }
      : { kind: 'address' as const, value: h.addresses[index]!.address })
    const provider = await h.create(scopes)
    const now = Date.now
    let clock = now()
    // Advance only the adapter's pacing clock; requests still run through its real transport.
    Date.now = () => (clock += 111)
    try {
      const ids: string[] = []
      let cursor: SyncCursor | null = null
      let pages = 0
      do {
        const result = await provider.sync(cursor, { limit: 37,
          mailboxScopes: pages % 2 ? [...scopes].reverse() : scopes })
        expect(result.fullSync).toBe(true)
        expect(result.snapshotComplete).toBe(!result.hasMore)
        expect(result.deletedMessageIds).toEqual([])
        expect(h.stats.heads).toHaveLength(count)
        for (const message of result.messages) {
          const index = Number(message.id.split('-').at(-1))
          expect(message.sourceDomains).toEqual([h.domains[index]!.domain])
          expect(message.deliveryRecipients).toEqual([h.addresses[index]!.address])
          expect(message.isRead).toBe(index % 2 === 0)
          ids.push(message.id)
        }
        cursor = result.cursor
        pages++
        expect(pages).toBeLessThanOrEqual(Math.ceil(count / 37))
      } while (cursor)
      expect(ids.slice().sort()).toEqual(Array.from({ length: count }, (_, index) => `source-message-${index}`).sort())
      expect(new Set(ids).size).toBe(count)
      expect(h.stats.details).toBe(count)
      expect(new Set(h.stats.heads.map(url => url.searchParams.get('domain'))).size).toBe(count)
      expect(h.stats.heads.every(url => url.searchParams.get('type') === 'received')).toBe(true)
      expect(h.stats.heads.filter(url => url.searchParams.has('address'))).toHaveLength(Math.floor(count / 2))
      expect(h.stats.heads.some(url => url.searchParams.get('domain') === h.domains[count]!.domain)).toBe(false)
      expect(h.stats.maxHeads).toBe(4)
      expect(h.stats.activeHeads).toBe(0)
      expect(h.stats.settledHeads).toBe(count)
      expect(h.stats.discoveries.some(url => Number(url.searchParams.get('offset')) >= 100)).toBe(true)
    } finally { Date.now = now; await provider.disconnect() }
  })

  for (const count of [600, 1_000]) test(`normalizes ${count === 600 ? 1_200 : 5_000} raw selectors into ${count} receiving streams`, async () => {
    const h = peer(count + 1)
    const scopes = [
      ...h.domains.slice(0, count).map(domain => ({ kind: 'domain' as const, value: domain.domain })),
      ...h.addresses.slice(0, count).map(address => ({ kind: 'address' as const, value: address.address })),
      ...Array.from({ length: count === 1_000 ? 3_000 : 0 }, (_, index) => ({
        kind: 'domain' as const, value: ` ${h.domains[index % count]!.domain.toUpperCase()} `,
      })),
    ]
    const provider = await h.create(scopes)
    const now = Date.now
    let clock = now()
    Date.now = () => (clock += 111)
    try {
      const ids: string[] = []
      let cursor: SyncCursor | null = null
      do {
        const page = await provider.sync(cursor, { limit: 100,
          ...(cursor ? { mailboxScopes: [...scopes].reverse() } : {}) })
        ids.push(...page.messages.map(message => message.id))
        expect(page.snapshotComplete).toBe(!page.hasMore)
        expect(h.stats.heads).toHaveLength(count)
        cursor = page.cursor
      } while (cursor)
      expect(ids.slice().sort()).toEqual(Array.from({ length: count }, (_, index) => `source-message-${index}`).sort())
      expect(new Set(ids).size).toBe(count)
      expect(h.stats.details).toBe(count)
      expect(h.stats.heads.every(url => url.searchParams.get('type') === 'received' &&
        url.searchParams.has('domain') && !url.searchParams.has('address'))).toBe(true)
      expect(h.stats.heads.some(url => url.searchParams.get('domain') === h.domains[count]!.domain)).toBe(false)
      expect(h.stats.maxHeads).toBe(4)
    } finally { Date.now = now; await provider.disconnect() }
  })

  for (const scenario of ['unauthorized', 'unfilterable'] as const) test(`rejects ${scenario} covered addresses in more than 1000 raw selectors before mail reads`, async () => {
    const h = peer(600)
    const scopes = [
      ...h.domains.map(domain => ({ kind: 'domain' as const, value: domain.domain })),
      ...h.addresses.map(address => ({ kind: 'address' as const, value: address.address })),
      ...(scenario === 'unauthorized' ? [{ kind: 'address' as const, value: `not-discovered@${h.domains[0]!.domain}` }] : []),
    ]
    h.controls.envelopeRecipients = scenario !== 'unfilterable'
    const provider = await h.create(scopes)
    const now = Date.now
    let clock = now()
    Date.now = () => (clock += 111)
    try {
      await failure(() => provider.sync(), scenario === 'unauthorized' ? 'AUTHORIZATION' : 'UNSUPPORTED_OPERATION', false)
      expect(h.stats.listings).toHaveLength(0)
      expect(h.stats.details).toBe(0)
    } finally { Date.now = now; await provider.disconnect() }
  })

  test('rejects more than 5000 raw selectors before discovery even when they name one effective stream', async () => {
    const h = peer(1)
    const provider = await h.create([])
    const scopes = Array.from({ length: 5_001 }, () => ({ kind: 'domain' as const, value: h.domains[0]!.domain }))
    try {
      await failure(async () => h.create(scopes), 'VALIDATION', false)
      await failure(() => provider.sync(null, { mailboxScopes: scopes }), 'VALIDATION', false)
      expect(h.stats.discoveries).toHaveLength(0)
      expect(h.stats.listings).toHaveLength(0)
      expect(h.stats.details).toBe(0)
    } finally { await provider.disconnect() }
  })

  test('unselected connections pin 1000 domains and the two distinct outbound streams', async () => {
    const h = peer(1_000)
    const provider = await h.create()
    const now = Date.now
    let clock = now()
    Date.now = () => (clock += 111)
    try {
      const first = await provider.sync(null, { limit: 1 })
      expect(first).toMatchObject({ hasMore: true, snapshotComplete: false })
      expect(h.stats.heads).toHaveLength(1_002)
      expect(h.stats.heads.filter(url => url.searchParams.get('type') === 'received')).toHaveLength(1_000)
      expect(h.stats.heads.filter(url => !url.searchParams.has('domain')).map(url => url.searchParams.get('type')).sort())
        .toEqual(['scheduled', 'sent'])
      expect(h.stats.maxHeads).toBe(4)
      expect(h.stats.details).toBe(1)
    } finally { Date.now = now; await provider.disconnect() }
  })

  test('validates every selected grant before reads, deduplicates covered scopes, and rejects excess input', async () => {
    const h = peer(1_001)
    const domains = h.domains.slice(0, 101).map(domain => ({ kind: 'domain' as const, value: domain.domain }))
    const scopes = [...domains, { kind: 'domain' as const, value: ` ${domains[0]!.value.toUpperCase()} ` },
      { kind: 'address' as const, value: h.addresses[0]!.address }]
    const provider = await h.create(scopes)
    const unselected = await h.create()
    const now = Date.now
    let clock = now()
    Date.now = () => (clock += 111)
    try {
      for (const unknown of [{ kind: 'domain' as const, value: 'unknown.example.test' },
        { kind: 'address' as const, value: `not-discovered@${domains[0]!.value}` }]) {
        await failure(() => provider.sync(null, { mailboxScopes: [...scopes, unknown] }), 'AUTHORIZATION', false)
        expect(h.stats.listings).toHaveLength(0)
        expect(h.stats.details).toBe(0)
      }
      const excess = [
        ...h.domains.map(domain => ({ kind: 'domain' as const, value: domain.domain })),
        ...h.addresses.map(address => ({ kind: 'address' as const, value: address.address })),
      ]
      const overscoped = await h.create(excess)
      try { await failure(() => overscoped.sync(), 'VALIDATION', false) }
      finally { await overscoped.disconnect() }
      await failure(() => provider.sync(null, { mailboxScopes: excess }), 'VALIDATION', false)
      await failure(() => unselected.listMessages({ folder: 'inbox' }), 'VALIDATION', false)
      expect(h.stats.listings).toHaveLength(0)
      const first = await provider.sync(null, { limit: 1 })
      expect(h.stats.heads).toHaveLength(101)
      expect(h.stats.heads.every(url => !url.searchParams.has('address'))).toBe(true)
      const rest = await provider.sync(first.cursor, { limit: 100, mailboxScopes: [...scopes].reverse() })
      expect(rest.snapshotComplete).toBe(true)
      expect(new Set([...first.messages, ...rest.messages].map(message => message.id)).size).toBe(101)
      expect(h.stats.heads).toHaveLength(101)
    } finally { Date.now = now; await Promise.all([provider.disconnect(), unselected.disconnect()]) }
  })

  for (const scenario of ['failed-head', 'disconnect'] as const) test(`${scenario} cancels and settles four active heads without starting the rest`, async () => {
    const h = peer(101)
    const provider = await h.create(h.domains.map(domain => ({ kind: 'domain', value: domain.domain })))
    const now = Date.now
    let clock = now()
    Date.now = () => (clock += 111)
    let entered!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve })
    let failHead!: () => void
    let aborted = 0
    h.controls.head = async (_url, signal) => new Promise<Response>((resolve, reject) => {
      const abort = () => { aborted++; reject(signal.reason) }
      signal.addEventListener('abort', abort, { once: true })
      if (h.stats.heads.length === 1) failHead = () => {
        signal.removeEventListener('abort', abort)
        resolve(Response.json({ error: 'Controlled head throttle' }, { status: 429, headers: { 'Retry-After': '9' } }))
      }
      if (h.stats.heads.length === 4) entered()
    })
    const operation = provider.sync(null, { limit: 1 }).then(result => ({ result }), error => ({ error }))
    try {
      await Promise.race([ready, operation.then(() => { throw new Error('Head pinning finished before four requests entered') })])
      expect(h.stats.activeHeads).toBe(4)
      if (scenario === 'failed-head') failHead()
      else await provider.disconnect()
      expect(await operation).toMatchObject({ error: scenario === 'failed-head'
        ? { code: 'RATE_LIMITED', retryable: true, retryAfter: 9 }
        : { code: 'NETWORK', retryable: true } })
      expect(h.stats.heads).toHaveLength(4)
      expect(h.stats.activeHeads).toBe(0)
      expect(h.stats.settledHeads).toBe(4)
      expect(h.stats.details).toBe(0)
      expect(aborted).toBe(scenario === 'failed-head' ? 3 : 4)
      if (scenario === 'failed-head') {
        h.controls.head = undefined
        const retry = await provider.sync(null, { limit: 1 })
        expect(retry).toMatchObject({ hasMore: true, snapshotComplete: false })
        expect(retry.messages.map(message => message.id)).toEqual(['source-message-0'])
        expect(h.stats.heads).toHaveLength(105)
      } else {
        await failure(() => provider.sync(), 'NETWORK', true)
        expect(h.stats.heads).toHaveLength(4)
      }
    } finally { Date.now = now; await provider.disconnect(); await operation }
  })

  test('disconnect cancels paced head timers before they can call the transport', async () => {
    const h = peer(101)
    const provider = await h.create(h.domains.map(domain => ({ kind: 'domain', value: domain.domain })))
    const now = Date.now
    let clock = now()
    Date.now = () => (clock += 111)
    let entered!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve })
    h.controls.head = async (_url, signal) => {
      // The first head is in flight; force the other three workers into real, long pacing waits.
      const earlier = clock - 5_000
      Date.now = () => earlier
      entered()
      return new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    }
    const operation = provider.sync(null, { limit: 1 }).then(result => ({ result }), error => ({ error }))
    try {
      await Promise.race([ready, operation.then(() => { throw new Error('Head pinning did not enter the transport') })])
      const start = performance.now()
      await provider.disconnect()
      expect(await operation).toMatchObject({ error: { code: 'NETWORK', retryable: true } })
      expect(performance.now() - start).toBeLessThan(500)
      expect(h.stats.heads).toHaveLength(1)
      expect(h.stats.activeHeads).toBe(0)
      expect(h.stats.settledHeads).toBe(1)
    } finally { Date.now = now; await provider.disconnect(); await operation }
  })

  test('concurrent snapshot requests share the four-head bound without sharing source state', async () => {
    const h = peer(101)
    const provider = await h.create(h.domains.map(domain => ({ kind: 'domain', value: domain.domain })))
    const now = Date.now
    let clock = now()
    Date.now = () => (clock += 111)
    try {
      const results = await Promise.all(['first-query', 'second-query'].map(search => provider.listMessages({ search, limit: 1 })))
      expect(h.stats.maxHeads).toBe(4)
      expect(h.stats.heads).toHaveLength(202)
      expect(results[0]!.nextCursor).not.toBe(results[1]!.nextCursor)
      for (const [index, search] of ['first-query', 'second-query'].entries()) {
        const rest = await provider.listMessages({ search, cursor: results[index]!.nextCursor, limit: 100 })
        expect(rest.hasMore).toBe(false)
        expect(new Set([...results[index]!.items, ...rest.items].map(message => message.id)).size).toBe(101)
      }
      expect(h.stats.heads).toHaveLength(202)
    } finally { Date.now = now; await provider.disconnect() }
  })

  test('many-source cursors pin arrivals, retain ordering and invalidate changed scopes or refreshed grants', async () => {
    const h = peer(102)
    const scopes = h.domains.slice(0, 101).map(domain => ({ kind: 'domain' as const, value: domain.domain }))
    const original = h.mail.get(scopes[0]!.value)!
    original.push({ ...original[0], id: 'older-pinned-message' })
    const provider = await h.create(scopes)
    const replacement = await h.create(scopes)
    const now = Date.now
    let clock = now()
    Date.now = () => (clock += 111)
    try {
      const first = await provider.sync(null, { limit: 1 })
      expect(first.cursor).not.toBeNull()
      expect(h.stats.heads).toHaveLength(101)
      const reads = h.stats.listings.length + h.stats.details
      await failure(() => replacement.sync(first.cursor), 'INVALID_CURSOR', false)
      await failure(() => provider.sync(first.cursor, { mailboxScopes: [...scopes.slice(0, 100),
        { kind: 'domain', value: h.domains[101]!.domain }] }), 'INVALID_CURSOR', false)
      await failure(() => provider.listThreads({ cursor: first.cursor!.value, folder: 'inbox' }), 'INVALID_CURSOR', false)
      expect(h.stats.listings.length + h.stats.details).toBe(reads)
      original.unshift({ ...original[0], id: 'new-arrival', created_at: '2026-01-02T00:00:00.000Z' })
      const ids = first.messages.map(message => message.id)
      let cursor = first.cursor
      do {
        const next = await provider.sync(cursor, { limit: 37, mailboxScopes: [...scopes].reverse() })
        ids.push(...next.messages.map(message => message.id)); cursor = next.cursor
      } while (cursor)
      expect(ids).toHaveLength(102)
      expect(new Set(ids).size).toBe(102)
      expect(ids).toContain('older-pinned-message')
      expect(ids).not.toContain('new-arrival')
      expect(h.stats.heads).toHaveLength(101)
      const fresh = await provider.sync(null, { limit: 1 })
      expect(fresh.messages.map(message => message.id)).toEqual(['new-arrival'])
      const beforeRevocation = h.stats.listings.length + h.stats.details
      h.domains[100]!.canReceiveEmails = false
      clock += 61_000
      await failure(() => provider.sync(fresh.cursor), 'INVALID_CURSOR', false)
      expect(h.stats.listings.length + h.stats.details).toBe(beforeRevocation)
      const restarted = await provider.sync(null, { limit: 1 })
      expect(restarted.snapshotComplete).toBe(false)
      expect(h.stats.heads.slice(-100).some(url => url.searchParams.get('domain') === h.domains[100]!.domain)).toBe(false)
      original.pop()
      let current = restarted.cursor
      await failure(async () => {
        do { current = (await provider.sync(current, { limit: 100 })).cursor } while (current)
      }, 'INVALID_CURSOR', false)
    } finally { Date.now = now; await Promise.all([provider.disconnect(), replacement.disconnect()]) }
  })

  test('complete native threads spanning selected domains retain read/archive state and exclude unchosen delivery', async () => {
    const h = peer(102)
    const scopes = h.domains.slice(0, 101).map(domain => ({ kind: 'domain' as const, value: domain.domain }))
    for (const index of [0, 1, 101]) h.mail.get(h.domains[index]!.domain)![0]!.thread_id = 'shared-source-thread'
    h.mail.get(h.domains[0]!.domain)![0]!.is_archived = true
    const provider = await h.create(scopes)
    const now = Date.now
    let clock = now()
    Date.now = () => (clock += 111)
    try {
      const first = await provider.listThreads({ limit: 1 })
      expect(first.total).toBe(100)
      expect(first.items[0]!.messages.map(message => message.id).sort()).toEqual(['source-message-0', 'source-message-1'])
      expect(first.items[0]!.messageCount).toBe(2)
      expect(first.items[0]!.messages.find(message => message.id === 'source-message-0')).toMatchObject({ folder: 'archive', isRead: true })
      expect(first.items[0]!.messages.find(message => message.id === 'source-message-1')).toMatchObject({ folder: 'inbox', isRead: false })
      const rest = await provider.listThreads({ cursor: first.nextCursor, limit: 100 })
      expect(rest.hasMore).toBe(false)
      expect(new Set([...first.items, ...rest.items].map(thread => thread.id)).size).toBe(100)
      expect(h.stats.heads).toHaveLength(101)
    } finally { Date.now = now; await provider.disconnect() }
  })

  for (const scenario of ['queries', 'heads', 'entries', 'thread-identities'] as const) test(`${scenario} metadata stays inside the shared 8 MiB snapshot budget`, async () => {
    const h = peer(1_000)
    const scopes = h.domains.map(domain => ({ kind: 'domain' as const, value: domain.domain }))
    if (scenario === 'heads' || scenario === 'entries') {
      for (const values of h.mail.values()) {
        const large = { ...values[0], id: `${values[0]!.id}-large`, from_name: 'n'.repeat(2_048),
          message_id: 'm'.repeat(2_048), thread_id: 't'.repeat(2_048) }
        if (scenario === 'heads') values[0] = large
        else values.push(large)
      }
    }
    if (scenario === 'thread-identities') {
      for (const values of h.mail.values()) Object.assign(values[0]!, { from_name: 'n'.repeat(1_000), thread_id: 't'.repeat(2_048) })
      h.controls.head = async url => Response.json({
        data: h.mail.get(url.searchParams.get('domain')!)!.map(message => ({ ...message, thread_id: undefined })),
        pagination: { offset: 0, limit: 1, total: 1, has_more: false },
      })
    }
    const provider = await h.create(scopes)
    const now = Date.now
    let clock = now()
    Date.now = () => (clock += 111)
    try {
      let completed = false
      await failure(async () => {
        if (scenario === 'thread-identities') await provider.listThreads({ limit: 1 })
        else {
          let cursor: string | null = null
          do {
            const page = await provider.listMessages({ limit: 100, cursor,
              ...(scenario === 'queries' ? { search: 'q'.repeat(2_100) } : {}) })
            cursor = page.nextCursor
          } while (cursor)
        }
        completed = true
      }, 'UPSTREAM', false)
      expect(completed).toBe(false)
      expect(h.stats.activeHeads).toBe(0)
      if (scenario === 'queries') expect(h.stats.heads).toHaveLength(0)
      if (scenario === 'heads') {
        expect(h.stats.heads.length).toBeGreaterThan(100)
        expect(h.stats.heads.length).toBeLessThan(1_000)
        expect(h.stats.details).toBe(0)
      }
      if (scenario === 'entries' || scenario === 'thread-identities') {
        expect(h.stats.heads).toHaveLength(1_000)
        expect(h.stats.details).toBeGreaterThan(0)
      }
    } finally { Date.now = now; await provider.disconnect() }
  })

  test('aggregate item totals accept 10000 as incomplete history and fail explicitly above it', async () => {
    for (const perSource of [10, 11]) {
      const h = peer(1_000)
      for (const [domain, values] of h.mail) h.mail.set(domain, Array.from({ length: perSource }, (_, index) => ({
        ...values[0], id: `${values[0]!.id}-${index}`,
      })))
      const provider = await h.create(h.domains.map(domain => ({ kind: 'domain', value: domain.domain })))
      const now = Date.now
      let clock = now()
      Date.now = () => (clock += 111)
      try {
        if (perSource === 10) {
          const first = await provider.sync(null, { limit: 1 })
          expect(first).toMatchObject({ hasMore: true, snapshotComplete: false })
          expect(first.cursor).not.toBeNull()
          expect(first.messages).toHaveLength(1)
          expect(h.stats.heads).toHaveLength(1_000)
        } else {
          await failure(() => provider.sync(null, { limit: 1 }), 'UPSTREAM', false)
          expect(h.stats.heads.length).toBeLessThan(1_000)
          expect(h.stats.details).toBe(0)
        }
        expect(h.stats.activeHeads).toBe(0)
        expect(h.stats.maxHeads).toBe(4)
      } finally { Date.now = now; await provider.disconnect() }
    }
  })
})

describe('Inbound E2 metadata and cursor boundaries', () => {
  test('E2 headers preserve display and RFC metadata without expanding recipients or inventing delivery evidence', async () => {
    const definition = builtInProviders.find(provider => provider.id === 'inbound')!
    const wire = {
      id: 'e2-header-message', type: 'received', created_at: '2026-01-01T00:00:00.000Z',
      from: WRITER, to: [PRIMARY], cc: [], bcc: [], reply_to: [WRITER],
      subject: 'E2 metadata contract', text: 'Metadata-only contract body', is_read: false, attachments: [],
      headers: {
        From: `"Writer, Ren\u00e9" <${WRITER}>`,
        To: `"Reader, \u65e5\u672c\u8a9e" <${PRIMARY}>, other@unrelated.example.test`,
        Cc: 'not-a-structured-recipient@unrelated.example.test',
        Bcc: 'must-not-be-exposed@unrelated.example.test',
        'Reply-To': `"Reply desk" <${WRITER}>`,
        'Message-ID': '<e2-header-message@example.test>',
        'In-Reply-To': '<e2-parent@example.test>',
        References: ['<e2-root@example.test>', '<e2-parent@example.test>'],
        'X-Inbox-Contract': 'e2-header-contract',
        'X-Nontext': { ignored: true },
      },
    }
    const calls: string[] = []
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      expect(url.origin).toBe('https://inbound.invalid')
      expect(init?.method ?? 'GET').toBe('GET')
      calls.push(url.pathname)
      if (url.pathname.endsWith('/domains')) return Response.json({
        data: [{ id: 'e2-domain', domain: 'example.test', status: 'verified', canReceiveEmails: true }],
        pagination: { hasMore: false, offset: 0, limit: 100, total: 1 },
      })
      if (url.pathname.endsWith('/email-addresses')) return Response.json({
        data: [], pagination: { hasMore: false, offset: 0, limit: 100, total: 0 },
      })
      if (url.pathname.endsWith(`/emails/${wire.id}`)) return Response.json(wire)
      throw new Error('Unexpected E2 metadata request')
    }) as typeof fetch
    const provider = await definition.create({ accountId: 'e2-metadata', apiKey: 'offline-e2', baseUrl: 'https://inbound.invalid/api/e2', fetch: fetcher })
    try {
      const message = await provider.getMessage(wire.id)
      expect(message.from).toEqual({ name: 'Writer, Ren\u00e9', email: WRITER })
      expect(message.to).toEqual([{ name: 'Reader, \u65e5\u672c\u8a9e', email: PRIMARY }])
      expect(message.cc).toEqual([])
      expect(message.bcc).toEqual([])
      expect(message.replyTo).toEqual([{ name: 'Reply desk', email: WRITER }])
      expect(message.rfcMessageId).toBe('<e2-header-message@example.test>')
      expect(message.inReplyTo).toBe('<e2-parent@example.test>')
      expect(message.references).toEqual(['<e2-root@example.test>', '<e2-parent@example.test>'])
      expect(message.headers?.['x-inbox-contract']).toBe('e2-header-contract')
      expect(message.headers?.['x-nontext']).toBeUndefined()
      expect(message.folderIds).toEqual(['inbox'])
      expect(message.deliveryRecipients).toBeUndefined()
      expect(message.sourceDomains).toBeUndefined()
      expect(message.isRead).toBe(false)
      expect(wire.is_read).toBe(false)
      expect(calls).toEqual(['/api/e2/domains', '/api/e2/email-addresses', `/api/e2/emails/${wire.id}`])
    } finally { await provider.disconnect() }
  })

  test('thread cursors bind account, query filters, and resource kind', async () => {
    const h = await httpHarness('inbound')
    try {
      const first = await h.provider.listThreads({ folder: h.scope, limit: 1 })
      expect(first.nextCursor).not.toBeNull()
      await failure(() => h.other!.listThreads({ folder: h.scope, cursor: first.nextCursor, limit: 1 }), 'INVALID_CURSOR', false)
      for (const changed of [{ folder: 'archive' }, { search: 'different-query' }, { unreadOnly: true }]) {
        await failure(() => h.provider.listThreads({ folder: h.scope, cursor: first.nextCursor, ...changed }), 'INVALID_CURSOR', false)
      }
      await failure(() => h.provider.listMessages({ folder: h.scope, cursor: first.nextCursor }), 'INVALID_CURSOR', false)
      await failure(() => h.provider.listThreads({ folder: h.scope, cursor: '1' }), 'INVALID_CURSOR', false)
      const next = await h.provider.listThreads({ folder: h.scope, cursor: first.nextCursor, limit: 2 })
      expect(next.hasMore).toBe(false)
      expect(next.items.map(thread => thread.id)).not.toContain(first.items[0]!.id)
      expect(h.writes?.()).toBe(0)
    } finally { await h.close() }
  })

  test('snapshot removals fail closed rather than completing a displaced backfill', async () => {
    const h = await httpHarness('inbound')
    try {
      const first = await h.provider.sync(null, { folder: 'inbox', limit: 1 })
      await h.removeMessage(h.provider, h.ids[0]!)
      await failure(() => h.provider.sync(first.cursor, { folder: 'inbox', limit: 2 }), 'INVALID_CURSOR', false)
      const restarted = await h.provider.sync(null, { folder: 'inbox', limit: 100 })
      expect(restarted.snapshotComplete).toBe(true)
      expect(restarted.messages.map(message => message.id).sort()).toEqual(h.ids.slice(1).sort())
    } finally { await h.close() }
  })

  test('snapshot cursors have bounded storage and expire across eviction, instances and disconnect', async () => {
    const h = await httpHarness('inbound')
    const replacement = await h.definition.create(h.credentials)
    try {
      const first = await h.provider.listMessages({ folder: 'inbox', limit: 1 })
      expect(first.nextCursor!.length).toBeLessThan(128)
      await failure(() => replacement.listMessages({ folder: 'inbox', cursor: first.nextCursor }), 'INVALID_CURSOR', false)
      for (let index = 0; index < 4; index++) await h.provider.listMessages({ folder: 'inbox', limit: 1 })
      await failure(() => h.provider.listMessages({ folder: 'inbox', cursor: first.nextCursor }), 'INVALID_CURSOR', false)
      const latest = await h.provider.listMessages({ folder: 'inbox', limit: 1 })
      const replay = await h.provider.listMessages({ folder: 'inbox', cursor: latest.nextCursor, limit: 2 })
      expect(replay.items.map(message => message.id).sort()).toEqual(h.ids.slice(0, 2).sort())
      expect(replay.hasMore).toBe(false)
      const now = Date.now
      const expired = now() + 16 * 60_000
      Date.now = () => expired
      try { await failure(() => h.provider.listMessages({ folder: 'inbox', cursor: latest.nextCursor }), 'INVALID_CURSOR', false) }
      finally { Date.now = now }
      const active = await h.provider.listMessages({ folder: 'inbox', limit: 1 })
      await h.provider.disconnect()
      await failure(() => h.provider.listMessages({ folder: 'inbox', cursor: active.nextCursor }), 'NETWORK', true)
    } finally { await replacement.disconnect(); await h.close() }
  })

  test('named recipient and inline Content-ID translation retain native submission identities', async () => {
    const definition = builtInProviders.find(provider => provider.id === 'inbound')!
    const submissions: Wire[] = []
    let native: Wire
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      expect(url.origin).toBe('https://inbound.invalid')
      if (url.pathname === '/api/e2/emails' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        submissions.push(body)
        native = { ...body, id: 'named-submission', type: 'sent', created_at: '2026-01-01T00:00:00.000Z' }
        return Response.json({ id: native.id, message_id: '<named-submission@example.test>' })
      }
      expect(init?.method ?? 'GET').toBe('GET')
      if (url.pathname === '/api/e2/emails/named-submission') return Response.json(native)
      throw new Error('Unexpected Inbound translation request')
    }) as typeof fetch
    const provider = await definition.create({ accountId: 'named-translation', email: PRIMARY, apiKey: 'offline',
      baseUrl: 'https://inbound.invalid/api/e2', fetch: fetcher })
    try {
      const sent = await provider.send({ from: { name: 'Writer, René', email: PRIMARY },
        to: { name: 'Reader, 日本語', email: SECONDARY }, cc: { name: 'Copy desk', email: WRITER },
        bcc: { name: 'Private copy', email: PRIMARY }, subject: 'Named submission', bodyText: TEXT, bodyHtml: HTML,
        attachments: [{ filename: 'inline.png', content: BINARY, contentType: 'image/png', contentId: 'contract-inline', inline: true },
          { filename: ZERO_FILE, content: new Uint8Array(), contentType: 'text/plain' }] })
      expect(sent).toMatchObject({ id: 'named-submission', providerMessageId: 'named-submission' })
      expect(submissions).toHaveLength(1)
      expect(submissions[0]).toMatchObject({ to: [`"Reader, 日本語" <${SECONDARY}>`], cc: [`"Copy desk" <${WRITER}>`],
        bcc: [`"Private copy" <${PRIMARY}>`] })
      expect(submissions[0]!.attachments[0]).toMatchObject({ content_id: 'contract-inline', content_type: 'image/png', content: Buffer.from(BINARY).toString('base64') })
      expect(submissions[0]!.attachments[1].content).toBe('')
      const message = await provider.getMessage(sent.providerMessageId!)
      expect(message.to).toEqual([{ name: 'Reader, 日本語', email: SECONDARY }])
      expect(message.attachments[0]).toMatchObject({ contentId: 'contract-inline', inline: true })
      await failure(() => provider.send({ from: PRIMARY, to: SECONDARY, subject: 'Missing CID', bodyHtml: HTML,
        attachments: [{ filename: 'inline.png', content: BINARY, inline: true }] }), 'VALIDATION', false)
      for (const extra of [{ sourceMessageId: 'named-submission' }, { scheduledAt: '2099-01-01T00:00:00.000Z' }]) {
        await failure(() => provider.send({ ...extra, from: PRIMARY, to: SECONDARY, subject: 'Unsupported native CID', bodyHtml: HTML,
          attachments: [{ filename: 'inline.png', content: BINARY, contentId: 'contract-inline', inline: true }] }), 'UNSUPPORTED_OPERATION', false)
      }
      expect(submissions).toHaveLength(1)
    } finally { await provider.disconnect() }
  })

  test('archive evidence survives detail omissions and native thread archive defaults', async () => {
    const h = await httpHarness('inbound')
    const nativeFetch = h.credentials.fetch!
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await nativeFetch(input, init)
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname
      if ((init?.method ?? 'GET') !== 'GET' || !/\/(?:emails|mail\/threads)\/[^/]+$/.test(path)) return response
      const body = await response.json() as Wire
      delete body.is_archived
      if (body.messages) {
        for (const message of body.messages) delete message.is_archived
        body.thread.is_archived = false
      }
      return Response.json(body, { status: response.status })
    }) as typeof fetch
    const provider = await h.definition.create({ ...h.credentials, fetch: fetcher })
    try {
      const archived = await provider.mutate(h.rootId, { folder: 'archive' })
      expect(archived?.folder).toBe('archive')
      expect((await provider.getMessage(h.rootId)).folder).toBe('archive')
      const thread = await provider.getThread(h.rootThread)
      expect(thread.messages.find(message => message.id === h.rootId)?.folder).toBe('archive')
      expect(thread.messages.find(message => message.id === h.ids[1])?.folder).toBe('inbox')
      const listing = await provider.listThreads({ folder: 'archive', limit: 1 })
      expect(listing.items[0]?.messages.map(message => message.id).sort()).toEqual(h.ids.slice(0, 2).sort())
      expect(listing.items[0]?.messages.find(message => message.id === h.rootId)?.folder).toBe('archive')
      expect(listing.items[0]?.folder).toBe('archive')
      await provider.mutate(h.rootId, { folder: 'inbox' })
      expect((await provider.getMessage(h.rootId)).folder).toBe('inbox')
    } finally { await provider.disconnect(); await h.close() }
  })

  test('receiving snapshots filter MIME-only matches, pin arrivals and scope every thread message', async () => {
    const definition = builtInProviders.find(provider => provider.id === 'inbound')!
    const domain = 'scoped.example.test'
    const selected = `support@${domain}`
    const other = `other@${domain}`
    const scopes = [{ kind: 'address' as const, value: selected }]
    let canReceive = true
    const native: Wire[] = [
      { id: 'header-only', thread_id: 'shared-thread', envelope_recipient: other, to: [selected] },
      { id: 'selected-root', thread_id: 'shared-thread', envelope_recipient: selected, to: [other] },
      { id: 'selected-reply', thread_id: 'shared-thread', envelope_recipient: selected, to: [selected] },
      { id: 'selected-separate', thread_id: 'separate-thread', envelope_recipient: selected, to: [selected] },
    ].map((message, index) => ({ ...message, type: 'received', subject: message.id, from: WRITER, is_read: false,
      is_archived: false, created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, 4 - index)).toISOString() }))
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      expect(url.origin).toBe('https://inbound.invalid')
      expect(init?.method ?? 'GET').toBe('GET')
      if (url.pathname.endsWith('/domains')) return Response.json({ data: [{ id: 'scope-domain', domain, status: 'verified', canReceiveEmails: canReceive }],
        pagination: { hasMore: false, offset: 0, limit: 100, total: 1 }, capabilities: { envelopeRecipients: true } })
      if (url.pathname.endsWith('/email-addresses')) return Response.json({ data: [selected, other].map(address => ({ address,
        domainId: 'scope-domain', isActive: true, isReceiptRuleConfigured: true })), pagination: { hasMore: false, offset: 0, limit: 100, total: 2 } })
      if (url.pathname.endsWith('/emails')) {
        expect(url.searchParams.get('domain')).toBe(domain)
        expect(url.searchParams.get('type')).toBe('received')
        const offset = Number(url.searchParams.get('offset'))
        const limit = Number(url.searchParams.get('limit'))
        return Response.json({ data: native.slice(offset, offset + limit), pagination: { offset, limit, total: native.length, has_more: offset + limit < native.length } })
      }
      if (url.pathname.includes('/mail/threads/')) {
        const id = url.pathname.split('/').at(-1)!
        const messages = native.filter(message => message.thread_id === id)
        if (id === 'shared-thread') messages.push({ id: 'outbound-sibling', type: 'outbound', from: selected, to: [other], subject: 'Not receiving evidence' })
        return Response.json({ thread: { id, message_count: messages.length }, messages })
      }
      const message = native.find(message => url.pathname.endsWith(`/emails/${message.id}`))
      if (message) return Response.json(message)
      throw new Error('Unexpected scoped Inbound request')
    }) as typeof fetch
    const provider = await definition.create({ accountId: 'receiving-scopes', apiKey: 'offline', sdkMailboxScopes: scopes,
      baseUrl: 'https://inbound.invalid/api/e2', fetch: fetcher })
    try {
      const first = await provider.listMessages({ limit: 1 })
      expect(first.items).toEqual([])
      expect(first.hasMore).toBe(true)
      native.unshift({ ...native[1], id: 'arrival', thread_id: 'arrival-thread', created_at: '2026-01-01T00:00:05.000Z' })
      const second = await provider.listMessages({ cursor: first.nextCursor, limit: 2 })
      expect(second.items.map(message => message.id)).toEqual(['selected-root', 'selected-reply'])
      const last = await provider.listMessages({ cursor: second.nextCursor, limit: 2 })
      expect(last.items.map(message => message.id)).toEqual(['selected-separate'])
      expect(last.hasMore).toBe(false)
      const fresh = await provider.listMessages({ limit: 100 })
      expect(fresh.items.map(message => message.id)).toEqual(['arrival', 'selected-root', 'selected-reply', 'selected-separate'])
      expect(fresh.items.every(message => message.deliveryRecipients?.includes(selected))).toBe(true)
      const threads = await provider.listThreads({ limit: 1 })
      await failure(() => provider.listThreads({ cursor: threads.nextCursor, mailboxScopes: [{ kind: 'address', value: other }] }), 'INVALID_CURSOR', false)
      await failure(() => provider.listThreads({ cursor: first.nextCursor }), 'INVALID_CURSOR', false)
      const rest = await provider.listThreads({ cursor: threads.nextCursor, limit: 100 })
      const shared = [...threads.items, ...rest.items].find(thread => thread.id === 'shared-thread')!
      expect(shared.messages.map(message => message.id).sort()).toEqual(['selected-reply', 'selected-root'])
      expect(shared.messageCount).toBe(2)
      const nativeThread = await provider.getThread('shared-thread')
      expect(nativeThread.messages.map(message => message.id).sort()).toEqual(['selected-reply', 'selected-root'])
      expect(nativeThread.messageCount).toBe(2)
      const beforeGrantChange = await provider.listMessages({ limit: 1 })
      canReceive = false
      const now = Date.now
      const later = now() + 61_000
      Date.now = () => later
      try {
        await failure(() => provider.listMessages({ cursor: beforeGrantChange.nextCursor }), 'INVALID_CURSOR', false)
        expect(await provider.listMessages()).toMatchObject({ items: [], hasMore: false, nextCursor: null })
      } finally { Date.now = now }
    } finally { await provider.disconnect() }
  })

  test('unknown envelope evidence and oversized snapshots cannot become complete mailboxes', async () => {
    const definition = builtInProviders.find(provider => provider.id === 'inbound')!
    for (const scenario of ['missing-envelope', 'oversized'] as const) {
      const domain = 'bounded.example.test'
      const address = `support@${domain}`
      const native = { id: scenario, type: 'received', to: [address], envelope_recipient: null }
      const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        expect(url.origin).toBe('https://inbound.invalid')
        expect(init?.method ?? 'GET').toBe('GET')
        if (url.pathname.endsWith('/domains')) return Response.json({ data: [{ id: domain, domain, status: 'verified', canReceiveEmails: true }],
          pagination: { hasMore: false, offset: 0, limit: 100, total: 1 }, capabilities: { envelopeRecipients: true } })
        if (url.pathname.endsWith('/email-addresses')) return Response.json({ data: [{ address, domainId: domain, isActive: true, isReceiptRuleConfigured: true }],
          pagination: { hasMore: false, offset: 0, limit: 100, total: 1 } })
        if (url.pathname.endsWith('/emails')) return Response.json({ data: [native], pagination: {
          offset: 0, limit: 1, total: scenario === 'oversized' ? 10_001 : 1, has_more: scenario === 'oversized' } })
        if (url.pathname.endsWith(`/emails/${scenario}`)) return Response.json(native)
        throw new Error('Unexpected bounded Inbound request')
      }) as typeof fetch
      const provider = await definition.create({ accountId: scenario, apiKey: 'offline', sdkMailboxScopes: [{ kind: 'address', value: address }],
        baseUrl: 'https://inbound.invalid/api/e2', fetch: fetcher })
      try { await failure(() => provider.sync(null, { limit: 1 }), 'UPSTREAM', false) }
      finally { await provider.disconnect() }
    }
  })
})

test('Gmail rotating download handles retain stable MIME attachment identity and readable legacy handles', async () => {
  const definition = builtInProviders.find(provider => provider.id === 'gmail')!
  const handles = new Set(['persisted-handle'])
  let revision = 0
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    expect(url.origin).toBe('https://gmail.invalid')
    expect(init?.method ?? 'GET').toBe('GET')
    if (url.pathname.endsWith('/users/me/messages/stable-message')) {
      const handle = `download-handle-${++revision}`
      handles.add(handle)
      return Response.json({
        id: 'stable-message', threadId: 'stable-thread', internalDate: String(Date.UTC(2026, 0, 1)), labelIds: ['INBOX', 'UNREAD'],
        payload: { partId: '', mimeType: 'multipart/mixed', headers: [], parts: [{
          partId: '1', mimeType: 'application/octet-stream', filename: FILE,
          headers: [{ name: 'Content-Disposition', value: 'attachment' }],
          body: { attachmentId: handle, size: BINARY.byteLength },
        }] },
      })
    }
    const attachment = /^\/gmail\/v1\/users\/me\/messages\/stable-message\/attachments\/([^/]+)$/.exec(url.pathname)
    if (attachment && handles.has(decodeURIComponent(attachment[1]!))) {
      return Response.json({ data: Buffer.from(BINARY).toString('base64url'), size: BINARY.byteLength })
    }
    return Response.json({ error: { message: 'Not found' } }, { status: 404 })
  }) as typeof fetch
  const provider = await definition.create({ accountId: 'gmail-rotating', accessToken: 'offline-token',
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'], baseUrl: 'https://gmail.invalid/gmail/v1', fetch: fetcher })
  try {
    const first = await provider.getMessage('stable-message')
    const second = await provider.getMessage('stable-message')
    expect(revision).toBe(2)
    expect(first.attachments[0]!.id).toBe(second.attachments[0]!.id)
    const current = await provider.getAttachment(first.id, first.attachments[0]!.id)
    expect(current.content).toEqual(BINARY)
    expect(current.filename).toBe(FILE)
    const legacy = await provider.getAttachment(first.id, 'persisted-handle', undefined, {
      filename: FILE, contentType: 'application/octet-stream',
    })
    expect(legacy.content).toEqual(BINARY)
    expect(legacy.filename).toBe(FILE)
    expect(legacy.contentType).toBe('application/octet-stream')
    expect(legacy.attachment.id).toBe('persisted-handle')
    await failure(() => provider.getAttachment('other-message', 'persisted-handle'), 'NOT_FOUND', false)
  } finally { await provider.disconnect() }
})

describe('Gmail read-only body and pagination regressions', () => {
  test('explicit HTML UTF-8 declarations override legacy MIME only for valid original UTF-8 bytes', async () => {
    const definition = builtInProviders.find(provider => provider.id === 'gmail')!
    const plain = 'Plain caf\u00e9 body.'
    const body = '<body>Keep\u00a0both\u00a0spaces \u00a9</body>'
    for (const html of [
      `<html><head><meta charset="UTF-8"></head>${body}</html>`,
      `<!doctype html><html><head><META content="text/html; charset='utf-8'" HTTP-EQUIV="Content-Type"></head>${body}</html>`,
      `\ufeff<html><head></head>${body}</html>`,
    ]) {
      const native = { id: 'utf8-html', threadId: 'utf8-thread', internalDate: '1767225600000', payload: {
        mimeType: 'multipart/alternative', parts: [
          { partId: '0', mimeType: 'text/plain', headers: [
            { name: 'Content-Type', value: 'text/plain; charset=ISO-8859-1' },
            { name: 'Content-Transfer-Encoding', value: 'QUOTED-PRINTABLE' },
          ], body: { data: Buffer.from(plain, 'latin1').toString('base64url') } },
          { partId: '1', mimeType: 'text/html', headers: [
            { name: 'Content-Type', value: 'text/html; charset=ISO-8859-1' },
            { name: 'Content-Transfer-Encoding', value: 'QUOTED-PRINTABLE' },
          ], body: { data: Buffer.from(html, 'utf8').toString('base64url') } },
        ],
      } }
      const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toBe('https://gmail.invalid/gmail/v1/users/me/messages/utf8-html?format=full')
        expect(init?.method ?? 'GET').toBe('GET')
        return Response.json(native)
      }) as typeof fetch
      const provider = await definition.create({ accountId: 'gmail-utf8', accessToken: 'offline-token',
        scopes: ['https://www.googleapis.com/auth/gmail.readonly'], baseUrl: 'https://gmail.invalid/gmail/v1', fetch: fetcher })
      try {
        const message = await provider.getMessage(native.id)
        expect(message.bodyHtml).toBe(html.replace(/^\ufeff/, ''))
        expect(message.bodyText).toBe(plain)
        expect(message.attachments).toEqual([])
      } finally { await provider.disconnect() }
    }
  })

  test('invalid UTF-8, non-head declarations and non-HTML parts retain their MIME charset', async () => {
    const definition = builtInProviders.find(provider => provider.id === 'gmail')!
    const declared = '<html><head><meta charset="utf-8"></head><body>caf\u00e9 \u00a9</body></html>'
    for (const [mimeType, charset, bytes] of [
      ['text/html', 'ISO-8859-1', Buffer.from(declared, 'latin1')],
      ['text/html', 'windows-1252', Buffer.from('<html><head></head><body>\u00a9</body></html>')],
      ['text/html', 'ISO-8859-1', Buffer.from('<html><head><!-- <meta charset="utf-8"> --><script>const example = `<meta charset="utf-8">`</script><template><meta charset="utf-8"></template></head><body><meta charset="utf-8">\u00a9</body></html>')],
      ['text/html', 'ISO-8859-1', Buffer.from('<html><head><meta charset="windows-1252"><meta charset="utf-8"></head><body>\u00a9</body></html>')],
      ['text/html', 'utf-16le', Buffer.from(declared, 'utf16le')],
      ['text/plain', 'ISO-8859-1', Buffer.from(declared)],
    ] as const) {
      const native = { id: 'legacy-body', threadId: 'legacy-thread', internalDate: '1767225600000', payload: {
        partId: '0', mimeType, headers: [{ name: 'Content-Type', value: `${mimeType}; charset=${charset}` }],
        body: { data: bytes.toString('base64url') },
      } }
      const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toBe('https://gmail.invalid/gmail/v1/users/me/messages/legacy-body?format=full')
        expect(init?.method ?? 'GET').toBe('GET')
        return Response.json(native)
      }) as typeof fetch
      const provider = await definition.create({ accountId: 'gmail-legacy', accessToken: 'offline-token',
        scopes: ['https://www.googleapis.com/auth/gmail.readonly'], baseUrl: 'https://gmail.invalid/gmail/v1', fetch: fetcher })
      try {
        const message = await provider.getMessage(native.id)
        expect(mimeType === 'text/html' ? message.bodyHtml : message.bodyText).toBe(new TextDecoder(charset).decode(bytes))
        expect(message.attachments).toEqual([])
      } finally { await provider.disconnect() }
    }
  })

  test('attachment-backed bodies hydrate full reads while attached files and metadata reads stay lazy', async () => {
    const definition = builtInProviders.find(provider => provider.id === 'gmail')!
    const text = 'External caf\u00e9 body.'
    const html = '<p>HTML \u65e5\u672c\u8a9e caf\u00e9</p><img src="inline.png">'
    const downloads: string[] = []
    let htmlOnly = false
    let bodyFailure: 'missing' | 'malformed' | undefined
    const plainPart = { partId: '0.0', mimeType: 'text/plain', headers: [
      { name: 'Content-Type', value: 'text/plain; charset="windows-1252"' },
      { name: 'Content-Disposition', value: 'inline' },
    ], body: { attachmentId: 'external-text', data: '', size: Buffer.byteLength(text, 'latin1') } }
    const htmlPart = { partId: '0.1', mimeType: 'text/html', headers: [
      { name: 'Content-Type', value: "text/html; charset='utf-16le'" },
    ], body: { attachmentId: 'external-html', size: Buffer.byteLength(html, 'utf16le') } }
    const native = { id: 'external-body', threadId: 'external-thread', internalDate: '1767225600000',
      labelIds: ['INBOX', 'UNREAD'], snippet: 'Native summary', payload: { mimeType: 'multipart/mixed', parts: [
        { partId: '0', mimeType: 'multipart/alternative', parts: [plainPart, htmlPart,
          { partId: '0.2', mimeType: 'text/plain', body: { attachmentId: 'unused-alternative' } }] },
        { partId: '1', mimeType: 'text/plain', filename: 'note.txt',
          headers: [{ name: 'Content-Disposition', value: 'attachment' }], body: { attachmentId: 'text-file', size: BINARY.byteLength } },
        { partId: '2', mimeType: 'image/png', filename: 'inline.png', headers: [
          { name: 'Content-Disposition', value: 'inline' }, { name: 'Content-ID', value: '<body-inline>' },
        ], body: { attachmentId: 'inline-image', size: BINARY.byteLength } },
        { partId: '3', mimeType: 'message/rfc822', filename: 'attached.eml', body: { attachmentId: 'attached-message' },
          parts: [{ partId: '3.0', mimeType: 'text/html', body: { attachmentId: 'nested-body' } }] },
      ] } }
    const base = '/gmail/v1/users/me'
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      expect(url.origin).toBe('https://gmail.invalid')
      expect(init?.method ?? 'GET').toBe('GET')
      const message = htmlOnly ? { ...native, payload: htmlPart } : native
      if (url.pathname === `${base}/profile`) return Response.json({ emailAddress: PRIMARY, historyId: '100' })
      if (url.pathname === `${base}/labels/INBOX`) return Response.json({ messagesUnread: 1 })
      if (url.pathname === `${base}/labels`) return Response.json({ labels: [{ id: 'INBOX', name: 'Inbox' }] })
      if (url.pathname === `${base}/messages`) return Response.json({ messages: [{ id: native.id, threadId: native.threadId }] })
      if (url.pathname === `${base}/threads`) return Response.json({ threads: [{ id: native.threadId }] })
      if (url.pathname === `${base}/messages/${native.id}`) return Response.json(message)
      if (url.pathname === `${base}/threads/${native.threadId}`) return Response.json({ id: native.threadId, messages: [message] })
      if (url.pathname === `${base}/history`) return Response.json({ historyId: '101', history: [{ messagesAdded: [{ message: { id: native.id } }] }] })
      const prefix = `${base}/messages/${native.id}/attachments/`
      if (url.pathname.startsWith(prefix)) {
        const id = decodeURIComponent(url.pathname.slice(prefix.length))
        downloads.push(id)
        if (id === 'text-file') return Response.json({ data: Buffer.from(BINARY).toString('base64url') })
        if (id === 'external-text' || id === 'external-html') {
          if (bodyFailure === 'missing') return Response.json({ error: { message: 'Missing body part' } }, { status: 404 })
          if (bodyFailure === 'malformed') return Response.json({ size: 10 })
          return Response.json({ data: (id === 'external-text' ? Buffer.from(text, 'latin1') : Buffer.from(html, 'utf16le')).toString('base64url') })
        }
      }
      throw new Error('Unexpected body hydration request')
    }) as typeof fetch
    const provider = await definition.create({ accountId: 'gmail-bodies', accessToken: 'offline-token',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'], baseUrl: 'https://gmail.invalid/gmail/v1', fetch: fetcher })
    try {
      await provider.getAccount()
      await provider.listFolders()
      expect(downloads).toEqual([])
      for (const read of [
        () => provider.getMessage(native.id),
        async () => (await provider.getThread(native.threadId)).messages[0]!,
        async () => (await provider.listMessages({ folder: 'inbox' })).items[0]!,
        async () => (await provider.listThreads({ folder: 'inbox' })).items[0]!.messages[0]!,
        async () => (await provider.sync(null, { folder: 'inbox' })).messages[0]!,
        async () => (await provider.sync({ provider: 'gmail', kind: 'history', value: '100', folder: 'inbox',
          metadata: { accountId: provider.accountId } })).messages[0]!,
      ]) {
        downloads.length = 0
        const message = await read()
        expect(message).toMatchObject({ id: native.id, threadId: native.threadId, accountId: provider.accountId,
          bodyText: text, preview: 'Native summary', isRead: false })
        expect(message.bodyHtml).toContain('HTML \u65e5\u672c\u8a9e caf\u00e9')
        expect(message.bodyHtml).toContain('src="cid:body-inline"')
        expect(message.attachments.map(attachment => attachment.id)).toEqual(['part:1', 'part:2', 'part:3'])
        expect(message.attachments[1]).toMatchObject({ filename: 'inline.png', inline: true, contentId: 'body-inline' })
        expect(downloads).toEqual(['external-text', 'external-html'])
      }
      downloads.length = 0
      const attachment = await provider.getAttachment(native.id, 'part:1')
      expect(attachment.content).toEqual(BINARY)
      expect(attachment.attachment.id).toBe('part:1')
      expect(downloads).toEqual(['text-file'])
      htmlOnly = true
      const fallback = await provider.getMessage(native.id)
      expect(fallback.bodyHtml).toBe(html)
      expect(fallback.bodyText.trim()).toBe('HTML \u65e5\u672c\u8a9e caf\u00e9')
      expect(fallback.attachments).toEqual([])
      bodyFailure = 'missing'
      await failure(() => provider.getMessage(native.id), 'UPSTREAM', true)
      await failure(() => provider.listMessages(), 'UPSTREAM', true)
      bodyFailure = 'malformed'
      await failure(() => provider.getMessage(native.id), 'UPSTREAM', false)
    } finally { await provider.disconnect() }
  })

  test('native page-token errors reset snapshots and expire list cursors without hiding other failures', async () => {
    const definition = builtInProviders.find(provider => provider.id === 'gmail')!
    const calls: URL[] = []
    const folder = 'Label_custom'
    let historyId = 100
    let rejection: { status: number; body: unknown } | undefined
    let rejectFirstPage = false
    const natives = ['first', 'second'].map(id => ({ id, threadId: `${id}-thread`, internalDate: '1767225600000',
      labelIds: [folder], payload: { mimeType: 'text/plain', body: { data: Buffer.from(id).toString('base64url') } } }))
    const base = '/gmail/v1/users/me'
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      expect(url.origin).toBe('https://gmail.invalid')
      expect(init?.method ?? 'GET').toBe('GET')
      calls.push(url)
      if (url.pathname === `${base}/profile`) return Response.json({ historyId: String(++historyId) })
      if (url.pathname === `${base}/messages` || url.pathname === `${base}/threads`) {
        expect(url.searchParams.get('labelIds')).toBe(folder)
        expect(url.searchParams.get('maxResults')).toBe('1')
        const continued = url.searchParams.has('pageToken')
        if (rejection && (continued || rejectFirstPage)) return Response.json(rejection.body, { status: rejection.status })
        const message = natives[continued ? 1 : 0]!
        return Response.json({ ...(url.pathname.endsWith('/threads') ? { threads: [{ id: message.threadId }] }
          : { messages: [{ id: message.id, threadId: message.threadId }] }),
          ...(!continued ? { nextPageToken: `page-${historyId}` } : {}) })
      }
      for (const message of natives) {
        if (url.pathname === `${base}/messages/${message.id}`) return Response.json(message)
        if (url.pathname === `${base}/threads/${message.threadId}`) return Response.json({ id: message.threadId, messages: [message] })
      }
      throw new Error('Unexpected pagination request')
    }) as typeof fetch
    const credentials = { accountId: 'gmail-pagination', accessToken: 'offline-token',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'], baseUrl: 'https://gmail.invalid/gmail/v1', fetch: fetcher }
    const provider = await definition.create(credentials)
    const other = await definition.create({ ...credentials, accountId: 'gmail-pagination-other' })
    const options = { folder, limit: 1 }
    try {
      for (const body of [
        { error: { message: 'Invalid pageToken.' } },
        { error: { message: 'Page token has expired.' } },
        { error: { message: 'Invalid value for \'pageToken\'.' } },
        { error: { message: 'Invalid Value', errors: [{ reason: 'invalid', location: 'pageToken', locationType: 'parameter' }] } },
        { error: { message: 'Request rejected', errors: [{ reason: 'invalidPageToken' }] } },
      ]) {
        rejection = undefined
        const first = await provider.sync(null, options)
        expect(first.cursor).toMatchObject({ kind: 'page', folder, metadata: { accountId: provider.accountId } })
        const before = calls.length
        await failure(() => other.sync(first.cursor, options), 'INVALID_CURSOR', false)
        await failure(() => provider.sync(first.cursor, { ...options, folder: 'inbox' }), 'INVALID_CURSOR', false)
        expect(calls).toHaveLength(before)
        rejection = { status: 400, body }
        const reset = await provider.sync(first.cursor, options)
        expect(reset).toMatchObject({ fullSync: true, hasMore: true, snapshotComplete: false, deletedMessageIds: [] })
        expect(reset.messages.map(message => message.id)).toEqual(['first'])
        expect(reset.cursor).toMatchObject({ kind: 'page', value: String(historyId), folder,
          metadata: { accountId: provider.accountId, pageToken: `page-${historyId}` } })
        expect(reset.cursor!.value).not.toBe(first.cursor!.value)
        expect(reset.recentCursor).toMatchObject({ kind: 'history', value: String(historyId), folder,
          metadata: { accountId: provider.accountId } })
        expect(reset.recentCursor!.metadata!.pageToken).toBeUndefined()
        expect(calls[before]!.searchParams.get('pageToken')).toBe(first.cursor!.metadata!.pageToken!)
        expect(calls[before + 1]!.pathname).toBe(`${base}/profile`)
        expect(calls[before + 2]!.searchParams.has('pageToken')).toBe(false)
        rejection = undefined
        const last = await provider.sync(reset.cursor, options)
        expect(last).toMatchObject({ fullSync: true, hasMore: false, snapshotComplete: true })
        expect(last.messages.map(message => message.id)).toEqual(['second'])
        for (const kind of ['messages', 'threads'] as const) {
          const list = kind === 'messages' ? provider.listMessages.bind(provider) : provider.listThreads.bind(provider)
          const page = await list({ ...options, search: 'contract', unreadOnly: true })
          const count = calls.length
          for (const changed of [{ folder: 'inbox' }, { search: 'other' }, { unreadOnly: false }]) {
            await failure(() => list({ ...options, search: 'contract', unreadOnly: true, cursor: page.nextCursor, ...changed }), 'INVALID_CURSOR', false)
          }
          expect(calls).toHaveLength(count)
          rejection = { status: 400, body }
          await failure(() => list({ ...options, search: 'contract', unreadOnly: true, cursor: page.nextCursor }), 'INVALID_CURSOR', false)
          expect(calls).toHaveLength(count + 1)
          expect(calls.at(-1)!.searchParams.get('q')).toBe('contract is:unread')
          rejection = undefined
        }
      }
      const first = await provider.sync(null, options)
      for (const [status, body, code, retryable] of [
        [400, { error: { message: 'Invalid Value', errors: [{ reason: 'invalid', location: 'labelIds' }] } }, 'VALIDATION', false],
        [400, { error: { message: 'Invalid query: pageToken', errors: [{ reason: 'invalidArgument', location: 'q' }] } }, 'VALIDATION', false],
        [400, { error: { message: 'Request contains an invalid argument.', errors: [{ reason: 'invalidArgument' }] } }, 'VALIDATION', false],
        [401, { error: { message: 'Invalid pageToken.' } }, 'AUTHENTICATION', false],
        [403, { error: { message: 'Invalid pageToken.' } }, 'AUTHORIZATION', false],
        [503, { error: { message: 'Invalid pageToken.' } }, 'UPSTREAM', true],
      ] as const) {
        rejection = { status, body }
        const before = calls.length
        await failure(() => provider.sync(first.cursor, options), code, retryable)
        expect(calls).toHaveLength(before + 1)
      }
      rejectFirstPage = true
      rejection = { status: 400, body: { error: { message: 'Invalid pageToken.' } } }
      const before = calls.length
      await failure(() => provider.sync(null, options), 'VALIDATION', false)
      expect(calls).toHaveLength(before + 2)
    } finally { await Promise.all([provider.disconnect(), other.disconnect()]) }
  })
})
