import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib'
import { SaxesParser } from 'saxes'
import { createInbox } from '../src/core'
import { createInboxApi } from '../src/http'
import { createInboxClient } from '../src/client'
import { pinnedMediaNetwork } from '../src/media'
import { CredentialError, InboxError } from '../src/contracts'
import { createGoogleOAuthHost, type GoogleOAuthConfig, type OAuthAttempt } from '../server/google-oauth'
import { createGoogleOAuthApi } from '../server/google-oauth-api'
import { createGoogleOAuthClient } from '../server/google-client'
import { createLocalHost } from '../../../apps/local-host/src/host'
import { loadLocalConfig } from '../../../apps/local-host/src/config'
import { createAttentionFeedbackStore } from '../../../apps/local-host/src/attention-feedback'
import { createSplitPreferencesStore } from '../../../apps/local-host/src/split-preferences'
import { classifyAttention } from '../../../apps/shared/mail-attention'
import { normalizeSplits } from '../../../apps/shared/splits'
import { mailFacts } from '../src/mail-facts'
import { createMockHost } from '../../../apps/mock-api/src/host'
import type {
  Account, BlobInfo, ChangeEvent, ChangePage, Connection, Draft, Folder, Inbox, InboxOptions,
  Label, Mailbox, MailboxCandidate, MailboxMembership, MailboxMessageSummary, Message,
  MessageSummary, Operation, Page, Policy, ProviderDefinition, Query,
  ThreadSummary, MediaNetwork,
} from '../src/contracts'
import {
  ProviderAuthenticationError, ProviderCursorExpiredError, ProviderError,
  ProviderNotFoundError, ProviderRateLimitError, UnsupportedOperationError,
} from '../server/sdk/types'
import type { ConnectionSources } from '../server/sdk/mail-sources'
import type {
  Attachment, AttachmentData, InboxProvider, MailAccount, MailMessage, MailThread,
  MessageMutation, Participant, ProviderCapabilities, ProviderCredentials,
  ProviderFolder, SendInput, SendResult, SyncCursor, SyncOptions, SyncResult,
} from '../server/sdk/types'

const TEMP_ROOT = '/private/var/folders/2j/6mslx1715gx8frsyn66sf1sh0000gn/T/opencode'
const FULL = 'reference-mail'
const RESTRICTED = 'reference-read-only'
const DYNAMIC = 'unanticipated-provider-2026'
const SCOPED = 'reference-inbound-scopes'
const EPOCH = Date.parse('2026-09-01T12:00:00.000Z')
const KEY = Buffer.alloc(32, 37).toString('base64')
const SECRET = 'synthetic-access-token-do-not-disclose'
const BODY_SECRET = 'PRIVATE-BODY-not-for-logs-or-list-pages'
const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  const tasks = cleanup.splice(0).reverse()
  for (const task of tasks) await task()
})

describe('Attention baseline and explicit feedback', () => {
  test('application routes persist filtered splits and W/Undo behind the existing host owner/origin boundary', async () => {
    const root = await mkdtemp(join(TEMP_ROOT, 'attention-host-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const config = loadLocalConfig({ configPath: join(root, 'local.json'), environment: {} })
    const host = await createLocalHost({ ...config, dataDir: join(root, 'runtime'), allowProviderWrites: false }, {})
    cleanup.push(() => host.close())
    const base = `http://localhost:${config.backend.port}`, origin = config.web.origin
    const session = await host.fetch(new Request(`${base}/session`, { method: 'POST', headers: { Origin: origin, 'X-Superlocal': '1' } }))
    const headers = { Origin: origin, Cookie: session.headers.get('set-cookie')!.split(';')[0]!, 'Content-Type': 'application/json' }
    const route = (path: string, method = 'GET', body?: unknown) => host.fetch(new Request(`${base}/host/${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) }))
    expect((await host.fetch(new Request(`${base}/host/attention-feedback`))).status).toBe(401)
    expect((await host.fetch(new Request(`${base}/host/attention-feedback`, { method: 'POST', headers: { ...headers, Origin: 'https://evil.test' }, body: '{}' }))).status).toBe(403)
    expect(await (await route('split-preferences')).json()).toBeNull()
    const saved = await route('split-preferences', 'PUT', { ...normalizeSplits({ splits: ['Important', 'Other', 'John'], splitRules: { John: 'from:john@doe.com' } }), revision: 0 })
    expect(saved.status).toBe(200)
    expect(await (await route('split-preferences')).json()).toMatchObject({ revision: 1, splitRules: { John: 'from:john@doe.com' } })
    const mailbox = (await host.inbox.mailboxes(host.owner))[0]!
    const message = (await host.inbox.mailboxMessages(host.owner, { mailboxIds: [mailbox.id], folder: 'inbox', limit: 1 })).items[0]!
    const target = { sourceId: message.sourceId, mailboxId: mailbox.id, messageId: message.id, messageRevision: message.revision, revision: message.memberships[0]!.revision }
    const decision = classifyAttention(message)
    const response = await route('attention-feedback', 'POST', { id: 'host-negative-feedback-001', targets: [target] })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'active', count: 1 })
    const done = await host.inbox.mailboxMessage(host.owner, mailbox.id, message.id)
    expect(done.memberships[0]!.done).toBe(true)
    expect(classifyAttention(done)).toEqual(decision)
    expect((await route('attention-feedback/host-negative-feedback-001/undo', 'POST')).status).toBe(200)
    expect((await host.inbox.mailboxMessage(host.owner, mailbox.id, message.id)).memberships[0]!.done).toBe(false)
    expect((await (await route('attention-feedback')).json())[0].status).toBe('retracted')
  })

  test('actual offline mock adapter carries newsletter, transaction, and direct evidence through SDK sync', async () => {
    const root = await mkdtemp(join(TEMP_ROOT, 'attention-mock-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const host = await createMockHost({ dataDir: root, encryptionKey: KEY, token: SECRET, allowProviderWrites: false })
    cleanup.push(() => host.close())
    const connection = (await host.inbox.connections(host.owner))[0]!
    const scope = { owner: host.owner, storeId: connection.identity!.subject, accountId: connection.sourceIds[0]! }
    for (const subject of ['Attention test newsletter', 'Attention test receipt', 'Attention test hello']) host.store.receive(scope, {
      from: 'john@doe.test', subject, text: 'A synthetic message',
      ...(subject.endsWith('hello') ? {} : { headers: { 'List-ID': '<updates.example.test>', 'List-Unsubscribe': '<mailto:leave@example.test>' } }),
    })
    await host.inbox.sync(host.owner, scope.accountId)
    const rows = (await host.inbox.messages(host.owner, { accountId: scope.accountId, search: 'subject:"Attention test"' })).items
    expect(rows).toHaveLength(3)
    expect(Object.fromEntries(rows.map(message => [message.subject, classifyAttention(message).category]))).toEqual({
      'Attention test newsletter': 'Other', 'Attention test receipt': 'Important', 'Attention test hello': 'Important',
    })
    // Exercise the real HTTP output schemas/client, not just the core: additive
    // facts must not be stripped before the UI receives its body-free summaries.
    const client = createInboxClient({ baseUrl: 'http://localhost', headers: { authorization: `Bearer ${SECRET}` },
      fetch: Object.assign((input: Parameters<typeof fetch>[0], init?: RequestInit) => host.fetch(new Request(input, init)), { preconnect() {} }) })
    const boxes = (await client.mailboxes()).filter(box => box.sourceId === scope.accountId)
    const viaMailbox = (await client.mailboxMessages({ mailboxIds: boxes.map(box => box.id), search: 'subject:"Attention test"' })).items
    const viaMessages = (await client.messages({ accountId: scope.accountId, search: 'subject:"Attention test"' })).items
    for (const page of [viaMailbox, viaMessages]) {
      expect(page).toHaveLength(3)
      expect(Object.fromEntries(page.map(message => [message.subject, classifyAttention(message).category]))).toEqual({
        'Attention test newsletter': 'Other', 'Attention test receipt': 'Important', 'Attention test hello': 'Important',
      })
      expect(page.every(message => message.facts?.version === 1)).toBe(true)
    }
    const newsletter = viaMailbox.find(message => message.subject.endsWith('newsletter'))!
    expect((await client.mailboxMessage(boxes[0]!.id, newsletter.id)).facts).toEqual(newsletter.facts)
    expect((await client.message(newsletter.id)).facts).toEqual(newsletter.facts)
  })

  test('normalized facts classify locally before body reads, preserve uncertain and transactional mail, and qualify old cached rows', async () => {
    const h = await fixture({ allowProviderWrites: false })
    const { account, box } = await h.seed('alice', 'attention-facts', [
      native('newsletter', { subject: 'Weekly digest', preview: 'The latest news', bodyHtml: '<p>News</p><a href="https://example.test/unsubscribe">Unsubscribe</a>', headers: { 'List-ID': '<weekly.example.test>', 'List-Unsubscribe': '<https://example.test/unsubscribe>' } }),
      native('receipt', { subject: 'Your receipt', preview: 'Payment received', headers: { 'List-Unsubscribe': '<https://example.test/unsubscribe>', Precedence: 'bulk' }, nativeCategories: ['promotions'] }),
      native('direct', { subject: 'Can we meet tomorrow?', preview: 'A personal question' }),
      native('reply', { subject: 'Re: Weekly digest', inReplyTo: '<conversation@example.test>', nativeCategories: ['promotions'] }),
      native('promotion', { subject: 'Campaign', nativeCategories: ['promotions'], folderIds: ['inbox', 'native-promotions'] }),
    ])
    const before = structuredClone(box.calls)
    const summaries = (await h.inbox.messages('alice', { accountId: account.id })).items
    const decisions = Object.fromEntries(summaries.map(message => [message.subject, classifyAttention(message).category]))
    expect(decisions).toEqual({ 'Weekly digest': 'Other', 'Your receipt': 'Important', 'Can we meet tomorrow?': 'Important', 'Re: Weekly digest': 'Important', Campaign: 'Other' })
    for (const message of summaries) expect(classifyAttention(await h.inbox.message('alice', message.id))).toEqual(classifyAttention(message))
    expect(JSON.stringify(summaries)).not.toContain('<p>News</p>')
    const database = new Database(h.database)
    database.exec("UPDATE sdk_messages SET confirmed=json_remove(confirmed,'$.facts'),visible=json_remove(visible,'$.facts')")
    database.close()
    await h.restart()
    const cached = (await h.inbox.messages('alice', { accountId: account.id })).items
    expect(classifyAttention(cached.find(message => message.subject === 'Weekly digest')!).category).toBe('Other')
    expect(cached.find(message => message.subject === 'Weekly digest')!.facts?.listId).toBeUndefined()
    expect(classifyAttention(cached.find(message => message.subject === 'Campaign')!).category).toBe('Other')
    expect(box.calls).toEqual({ ...before, disconnect: before.disconnect + 1 })
    for (const provider of ['gmail', 'inbound', 'imap', 'mock']) {
      const facts = mailFacts({ headers: { 'list-id': '<news.example.test>', 'list-unsubscribe': '<mailto:leave@example.test>' } })
      expect(classifyAttention({ subject: `${provider} newsletter`, preview: '', facts }).category).toBe('Other')
      for (const subject of ['Your password reset', 'Security alert', 'Invoice 123', 'Your order confirmation', 'Please reply today']) expect(classifyAttention({ subject, preview: '', facts }).category).toBe('Important')
    }
    expect(classifyAttention({ subject: 'Unsubscribe', preview: 'A lone word', facts: mailFacts({ headers: { 'auto-submitted': 'auto-generated' } }) }).category).toBe('Important')
    expect(classifyAttention({ subject: 'Discussion', preview: '', facts: mailFacts({ headers: { 'list-id': '<list>', 'list-unsubscribe': '<mailto:leave@test>', 'list-post': '<mailto:post@test>' } }) }).category).toBe('Important')
  })

  test('W is durable collection only; E is unlabeled; atomic retry, restart, Undo, newer replies and owner isolation', async () => {
    const h = await fixture({ allowProviderWrites: false })
    const { account, box } = await h.seed('alice', 'feedback-local', [native('one', { subject: 'Weekly newsletter', bodyHtml: '<a href="https://example.test/unsubscribe">Unsubscribe</a>' }), native('two')])
    const mailbox = (await h.inbox.mailboxes('alice')).find(value => value.sourceId === account.id)!
    const rows = (await h.inbox.mailboxMessages('alice', { mailboxIds: [mailbox.id] })).items
    const database = new Database(join(h.directory, 'feedback.sqlite'))
    cleanup.push(async () => { database.close() })
    let feedback = createAttentionFeedbackStore(database, h.inbox, 'alice')
    const targets = rows.map(message => ({ sourceId: account.id, mailboxId: mailbox.id, messageId: message.id, revision: message.memberships[0]!.revision, messageRevision: message.revision }))
    const id = 'explicit-negative-event-0001'
    const decisions = rows.map(classifyAttention)
    const before = structuredClone(box.calls)
    const result = await feedback.record({ id, targets })
    expect(result).toMatchObject({ status: 'active', count: 2 })
    expect(await feedback.record({ id, targets })).toEqual(result)
    await expect(feedback.record({ id, targets: targets.slice(0, 1) })).rejects.toMatchObject({ status: 409 })
    await h.restart()
    feedback = createAttentionFeedbackStore(database, h.inbox, 'alice')
    expect((await feedback.list())[0]).toEqual(result)
    expect((await h.inbox.mailboxMessages('alice', { mailboxIds: [mailbox.id] })).items.every(message => message.memberships[0]!.done)).toBe(true)
    expect((await h.inbox.mailboxMessages('alice', { mailboxIds: [mailbox.id] })).items.map(classifyAttention)).toEqual(decisions)
    const other = createAttentionFeedbackStore(database, h.inbox, 'bob')
    expect(await other.list()).toEqual([])
    await expect(other.undo(id)).rejects.toMatchObject({ status: 404 })
    await expect(other.record({ id: 'cross-owner-negative-001', targets })).rejects.toMatchObject({ status: 404 })
    expect((await feedback.undo(id)).status).toBe('retracted')
    expect((await feedback.undo(id)).status).toBe('retracted')
    expect((await h.inbox.mailboxMessages('alice', { mailboxIds: [mailbox.id] })).items.every(message => !message.memberships[0]!.done)).toBe(true)
    // E remains the existing local Done path and writes no feedback event.
    const current = await h.inbox.mailboxMessage('alice', mailbox.id, rows[0]!.id)
    await h.inbox.setMailboxState('alice', mailbox.id, current.id, { done: true }, current.memberships[0]!.revision)
    expect((await feedback.list())).toHaveLength(1)
    expect(box.calls).toEqual({ ...before, disconnect: before.disconnect + 1 })
  })

  test('pending feedback resumes an already committed SDK receipt without duplicate state writes; failed batches are atomic', async () => {
    const h = await fixture({ allowProviderWrites: false })
    const { account, box } = await h.seed('alice', 'feedback-recovery', [native('one'), native('two')])
    const mailbox = (await h.inbox.mailboxes('alice')).find(value => value.sourceId === account.id)!
    const rows = (await h.inbox.mailboxMessages('alice', { mailboxIds: [mailbox.id] })).items
    const targets = rows.map(message => ({ sourceId: account.id, mailboxId: mailbox.id, messageId: message.id, revision: message.memberships[0]!.revision, messageRevision: message.revision }))
    await expect(h.inbox.setMailboxStates('alice', { id: 'bad-atomic-batch', targets: targets.map(({ mailboxId, messageId, revision }, index) => ({ mailboxId, messageId, revision: index ? 999 : revision })), done: true })).rejects.toMatchObject({ status: 412 })
    expect((await h.inbox.mailboxMessages('alice', { mailboxIds: [mailbox.id] })).items.every(message => !message.memberships[0]!.done)).toBe(true)
    const database = new Database(join(h.directory, 'feedback.sqlite'))
    cleanup.push(async () => { database.close() })
    let feedback = createAttentionFeedbackStore(database, h.inbox, 'alice')
    const original = h.inbox.setMailboxStates
    h.inbox.setMailboxStates = async (...args) => { await original(...args); throw new InboxError('INTERNAL', 'Simulated lost response', 500) }
    await expect(feedback.record({ id: 'lost-response-negative-001', targets })).rejects.toMatchObject({ status: 500 })
    h.inbox.setMailboxStates = original
    await h.restart()
    feedback = createAttentionFeedbackStore(database, h.inbox, 'alice')
    expect((await feedback.list())[0]).toMatchObject({ status: 'active', count: 2 })
    const current = (await h.inbox.mailboxMessages('alice', { mailboxIds: [mailbox.id] })).items
    expect(current.every(message => message.memberships[0]!.revision === 2)).toBe(true)
    expect((await feedback.undo('lost-response-negative-001')).status).toBe('retracted')
    expect(box.calls.mutate).toHaveLength(0)
  })

  test('feedback deduplicates overlapping memberships, separates sources, and never absorbs a later reply', async () => {
    const h = await fixture({ allowProviderWrites: false })
    h.discoveries.set('feedback-scoped', { sources: ['alpha.example.test', 'beta.example.test'].map(value => ({ kind: 'domain' as const, value, canReceive: true, canSend: false, canFilter: true })), identities: [] })
    const scoped = await h.connect('alice', 'feedback-scoped', [native('same', { sourceDomains: ['alpha.example.test', 'beta.example.test'] })], SCOPED)
    const boxes = await Promise.all(['alpha.example.test', 'beta.example.test'].map(value => h.inbox.createMailbox('alice', { sourceId: scoped.account.id, name: value, selector: { kind: 'domain', value } })))
    await h.sync('alice', scoped.account.id)
    const separate = await h.seed('alice', 'feedback-separate', [native('same')])
    const mailboxIds = (await h.inbox.mailboxes('alice')).map(value => value.id)
    const rows = (await h.inbox.mailboxMessages('alice', { mailboxIds })).items
    expect(rows).toHaveLength(2)
    const targets = rows.flatMap(message => message.memberships.map(state => ({ sourceId: message.sourceId, messageId: message.id, messageRevision: message.revision, mailboxId: state.mailboxId, revision: state.revision })))
    expect(targets).toHaveLength(3)
    const database = new Database(':memory:')
    try {
      const feedback = createAttentionFeedbackStore(database, h.inbox, 'alice')
      expect(await feedback.record({ id: 'overlapping-negative-001', targets })).toMatchObject({ count: 2, status: 'active' })
      scoped.box.put(native('new-reply', { threadId: 'native-thread-same', inReplyTo: '<same@example.test>', sourceDomains: ['alpha.example.test', 'beta.example.test'] }))
      await h.sync('alice', scoped.account.id)
      const after = (await h.inbox.mailboxMessages('alice', { mailboxIds: boxes.map(box => box.id) })).items
      const added = after.find(message => !rows.some(original => original.id === message.id))!
      expect(added.memberships.every(state => !state.done)).toBe(true)
      expect(classifyAttention(added).category).toBe('Important')
      expect((await feedback.list())[0]!.count).toBe(2)
      await feedback.undo('overlapping-negative-001')
      expect((await h.inbox.mailboxMessages('alice', { mailboxIds })).items.every(message => message.memberships.every(state => !state.done))).toBe(true)
      expect(scoped.box.calls.mutate).toHaveLength(0)
      expect(separate.box.calls.mutate).toHaveLength(0)
    } finally { database.close() }
  })

  test('host split preferences preserve authored filters and unrelated preferences, persist reloads, and isolate owners', async () => {
    const database = new Database(':memory:')
    try {
      const store = createSplitPreferencesStore(database, 'alice')
      const legacy = { splits: ['Important', 'Github', 'Inbound', 'Calendar', 'Other', 'John'], splitRules: { John: 'from:john@doe.com' }, theme: 'custom', pinnedMailboxIds: ['keep'] }
      const migrated = normalizeSplits(legacy)
      expect(migrated.splits).toEqual(['Important', 'Other', 'John'])
      expect(legacy.theme).toBe('custom')
      expect(legacy.pinnedMailboxIds).toEqual(['keep'])
      const value = store.write({ ...migrated, revision: 0 })
      expect(createSplitPreferencesStore(database, 'alice').read()).toEqual(value)
      expect(createSplitPreferencesStore(database, 'bob').read()).toBeNull()
      expect(() => store.write({ ...value, revision: 0 })).toThrow()
      const renamed = store.write({ ...value, splits: ['Important', 'Other', 'Johnny'], splitRules: { Johnny: 'from:john@doe.com' } })
      expect(renamed.splitRules.Johnny).toBe('from:john@doe.com')
      expect(store.write({ ...renamed, splits: ['Important', 'Other'], splitRules: {} }).splits).toEqual(['Important', 'Other'])
      expect(normalizeSplits({ ...legacy, splitRules: { Github: 'from:custom@example.test', John: 'from:john@doe.com' } }).splits).toContain('Github')
    } finally { database.close() }
  })
})

describe('IMAP host onboarding boundary', () => {
  test('fresh checkout stays offline; real iCloud onboarding is explicit, encrypted-SDK-only and endpoint constrained', async () => {
    const root = await mkdtemp(join(TEMP_ROOT, 'imap-host-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const config = loadLocalConfig({ configPath: join(root, 'local.json'), environment: {} })
    expect(config.mode).toBe('mock')
    expect(config.providers.gmail.enabled).toBe(false)
    expect(config.providers.inbound.enabled).toBe(false)
    const host = await createLocalHost({ ...config, mode: 'real', dataDir: join(root, 'runtime') }, {})
    cleanup.push(() => host.close())
    const origin = config.web.origin
    const base = `http://localhost:${config.backend.port}`
    const session = await host.fetch(new Request(`${base}/session`, { method: 'POST', headers: { Origin: origin, 'X-Superlocal': '1' } }))
    const cookie = session.headers.get('set-cookie')!.split(';')[0]!
    const headers = { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }
    const descriptor = await (await host.fetch(new Request(`${base}/host/config`, { headers }))).json()
    expect(descriptor.providers).toEqual([expect.objectContaining({ id: 'imap', ready: true, mailboxSelection: 'automatic', reconnect: true,
      fields: [expect.objectContaining({ name: 'email', type: 'email' }), expect.objectContaining({ name: 'password', label: 'App-specific password', type: 'password' })] })])
    expect(await host.inbox.accounts(host.owner)).toEqual([])
    let captured: any
    const original = host.inbox.createConnection
    host.inbox.createConnection = async (_owner, input, identity) => { captured = { input, identity }; return { id: 'synthetic-connection' } as Connection }
    try {
      const path = `${base}/host/providers/imap/connect`
      const password = '  synthetic\tmail-password  '
      const connected = await host.fetch(new Request(path, { method: 'POST', headers, body: JSON.stringify({ credentials: { email: 'reader@icloud.com', password } }) }))
      expect(connected.status).toBe(200)
      expect(captured.input.credentials.password).toBe(password)
      expect(captured.identity.issuer).toBe('imaps://imap.mail.me.com:993')
      expect(captured.identity.subject).toBe('reader@icloud.com')
      expect(await connected.json()).toEqual({ connectionId: 'synthetic-connection' })
      captured = null
      for (const credentials of [
        { email: 'reader@icloud.com', password, host: '127.0.0.1' },
        { email: 'reader@icloud.com', password, smtp: { host: '169.254.169.254' } },
        { email: 'reader@icloud.com', password, tls: { rejectUnauthorized: false } },
        { email: 'reader@icloud.com', password, preset: 'unconfigured-host' },
      ]) {
        expect((await host.fetch(new Request(path, { method: 'POST', headers, body: JSON.stringify({ credentials }) }))).status).toBe(400)
      }
      expect(captured).toBeNull()
      expect((await host.fetch(new Request(path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' }))).status).toBe(401)
      for (const [method, path] of [['POST', '/v1/connections'], ['POST', '/v1/accounts'], ['PUT', '/v1/connections/any/credentials'], ['POST', '/v1/accounts/any/reconnect']]) {
        expect((await host.fetch(new Request(`${base}${path}`, { method, headers, body: '{}' }))).status).toBe(403)
      }
    } finally { host.inbox.createConnection = original }
  })
})

const fullCapabilities: ProviderCapabilities = {
  sync: true, incrementalSync: true, deltaSync: true, send: true, reply: true,
  threads: true, nativeThreads: true, folders: true, createFolders: true,
  labels: true, archive: true, trash: true, permanentDelete: true, markRead: true,
  markUnread: true, star: true, attachments: true, attachmentDownload: true,
  search: true, drafts: true, scheduledSend: true, snooze: true,
  readReceipts: true, pushNotifications: true,
}
const restrictedCapabilities: ProviderCapabilities = {
  ...fullCapabilities,
  send: false, reply: false, nativeThreads: false, createFolders: false,
  labels: false, archive: false, trash: false, permanentDelete: false,
  markRead: false, markUnread: false, star: false, attachments: false,
  search: false, drafts: false, scheduledSend: false, snooze: false,
  readReceipts: false, pushNotifications: false,
}

function participant(email: string, name = email): Participant { return { email, name } }

function native(id: string, input: Partial<MailMessage> = {}): MailMessage {
  return {
    id, accountId: 'upstream-account', threadId: `native-thread-${id}`,
    from: participant('sender@example.test', 'Sender'),
    to: [participant('reader@example.test')], cc: [], bcc: [],
    subject: `Subject ${id}`, preview: `Preview ${id}`,
    bodyText: `Body ${id}`, bodyHtml: `<p>Body ${id}</p>`,
    receivedAt: new Date(EPOCH - 60_000).toISOString(),
    isRead: false, isStarred: false, folder: 'inbox', labels: [], attachments: [],
    ...input,
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

// The timeout is a deadlock watchdog, not a performance assertion.
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 4_000)
      }),
    ])
  } finally { clearTimeout(timer) }
}

function gate<T>(fallback: T) {
  const entered = deferred<void>()
  const release = deferred<T>()
  return {
    entered: entered.promise,
    wait: () => { entered.resolve(); return release.promise },
    release: (value: T = fallback) => release.resolve(value),
  }
}

type Receipt<T, A extends unknown[] = []> = T | Error | ((...args: A) => T | Promise<T>)

function referenceMailbox(key: string, email: string, seed: MailMessage[], aliases: string[] = []) {
  const messages = new Map(seed.map(message => [message.id, structuredClone(message)]))
  const attachments = new Map<string, AttachmentData>()
  const history: Array<{ sequence: number; message?: MailMessage; deleted?: string }> = []
  const syncReceipts: Array<Receipt<SyncResult>> = []
  const sendReceipts: Array<Receipt<SendResult, [SendInput]>> = []
  const mutationReceipts = new Map<string, Array<Receipt<MailMessage | null, [MessageMutation, MailMessage]>>>()
  let sequence = 1
  let sent = 0
  const folderRows: ProviderFolder[] = ['inbox', 'sent', 'archive', 'trash', 'spam'].map(role => ({
    id: `native-folder-${role}`, name: role, folder: role,
  }))
  const calls = {
    create: [] as Array<Record<string, unknown>>,
    getAccount: 0, listFolders: 0, listMessages: 0, listThreads: 0,
    getMessage: [] as string[], getThread: [] as string[], disconnect: 0,
    createFolder: [] as string[],
    sync: [] as Array<{ cursor: SyncCursor | string | null; options: SyncOptions }>,
    send: [] as SendInput[],
    mutate: [] as Array<{ id: string; changes: MessageMutation }>,
    attachment: [] as Array<{ messageId: string; attachmentId: string; contentId?: string }>,
  }
  const put = (message: MailMessage) => {
    messages.set(message.id, structuredClone(message))
    history.push({ sequence: ++sequence, message: structuredClone(message) })
  }
  const remove = (id: string) => {
    messages.delete(id)
    history.push({ sequence: ++sequence, deleted: id })
  }
  const read = (id: string) => {
    const message = messages.get(id)
    if (!message) throw new ProviderNotFoundError(FULL, 'Missing upstream message')
    return structuredClone(message)
  }
  const threadRows = (accountId: string): MailThread[] => {
    const groups = new Map<string, MailMessage[]>()
    for (const message of messages.values()) {
      const group = groups.get(message.threadId) ?? []
      group.push({ ...structuredClone(message), accountId })
      groups.set(message.threadId, group)
    }
    return [...groups].map(([id, group]) => {
      group.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id))
      const first = group[0]!
      const last = group[group.length - 1]!
      return {
        id, accountId, subject: first.subject, preview: last.preview,
        participants: group.flatMap(message => [message.from, ...message.to, ...message.cc]),
        messages: group, messageCount: group.length, lastMessageAt: last.receivedAt,
        isRead: group.every(message => message.isRead),
        isStarred: group.some(message => message.isStarred), folder: last.folder,
        labels: [...new Set(group.flatMap(message => message.labels))],
        hasAttachments: group.some(message => message.attachments.length > 0),
      }
    })
  }
  const receive = async <T, A extends unknown[]>(receipt: Receipt<T, A>, ...args: A): Promise<T> => {
    if (receipt instanceof Error) throw receipt
    return typeof receipt === 'function'
      ? await (receipt as (...values: A) => T | Promise<T>)(...args)
      : structuredClone(receipt)
  }
  const recipients = (value: SendInput['to'] | undefined): Participant[] => {
    if (value === undefined) return []
    return (Array.isArray(value) ? value : [value]).map(item => {
      if (typeof item !== 'string') return structuredClone(item)
      const address = item.match(/<([^>]+)>/)?.[1] ?? item.trim()
      return participant(address)
    })
  }
  return {
    key, email, aliases, calls, put, remove,
    nextSync: (receipt: Receipt<SyncResult>) => { syncReceipts.push(receipt) },
    nextSend: (receipt: Receipt<SendResult, [SendInput]>) => { sendReceipts.push(receipt) },
    nextMutation: (id: string, receipt: Receipt<MailMessage | null, [MessageMutation, MailMessage]>) => {
      const queue = mutationReceipts.get(id) ?? []
      queue.push(receipt)
      mutationReceipts.set(id, queue)
    },
    attachment: (messageId: string, attachment: Attachment, content: Uint8Array) => {
      attachments.set(`${messageId}\0${attachment.id}`, {
        attachment: structuredClone(attachment), content: content.slice(),
        filename: attachment.filename, contentType: attachment.contentType,
      })
    },
    adapter(credentials: ProviderCredentials & Record<string, unknown>, type: string, capabilities: ProviderCapabilities): InboxProvider {
      calls.create.push({ ...credentials, fetch: undefined })
      const accountId = credentials.accountId
      return {
        type, accountId, capabilities: Object.freeze({ ...capabilities }),
        async getAccount(): Promise<MailAccount> {
          calls.getAccount++
          if (credentials.accessToken === 'expired') throw new ProviderAuthenticationError(type, `${SECRET}: expired`)
          return {
            id: accountId, name: key, email, aliases, provider: type,
            color: '#334455', syncStatus: 'connected', unreadCount: 0, capabilities,
          }
        },
        async listFolders() { calls.listFolders++; return structuredClone(folderRows) },
        async createFolder(name) {
          calls.createFolder.push(name)
          if (!capabilities.createFolders) throw new UnsupportedOperationError(type, 'createFolder')
          const row: ProviderFolder = { id: `custom-${folderRows.length}`, name, folder: `custom-${folderRows.length}`, custom: true }
          folderRows.push(row)
          return structuredClone(row)
        },
        async listMessages(options = {}) {
          calls.listMessages++
          const all = [...messages.values()].filter(message => !options.folder || message.folder === options.folder)
          const offset = Number(options.cursor ?? 0)
          const limit = options.limit ?? 50
          const items = all.slice(offset, offset + limit).map(message => ({ ...structuredClone(message), accountId }))
          const hasMore = offset + items.length < all.length
          return { items, hasMore, nextCursor: hasMore ? String(offset + items.length) : null, total: all.length }
        },
        async listThreads(options = {}) {
          calls.listThreads++
          const all = threadRows(accountId).filter(thread => !options.folder || thread.folder === options.folder)
          const offset = Number(options.cursor ?? 0)
          const items = all.slice(offset, offset + (options.limit ?? 50))
          const hasMore = offset + items.length < all.length
          return { items, hasMore, nextCursor: hasMore ? String(offset + items.length) : null, total: all.length }
        },
        async getMessage(id) { calls.getMessage.push(id); return { ...read(id), accountId } },
        async getThread(id) {
          calls.getThread.push(id)
          const row = threadRows(accountId).find(thread => thread.id === id)
          if (!row) throw new ProviderNotFoundError(type)
          return row
        },
        async sync(cursor = null, options = {}) {
          calls.sync.push({ cursor: structuredClone(cursor), options: structuredClone(options) })
          if (!capabilities.sync) throw new UnsupportedOperationError(type, 'sync')
          if (syncReceipts.length) {
            const result = await receive(syncReceipts.shift()!)
            return {
              ...result,
              messages: result.messages.map(message => ({ ...message, accountId })),
              threads: result.threads.map(thread => ({ ...thread, accountId, messages: thread.messages.map(message => ({ ...message, accountId })) })),
            }
          }
          const value = typeof cursor === 'string' ? cursor : cursor?.value
          const from = value ? Number(value.replace('v:', '')) : 0
          const delta = from ? history.filter(entry => entry.sequence > from) : []
          return {
            messages: (from ? delta.flatMap(entry => entry.message ? [entry.message] : []) : [...messages.values()])
              .map(message => ({ ...structuredClone(message), accountId })),
            threads: [], deletedMessageIds: delta.flatMap(entry => entry.deleted ? [entry.deleted] : []),
            cursor: { provider: type, kind: 'history', value: `v:${sequence}` },
            hasMore: false, fullSync: !cursor,
          }
        },
        async send(input) {
          calls.send.push(structuredClone(input))
          if (!capabilities.send) throw new UnsupportedOperationError(type, 'send')
          if (sendReceipts.length) return receive(sendReceipts.shift()!, input)
          const id = `native-sent-${++sent}`
          const threadId = input.threadId ?? `native-thread-${id}`
          const messageId = `<reference-${sent}@example.test>`
          put(native(id, {
            accountId, threadId, folder: 'sent', isRead: true, rfcMessageId: messageId,
            from: recipients(input.from ?? email)[0]!,
            to: recipients(input.to), cc: recipients(input.cc), bcc: recipients(input.bcc),
            subject: input.subject, bodyText: input.bodyText ?? input.text ?? input.body ?? '',
            bodyHtml: input.bodyHtml ?? input.html ?? '', receivedAt: new Date(EPOCH).toISOString(),
          }))
          return { id, threadId, messageId, accepted: recipients(input.to).map(item => item.email), rejected: [] }
        },
        async mutate(id, changes) {
          calls.mutate.push({ id, changes: structuredClone(changes) })
          if ((changes.isRead === true && !capabilities.markRead) || (changes.isRead === false && !capabilities.markUnread)
            || (changes.isStarred !== undefined && !capabilities.star) || (changes.isArchived !== undefined && !capabilities.archive)
            || (changes.deletePermanently && !capabilities.permanentDelete) || (changes.folder === 'trash' && !capabilities.trash)) {
            throw new UnsupportedOperationError(type, 'mutate')
          }
          const current = { ...read(id), accountId }
          const queue = mutationReceipts.get(id)
          if (queue?.length) {
            const result = await receive(queue.shift()!, changes, current)
            if (result) {
              const message = { ...result, accountId }
              put(message)
              return message
            }
            remove(id)
            return null
          }
          if (changes.deletePermanently) { remove(id); return null }
          const updated: MailMessage = {
            ...current,
            ...(changes.isRead === undefined ? {} : { isRead: changes.isRead }),
            ...(changes.isStarred === undefined ? {} : { isStarred: changes.isStarred }),
            ...(changes.folder === undefined ? {} : { folder: changes.folder }),
            ...(changes.isArchived === undefined ? {} : { folder: changes.isArchived ? 'archive' : 'inbox' }),
            ...(changes.snoozedUntil === undefined ? {} : { snoozedUntil: changes.snoozedUntil }),
            labels: [...new Set([...current.labels, ...(changes.addLabels ?? [])])]
              .filter(label => !changes.removeLabels?.includes(label)),
          }
          put(updated)
          return structuredClone(updated)
        },
        async getAttachment(messageId, attachmentId, contentId) {
          calls.attachment.push({ messageId, attachmentId, contentId })
          const result = attachments.get(`${messageId}\0${attachmentId}`)
          if (!result) throw new ProviderNotFoundError(type, 'Missing upstream attachment')
          return structuredClone(result)
        },
        async disconnect() { calls.disconnect++ },
      }
    },
  }
}

type ReferenceMailbox = ReturnType<typeof referenceMailbox>

function receipt(messages: MailMessage[], value: string, options: Partial<SyncResult> = {}): SyncResult {
  return {
    messages, threads: [], deletedMessageIds: [],
    cursor: { provider: FULL, kind: 'history', value }, hasMore: false, fullSync: false,
    ...options,
  }
}

function cursorValue(cursor: SyncCursor | string | null | undefined) {
  return typeof cursor === 'string' ? cursor : cursor?.value ?? null
}

async function fixture(options: Partial<InboxOptions> & { googleOAuth?: GoogleOAuthConfig } = {}) {
  const { googleOAuth: _hostGoogle, ...inboxOptions } = options
  const directory = await mkdtemp(join(TEMP_ROOT, 'inbox-api-'))
  const database = join(directory, 'mail.sqlite')
  const clock = { value: EPOCH }
  const boxes = new Map<string, ReferenceMailbox>()
  const discoveries = new Map<string, ConnectionSources>()
  const googleKeys = options.googleOAuth ? generateKeyPairSync('rsa', { modulusLength: 2048 }) : null
  const google = {
    codes: new Map<string, {
      mailbox: string; subject: string; nonce: string; challenge: string;
      claims?: Record<string, unknown>; refreshToken?: string | null; forged?: boolean;
    }>(),
    access: new Map<string, string>(),
    profiles: new Map<string, Record<string, unknown>>(),
    requests: [] as Array<{ url: string; method: string; body: string }>,
    issued: [] as Array<{ accessToken: string; idToken: string; refreshToken?: string }>,
  }
  const logs: Array<{ code: string; operation: string }> = []
  const instances = new Set<Inbox>()
  const suppliedConnections = new Set<Database>()
  const releases: Array<() => void> = []
  const pending: Array<Promise<unknown>> = []
  const servers: Array<{ stop: (closeActiveConnections?: boolean) => void | Promise<void> }> = []
  const controllers: AbortController[] = []
  const definitions: ProviderDefinition[] = [FULL, RESTRICTED, DYNAMIC, SCOPED, ...(options.googleOAuth ? ['gmail'] : [])].map(id => ({
    id, name: id, connection: id === 'gmail' ? 'oauth' : 'credentials', scopes: ['mail'],
    nativeCategoryRoles: { 'native-promotions': 'promotions' },
    ...(id === SCOPED ? {
      mailboxSelection: 'manual' as const,
      async discover(provider: InboxProvider) {
        const data = discoveries.get((await provider.getAccount()).name)
        if (!data) throw new ProviderError(id, 'VALIDATION', 'Reference discovery was not configured')
        return structuredClone(data)
      },
    } : {}),
    create(credentials) {
      if (id === SCOPED && credentials.apiKey !== SECRET) throw new ProviderAuthenticationError(id, 'Invalid reference API key')
      const box = boxes.get(id === 'gmail' ? google.access.get(String(credentials.accessToken)) ?? '' : String(credentials.mailbox))
      if (!box) throw new ProviderAuthenticationError(id, 'Unknown reference mailbox')
      return box.adapter(credentials, id, id === RESTRICTED ? restrictedCapabilities : fullCapabilities)
    },
  }))
  const settings: InboxOptions = {
    database, encryptionKey: KEY, providers: definitions, now: () => clock.value,
    syncIntervalMs: 60_000, eventRetention: 1000, leaseMs: 1000, concurrency: 4,
    log: event => logs.push(structuredClone(event)),
    fetch: options.googleOAuth ? (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init)
      const body = await request.text()
      google.requests.push({ url: request.url, method: request.method, body })
      if (request.url === 'https://openidconnect.googleapis.com/v1/userinfo' && request.method === 'GET') {
        const profile = google.profiles.get((request.headers.get('authorization') ?? '').replace(/^Bearer /i, ''))
        return profile ? Response.json(profile) : Response.json({ error: 'invalid_token' }, { status: 401 })
      }
      if (request.url === 'https://www.googleapis.com/oauth2/v3/certs' && request.method === 'GET') {
        return Response.json({ keys: [{ ...googleKeys!.publicKey.export({ format: 'jwk' }), kid: 'pilot-rs256', alg: 'RS256', use: 'sig' }] })
      }
      if (request.url !== 'https://oauth2.googleapis.com/token' || request.method !== 'POST') {
        throw new Error(`Live network is forbidden: unexpected synthetic Google request ${request.method} ${request.url}`)
      }
      const form = new URLSearchParams(body)
      const code = form.get('code') ?? ''
      const grant = google.codes.get(code)
      const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url')
      const basic = Buffer.from(`${options.googleOAuth!.clientId}:${options.googleOAuth!.clientSecret}`).toString('base64')
      const authenticated = form.get('client_id') === options.googleOAuth!.clientId && form.get('client_secret') === options.googleOAuth!.clientSecret
        || request.headers.get('authorization') === `Basic ${basic}`
      if (!grant || grant.challenge !== challenge || form.get('grant_type') !== 'authorization_code'
        || form.get('redirect_uri') !== options.googleOAuth!.redirectUri || !authenticated) {
        return Response.json({ error: 'invalid_grant' }, { status: 400 })
      }
      google.codes.delete(code)
      const box = boxes.get(grant.mailbox)
      if (!box) throw new Error('Synthetic Google code has no reference mailbox')
      const claims = {
        iss: 'https://accounts.google.com', sub: grant.subject, aud: options.googleOAuth!.clientId,
        email: box.email, email_verified: true, nonce: grant.nonce,
        iat: Math.floor(clock.value / 1000), exp: Math.floor(clock.value / 1000) + 3600, ...grant.claims,
      }
      const unsigned = [
        { alg: 'RS256', kid: 'pilot-rs256', typ: 'JWT' }, claims,
      ].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.')
      const signature = sign('RSA-SHA256', Buffer.from(unsigned), googleKeys!.privateKey)
      if (grant.forged) signature[0] = signature[0]! ^ 1
      const idToken = `${unsigned}.${signature.toString('base64url')}`
      const accessToken = `${SECRET}-google-${code}`
      const refreshToken = grant.refreshToken === null ? undefined : grant.refreshToken ?? `${SECRET}-refresh-${grant.mailbox}`
      google.access.set(accessToken, grant.mailbox)
      google.profiles.set(accessToken, { sub: claims.sub, email: claims.email, email_verified: claims.email_verified })
      google.issued.push({ accessToken, idToken, refreshToken })
      return Response.json({
        access_token: accessToken, id_token: idToken, token_type: 'Bearer', expires_in: 3600,
        scope: (options.googleOAuth!.scopes ?? ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly']).join(' '),
        ...(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
      })
    }) as typeof fetch : Object.assign(
      () => { throw new Error('Live network is forbidden in the reference mailbox') },
      { preconnect: () => { throw new Error('Live network is forbidden in the reference mailbox') } },
    ),
    ...inboxOptions,
  }
  cleanup.push(async () => {
    for (const release of releases) release()
    for (const controller of controllers) controller.abort()
    try {
      for (const server of servers) await server.stop(true)
      await bounded(Promise.allSettled(pending), 'outstanding reference requests during cleanup')
    } finally {
      try { await Promise.all([...instances].map(instance => instance.close())) }
      finally {
        for (const connection of suppliedConnections) {
          try { connection.close() } catch { /* Closing an already-owned connection is harmless during cleanup. */ }
        }
        await rm(directory, { recursive: true, force: true })
      }
    }
  })
  let inbox = createInbox(settings)
  instances.add(inbox)
  const authenticate = async (request: Request) => {
    const token = request.headers.get('authorization')
    return token === 'Bearer alice' ? { id: 'alice' } : token === 'Bearer bob' ? { id: 'bob' } : null
  }
  const hosts = new WeakMap<Inbox, ReturnType<typeof createGoogleOAuthHost>>()
  const host = (target: Inbox = inbox) => {
    if (!options.googleOAuth) throw new InboxError('OAUTH_NOT_CONFIGURED', 'Google OAuth is not configured in this host.', 503)
    let value = hosts.get(target)
    if (!value) {
      const hostDatabase = new Database(database)
      suppliedConnections.add(hostDatabase)
      value = createGoogleOAuthHost({ inbox: target, database: hostDatabase, encryptionKey: KEY, config: options.googleOAuth,
        now: settings.now, fetch: settings.fetch })
      hosts.set(target, value)
    }
    return value
  }
  const makeApi = (target: Inbox = inbox) => new Hono()
    .route('/', createGoogleOAuthApi({ oauth: () => host(target), authenticate, allowedOrigins: ['https://app.example.test'] }))
    .route('/', createInboxApi({
      inbox: target, authenticate, allowedOrigins: ['https://app.example.test'],
      heartbeatMs: 20, streamPollMs: 10, maxStreamsPerOwner: 2,
    }))
  let api = makeApi()
  const request = (owner: string | null, path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    if (owner) headers.set('authorization', `Bearer ${owner}`)
    return api.request(`/v1${path}`, { ...init, headers })
  }
  const json = async <T>(owner: string, path: string, body?: unknown, method = 'GET', status = 200, headers: HeadersInit = {}): Promise<T> => {
    const response = await request(owner, path, {
      method, headers: { 'content-type': 'application/json', ...Object.fromEntries(new Headers(headers)) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    expect(response.status).toBe(status)
    return response.json() as Promise<T>
  }
  const connect = async (owner: string, key: string, seed: MailMessage[] = [], providerId = FULL, aliases: string[] = []) => {
    const box = referenceMailbox(key, `${key}@example.test`, seed, aliases)
    boxes.set(key, box)
    const account = await json<Account>(owner, '/accounts', {
      providerId, credentials: { mailbox: key, ...(providerId === SCOPED ? { apiKey: SECRET } : { accessToken: SECRET, refreshToken: `${SECRET}-refresh` }), aliases },
    }, 'POST', 201)
    return { account, box }
  }
  const sync = (owner: string, accountId: string, input: Record<string, unknown> = {}) =>
    json<{ synchronized: number; hasMore: boolean; state: string }>(owner, `/accounts/${accountId}/sync`, input, 'POST')
  const seed = async (owner: string, key: string, messages = [native('same')], providerId = FULL, aliases: string[] = []) => {
    const connected = await connect(owner, key, messages, providerId, aliases)
    await sync(owner, connected.account.id)
    return connected
  }
  return {
    database, directory, clock, logs, boxes, discoveries, google, request, json, connect, sync, seed,
    get inbox() { return inbox }, get api() { return api }, get oauth() { return host() },
    gate<T>(fallback: T) { const barrier = gate(fallback); releases.push(() => barrier.release()); return barrier },
    pending<T>(promise: Promise<T>) { pending.push(promise.catch(() => undefined)); return promise },
    async restart(databaseOverride?: Database) {
      if (databaseOverride) suppliedConnections.add(databaseOverride)
      await inbox.close()
      instances.delete(inbox)
      inbox = createInbox({ ...settings, ...(databaseOverride ? { database: databaseOverride } : {}) })
      instances.add(inbox)
      api = makeApi()
    },
    worker() { const worker = createInbox(settings); instances.add(worker); return worker },
    socket(config: { maxStreamsPerOwner?: number } = {}) {
      const socketApi = createInboxApi({
        inbox, authenticate, allowedOrigins: ['https://app.example.test'],
        heartbeatMs: 20, streamPollMs: 10, maxStreamsPerOwner: 2, ...config,
      })
      const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => socketApi.fetch(request) })
      servers.push(server)
      return `http://127.0.0.1:${server.port}`
    },
    controller() { const controller = new AbortController(); controllers.push(controller); return controller },
    async page(owner = 'alice', query: Query = {}) {
      const search = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]))
      return json<Page<MessageSummary>>(owner, `/messages?${search}`)
    },
    async mutate(owner: string, ids: string[], changes: MessageMutation & { addLabelIds?: string[]; removeLabelIds?: string[]; folderId?: string }, key: string) {
      return json<Operation>(owner, '/operations', { messageIds: ids, changes }, 'POST', 202, { 'Idempotency-Key': key })
    },
    async draft(owner: string, accountId: string, input: Record<string, unknown> = {}) {
      return json<Draft>(owner, '/drafts', { accountId, ...input }, 'POST', 201)
    },
    async submit(owner: string, draft: Draft, key: string, sendAt?: string) {
      return json<Operation>(owner, `/drafts/${draft.id}/submit`, {
        revision: draft.revision, ...(sendAt === undefined ? {} : { sendAt }),
      }, 'POST', 202, { 'Idempotency-Key': key })
    },
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

function transport(h: Fixture) {
  const requests: Array<{ path: string; method: string; headers: Headers; status: number; etag: string | null; body: unknown }> = []
  const fetcher = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const body = request.headers.get('content-type')?.includes('application/json') && request.body
      ? await request.clone().json() : null
    const response = await h.api.request(request)
    requests.push({ path: `${url.pathname}${url.search}`, method: request.method, headers: new Headers(request.headers), status: response.status, etag: response.headers.get('etag'), body })
    return response
  }) as typeof fetch
  return { requests, fetch: fetcher }
}

async function invalid(response: Response, status?: number) {
  if (status === undefined) {
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.status).toBeLessThan(500)
  } else expect(response.status).toBe(status)
  const text = await response.text()
  expect(text).not.toContain(SECRET)
  expect(text).not.toContain(BODY_SECRET)
  return text
}

async function etag(h: Fixture, owner: string, path: string) {
  const response = await h.request(owner, path)
  expect(response.status).toBe(200)
  const value = response.headers.get('etag')
  expect(value).not.toBeNull()
  return value!
}

function sse(response: Response) {
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('text/event-stream')
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const next = async () => {
    while (true) {
      const boundary = /\r?\n\r?\n/.exec(buffer)
      if (boundary) {
        const raw = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary[0].length)
        const lines = raw.split(/\r?\n/)
        const value = (prefix: string) => lines.filter(line => line.startsWith(prefix)).map(line => line.slice(prefix.length).replace(/^ /, '')).join('\n')
        return { event: value('event:') || 'message', id: value('id:'), data: value('data:'), comment: value(':'), isComment: lines.some(line => line.startsWith(':')) }
      }
      const chunk = await bounded(reader.read(), 'SSE frame')
      if (chunk.done) throw new Error(`SSE ended before a complete frame: ${buffer}`)
      buffer += decoder.decode(chunk.value, { stream: true })
    }
  }
  return {
    next, cancel: () => reader.cancel().catch(() => undefined),
    async event(name: string) {
      for (let index = 0; index < 100; index++) {
        const frame = await next()
        if (frame.event === name) return frame
      }
      throw new Error(`SSE did not produce ${name}`)
    },
  }
}

describe('mail HTTP ownership and provider lifecycle', () => {
  test('authentication is the host seam; query, body, and unrelated headers cannot choose the owner', async () => {
    const h = await fixture()
    await h.seed('alice', 'alice-auth')
    const bob = await h.seed('bob', 'bob-auth')
    for (const path of ['/accounts', '/messages', '/drafts', '/operations/missing', '/changes', '/events', '/policy']) {
      await invalid(await h.request(null, `${path}${path.includes('?') ? '&' : '?'}owner=alice`, {
        headers: { 'x-owner-id': 'alice', 'x-user-id': 'alice' },
      }), 401)
    }
    await invalid(await h.request('alice', '/accounts?owner=bob&userId=bob'), 400)
    const accounts = await h.json<Account[]>('alice', '/accounts')
    expect(accounts.map(account => account.email)).toEqual(['alice-auth@example.test'])
    await invalid(await h.request('alice', `/accounts/${bob.account.id}`, { headers: { 'x-owner-id': 'bob' } }), 404)
    const allowed = await h.request('alice', '/accounts', { headers: { origin: 'https://app.example.test' } })
    expect(allowed.status).toBe(200)
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://app.example.test')
    const disallowed = await h.request('alice', '/accounts', { headers: { origin: 'https://evil.example.test' } })
    expect(disallowed.headers.get('access-control-allow-origin')).not.toBe('https://evil.example.test')
  })

  test('two owners with two same-provider accounts each retain distinct native message and thread identities', async () => {
    const h = await fixture()
    const records = []
    for (const owner of ['alice', 'bob']) {
      for (const suffix of ['personal', 'work']) {
        const key = `${owner}-${suffix}`
        const record = await h.seed(owner, key, [native('identical-native-id', {
          threadId: 'identical-native-thread', subject: key, bodyText: `${BODY_SECRET}:${key}`,
        })])
        const page = await h.page(owner, { accountId: record.account.id })
        expect(page.total).toBe(1)
        expect(page.items[0]!.subject).toBe(key)
        records.push({ ...record, owner, message: page.items[0]! })
      }
    }
    expect(new Set(records.map(record => record.account.id)).size).toBe(4)
    expect(new Set(records.map(record => record.message.id)).size).toBe(4)
    expect(new Set(records.map(record => record.message.threadId)).size).toBe(4)
    for (const owner of ['alice', 'bob']) {
      expect((await h.page(owner)).items.map(message => message.subject).sort()).toEqual([`${owner}-personal`, `${owner}-work`])
      expect((await h.inbox.accounts(owner)).length).toBe(2)
      for (const record of records.filter(record => record.owner !== owner)) {
        await invalid(await h.request(owner, `/messages/${record.message.id}`), 404)
        await invalid(await h.request(owner, `/threads/${record.message.threadId}`), 404)
        await invalid(await h.request(owner, `/messages?accountId=${record.account.id}`), 404)
        await expect(h.inbox.message(owner, record.message.id)).rejects.toMatchObject({ status: 404 })
        await expect(h.inbox.account(owner, record.account.id)).rejects.toMatchObject({ status: 404 })
      }
    }
    await h.restart()
    expect((await h.page('alice')).total).toBe(2)
    expect((await h.page('bob')).total).toBe(2)
    for (const record of records) {
      expect((await h.inbox.message(record.owner, record.message.id)).accountId).toBe(record.account.id)
    }
  })

  test('foreign accounts, drafts, labels, blobs, and operations are rejected before any upstream work', async () => {
    const h = await fixture()
    const { account, box } = await h.seed('bob', 'bob-foreign')
    const message = (await h.page('bob')).items[0]!
    const draft = await h.draft('bob', account.id)
    const label = await h.json<Label>('bob', '/labels', { accountId: account.id, name: 'Private' }, 'POST', 201)
    const blob = await h.inbox.upload('bob', account.id, { filename: 'private.bin', contentType: 'application/octet-stream', content: new Uint8Array([7, 8]) })
    const operation = await h.mutate('bob', [message.id], { isStarred: true }, 'bob-only')
    const before = { mutations: box.calls.mutate.length, syncs: box.calls.sync.length, creates: box.calls.create.length }
    const requests: Array<[string, string, unknown?]> = [
      ['GET', `/accounts/${account.id}`], ['DELETE', `/accounts/${account.id}`],
      ['POST', `/accounts/${account.id}/sync`, {}],
      ['POST', `/accounts/${account.id}/reconnect`, { mailbox: 'bob-foreign', accessToken: SECRET }],
      ['GET', `/accounts/${account.id}/folders`], ['POST', `/accounts/${account.id}/folders`, { name: 'Injected' }],
      ['GET', `/labels?accountId=${account.id}`], ['GET', `/drafts?accountId=${account.id}`],
      ['POST', '/drafts', { accountId: account.id }], ['POST', '/labels', { accountId: account.id, name: 'Injected' }],
      ['GET', `/drafts/${draft.id}`], ['PATCH', `/drafts/${draft.id}`, { subject: 'Hijacked' }],
      ['DELETE', `/drafts/${draft.id}`], ['POST', `/drafts/${draft.id}/submit`, { revision: draft.revision }],
      ['PATCH', `/labels/${label.id}`, { name: 'Hijacked' }], ['DELETE', `/labels/${label.id}`],
      ['GET', `/blobs/${blob.id}`], ['GET', `/operations/${operation.id}`],
      ['POST', `/operations/${operation.id}/cancel`, {}], ['POST', `/operations/${operation.id}/undo`, {}],
      ['POST', `/operations/${operation.id}/reschedule`, { sendAt: new Date(EPOCH + 60_000).toISOString() }],
    ]
    for (const [method, path, body] of requests) {
      await invalid(await h.request('alice', path, {
        method, headers: { 'content-type': 'application/json', 'If-Match': '"1"', 'Idempotency-Key': 'foreign-submit' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), 404)
    }
    await expect(h.inbox.draft('alice', draft.id)).rejects.toMatchObject({ status: 404 })
    await expect(h.inbox.download('alice', blob.id)).rejects.toMatchObject({ status: 404 })
    await expect(h.inbox.operation('alice', operation.id)).rejects.toMatchObject({ status: 404 })
    expect(box.calls.mutate.length).toBe(before.mutations)
    expect(box.calls.sync.length).toBe(before.syncs)
    expect(box.calls.create.length).toBe(before.creates)
    expect((await h.inbox.draft('bob', draft.id)).subject).not.toBe('Hijacked')
    expect((await h.inbox.labels('bob'))[0]!.name).toBe('Private')
  })

  test('an unknown registered provider works end to end, and unsupported capabilities do not disable local features', async () => {
    const h = await fixture()
    const dynamic = await h.seed('alice', 'dynamic', [native('external')], DYNAMIC)
    const readOnly = await h.seed('alice', 'readonly', [native('readonly')], RESTRICTED)
    const providers = await h.json<Array<{ id: string; name: string; connection: string; scopes: string[] }>>('alice', '/providers')
    expect(providers.find(provider => provider.id === DYNAMIC)).toEqual({ id: DYNAMIC, name: DYNAMIC, connection: 'credentials', scopes: ['mail'] })
    expect(dynamic.account.providerId).toBe(DYNAMIC)
    expect(readOnly.account.capabilities).toEqual(restrictedCapabilities)
    expect(readOnly.account.features).toMatchObject({ localDrafts: true, localLabels: true, snooze: true, scheduledSend: false, undoSend: false })
    const draft = await h.draft('alice', readOnly.account.id, { bodyText: 'An incomplete local autosave' })
    expect(draft.bodyText).toBe('An incomplete local autosave')
    const label = await h.json<Label>('alice', '/labels', { accountId: readOnly.account.id, name: 'Local only' }, 'POST', 201)
    const message = (await h.page('alice', { accountId: readOnly.account.id })).items[0]!
    await h.mutate('alice', [message.id], { addLabelIds: [label.id] }, 'readonly-local-label')
    await h.inbox.runDue()
    expect((await h.inbox.message('alice', message.id)).labelIds).toContain(label.id)
    for (const changes of [{ isRead: true }, { isStarred: true }, { isArchived: true }, { deletePermanently: true }]) {
      await invalid(await h.request('alice', '/operations', {
        method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': JSON.stringify(changes) },
        body: JSON.stringify({ messageIds: [message.id], changes }),
      }))
    }
    await invalid(await h.request('alice', `/accounts/${readOnly.account.id}/folders`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Native denied' }),
    }))
    await invalid(await h.request('alice', `/drafts/${draft.id}/submit`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'no-send' }, body: JSON.stringify({ revision: draft.revision }),
    }))
    expect(readOnly.box.calls.mutate).toEqual([])
    expect(readOnly.box.calls.send).toEqual([])
    expect(readOnly.box.calls.createFolder).toEqual([])
    await h.inbox.setPolicy('alice', { undoSendSeconds: 0 })
    const outgoing = await h.draft('alice', dynamic.account.id, { to: [participant('recipient@example.test')], subject: 'Dynamic delivery', bodyText: 'Hello' })
    const sent = await h.submit('alice', outgoing, 'dynamic-send')
    await h.inbox.runDue()
    expect((await h.inbox.operation('alice', sent.id)).status).toBe('succeeded')
    expect(dynamic.box.calls.send).toHaveLength(1)
    await h.sync('alice', dynamic.account.id)
    expect((await h.page('alice', { accountId: dynamic.account.id, folder: 'sent' })).items.map(item => item.subject)).toEqual(['Dynamic delivery'])
  })

  test('local snooze and scheduled sending remain available when a send-capable provider lacks those native capabilities', async () => {
    const providerId = 'limited-native-mail'
    const capabilities = { ...restrictedCapabilities, send: true, reply: true }
    const box = referenceMailbox('local-workflows', 'local-workflows@example.test', [native('local')])
    const h = await fixture({ providers: [{
      id: providerId, name: 'Limited native operations',
      create: credentials => box.adapter(credentials, providerId, capabilities),
    }] })
    const account = await h.json<Account>('alice', '/accounts', {
      providerId, credentials: { mailbox: 'local-workflows', accessToken: SECRET },
    }, 'POST', 201)
    await h.sync('alice', account.id)
    expect(account.capabilities).toMatchObject({ snooze: false, scheduledSend: false, drafts: false, labels: false })
    expect(account.features).toMatchObject({ snooze: true, scheduledSend: true, undoSend: true, localDrafts: true, localLabels: true })
    const message = (await h.page()).items[0]!
    await h.mutate('alice', [message.id], { snoozedUntil: new Date(EPOCH + 60_000).toISOString() }, 'local-only-snooze')
    await h.inbox.runDue()
    expect((await h.page('alice', { folder: 'snoozed' })).items.map(item => item.id)).toEqual([message.id])
    expect(box.calls.mutate).toEqual([])
    const draft = await h.draft('alice', account.id, { to: [participant('recipient@example.test')], subject: 'Locally scheduled' })
    const operation = await h.submit('alice', draft, 'local-only-schedule', new Date(EPOCH + 120_000).toISOString())
    h.clock.value = EPOCH + 60_000
    await h.inbox.runDue()
    expect((await h.inbox.message('alice', message.id)).snoozedUntil).toBeNull()
    expect(box.calls.send).toEqual([])
    h.clock.value = EPOCH + 120_000
    await h.inbox.runDue()
    expect((await h.inbox.operation('alice', operation.id)).status).toBe('succeeded')
    expect(box.calls.send).toHaveLength(1)
    expect(box.calls.send[0]!.scheduledAt).toBeUndefined()
  })

  test('reconnect increments generation and fences a late old-credential sync result', async () => {
    const h = await fixture()
    const { account, box } = await h.seed('alice', 'generation', [native('old', { subject: 'Before reconnect' })])
    const barrier = h.gate(receipt([native('late', { subject: 'Obsolete credential result' })], 'obsolete'))
    box.nextSync(barrier.wait)
    const oldSync = h.pending(h.inbox.sync('alice', account.id).catch(error => error))
    await bounded(barrier.entered, 'old-generation sync')
    const replacement = referenceMailbox('generation-new', 'generation@example.test', [native('fresh', { subject: 'Fresh credentials' })])
    h.boxes.set('generation-new', replacement)
    const reconnected = await h.json<Account>('alice', `/accounts/${account.id}/reconnect`, {
      mailbox: 'generation-new', accessToken: 'replacement-synthetic-token',
    }, 'POST')
    expect(reconnected.id).toBe(account.id)
    expect(reconnected.generation).toBeGreaterThan(account.generation)
    await h.sync('alice', account.id)
    barrier.release()
    await bounded(oldSync, 'obsolete sync settlement')
    const page = await h.page('alice', { accountId: account.id })
    expect(page.items.some(message => message.subject === 'Fresh credentials')).toBe(true)
    expect(page.items.some(message => message.subject === 'Obsolete credential result')).toBe(false)
    await h.restart()
    expect((await h.inbox.account('alice', account.id)).generation).toBe(reconnected.generation)
    expect((await h.page('alice')).items.some(message => message.subject === 'Obsolete credential result')).toBe(false)
  })

  test('disconnect fences in-flight writes, is durable, and cannot be undone by a late provider response', async () => {
    const h = await fixture()
    const { account, box } = await h.seed('alice', 'disconnect')
    const barrier = h.gate(receipt([native('resurrected')], 'late-after-disconnect'))
    box.nextSync(barrier.wait)
    const pending = h.pending(h.inbox.sync('alice', account.id).catch(error => error))
    await bounded(barrier.entered, 'disconnect race')
    const response = await h.request('alice', `/accounts/${account.id}`, { method: 'DELETE' })
    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
    barrier.release()
    await bounded(pending, 'disconnected sync settlement')
    expect((await h.inbox.account('alice', account.id)).status).toBe('disconnected')
    await h.restart()
    const calls = box.calls.sync.length
    await expect(h.inbox.sync('alice', account.id)).rejects.toBeDefined()
    await h.inbox.poll()
    expect(box.calls.sync.length).toBe(calls)
    expect((await h.page('alice')).items.some(message => message.subject === 'Subject resurrected')).toBe(false)
    expect(box.calls.disconnect).toBeGreaterThan(0)
  })
})

describe('cached reads, search, folders, and local labels', () => {
  test('reading full messages, pages, and threads does not mark read, enqueue work, or consult the provider', async () => {
    const h = await fixture()
    const { account, box } = await h.seed('alice', 'readonly-views', [
      native('first', { threadId: 'conversation', bodyText: BODY_SECRET }),
      native('second', { threadId: 'conversation', isRead: true }),
    ])
    const baseline = await h.inbox.changes('alice')
    const original = await h.page('alice')
    const first = original.items.find(message => !message.isRead)!
    const calls = { sync: box.calls.sync.length, lists: box.calls.listMessages, threads: box.calls.listThreads }
    for (let pass = 0; pass < 2; pass++) {
      const message = await h.json<Message>('alice', `/messages/${first.id}`)
      expect(message.bodyText).toBe(BODY_SECRET)
      expect(message.isRead).toBe(false)
      expect(message.revision).toBe(first.revision)
      const page = await h.page('alice', { accountId: account.id })
      expect(page.items.find(message => message.id === first.id)!.isRead).toBe(false)
      const threads = await h.json<Page<ThreadSummary>>('alice', '/threads')
      expect(threads.items[0]!.messageCount).toBe(2)
      const thread = await h.json<Page<MessageSummary>>('alice', `/threads/${first.threadId}`)
      expect(thread.items).toHaveLength(2)
      expect(JSON.stringify(thread)).not.toContain(BODY_SECRET)
    }
    await h.inbox.runDue()
    expect(box.calls.getMessage).toEqual([])
    expect(box.calls.getThread).toEqual([])
    expect(box.calls.mutate).toEqual([])
    expect(box.calls.sync.length).toBe(calls.sync)
    expect(box.calls.listMessages).toBe(calls.lists)
    expect(box.calls.listThreads).toBe(calls.threads)
    expect((await h.inbox.changes('alice', { since: baseline.state })).events).toEqual([])
    expect((await h.inbox.message('alice', first.id)).revision).toBe(first.revision)
  })

  test('a 10,000-message cache returns a bounded body-free page, not an upstream query or embedded conversation', async () => {
    const h = await fixture({ eventRetention: 20 })
    const body = `${BODY_SECRET}:${'x'.repeat(1024)}`
    const messages = Array.from({ length: 10_000 }, (_, index) => native(`bulk-${String(index).padStart(5, '0')}`, {
      threadId: `bulk-thread-${index}`, subject: `Budget ${index}`,
      preview: 'A preview that must remain bounded. '.repeat(50),
      bodyText: body, bodyHtml: `<p>${body}</p>`, bcc: [participant('hidden@example.test')],
    }))
    const { account, box } = await h.seed('alice', 'large', messages)
    const before = { sync: box.calls.sync.length, list: box.calls.listMessages, get: box.calls.getMessage.length }
    const response = await h.request('alice', `/messages?accountId=${account.id}&limit=50`)
    expect(response.status).toBe(200)
    const encoded = await response.text()
    expect(Buffer.byteLength(encoded)).toBeLessThan(100_000)
    expect(encoded).not.toContain(BODY_SECRET)
    expect(encoded).not.toContain('hidden@example.test')
    const page = JSON.parse(encoded) as Page<MessageSummary>
    expect(page.total).toBe(10_000)
    expect(page.items).toHaveLength(50)
    expect(page.nextCursor).not.toBeNull()
    for (const message of page.items) {
      expect(message.preview.length).toBeLessThanOrEqual(256)
      expect(message).not.toHaveProperty('bodyText')
      expect(message).not.toHaveProperty('bodyHtml')
      expect(message).not.toHaveProperty('messages')
      expect(message).not.toHaveProperty('bcc')
      expect(message).not.toHaveProperty('attachments')
    }
    const match = await h.page('alice', { search: '"Budget 9999"', limit: 50 })
    expect(match.items.map(message => message.subject)).toEqual(['Budget 9999'])
    expect(box.calls.sync.length).toBe(before.sync)
    expect(box.calls.listMessages).toBe(before.list)
    expect(box.calls.getMessage.length).toBe(before.get)
  }, 30_000)

  test('global search includes sent and archive, intersects typed filters, and treats SQL wildcards literally', async () => {
    const h = await fixture()
    const rows = [
      native('inbox', { subject: 'needle inbox', from: participant('one@example.test'), receivedAt: '2026-08-29T12:00:00.000Z' }),
      native('sent', { subject: 'needle sent', folder: 'sent', isRead: true, from: participant('self@example.test'), to: [participant('target@example.test')], receivedAt: '2026-08-30T12:00:00.000Z' }),
      native('archive', { subject: 'needle archive', folder: 'archive', isStarred: true, from: participant('one@example.test'), to: [participant('target@example.test')], receivedAt: '2026-08-31T12:00:00.000Z', attachments: [{ id: 'a', filename: 'a.txt', contentType: 'text/plain', size: 1, url: 'https://upstream.invalid/secret' }] }),
      native('literal', { subject: 'literal 100%_complete* report' }),
      native('not-literal', { subject: 'literal 100XXcompleteZZ report' }),
    ]
    const { account, box } = await h.seed('alice', 'search', rows)
    await h.seed('alice', 'search-secondary', [native('other', { subject: 'needle secondary' })])
    await h.seed('bob', 'search-foreign', [native('foreign', { subject: 'needle foreign' })])
    expect((await h.page('alice', { search: 'needle' })).items.map(message => message.subject).sort()).toEqual(['needle archive', 'needle inbox', 'needle secondary', 'needle sent'])
    expect((await h.page('alice', { search: 'needle', folder: 'sent' })).items.map(message => message.subject)).toEqual(['needle sent'])
    expect((await h.page('alice', { search: 'needle', folder: 'archive' })).items.map(message => message.subject)).toEqual(['needle archive'])
    expect((await h.page('alice', { search: 'needle in:sent' })).items.map(message => message.subject)).toEqual(['needle sent'])
    expect((await h.page('alice', { search: 'from:one@example.test is:unread', accountId: account.id })).total).toBe(2)
    expect((await h.page('alice', {
      accountId: account.id, from: 'one@example.test', to: 'target@example.test',
      unreadOnly: true, starredOnly: true, hasAttachments: true,
      after: '2026-08-30T00:00:00.000Z', before: '2026-09-01T00:00:00.000Z',
    })).items.map(message => message.subject)).toEqual(['needle archive'])
    expect((await h.page('alice', { search: '%_complete*' })).items.map(message => message.subject)).toEqual(['literal 100%_complete* report'])
    expect((await h.page('alice', { search: "' OR 1=1 --" })).total).toBe(0)
    expect((await h.page('alice', { search: 'needle', accountId: account.id, sort: 'oldest' })).items.map(message => message.subject)).toEqual(['needle inbox', 'needle sent', 'needle archive'])
    expect(box.calls.listMessages).toBe(0)
  })

  test('unknown search operators and malformed query values are validation failures rather than silently broadened searches', async () => {
    const h = await fixture()
    await h.seed('alice', 'validation')
    for (const search of ['unknown:value', 'is:made-up', 'has:elephant', 'before:not-a-date', '"unterminated']) {
      await invalid(await h.request('alice', `/messages?search=${encodeURIComponent(search)}`), 400)
    }
    for (const query of ['limit=0', 'limit=-1', 'limit=1.5', 'limit=NaN', 'unreadOnly=perhaps', 'sort=random', 'before=not-a-date', 'after=not-a-date']) {
      await invalid(await h.request('alice', `/messages?${query}`), 400)
    }
    await invalid(await h.request('alice', '/drafts', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
    }), 400)
    expect((await h.page()).total).toBe(1)
    expect(await h.inbox.drafts('alice')).toEqual([])
  })

  test('thread summaries count the full conversation and separately count matching messages', async () => {
    const h = await fixture()
    await h.seed('alice', 'thread-counts', [
      native('thread-a', { threadId: 'thread-one', subject: 'The whole conversation', preview: 'Old preview', receivedAt: '2026-08-29T00:00:00.000Z' }),
      native('thread-b', { threadId: 'thread-one', subject: 'Re: The whole conversation', bodyText: 'unique searchable detail', folder: 'sent', isRead: true, receivedAt: '2026-08-30T00:00:00.000Z' }),
      native('thread-c', { threadId: 'thread-one', subject: 'Re: The whole conversation', preview: 'Latest preview', isStarred: true, receivedAt: '2026-08-31T00:00:00.000Z' }),
      native('unrelated'),
    ])
    const threads = await h.json<Page<ThreadSummary>>('alice', '/threads?folder=sent')
    expect(threads.total).toBe(1)
    const thread = threads.items[0]!
    expect(thread.messageCount).toBe(3)
    expect(thread.matchingMessageCount).toBe(1)
    expect(thread.isRead).toBe(false)
    expect(thread.isStarred).toBe(true)
    expect(thread.lastMessageAt).toBe('2026-08-31T00:00:00.000Z')
    expect(thread.preview).toBe('Latest preview')
    const first = await h.json<Page<MessageSummary>>('alice', `/threads/${thread.id}?limit=2`)
    expect(first.total).toBe(3)
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()
    const second = await h.json<Page<MessageSummary>>('alice', `/threads/${thread.id}?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`)
    expect(second.items).toHaveLength(1)
    expect(second.nextCursor).toBeNull()
    expect(new Set([...first.items, ...second.items].map(message => message.id)).size).toBe(3)
    expect([...first.items, ...second.items].every(message => message.threadId === thread.id)).toBe(true)
    expect(JSON.stringify(first)).not.toContain('unique searchable detail')
  })

  test('opaque pagination is stable across tied timestamps and rejects stale, foreign, or query-mismatched cursors', async () => {
    const h = await fixture()
    const rows = Array.from({ length: 9 }, (_, index) => native(`tie-${index}`))
    await h.seed('alice', 'ties', rows)
    await h.seed('bob', 'bob-ties', rows)
    const first = await h.page('alice', { limit: 3 })
    const again = await h.page('alice', { limit: 3 })
    expect(again.items.map(message => message.id)).toEqual(first.items.map(message => message.id))
    expect(again.nextCursor).toBe(first.nextCursor)
    const ids = first.items.map(message => message.id)
    let cursor = first.nextCursor
    while (cursor) {
      const page = await h.page('alice', { limit: 3, cursor })
      ids.push(...page.items.map(message => message.id))
      cursor = page.nextCursor
      expect(ids.length).toBeLessThanOrEqual(9)
    }
    expect(ids).toHaveLength(9)
    expect(new Set(ids).size).toBe(9)
    await invalid(await h.request('bob', `/messages?limit=3&cursor=${encodeURIComponent(first.nextCursor!)}`))
    await invalid(await h.request('alice', `/messages?folder=sent&limit=3&cursor=${encodeURIComponent(first.nextCursor!)}`))
    await invalid(await h.request('alice', '/messages?cursor=not-a-valid-cursor'))
    await h.mutate('alice', [first.items[0]!.id], { isRead: true }, 'cursor-invalidation')
    await invalid(await h.request('alice', `/messages?limit=3&cursor=${encodeURIComponent(first.nextCursor!)}`), 409)
    expect((await h.page('alice', { limit: 3 })).state).not.toBe(first.state)
  })

  test('custom provider folders and same-named local labels have independent membership and persistence', async () => {
    const h = await fixture()
    const { account, box } = await h.seed('alice', 'folders', [native('one'), native('two')])
    const first = (await h.page()).items[0]!
    const folder = await h.json<Folder>('alice', `/accounts/${account.id}/folders`, { name: 'Project / Alpha' }, 'POST', 201)
    const label = await h.json<Label>('alice', '/labels', { accountId: account.id, name: 'Project / Alpha' }, 'POST', 201)
    expect(folder.scope).toBe('provider')
    expect(label.scope).toBe('local')
    expect(folder.id).not.toBe(label.id)
    await h.mutate('alice', [first.id], { folderId: folder.id, addLabelIds: [label.id] }, 'folder-plus-local-label')
    await h.inbox.runDue()
    const moved = await h.inbox.message('alice', first.id)
    expect(moved.folderIds).toContain(folder.id)
    expect(moved.labelIds).toContain(label.id)
    expect((await h.page('alice', { folder: folder.id })).items.map(message => message.id)).toEqual([first.id])
    expect((await h.page('alice', { labelId: label.id })).items.map(message => message.id)).toEqual([first.id])
    expect(box.calls.mutate.flatMap(call => call.changes.addLabels ?? [])).not.toContain(label.id)
    const renamed = await h.inbox.updateLabel('alice', label.id, 'Renamed locally', label.revision)
    expect(renamed.revision).toBeGreaterThan(label.revision)
    expect((await h.inbox.message('alice', first.id)).labelIds).toContain(label.id)
    const calls = box.calls.mutate.length
    await h.mutate('alice', [first.id], { removeLabelIds: [label.id] }, 'remove-local-label')
    await h.inbox.runDue()
    expect(box.calls.mutate.length).toBe(calls)
    expect((await h.inbox.message('alice', first.id)).folderIds).toContain(folder.id)
    await h.mutate('alice', [first.id], { addLabelIds: [label.id] }, 'reattach-local-label')
    await h.inbox.runDue()
    const response = await h.request('alice', `/labels/${label.id}`, { method: 'DELETE' })
    expect(response.status).toBe(204)
    expect((await h.inbox.message('alice', first.id)).labelIds).not.toContain(label.id)
    expect((await h.inbox.message('alice', first.id)).folderIds).toContain(folder.id)
    await h.restart()
    expect((await h.inbox.folders('alice', account.id)).filter(item => item.name === folder.name).map(item => item.id)).toEqual([folder.id])
    expect(await h.inbox.labels('alice', account.id)).toEqual([])
    expect(box.calls.createFolder).toEqual(['Project / Alpha'])
  })

  test('label PATCH requires the current revision, and foreign-account labels cannot be applied to a message', async () => {
    const h = await fixture()
    const a = await h.seed('alice', 'label-a')
    const b = await h.seed('alice', 'label-b')
    const label = await h.json<Label>('alice', '/labels', { accountId: a.account.id, name: 'Original' }, 'POST', 201)
    const path = `/labels/${label.id}`
    const tag = await etag(h, 'alice', path)
    await invalid(await h.request('alice', path, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Missing precondition' }),
    }), 428)
    const renamed = await h.json<Label>('alice', path, { name: 'Renamed' }, 'PATCH', 200, { 'If-Match': tag })
    expect(renamed.name).toBe('Renamed')
    expect(renamed.revision).toBeGreaterThan(label.revision)
    await invalid(await h.request('alice', path, {
      method: 'PATCH', headers: { 'content-type': 'application/json', 'If-Match': tag }, body: JSON.stringify({ name: 'Stale rename' }),
    }), 412)
    const message = (await h.page('alice', { accountId: b.account.id })).items[0]!
    await invalid(await h.request('alice', '/operations', {
      method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'wrong-account-label' },
      body: JSON.stringify({ messageIds: [message.id], changes: { addLabelIds: [label.id] } }),
    }))
    expect((await h.inbox.message('alice', message.id)).labelIds).toEqual([])
    expect((await h.inbox.labels('alice', a.account.id))[0]!.name).toBe('Renamed')
    expect(b.box.calls.mutate).toEqual([])
  })
})

describe('durable mutation intent', () => {
  test('read, unread, star, archive, trash, and permanent delete act on public IDs and report native receipts', async () => {
    const h = await fixture()
    const { box } = await h.seed('alice', 'mutation-lifecycle')
    const message = (await h.page()).items[0]!
    const cases: Array<{ changes: MessageMutation; expected: Partial<Message> }> = [
      { changes: { isRead: true }, expected: { isRead: true } },
      { changes: { isRead: false }, expected: { isRead: false } },
      { changes: { isStarred: true }, expected: { isStarred: true } },
      { changes: { isArchived: true }, expected: { folder: 'archive' } },
      { changes: { isArchived: false }, expected: { folder: 'inbox' } },
      { changes: { folder: 'trash' }, expected: { folder: 'trash' } },
    ]
    for (const [index, item] of cases.entries()) {
      const operation = await h.mutate('alice', [message.id], item.changes, `lifecycle-${index}`)
      expect(operation.type).toBe('mutation')
      expect((await h.inbox.message('alice', message.id))).toMatchObject(item.expected)
      await h.inbox.runDue()
      const finished = await h.json<Operation>('alice', `/operations/${operation.id}`)
      expect(finished.status).toBe('succeeded')
      expect(finished.results).toEqual([{ messageId: message.id, status: 'succeeded' }])
      expect((await h.inbox.message('alice', message.id))).toMatchObject(item.expected)
    }
    const deletion = await h.mutate('alice', [message.id], { deletePermanently: true }, 'permanent-delete')
    await h.inbox.runDue()
    expect((await h.inbox.operation('alice', deletion.id)).status).toBe('succeeded')
    await invalid(await h.request('alice', `/messages/${message.id}`), 404)
    expect((await h.page()).total).toBe(0)
    expect(box.calls.mutate.map(call => call.id)).toEqual(Array(7).fill('same'))
  })

  test('mixed-owner bulk preflight is atomic, including local intent and the change feed', async () => {
    const h = await fixture()
    const alice = await h.seed('alice', 'bulk-alice')
    const bob = await h.seed('bob', 'bulk-bob')
    const a = (await h.page('alice')).items[0]!
    const b = (await h.page('bob')).items[0]!
    const baseline = await h.inbox.changes('alice')
    await invalid(await h.request('alice', '/operations', {
      method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'mixed-owner' },
      body: JSON.stringify({ messageIds: [a.id, b.id], changes: { isRead: true, isStarred: true } }),
    }), 404)
    await expect(h.inbox.mutate('alice', { messageIds: [a.id, b.id], changes: { folder: 'trash' }, idempotencyKey: 'mixed-core' })).rejects.toMatchObject({ status: 404 })
    await h.inbox.runDue()
    expect((await h.inbox.message('alice', a.id))).toMatchObject({ isRead: false, isStarred: false, folder: 'inbox', revision: a.revision })
    expect((await h.inbox.message('bob', b.id))).toMatchObject({ isRead: false, isStarred: false, folder: 'inbox', revision: b.revision })
    expect((await h.inbox.changes('alice', { since: baseline.state })).events).toEqual([])
    expect(alice.box.calls.mutate).toEqual([])
    expect(bob.box.calls.mutate).toEqual([])
    await h.restart()
    await h.inbox.runDue()
    expect((await h.inbox.message('alice', a.id)).isRead).toBe(false)
    expect(alice.box.calls.mutate).toEqual([])
  })

  test('per-item upstream failures are durable partial results without losing successful items or unrelated intent', async () => {
    const h = await fixture()
    const { box } = await h.seed('alice', 'partial', [native('ok'), native('bad')])
    const page = await h.page()
    const ok = page.items.find(message => message.subject === 'Subject ok')!
    const bad = page.items.find(message => message.subject === 'Subject bad')!
    box.nextMutation('bad', new ProviderError(FULL, 'AUTHORIZATION', `${SECRET} ${BODY_SECRET}`, { status: 403 }))
    const operation = await h.mutate('alice', [ok.id, bad.id], { isRead: true }, 'partial-read')
    await h.inbox.runDue()
    const finished = await h.inbox.operation('alice', operation.id)
    expect(finished.status).toBe('partial')
    expect(finished.results.find(result => result.messageId === ok.id)).toEqual({ messageId: ok.id, status: 'succeeded' })
    expect(finished.results.find(result => result.messageId === bad.id)).toMatchObject({ messageId: bad.id, status: 'failed', problem: { retryable: false } })
    expect((await h.inbox.message('alice', ok.id)).isRead).toBe(true)
    expect(JSON.stringify(finished)).not.toContain(SECRET)
    expect(JSON.stringify(finished)).not.toContain(BODY_SECRET)
    const star = await h.mutate('alice', [bad.id], { isStarred: true }, 'surviving-star')
    await h.inbox.runDue()
    await h.restart()
    expect((await h.inbox.operation('alice', operation.id)).results).toEqual(finished.results)
    expect((await h.inbox.operation('alice', star.id)).status).toBe('succeeded')
    expect((await h.inbox.message('alice', bad.id)).isStarred).toBe(true)
    expect((await h.inbox.message('alice', ok.id)).isRead).toBe(true)
  })

  test('an old failed mutation cannot roll back a newer edit while its upstream request is in flight', async () => {
    const h = await fixture()
    const { box } = await h.seed('alice', 'intent-order')
    const message = (await h.page()).items[0]!
    const barrier = h.gate<void>(undefined)
    box.nextMutation('same', async () => {
      await barrier.wait()
      throw new ProviderError(FULL, 'UPSTREAM', 'Old request was rejected', { retryable: false })
    })
    const older = await h.mutate('alice', [message.id], { isRead: true }, 'older-read')
    const running = h.pending(h.inbox.runDue())
    await bounded(barrier.entered, 'old mutation upstream')
    const newer = await h.mutate('alice', [message.id], { isRead: false, isStarred: true }, 'newer-unread-star')
    expect(await h.inbox.message('alice', message.id)).toMatchObject({ isRead: false, isStarred: true })
    barrier.release()
    await bounded(running, 'old failed mutation')
    await h.inbox.runDue()
    expect((await h.inbox.operation('alice', older.id)).status).toBe('failed')
    expect((await h.inbox.operation('alice', newer.id)).status).toBe('succeeded')
    expect(await h.inbox.message('alice', message.id)).toMatchObject({ isRead: false, isStarred: true })
    await h.restart()
    expect(await h.inbox.message('alice', message.id)).toMatchObject({ isRead: false, isStarred: true })
  })

  test('a stale successful provider snapshot cannot overwrite fields owned by a newer pending operation', async () => {
    const h = await fixture()
    const { box } = await h.seed('alice', 'stale-receipt')
    const message = (await h.page()).items[0]!
    const barrier = h.gate(native('same', { isRead: true, isStarred: false }))
    box.nextMutation('same', barrier.wait)
    await h.mutate('alice', [message.id], { isRead: true }, 'read-stale-receipt')
    const running = h.pending(h.inbox.runDue())
    await bounded(barrier.entered, 'stale success receipt')
    await h.mutate('alice', [message.id], { isStarred: true }, 'newer-star')
    barrier.release()
    await bounded(running, 'stale success settlement')
    expect((await h.inbox.message('alice', message.id)).isStarred).toBe(true)
    await h.inbox.runDue()
    expect(await h.inbox.message('alice', message.id)).toMatchObject({ isRead: true, isStarred: true })
  })

  test('idempotency survives restart, rejects changed payloads, and is scoped to the authenticated owner', async () => {
    const h = await fixture()
    const alice = await h.seed('alice', 'idempotency-alice')
    await h.seed('bob', 'idempotency-bob')
    const a = (await h.page('alice')).items[0]!
    const b = (await h.page('bob')).items[0]!
    const first = await h.mutate('alice', [a.id], { isRead: true }, 'shared-key')
    const baseline = await h.inbox.changes('alice')
    const replay = await h.mutate('alice', [a.id], { isRead: true }, 'shared-key')
    expect(replay.id).toBe(first.id)
    expect((await h.inbox.changes('alice', { since: baseline.state })).events).toEqual([])
    await invalid(await h.request('alice', '/operations', {
      method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'shared-key' },
      body: JSON.stringify({ messageIds: [a.id], changes: { isRead: false } }),
    }), 409)
    const otherOwner = await h.mutate('bob', [b.id], { isRead: true }, 'shared-key')
    expect(otherOwner.id).not.toBe(first.id)
    await h.restart()
    expect((await h.mutate('alice', [a.id], { isRead: true }, 'shared-key')).id).toBe(first.id)
    await h.inbox.runDue()
    await h.inbox.runDue()
    expect(alice.box.calls.mutate).toHaveLength(1)
    const finishedReplay = await h.mutate('alice', [a.id], { isRead: true }, 'shared-key')
    expect(finishedReplay.id).toBe(first.id)
    expect(finishedReplay.status).toBe('succeeded')
  })

  test('missing idempotency and stale bulk revisions do not enqueue or apply any intent', async () => {
    const h = await fixture()
    const { box } = await h.seed('alice', 'preconditions', [native('first'), native('second')])
    const page = await h.page()
    const [first, second] = page.items as [MessageSummary, MessageSummary]
    await invalid(await h.request('alice', '/operations', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageIds: [first.id], changes: { isRead: true }, idempotencyKey: 'body-is-not-the-header' }),
    }))
    await invalid(await h.request('alice', '/operations', {
      method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'revision-preflight' },
      body: JSON.stringify({ messageIds: [first.id, second.id], changes: { isRead: true }, ifRevisions: { [first.id]: first.revision, [second.id]: second.revision + 1 } }),
    }), 412)
    await h.inbox.runDue()
    expect((await h.page()).items.every(message => !message.isRead)).toBe(true)
    expect(box.calls.mutate).toEqual([])
    expect((await h.inbox.message('alice', first.id)).revision).toBe(first.revision)
  })
})

describe('blob privacy and draft editing', () => {
  test('multipart uploads preserve arbitrary bytes and zero-byte files, and never cross account ownership', async () => {
    const h = await fixture()
    const a = await h.seed('alice', 'blob-alice')
    const b = await h.seed('bob', 'blob-bob')
    const contents = [new Uint8Array([0, 255, 13, 10, 128, 0, 42]), new Uint8Array()]
    const uploaded: BlobInfo[] = []
    for (const [index, bytes] of contents.entries()) {
      const form = new FormData()
      form.set('accountId', a.account.id)
      form.set('file', new File([bytes], index ? 'empty.txt' : 'bytes.bin', { type: index ? 'text/plain' : 'application/octet-stream' }))
      const response = await h.request('alice', '/blobs', { method: 'POST', body: form })
      expect(response.status).toBe(201)
      const info = await response.json() as BlobInfo
      uploaded.push(info)
      expect(info.size).toBe(bytes.byteLength)
      expect(info.accountId).toBe(a.account.id)
      const downloaded = await h.request('alice', `/blobs/${info.id}`)
      expect(downloaded.status).toBe(200)
      expect(downloaded.headers.get('content-type')).toContain(info.contentType)
      expect(downloaded.headers.get('content-disposition')).toContain(info.filename)
      expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes)
      await invalid(await h.request('bob', `/blobs/${info.id}`), 404)
      await expect(h.inbox.download('bob', info.id)).rejects.toMatchObject({ status: 404 })
    }
    const foreignForm = new FormData()
    foreignForm.set('accountId', b.account.id)
    foreignForm.set('file', new File(['not yours'], 'injected.txt'))
    await invalid(await h.request('alice', '/blobs', { method: 'POST', body: foreignForm }), 404)
    const foreign = await h.inbox.upload('bob', b.account.id, { filename: 'foreign.txt', contentType: 'text/plain', content: new Uint8Array([10]) })
    await invalid(await h.request('alice', '/drafts', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: a.account.id, attachmentIds: [uploaded[0]!.id, foreign.id] }),
    }), 404)
    expect(await h.inbox.drafts('alice')).toEqual([])
    await h.restart()
    for (const [index, info] of uploaded.entries()) expect((await h.inbox.download('alice', info.id)).content).toEqual(contents[index]!)
  })

  test('same-owner cross-account blobs cannot silently move into another sending identity', async () => {
    const h = await fixture()
    const first = await h.seed('alice', 'blob-source')
    const second = await h.seed('alice', 'blob-destination')
    const blob = await h.inbox.upload('alice', first.account.id, { filename: 'source.bin', contentType: 'application/octet-stream', content: new Uint8Array([1]) })
    const draft = await h.draft('alice', second.account.id)
    const tag = await etag(h, 'alice', `/drafts/${draft.id}`)
    await invalid(await h.request('alice', `/drafts/${draft.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', 'If-Match': tag },
      body: JSON.stringify({ attachmentIds: [blob.id] }),
    }))
    expect((await h.inbox.draft('alice', draft.id)).attachmentIds).toEqual([])
    expect((await h.inbox.draft('alice', draft.id)).revision).toBe(draft.revision)
  })

  test('inline CID attachments resolve to authenticated local blobs without exposing provider URLs or invoking read receipts', async () => {
    const h = await fixture()
    const upstreamUrl = `https://upstream.invalid/private?token=${SECRET}`
    const inline: Attachment = { id: 'native-inline', filename: 'plot.png', contentType: 'image/png', size: 4, url: upstreamUrl, inline: true, contentId: 'plot@example.test' }
    const { account, box } = await h.connect('alice', 'cid', [native('with-cid', {
      bodyHtml: '<p>Plot</p><img src="cid:plot@example.test"><img src="https://tracker.example.test/pixel"><script>steal()</script>',
      attachments: [inline], readReceipt: true,
    })])
    box.attachment('with-cid', inline, new Uint8Array([137, 80, 78, 71]))
    await h.sync('alice', account.id)
    const id = (await h.page()).items[0]!.id
    const response = await h.request('alice', `/messages/${id}`)
    const message = await response.json() as Message
    expect(message.attachments).toHaveLength(1)
    const blob = message.attachments[0]!
    expect(blob).toMatchObject({ inline: true, contentId: 'plot@example.test', filename: 'plot.png', size: 4 })
    expect(message.bodyHtml).toContain(`/v1/blobs/${blob.id}`)
    expect(message.bodyHtml).not.toContain('cid:plot@example.test')
    expect(message.bodyHtml).not.toContain('<script')
    expect(JSON.stringify(message)).not.toContain(upstreamUrl)
    expect(JSON.stringify(message)).not.toContain(SECRET)
    const download = await h.request('alice', `/blobs/${blob.id}`)
    expect(download.status).toBe(200)
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]))
    const before = box.calls.attachment.length
    await invalid(await h.request('bob', `/blobs/${blob.id}`), 404)
    expect(box.calls.attachment.length).toBe(before)
    expect(box.calls.attachment[0]).toMatchObject({ messageId: 'with-cid', attachmentId: 'native-inline' })
    expect(box.calls.mutate).toEqual([])
    expect((await h.inbox.message('alice', id)).isRead).toBe(false)
  })

  test('isolated email documents preserve sender roots and responsive CSS without weakening image privacy', async () => {
    const h = await fixture()
    const { account, box } = await h.connect('alice', 'email-document', [native('styled', {
      bodyHtml: `<html lang="ar" dir="rtl"><head><style>
        body { color: #123456; font-family: "Helvetica Neue", sans-serif; }
        .layout { width: 600px; }
        @media (max-width: 640px) { .layout { width: 100%; } }
        img.hidden-pixel { display: none; }
        @import url("https://unsafe.example.test/style.css");
      </style></head><body class="sender-document" style="padding:12px">
        <table class="layout"><tr><td>Example content</td></tr></table>
        <img class="hero" src="https://assets.example.test/hero.png" data-inbox-tracking="true" width="600" height="240">
        <img class="hidden-pixel" src="https://assets.example.test/hidden.png">
        <script>unsafe()</script>
      </body></html>`,
    })])
    await h.sync('alice', account.id)
    const id = (await h.page()).items[0]!.id
    const mailbox = (await h.inbox.mailboxes('alice')).find(item => item.sourceId === account.id)!
    const response = await h.request('alice', `/mailboxes/${mailbox.id}/messages/${id}`)
    expect(response.status).toBe(200)
    const blocked = await response.json() as Message
    expect(blocked.bodyFormat).toBe('html')
    expect(blocked.bodyDocument!.html).toContain('<html lang="ar" dir="rtl">')
    expect(blocked.bodyDocument!.html).toContain('<body class="sender-document" style="padding:12px">')
    expect(blocked.bodyDocument!.styles).toContain('@media (max-width: 640px)')
    expect(blocked.bodyDocument!.styles).toContain('width: 100%')
    expect(blocked.bodyHtml).toContain('width:600px')
    expect(blocked.bodyDocument!.html).toContain('<table class="layout">')
    expect(JSON.stringify(blocked.bodyDocument)).not.toContain('unsafe()')
    expect(blocked.bodyDocument!.styles).not.toContain('@import')
    const blockedImages = blocked.bodyDocument!.html.match(/<img\b[^>]*>/g)!
    expect(blockedImages[0]).toContain('data-openmail-src="https://assets.example.test/hero.png"')
    expect(blockedImages[0]).not.toContain('data-inbox-tracking')
    expect(blockedImages[1]).toContain('data-inbox-tracking="true"')
    expect(blockedImages[1]).not.toMatch(/\ssrc=/)
    expect(blockedImages[1]).not.toContain('data-openmail-src')
    await h.inbox.setPolicy('alice', { remoteImages: true })
    const allowed = await (await h.request('alice', `/mailboxes/${mailbox.id}/messages/${id}`)).json() as Message
    const allowedImages = allowed.bodyDocument!.html.match(/<img\b[^>]*>/g)!
    expect(allowedImages[0]).toMatch(new RegExp(`src="/v1/messages/${id}/media/[A-Za-z\\d_-]{43}"`))
    expect(allowedImages[0]).not.toContain('https://assets.example.test/hero.png')
    expect(allowedImages[1]).toContain('data-inbox-tracking="true"')
    expect(allowedImages[1]).not.toMatch(/\ssrc=/)
    expect(box.calls.mutate).toEqual([])
    expect(allowed.isRead).toBe(false)
    await invalid(await h.request('bob', `/mailboxes/${mailbox.id}/messages/${id}`), 404)
  })

  test('email backgrounds follow image policy while retaining safe layout and authenticated inline resources', async () => {
    const h = await fixture()
    const inline: Attachment = { id: 'background-part', filename: 'cover.png', contentType: 'image/png', size: 4, url: 'https://upstream.example.test/cover.png', inline: true, contentId: 'cover@example.test' }
    const { account, box } = await h.connect('alice', 'email-backgrounds', [native('backgrounds', {
      bodyHtml: `<html><head><style>
        .hero { background: #123456 url("https://assets.example.test/hero.png") center / cover no-repeat; }
        .pixel { background-image: url("https://tracker.example.test/pixel"); }
      </style></head><body>
        <table background="https://assets.example.test/table.png"><tr><td class="hero">Example content</td></tr></table>
        <div style="background-image:url(cid:cover@example.test);background-size:contain;background-repeat:no-repeat">Inline cover</div>
        <div style="background-image:url(javascript:unsafe())">Safe text</div>
      </body></html>`,
      attachments: [inline],
    }), native('background-only', {
      bodyHtml: '<html><head><style>@media (min-width: 300px) { .poster { height:180px; background-image:url("https://assets.example.test/poster.png"); } }</style></head><body><div class="poster"></div></body></html>',
      bodyText: 'Picture alternative',
    })])
    await h.sync('alice', account.id)
    const rows = (await h.page()).items
    const id = rows.find(row => row.subject === 'Subject backgrounds')!.id
    const blocked = await h.inbox.message('alice', id)
    const blob = blocked.attachments[0]!
    expect(blocked.bodyDocument!.styles).toContain('#123456')
    expect(JSON.stringify(blocked.bodyDocument)).not.toContain('https://assets.example.test')
    expect(JSON.stringify(blocked.bodyDocument)).not.toContain('javascript:')
    expect(blocked.bodyDocument!.html).toContain(`/v1/blobs/${blob.id}`)
    await h.inbox.setPolicy('alice', { remoteImages: true })
    const message = await (await h.request('alice', `/messages/${id}`)).json() as Message
    expect(message.bodyDocument!.styles).toContain(`url("/v1/messages/${id}/media/`)
    expect(message.bodyDocument!.styles).toContain('cover')
    expect(message.bodyDocument!.html).toContain(`background="/v1/messages/${id}/media/`)
    expect(message.bodyDocument!.html).toContain(`/v1/blobs/${blob.id}`)
    expect(JSON.stringify(message.bodyDocument)).not.toContain('tracker.example.test')
    expect(JSON.stringify(message.bodyDocument)).not.toContain('javascript:')
    expect(box.calls.mutate).toEqual([])
    expect(message.isRead).toBe(false)
    const poster = await h.inbox.message('alice', rows.find(row => row.subject === 'Subject background-only')!.id)
    expect(poster.bodyFormat).toBe('html')
    expect(poster.bodyDocument!.styles).toContain(`url("/v1/messages/${poster.id}/media/`)
  })

  test('plain email reads preserve exact text and use it when HTML is empty or noncontent', async () => {
    const h = await fixture()
    const bodyText = '\n  Literal <tags> & symbols\r\n\tquoted > reply\nhttps://example.test/path(test).\ntrailing  \n'
    const variants = ['', '  \n ', '<html><head><script>unsafe()</script></head><body><div> </div></body></html>', '<img src="https://tracker.example.test/pixel" width="1" height="1" alt="Tracking pixel">']
    const { account, box } = await h.connect('alice', 'plain-email', [
      ...variants.map((bodyHtml, index) => native(`plain-${index}`, { bodyHtml, bodyText })),
      native('image-only', { bodyHtml: '<img src="https://assets.example.test/photo.png" alt="Example photo">', bodyText: 'Image alternative' }),
    ])
    await h.sync('alice', account.id)
    const rows = (await h.page()).items
    for (const row of rows) {
      const response = await h.request('alice', `/messages/${row.id}`)
      expect(response.status).toBe(200)
      const message = await response.json() as Message
      if (row.subject === 'Subject image-only') {
        expect(message.bodyFormat).toBe('html')
        expect(message.bodyDocument!.html).toContain('alt="Example photo"')
      } else {
        expect(message.bodyText).toBe(bodyText)
        expect(message.bodyFormat).toBe('text')
        expect(message.bodyDocument).toBeUndefined()
        expect(message.bodyHtml).toContain('&lt;tags&gt; &amp; symbols')
        expect(message.bodyHtml).not.toContain('<script')
      }
      expect(message.isRead).toBe(false)
    }
    expect(rows).toHaveLength(5)
    expect(box.calls.mutate).toEqual([])
  })

  test('incomplete autosaves preserve exact text and editor HTML, with multiple independent drafts per source thread', async () => {
    const h = await fixture()
    const { account, box } = await h.seed('alice', 'autosave')
    const source = (await h.page()).items[0]!
    const bodyText = '  unfinished\r\n\ntrailing spaces  \n'
    const bodyHtml = '<p data-editor-node="n1">  unfinished <strong>bold</strong></p>\n<p><br></p>'
    const draft = await h.draft('alice', account.id, { subject: '', bodyText, bodyHtml, to: [], cc: [], bcc: [] })
    expect(draft).toMatchObject({ status: 'active', bodyText, bodyHtml, to: [], cc: [], bcc: [], attachmentIds: [] })
    const replyOne = await h.draft('alice', account.id, { mode: 'reply', sourceMessageId: source.id })
    const replyTwo = await h.draft('alice', account.id, { mode: 'reply', sourceMessageId: source.id })
    expect(replyOne.id).not.toBe(replyTwo.id)
    expect(replyOne.sourceMessageId).toBe(source.id)
    expect(replyTwo.sourceMessageId).toBe(source.id)
    const tag = await etag(h, 'alice', `/drafts/${draft.id}`)
    const saved = await h.json<Draft>('alice', `/drafts/${draft.id}`, { subject: '  Still incomplete  ' }, 'PATCH', 200, { 'If-Match': tag })
    expect(saved.subject).toBe('  Still incomplete  ')
    expect(saved.bodyText).toBe(bodyText)
    expect(saved.bodyHtml).toBe(bodyHtml)
    expect(saved.revision).toBeGreaterThan(draft.revision)
    expect(box.calls.send).toEqual([])
    await h.restart()
    expect(await h.inbox.draft('alice', draft.id)).toMatchObject({ subject: saved.subject, bodyText, bodyHtml, revision: saved.revision })
    expect((await h.inbox.drafts('alice', account.id)).map(item => item.id).sort()).toEqual([draft.id, replyOne.id, replyTwo.id].sort())
  })

  test('reply-all uses the exact selected message, respects Reply-To, removes every own alias, and keeps edits authoritative', async () => {
    const h = await fixture()
    const old = native('old-source', {
      threadId: 'one-thread', rfcMessageId: '<old-source@example.test>', references: ['<root@example.test>'],
      from: participant('author@example.test'), replyTo: [participant('reply-desk@example.test')],
      to: [participant('REPLY@example.test'), participant('ALIAS@example.test'), participant('teammate@example.test')],
      cc: [participant('watcher@example.test'), participant('teammate@example.test'), participant('other-own@example.test')],
      bcc: [participant('invisible@example.test')], subject: 'Selected older source',
      bodyText: 'Exact older source quotation', bodyHtml: '<p>Exact older source quotation</p>', receivedAt: '2026-08-29T00:00:00.000Z',
    })
    const latest = native('latest-source', {
      threadId: 'one-thread', rfcMessageId: '<latest-source@example.test>',
      from: participant('wrong-latest-author@example.test'), subject: 'Wrong latest source',
      bodyText: 'Do not quote the latest source', receivedAt: '2026-08-31T00:00:00.000Z',
    })
    const { account, box } = await h.seed('alice', 'reply', [old, latest], FULL, ['alias@example.test', 'other-own@example.test'])
    const selected = (await h.page()).items.find(message => message.subject === old.subject)!
    const draft = await h.draft('alice', account.id, { mode: 'replyAll', sourceMessageId: selected.id })
    expect(draft.to.map(item => item.email.toLowerCase()).sort()).toEqual(['reply-desk@example.test', 'teammate@example.test'])
    expect(draft.cc.map(item => item.email.toLowerCase())).toEqual(['watcher@example.test'])
    expect(draft.bcc).toEqual([])
    expect(draft.subject).toContain('Selected older source')
    expect(draft.bodyText).not.toContain('Do not quote the latest source')
    const tag = await etag(h, 'alice', `/drafts/${draft.id}`)
    const edited = await h.json<Draft>('alice', `/drafts/${draft.id}`, {
      to: [participant('edited@example.test')], cc: [], bcc: [participant('private-outgoing@example.test')],
      subject: 'My edited subject', bodyText: 'My exact reply', bodyHtml: '<p>My exact reply</p>',
    }, 'PATCH', 200, { 'If-Match': tag })
    await h.inbox.setPolicy('alice', { undoSendSeconds: 0 })
    const operation = await h.submit('alice', edited, 'reply-selected-source')
    await h.inbox.runDue()
    expect((await h.inbox.operation('alice', operation.id)).status).toBe('succeeded')
    const sent = box.calls.send[0]!
    expect(sent.to).toEqual([participant('edited@example.test')])
    expect(sent.cc ?? []).toEqual([])
    expect(sent.bcc).toEqual([participant('private-outgoing@example.test')])
    expect(sent.subject).toBe('My edited subject')
    expect(sent.bodyText ?? sent.text).toBe('My exact reply')
    expect(sent.threadId).toBe('one-thread')
    expect(sent.inReplyTo).toBe('<old-source@example.test>')
    expect(sent.references).toEqual(['<root@example.test>', '<old-source@example.test>'])
    expect(JSON.stringify(sent)).not.toContain('latest-source')
  })

  test('forwarding quotes the selected source without inheriting private recipients or replying to the thread', async () => {
    const h = await fixture()
    const { account, box } = await h.seed('alice', 'forward', [native('forward-source', {
      threadId: 'source-thread', rfcMessageId: '<source@example.test>',
      subject: 'Forward this', bodyText: 'The selected forward body', bodyHtml: '<p>The selected forward body</p>',
      bcc: [participant('secret-original@example.test')],
    })])
    const source = (await h.page()).items[0]!
    const draft = await h.draft('alice', account.id, { mode: 'forward', sourceMessageId: source.id })
    expect(draft.to).toEqual([])
    expect(draft.cc).toEqual([])
    expect(draft.bcc).toEqual([])
    expect(draft.bodyText).toContain('The selected forward body')
    expect(draft.subject).toMatch(/^Fwd:/i)
    const edited = await h.inbox.updateDraft('alice', draft.id, { to: [participant('forward-target@example.test')] }, draft.revision)
    await h.inbox.setPolicy('alice', { undoSendSeconds: 0 })
    await h.submit('alice', edited, 'forward-send')
    await h.inbox.runDue()
    expect(box.calls.send[0]!.inReplyTo).toBeUndefined()
    expect(box.calls.send[0]!.threadId).toBeUndefined()
    expect(JSON.stringify(box.calls.send[0])).not.toContain('secret-original@example.test')
  })

  test('foreign and cross-account source messages are rejected before creating a reply draft', async () => {
    const h = await fixture()
    const a = await h.seed('alice', 'source-a')
    const sameOwner = await h.seed('alice', 'source-a2')
    await h.seed('bob', 'source-b')
    const ownSource = (await h.page('alice', { accountId: sameOwner.account.id })).items[0]!
    const foreign = (await h.page('bob')).items[0]!
    for (const sourceMessageId of [foreign.id, ownSource.id, 'missing-source']) {
      await invalid(await h.request('alice', '/drafts', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: a.account.id, mode: 'reply', sourceMessageId }),
      }))
    }
    await invalid(await h.request('alice', '/drafts', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: a.account.id, mode: 'replyAll' }),
    }))
    expect(await h.inbox.drafts('alice')).toEqual([])
  })

  test('draft PATCH and DELETE enforce strong revisions and competing editors cannot lose an update', async () => {
    const h = await fixture()
    const { account } = await h.seed('alice', 'draft-revisions')
    const draft = await h.draft('alice', account.id, { to: [participant('recipient@example.test')], bodyText: 'Preserve me' })
    const path = `/drafts/${draft.id}`
    const tag = await etag(h, 'alice', path)
    expect(tag.startsWith('W/')).toBe(false)
    await invalid(await h.request('alice', path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subject: 'No condition' }) }), 428)
    const competing = await Promise.all(['Editor A', 'Editor B'].map(subject => h.request('alice', path, {
      method: 'PATCH', headers: { 'content-type': 'application/json', 'If-Match': tag }, body: JSON.stringify({ subject }),
    })))
    expect(competing.map(response => response.status).sort()).toEqual([200, 412])
    const winner = await competing.find(response => response.status === 200)!.json() as Draft
    const saved = await h.inbox.draft('alice', draft.id)
    expect(saved.subject).toBe(winner.subject)
    expect(saved.bodyText).toBe('Preserve me')
    expect(saved.to).toEqual(draft.to)
    expect(saved.revision).toBe(draft.revision + 1)
    await invalid(await h.request('alice', path, { method: 'DELETE' }), 428)
    await invalid(await h.request('alice', path, { method: 'DELETE', headers: { 'If-Match': tag } }), 412)
    const current = await etag(h, 'alice', path)
    const response = await h.request('alice', path, { method: 'DELETE', headers: { 'If-Match': current } })
    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
    await invalid(await h.request('alice', path), 404)
    expect(await h.inbox.drafts('alice')).toEqual([])
  })
})

describe('atomic draft submission and send scheduling', () => {
  test('submission validates recipients, sender, revision, and header idempotency without consuming an autosave', async () => {
    const h = await fixture()
    const { account, box } = await h.seed('alice', 'submit-validation')
    const incomplete = await h.draft('alice', account.id, { subject: 'Not ready', bodyText: 'Keep this text' })
    await invalid(await h.request('alice', `/drafts/${incomplete.id}/submit`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'incomplete' }, body: JSON.stringify({ revision: incomplete.revision }),
    }))
    expect(await h.inbox.draft('alice', incomplete.id)).toMatchObject({ status: 'active', revision: incomplete.revision, bodyText: 'Keep this text' })
    const complete = await h.inbox.updateDraft('alice', incomplete.id, { to: [participant('recipient@example.test')] }, incomplete.revision)
    await invalid(await h.request('alice', `/drafts/${complete.id}/submit`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'stale-submit' }, body: JSON.stringify({ revision: incomplete.revision }),
    }), 412)
    await invalid(await h.request('alice', `/drafts/${complete.id}/submit`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: complete.revision, idempotencyKey: 'body-key' }),
    }))
    const spoofed = await h.draft('alice', account.id, { from: 'not-an-own-address@example.test', to: [participant('recipient@example.test')], subject: 'Spoof' })
    await invalid(await h.request('alice', `/drafts/${spoofed.id}/submit`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'spoofed-sender' }, body: JSON.stringify({ revision: spoofed.revision }),
    }))
    await h.inbox.runDue()
    expect(box.calls.send).toEqual([])
    expect((await h.inbox.draft('alice', complete.id)).status).toBe('active')
  })

  test('simultaneous submit requests atomically consume a draft once; the winning idempotency key replays after restart', async () => {
    const h = await fixture()
    const { account, box } = await h.seed('alice', 'atomic-submit')
    const draft = await h.draft('alice', account.id, { to: [participant('recipient@example.test')], subject: 'One send', bodyText: 'One immutable body' })
    const responses = await Promise.all(['first-submit', 'second-submit'].map(key => h.request('alice', `/drafts/${draft.id}/submit`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ revision: draft.revision }),
    })))
    expect(responses.map(response => response.status).sort()).toEqual([202, 409])
    const index = responses.findIndex(response => response.status === 202)
    const operation = await responses[index]!.json() as Operation
    const winningKey = ['first-submit', 'second-submit'][index]!
    expect((await h.inbox.draft('alice', draft.id)).status).toBe('submitted')
    expect((await h.submit('alice', draft, winningKey)).id).toBe(operation.id)
    await h.restart()
    expect((await h.submit('alice', draft, winningKey)).id).toBe(operation.id)
    h.clock.value += 120_000
    await h.inbox.runDue()
    await h.inbox.runDue()
    expect(box.calls.send).toHaveLength(1)
    expect((await h.inbox.operation('alice', operation.id)).status).toBe('succeeded')
    await invalid(await h.request('alice', `/drafts/${draft.id}/submit`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': winningKey },
      body: JSON.stringify({ revision: draft.revision, sendAt: new Date(EPOCH + 3_600_000).toISOString() }),
    }), 409)
  })

  test('queued delivery uses an immutable body, recipients, and byte payload, and the send echo keeps one public message identity', async () => {
    const h = await fixture()
    const { account, box } = await h.seed('alice', 'immutable')
    const blob = await h.inbox.upload('alice', account.id, { filename: 'binary.bin', contentType: 'application/octet-stream', content: new Uint8Array([0, 255, 1]) })
    const draft = await h.draft('alice', account.id, {
      to: [participant('original@example.test')], subject: 'Immutable queued subject',
      bodyText: 'Original queued text', bodyHtml: '<p>Original queued HTML</p>', attachmentIds: [blob.id],
    })
    const operation = await h.submit('alice', draft, 'immutable-send')
    expect(box.calls.send).toEqual([])
    const submitted = await h.inbox.draft('alice', draft.id)
    await invalid(await h.request('alice', `/drafts/${draft.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', 'If-Match': await etag(h, 'alice', `/drafts/${draft.id}`) },
      body: JSON.stringify({ bodyText: 'Attempted mutation', to: [participant('wrong@example.test')], attachmentIds: [] }),
    }), 409)
    expect((await h.inbox.draft('alice', draft.id)).revision).toBe(submitted.revision)
    h.clock.value += 120_000
    await h.inbox.runDue()
    const payload = box.calls.send[0]!
    expect(payload.to).toEqual([participant('original@example.test')])
    expect(payload.subject).toBe('Immutable queued subject')
    expect(payload.bodyText ?? payload.text).toBe('Original queued text')
    expect(payload.bodyHtml ?? payload.html).toBe('<p>Original queued HTML</p>')
    expect(payload.attachments).toHaveLength(1)
    const sentAttachment = payload.attachments![0]!
    expect(sentAttachment.filename).toBe('binary.bin')
    const bytes = typeof sentAttachment.content === 'string'
      ? new Uint8Array(Buffer.from(sentAttachment.content, sentAttachment.encoding === 'base64' ? 'base64' : 'utf8'))
      : new Uint8Array(sentAttachment.content)
    expect(bytes).toEqual(new Uint8Array([0, 255, 1]))
    expect((await h.inbox.operation('alice', operation.id)).status).toBe('succeeded')
    const optimisticSent = await h.page('alice', { folder: 'sent' })
    expect(optimisticSent.items.map(message => message.subject)).toEqual(['Immutable queued subject'])
    const publicId = optimisticSent.items[0]!.id
    await h.sync('alice', account.id)
    await h.sync('alice', account.id)
    const echoed = await h.page('alice', { folder: 'sent' })
    expect(echoed.total).toBe(1)
    expect(echoed.items[0]!.id).toBe(publicId)
    expect((await h.inbox.message('alice', publicId)).bodyText).toBe('Original queued text')
  })

  test('default undo-send holds delivery; cancel and undo stop dispatch and preserve an editable draft', async () => {
    const h = await fixture()
    const { account, box } = await h.seed('alice', 'undo-send')
    const policy = await h.json<Policy>('alice', '/policy')
    expect(policy.undoSendSeconds).toBeGreaterThan(0)
    for (const action of ['cancel', 'undo']) {
      const draft = await h.draft('alice', account.id, { to: [participant('recipient@example.test')], subject: action, bodyText: 'Keep this draft' })
      const operation = await h.submit('alice', draft, `held-${action}`)
      expect(operation.status).toBe('pending')
      expect(Date.parse(operation.sendAt!)).toBe(h.clock.value + policy.undoSendSeconds * 1000)
      await h.inbox.runDue()
      expect(box.calls.send).toEqual([])
      const cancelled = await h.json<Operation>('alice', `/operations/${operation.id}/${action}`, {}, 'POST')
      expect(cancelled.status).toBe('cancelled')
      expect((await h.inbox.draft('alice', draft.id))).toMatchObject({ status: 'active', bodyText: 'Keep this draft' })
      const replay = await h.submit('alice', draft, `held-${action}`)
      expect(replay.id).toBe(operation.id)
      expect(replay.status).toBe('cancelled')
    }
    h.clock.value += 3_600_000
    await h.restart()
    await h.inbox.runDue()
    expect(box.calls.send).toEqual([])
  })

  test('schedule and reschedule use current durable deadlines rather than stale in-memory timers', async () => {
    const h = await fixture()
    const { account, box } = await h.seed('alice', 'schedule')
    const draft = await h.draft('alice', account.id, { to: [participant('recipient@example.test')], subject: 'Scheduled', bodyText: 'Later' })
    const initial = new Date(EPOCH + 60_000).toISOString()
    const later = new Date(EPOCH + 120_000).toISOString()
    const operation = await h.submit('alice', draft, 'scheduled-send', initial)
    expect(operation.sendAt).toBe(initial)
    const changed = await h.json<Operation>('alice', `/operations/${operation.id}/reschedule`, { sendAt: later }, 'POST')
    expect(changed.id).toBe(operation.id)
    expect(changed.sendAt).toBe(later)
    await invalid(await h.request('alice', `/operations/${operation.id}/reschedule`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sendAt: 'not-a-date' }),
    }), 400)
    h.clock.value = EPOCH + 60_001
    await h.inbox.runDue()
    expect(box.calls.send).toEqual([])
    await h.restart()
    h.clock.value = EPOCH + 119_999
    await h.inbox.runDue()
    expect(box.calls.send).toEqual([])
    h.clock.value = EPOCH + 120_000
    await h.inbox.runDue()
    expect(box.calls.send).toHaveLength(1)
    expect((await h.inbox.operation('alice', operation.id)).status).toBe('succeeded')
    await invalid(await h.request('alice', `/operations/${operation.id}/cancel`, { method: 'POST' }), 409)
    await invalid(await h.request('alice', `/operations/${operation.id}/reschedule`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sendAt: new Date(EPOCH + 180_000).toISOString() }),
    }), 409)
  })

  test('a transport failure with an unknown send outcome is uncertain and is never automatically retried', async () => {
    const h = await fixture()
    const { account, box } = await h.seed('alice', 'unknown-send')
    await h.inbox.setPolicy('alice', { undoSendSeconds: 0 })
    box.nextSend(new ProviderError(FULL, 'NETWORK', `${SECRET}: connection lost after acceptance`, { retryable: true }))
    const draft = await h.draft('alice', account.id, { to: [participant('recipient@example.test')], subject: 'Unknown outcome', bodyText: BODY_SECRET })
    const operation = await h.submit('alice', draft, 'uncertain-send')
    await h.inbox.runDue()
    const result = await h.inbox.operation('alice', operation.id)
    expect(result.status).toBe('uncertain')
    expect(result.attempts).toBe(1)
    expect(result.problem?.retryable).toBe(false)
    expect(JSON.stringify(result)).not.toContain(SECRET)
    expect(JSON.stringify(result)).not.toContain(BODY_SECRET)
    for (let attempt = 0; attempt < 3; attempt++) {
      h.clock.value += 86_400_000
      await h.restart()
      await h.inbox.runDue()
      const replay = await h.submit('alice', draft, 'uncertain-send')
      expect(replay.id).toBe(operation.id)
      expect(replay.status).toBe('uncertain')
    }
    expect(box.calls.send).toHaveLength(1)
    expect((await h.page('alice', { folder: 'sent' })).total).toBe(0)
  })

  test('a definitive retryable rejection can retry, but a definitive permanent failure does not claim success', async () => {
    const h = await fixture()
    const { account, box } = await h.seed('alice', 'send-failures')
    await h.inbox.setPolicy('alice', { undoSendSeconds: 0 })
    box.nextSend(new ProviderRateLimitError(FULL, 'Definitively rejected before send', { retryAfter: 2 }))
    const retryDraft = await h.draft('alice', account.id, { to: [participant('recipient@example.test')], subject: 'Safe retry' })
    const retry = await h.submit('alice', retryDraft, 'safe-retry')
    await h.inbox.runDue()
    expect((await h.inbox.operation('alice', retry.id)).status).toBe('pending')
    expect(box.calls.send).toHaveLength(1)
    h.clock.value += 60_000
    await h.inbox.runDue()
    expect((await h.inbox.operation('alice', retry.id))).toMatchObject({ status: 'succeeded', attempts: 2 })
    box.nextSend(new ProviderError(FULL, 'VALIDATION', 'Recipient rejected', { status: 422, retryable: false }))
    const badDraft = await h.draft('alice', account.id, { to: [participant('rejected@example.test')], subject: 'No delivery' })
    const failed = await h.submit('alice', badDraft, 'permanent-send-failure')
    await h.inbox.runDue()
    expect((await h.inbox.operation('alice', failed.id))).toMatchObject({ status: 'failed', attempts: 1, problem: { retryable: false } })
    h.clock.value += 86_400_000
    await h.inbox.runDue()
    expect(box.calls.send).toHaveLength(3)
    expect((await h.page('alice', { folder: 'sent' })).items.map(message => message.subject)).toEqual(['Safe retry'])
  })
})

describe('worker leases, sync checkpoints, and delayed actions', () => {
  test('two SQLite workers cannot dispatch the same claimed send concurrently', async () => {
    const h = await fixture()
    const { account, box } = await h.seed('alice', 'lease-send')
    await h.inbox.setPolicy('alice', { undoSendSeconds: 0 })
    const draft = await h.draft('alice', account.id, { to: [participant('recipient@example.test')], subject: 'Claim exactly once' })
    const operation = await h.submit('alice', draft, 'lease-send')
    const barrier = h.gate<SendResult>({ id: 'claimed-native-send', messageId: '<claimed@example.test>' })
    box.nextSend(barrier.wait)
    const worker = h.worker()
    const first = h.pending(h.inbox.runDue())
    await bounded(barrier.entered, 'first send claim')
    await bounded(worker.runDue(), 'second worker observing an unexpired lease')
    expect(box.calls.send).toHaveLength(1)
    expect((await worker.operation('alice', operation.id)).status).toBe('processing')
    barrier.release()
    await bounded(first, 'claimed send receipt')
    await Promise.all([h.inbox.runDue(), worker.runDue()])
    expect(box.calls.send).toHaveLength(1)
    expect((await worker.operation('alice', operation.id))).toMatchObject({ status: 'succeeded', attempts: 1 })
  })

  test('an expired send lease is uncertain, not permission for a second worker to send again', async () => {
    const h = await fixture({ leaseMs: 1000 })
    const { account, box } = await h.seed('alice', 'expired-send-lease')
    await h.inbox.setPolicy('alice', { undoSendSeconds: 0 })
    const draft = await h.draft('alice', account.id, { to: [participant('recipient@example.test')], subject: 'May already be accepted' })
    const operation = await h.submit('alice', draft, 'expired-lease-send')
    const barrier = h.gate<SendResult>({ id: 'late-native-receipt', messageId: '<late@example.test>' })
    box.nextSend(barrier.wait)
    const first = h.pending(h.inbox.runDue())
    await bounded(barrier.entered, 'send before lease expiry')
    h.clock.value += 1001
    const worker = h.worker()
    await worker.runDue()
    expect(box.calls.send).toHaveLength(1)
    expect((await worker.operation('alice', operation.id)).status).toBe('uncertain')
    barrier.release()
    await bounded(first, 'expired owner receipt')
    expect((await worker.operation('alice', operation.id)).status).toBe('uncertain')
    await h.restart()
    h.clock.value += 86_400_000
    await h.inbox.runDue()
    expect(box.calls.send).toHaveLength(1)
    expect((await h.inbox.operation('alice', operation.id)).status).toBe('uncertain')
  })

  test('retry-safe mutation leases can be reclaimed and a stale worker cannot replace the new receipt', async () => {
    const h = await fixture({ leaseMs: 1000 })
    const { box } = await h.seed('alice', 'mutation-lease')
    const message = (await h.page()).items[0]!
    const barrier = h.gate<void>(undefined)
    box.nextMutation('same', async () => {
      await barrier.wait()
      throw new ProviderError(FULL, 'UPSTREAM', 'Stale worker failure', { retryable: false })
    })
    const operation = await h.mutate('alice', [message.id], { isRead: true }, 'reclaim-read')
    const oldWorker = h.pending(h.inbox.runDue())
    await bounded(barrier.entered, 'mutation lease acquisition')
    h.clock.value += 1001
    const worker = h.worker()
    await worker.runDue()
    expect((await worker.operation('alice', operation.id)).status).toBe('succeeded')
    expect((await worker.message('alice', message.id)).isRead).toBe(true)
    barrier.release()
    await bounded(oldWorker, 'stale mutation failure')
    expect((await worker.operation('alice', operation.id)).status).toBe('succeeded')
    expect((await worker.message('alice', message.id)).isRead).toBe(true)
    expect(box.calls.mutate).toHaveLength(2)
  })

  test('duplicate sync echoes update native identities in place without duplicate messages, threads, or arrival events', async () => {
    const h = await fixture()
    const { account, box } = await h.seed('alice', 'sync-echo', [native('native-stable', { threadId: 'native-conversation' })])
    const before = (await h.page()).items[0]!
    const baseline = await h.inbox.changes('alice')
    const echo = native('native-stable', { threadId: 'native-conversation', isRead: true, isStarred: true, bodyText: 'Updated cached body' })
    box.nextSync(receipt([echo, structuredClone(echo)], 'echo-1'))
    await h.sync('alice', account.id)
    const after = (await h.page()).items[0]!
    expect(after.id).toBe(before.id)
    expect(after.threadId).toBe(before.threadId)
    expect(after.revision).toBeGreaterThan(before.revision)
    expect(after).toMatchObject({ isRead: true, isStarred: true })
    expect((await h.page()).total).toBe(1)
    expect((await h.json<Page<ThreadSummary>>('alice', '/threads')).total).toBe(1)
    box.nextSync(receipt([echo], 'echo-2'))
    await h.sync('alice', account.id)
    expect((await h.page()).items[0]!.id).toBe(before.id)
    expect((await h.inbox.message('alice', before.id)).bodyText).toBe('Updated cached body')
    const events = await h.inbox.changes('alice', { since: baseline.state, limit: 100 })
    expect(events.events.filter(event => event.type === 'mail.changed' && event.reason === 'arrival')).toEqual([])
    await h.restart()
    expect((await h.page()).items[0]!.id).toBe(before.id)
  })

  test('latest and backfill maintain independent checkpoints; backfill cannot regress current content or announce old mail as arrivals', async () => {
    const h = await fixture()
    const { account, box } = await h.connect('alice', 'sync-lanes')
    const baseline = await h.inbox.changes('alice')
    const current = native('current', { isRead: true, bodyText: 'Current authoritative body', receivedAt: '2026-09-01T11:00:00.000Z' })
    box.nextSync(receipt([current], 'latest-1', { fullSync: true, hasMore: true }))
    await h.sync('alice', account.id, { lane: 'latest' })
    const currentId = (await h.page()).items[0]!.id
    expect((await h.inbox.account('alice', account.id)).sync.coverage).toBe('partial')
    box.nextSync(receipt([
      native('old', { receivedAt: '2020-01-01T00:00:00.000Z' }),
      native('current', { isRead: false, bodyText: 'Obsolete backfill body', receivedAt: current.receivedAt }),
    ], 'backfill-1', { hasMore: true }))
    await h.sync('alice', account.id, { lane: 'backfill' })
    expect(cursorValue(box.calls.sync[1]!.cursor)).toBeNull()
    expect(await h.inbox.message('alice', currentId)).toMatchObject({ isRead: true, bodyText: 'Current authoritative body' })
    box.nextSync(receipt([native('new-arrival', { receivedAt: '2026-09-01T12:01:00.000Z' })], 'latest-2'))
    await h.sync('alice', account.id, { lane: 'latest' })
    expect(cursorValue(box.calls.sync[2]!.cursor)).toBe('latest-1')
    box.nextSync(receipt([native('oldest', { receivedAt: '2010-01-01T00:00:00.000Z' })], 'backfill-2'))
    await h.sync('alice', account.id, { lane: 'backfill' })
    expect(cursorValue(box.calls.sync[3]!.cursor)).toBe('backfill-1')
    expect((await h.inbox.account('alice', account.id)).sync.coverage).toBe('complete')
    const page = await h.page()
    expect(page.total).toBe(4)
    const arrivalId = page.items.find(message => message.subject === 'Subject new-arrival')!.id
    const oldIds = page.items.filter(message => ['Subject old', 'Subject oldest'].includes(message.subject)).map(message => message.id)
    const changes = await h.inbox.changes('alice', { since: baseline.state, limit: 100 })
    expect(changes.events.filter(event => event.type === 'mail.changed' && event.entityId === currentId).every(event => event.reason !== 'arrival')).toBe(true)
    expect(changes.events.filter(event => oldIds.includes(event.entityId)).map(event => event.reason)).toEqual(['backfill', 'backfill'])
    expect(changes.events.filter(event => event.type === 'mail.changed' && event.reason === 'arrival').map(event => event.entityId)).toEqual([arrivalId])
  })

  test('a fresh upstream sync refreshes content while preserving unapplied local mutation intent through restart', async () => {
    const h = await fixture()
    const { account, box } = await h.seed('alice', 'sync-pending-intent')
    const message = (await h.page()).items[0]!
    const operation = await h.mutate('alice', [message.id], { isRead: true, isStarred: true }, 'offline-intent')
    box.put(native('same', { bodyText: 'Fresh remote content', isRead: false, isStarred: false }))
    await h.sync('alice', account.id)
    expect(await h.inbox.message('alice', message.id)).toMatchObject({ bodyText: 'Fresh remote content', isRead: true, isStarred: true })
    expect(box.calls.mutate).toEqual([])
    await h.restart()
    expect(await h.inbox.message('alice', message.id)).toMatchObject({ bodyText: 'Fresh remote content', isRead: true, isStarred: true })
    await h.inbox.runDue()
    expect((await h.inbox.operation('alice', operation.id)).status).toBe('succeeded')
    expect(box.calls.mutate).toHaveLength(1)
    expect(await h.inbox.message('alice', message.id)).toMatchObject({ bodyText: 'Fresh remote content', isRead: true, isStarred: true })
  })

  test('failed sync does not advance the cursor or destroy cached mail; restart retries the last committed checkpoint', async () => {
    const h = await fixture()
    const { account, box } = await h.seed('alice', 'sync-recovery')
    const original = (await h.page()).items[0]!
    box.nextSync(new ProviderError(FULL, 'NETWORK', `${SECRET} ${BODY_SECRET}`, { retryable: true }))
    await expect(h.inbox.sync('alice', account.id)).rejects.toBeDefined()
    const failedCursor = cursorValue(box.calls.sync.at(-1)!.cursor)
    expect(failedCursor).not.toBeNull()
    expect(await h.inbox.message('alice', original.id)).toMatchObject({ revision: original.revision, subject: original.subject })
    await h.restart()
    box.nextSync(receipt([native('recovered')], 'recovered-cursor'))
    await h.sync('alice', account.id)
    expect(cursorValue(box.calls.sync.at(-1)!.cursor)).toBe(failedCursor)
    expect((await h.page()).total).toBe(2)
    expect((await h.inbox.account('alice', account.id)).sync.problem).toBeNull()
    expect(JSON.stringify(h.logs)).not.toContain(SECRET)
    expect(JSON.stringify(h.logs)).not.toContain(BODY_SECRET)
  })

  test('an expired provider cursor restarts safely without changing public IDs or inventing arrivals', async () => {
    const h = await fixture()
    const { account, box } = await h.seed('alice', 'expired-cursor')
    const message = (await h.page()).items[0]!
    const baseline = await h.inbox.changes('alice')
    box.nextSync(new ProviderCursorExpiredError(FULL))
    box.nextSync(receipt([native('same', { isRead: true })], 'fresh-checkpoint', { fullSync: true }))
    await h.sync('alice', account.id)
    expect(cursorValue(box.calls.sync.at(-2)!.cursor)).not.toBeNull()
    expect(cursorValue(box.calls.sync.at(-1)!.cursor)).toBeNull()
    expect((await h.page()).items.map(item => item.id)).toEqual([message.id])
    expect((await h.inbox.message('alice', message.id)).isRead).toBe(true)
    expect((await h.inbox.changes('alice', { since: baseline.state })).events.filter(event => event.reason === 'arrival')).toEqual([])
  })

  test('a failed SQLite sync commit exposes neither a partial page nor an advanced checkpoint', async () => {
    const h = await fixture()
    const { account, box } = await h.seed('alice', 'commit-recovery')
    const before = await h.page()
    const connection = new Database(h.database)
    await h.restart(connection)
    connection.exec('PRAGMA busy_timeout = 0')
    const blocker = new Database(h.database)
    const barrier = h.gate(receipt([native('uncommitted-a'), native('uncommitted-b')], 'must-not-commit'))
    box.nextSync(barrier.wait)
    const syncing = h.pending(h.inbox.sync('alice', account.id).then(() => null, error => error as unknown))
    try {
      await bounded(barrier.entered, 'provider fetch before SQLite commit')
      blocker.exec('BEGIN IMMEDIATE')
      barrier.release()
      const failure = await bounded(syncing, 'failed SQLite transaction')
      expect(failure).not.toBeNull()
    } finally {
      if (blocker.inTransaction) blocker.exec('ROLLBACK')
      blocker.close()
      barrier.release()
    }
    expect((await h.page()).items.map(message => message.id)).toEqual(before.items.map(message => message.id))
    const failedCursor = cursorValue(box.calls.sync.at(-1)!.cursor)
    await h.restart()
    box.nextSync(receipt([native('uncommitted-a'), native('uncommitted-b')], 'committed-retry'))
    await h.sync('alice', account.id)
    expect(cursorValue(box.calls.sync.at(-1)!.cursor)).toBe(failedCursor)
    expect((await h.page()).total).toBe(3)
    const ids = (await h.page()).items.map(message => message.id)
    expect(new Set(ids).size).toBe(3)
  })

  test('provider deletion removes cached messages and empty threads without resurrecting them on restart', async () => {
    const h = await fixture()
    const { account, box } = await h.seed('alice', 'delete-sync', [native('to-delete')])
    const message = (await h.page()).items[0]!
    const baseline = await h.inbox.changes('alice')
    box.remove('to-delete')
    await h.sync('alice', account.id)
    await invalid(await h.request('alice', `/messages/${message.id}`), 404)
    expect((await h.page()).total).toBe(0)
    expect((await h.json<Page<ThreadSummary>>('alice', '/threads')).total).toBe(0)
    const changes = await h.inbox.changes('alice', { since: baseline.state })
    expect(changes.events.filter(event => event.type === 'mail.changed')).toEqual([
      expect.objectContaining({ entityId: message.id, change: 'deleted', accountId: account.id }),
    ])
    await h.restart()
    await h.inbox.runDue()
    expect((await h.page()).total).toBe(0)
  })

  test('poll uses current persisted accounts and intervals rather than a startup account snapshot', async () => {
    const h = await fixture({ syncIntervalMs: 1000 })
    const first = await h.seed('alice', 'poll-first')
    const worker = h.worker()
    const later = await h.connect('bob', 'poll-later', [native('later')])
    h.clock.value += 1001
    await worker.poll()
    expect(later.box.calls.sync).toHaveLength(1)
    expect((await worker.messages('bob')).total).toBe(1)
    const count = first.box.calls.sync.length
    await worker.poll()
    expect(first.box.calls.sync.length).toBe(count)
    await h.inbox.disconnect('alice', first.account.id)
    h.clock.value += 1001
    await worker.poll()
    expect(first.box.calls.sync.length).toBe(count)
    expect(later.box.calls.sync).toHaveLength(2)
  })

  test('snooze deadlines survive restart, but a newer trash action is never undone by an old wakeup', async () => {
    const h = await fixture()
    await h.seed('alice', 'snooze', [native('wake'), native('trashed')])
    const page = await h.page()
    const wake = page.items.find(message => message.subject === 'Subject wake')!
    const trashed = page.items.find(message => message.subject === 'Subject trashed')!
    const until = new Date(EPOCH + 60_000).toISOString()
    await h.mutate('alice', [wake.id, trashed.id], { snoozedUntil: until }, 'snooze-both')
    await h.inbox.runDue()
    expect((await h.page('alice', { folder: 'snoozed' })).total).toBe(2)
    expect((await h.page('alice', { folder: 'inbox' })).total).toBe(0)
    await h.mutate('alice', [trashed.id], { folder: 'trash' }, 'trash-while-snoozed')
    await h.inbox.runDue()
    await h.restart()
    h.clock.value = EPOCH + 59_999
    await h.inbox.runDue()
    expect((await h.inbox.message('alice', wake.id)).snoozedUntil).toBe(until)
    h.clock.value = EPOCH + 60_000
    await h.inbox.runDue()
    expect(await h.inbox.message('alice', wake.id)).toMatchObject({ folder: 'inbox', snoozedUntil: null })
    expect((await h.inbox.message('alice', trashed.id)).folder).toBe('trash')
    expect((await h.page('alice', { folder: 'inbox' })).items.map(message => message.id)).toEqual([wake.id])
  })

  test('undo restores an unchanged mutation but refuses to clobber a newer conflicting user action', async () => {
    const h = await fixture()
    await h.seed('alice', 'undo-mutation')
    const message = (await h.page()).items[0]!
    const archived = await h.mutate('alice', [message.id], { isArchived: true }, 'undo-archive')
    await h.inbox.runDue()
    await h.json<Operation>('alice', `/operations/${archived.id}/undo`, {}, 'POST')
    await h.inbox.runDue()
    expect((await h.inbox.message('alice', message.id)).folder).toBe('inbox')
    const older = await h.mutate('alice', [message.id], { isArchived: true }, 'older-archive')
    await h.inbox.runDue()
    await h.mutate('alice', [message.id], { folder: 'trash', isStarred: true }, 'newer-trash')
    await h.inbox.runDue()
    await invalid(await h.request('alice', `/operations/${older.id}/undo`, { method: 'POST' }), 409)
    expect(await h.inbox.message('alice', message.id)).toMatchObject({ folder: 'trash', isStarred: true })
  })
})

describe('policy privacy and replayable changes', () => {
  test('remote image policy changes content security headers without modifying message bodies or leaking credentials to logs', async () => {
    const h = await fixture()
    const { account, box } = await h.seed('alice', 'privacy', [native('privacy', {
      bodyText: BODY_SECRET,
      bodyHtml: '<p>Private body</p><img src="https://tracker.example.test/open"><a href="https://example.test/">Link</a>',
    })])
    const message = (await h.page()).items[0]!
    const baseline = await h.inbox.changes('alice')
    await h.inbox.setPolicy('bob', { remoteImages: false })
    await h.json<Policy>('alice', '/policy', { remoteImages: false }, 'PATCH')
    const blocked = await h.request('alice', `/messages/${message.id}`)
    const blockedPolicy = blocked.headers.get('content-security-policy') ?? ''
    const blockedBody = await blocked.json() as Message
    expect(blockedPolicy).toContain('img-src')
    const blockedImages = blockedPolicy.split(';').find(directive => directive.trim().startsWith('img-src')) ?? ''
    expect(blockedImages).not.toContain('https:')
    expect(blocked.headers.get('referrer-policy')).toBe('no-referrer')
    await h.json<Policy>('alice', '/policy', { remoteImages: true }, 'PATCH')
    const allowed = await h.request('alice', `/messages/${message.id}`)
    const allowedPolicy = allowed.headers.get('content-security-policy') ?? ''
    expect(allowedPolicy.split(';').find(directive => directive.trim().startsWith('img-src'))).toContain("'self' data:")
    expect(allowedPolicy.split(';').find(directive => directive.trim().startsWith('img-src'))).not.toContain('https:')
    expect((await allowed.json() as Message).bodyHtml).toBe(blockedBody.bodyHtml)
    expect((await h.inbox.message('alice', message.id)).revision).toBe(message.revision)
    expect((await h.inbox.policy('bob')).remoteImages).not.toBe((await h.inbox.policy('alice')).remoteImages)
    box.nextSync(new CredentialError('revoked', `${SECRET} ${BODY_SECRET}`))
    await expect(h.inbox.sync('alice', account.id)).rejects.toBeDefined()
    expect((await h.inbox.account('alice', account.id)).status).toBe('reconnect_required')
    const exposed = JSON.stringify({ logs: h.logs, account: await h.inbox.account('alice', account.id), events: await h.inbox.changes('alice', { since: baseline.state }) })
    expect(exposed).not.toContain(SECRET)
    expect(exposed).not.toContain(BODY_SECRET)
    expect(exposed).not.toContain('refreshToken')
    expect(exposed).not.toContain('accessToken')
    expect(box.calls.mutate).toEqual([])
  })

  test('policy validation is atomic and persists per owner', async () => {
    const h = await fixture()
    const alice = await h.json<Policy>('alice', '/policy', { remoteImages: false, undoSendSeconds: 25 }, 'PATCH')
    const bob = await h.json<Policy>('bob', '/policy', { remoteImages: true, undoSendSeconds: 0 }, 'PATCH')
    expect(alice).toEqual({ remoteImages: false, undoSendSeconds: 25 })
    expect(bob).toEqual({ remoteImages: true, undoSendSeconds: 0 })
    for (const body of [{ undoSendSeconds: -1 }, { undoSendSeconds: 1.5 }, { remoteImages: 'true' }]) {
      await invalid(await h.request('alice', '/policy', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), 400)
    }
    await h.restart()
    expect(await h.inbox.policy('alice')).toEqual(alice)
    expect(await h.inbox.policy('bob')).toEqual(bob)
  })

  test('host image defaults apply to new owners without overwriting saved user choices', async () => {
    const h = await fixture({ defaultPolicy: { remoteImages: true } })
    const initial = await h.inbox.policy('alice')
    expect(initial).toEqual({ remoteImages: true, undoSendSeconds: 10 })
    initial.remoteImages = false
    expect((await h.inbox.policy('alice')).remoteImages).toBe(true)
    await h.json<Policy>('alice', '/policy', { remoteImages: false }, 'PATCH')
    await h.restart()
    expect((await h.inbox.policy('alice')).remoteImages).toBe(false)
    expect((await h.inbox.policy('bob')).remoteImages).toBe(true)
    expect(() => createInbox({ encryptionKey: KEY, providers: [], defaultPolicy: { remoteImages: 'true' as unknown as boolean } })).toThrow()
  })

  test('change replay is owner-scoped, paged in commit order, resumable after restart, and empty without an explicit cursor', async () => {
    const h = await fixture()
    const alice = await h.seed('alice', 'changes-alice')
    const bob = await h.seed('bob', 'changes-bob')
    const baseline = await h.json<ChangePage>('alice', '/changes')
    const bobBaseline = await h.inbox.changes('bob')
    expect(baseline.events).toEqual([])
    const ownIds: string[] = []
    const foreignIds: string[] = []
    for (let index = 0; index < 5; index++) {
      ownIds.push((await h.inbox.createLabel('alice', alice.account.id, `Own ${index}`)).id)
      foreignIds.push((await h.inbox.createLabel('bob', bob.account.id, `Foreign ${index}`)).id)
    }
    const first = await h.json<ChangePage>('alice', `/changes?since=${encodeURIComponent(baseline.state)}&limit=2`)
    expect(first.events.map(event => event.entityId)).toEqual(ownIds.slice(0, 2))
    expect(first.hasMore).toBe(true)
    expect(first.state).toBe(first.events.at(-1)!.id)
    expect(first.resetRequired).toBe(false)
    await h.restart()
    const all = [...first.events]
    let state = first.state
    let hasMore = first.hasMore
    while (hasMore) {
      const page = await h.inbox.changes('alice', { since: state, limit: 2 })
      all.push(...page.events)
      hasMore = page.hasMore
      state = page.state
      expect(all.length).toBeLessThanOrEqual(5)
    }
    expect(all.map(event => event.entityId)).toEqual(ownIds)
    expect(all.every(event => event.type === 'label.updated' && event.reason === 'mutation' && event.accountId === alice.account.id)).toBe(true)
    expect(new Set(all.map(event => event.id)).size).toBe(5)
    expect(all.some(event => foreignIds.includes(event.entityId))).toBe(false)
    expect((await h.inbox.changes('alice', { since: state })).events).toEqual([])
    expect((await h.inbox.changes('alice')).events).toEqual([])
    const foreign = await h.inbox.changes('bob', { since: bobBaseline.state, limit: 100 })
    expect(foreign.events.some(event => ownIds.includes(event.entityId))).toBe(false)
    expect(JSON.stringify(all)).not.toContain(SECRET)
  })

  test('retention gaps explicitly reset instead of silently skipping events or serving an unbounded history', async () => {
    const h = await fixture({ eventRetention: 4 })
    const { account } = await h.seed('alice', 'retention')
    const old = await h.inbox.changes('alice')
    const ids: string[] = []
    for (let index = 0; index < 12; index++) ids.push((await h.inbox.createLabel('alice', account.id, `Retained ${index}`)).id)
    const latest = await h.inbox.changes('alice')
    const gap = await h.json<ChangePage>('alice', `/changes?since=${encodeURIComponent(old.state)}&limit=2`)
    expect(gap.resetRequired).toBe(true)
    expect(gap.state).toBe(latest.state)
    expect(gap.events).toEqual([])
    expect(gap.hasMore).toBe(false)
    const baseline = await h.inbox.changes('alice', { since: latest.state })
    expect(baseline.events).toEqual([])
    const last = await h.inbox.createLabel('alice', account.id, 'After reset')
    const resumed = await h.inbox.changes('alice', { since: latest.state, limit: 100 })
    expect(resumed.events.map(event => event.entityId)).toEqual([last.id])
    expect(resumed.resetRequired).toBe(false)
    expect(ids).not.toContain(last.id)
  })

  test('GET validators change with observable query results and never let one owner validate another owner response', async () => {
    const h = await fixture()
    await h.seed('alice', 'etag-alice')
    await h.seed('bob', 'etag-bob', [native('same', { subject: 'Private Bob result' })])
    const response = await h.request('alice', '/messages?unreadOnly=true')
    const aliceTag = response.headers.get('etag')!
    const original = await response.json() as Page<MessageSummary>
    expect(aliceTag).not.toBeNull()
    const unchanged = await h.request('alice', '/messages?unreadOnly=true', { headers: { 'If-None-Match': aliceTag } })
    expect(unchanged.status).toBe(304)
    expect(await unchanged.text()).toBe('')
    const bob = await h.request('bob', '/messages?unreadOnly=true', { headers: { 'If-None-Match': aliceTag } })
    expect(bob.status).toBe(200)
    expect((await bob.json() as Page<MessageSummary>).items[0]!.subject).toBe('Private Bob result')
    await h.mutate('alice', [original.items[0]!.id], { isRead: true }, 'etag-read')
    const changed = await h.request('alice', '/messages?unreadOnly=true', { headers: { 'If-None-Match': aliceTag } })
    expect(changed.status).toBe(200)
    expect(changed.headers.get('etag')).not.toBe(aliceTag)
    expect((await changed.json() as Page<MessageSummary>).items).toEqual([])
  })
})

describe('SSE over real loopback sockets', () => {
  test('abort while the first change page is pending immediately releases the slot without subscribing late', async () => {
    const h = await fixture()
    const page = await h.inbox.changes('alice')
    const barrier = h.gate(page)
    let reads = 0
    let subscriptions = 0
    const api = createInboxApi({
      inbox: { ...h.inbox,
        changes: (...args) => ++reads === 1 ? barrier.wait() : h.inbox.changes(...args),
        subscribe: (...args) => { subscriptions++; return h.inbox.subscribe(...args) },
      },
      authenticate: () => ({ id: 'alice' }), maxStreamsPerOwner: 1,
    })
    const controller = h.controller()
    const pending = h.pending(Promise.resolve(api.request('/v1/events', { signal: controller.signal })))
    await bounded(barrier.entered, 'pending initial change page')
    controller.abort()
    const replacement = await api.request('/v1/events')
    expect(replacement.status).toBe(200)
    await replacement.body!.cancel()
    expect(subscriptions).toBe(1)
    barrier.release()
    const aborted = await bounded(pending, 'aborted setup settlement')
    expect(aborted).toBeDefined()
    expect(await aborted!.text()).toBe('')
    expect(subscriptions).toBe(1)
  })

  test('authentication precedes streaming; ready and heartbeats flush, stream limits are per owner, and disconnect releases capacity', async () => {
    const h = await fixture()
    await h.seed('alice', 'socket-auth')
    const baseline = await h.inbox.changes('alice')
    const base = h.socket({ maxStreamsPerOwner: 1 })
    const unauthenticated = await fetch(`${base}/v1/events`)
    expect(unauthenticated.headers.get('content-type')).not.toContain('text/event-stream')
    await invalid(unauthenticated, 401)
    const controller = h.controller()
    const response = await fetch(`${base}/v1/events`, { headers: { authorization: 'Bearer alice' }, signal: controller.signal })
    const stream = sse(response)
    const ready = await stream.next()
    expect(ready.event).toBe('ready')
    expect(JSON.parse(ready.data)).toEqual({ state: baseline.state })
    expect(ready.id).toBe('')
    const heartbeat = await stream.next()
    expect(heartbeat.isComment).toBe(true)
    expect(heartbeat.data).toBe('')
    expect(heartbeat.id).toBe('')
    await invalid(await fetch(`${base}/v1/events`, { headers: { authorization: 'Bearer alice' } }), 429)
    const bobController = h.controller()
    const bob = sse(await fetch(`${base}/v1/events`, { headers: { authorization: 'Bearer bob' }, signal: bobController.signal }))
    expect((await bob.next()).event).toBe('ready')
    controller.abort()
    await stream.cancel()
    let replacement: Response | undefined
    const replacementController = h.controller()
    // Only socket teardown settlement uses a short wait; all mail deadlines use the injected clock.
    for (let attempt = 0; attempt < 80; attempt++) {
      const candidate = await fetch(`${base}/v1/events`, { headers: { authorization: 'Bearer alice' }, signal: replacementController.signal })
      if (candidate.status === 200) { replacement = candidate; break }
      await invalid(candidate, 429)
      await Bun.sleep(10)
    }
    expect(replacement).toBeDefined()
    // Disconnect before consuming the first frame, exercising the early reader-cancellation path.
    await replacement!.body!.cancel()
    replacementController.abort()
    bobController.abort()
    await bob.cancel()
    const finalController = h.controller()
    let final: Response | undefined
    for (let attempt = 0; attempt < 80; attempt++) {
      const candidate = await fetch(`${base}/v1/events`, { headers: { authorization: 'Bearer alice' }, signal: finalController.signal })
      if (candidate.status === 200) { final = candidate; break }
      await invalid(candidate, 429)
      await Bun.sleep(10)
    }
    expect(final).toBeDefined()
    const finalStream = sse(final!)
    expect((await finalStream.next()).event).toBe('ready')
    finalController.abort()
    await finalStream.cancel()
  })

  test('streamed ChangeEvents have durable IDs, exclude the other owner, and Last-Event-ID replays exactly the disconnected gap', async () => {
    const h = await fixture()
    const a = await h.seed('alice', 'stream-alice')
    const b = await h.seed('bob', 'stream-bob')
    const base = h.socket()
    const controller = h.controller()
    const stream = sse(await fetch(`${base}/v1/events`, { headers: { authorization: 'Bearer alice' }, signal: controller.signal }))
    const ready = await stream.next()
    expect(ready.event).toBe('ready')
    const baseline = JSON.parse(ready.data) as { state: string }
    const foreign = await h.inbox.createLabel('bob', b.account.id, 'Must not stream to Alice')
    const own = await h.inbox.createLabel('alice', a.account.id, 'First streamed label')
    const first = await stream.event('label.updated')
    const event = JSON.parse(first.data) as ChangeEvent
    expect(event).toMatchObject({ id: first.id, entityId: own.id, accountId: a.account.id, type: 'label.updated' })
    expect(event.entityId).not.toBe(foreign.id)
    expect(first.id).not.toBe('')
    expect((await h.inbox.changes('alice', { since: baseline.state })).events.map(item => item.id)).toContain(first.id)
    controller.abort()
    await stream.cancel()
    const missed = [
      await h.inbox.createLabel('alice', a.account.id, 'Missed one'),
      await h.inbox.createLabel('alice', a.account.id, 'Missed two'),
    ]
    const replayController = h.controller()
    const replay = sse(await fetch(`${base}/v1/events`, {
      headers: { authorization: 'Bearer alice', 'Last-Event-ID': first.id }, signal: replayController.signal,
    }))
    const replayReady = await replay.next()
    expect(replayReady.event).toBe('ready')
    expect(JSON.parse(replayReady.data)).toEqual({ state: first.id })
    const replayed = [await replay.event('label.updated'), await replay.event('label.updated')]
    expect(replayed.map(frame => (JSON.parse(frame.data) as ChangeEvent).entityId)).toEqual(missed.map(label => label.id))
    expect(new Set(replayed.map(frame => frame.id)).size).toBe(2)
    expect(replayed.some(frame => frame.id === first.id)).toBe(false)
    replayController.abort()
    await replay.cancel()
  })

  test('socket streams observe another SQLite worker and distinguish historical backfill from new arrivals', async () => {
    const h = await fixture()
    const { account, box } = await h.connect('alice', 'stream-cross-worker')
    const base = h.socket()
    const controller = h.controller()
    const stream = sse(await fetch(`${base}/v1/events`, { headers: { authorization: 'Bearer alice' }, signal: controller.signal }))
    expect((await stream.next()).event).toBe('ready')
    const worker = h.worker()
    const label = await worker.createLabel('alice', account.id, 'Other worker commit')
    const persisted = await stream.event('label.updated')
    expect((JSON.parse(persisted.data) as ChangeEvent).entityId).toBe(label.id)
    box.nextSync(receipt([native('historical', { receivedAt: '2016-01-01T00:00:00.000Z' })], 'historical-page', { fullSync: true }))
    await worker.sync('alice', account.id, { lane: 'backfill' })
    const historical = JSON.parse((await stream.event('mail.changed')).data) as ChangeEvent
    expect(['initial', 'backfill']).toContain(historical.reason)
    expect(historical.reason).not.toBe('arrival')
    box.nextSync(receipt([native('initial-current')], 'current-initial', { fullSync: true }))
    await worker.sync('alice', account.id, { lane: 'latest' })
    expect((JSON.parse((await stream.event('mail.changed')).data) as ChangeEvent).reason).toBe('initial')
    box.nextSync(receipt([native('actual-arrival')], 'current-next'))
    await worker.sync('alice', account.id, { lane: 'latest' })
    const arrival = JSON.parse((await stream.event('mail.changed')).data) as ChangeEvent
    expect(arrival.reason).toBe('arrival')
    expect((await h.inbox.message('alice', arrival.entityId)).subject).toBe('Subject actual-arrival')
    controller.abort()
    await stream.cancel()
  })

  test('an expired replay cursor emits an explicit reset with the new baseline instead of silently dropping history', async () => {
    const h = await fixture({ eventRetention: 3 })
    const { account } = await h.seed('alice', 'socket-gap')
    const old = await h.inbox.changes('alice')
    for (let index = 0; index < 8; index++) await h.inbox.createLabel('alice', account.id, `Gap ${index}`)
    const latest = await h.inbox.changes('alice')
    const base = h.socket()
    const controller = h.controller()
    const stream = sse(await fetch(`${base}/v1/events?since=${encodeURIComponent(old.state)}`, { headers: { authorization: 'Bearer alice' }, signal: controller.signal }))
    const ready = await stream.next()
    expect(ready.event).toBe('ready')
    expect(JSON.parse(ready.data)).toEqual({ state: old.state })
    const reset = await stream.next()
    expect(reset.event).toBe('reset.required')
    expect(JSON.parse(reset.data)).toEqual({ state: latest.state })
    expect(reset.id).toBe('')
    controller.abort()
    await stream.cancel()
  })
})

describe('framework-neutral client against the real HTTP adapter', () => {
  test('conditional GETs decode 304 responses from the scoped cache and preserve host authentication and custom headers', async () => {
    const h = await fixture()
    await h.seed('alice', 'client-cache')
    const wire = transport(h)
    const client = createInboxClient({
      baseUrl: 'http://inbox.test', fetch: wire.fetch,
      headers: { authorization: 'Bearer alice', 'x-host-application': 'test-host' }, cacheScope: 'alice-session',
    })
    const first = await client.messages({ limit: 2 })
    expect(first.total).toBe(1)
    const firstRequest = wire.requests.at(-1)!
    expect(firstRequest.path).toBe('/v1/messages?limit=2')
    expect(firstRequest.headers.get('authorization')).toBe('Bearer alice')
    expect(firstRequest.headers.get('x-host-application')).toBe('test-host')
    expect(firstRequest.headers.get('if-none-match')).toBeNull()
    expect(firstRequest.status).toBe(200)
    const second = await client.messages({ limit: 2 })
    expect(second).toEqual(first)
    expect(wire.requests.at(-1)!.headers.get('if-none-match')).toBe(firstRequest.etag)
    expect(wire.requests.at(-1)!.status).toBe(304)
    const accounts = await client.request<Account[]>('/accounts', { headers: { 'x-request-marker': 'preserved' } })
    expect(accounts.map(account => account.email)).toEqual(['client-cache@example.test'])
    expect(wire.requests.at(-1)!.headers.get('authorization')).toBe('Bearer alice')
    expect(wire.requests.at(-1)!.headers.get('x-request-marker')).toBe('preserved')
    const documentation = await client.request<unknown>('/openapi.json')
    const documentationTag = wire.requests.at(-1)!.etag
    expect(wire.requests.at(-1)!.status).toBe(200)
    expect(JSON.stringify(documentation)).not.toContain(SECRET)
    expect(JSON.stringify(documentation)).not.toContain(accounts[0]!.id)
    await client.request('/openapi.json')
    expect(wire.requests.at(-1)!.status).toBe(304)
    expect(wire.requests.at(-1)!.headers.get('if-none-match')).toBe(documentationTag)
    await expect(client.message('missing-message')).rejects.toMatchObject({ status: 404 })
    expect(wire.requests.at(-1)!.status).toBe(404)
  })

  test('cache entries are not shared between owners even when callers reuse the same cache scope', async () => {
    const h = await fixture()
    await h.seed('alice', 'client-alice', [native('same', { subject: 'Alice only' })])
    await h.seed('bob', 'client-bob', [native('same', { subject: 'Bob only' })])
    const wire = transport(h)
    const alice = createInboxClient({ baseUrl: 'http://inbox.test', fetch: wire.fetch, headers: { authorization: 'Bearer alice' }, cacheScope: 'shared-view-name' })
    const bob = createInboxClient({ baseUrl: 'http://inbox.test', fetch: wire.fetch, headers: { authorization: 'Bearer bob' }, cacheScope: 'shared-view-name' })
    const alicePage = await alice.messages()
    const aliceTag = wire.requests.at(-1)!.etag
    const bobPage = await bob.messages()
    const bobTag = wire.requests.at(-1)!.etag
    expect(alicePage.items.map(message => message.subject)).toEqual(['Alice only'])
    expect(bobPage.items.map(message => message.subject)).toEqual(['Bob only'])
    expect(wire.requests.at(-1)!.headers.get('if-none-match')).toBeNull()
    expect(bobTag).not.toBe(aliceTag)
    expect((await alice.messages()).items.map(message => message.subject)).toEqual(['Alice only'])
    expect(wire.requests.at(-1)!.headers.get('if-none-match')).toBe(aliceTag)
    expect((await bob.messages()).items.map(message => message.subject)).toEqual(['Bob only'])
    expect(wire.requests.at(-1)!.headers.get('if-none-match')).toBe(bobTag)
    await expect(alice.message(bobPage.items[0]!.id)).rejects.toMatchObject({ status: 404 })
  })

  test('changing credentials aborts or fences an in-flight old-owner response before it can populate the new cache', async () => {
    const h = await fixture()
    await h.seed('alice', 'inflight-alice', [native('same', { subject: 'Private Alice response' })])
    await h.seed('bob', 'inflight-bob', [native('same', { subject: 'Current Bob response' })])
    const barrier = h.gate<void>(undefined)
    const requests: Array<{ owner: string | null; tag: string | null; responseTag: string | null }> = []
    let blocked = false
    const fetcher = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init)
      const response = await h.api.request(request)
      requests.push({ owner: request.headers.get('authorization'), tag: request.headers.get('if-none-match'), responseTag: response.headers.get('etag') })
      if (!blocked && request.headers.get('authorization') === 'Bearer alice') {
        blocked = true
        // Intentionally ignore the signal here to test the client's generation fence as well as abort.
        await barrier.wait()
      }
      return response
    }) as typeof fetch
    const client = createInboxClient({ baseUrl: 'http://inbox.test', fetch: fetcher, headers: { authorization: 'Bearer alice' }, cacheScope: 'alice' })
    const old = h.pending(client.messages()).then(value => ({ value, error: null }), error => ({ value: null, error: error as Error }))
    await bounded(barrier.entered, 'old-owner HTTP response')
    client.setCredentials({ headers: { authorization: 'Bearer bob' }, cacheScope: 'bob' })
    const bob = await client.messages()
    const bobTag = requests.at(-1)!.responseTag
    expect(bob.items.map(message => message.subject)).toEqual(['Current Bob response'])
    barrier.release()
    expect((await bounded(old, 'fenced old response')).error?.name).toBe('AbortError')
    const current = await client.messages()
    expect(current.items.map(message => message.subject)).toEqual(['Current Bob response'])
    expect(requests.at(-1)).toMatchObject({ owner: 'Bearer bob', tag: bobTag })
    expect(requests.at(-1)!.tag).not.toBe(requests[0]!.responseTag)
    client.setCredentials({ headers: { authorization: 'Bearer alice' }, cacheScope: 'alice-again' })
    expect((await client.messages()).items.map(message => message.subject)).toEqual(['Private Alice response'])
    expect(requests.at(-1)!.tag).toBeNull()
  })

  test('cacheMaxEntries is an observable bound, clearCache clears validators, and an unscoped client does not cache', async () => {
    const h = await fixture()
    await h.seed('alice', 'cache-bound', [native('one'), native('two'), native('three')])
    const wire = transport(h)
    const client = createInboxClient({ baseUrl: 'http://inbox.test', fetch: wire.fetch, headers: { authorization: 'Bearer alice' }, cacheScope: 'bounded', cacheMaxEntries: 2 })
    for (let limit = 1; limit <= 6; limit++) await client.messages({ limit })
    const start = wire.requests.length
    for (let limit = 1; limit <= 6; limit++) await client.messages({ limit })
    expect(wire.requests.slice(start).filter(request => request.headers.has('if-none-match')).length).toBeLessThanOrEqual(2)
    await client.messages({ limit: 6 })
    expect(wire.requests.at(-1)!.status).toBe(304)
    client.clearCache()
    await client.messages({ limit: 6 })
    expect(wire.requests.at(-1)!.headers.get('if-none-match')).toBeNull()
    expect(wire.requests.at(-1)!.status).toBe(200)
    const unscoped = createInboxClient({ baseUrl: 'http://inbox.test', fetch: wire.fetch, headers: { authorization: 'Bearer alice' } })
    await unscoped.messages()
    await unscoped.messages()
    expect(wire.requests.at(-1)!.headers.get('if-none-match')).toBeNull()
    expect(wire.requests.at(-1)!.status).toBe(200)
  })

  test('mutation methods send the idempotency header and invalidate related message, thread, and filtered-query caches', async () => {
    const h = await fixture()
    await h.seed('alice', 'client-mutations')
    const wire = transport(h)
    const client = createInboxClient({ baseUrl: 'http://inbox.test', fetch: wire.fetch, headers: { authorization: 'Bearer alice' }, cacheScope: 'mutations' })
    const page = await client.messages({ unreadOnly: true })
    const message = page.items[0]!
    await client.message(message.id)
    await client.threads({ unreadOnly: true })
    await client.thread(message.threadId)
    const operation = await client.mutate({ messageIds: [message.id], changes: { isRead: true }, idempotencyKey: 'client-idempotency' })
    const write = wire.requests.find(request => request.method === 'POST' && request.path === '/v1/operations')!
    expect(write.status).toBe(202)
    expect(write.headers.get('idempotency-key')).toBe('client-idempotency')
    expect(write.body).toEqual({ messageIds: [message.id], changes: { isRead: true } })
    expect((await client.messages({ unreadOnly: true })).items).toEqual([])
    expect(wire.requests.at(-1)!.headers.get('if-none-match')).toBeNull()
    expect((await client.message(message.id)).isRead).toBe(true)
    expect(wire.requests.at(-1)!.headers.get('if-none-match')).toBeNull()
    expect((await client.threads({ unreadOnly: true })).items).toEqual([])
    expect((await client.thread(message.threadId)).items[0]!.isRead).toBe(true)
    await h.inbox.runDue()
    expect((await client.operation(operation.id)).status).toBe('succeeded')
  })

  test('client draft and label edits use actual entity ETags, reject stale revisions, and preserve uploaded bytes', async () => {
    const h = await fixture()
    const { account } = await h.seed('alice', 'client-editing')
    const wire = transport(h)
    const client = createInboxClient({ baseUrl: 'http://inbox.test', fetch: wire.fetch, headers: { authorization: 'Bearer alice' }, cacheScope: 'editing' })
    const blob = await client.upload(account.id, { filename: 'client.bin', contentType: 'application/octet-stream', content: new Uint8Array([0, 128, 255]) })
    const downloaded = await client.download(blob.id)
    expect(downloaded.content).toEqual(new Uint8Array([0, 128, 255]))
    const draft = await client.createDraft({ accountId: account.id, bodyText: 'Client body', attachmentIds: [blob.id] })
    const saved = await client.updateDraft(draft.id, { subject: 'Edited subject' }, draft.revision)
    const patch = wire.requests.findLast(request => request.method === 'PATCH' && request.path === `/v1/drafts/${draft.id}`)!
    const get = wire.requests.findLast(request => request.method === 'GET' && request.path === `/v1/drafts/${draft.id}`)!
    expect(patch.headers.get('if-match')).toBe(get.etag)
    expect(saved).toMatchObject({ subject: 'Edited subject', bodyText: 'Client body', attachmentIds: [blob.id] })
    await expect(client.updateDraft(draft.id, { subject: 'Stale client edit' }, draft.revision)).rejects.toMatchObject({ status: 412 })
    expect((await client.draft(draft.id)).subject).toBe('Edited subject')
    const label = await client.createLabel(account.id, 'Client label')
    const renamed = await client.updateLabel(label.id, 'Client renamed label', label.revision)
    expect(renamed.name).toBe('Client renamed label')
    await expect(client.updateLabel(label.id, 'Stale label', label.revision)).rejects.toMatchObject({ status: 412 })
    await client.deleteLabel(label.id)
    expect(await client.labels(account.id)).toEqual([])
    await client.deleteDraft(draft.id, saved.revision)
    expect(wire.requests.at(-1)!.status).toBe(204)
    expect(await client.drafts(account.id)).toEqual([])
  })

  test('client account, folder, policy, submission, scheduling, and cancellation methods drive the public routes', async () => {
    const h = await fixture()
    const box = referenceMailbox('client-flow', 'client-flow@example.test', [native('client-message')])
    h.boxes.set('client-flow', box)
    const wire = transport(h)
    const client = createInboxClient({ baseUrl: 'http://inbox.test', fetch: wire.fetch, headers: { authorization: 'Bearer alice' }, cacheScope: 'whole-flow' })
    const account = await client.connect({ providerId: DYNAMIC, credentials: { mailbox: 'client-flow', accessToken: SECRET } })
    expect(account.providerId).toBe(DYNAMIC)
    expect((await client.providers()).map(provider => provider.id)).toContain(DYNAMIC)
    expect((await client.accounts()).map(item => item.id)).toEqual([account.id])
    expect((await client.account(account.id)).email).toBe('client-flow@example.test')
    await client.sync(account.id)
    expect((await client.messages({ accountId: account.id })).total).toBe(1)
    const folder = await client.createFolder(account.id, 'Client folder')
    expect((await client.folders(account.id)).map(item => item.id)).toContain(folder.id)
    expect(wire.requests.some(request => request.path === `/v1/accounts/${account.id}/folders` && request.method === 'POST')).toBe(true)
    const policy = await client.setPolicy({ remoteImages: false, undoSendSeconds: 5 })
    expect(await client.policy()).toEqual(policy)
    const baseline = await client.changes()
    expect(baseline.events).toEqual([])
    const draft = await client.createDraft({ accountId: account.id, to: [participant('recipient@example.test')], subject: 'Client queued' })
    const operation = await client.submit(draft.id, { revision: draft.revision, idempotencyKey: 'client-submit', sendAt: new Date(EPOCH + 60_000).toISOString() })
    expect(wire.requests.at(-1)!.headers.get('idempotency-key')).toBe('client-submit')
    expect(wire.requests.at(-1)!.body).toEqual({ revision: draft.revision, sendAt: new Date(EPOCH + 60_000).toISOString() })
    const later = new Date(EPOCH + 120_000).toISOString()
    expect((await client.reschedule(operation.id, later)).sendAt).toBe(later)
    expect((await client.cancel(operation.id)).status).toBe('cancelled')
    const second = await client.createDraft({ accountId: account.id, to: [participant('recipient@example.test')], subject: 'Client undo' })
    const held = await client.submit(second.id, { revision: second.revision, idempotencyKey: 'client-undo' })
    expect((await client.undo(held.id)).status).toBe('cancelled')
    expect((await client.changes({ since: baseline.state })).events.some(event => event.entityId === draft.id)).toBe(true)
    const reconnected = await client.reconnect(account.id, { mailbox: 'client-flow', accessToken: 'synthetic-replacement-token' })
    expect(reconnected.id).toBe(account.id)
    expect(reconnected.generation).toBeGreaterThan(account.generation)
    await client.disconnect(account.id)
    expect(wire.requests.at(-1)!.status).toBe(204)
    expect((await client.account(account.id)).status).toBe('disconnected')
    expect(box.calls.send).toEqual([])
  })
})

describe('client event streams over real loopback sockets', () => {
  test('HTTP errors expose safe Retry-After hints and unchanged constructor fields', async () => {
    for (const [header, expected] of [['2', 2000], ['invalid', undefined], ['-1', undefined], ['1.5', undefined]] as const) {
      const client = createInboxClient({ baseUrl: 'http://inbox.test', fetch: Object.assign(async () => Response.json(
        { error: 'Too many requests', code: 'STREAM_LIMIT', retryable: true },
        { status: 429, headers: { 'Retry-After': header } },
      ), { preconnect() {} }) })
      for (const operation of [() => client.accounts(), () => client.events({ reconnect: false }).next()]) {
        await expect(operation()).rejects.toMatchObject({ name: 'ApiError', status: 429, code: 'STREAM_LIMIT', retryable: true, retryAfterMs: expected })
      }
    }
    const date = new Date(Date.now() + 10000).toUTCString()
    const client = createInboxClient({ baseUrl: 'http://inbox.test', fetch: Object.assign(async () => Response.json(
      { code: 'STREAM_LIMIT', retryable: true }, { status: 429, headers: { 'Retry-After': date } },
    ), { preconnect() {} }) })
    const issue = await client.events({ reconnect: false }).next().catch(error => error)
    expect(issue.retryAfterMs).toBeGreaterThan(8000)
    expect(issue.retryAfterMs).toBeLessThanOrEqual(10000)
  })

  test('reconnect respects Retry-After, backs off repeated stream limits, and return cancels the wait', async () => {
    const requested: number[] = []
    const client = createInboxClient({ baseUrl: 'http://inbox.test', fetch: Object.assign(async () => {
      requested.push(Date.now())
      return Response.json({ code: 'STREAM_LIMIT', retryable: true }, { status: 429, headers: { 'Retry-After': '1' } })
    }, { preconnect() {} }) })
    const iterator = client.events({ reconnectMs: 0 })
    const next = iterator.next()
    await bounded((async () => { while (requested.length < 3) await Bun.sleep(10) })(), 'three bounded stream retries')
    expect(requested[1]! - requested[0]!).toBeGreaterThanOrEqual(990)
    expect(requested[2]! - requested[1]!).toBeGreaterThanOrEqual(1490)
    await bounded(iterator.return!(), 'cancel retry wait')
    expect((await next).done).toBe(true)
    const count = requested.length
    await Bun.sleep(30)
    expect(requested).toHaveLength(count)
  })

  test('invalid event content types cancel their body and iterator return interrupts a pending read', async () => {
    let cancelled = 0
    const invalidClient = createInboxClient({ baseUrl: 'http://inbox.test', fetch: Object.assign(async () => new Response(
      new ReadableStream<Uint8Array>({ cancel() { cancelled++ } }), { headers: { 'Content-Type': 'application/octet-stream' } },
    ), { preconnect() {} }) })
    await expect(invalidClient.events({ reconnect: false }).next()).rejects.toMatchObject({ code: 'INVALID_EVENT_STREAM' })
    expect(cancelled).toBe(1)
    const h = await fixture()
    const client = createInboxClient({ baseUrl: h.socket({ maxStreamsPerOwner: 1 }), headers: { authorization: 'Bearer alice' } })
    const iterator = client.events({ reconnect: false })
    expect((await bounded(iterator.next(), 'ready before iterator return')).value?.type).toBe('ready')
    const waiting = iterator.next()
    await bounded(iterator.return!(), 'return during pending read')
    expect((await waiting).done).toBe(true)
    await Bun.sleep(30)
    const replacement = client.events({ reconnect: false })
    expect((await bounded(replacement.next(), 'replacement after iterator return')).value?.type).toBe('ready')
    await replacement.return!()
  })

  test('consumed change events invalidate affected cached queries, message detail, and thread summaries', async () => {
    const h = await fixture()
    await h.seed('alice', 'client-stream-effects')
    const base = h.socket()
    const requests: Array<{ path: string; tag: string | null; status: number }> = []
    const fetcher = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init)
      const response = await fetch(request)
      requests.push({ path: new URL(request.url).pathname, tag: request.headers.get('if-none-match'), status: response.status })
      return response
    }) as typeof fetch
    const client = createInboxClient({ baseUrl: base, fetch: fetcher, headers: { authorization: 'Bearer alice' }, cacheScope: 'event-effects' })
    const page = await client.messages({ unreadOnly: true })
    const message = page.items[0]!
    await client.message(message.id)
    await client.threads({ unreadOnly: true })
    expect((await client.messages({ unreadOnly: true })).items).toHaveLength(1)
    expect(requests.at(-1)!.status).toBe(304)
    const controller = h.controller()
    const iterator = client.events({ signal: controller.signal, reconnect: false })[Symbol.asyncIterator]()
    const ready = await bounded(iterator.next(), 'client ready event')
    expect(ready.done).toBe(false)
    if (ready.done) throw new Error('Client stream ended before ready')
    expect(ready.value.type).toBe('ready')
    const worker = h.worker()
    await worker.mutate('alice', { messageIds: [message.id], changes: { isRead: true }, idempotencyKey: 'external-read' })
    let changed: ChangeEvent | undefined
    for (let index = 0; index < 10; index++) {
      const next = await bounded(iterator.next(), 'client mail change')
      if (next.done) throw new Error('Client event stream ended before the external mail change')
      if (next.value.type === 'mail.changed') { changed = next.value; break }
    }
    expect(changed).toMatchObject({ type: 'mail.changed', entityId: message.id })
    expect((await client.messages({ unreadOnly: true })).items).toEqual([])
    expect(requests.at(-1)!.tag).toBeNull()
    expect((await client.message(message.id)).isRead).toBe(true)
    expect(requests.at(-1)!.tag).toBeNull()
    expect((await client.threads({ unreadOnly: true })).items).toEqual([])
    expect(requests.at(-1)!.tag).toBeNull()
    controller.abort()
    if (iterator.return) await bounded(iterator.return(undefined), 'client stream cancellation')
  })

  test('reset.required clears cached validators before the caller refreshes after a retention gap', async () => {
    const h = await fixture({ eventRetention: 3 })
    const { account } = await h.seed('alice', 'client-reset')
    const base = h.socket()
    const validators: Array<string | null> = []
    const fetcher = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init)
      if (new URL(request.url).pathname === '/v1/messages') validators.push(request.headers.get('if-none-match'))
      return fetch(request)
    }) as typeof fetch
    const client = createInboxClient({ baseUrl: base, fetch: fetcher, headers: { authorization: 'Bearer alice' }, cacheScope: 'reset' })
    await client.messages()
    await client.messages()
    expect(validators.at(-1)).not.toBeNull()
    const baseline = await client.changes()
    for (let index = 0; index < 8; index++) await h.inbox.createLabel('alice', account.id, `Reset gap ${index}`)
    const latest = await h.inbox.changes('alice')
    const controller = h.controller()
    const iterator = client.events({ since: baseline.state, signal: controller.signal, reconnect: false })[Symbol.asyncIterator]()
    const ready = await bounded(iterator.next(), 'client ready before reset')
    expect(ready.value).toEqual({ type: 'ready', state: baseline.state })
    const reset = await bounded(iterator.next(), 'client reset notification')
    expect(reset.value).toEqual({ type: 'reset.required', state: latest.state })
    expect((await client.messages()).total).toBe(1)
    expect(validators.at(-1)).toBeNull()
    controller.abort()
    if (iterator.return) await bounded(iterator.return(undefined), 'reset stream cancellation')
  })

  test('client reconnect sends the last delivered event ID and replays a real socket gap without duplicates', async () => {
    const h = await fixture()
    const { account } = await h.seed('alice', 'client-reconnect')
    const base = h.socket()
    const reconnect = h.gate<void>(undefined)
    const streamRequests: Request[] = []
    const fetcher = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init)
      if (new URL(request.url).pathname !== '/v1/events') return fetch(request)
      streamRequests.push(request.clone())
      const index = streamRequests.length
      if (index === 2) await reconnect.wait()
      const response = await fetch(request)
      if (index !== 1) return response
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let seen = ''
      let ended = false
      // Cut one real network response after its first change, simulating an intermediary disconnect.
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (ended) return
          const chunk = await reader.read()
          if (chunk.done) { ended = true; controller.close(); return }
          controller.enqueue(chunk.value)
          seen += decoder.decode(chunk.value, { stream: true })
          const completeFrames = seen.split(/\r?\n\r?\n/).slice(0, -1)
          if (completeFrames.some(frame => frame.split(/\r?\n/).some(line => /^event: ?label\.updated$/.test(line)))) {
            ended = true
            controller.close()
            await reader.cancel()
          }
        },
        async cancel() { ended = true; await reader.cancel() },
      })
      return new Response(body, { status: response.status, headers: response.headers })
    }) as typeof fetch
    const client = createInboxClient({ baseUrl: base, fetch: fetcher, headers: { authorization: 'Bearer alice' }, cacheScope: 'reconnect' })
    const controller = h.controller()
    const iterator = client.events({ signal: controller.signal, reconnect: true, reconnectMs: 0 })[Symbol.asyncIterator]()
    const initial = await bounded(iterator.next(), 'first client connection')
    if (initial.done) throw new Error('Client stream ended before its first ready frame')
    expect(initial.value.type).toBe('ready')
    const firstLabel = await h.inbox.createLabel('alice', account.id, 'Before socket gap')
    const first = await bounded(iterator.next(), 'event before forced disconnect')
    if (first.done || first.value.type !== 'label.updated') throw new Error('Expected the first label ChangeEvent')
    expect(first.value.entityId).toBe(firstLabel.id)
    const resume = h.pending(iterator.next())
    await bounded(reconnect.entered, 'client reconnection attempt')
    expect(streamRequests[1]!.headers.get('last-event-id')).toBe(first.value.id)
    const secondLabel = await h.inbox.createLabel('alice', account.id, 'During socket gap')
    reconnect.release()
    const ready = await bounded(resume, 'resumed ready frame')
    expect(ready.value).toEqual({ type: 'ready', state: first.value.id })
    const second = await bounded(iterator.next(), 'replayed gap event')
    if (second.done || second.value.type !== 'label.updated') throw new Error('Expected the replayed label ChangeEvent')
    expect(second.value.entityId).toBe(secondLabel.id)
    expect(second.value.id).not.toBe(first.value.id)
    expect(streamRequests).toHaveLength(2)
    controller.abort()
    if (iterator.return) await bounded(iterator.return(undefined), 'reconnected stream cancellation')
  })

  test('credential changes terminate old-owner streams and new streams deliver only the new owner events', async () => {
    const h = await fixture()
    const a = await h.seed('alice', 'stream-switch-alice')
    const b = await h.seed('bob', 'stream-switch-bob')
    const client = createInboxClient({ baseUrl: h.socket(), headers: { authorization: 'Bearer alice' }, cacheScope: 'alice-stream' })
    const controller = h.controller()
    const old = client.events({ signal: controller.signal, reconnect: false })[Symbol.asyncIterator]()
    const oldReady = await bounded(old.next(), 'old-owner stream ready')
    if (oldReady.done) throw new Error('Old-owner stream ended before ready')
    expect(oldReady.value.type).toBe('ready')
    const waiting = h.pending(old.next()).then(result => ({ done: result.done, error: null }), error => ({ done: false, error: error as Error }))
    client.setCredentials({ headers: { authorization: 'Bearer bob' }, cacheScope: 'bob-stream' })
    const closed = await bounded(waiting, 'old-owner stream termination')
    expect(closed.done === true || closed.error?.name === 'AbortError').toBe(true)
    const current = client.events({ signal: controller.signal, reconnect: false })[Symbol.asyncIterator]()
    const currentReady = await bounded(current.next(), 'new-owner stream ready')
    if (currentReady.done) throw new Error('New-owner stream ended before ready')
    expect(currentReady.value.type).toBe('ready')
    await h.inbox.createLabel('alice', a.account.id, 'Old owner private event')
    const bobLabel = await h.inbox.createLabel('bob', b.account.id, 'New owner event')
    const change = await bounded(current.next(), 'new-owner label event')
    if (change.done || change.value.type !== 'label.updated') throw new Error('Expected the new owner label event')
    expect(change.value.entityId).toBe(bobLabel.id)
    expect(change.value.accountId).toBe(b.account.id)
    expect((await client.accounts()).map(account => account.id)).toEqual([b.account.id])
    controller.abort()
    if (old.return) await bounded(old.return(undefined), 'old iterator cleanup')
    if (current.return) await bounded(current.return(undefined), 'new iterator cleanup')
  })
})

describe('pilot contract: server OAuth, configured mailboxes, and canonical messages', () => {
  const discovery: ConnectionSources = {
    sources: [
      { kind: 'domain', value: 'alpha.example.test', canReceive: true, canSend: true, canFilter: true },
      { kind: 'domain', value: 'beta.example.test', canReceive: true, canSend: true, canFilter: true },
      { kind: 'address', value: 'help@alpha.example.test', canReceive: true, canSend: true, canFilter: true },
    ],
    identities: [{ email: 'help@alpha.example.test' }, { email: 'desk@beta.example.test' }],
  }
  const googleOAuth = {
    clientId: 'pilot-client.apps.googleusercontent.com', clientSecret: `${SECRET}-google-client`,
    redirectUri: 'https://inbox.example.test/v1/oauth/google/callback',
  }

  test('connection credentials are encrypted once at the connection boundary and never returned in source or connection metadata', async () => {
    const h = await fixture()
    const box = referenceMailbox('pilot-key', 'pilot-key@example.test', [])
    h.boxes.set(box.key, box)
    h.discoveries.set(box.key, discovery)
    await invalid(await h.request('alice', '/connections', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: SCOPED, credentials: { mailbox: box.key, apiKey: `${SECRET}-invalid` } }),
    }), 409)
    expect(await h.inbox.connections('alice')).toEqual([])
    const connection = await h.json<Connection>('alice', '/connections', {
      providerId: SCOPED, credentials: { mailbox: box.key, apiKey: SECRET },
    }, 'POST', 201)
    expect(connection).toMatchObject({ providerId: SCOPED, status: 'connected', identity: null })
    expect(connection.sourceIds).toHaveLength(1)
    expect(connection.id).not.toBe(connection.sourceIds[0])
    const source = await h.json<Account>('alice', `/accounts/${connection.sourceIds[0]}`)
    expect(source.connectionId).toBe(connection.id)
    const connections = await h.json<Connection[]>('alice', '/connections')
    expect(connections.map(item => item.id)).toEqual([connection.id])
    expect(await h.json<Connection>('alice', `/connections/${connection.id}`)).toEqual(connection)
    const publicData = JSON.stringify({ connection, source, connections, logs: h.logs })
    expect(publicData).not.toContain(SECRET)
    for (const field of ['credentials', 'apiKey', 'accessToken', 'refreshToken']) expect(publicData).not.toContain(field)
    const db = new Database(h.database, { readonly: true })
    try {
      const stored = db.query<{ credentials: string }, [string]>('SELECT credentials FROM sdk_connections WHERE id=?').get(connection.id)
      expect(stored?.credentials).toMatch(/^v1\./)
      expect(stored?.credentials).not.toContain(SECRET)
      const old = db.query<{ credentials: string }, [string]>('SELECT credentials FROM sdk_accounts WHERE id=?').get(source.id)
      expect(old?.credentials).toBe('')
    } finally { db.close() }
    await h.restart()
    expect(await h.json<Connection>('alice', `/connections/${connection.id}`)).toEqual(connection)
    expect((await h.json<MailboxCandidate[]>('alice', `/connections/${connection.id}/mailbox-candidates`)).length).toBe(3)
    expect(box.calls.create.at(-1)!.apiKey).toBe(SECRET)
  })

  test('legacy providers get an automatic all-mail view while a manual provider is not polled before a mailbox is selected', async () => {
    const h = await fixture()
    const legacy = await h.connect('alice', 'legacy-view', [native('legacy')])
    h.discoveries.set('manual-view', discovery)
    const manual = await h.connect('alice', 'manual-view', [native('manual', { sourceDomains: ['alpha.example.test'] })], SCOPED)
    const mailboxes = await h.json<Mailbox[]>('alice', '/mailboxes')
    expect(mailboxes.filter(item => item.sourceId === legacy.account.id)).toEqual([
      expect.objectContaining({ selector: { kind: 'all' }, status: 'active' }),
    ])
    expect(mailboxes.filter(item => item.sourceId === manual.account.id)).toEqual([])
    await h.inbox.poll()
    expect(legacy.box.calls.sync).toHaveLength(1)
    expect(manual.box.calls.sync).toEqual([])
    const selected = await h.json<Mailbox>('alice', '/mailboxes', {
      sourceId: manual.account.id, name: 'Selected domain', selector: { kind: 'domain', value: 'alpha.example.test' },
    }, 'POST', 201)
    expect(selected).toMatchObject({ sourceId: manual.account.id, connectionId: manual.account.connectionId, receiving: 'ready' })
    await h.inbox.poll()
    expect(manual.box.calls.sync).toHaveLength(1)
    expect((await h.json<Page<MailboxMessageSummary>>('alice', `/mailbox-messages?mailboxIds=${selected.id}`)).total).toBe(1)
  })

  test('discovered domain and address proofs select overlapping views without guessing from To or merging separate native deliveries', async () => {
    const h = await fixture()
    h.discoveries.set('scope-proof', discovery)
    const shared = native('delivery-one', {
      subject: 'Identical delivery', rfcMessageId: '<same-rfc@example.test>', bodyText: BODY_SECRET,
      sourceDomains: ['alpha.example.test'], deliveryRecipients: ['help@alpha.example.test'],
      to: [participant('desk@beta.example.test')],
    })
    const { account } = await h.connect('alice', 'scope-proof', [
      shared, { ...shared, id: 'delivery-two' },
      native('header-only', { to: [participant('help@alpha.example.test')], sourceDomains: ['beta.example.test'] }),
    ], SCOPED)
    const candidates = await h.json<MailboxCandidate[]>('alice', `/connections/${account.connectionId}/mailbox-candidates`)
    expect(candidates.map(item => item.selector)).toEqual(expect.arrayContaining([
      { kind: 'domain', value: 'alpha.example.test' }, { kind: 'domain', value: 'beta.example.test' },
      { kind: 'address', value: 'help@alpha.example.test' },
    ]))
    expect(candidates).toHaveLength(3)
    expect(candidates.every(item => item.sourceId === account.id && item.canFilter && item.canReceive)).toBe(true)
    expect(candidates.find(item => item.selector.kind === 'address')?.identities).toEqual(['help@alpha.example.test'])
    const a = await h.json<Mailbox>('alice', '/mailboxes', {
      sourceId: account.id, name: 'Alpha domain', selector: { kind: 'domain', value: 'alpha.example.test' },
    }, 'POST', 201)
    const b = await h.json<Mailbox>('alice', '/mailboxes', {
      sourceId: account.id, name: 'Help address', selector: { kind: 'address', value: 'help@alpha.example.test' },
    }, 'POST', 201)
    await h.json('alice', `/mailboxes/${a.id}/sync`, {}, 'POST')
    const page = await h.json<Page<MailboxMessageSummary>>('alice', `/mailbox-messages?mailboxIds=${a.id},${b.id}`)
    expect(page.total).toBe(2)
    expect(new Set(page.items.map(item => item.id)).size).toBe(2)
    expect(page.items.every(item => item.subject === shared.subject && item.sourceId === account.id)).toBe(true)
    for (const item of page.items) {
      expect(item.memberships.map(member => member.mailboxId).sort()).toEqual([a.id, b.id].sort())
      expect((await h.json<Message>('alice', `/mailboxes/${a.id}/messages/${item.id}`)).bodyText).toBe(BODY_SECRET)
    }
    expect(JSON.stringify(page)).not.toContain(BODY_SECRET)
    expect((await h.page('alice', { accountId: account.id })).total).toBe(3)
  })

  test('delivery evidence accumulates before unchanged-body and backfill shortcuts, then survives omissions and restart', async () => {
    const h = await fixture()
    h.discoveries.set('evidence-union', discovery)
    const original = native('one-upstream-record', { bodyText: 'Authoritative body', sourceDomains: ['alpha.example.test'] })
    const { account, box } = await h.connect('alice', 'evidence-union', [original], SCOPED)
    const a = await h.json<Mailbox>('alice', '/mailboxes', {
      sourceId: account.id, name: 'Evidence A', selector: { kind: 'domain', value: 'alpha.example.test' },
    }, 'POST', 201)
    const b = await h.json<Mailbox>('alice', '/mailboxes', {
      sourceId: account.id, name: 'Evidence B', selector: { kind: 'domain', value: 'beta.example.test' },
    }, 'POST', 201)
    await h.json('alice', `/mailboxes/${a.id}/sync`, {}, 'POST')
    const first = (await h.inbox.mailboxMessages('alice', { mailboxIds: [a.id] })).items[0]!
    expect((await h.inbox.mailboxMessages('alice', { mailboxIds: [b.id] })).total).toBe(0)
    const baseline = await h.inbox.changes('alice')
    box.nextSync(receipt([{ ...original, sourceDomains: ['beta.example.test'] }], 'same-body-new-scope'))
    await h.json('alice', `/mailboxes/${b.id}/sync`, {}, 'POST')
    expect((await h.inbox.mailboxMessages('alice', { mailboxIds: [b.id] })).items.map(item => item.id)).toEqual([first.id])
    box.nextSync(receipt([native(original.id, { bodyText: original.bodyText })], 'detail-without-delivery-evidence'))
    await h.sync('alice', account.id)
    await h.restart()
    const historicalAddress = await h.json<Mailbox>('alice', '/mailboxes', {
      sourceId: account.id, name: 'Historical address proof', selector: { kind: 'address', value: 'help@alpha.example.test' },
    }, 'POST', 201)
    expect((await h.inbox.mailboxMessages('alice', { mailboxIds: [historicalAddress.id] })).total).toBe(0)
    box.nextSync(receipt([native(original.id, { bodyText: 'Obsolete backfill body', deliveryRecipients: ['help@alpha.example.test'] })], 'historical-detail'))
    await h.json('alice', `/mailboxes/${b.id}/sync`, { lane: 'backfill' }, 'POST')
    const union = await h.inbox.mailboxMessages('alice', { mailboxIds: [a.id, b.id] })
    expect(union.total).toBe(1)
    expect(union.items[0]!.id).toBe(first.id)
    expect(union.items[0]!.memberships.map(item => item.mailboxId).sort()).toEqual([a.id, b.id].sort())
    expect((await h.inbox.mailboxMessage('alice', a.id, first.id)).bodyText).toBe(original.bodyText)
    expect((await h.inbox.mailboxMessage('alice', b.id, first.id)).bodyText).toBe(original.bodyText)
    expect((await h.inbox.mailboxMessage('alice', historicalAddress.id, first.id)).bodyText).toBe(original.bodyText)
    expect((await h.inbox.changes('alice', { since: baseline.state })).events.filter(event => event.type === 'mail.changed' && event.reason === 'arrival')).toEqual([])
  })

  test('unified counts and tied-timestamp pagination count canonical records rather than mailbox memberships', async () => {
    const h = await fixture()
    h.discoveries.set('distinct-pages', discovery)
    const { account } = await h.connect('alice', 'distinct-pages', [
      ...['overlap-1', 'overlap-2', 'overlap-3'].map(id => native(id, { sourceDomains: ['alpha.example.test', 'beta.example.test'] })),
      native('only-a', { sourceDomains: ['alpha.example.test'] }), native('only-b', { sourceDomains: ['beta.example.test'] }),
    ], SCOPED)
    const a = await h.json<Mailbox>('alice', '/mailboxes', {
      sourceId: account.id, name: 'Pages A', selector: { kind: 'domain', value: 'alpha.example.test' },
    }, 'POST', 201)
    const b = await h.json<Mailbox>('alice', '/mailboxes', {
      sourceId: account.id, name: 'Pages B', selector: { kind: 'domain', value: 'beta.example.test' },
    }, 'POST', 201)
    await h.json('alice', `/mailboxes/${a.id}/sync`, {}, 'POST')
    expect((await h.inbox.mailboxMessages('alice', { mailboxIds: [a.id] })).total).toBe(4)
    expect((await h.inbox.mailboxMessages('alice', { mailboxIds: [b.id] })).total).toBe(4)
    const path = `/mailbox-messages?mailboxIds=${a.id},${b.id}&limit=2`
    const first = await h.json<Page<MailboxMessageSummary>>('alice', path)
    expect(first.total).toBe(5)
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()
    expect(await h.json<Page<MailboxMessageSummary>>('alice', path)).toEqual(first)
    const ids = first.items.map(item => item.id)
    let cursor = first.nextCursor
    while (cursor) {
      const next = await h.json<Page<MailboxMessageSummary>>('alice', `${path}&cursor=${encodeURIComponent(cursor)}`)
      expect(next.total).toBe(5)
      ids.push(...next.items.map(item => item.id))
      expect(ids.length).toBeLessThanOrEqual(5)
      cursor = next.nextCursor
    }
    expect(ids).toHaveLength(5)
    expect(new Set(ids).size).toBe(5)
    await invalid(await h.request('alice', `/mailbox-messages?mailboxIds=${a.id}&limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`))
    await invalid(await h.request('alice', `/mailbox-messages?mailboxIds=${a.id}&done=perhaps`), 400)
  })

  test('native read state is global to the canonical record while done and snooze are local to one membership', async () => {
    const h = await fixture()
    h.discoveries.set('workflow-scope', discovery)
    const { account, box } = await h.connect('alice', 'workflow-scope', [native('shared', { sourceDomains: ['alpha.example.test', 'beta.example.test'] })], SCOPED)
    const a = await h.json<Mailbox>('alice', '/mailboxes', {
      sourceId: account.id, name: 'Workflow A', selector: { kind: 'domain', value: 'alpha.example.test' },
    }, 'POST', 201)
    const b = await h.json<Mailbox>('alice', '/mailboxes', {
      sourceId: account.id, name: 'Workflow B', selector: { kind: 'domain', value: 'beta.example.test' },
    }, 'POST', 201)
    await h.json('alice', `/mailboxes/${a.id}/sync`, {}, 'POST')
    const message = (await h.inbox.mailboxMessages('alice', { mailboxIds: [a.id, b.id] })).items[0]!
    const until = new Date(h.clock.value + 60_000).toISOString()
    const path = `/mailboxes/${a.id}/messages/${message.id}`
    const member = await h.json<MailboxMembership>('alice', `${path}/state`, { done: true, snoozedUntil: until }, 'PATCH', 200, { 'If-Match': await etag(h, 'alice', path) })
    expect(member).toMatchObject({ mailboxId: a.id, messageId: message.id, done: true, snoozedUntil: until })
    expect((await h.inbox.mailboxMessage('alice', b.id, message.id)).memberships.find(item => item.mailboxId === b.id)).toMatchObject({ done: false, snoozedUntil: null })
    const operation = await h.json<Operation>('alice', '/operations', {
      messageIds: [message.id], viaMailboxId: a.id, changes: { isRead: true },
    }, 'POST', 202, { 'Idempotency-Key': 'shared-native-read' })
    await h.inbox.runDue()
    expect((await h.inbox.operation('alice', operation.id)).status).toBe('succeeded')
    expect(box.calls.mutate).toEqual([{ id: 'shared', changes: { isRead: true } }])
    for (const mailbox of [a, b]) expect((await h.inbox.mailboxMessage('alice', mailbox.id, message.id)).isRead).toBe(true)
    expect((await h.inbox.message('alice', message.id)).snoozedUntil).toBeNull()
    expect((await h.json<Page<MailboxMessageSummary>>('alice', `/mailbox-messages?mailboxIds=${a.id}&done=true&snoozed=true`)).total).toBe(1)
    expect((await h.json<Page<MailboxMessageSummary>>('alice', `/mailbox-messages?mailboxIds=${b.id}&done=false&snoozed=false`)).total).toBe(1)
    expect((await h.json<Page<MailboxMessageSummary>>('alice', `/mailbox-messages?mailboxIds=${a.id},${b.id}&done=false&snoozed=true`)).total).toBe(0)
    await h.restart()
    expect((await h.inbox.mailboxMessage('alice', a.id, message.id)).memberships.find(item => item.mailboxId === a.id)).toEqual(member)
    h.clock.value += 60_000
    await h.inbox.runDue()
    expect((await h.inbox.mailboxMessage('alice', a.id, message.id)).memberships.find(item => item.mailboxId === a.id)).toMatchObject({ done: true, snoozedUntil: null })
    expect(box.calls.mutate).toHaveLength(1)
  })

  test('viaMailboxId authorizes every selected record before accepting native or local intent', async () => {
    const h = await fixture()
    h.discoveries.set('write-context', discovery)
    const { account, box } = await h.connect('alice', 'write-context', [
      native('only-a', { sourceDomains: ['alpha.example.test'] }), native('only-b', { sourceDomains: ['beta.example.test'] }),
    ], SCOPED)
    const a = await h.json<Mailbox>('alice', '/mailboxes', {
      sourceId: account.id, name: 'Write A', selector: { kind: 'domain', value: 'alpha.example.test' },
    }, 'POST', 201)
    const b = await h.json<Mailbox>('alice', '/mailboxes', {
      sourceId: account.id, name: 'Write B', selector: { kind: 'domain', value: 'beta.example.test' },
    }, 'POST', 201)
    await h.sync('alice', account.id)
    const own = (await h.inbox.mailboxMessages('alice', { mailboxIds: [a.id] })).items[0]!
    const other = (await h.inbox.mailboxMessages('alice', { mailboxIds: [b.id] })).items[0]!
    const baseline = await h.inbox.changes('alice')
    await invalid(await h.request('alice', '/operations', {
      method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'mixed-mailbox-context' },
      body: JSON.stringify({ messageIds: [own.id, other.id], viaMailboxId: a.id, changes: { isRead: true } }),
    }), 404)
    await expect(h.inbox.mutate('alice', { messageIds: [other.id], viaMailboxId: a.id, changes: { isStarred: true }, idempotencyKey: 'direct-wrong-view' })).rejects.toMatchObject({ status: 404 })
    await invalid(await h.request('alice', `/mailboxes/${a.id}/messages/${other.id}`), 404)
    await invalid(await h.request('alice', `/mailboxes/${a.id}/messages/${other.id}/state`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', 'If-Match': await etag(h, 'alice', `/mailboxes/${b.id}/messages/${other.id}`) },
      body: JSON.stringify({ done: true }),
    }), 404)
    await h.inbox.runDue()
    expect(box.calls.mutate).toEqual([])
    expect((await h.inbox.message('alice', own.id)).isRead).toBe(false)
    expect((await h.inbox.mailboxMessage('alice', b.id, other.id)).memberships.find(item => item.mailboxId === b.id)?.done).toBe(false)
    expect((await h.inbox.changes('alice', { since: baseline.state })).events).toEqual([])
  })

  test('mailbox configuration rejects duplicate names and unknown scopes and uses strong entity preconditions', async () => {
    const h = await fixture()
    h.discoveries.set('mailbox-config', discovery)
    const { account } = await h.connect('alice', 'mailbox-config', [], SCOPED)
    const a = await h.json<Mailbox>('alice', '/mailboxes', {
      sourceId: account.id, name: 'Alpha', selector: { kind: 'domain', value: 'alpha.example.test' }, defaultSender: 'help@alpha.example.test',
    }, 'POST', 201)
    const b = await h.json<Mailbox>('alice', '/mailboxes', {
      sourceId: account.id, name: 'Beta', selector: { kind: 'domain', value: 'beta.example.test' },
    }, 'POST', 201)
    for (const selector of [{ kind: 'domain', value: 'unknown.example.test' }, { kind: 'address', value: 'invented@alpha.example.test' }, { kind: 'all' }]) {
      await invalid(await h.request('alice', '/mailboxes', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceId: account.id, name: 'Not discovered', selector }),
      }))
    }
    await invalid(await h.request('alice', '/mailboxes', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceId: account.id, name: a.name, selector: { kind: 'address', value: 'help@alpha.example.test' } }),
    }), 409)
    const path = `/mailboxes/${a.id}`
    const tag = await etag(h, 'alice', path)
    await invalid(await h.request('alice', path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'No condition' }) }), 428)
    await invalid(await h.request('alice', path, { method: 'PATCH', headers: { 'content-type': 'application/json', 'If-Match': tag }, body: JSON.stringify({ name: b.name }) }), 409)
    const renamed = await h.json<Mailbox>('alice', path, { name: 'Renamed Alpha' }, 'PATCH', 200, { 'If-Match': tag })
    expect(renamed).toMatchObject({ id: a.id, selector: a.selector, defaultSender: a.defaultSender, name: 'Renamed Alpha', revision: a.revision + 1 })
    for (const stale of [tag, `W/${await etag(h, 'alice', path)}`, '*']) {
      await invalid(await h.request('alice', path, { method: 'PATCH', headers: { 'content-type': 'application/json', 'If-Match': stale }, body: JSON.stringify({ status: 'detached' }) }), 412)
    }
    expect((await h.json<Mailbox>('alice', path)).status).toBe('active')
  })

  test('a candidate without authoritative filtering is explicit metadata, not permission to invent a header-based mailbox', async () => {
    const h = await fixture()
    h.discoveries.set('cannot-filter', {
      sources: [{ kind: 'domain', value: 'alpha.example.test', canReceive: true, canSend: false, canFilter: false, unavailableReason: 'No delivery evidence available' }],
      identities: [],
    })
    const { account, box } = await h.connect('alice', 'cannot-filter', [native('looks-matching', { to: [participant('help@alpha.example.test')] })], SCOPED)
    const candidates = await h.json<MailboxCandidate[]>('alice', `/connections/${account.connectionId}/mailbox-candidates`)
    expect(candidates).toEqual([expect.objectContaining({
      sourceId: account.id, selector: { kind: 'domain', value: 'alpha.example.test' }, canFilter: false,
      unavailableReason: 'No delivery evidence available',
    })])
    await invalid(await h.request('alice', '/mailboxes', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        sourceId: account.id, name: 'Must not guess', selector: { kind: 'domain', value: 'alpha.example.test' },
      }),
    }))
    expect(await h.json<Mailbox[]>('alice', '/mailboxes')).toEqual([])
    await h.inbox.poll()
    expect(box.calls.sync).toEqual([])
  })

  test('detaching one mailbox revokes its old context but preserves the canonical message and blob through its sibling', async () => {
    const h = await fixture()
    h.discoveries.set('detach-view', discovery)
    const attachment: Attachment = { id: 'shared-bytes', filename: 'shared.bin', contentType: 'application/octet-stream', size: 4, url: 'https://upstream.invalid/private' }
    const bytes = new Uint8Array([0, 127, 128, 255])
    const { account, box } = await h.connect('alice', 'detach-view', [native('shared', {
      sourceDomains: ['alpha.example.test', 'beta.example.test'], bodyText: BODY_SECRET, attachments: [attachment],
    })], SCOPED)
    box.attachment('shared', attachment, bytes)
    const a = await h.json<Mailbox>('alice', '/mailboxes', {
      sourceId: account.id, name: 'Detach A', selector: { kind: 'domain', value: 'alpha.example.test' },
    }, 'POST', 201)
    const b = await h.json<Mailbox>('alice', '/mailboxes', {
      sourceId: account.id, name: 'Keep B', selector: { kind: 'domain', value: 'beta.example.test' },
    }, 'POST', 201)
    await h.sync('alice', account.id)
    const id = (await h.inbox.mailboxMessages('alice', { mailboxIds: [a.id] })).items[0]!.id
    const path = `/mailboxes/${a.id}/messages/${id}`
    const oldTag = await etag(h, 'alice', path)
    const original = await h.inbox.mailboxMessage('alice', a.id, id)
    const blob = original.attachments[0]!
    expect((await h.inbox.download('alice', blob.id)).content).toEqual(bytes)
    const detached = await h.json<Mailbox>('alice', `/mailboxes/${a.id}`, { status: 'detached' }, 'PATCH', 200, { 'If-Match': await etag(h, 'alice', `/mailboxes/${a.id}`) })
    expect(detached.status).toBe('detached')
    await invalid(await h.request('alice', path, { headers: { 'If-None-Match': oldTag } }), 404)
    await invalid(await h.request('alice', `${path}/state`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', 'If-Match': oldTag }, body: JSON.stringify({ done: true }),
    }), 404)
    await invalid(await h.request('alice', `/mailbox-messages?mailboxIds=${a.id},${b.id}`), 404)
    await expect(h.inbox.mutate('alice', { messageIds: [id], viaMailboxId: a.id, changes: { isRead: true }, idempotencyKey: 'detached-native-context' })).rejects.toMatchObject({ status: 404 })
    expect(box.calls.mutate).toEqual([])
    expect(box.calls.disconnect).toBe(0)
    await h.restart()
    const remaining = await h.json<Message>('alice', `/mailboxes/${b.id}/messages/${id}`)
    expect(remaining).toMatchObject({ id, bodyText: BODY_SECRET, attachments: [blob] })
    expect((await h.inbox.download('alice', blob.id)).content).toEqual(bytes)
    expect(box.calls.attachment).toHaveLength(1)
    expect((await h.inbox.mailboxMessages('alice', { mailboxIds: [b.id] })).total).toBe(1)
    await invalid(await h.request('alice', path), 404)
  })

  test('a paused view or an empty full-sync observation is not a global revocation of a shared record', async () => {
    const h = await fixture()
    h.discoveries.set('paused-view', discovery)
    const { account, box } = await h.connect('alice', 'paused-view', [native('retained', { sourceDomains: ['alpha.example.test', 'beta.example.test'] })], SCOPED)
    const a = await h.json<Mailbox>('alice', '/mailboxes', {
      sourceId: account.id, name: 'Paused A', selector: { kind: 'domain', value: 'alpha.example.test' },
    }, 'POST', 201)
    const b = await h.json<Mailbox>('alice', '/mailboxes', {
      sourceId: account.id, name: 'Active B', selector: { kind: 'domain', value: 'beta.example.test' },
    }, 'POST', 201)
    await h.sync('alice', account.id)
    const id = (await h.inbox.mailboxMessages('alice', { mailboxIds: [a.id, b.id] })).items[0]!.id
    await h.json<Mailbox>('alice', `/mailboxes/${a.id}`, { status: 'paused' }, 'PATCH', 200, { 'If-Match': await etag(h, 'alice', `/mailboxes/${a.id}`) })
    box.nextSync(receipt([], 'empty-view-snapshot', { fullSync: true }))
    await h.json('alice', `/mailboxes/${b.id}/sync`, {}, 'POST')
    expect((await h.inbox.mailboxMessage('alice', a.id, id)).id).toBe(id)
    expect((await h.inbox.mailboxMessage('alice', b.id, id)).id).toBe(id)
    expect((await h.page('alice', { accountId: account.id })).items.map(item => item.id)).toEqual([id])
    await h.json<Mailbox>('alice', `/mailboxes/${b.id}`, { status: 'paused' }, 'PATCH', 200, { 'If-Match': await etag(h, 'alice', `/mailboxes/${b.id}`) })
    const calls = box.calls.sync.length
    h.clock.value += 120_000
    await h.restart()
    await h.inbox.poll()
    expect(box.calls.sync.length).toBe(calls)
    expect((await h.inbox.mailboxMessage('alice', b.id, id)).subject).toBe('Subject retained')
  })

  test('connection, candidate, mailbox, and OAuth status routes remain private and reject foreign IDs before provider work', async () => {
    const h = await fixture({ googleOAuth })
    const { account, box } = await h.seed('bob', 'private-pilot')
    const mailbox = (await h.inbox.mailboxes('bob'))[0]!
    const message = (await h.page('bob')).items[0]!
    const attempt = await h.json<OAuthAttempt>('bob', '/connections/google/start', {}, 'POST')
    for (const path of ['/connections', '/mailboxes', `/connections/${account.connectionId}/mailbox-candidates`,
      `/mailboxes/${mailbox.id}`, `/mailbox-messages?mailboxIds=${mailbox.id}`, `/connections/google/attempts/${attempt.id}`]) {
      await invalid(await h.request(null, path), 401)
    }
    await invalid(await h.request(null, '/connections/google/start', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }), 401)
    const before = { creates: box.calls.create.length, syncs: box.calls.sync.length, disconnects: box.calls.disconnect }
    const requests: Array<[string, string, unknown?]> = [
      ['GET', `/connections/${account.connectionId}`], ['DELETE', `/connections/${account.connectionId}`],
      ['GET', `/connections/${account.connectionId}/mailbox-candidates`], ['GET', `/mailboxes/${mailbox.id}`],
      ['PATCH', `/mailboxes/${mailbox.id}`, { status: 'detached' }], ['POST', `/mailboxes/${mailbox.id}/sync`, {}],
      ['POST', '/mailboxes', { sourceId: account.id, name: 'Foreign source', selector: { kind: 'all' } }],
      ['GET', `/mailbox-messages?mailboxIds=${mailbox.id}`], ['GET', `/mailboxes/${mailbox.id}/messages/${message.id}`],
      ['PATCH', `/mailboxes/${mailbox.id}/messages/${message.id}/state`, { done: true }],
      ['GET', `/connections/google/attempts/${attempt.id}`], ['POST', '/connections/google/start', { connectionId: account.connectionId }],
    ]
    for (const [method, path, body] of requests) {
      await invalid(await h.request('alice', path, {
        method, headers: { 'content-type': 'application/json', 'If-Match': '"foreign-etag"' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), 404)
    }
    expect(await h.json<Connection[]>('alice', '/connections')).toEqual([])
    expect(await h.json<Mailbox[]>('alice', '/mailboxes')).toEqual([])
    expect(box.calls.create.length).toBe(before.creates)
    expect(box.calls.sync.length).toBe(before.syncs)
    expect(box.calls.disconnect).toBe(before.disconnects)
    expect(h.google.requests).toEqual([])
  })

  test('mailbox-bound drafts choose a verified scoped sender and detach cancels only their undispatched submissions', async () => {
    const h = await fixture()
    h.discoveries.set('scoped-drafts', discovery)
    const { account, box } = await h.connect('alice', 'scoped-drafts', [], SCOPED)
    const a = await h.json<Mailbox>('alice', '/mailboxes', {
      sourceId: account.id, name: 'Sender A', selector: { kind: 'domain', value: 'alpha.example.test' }, defaultSender: 'help@alpha.example.test',
    }, 'POST', 201)
    const b = await h.json<Mailbox>('alice', '/mailboxes', {
      sourceId: account.id, name: 'Sender B', selector: { kind: 'domain', value: 'beta.example.test' }, defaultSender: 'desk@beta.example.test',
    }, 'POST', 201)
    await invalid(await h.request('alice', `/mailboxes/${a.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', 'If-Match': await etag(h, 'alice', `/mailboxes/${a.id}`) },
      body: JSON.stringify({ defaultSender: b.defaultSender }),
    }), 403)
    const first = await h.draft('alice', account.id, { mailboxId: a.id, to: [participant('recipient@example.test')], subject: 'Do not dispatch', bodyText: 'Retain this autosave' })
    const second = await h.draft('alice', account.id, { mailboxId: b.id, to: [participant('recipient@example.test')], subject: 'Sibling may dispatch' })
    const advanced = await h.draft('alice', account.id, { subject: 'Advanced source draft' })
    expect(first).toMatchObject({ mailboxId: a.id, from: 'help@alpha.example.test' })
    expect(second).toMatchObject({ mailboxId: b.id, from: 'desk@beta.example.test' })
    expect(advanced.from).toBe(account.email)
    expect(advanced.mailboxId).toBeUndefined()
    const sendAt = new Date(h.clock.value + 60_000).toISOString()
    const cancel = await h.submit('alice', first, 'bound-to-a', sendAt)
    const keep = await h.submit('alice', second, 'bound-to-b', sendAt)
    await h.json<Mailbox>('alice', `/mailboxes/${a.id}`, { status: 'detached' }, 'PATCH', 200, { 'If-Match': await etag(h, 'alice', `/mailboxes/${a.id}`) })
    expect((await h.inbox.operation('alice', cancel.id)).status).toBe('cancelled')
    expect((await h.inbox.operation('alice', keep.id)).status).toBe('pending')
    expect(await h.inbox.draft('alice', first.id)).toMatchObject({ status: 'active', mailboxId: a.id, from: first.from, bodyText: first.bodyText })
    await h.restart()
    h.clock.value += 60_000
    await h.inbox.runDue()
    expect(box.calls.send).toHaveLength(1)
    expect(box.calls.send[0]).toMatchObject({ from: 'desk@beta.example.test', subject: second.subject })
    expect((await h.inbox.operation('alice', cancel.id)).status).toBe('cancelled')
    expect((await h.inbox.operation('alice', keep.id)).status).toBe('succeeded')
    await invalid(await h.request('alice', `/drafts/${first.id}/submit`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'detached-cannot-resubmit' }, body: JSON.stringify({ revision: first.revision }),
    }))
  })

  test('disabling provider writes still permits cached reads, synchronization, drafts, and mailbox-local workflow state', async () => {
    const h = await fixture({ allowProviderWrites: false })
    h.discoveries.set('read-only-pilot', discovery)
    const { account, box } = await h.connect('alice', 'read-only-pilot', [native('read-only', { sourceDomains: ['alpha.example.test'], bodyText: BODY_SECRET })], SCOPED)
    const mailbox = await h.json<Mailbox>('alice', '/mailboxes', {
      sourceId: account.id, name: 'Read-only pilot', selector: { kind: 'domain', value: 'alpha.example.test' }, defaultSender: 'help@alpha.example.test',
    }, 'POST', 201)
    await h.json('alice', `/mailboxes/${mailbox.id}/sync`, {}, 'POST')
    const message = (await h.inbox.mailboxMessages('alice', { mailboxIds: [mailbox.id] })).items[0]!
    const path = `/mailboxes/${mailbox.id}/messages/${message.id}`
    expect((await h.json<Message>('alice', path)).bodyText).toBe(BODY_SECRET)
    const local = await h.json<MailboxMembership>('alice', `${path}/state`, {
      done: true, snoozedUntil: new Date(h.clock.value + 60_000).toISOString(),
    }, 'PATCH', 200, { 'If-Match': await etag(h, 'alice', path) })
    expect(local.done).toBe(true)
    const draft = await h.draft('alice', account.id, { mailboxId: mailbox.id, to: [participant('recipient@example.test')], bodyText: 'A local draft is safe' })
    await invalid(await h.request('alice', `/drafts/${draft.id}/submit`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'writes-disabled-send' }, body: JSON.stringify({ revision: draft.revision }),
    }), 403)
    await invalid(await h.request('alice', '/operations', {
      method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'writes-disabled-native' },
      body: JSON.stringify({ messageIds: [message.id], viaMailboxId: mailbox.id, changes: { isRead: true } }),
    }), 403)
    await invalid(await h.request('alice', `/accounts/${account.id}/folders`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Provider write prohibited' }),
    }), 403)
    await expect(h.inbox.mutate('alice', { messageIds: [message.id], changes: { isStarred: true }, idempotencyKey: 'advanced-writes-also-disabled' })).rejects.toMatchObject({ status: 403 })
    await h.inbox.runDue()
    expect(box.calls.sync).toHaveLength(1)
    expect(box.calls.send).toEqual([])
    expect(box.calls.mutate).toEqual([])
    expect(box.calls.createFolder).toEqual([])
    expect((await h.inbox.draft('alice', draft.id)).status).toBe('active')
    expect((await h.inbox.message('alice', message.id)).isRead).toBe(false)
  })

  test('advanced source APIs retain their owner-authorized whole-source semantics independently of configured view state', async () => {
    const h = await fixture()
    h.discoveries.set('advanced-source', discovery)
    const { account, box } = await h.connect('alice', 'advanced-source', [
      native('selected', { sourceDomains: ['alpha.example.test'] }),
      native('outside-view', { sourceDomains: ['beta.example.test'], folder: 'archive' }),
      native('no-evidence', { to: [participant('help@alpha.example.test')] }),
    ], SCOPED)
    await h.sync('alice', account.id)
    expect((await h.page('alice', { accountId: account.id })).total).toBe(3)
    const mailbox = await h.json<Mailbox>('alice', '/mailboxes', {
      sourceId: account.id, name: 'Narrow view', selector: { kind: 'domain', value: 'alpha.example.test' },
    }, 'POST', 201)
    expect((await h.inbox.mailboxMessages('alice', { mailboxIds: [mailbox.id] })).total).toBe(1)
    const outside = (await h.page('alice', { accountId: account.id, folder: 'archive' })).items[0]!
    await invalid(await h.request('alice', `/mailboxes/${mailbox.id}/messages/${outside.id}`), 404)
    expect((await h.json<Message>('alice', `/messages/${outside.id}`)).subject).toBe('Subject outside-view')
    await h.mutate('alice', [outside.id], { isRead: true }, 'explicit-advanced-source-write')
    await h.inbox.runDue()
    expect(box.calls.mutate).toEqual([{ id: 'outside-view', changes: { isRead: true } }])
    await h.json<Mailbox>('alice', `/mailboxes/${mailbox.id}`, { status: 'detached' }, 'PATCH', 200, { 'If-Match': await etag(h, 'alice', `/mailboxes/${mailbox.id}`) })
    expect((await h.page('alice', { accountId: account.id })).total).toBe(3)
    expect((await h.inbox.message('alice', outside.id)).isRead).toBe(true)
    await invalid(await h.request('bob', `/messages?accountId=${account.id}`), 404)
    await expect(h.inbox.message('bob', outside.id)).rejects.toMatchObject({ status: 404 })
  })

  test('SSE delivers new connection, mailbox, and membership events without duplicate arrivals and the client preserves their scope', async () => {
    const h = await fixture()
    h.discoveries.set('pilot-events', discovery)
    const { account, box } = await h.connect('alice', 'pilot-events', [], SCOPED)
    const a = await h.json<Mailbox>('alice', '/mailboxes', {
      sourceId: account.id, name: 'Events A', selector: { kind: 'domain', value: 'alpha.example.test' },
    }, 'POST', 201)
    await h.sync('alice', account.id)
    const bob = await h.seed('bob', 'foreign-pilot-events')
    const baseline = await h.inbox.changes('alice')
    const wire = transport(h)
    const client = createInboxClient({ baseUrl: 'http://inbox.test', fetch: wire.fetch, headers: { authorization: 'Bearer alice' }, cacheScope: 'pilot-events' })
    const controller = h.controller()
    const iterator = client.events({ since: baseline.state, reconnect: false, signal: controller.signal })
    expect((await bounded(iterator.next(), 'pilot stream ready')).value).toEqual({ type: 'ready', state: baseline.state })
    await client.mailboxes()
    await client.mailboxMessages({ mailboxIds: [a.id], done: false })
    const b = await h.json<Mailbox>('alice', '/mailboxes', {
      sourceId: account.id, name: 'Events B', selector: { kind: 'domain', value: 'beta.example.test' },
    }, 'POST', 201)
    const arrival = native('one-arrival', { bodyText: BODY_SECRET, sourceDomains: ['alpha.example.test'] })
    box.put(arrival)
    await h.sync('alice', account.id)
    const id = (await h.inbox.mailboxMessages('alice', { mailboxIds: [a.id] })).items[0]!.id
    box.put({ ...arrival, sourceDomains: ['beta.example.test'] })
    await h.sync('alice', account.id)
    await h.inbox.updateMailbox('alice', b.id, { name: 'Renamed Events B' }, b.revision)
    const state = (await h.inbox.mailboxMessage('alice', a.id, id)).memberships.find(item => item.mailboxId === a.id)!
    await h.inbox.setMailboxState('alice', a.id, id, { done: true }, state.revision)
    const extra = await h.connect('alice', 'event-connection', [])
    const foreign = await h.inbox.createLabel('bob', bob.account.id, 'Never expose this event')
    const journal = await h.inbox.changes('alice', { since: baseline.state, limit: 100 })
    expect(journal.hasMore).toBe(false)
    expect(journal.events.filter(event => event.type === 'mail.changed' && event.reason === 'arrival').map(event => event.entityId)).toEqual([id])
    expect(journal.events.filter(event => event.type === 'membership.updated' && event.change === 'created' && event.entityId === id).map(event => event.mailboxId).sort()).toEqual([a.id, b.id].sort())
    expect(journal.events.some(event => event.type === 'connection.updated' && event.entityId === extra.account.connectionId)).toBe(true)
    expect(journal.events.filter(event => event.type === 'mailbox.updated' && event.entityId === b.id)).toHaveLength(2)
    const streamed: ChangeEvent[] = []
    for (let index = 0; index < journal.events.length; index++) {
      const next = await bounded(iterator.next(), 'pilot scoped event')
      if (next.done || !('entityId' in next.value)) throw new Error('Expected a durable pilot ChangeEvent')
      streamed.push(next.value)
    }
    expect(streamed).toEqual(journal.events)
    expect(streamed.some(event => event.entityId === foreign.id)).toBe(false)
    expect(JSON.stringify(streamed)).not.toContain(BODY_SECRET)
    expect(JSON.stringify(streamed)).not.toContain(SECRET)
    expect((await client.mailboxes()).find(item => item.id === b.id)?.name).toBe('Renamed Events B')
    expect(wire.requests.at(-1)!.headers.get('if-none-match')).toBeNull()
    expect((await client.mailboxMessages({ mailboxIds: [a.id], done: false })).total).toBe(0)
    expect(wire.requests.at(-1)!.headers.get('if-none-match')).toBeNull()
    controller.abort()
    if (iterator.return) await bounded(iterator.return(), 'pilot event cancellation')
  })

  test('new client methods use comma-separated mailbox filters and GET representation ETags with membership rather than message revisions', async () => {
    const h = await fixture()
    const box = referenceMailbox('pilot-client', 'pilot-client@example.test', [native('shared', { sourceDomains: ['alpha.example.test', 'beta.example.test'] })])
    h.boxes.set(box.key, box)
    h.discoveries.set(box.key, discovery)
    const wire = transport(h)
    const client = createInboxClient({ baseUrl: 'http://inbox.test', fetch: wire.fetch, headers: { authorization: 'Bearer alice', 'x-host-application': 'pilot' }, cacheScope: 'pilot-client' })
    const connection = await client.createConnection({ providerId: SCOPED, credentials: { mailbox: box.key, apiKey: SECRET } })
    expect((await client.connections()).map(item => item.id)).toEqual([connection.id])
    expect((await client.connection(connection.id)).id).toBe(connection.id)
    expect(await client.mailboxCandidates(connection.id)).toHaveLength(3)
    const a = await client.createMailbox({ sourceId: connection.sourceIds[0]!, name: 'Client A', selector: { kind: 'domain', value: 'alpha.example.test' } })
    const b = await client.createMailbox({ sourceId: connection.sourceIds[0]!, name: 'Client B', selector: { kind: 'domain', value: 'beta.example.test' } })
    expect((await client.mailboxes()).map(item => item.id).sort()).toEqual([a.id, b.id].sort())
    await client.syncMailbox(a.id)
    const page = await client.mailboxMessages({ mailboxIds: [a.id, b.id], done: false, snoozed: false, limit: 1 })
    expect(page.total).toBe(1)
    const query = new URL(wire.requests.at(-1)!.path, 'http://inbox.test')
    expect(query.pathname).toBe('/v1/mailbox-messages')
    expect(query.searchParams.get('mailboxIds')?.split(',').sort()).toEqual([a.id, b.id].sort())
    expect(query.searchParams.get('done')).toBe('false')
    expect(query.searchParams.get('snoozed')).toBe('false')
    expect(wire.requests.at(-1)!.headers.get('x-host-application')).toBe('pilot')
    const id = page.items[0]!.id
    const before = await client.mailboxMessage(a.id, id)
    const oldTag = wire.requests.at(-1)!.etag!
    const member = before.memberships.find(item => item.mailboxId === a.id)!
    await client.mutate({ messageIds: [id], viaMailboxId: a.id, changes: { isRead: true }, idempotencyKey: 'different-revision-domains' })
    await h.inbox.runDue()
    const current = await client.mailboxMessage(a.id, id)
    expect(current.revision).not.toBe(member.revision)
    expect(current.memberships.find(item => item.mailboxId === a.id)?.revision).toBe(member.revision)
    const path = `/mailboxes/${a.id}/messages/${id}`
    await invalid(await h.request('alice', `${path}/state`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', 'If-Match': oldTag }, body: JSON.stringify({ done: true }),
    }), 412)
    await invalid(await h.request('alice', `${path}/state`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ done: true }),
    }), 428)
    const saved = await client.setMailboxState(a.id, id, { done: true }, member.revision)
    expect(saved).toMatchObject({ mailboxId: a.id, messageId: id, done: true, revision: member.revision + 1 })
    const patch = wire.requests.findLast(request => request.path === `/v1${path}/state` && request.method === 'PATCH')!
    const get = wire.requests.findLast(request => request.path === `/v1${path}` && request.method === 'GET')!
    expect(patch.headers.get('if-match')).toBe(get.etag)
    expect(patch.body).toEqual({ done: true })
    await expect(client.setMailboxState(a.id, id, { done: false }, member.revision)).rejects.toMatchObject({ status: 412 })
    expect((await client.mailboxMessages({ mailboxIds: [a.id], done: true })).total).toBe(1)
    expect((await client.mailboxMessages({ mailboxIds: [b.id], done: false })).total).toBe(1)
    const renamed = await client.updateMailbox(a.id, { name: 'Client renamed A' }, a.revision)
    expect((await client.mailbox(a.id)).name).toBe(renamed.name)
    await expect(client.updateMailbox(a.id, { name: 'Stale client name' }, a.revision)).rejects.toMatchObject({ status: 412 })
    await client.disconnectConnection(connection.id)
    expect(wire.requests.at(-1)).toMatchObject({ method: 'DELETE', path: `/v1/connections/${connection.id}`, status: 204 })
    expect((await client.connection(connection.id)).status).toBe('disconnected')
  })

  test('Google starts with host auth, uses a one-use cookie handoff and real PKCE/JWKS validation, and returns only a connection', async () => {
    const h = await fixture({ googleOAuth })
    h.boxes.set('google-first', referenceMailbox('google-first', 'verified-google@example.test', [native('google-message')]))
    const wire = transport(h)
    const client = createInboxClient({ baseUrl: 'https://inbox.example.test', fetch: wire.fetch, headers: { authorization: 'Bearer alice' }, cacheScope: 'google-owner' })
    const googleClient = createGoogleOAuthClient(client)
    const attempt = await googleClient.startGoogleOAuth()
    expect(wire.requests.at(-1)).toMatchObject({ method: 'POST', path: '/v1/connections/google/start', status: 200 })
    expect(attempt).toMatchObject({ providerId: 'gmail', status: 'pending', connectionId: null })
    expect(Date.parse(attempt.expiresAt)).toBe(h.clock.value + 10 * 60_000)
    const status = await googleClient.googleOAuthAttempt(attempt.id)
    expect(status.authorizeUrl).toBeUndefined()
    const handoffUrl = new URL(attempt.authorizeUrl!)
    expect(handoffUrl.origin).toBe('https://inbox.example.test')
    expect(handoffUrl.pathname).toBe(`/v1/oauth/google/authorize/${attempt.id}`)
    const handoff = await h.api.request(handoffUrl.href)
    expect(handoff.status).toBe(302)
    expect(handoff.headers.get('cache-control')).toBe('no-store')
    const setCookie = handoff.headers.get('set-cookie')!
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Lax')
    expect(setCookie).toContain('Secure')
    expect(setCookie).toContain('Max-Age=600')
    expect(setCookie.split('=')[0]).toBe(`inbox_google_oauth_${attempt.id}`)
    const cookie = setCookie.split(';')[0]!
    const authorization = new URL(handoff.headers.get('location')!)
    expect(authorization.origin).toBe('https://accounts.google.com')
    expect(authorization.pathname).toBe('/o/oauth2/v2/auth')
    expect(authorization.searchParams.get('client_id')).toBe(googleOAuth.clientId)
    expect(authorization.searchParams.get('redirect_uri')).toBe(googleOAuth.redirectUri)
    expect(authorization.searchParams.get('response_type')).toBe('code')
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorization.searchParams.get('scope')?.split(' ').sort()).toEqual(['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly'].sort())
    expect(authorization.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(authorization.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(authorization.href).not.toContain(googleOAuth.clientSecret)
    expect(authorization.searchParams.has('code_verifier')).toBe(false)
    const db = new Database(h.database, { readonly: true })
    let persisted = ''
    try {
      const row = db.query<{ secrets: string }, [string]>('SELECT * FROM sdk_oauth_attempts WHERE id=?').get(attempt.id)
      expect(row?.secrets).toMatch(/^v1\./)
      persisted = JSON.stringify(row)
      expect(persisted).not.toContain(authorization.searchParams.get('state')!)
      expect(persisted).not.toContain(authorization.searchParams.get('nonce')!)
      expect(persisted).not.toContain(handoffUrl.searchParams.get('ticket')!)
    } finally { db.close() }
    h.google.codes.set('google-first-code', {
      mailbox: 'google-first', subject: 'verified-google-subject', nonce: authorization.searchParams.get('nonce')!,
      challenge: authorization.searchParams.get('code_challenge')!,
    })
    await h.restart()
    const callback = new URL(googleOAuth.redirectUri)
    callback.search = new URLSearchParams({ state: authorization.searchParams.get('state')!, code: 'google-first-code' }).toString()
    const response = await h.api.request(callback.href, { headers: { cookie } })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(response.headers.get('set-cookie')?.split('=')[0]).toBe(cookie.split('=')[0])
    const connection = await response.json() as Connection
    expect(connection).toMatchObject({ providerId: 'gmail', identity: { issuer: 'https://accounts.google.com', subject: 'verified-google-subject', registrationId: googleOAuth.clientId } })
    expect(connection.sourceIds).toHaveLength(1)
    const completed = await googleClient.googleOAuthAttempt(attempt.id)
    expect(completed).toMatchObject({ status: 'completed', connectionId: connection.id })
    expect(completed.authorizeUrl).toBeUndefined()
    const tokenRequests = h.google.requests.filter(request => request.url === 'https://oauth2.googleapis.com/token')
    expect(tokenRequests).toHaveLength(1)
    const form = new URLSearchParams(tokenRequests[0]!.body)
    expect(form.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url')).toBe(authorization.searchParams.get('code_challenge')!)
    expect(persisted).not.toContain(form.get('code_verifier')!)
    expect(h.google.requests.some(request => request.url === 'https://www.googleapis.com/oauth2/v3/certs')).toBe(true)
    expect([...new Set(h.google.requests.map(request => request.url))].sort()).toEqual([
      'https://oauth2.googleapis.com/token', 'https://www.googleapis.com/oauth2/v3/certs', 'https://openidconnect.googleapis.com/v1/userinfo',
    ].sort())
    const exposed = JSON.stringify({ connection, completed, logs: h.logs })
    for (const secret of [SECRET, form.get('code_verifier')!, authorization.searchParams.get('nonce')!, authorization.searchParams.get('state')!, h.google.issued[0]!.idToken]) {
      expect(exposed).not.toContain(secret)
    }
    await invalid(await h.request(null, '/connections', { headers: { cookie } }), 401)
    expect(await h.inbox.connections('bob')).toEqual([])
    await h.sync('alice', connection.sourceIds[0]!)
    expect((await h.page('alice')).items.map(item => item.subject)).toEqual(['Subject google-message'])
  })

  test('multiple verified Gmail accounts keep independent connections, sources, native identities, and state', async () => {
    const h = await fixture({ googleOAuth })
    const records: Array<{ owner: string; connection: Connection; mailbox: Mailbox; message: MessageSummary }> = []
    for (const [owner, key] of [['alice', 'gmail-personal'], ['alice', 'gmail-work'], ['bob', 'gmail-foreign']] as const) {
      h.boxes.set(key, referenceMailbox(key, `${key}@example.test`, [native('same-google-native-id', {
        threadId: 'same-google-thread', subject: key, bodyText: `${BODY_SECRET}:${key}`,
      })]))
      const attempt = await h.json<OAuthAttempt>(owner, '/connections/google/start', {}, 'POST')
      const handoff = await h.api.request(attempt.authorizeUrl!)
      expect(handoff.status).toBe(302)
      const authorization = new URL(handoff.headers.get('location')!)
      h.google.codes.set(key, { mailbox: key, subject: `subject-${key}`, nonce: authorization.searchParams.get('nonce')!, challenge: authorization.searchParams.get('code_challenge')! })
      const callback = new URL(googleOAuth.redirectUri)
      callback.search = new URLSearchParams({ state: authorization.searchParams.get('state')!, code: key }).toString()
      const response = await h.api.request(callback.href, { headers: { cookie: handoff.headers.get('set-cookie')!.split(';')[0]! } })
      expect(response.status).toBe(200)
      const connection = await response.json() as Connection
      await h.sync(owner, connection.sourceIds[0]!)
      const message = (await h.page(owner, { accountId: connection.sourceIds[0]! })).items[0]!
      const mailbox = (await h.inbox.mailboxes(owner)).find(item => item.sourceId === connection.sourceIds[0])!
      expect(mailbox.selector).toEqual({ kind: 'all' })
      expect((await h.inbox.mailboxMessage(owner, mailbox.id, message.id)).bodyText).toBe(`${BODY_SECRET}:${key}`)
      records.push({ owner, connection, mailbox, message })
    }
    expect(new Set(records.map(item => item.connection.id)).size).toBe(3)
    expect(new Set(records.map(item => item.connection.sourceIds[0])).size).toBe(3)
    expect(new Set(records.map(item => item.message.id)).size).toBe(3)
    expect(new Set(records.map(item => item.message.threadId)).size).toBe(3)
    const [personal, work, foreign] = records as [typeof records[number], typeof records[number], typeof records[number]]
    expect((await h.inbox.mailboxMessages('alice', { mailboxIds: [personal.mailbox.id, work.mailbox.id] })).total).toBe(2)
    await h.mutate('alice', [personal.message.id], { isRead: true }, 'one-google-source-read')
    await h.inbox.runDue()
    expect((await h.inbox.message('alice', work.message.id)).isRead).toBe(false)
    expect((await h.inbox.message('bob', foreign.message.id)).isRead).toBe(false)
    await invalid(await h.request('alice', `/connections/${foreign.connection.id}/mailbox-candidates`), 404)
    await invalid(await h.request('alice', `/mailboxes/${foreign.mailbox.id}/messages/${foreign.message.id}`), 404)
    await h.restart()
    expect((await h.page('alice')).items.map(item => item.id).sort()).toEqual([personal.message.id, work.message.id].sort())
    expect((await h.page('bob')).items.map(item => item.id)).toEqual([foreign.message.id])
    expect((await h.inbox.message('alice', personal.message.id)).isRead).toBe(true)
  })

  test('same verified Google identity reauthorization preserves source, message, and mailbox IDs and an omitted refresh token', async () => {
    const h = await fixture({ googleOAuth })
    const box = referenceMailbox('google-reauth', 'same-verified-google@example.test', [native('stable-record')])
    h.boxes.set(box.key, box)
    let original: Connection | undefined
    let firstMessage: MessageSummary | undefined
    let firstMailbox: Mailbox | undefined
    for (let index = 0; index < 3; index++) {
      const attempt = await h.json<OAuthAttempt>('alice', '/connections/google/start', index === 1 ? { connectionId: original!.id } : {}, 'POST')
      const handoff = await h.api.request(attempt.authorizeUrl!)
      expect(handoff.status).toBe(302)
      const authorization = new URL(handoff.headers.get('location')!)
      const code = `reauth-${index}`
      h.google.codes.set(code, {
        mailbox: box.key, subject: 'stable-verified-subject', nonce: authorization.searchParams.get('nonce')!,
        challenge: authorization.searchParams.get('code_challenge')!, ...(index ? { refreshToken: null } : {}),
      })
      const callback = new URL(googleOAuth.redirectUri)
      callback.search = new URLSearchParams({ state: authorization.searchParams.get('state')!, code }).toString()
      const response = await h.api.request(callback.href, { headers: { cookie: handoff.headers.get('set-cookie')!.split(';')[0]! } })
      expect(response.status).toBe(200)
      const connection = await response.json() as Connection
      if (original) {
        expect(connection.id).toBe(original.id)
        expect(connection.sourceIds).toEqual(original.sourceIds)
        expect(connection.generation).toBeGreaterThan(original.generation)
      }
      await h.sync('alice', connection.sourceIds[0]!)
      const page = await h.page('alice', { accountId: connection.sourceIds[0]! })
      expect(page.total).toBe(1)
      const mailbox = (await h.inbox.mailboxes('alice'))[0]!
      if (firstMessage) expect(page.items[0]!.id).toBe(firstMessage.id)
      if (firstMailbox) expect(mailbox.id).toBe(firstMailbox.id)
      expect(box.calls.create.at(-1)!.refreshToken).toBe(h.google.issued[0]!.refreshToken)
      expect(await h.inbox.connections('alice')).toHaveLength(1)
      expect(await h.inbox.accounts('alice')).toHaveLength(1)
      original = connection
      firstMessage ??= page.items[0]!
      firstMailbox ??= mailbox
    }
    expect(h.google.issued[0]!.refreshToken).toBeDefined()
    expect(h.google.issued.slice(1).map(item => item.refreshToken)).toEqual([undefined, undefined])
    await h.restart()
    await h.sync('alice', original!.sourceIds[0]!)
    expect(box.calls.create.at(-1)!.refreshToken).toBe(h.google.issued[0]!.refreshToken)
    expect(box.calls.create.at(-1)!.accessToken).toBe(h.google.issued.at(-1)!.accessToken)
    expect((await h.page()).items.map(item => item.id)).toEqual([firstMessage!.id])
  })

  test('forged signatures, wrong nonce or token audience/issuer, expired tokens, and unverified email never create a connection', async () => {
    const h = await fixture({ googleOAuth })
    h.boxes.set('invalid-google', referenceMailbox('invalid-google', 'invalid-google@example.test', []))
    const invalidTokens: Array<{ name: string; claims?: Record<string, unknown>; forged?: boolean }> = [
      { name: 'forged-signature', forged: true }, { name: 'wrong-nonce', claims: { nonce: 'different-browser-nonce' } },
      { name: 'expired-token', claims: { exp: Math.floor(h.clock.value / 1000) - 3600 } },
      { name: 'other-issuer', claims: { iss: 'https://attacker.example.test' } },
      { name: 'other-audience', claims: { aud: 'another-client.apps.googleusercontent.com' } },
      { name: 'unverified-email', claims: { email_verified: false } },
    ]
    for (const invalidToken of invalidTokens) {
      const attempt = await h.json<OAuthAttempt>('alice', '/connections/google/start', {}, 'POST')
      const handoff = await h.api.request(attempt.authorizeUrl!)
      expect(handoff.status).toBe(302)
      const authorization = new URL(handoff.headers.get('location')!)
      h.google.codes.set(invalidToken.name, {
        mailbox: 'invalid-google', subject: 'untrusted-subject', nonce: authorization.searchParams.get('nonce')!,
        challenge: authorization.searchParams.get('code_challenge')!, claims: invalidToken.claims, forged: invalidToken.forged,
      })
      const callback = new URL(googleOAuth.redirectUri)
      callback.search = new URLSearchParams({ state: authorization.searchParams.get('state')!, code: invalidToken.name }).toString()
      const error = await invalid(await h.api.request(callback.href, { headers: { cookie: handoff.headers.get('set-cookie')!.split(';')[0]! } }), 400)
      expect(JSON.parse(error)).toMatchObject({ code: 'OAUTH_FAILED' })
      expect(error).not.toContain(h.google.issued.at(-1)!.idToken)
      expect((await h.json<OAuthAttempt>('alice', `/connections/google/attempts/${attempt.id}`)).status).toBe('failed')
      expect(await h.inbox.connections('alice')).toEqual([])
      expect(await h.inbox.accounts('alice')).toEqual([])
      expect(await h.inbox.mailboxes('alice')).toEqual([])
    }
    expect(h.google.requests.filter(request => request.url === 'https://oauth2.googleapis.com/token')).toHaveLength(invalidTokens.length)
    expect(h.google.requests.some(request => request.url === 'https://www.googleapis.com/oauth2/v3/certs')).toBe(true)
  })

  test('callback state, per-attempt browser binding, current owner, and authorization-code PKCE binding cannot be substituted', async () => {
    const h = await fixture({ googleOAuth })
    h.boxes.set('bound-google', referenceMailbox('bound-google', 'bound-google@example.test', []))
    let previousCookie = ''
    for (const violation of ['state', 'cookie', 'owner', 'pkce']) {
      const attempt = await h.json<OAuthAttempt>('alice', '/connections/google/start', {}, 'POST')
      const handoff = await h.api.request(attempt.authorizeUrl!)
      expect(handoff.status).toBe(302)
      const cookie = handoff.headers.get('set-cookie')!.split(';')[0]!
      const authorization = new URL(handoff.headers.get('location')!)
      const tokensBefore = h.google.requests.filter(request => request.url === 'https://oauth2.googleapis.com/token').length
      h.google.codes.set(violation, {
        mailbox: 'bound-google', subject: 'bound-subject', nonce: authorization.searchParams.get('nonce')!,
        challenge: violation === 'pkce' ? createHash('sha256').update('a-verifier-from-another-authorization').digest('base64url') : authorization.searchParams.get('code_challenge')!,
      })
      const callback = new URL(googleOAuth.redirectUri)
      callback.search = new URLSearchParams({ state: violation === 'state' ? 'Z'.repeat(43) : authorization.searchParams.get('state')!, code: violation }).toString()
      await invalid(await h.api.request(callback.href, { headers: {
        cookie: violation === 'cookie' ? previousCookie : cookie,
        ...(violation === 'owner' ? { authorization: 'Bearer bob' } : {}),
      } }), 400)
      expect(h.google.requests.filter(request => request.url === 'https://oauth2.googleapis.com/token')).toHaveLength(tokensBefore + Number(violation === 'pkce'))
      expect(await h.inbox.connections('alice')).toEqual([])
      expect(await h.inbox.connections('bob')).toEqual([])
      previousCookie = cookie
    }
    expect(h.google.issued).toEqual([])
  })

  test('OAuth handoff and callback capabilities are one-use across races and restart, and expired attempts never exchange a code', async () => {
    const h = await fixture({ googleOAuth })
    h.boxes.set('oauth-replay', referenceMailbox('oauth-replay', 'oauth-replay@example.test', []))
    const attempt = await h.json<OAuthAttempt>('alice', '/connections/google/start', {}, 'POST')
    const wrongTicket = new URL(attempt.authorizeUrl!)
    wrongTicket.searchParams.set('ticket', 'X'.repeat(43))
    await invalid(await h.api.request(wrongTicket.href), 400)
    const handoff = await h.api.request(attempt.authorizeUrl!)
    expect(handoff.status).toBe(302)
    const authorization = new URL(handoff.headers.get('location')!)
    const cookie = handoff.headers.get('set-cookie')!.split(';')[0]!
    h.google.codes.set('one-use-code', {
      mailbox: 'oauth-replay', subject: 'one-use-subject', nonce: authorization.searchParams.get('nonce')!,
      challenge: authorization.searchParams.get('code_challenge')!,
    })
    const callback = new URL(googleOAuth.redirectUri)
    callback.search = new URLSearchParams({ state: authorization.searchParams.get('state')!, code: 'one-use-code' }).toString()
    const raced = await Promise.all([
      h.api.request(callback.href, { headers: { cookie } }), h.api.request(callback.href, { headers: { cookie } }),
    ])
    expect(raced.map(response => response.status).sort()).toEqual([200, 400])
    expect(await h.inbox.connections('alice')).toHaveLength(1)
    expect(h.google.requests.filter(request => request.url === 'https://oauth2.googleapis.com/token')).toHaveLength(1)
    await h.restart()
    await invalid(await h.api.request(attempt.authorizeUrl!), 400)
    await invalid(await h.api.request(callback.href, { headers: { cookie } }), 400)
    const expiredHandoff = await h.json<OAuthAttempt>('alice', '/connections/google/start', {}, 'POST')
    h.clock.value = Date.parse(expiredHandoff.expiresAt) + 1
    await invalid(await h.api.request(expiredHandoff.authorizeUrl!), 400)
    expect((await h.json<OAuthAttempt>('alice', `/connections/google/attempts/${expiredHandoff.id}`)).status).toBe('failed')
    const expiredCallback = await h.json<OAuthAttempt>('alice', '/connections/google/start', {}, 'POST')
    const lateHandoff = await h.api.request(expiredCallback.authorizeUrl!)
    expect(lateHandoff.status).toBe(302)
    const lateAuthorization = new URL(lateHandoff.headers.get('location')!)
    h.google.codes.set('late-code', {
      mailbox: 'oauth-replay', subject: 'late-subject', nonce: lateAuthorization.searchParams.get('nonce')!,
      challenge: lateAuthorization.searchParams.get('code_challenge')!,
    })
    const lateCallback = new URL(googleOAuth.redirectUri)
    lateCallback.search = new URLSearchParams({ state: lateAuthorization.searchParams.get('state')!, code: 'late-code' }).toString()
    h.clock.value = Date.parse(expiredCallback.expiresAt) + 1
    await invalid(await h.api.request(lateCallback.href, { headers: { cookie: lateHandoff.headers.get('set-cookie')!.split(';')[0]! } }), 400)
    expect((await h.json<OAuthAttempt>('alice', `/connections/google/attempts/${expiredCallback.id}`)).status).toBe('failed')
    expect(h.google.requests.filter(request => request.url === 'https://oauth2.googleapis.com/token')).toHaveLength(1)
    expect(await h.inbox.connections('alice')).toHaveLength(1)
  })

  test('a mounted API authenticates private and unknown paths before access while its explicit health GET remains public', async () => {
    const h = await fixture()
    const { account, box } = await h.seed('alice', 'mounted-owner')
    const mounted = new Hono().route('/pilot', h.api)
    const health = await mounted.request('/pilot/health')
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ ok: true })
    expect(health.headers.get('cache-control')).toBe('no-store')
    expect(health.headers.get('x-content-type-options')).toBe('nosniff')
    const before = box.calls.sync.length
    for (const [method, path] of [
      ['GET', '/pilot/v1/connections'], ['GET', '/pilot/v1/mailboxes'], ['GET', `/pilot/v1/accounts/${account.id}`],
      ['POST', `/pilot/v1/accounts/${account.id}/sync`], ['GET', '/pilot/unknown'], ['GET', '/pilot/v1/unknown'],
    ]) {
      await invalid(await mounted.request(path!, {
        method, headers: { 'content-type': 'application/json', 'x-owner-id': 'alice' }, ...(method === 'POST' ? { body: '{}' } : {}),
      }), 401)
    }
    expect(box.calls.sync.length).toBe(before)
    const owned = await mounted.request('/pilot/v1/connections', { headers: { authorization: 'Bearer alice' } })
    expect(owned.status).toBe(200)
    expect((await owned.json() as Connection[]).map(item => item.id)).toEqual([account.connectionId!])
    await invalid(await mounted.request(`/pilot/v1/accounts/${account.id}`, { headers: { authorization: 'Bearer bob' } }), 404)
    await invalid(await mounted.request('/pilot/unknown', { headers: { authorization: 'Bearer alice' } }), 404)
  })

  test('HEAD and non-GET OAuth routes cannot consume capabilities, and a mounted callback preserves its full registered URI', async () => {
    const configured = { ...googleOAuth, redirectUri: 'https://inbox.example.test/pilot/v1/oauth/google/callback' }
    const h = await fixture({ googleOAuth: configured })
    h.boxes.set('prefixed-google', referenceMailbox('prefixed-google', 'prefixed-google@example.test', []))
    const mounted = new Hono().route('/pilot', h.api)
    const started = await mounted.request('https://inbox.example.test/pilot/v1/connections/google/start', {
      method: 'POST', headers: { authorization: 'Bearer alice', 'content-type': 'application/json' }, body: '{}',
    })
    expect(started.status).toBe(200)
    const attempt = await started.json() as OAuthAttempt
    expect(new URL(attempt.authorizeUrl!).pathname).toBe(`/pilot/v1/oauth/google/authorize/${attempt.id}`)
    for (const method of ['HEAD', 'POST']) await invalid(await mounted.request(attempt.authorizeUrl!, { method }), 401)
    const handoff = await mounted.request(attempt.authorizeUrl!)
    expect(handoff.status).toBe(302)
    const authorization = new URL(handoff.headers.get('location')!)
    expect(authorization.searchParams.get('redirect_uri')).toBe(configured.redirectUri)
    expect(handoff.headers.get('set-cookie')).toContain('Path=/pilot/v1/oauth/google/callback')
    h.google.codes.set('prefixed-code', {
      mailbox: 'prefixed-google', subject: 'prefixed-subject', nonce: authorization.searchParams.get('nonce')!,
      challenge: authorization.searchParams.get('code_challenge')!,
    })
    const callback = new URL(configured.redirectUri)
    callback.search = new URLSearchParams({ state: authorization.searchParams.get('state')!, code: 'prefixed-code' }).toString()
    const cookie = handoff.headers.get('set-cookie')!.split(';')[0]!
    for (const method of ['HEAD', 'POST']) await invalid(await mounted.request(callback.href, { method, headers: { cookie } }), 401)
    expect(h.google.requests).toEqual([])
    const completed = await mounted.request(callback.href, { headers: { cookie } })
    expect(completed.status).toBe(200)
    const connection = await completed.json() as Connection
    expect(connection.identity?.subject).toBe('prefixed-subject')
    expect((await h.inbox.connections('alice')).map(item => item.id)).toEqual([connection.id])
    expect(await h.inbox.connections('bob')).toEqual([])
  })
})

describe('pilot safety contract: legacy migration and revoked OAuth grants', () => {
  test('legacy source credentials migrate to an owner-bound connection without changing cached message or blob identities', async () => {
    const h = await fixture()
    const attachment: Attachment = { id: 'legacy-native-blob', filename: 'legacy.bin', contentType: 'application/octet-stream', size: 4, url: 'https://upstream.invalid/legacy' }
    const bytes = new Uint8Array([0, 127, 128, 255])
    const { account, box } = await h.connect('alice', 'legacy-source-migration', [native('legacy-native-message', {
      bodyText: BODY_SECRET, bodyHtml: '<p>Preserved legacy body</p>', isRead: true, attachments: [attachment],
    })])
    box.attachment('legacy-native-message', attachment, bytes)
    await h.sync('alice', account.id)
    const { connectionId: previousConnectionId, ...legacySource } = await h.inbox.account('alice', account.id)
    const message = await h.inbox.message('alice', (await h.page()).items[0]!.id)
    const blob = message.attachments[0]!
    expect((await h.inbox.download('alice', blob.id)).content).toEqual(bytes)
    const { createCredentialCrypto } = await import('../server/crypto')
    const credentials = { mailbox: box.key, accessToken: SECRET, refreshToken: `${SECRET}-legacy-refresh` }
    const encrypted = createCredentialCrypto({ NODE_ENV: 'production', CREDENTIAL_ENCRYPTION_KEY: KEY })
      .encryptCredential(JSON.stringify(credentials), 'alice', legacySource.id)
    await h.inbox.close()
    const legacy = new Database(h.database)
    try {
      legacy.exec('PRAGMA foreign_keys = ON')
      // Restore pre-pilot ownership storage without touching the persisted mail or blob rows.
      legacy.transaction(() => {
        legacy.query('DELETE FROM sdk_memberships WHERE owner=? AND source=?').run('alice', legacySource.id)
        legacy.query('DELETE FROM sdk_delivery_evidence WHERE owner=? AND source=?').run('alice', legacySource.id)
        legacy.query('DELETE FROM sdk_mailboxes WHERE owner=? AND source=?').run('alice', legacySource.id)
        legacy.query('DELETE FROM sdk_source_connections WHERE owner=? AND source=?').run('alice', legacySource.id)
        legacy.query('DELETE FROM sdk_connections WHERE owner=? AND id=?').run('alice', previousConnectionId!)
        legacy.query("DELETE FROM sdk_meta WHERE key='connection-pilot-schema'").run()
        legacy.query('UPDATE sdk_accounts SET data=?,credentials=? WHERE owner=? AND id=?')
          .run(JSON.stringify(legacySource), encrypted, 'alice', legacySource.id)
      }).immediate()
      expect(legacy.query('SELECT 1 FROM sdk_source_connections WHERE source=?').get(legacySource.id)).toBeNull()
      expect(legacy.query<{ credentials: string }, [string]>('SELECT credentials FROM sdk_accounts WHERE id=?').get(legacySource.id)?.credentials).toBe(encrypted)
    } finally { legacy.close() }
    await h.restart()
    const connection = (await h.json<Connection[]>('alice', '/connections'))[0]!
    expect(connection).toMatchObject({ id: legacySource.id, sourceIds: [legacySource.id], status: 'connected', identity: null })
    expect(await h.inbox.connections('alice')).toHaveLength(1)
    expect(await h.inbox.account('alice', legacySource.id)).toEqual({ ...legacySource, connectionId: connection.id })
    const migrated = new Database(h.database, { readonly: true })
    try {
      expect(migrated.query<{ owner: string; credentials: string }, [string]>('SELECT owner,credentials FROM sdk_connections WHERE id=?').get(connection.id))
        .toEqual({ owner: 'alice', credentials: encrypted })
      expect(migrated.query<{ credentials: string }, [string]>('SELECT credentials FROM sdk_accounts WHERE id=?').get(legacySource.id)?.credentials).toBe('')
      expect(migrated.query<{ connection: string }, [string, string]>('SELECT connection FROM sdk_source_connections WHERE owner=? AND source=?').all('alice', legacySource.id))
        .toEqual([{ connection: connection.id }])
    } finally { migrated.close() }
    expect(await h.inbox.message('alice', message.id)).toEqual(message)
    expect(await h.inbox.download('alice', blob.id)).toEqual({ info: blob, content: bytes })
    const mailbox = (await h.inbox.mailboxes('alice'))[0]!
    expect(mailbox).toMatchObject({ sourceId: legacySource.id, connectionId: connection.id, selector: { kind: 'all' } })
    expect((await h.inbox.mailboxMessage('alice', mailbox.id, message.id)).attachments).toEqual([blob])
    const creates = box.calls.create.length
    await h.sync('alice', legacySource.id)
    expect(box.calls.create).toHaveLength(creates + 1)
    expect(box.calls.create.at(-1)).toMatchObject({ ...credentials, accountId: legacySource.id, userId: 'alice' })
    expect(box.calls.attachment).toHaveLength(1)
    await invalid(await h.request('bob', `/connections/${connection.id}`), 404)
    await invalid(await h.request('bob', `/messages/${message.id}`), 404)
    await invalid(await h.request('bob', `/blobs/${blob.id}`), 404)
    await h.restart()
    expect((await h.inbox.connections('alice')).map(item => item.id)).toEqual([connection.id])
    expect((await h.page()).items.map(item => item.id)).toEqual([message.id])
    expect((await h.inbox.download('alice', blob.id)).content).toEqual(bytes)
  })

  test('disconnecting a verified Google grant fences an already-started reconnect callback and its queued provider work', async () => {
    const googleOAuth = {
      clientId: 'pilot-client.apps.googleusercontent.com', clientSecret: `${SECRET}-google-client`,
      redirectUri: 'https://inbox.example.test/v1/oauth/google/callback',
    }
    const h = await fixture({ googleOAuth })
    const box = referenceMailbox('revoked-google', 'revoked-google@example.test', [native('retained-google-message')])
    h.boxes.set(box.key, box)
    const initial = await h.json<OAuthAttempt>('alice', '/connections/google/start', {}, 'POST')
    const firstHandoff = await h.api.request(initial.authorizeUrl!)
    expect(firstHandoff.status).toBe(302)
    const firstAuthorization = new URL(firstHandoff.headers.get('location')!)
    h.google.codes.set('before-revocation', {
      mailbox: box.key, subject: 'verified-revoked-subject', nonce: firstAuthorization.searchParams.get('nonce')!,
      challenge: firstAuthorization.searchParams.get('code_challenge')!,
    })
    const firstCallback = new URL(googleOAuth.redirectUri)
    firstCallback.search = new URLSearchParams({ state: firstAuthorization.searchParams.get('state')!, code: 'before-revocation' }).toString()
    const firstResponse = await h.api.request(firstCallback.href, { headers: { cookie: firstHandoff.headers.get('set-cookie')!.split(';')[0]! } })
    expect(firstResponse.status).toBe(200)
    const connection = await firstResponse.json() as Connection
    expect(connection.identity).toMatchObject({ issuer: 'https://accounts.google.com', subject: 'verified-revoked-subject' })
    const sourceId = connection.sourceIds[0]!
    await h.sync('alice', sourceId)
    const message = (await h.page()).items[0]!
    const pending = await h.mutate('alice', [message.id], { isRead: true }, 'revoked-google-write')
    expect(pending.status).toBe('pending')
    const attempt = await h.json<OAuthAttempt>('alice', '/connections/google/start', { connectionId: connection.id }, 'POST')
    const handoff = await h.api.request(attempt.authorizeUrl!)
    expect(handoff.status).toBe(302)
    const authorization = new URL(handoff.headers.get('location')!)
    const cookie = handoff.headers.get('set-cookie')!.split(';')[0]!
    h.google.codes.set('stale-reconnect', {
      mailbox: box.key, subject: 'verified-revoked-subject', nonce: authorization.searchParams.get('nonce')!,
      challenge: authorization.searchParams.get('code_challenge')!, refreshToken: `${SECRET}-must-not-install`,
    })
    const disconnected = await h.request('alice', `/connections/${connection.id}`, { method: 'DELETE' })
    expect(disconnected.status).toBe(204)
    const revoked = await h.inbox.connection('alice', connection.id)
    const revokedSource = await h.inbox.account('alice', sourceId)
    expect(revoked.status).toBe('disconnected')
    expect(revoked.generation).toBeGreaterThan(connection.generation)
    expect(revokedSource.status).toBe('disconnected')
    expect((await h.inbox.operation('alice', pending.id)).status).toBe('cancelled')
    const calls = { create: box.calls.create.length, account: box.calls.getAccount, sync: box.calls.sync.length }
    await h.restart()
    const callback = new URL(googleOAuth.redirectUri)
    callback.search = new URLSearchParams({ state: authorization.searchParams.get('state')!, code: 'stale-reconnect' }).toString()
    const error = await invalid(await h.api.request(callback.href, { headers: { cookie } }), 400)
    expect(JSON.parse(error)).toMatchObject({ code: 'OAUTH_FAILED' })
    expect((await h.json<OAuthAttempt>('alice', `/connections/google/attempts/${attempt.id}`)).status).toBe('failed')
    expect(await h.inbox.connection('alice', connection.id)).toEqual(revoked)
    expect(await h.inbox.account('alice', sourceId)).toEqual(revokedSource)
    expect((await h.inbox.connections('alice')).map(item => item.id)).toEqual([connection.id])
    await h.inbox.runDue()
    await h.inbox.poll()
    expect(box.calls.create).toHaveLength(calls.create)
    expect(box.calls.getAccount).toBe(calls.account)
    expect(box.calls.sync).toHaveLength(calls.sync)
    expect(box.calls.send).toEqual([])
    expect(box.calls.mutate).toEqual([])
    expect((await h.inbox.operation('alice', pending.id)).status).toBe('cancelled')
    expect((await h.page()).items.map(item => item.id)).toEqual([message.id])
  })

  test('an untargeted Google link cannot overwrite a grant disconnected and reauthorized after the link was created', async () => {
    const googleOAuth = { clientId: 'pilot-client.apps.googleusercontent.com', clientSecret: `${SECRET}-google-client`, redirectUri: 'https://inbox.example.test/v1/oauth/google/callback' }
    const h = await fixture({ googleOAuth })
    const box = referenceMailbox('generic-google-fence', 'generic-google@example.test', [native('retained')])
    h.boxes.set(box.key, box)
    const begin = async (code: string, connectionId?: string) => {
      const attempt = await h.json<OAuthAttempt>('alice', '/connections/google/start', connectionId ? { connectionId } : {}, 'POST')
      const handoff = await h.api.request(attempt.authorizeUrl!)
      expect(handoff.status).toBe(302)
      const authorization = new URL(handoff.headers.get('location')!)
      h.google.codes.set(code, { mailbox: box.key, subject: 'generic-google-subject', nonce: authorization.searchParams.get('nonce')!, challenge: authorization.searchParams.get('code_challenge')! })
      const callback = new URL(googleOAuth.redirectUri)
      callback.search = new URLSearchParams({ state: authorization.searchParams.get('state')!, code }).toString()
      return { attempt, complete: () => h.api.request(callback.href, { headers: { cookie: handoff.headers.get('set-cookie')!.split(';')[0]! } }) }
    }
    const initial = await begin('generic-first')
    const first = await initial.complete()
    expect(first.status).toBe(200)
    const connection = await first.json() as Connection
    const stale = await begin('generic-stale')
    await h.inbox.disconnectConnection('alice', connection.id)
    const fresh = await begin('explicit-after-revocation', connection.id)
    const renewed = await fresh.complete()
    expect(renewed.status).toBe(200)
    const current = await renewed.json() as Connection
    expect(current.generation).toBeGreaterThan(connection.generation)
    const creations = box.calls.create.length
    const token = box.calls.create.at(-1)!.accessToken
    await invalid(await stale.complete(), 400)
    expect(await h.inbox.connection('alice', connection.id)).toEqual(current)
    expect(box.calls.create).toHaveLength(creations)
    expect(box.calls.create.at(-1)!.accessToken).toBe(token)
    expect((await h.oauth.attempt('alice', stale.attempt.id)).status).toBe('failed')
    expect(box.calls.send).toEqual([])
    expect(box.calls.mutate).toEqual([])
  })

  test('unverified API-key stores cannot be rebound by matching empty emails or injected account IDs', async () => {
    const original = referenceMailbox('original-key-store', '', [native('same-native-id', { bodyText: 'Original account body' })])
    const replacement = referenceMailbox('replacement-key-store', '', [native('same-native-id', { bodyText: 'Other account body' })])
    const provider: ProviderDefinition = { id: 'unverified-key-store', name: 'Key store', credentialReconnect: false,
      create: credentials => (credentials.apiKey === 'original' ? original : replacement).adapter(credentials, 'unverified-key-store', fullCapabilities) }
    const h = await fixture({ providers: [provider] })
    const source = await h.inbox.connect('alice', { providerId: provider.id, credentials: { apiKey: 'original' } })
    await h.inbox.sync('alice', source.id)
    const message = (await h.inbox.messages('alice', { accountId: source.id })).items[0]!
    const connection = await h.inbox.connection('alice', source.connectionId!)
    await expect(h.inbox.reconnect('alice', source.id, { apiKey: 'replacement', accountId: source.id, email: '' }))
      .rejects.toMatchObject({ code: 'SOURCE_IDENTITY_UNVERIFIED', status: 409 })
    expect(replacement.calls.create).toEqual([])
    expect(await h.inbox.connection('alice', connection.id)).toEqual(connection)
    expect(await h.inbox.message('alice', message.id)).toMatchObject({ bodyText: 'Original account body' })
    const other = await h.inbox.createConnection('alice', { providerId: provider.id, credentials: { apiKey: 'replacement' } })
    expect(other.id).not.toBe(connection.id)
    await h.inbox.sync('alice', other.sourceIds[0]!)
    const copied = (await h.inbox.messages('alice', { accountId: other.sourceIds[0]! })).items[0]!
    expect(copied.id).not.toBe(message.id)
    expect(await h.inbox.message('alice', copied.id)).toMatchObject({ bodyText: 'Other account body' })
    expect(await h.inbox.message('alice', message.id)).toMatchObject({ bodyText: 'Original account body' })
  })

  test('OAuth reauthorization preserves a refresh token rotated while the new mailbox identity is being verified', async () => {
    const googleOAuth = { clientId: 'pilot-client.apps.googleusercontent.com', clientSecret: `${SECRET}-google-client`, redirectUri: 'https://inbox.example.test/v1/oauth/google/callback' }
    const box = referenceMailbox('refresh-race', 'refresh-race@example.test', [native('retained')])
    const entered = deferred<void>()
    const release = deferred<void>()
    let block = false
    const provider: ProviderDefinition = { id: 'gmail', name: 'Google', create(credentials) {
      const inner = box.adapter(credentials, 'gmail', fullCapabilities)
      return { ...inner, async getAccount() {
        if (block) { entered.resolve(); await release.promise }
        return inner.getAccount()
      } }
    } }
    const h = await fixture({ googleOAuth, providers: [provider] })
    h.boxes.set(box.key, box)
    const authorize = async (code: string, connectionId?: string) => {
      const attempt = await h.json<OAuthAttempt>('alice', '/connections/google/start', connectionId ? { connectionId } : {}, 'POST')
      const handoff = await h.api.request(attempt.authorizeUrl!)
      expect(handoff.status).toBe(302)
      const authorization = new URL(handoff.headers.get('location')!)
      h.google.codes.set(code, { mailbox: box.key, subject: 'refresh-race-subject', nonce: authorization.searchParams.get('nonce')!, challenge: authorization.searchParams.get('code_challenge')!, ...(connectionId ? { refreshToken: null } : {}) })
      const callback = new URL(googleOAuth.redirectUri)
      callback.search = new URLSearchParams({ state: authorization.searchParams.get('state')!, code }).toString()
      return () => h.api.request(callback.href, { headers: { cookie: handoff.headers.get('set-cookie')!.split(';')[0]! } })
    }
    const firstResponse = await (await authorize('refresh-race-first'))()
    expect(firstResponse.status).toBe(200)
    const connection = await firstResponse.json() as Connection
    const callback = await authorize('refresh-race-second', connection.id)
    block = true
    const completing = h.pending(Promise.resolve(callback()))
    try {
      await bounded(entered.promise, 'new OAuth mailbox verification')
      const { createCredentialCrypto } = await import('../server/crypto')
      const crypto = createCredentialCrypto({ NODE_ENV: 'production', CREDENTIAL_ENCRYPTION_KEY: KEY })
      const database = new Database(h.database)
      try {
        const row = database.query<{ credentials: string }, [string, string]>('SELECT credentials FROM sdk_connections WHERE owner=? AND id=?').get('alice', connection.id)!
        const credentials = JSON.parse(crypto.decryptCredential(row.credentials, 'alice', connection.id))
        credentials.refreshToken = 'rotated-during-oauth-verification'
        database.query('UPDATE sdk_connections SET credentials=?,credential_version=credential_version+1 WHERE owner=? AND id=?')
          .run(crypto.encryptCredential(JSON.stringify(credentials), 'alice', connection.id), 'alice', connection.id)
      } finally { database.close() }
    } finally { block = false; release.resolve() }
    const completed = await bounded(completing, 'OAuth completion after refresh rotation')
    expect(completed.status).toBe(200)
    expect((await completed.json() as Connection).id).toBe(connection.id)
    await h.restart()
    await h.inbox.sync('alice', connection.sourceIds[0]!)
    expect(box.calls.create.at(-1)!.refreshToken).toBe('rotated-during-oauth-verification')
    expect(box.calls.send).toEqual([])
  })
})

test('close drains an in-flight foreground refresh and preserves rotated credentials and source identity across restart', async () => {
  const box = referenceMailbox('foreground-refresh', 'foreground-refresh@example.test', [])
  const entered = deferred<void>()
  const release = deferred<void>()
  const refreshTokens: unknown[] = []
  const initial = {
    accessToken: SECRET, refreshToken: `${SECRET}-before-close`,
    expiresAt: new Date(EPOCH + 120_000).toISOString(),
  }
  const rotated = {
    accessToken: `${SECRET}-rotated-access`, refreshToken: `${SECRET}-rotated-refresh`,
    expiresAt: new Date(EPOCH + 3_600_000).toISOString(),
  }
  const h = await fixture({ allowProviderWrites: false, providers: [{
    id: 'gmail', name: 'Foreground refresh', connection: 'oauth',
    create: credentials => box.adapter(credentials, 'gmail', fullCapabilities),
    async refresh(credentials) {
      refreshTokens.push(credentials.refreshToken)
      entered.resolve()
      await release.promise
      return rotated
    },
  }] })
  const source = await h.inbox.connect('alice', { providerId: 'gmail', credentials: initial })
  const connection = await h.inbox.connection('alice', source.connectionId!)
  h.clock.value = EPOCH + 60_000
  const foreground = h.pending(h.inbox.folders('alice', source.id))
  let closing: Promise<void> | undefined
  let closeFinished = false
  try {
    await bounded(entered.promise, 'foreground refresh before shutdown')
    expect(refreshTokens).toEqual([initial.refreshToken])
    expect(box.calls.listFolders).toBe(0)
    closing = h.pending(h.inbox.close().then(() => { closeFinished = true }))
    // Let shutdown progress while the token response remains gated.
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(closeFinished).toBe(false)
  } finally {
    release.resolve()
    // The foreground read may be cancelled; the refresh must still commit.
    await bounded(Promise.allSettled([foreground, ...(closing ? [closing] : [])]), 'foreground refresh and shutdown settlement')
  }
  await closing
  await h.restart()
  expect(await h.inbox.connection('alice', connection.id)).toEqual(connection)
  expect(await h.inbox.account('alice', source.id)).toMatchObject({
    id: source.id, connectionId: connection.id, generation: source.generation, status: 'connected',
  })
  await bounded(h.inbox.folders('alice', source.id), 'foreground read after refresh restart')
  expect(refreshTokens).toEqual([initial.refreshToken])
  expect(box.calls.create.at(-1)).toMatchObject({ ...rotated, accountId: source.id, userId: 'alice' })
  expect(box.calls.listFolders).toBeGreaterThan(0)
  expect(box.calls.sync).toEqual([])
  expect(box.calls.send).toEqual([])
  expect(box.calls.mutate).toEqual([])
  expect(box.calls.createFolder).toEqual([])
})

test('refresh-hook rate limits persist Retry-After cooldown and sync problems across restart', async () => {
  const box = referenceMailbox('refresh-cooldown', 'refresh-cooldown@example.test', [])
  const refreshTokens: unknown[] = []
  const retryAfter = 120
  const initial = {
    accessToken: SECRET, refreshToken: `${SECRET}-rate-limited-refresh`,
    expiresAt: new Date(EPOCH + 120_000).toISOString(),
  }
  const rotated = {
    accessToken: `${SECRET}-after-cooldown`, refreshToken: `${SECRET}-after-cooldown-refresh`,
    expiresAt: new Date(EPOCH + 3_600_000).toISOString(),
  }
  const h = await fixture({ allowProviderWrites: false, providers: [{
    id: 'gmail', name: 'Refresh cooldown', connection: 'oauth',
    create: credentials => box.adapter(credentials, 'gmail', fullCapabilities),
    async refresh(credentials) {
      refreshTokens.push(credentials.refreshToken)
      if (refreshTokens.length === 1) throw new ProviderRateLimitError('gmail', 'Synthetic token endpoint rate limit', { retryAfter })
      return rotated
    },
  }] })
  const source = await h.inbox.connect('alice', { providerId: 'gmail', credentials: initial })
  h.clock.value = EPOCH + 60_000
  const retryAt = h.clock.value + retryAfter * 1000
  await expect(h.inbox.sync('alice', source.id)).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429, retryable: true })
  expect(refreshTokens).toEqual([initial.refreshToken])
  expect(await h.inbox.account('alice', source.id)).toMatchObject({
    status: 'connected', sync: { lastSyncAt: null, problem: 'RATE_LIMITED' },
  })
  await h.inbox.poll()
  await expect(h.inbox.sync('alice', source.id)).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429, retryable: true })
  expect(refreshTokens).toEqual([initial.refreshToken])
  expect(box.calls.sync).toEqual([])
  await h.restart()
  expect(await h.inbox.account('alice', source.id)).toMatchObject({
    id: source.id, connectionId: source.connectionId, status: 'connected',
    sync: { lastSyncAt: null, problem: 'RATE_LIMITED' },
  })
  h.clock.value = retryAt - 1
  await h.inbox.poll()
  await expect(h.inbox.sync('alice', source.id)).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429, retryable: true })
  expect(refreshTokens).toEqual([initial.refreshToken])
  expect(box.calls.sync).toEqual([])
  h.clock.value = retryAt
  await h.inbox.poll()
  expect(refreshTokens).toEqual([initial.refreshToken, initial.refreshToken])
  expect(box.calls.create.at(-1)).toMatchObject({ ...rotated, accountId: source.id, userId: 'alice' })
  expect(box.calls.sync).toHaveLength(1)
  expect(await h.inbox.account('alice', source.id)).toMatchObject({
    status: 'connected', sync: { lastSyncAt: new Date(retryAt).toISOString(), problem: null },
  })
  expect(box.calls.send).toEqual([])
  expect(box.calls.mutate).toEqual([])
  expect(box.calls.createFolder).toEqual([])
})

test('Gmail rotating attachment handles preserve public IDs across reset syncs and restart and keep legacy downloads readable', async () => {
  const { GmailProvider } = await import('../server/sdk/gmail')
  const bytes = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55, 10, 0, 127, 128, 255])
  const filename = 'r\u00e9sum\u00e9-\u8cc7\u6599.pdf'
  const contentType = 'application/pdf'
  const nativeMessageId = 'gmail-rotating-attachment-message'
  const nativeThreadId = 'gmail-rotating-attachment-thread'
  const issuedHandles: string[] = []
  const downloadedHandles: string[] = []
  const requests: Array<{ method: string; path: string }> = []
  const h = await fixture({
    allowProviderWrites: false,
    providers: [{
      id: 'gmail', name: 'Gmail', connection: 'oauth',
      create: credentials => new GmailProvider({ ...credentials, accessToken: String(credentials.accessToken) }),
    }],
    fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      requests.push({ method: request.method, path: url.pathname })
      if (request.method !== 'GET' || url.origin !== 'https://gmail.googleapis.com') {
        throw new Error(`Provider writes and live network are forbidden: ${request.method} ${request.url}`)
      }
      const base = '/gmail/v1/users/me'
      if (url.pathname === `${base}/profile`) return Response.json({
        emailAddress: 'rotating-attachments@example.test', historyId: '100', messagesTotal: 1, threadsTotal: 1,
      })
      if (url.pathname === `${base}/labels/INBOX`) return Response.json({
        id: 'INBOX', name: 'INBOX', type: 'system', messagesUnread: 1, messagesTotal: 1,
      })
      if (url.pathname === `${base}/messages`) return Response.json({
        messages: [{ id: nativeMessageId, threadId: nativeThreadId }], resultSizeEstimate: 1,
      })
      if (url.pathname === `${base}/messages/${nativeMessageId}`) {
        const handle = `opaque-attachment-handle-${issuedHandles.length + 1}`
        issuedHandles.push(handle)
        return Response.json({
          id: nativeMessageId, threadId: nativeThreadId, labelIds: ['INBOX', 'UNREAD'],
          historyId: '100', internalDate: String(EPOCH), snippet: 'Synthetic rotating attachment',
          payload: {
            partId: '', mimeType: 'multipart/mixed',
            headers: [
              { name: 'From', value: 'Sender <sender@example.test>' },
              { name: 'To', value: 'rotating-attachments@example.test' },
              { name: 'Subject', value: 'Synthetic rotating attachment' },
            ],
            parts: [{
              partId: '0', mimeType: 'text/plain',
              body: { data: Buffer.from('Attachment body').toString('base64url'), size: 15 },
            }, {
              partId: '1', mimeType: contentType, filename,
              headers: [{ name: 'Content-Type', value: contentType }, { name: 'Content-Disposition', value: 'attachment' }],
              body: { attachmentId: handle, size: bytes.byteLength },
            }],
          },
        })
      }
      const attachmentPath = `${base}/messages/${nativeMessageId}/attachments/`
      if (url.pathname.startsWith(attachmentPath)) {
        const handle = decodeURIComponent(url.pathname.slice(attachmentPath.length))
        downloadedHandles.push(handle)
        if (!issuedHandles.includes(handle)) return Response.json({ error: { code: 404, message: 'Unknown synthetic attachment handle' } }, { status: 404 })
        return Response.json({ data: Buffer.from(bytes).toString('base64url'), size: bytes.byteLength })
      }
      throw new Error(`Unexpected synthetic Gmail request: ${request.method} ${request.url}`)
    }) as typeof fetch,
  })
  const source = await h.inbox.connect('alice', {
    providerId: 'gmail', credentials: { accessToken: SECRET, scopes: ['https://www.googleapis.com/auth/gmail.readonly'] },
  })
  const connection = await h.inbox.connection('alice', source.connectionId!)
  await h.sync('alice', source.id, { reset: true })
  const firstPage = await h.page('alice', { accountId: source.id })
  expect(firstPage.total).toBe(1)
  const message = await h.json<Message>('alice', `/messages/${firstPage.items[0]!.id}`)
  expect(message.attachments).toHaveLength(1)
  const blob = message.attachments[0]!
  expect(blob).toMatchObject({ accountId: source.id, filename, contentType, size: bytes.byteLength })
  const legacyHandle = issuedHandles[0]!
  for (let pass = 0; pass < 2; pass++) {
    if (pass === 1) await h.restart()
    const previousGets = issuedHandles.length
    await h.sync('alice', source.id, { reset: true })
    expect(issuedHandles.length).toBeGreaterThan(previousGets)
    const page = await h.page('alice', { accountId: source.id })
    expect(page.total).toBe(1)
    expect(page.items.map(item => item.id)).toEqual([message.id])
    const current = await h.json<Message>('alice', `/messages/${message.id}`)
    expect(current.accountId).toBe(source.id)
    expect(current.attachments).toEqual([blob])
    expect(await h.inbox.connection('alice', connection.id)).toEqual(connection)
  }
  const wire = transport(h)
  const client = createInboxClient({ baseUrl: 'http://inbox.test', fetch: wire.fetch, headers: { authorization: 'Bearer alice' }, cacheScope: 'gmail-rotating-attachments' })
  const beforeDownloadGets = issuedHandles.length
  expect(await client.download(blob.id)).toEqual({ info: blob, content: bytes })
  expect(issuedHandles.length).toBeGreaterThan(beforeDownloadGets)
  expect(downloadedHandles).toEqual([issuedHandles.at(-1)!])
  expect(legacyHandle).not.toBe(issuedHandles.at(-1))
  await h.inbox.close()
  const database = new Database(h.database)
  try {
    expect(database.query<{ cached: number }, [string]>('SELECT content IS NOT NULL AS cached FROM sdk_blobs WHERE id=?').get(blob.id)).toEqual({ cached: 1 })
    // Reproduce a persisted legacy row without letting cached bytes bypass its raw handle.
    const changed = database.query('UPDATE sdk_blobs SET attachment_id=?,content=NULL WHERE id=? AND owner=? AND account=? AND message_id=?')
      .run(legacyHandle, blob.id, 'alice', source.id, message.id)
    expect(changed.changes).toBe(1)
    expect(database.query<{ attachment_id: string; uncached: number }, [string]>('SELECT attachment_id,content IS NULL AS uncached FROM sdk_blobs WHERE id=?').get(blob.id))
      .toEqual({ attachment_id: legacyHandle, uncached: 1 })
  } finally { database.close() }
  await h.restart()
  const beforeLegacyDownloads = downloadedHandles.length
  const response = await h.request('alice', `/blobs/${blob.id}`)
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe(contentType)
  expect(response.headers.get('content-disposition')).toContain(encodeURIComponent(filename))
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
  expect(downloadedHandles.slice(beforeLegacyDownloads)).toEqual([legacyHandle])
  expect(await client.download(blob.id)).toEqual({ info: blob, content: bytes })
  expect((await h.inbox.accounts('alice')).map(account => account.id)).toEqual([source.id])
  expect(await h.inbox.connections('alice')).toEqual([connection])
  expect((await h.page('alice', { accountId: source.id })).items.map(item => item.id)).toEqual([message.id])
  expect((await h.json<Message>('alice', `/messages/${message.id}`)).attachments).toEqual([blob])
  expect(requests.filter(request => request.method !== 'GET')).toEqual([])
})

test('accepted non-ISO snooze dates wake both mailbox-local and source-local state without provider writes', async () => {
  const h = await fixture({ allowProviderWrites: false })
  const { account, box } = await h.connect('alice', 'snooze-date-formats', [
    native('membership-clock'), native('source-clock'),
  ])
  await h.inbox.sync('alice', account.id)
  const mailbox = (await h.inbox.mailboxes('alice')).find(value => value.sourceId === account.id)!
  const messages = (await h.inbox.messages('alice', { accountId: account.id })).items
  const local = messages.find(message => message.subject === 'Subject membership-clock')!
  const legacy = messages.find(message => message.subject === 'Subject source-clock')!
  const initial = await h.inbox.mailboxMessage('alice', mailbox.id, local.id)
  const deadline = EPOCH + 5_000
  const inputDate = new Date(deadline).toUTCString()
  const membership = initial.memberships.find(value => value.mailboxId === mailbox.id)!
  await h.inbox.setMailboxState('alice', mailbox.id, local.id, { snoozedUntil: inputDate }, membership.revision)
  const input = { messageIds: [legacy.id], changes: { snoozedUntil: inputDate }, idempotencyKey: 'non-iso-snooze' }
  const operation = await h.inbox.mutate('alice', input)
  await h.inbox.runDue()
  expect(input.changes.snoozedUntil).toBe(inputDate)
  expect((await h.inbox.mutate('alice', structuredClone(input))).id).toBe(operation.id)
  expect(Date.parse((await h.inbox.message('alice', legacy.id)).snoozedUntil!)).toBe(deadline)
  h.clock.value = deadline - 1
  await h.inbox.runDue()
  expect((await h.inbox.mailboxMessage('alice', mailbox.id, local.id)).memberships[0]!.snoozedUntil).not.toBeNull()
  expect((await h.inbox.message('alice', legacy.id)).snoozedUntil).not.toBeNull()
  h.clock.value = deadline
  await h.inbox.runDue()
  const awake = await h.inbox.mailboxMessage('alice', mailbox.id, local.id)
  expect(awake.memberships.find(value => value.mailboxId === mailbox.id)!.snoozedUntil).toBeNull()
  expect((await h.inbox.message('alice', legacy.id)).snoozedUntil).toBeNull()
  expect(awake.isRead).toBe(initial.isRead)
  expect(awake.folder).toBe(initial.folder)
  expect(box.calls.mutate).toEqual([])
  expect(box.calls.send).toEqual([])
})

describe('provider-neutral host credential contract', () => {
  test('API-token and API-key credentials replace through versioned HTTP without changing cached identities', async () => {
    for (const field of ['accessToken', 'apiKey'] as const) {
      const box = referenceMailbox(`generic-${field}`, `${field}@example.test`, [native('stable-native-id')])
      const id = `custom-${field}`
      const h = await fixture({ allowProviderWrites: false, providers: [{ id, name: id,
        create(credentials) {
          if (typeof credentials[field] !== 'string' || !credentials[field]) throw new ProviderError(id, 'VALIDATION', 'Credential is required')
          return box.adapter(credentials, id, fullCapabilities)
        },
      }] })
      const wire = transport(h)
      const client = createInboxClient({ baseUrl: 'https://app.example.test', fetch: wire.fetch, headers: { authorization: 'Bearer alice' } })
      const connection = await client.createConnection({ providerId: id, credentials: { [field]: SECRET, region: 'opaque-provider-config' } })
      const sourceId = connection.sourceIds[0]!
      await client.sync(sourceId)
      const original = (await client.messages({ accountId: sourceId })).items[0]!
      const mailbox = (await client.mailboxes()).find(value => value.sourceId === sourceId)!
      const state = await client.credentialState(connection.id)
      expect(state).toEqual({ connectionId: connection.id, generation: 1, version: 1, status: 'connected' })
      expect(JSON.stringify(state)).not.toContain(SECRET)
      const path = `/connections/${connection.id}/credentials`
      const tag = await etag(h, 'alice', path)
      const creates = box.calls.create.length
      await invalid(await h.request(null, path), 401)
      await invalid(await h.request('bob', path), 404)
      await invalid(await h.request('bob', path, { method: 'PUT', headers: { 'content-type': 'application/json', 'if-match': tag }, body: JSON.stringify({ credentials: { [field]: 'foreign' } }) }), 404)
      await invalid(await h.request('alice', path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credentials: { [field]: 'missing-precondition' } }) }), 428)
      expect(box.calls.create).toHaveLength(creates)
      const credentials = { [field]: `${SECRET}-replacement`, region: 'opaque-provider-config' }
      const updated = await client.updateCredentials(connection.id, credentials, state.version)
      expect(updated).toEqual({ connectionId: connection.id, generation: 2, version: 2, status: 'connected' })
      expect(wire.requests.some(request => request.method === 'PUT' && request.path === `/v1${path}` && request.headers.has('if-match'))).toBe(true)
      await invalid(await h.request('alice', path, { method: 'PUT', headers: { 'content-type': 'application/json', 'if-match': tag }, body: JSON.stringify({ credentials: { [field]: 'stale' } }) }), 412)
      await client.sync(sourceId)
      expect(box.calls.create.at(-1)).toMatchObject({ ...credentials, accountId: sourceId, userId: 'alice' })
      expect((await client.messages({ accountId: sourceId })).items.map(value => value.id)).toEqual([original.id])
      expect((await client.mailboxes()).map(value => value.id)).toContain(mailbox.id)
      expect((await client.account(sourceId)).generation).toBe(1)
      await h.restart()
      expect(await client.credentialState(connection.id)).toEqual(updated)
      await client.sync(sourceId)
      expect(box.calls.create.at(-1)).toMatchObject(credentials)
      expect((await client.message(original.id)).id).toBe(original.id)
      await client.disconnectConnection(connection.id)
      await expect(client.updateCredentials(connection.id, credentials, updated.version)).rejects.toMatchObject({ code: 'CONNECTION_DISCONNECTED', status: 409 })
      expect((await client.connection(connection.id)).status).toBe('disconnected')
      expect(box.calls.send).toEqual([])
      expect(box.calls.mutate).toEqual([])
    }
  })

  test('opaque store keys require host verification and cannot rebind a source by matching blank emails', async () => {
    const box = referenceMailbox('opaque-store', '', [native('retained')])
    let approved = false
    const verifications: Array<{ owner: string; connectionId: string; reason: string }> = []
    const h = await fixture({ providers: [{ id: 'opaque-store', name: 'Opaque store', credentialReconnect: false,
      create: credentials => box.adapter(credentials, 'opaque-store', fullCapabilities),
    }], verifyCredentials: context => {
      verifications.push({ owner: context.owner, connectionId: context.connection.id, reason: context.reason })
      return approved && context.owner === 'alice' && context.credentials.apiKey === `${SECRET}-verified`
    } })
    const connection = await h.inbox.createConnection('alice', { providerId: 'opaque-store', credentials: { apiKey: SECRET } })
    const before = box.calls.create.length
    await expect(h.inbox.updateCredentials('alice', connection.id, { apiKey: `${SECRET}-verified` }, 1))
      .rejects.toMatchObject({ code: 'SOURCE_IDENTITY_UNVERIFIED', status: 409 })
    expect(box.calls.create).toHaveLength(before)
    expect((await h.inbox.credentialState('alice', connection.id)).version).toBe(1)
    approved = true
    expect(await h.inbox.updateCredentials('alice', connection.id, { apiKey: `${SECRET}-verified` }, 1)).toMatchObject({ version: 2 })
    expect(verifications).toEqual([
      { owner: 'alice', connectionId: connection.id, reason: 'update' },
      { owner: 'alice', connectionId: connection.id, reason: 'update' },
    ])
    expect((await h.inbox.connection('alice', connection.id)).sourceIds).toEqual(connection.sourceIds)
    await expect(h.inbox.updateCredentials('bob', connection.id, { apiKey: SECRET }, 2)).rejects.toMatchObject({ status: 404 })
    expect(verifications).toHaveLength(2)
  })

  test('temporary host resolver failures preserve usable cache and recover without reconnect or source replacement', async () => {
    let phase: 'ready' | 'unavailable' | 'revoked' = 'ready'
    let accessToken = SECRET
    const resolutions: Array<{ owner: string; id: string; reason: string }> = []
    const h = await fixture({ allowProviderWrites: false, resolveCredentials: async context => {
      resolutions.push({ owner: context.owner, id: context.connection.id, reason: context.reason })
      if (phase === 'unavailable') throw new Error(`${SECRET} ${BODY_SECRET}`)
      if (phase === 'revoked') throw new CredentialError('revoked', `${SECRET} ${BODY_SECRET}`)
      return { ...context.credentials, accessToken }
    } })
    const { account, box } = await h.seed('alice', 'host-resolver', [native('cached')])
    const message = (await h.page()).items[0]!
    const baseline = resolutions.length
    await h.inbox.message('alice', message.id)
    await h.inbox.messages('alice')
    expect(resolutions).toHaveLength(baseline)
    phase = 'unavailable'
    await expect(h.inbox.sync('alice', account.id)).rejects.toMatchObject({ code: 'CREDENTIALS_UNAVAILABLE', status: 503, retryable: true })
    expect((await h.inbox.connection('alice', account.connectionId!)).status).toBe('connected')
    expect((await h.inbox.account('alice', account.id)).sync.problem).toBe('CREDENTIALS_UNAVAILABLE')
    expect((await h.inbox.message('alice', message.id)).id).toBe(message.id)
    expect(JSON.stringify(h.logs)).not.toContain(SECRET)
    await h.restart()
    phase = 'ready'; accessToken = `${SECRET}-host-renewed`
    await h.inbox.sync('alice', account.id)
    expect(box.calls.create.at(-1)).toMatchObject({ accessToken, accountId: account.id })
    expect(await h.inbox.credentialState('alice', account.connectionId!)).toMatchObject({ version: 2, generation: 1, status: 'connected' })
    expect((await h.inbox.account('alice', account.id)).sync.problem).toBeNull()
    expect((await h.page()).items.map(item => item.id)).toEqual([message.id])
    phase = 'revoked'
    await expect(h.inbox.sync('alice', account.id)).rejects.toMatchObject({ code: 'CREDENTIALS_REVOKED' })
    expect((await h.inbox.connection('alice', account.connectionId!)).status).toBe('reconnect_required')
    expect((await h.inbox.message('alice', message.id)).id).toBe(message.id)
    phase = 'ready'; accessToken = `${SECRET}-explicitly-restored`
    await h.inbox.updateCredentials('alice', account.connectionId!, { mailbox: box.key, accessToken }, 2)
    await h.inbox.sync('alice', account.id)
    expect((await h.inbox.connection('alice', account.connectionId!)).status).toBe('connected')
    expect((await h.inbox.account('alice', account.id)).generation).toBe(account.generation)
    expect(resolutions.every(value => value.owner === 'alice' && value.id === account.connectionId)).toBe(true)
    const count = resolutions.length
    await h.inbox.disconnectConnection('alice', account.connectionId!)
    await expect(h.inbox.sync('alice', account.id)).rejects.toBeDefined()
    expect(resolutions).toHaveLength(count)
    expect(box.calls.send).toEqual([])
    expect(box.calls.mutate).toEqual([])
  })

  test('expired directly supplied credentials require a host update, not an OAuth implementation in the platform', async () => {
    const h = await fixture()
    const box = referenceMailbox('expired-direct', 'expired-direct@example.test', [native('same')])
    h.boxes.set(box.key, box)
    const connection = await h.inbox.createConnection('alice', { providerId: FULL,
      credentials: { mailbox: box.key, accessToken: SECRET, expiresAt: new Date(EPOCH + 120_000).toISOString() } })
    h.clock.value = EPOCH + 60_000
    await h.inbox.sync('alice', connection.sourceIds[0]!)
    expect(box.calls.sync).toHaveLength(1)
    h.clock.value = EPOCH + 120_000
    await expect(h.inbox.sync('alice', connection.sourceIds[0]!)).rejects.toMatchObject({ code: 'CREDENTIALS_UNAVAILABLE', retryable: true })
    expect(box.calls.sync).toHaveLength(1)
    expect((await h.inbox.connection('alice', connection.id)).status).toBe('connected')
    await h.inbox.updateCredentials('alice', connection.id, { mailbox: box.key, accessToken: `${SECRET}-pushed`, expiresAt: new Date(EPOCH + 3_600_000).toISOString() }, 1)
    await h.inbox.sync('alice', connection.sourceIds[0]!)
    expect(box.calls.sync).toHaveLength(2)
    const core = createInboxApi({ inbox: h.inbox, authenticate: () => ({ id: 'alice' }) })
    expect((await core.request('/v1/connections/google/start', { method: 'POST' })).status).toBe(404)
    expect((await core.request('/v1/oauth/google/callback?state=anything')).status).toBe(404)
    const spec = await (await core.request('/v1/openapi.json')).json()
    expect(spec.paths['/v1/connections/{id}/credentials'].put).toBeDefined()
    expect(spec.paths['/v1/oauth/google/callback']).toBeUndefined()
  })

  test('provider rejection requests fresh host credentials once instead of treating an expired token as revoked consent', async () => {
    const reasons: string[] = []
    const h = await fixture({ resolveCredentials: async context => {
      reasons.push(context.reason)
      return { ...context.credentials, ...(context.reason === 'rejected' ? { accessToken: `${SECRET}-after-rejection` } : {}) }
    } })
    const { account, box } = await h.connect('alice', 'rejected-token', [native('same')])
    box.nextSync(new ProviderAuthenticationError(FULL, 'Expired access token'))
    await h.inbox.sync('alice', account.id)
    expect(reasons.filter(reason => reason === 'rejected')).toHaveLength(1)
    expect(box.calls.sync).toHaveLength(2)
    expect(box.calls.create.at(-1)).toMatchObject({ accessToken: `${SECRET}-after-rejection` })
    expect((await h.inbox.connection('alice', account.connectionId!)).status).toBe('connected')
  })

  test('a late resolver result cannot overwrite credentials pushed by the host while it was pending', async () => {
    const entered = deferred<void>(), release = deferred<Record<string, unknown>>()
    let block = false
    const h = await fixture({ resolveCredentials: async context => {
      if (block) { entered.resolve(); return release.promise }
      return { ...context.credentials }
    } })
    const { account, box } = await h.seed('alice', 'resolver-fence', [native('same')])
    const message = (await h.page()).items[0]!
    block = true
    const pending = h.pending(h.inbox.sync('alice', account.id))
    try {
      await bounded(entered.promise, 'host resolver before credential replacement')
      await h.inbox.updateCredentials('alice', account.connectionId!, { mailbox: box.key, accessToken: `${SECRET}-host-winner` }, 1)
    } finally { block = false; release.resolve({ mailbox: box.key, accessToken: `${SECRET}-stale-resolver` }) }
    await expect(pending).rejects.toBeDefined()
    expect(await h.inbox.credentialState('alice', account.connectionId!)).toMatchObject({ version: 2, generation: 2, status: 'connected' })
    await h.restart()
    await h.inbox.sync('alice', account.id)
    expect(box.calls.create.at(-1)).toMatchObject({ accessToken: `${SECRET}-host-winner` })
    expect((await h.page()).items.map(item => item.id)).toEqual([message.id])
  })

  test('credential replacement cancels and fences a late old-token sync without changing source identity', async () => {
    const h = await fixture()
    const { account, box } = await h.seed('alice', 'credential-sync-fence', [native('same', { bodyText: 'Current cached body' })])
    const message = (await h.page()).items[0]!
    const release = deferred<SyncResult>()
    box.nextSync(() => release.promise)
    const pending = h.pending(h.inbox.sync('alice', account.id))
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(box.calls.sync).toHaveLength(2)
      await h.inbox.updateCredentials('alice', account.connectionId!, { mailbox: box.key, accessToken: `${SECRET}-new-authority` }, 1)
    } finally { release.resolve(receipt([native('same', { bodyText: 'Stale response must not win' })], 'stale')) }
    await expect(pending).rejects.toBeDefined()
    expect(await h.inbox.message('alice', message.id)).toMatchObject({ id: message.id, accountId: account.id, bodyText: 'Current cached body' })
    expect((await h.inbox.account('alice', account.id)).generation).toBe(account.generation)
    await h.inbox.sync('alice', account.id)
    expect(box.calls.create.at(-1)).toMatchObject({ accessToken: `${SECRET}-new-authority`, accountId: account.id })
  })

  test('verified identities are host assertions, not credential-update JSON supplied by a caller', async () => {
    const box = referenceMailbox('host-bound-identity', '', [native('retained')])
    let verified = false
    const h = await fixture({ providers: [{ id: 'host-bound-store', name: 'Host-bound store', credentialReconnect: false,
      create: credentials => box.adapter(credentials, 'host-bound-store', fullCapabilities),
    }], verifyCredentials: context => verified && context.owner === 'alice' && context.credentials.apiKey === 'approved-replacement' })
    const identity = { issuer: 'host-credential-store', subject: 'immutable-store-1', registrationId: 'host-app' }
    const connection = await h.inbox.createConnection('alice', { providerId: 'host-bound-store', credentials: { apiKey: 'original' } }, identity)
    const path = `/connections/${connection.id}/credentials`
    const tag = await etag(h, 'alice', path)
    await invalid(await h.request('alice', path, { method: 'PUT', headers: { 'content-type': 'application/json', 'if-match': tag },
      body: JSON.stringify({ credentials: { apiKey: 'approved-replacement' }, identity }) }), 400)
    await invalid(await h.request('alice', path, { method: 'PUT', headers: { 'content-type': 'application/json', 'if-match': tag },
      body: JSON.stringify({ credentials: { apiKey: 'approved-replacement', identity } }) }), 409)
    expect((await h.inbox.credentialState('alice', connection.id)).version).toBe(1)
    verified = true
    await h.json('alice', path, { credentials: { apiKey: 'approved-replacement' } }, 'PUT', 200, { 'if-match': tag })
    expect((await h.inbox.connection('alice', connection.id)).identity).toEqual(identity)
    expect((await h.inbox.connection('alice', connection.id)).sourceIds).toEqual(connection.sourceIds)
    expect((await h.inbox.credentialState('alice', connection.id)).version).toBe(2)
  })

  test('the example host can recover missing OAuth settings without poisoning an existing SDK connection', async () => {
    const { createGoogleCredentialRefresh } = await import('../server/credential-refresh')
    const box = referenceMailbox('host-config-recovery', 'host-config@example.test', [])
    let config: GoogleOAuthConfig | undefined
    let exchanges = 0
    const fetcher = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(String(input)).toBe('https://oauth2.googleapis.com/token')
      exchanges++
      const body = new URLSearchParams(String(init?.body))
      expect(body.get('client_id')).toBe('host-registration')
      expect(body.get('client_secret')).toBe(`${SECRET}-host-client`)
      return Response.json({ access_token: `${SECRET}-renewed`, token_type: 'Bearer', expires_in: 3600 })
    }) as typeof fetch
    const h = await fixture({ providers: [{ id: 'gmail', name: 'Host Google example',
      create: credentials => box.adapter(credentials, 'gmail', fullCapabilities),
      refresh: (credentials, signal, context) => createGoogleCredentialRefresh(config, fetcher, () => h.clock.value)!(credentials, signal, context),
    }] })
    const connection = await h.inbox.createConnection('alice', { providerId: 'gmail', credentials: {
      accessToken: SECRET, refreshToken: `${SECRET}-refresh`, expiresAt: new Date(EPOCH + 120_000).toISOString(),
    } }, { issuer: 'https://accounts.google.com', subject: 'host-user', registrationId: 'host-registration' })
    h.clock.value = EPOCH + 60_000
    await expect(h.inbox.sync('alice', connection.sourceIds[0]!)).rejects.toMatchObject({ code: 'CREDENTIALS_UNAVAILABLE', retryable: true })
    expect(exchanges).toBe(0)
    expect((await h.inbox.connection('alice', connection.id)).status).toBe('connected')
    config = { clientId: 'wrong-registration', clientSecret: `${SECRET}-host-client`, redirectUri: 'https://host.example.test/v1/oauth/google/callback' }
    await expect(h.inbox.sync('alice', connection.sourceIds[0]!)).rejects.toMatchObject({ code: 'CREDENTIALS_UNAVAILABLE', retryable: true })
    expect(exchanges).toBe(0)
    config.clientId = 'host-registration'
    await h.inbox.sync('alice', connection.sourceIds[0]!)
    expect(exchanges).toBe(1)
    expect(await h.inbox.credentialState('alice', connection.id)).toMatchObject({ status: 'connected', version: 2, generation: 1 })
    expect((await h.inbox.connection('alice', connection.id)).sourceIds).toEqual(connection.sourceIds)
    expect(box.calls.create.at(-1)).toMatchObject({ accessToken: `${SECRET}-renewed`, refreshToken: `${SECRET}-refresh` })
    expect(JSON.stringify(h.logs)).not.toContain(SECRET)
  })

  test('automatic credential refresh drains an already-dispatched send instead of cancelling it', async () => {
    const box = referenceMailbox('refresh-during-send', 'refresh-send@example.test', [])
    const h = await fixture({ providers: [{ id: 'refresh-during-send', name: 'Refresh during send',
      create: credentials => box.adapter(credentials, 'refresh-during-send', fullCapabilities),
      refresh: async () => ({ accessToken: `${SECRET}-renewed`, expiresAt: new Date(EPOCH + 3_600_000).toISOString() }),
    }] })
    const source = await h.inbox.connect('alice', { providerId: 'refresh-during-send', credentials: {
      accessToken: SECRET, expiresAt: new Date(EPOCH + 120_000).toISOString(),
    } })
    await h.inbox.setPolicy('alice', { undoSendSeconds: 0 })
    const draft = await h.inbox.createDraft('alice', { accountId: source.id, from: box.email,
      to: [participant('recipient@example.test')], subject: 'Refresh during send', bodyText: 'Body' })
    const operation = await h.inbox.submit('alice', draft.id, { revision: draft.revision, idempotencyKey: 'refresh-during-send' })
    const barrier = h.gate<SendResult>({ id: 'native-accepted' })
    box.nextSend(barrier.wait)
    const running = h.pending(h.inbox.runDue())
    try {
      await bounded(barrier.entered, 'send entered before automatic refresh')
      h.clock.value = EPOCH + 60_000
      await h.inbox.sync('alice', source.id)
      expect((await h.inbox.credentialState('alice', source.connectionId!)).version).toBe(2)
      expect((await h.inbox.operation('alice', operation.id)).status).toBe('processing')
      expect(box.calls.disconnect).toBe(0)
    } finally { barrier.release() }
    await bounded(running, 'original send after automatic refresh')
    expect((await h.inbox.operation('alice', operation.id)).status).toBe('succeeded')
    expect(box.calls.send).toHaveLength(1)
    expect(box.calls.disconnect).toBe(1)
    await h.inbox.close()
    expect(box.calls.disconnect).toBe(2)
  })

  test('a provider still being created cannot escape retirement after another request resolves newer credentials', async () => {
    const box = referenceMailbox('pending-provider-creation', 'pending-create@example.test', [])
    const entered = deferred<void>(), release = deferred<void>()
    let block = false
    let accessToken = SECRET
    const h = await fixture({ resolveCredentials: async context => ({ ...context.credentials, accessToken }), providers: [{
      id: 'pending-provider-creation', name: 'Pending creation',
      async create(credentials) {
        if (block && credentials.accessToken === SECRET) { entered.resolve(); await release.promise }
        return box.adapter(credentials, 'pending-provider-creation', fullCapabilities)
      },
    }] })
    const source = await h.inbox.connect('alice', { providerId: 'pending-provider-creation', credentials: { accessToken: SECRET } })
    await h.restart()
    block = true
    const stale = h.pending(h.inbox.folders('alice', source.id))
    try {
      await bounded(entered.promise, 'old provider creation')
      accessToken = `${SECRET}-replacement`
      await h.inbox.sync('alice', source.id)
    } finally { block = false; release.resolve() }
    await expect(stale).rejects.toMatchObject({ code: 'CREDENTIALS_CHANGED', status: 409, retryable: true })
    expect((await h.inbox.account('alice', source.id)).sync.problem).toBeNull()
    await h.inbox.disconnectConnection('alice', source.connectionId!)
    expect(box.calls.disconnect).toBe(box.calls.create.length)
  })

  test('a host refresh may return only a fresh opaque token without retaining the previous token expiry', async () => {
    const box = referenceMailbox('token-only-refresh', 'token-only@example.test', [])
    let calls = 0
    const h = await fixture({ providers: [{ id: 'token-only-refresh', name: 'Opaque token refresh',
      create: credentials => box.adapter(credentials, 'token-only-refresh', fullCapabilities),
      refresh: async () => { calls++; return { accessToken: `${SECRET}-fresh` } },
    }] })
    const connection = await h.inbox.createConnection('alice', { providerId: 'token-only-refresh', credentials: {
      accessToken: SECRET, refreshToken: 'host-owned-reference', expiresAt: new Date(EPOCH + 10_000).toISOString(),
    } })
    h.clock.value = EPOCH + 10_000
    await h.inbox.sync('alice', connection.sourceIds[0]!)
    await h.inbox.sync('alice', connection.sourceIds[0]!)
    expect(calls).toBe(1)
    expect(box.calls.create.at(-1)).toMatchObject({ accessToken: `${SECRET}-fresh`, refreshToken: 'host-owned-reference' })
    expect(box.calls.create.at(-1)).not.toHaveProperty('expiresAt')
    expect(await h.inbox.credentialState('alice', connection.id)).toMatchObject({ status: 'connected', version: 2, generation: 1 })
  })
})

describe('authenticated message media', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRzQAAAAASUVORK5CYII=', 'base64')
  const source = `https://images.example.test/photo.png?signature=${SECRET}&variant=2`
  const html = `<img src="${source}" width="200" height="100">`
  const response = () => new Response(png, { headers: { 'content-type': 'image/png', 'cache-control': 'max-age=3600' } })
  const network = (request: MediaNetwork['request'] = async () => response()): MediaNetwork => ({ resolve: async () => ['93.184.216.34'], request })
  const resources = (message: Message) => [...new Set([message.bodyHtml, message.bodyDocument?.html ?? '', message.bodyDocument?.styles ?? '']
    .flatMap(value => [...value.matchAll(/\/v1\/messages\/[^/\s"<>]+\/media\/[A-Za-z\d_-]{43}/g)].map(match => match[0].slice(3))))]

  test('rewrites image and background output, serves exact controlled bytes lazily, and preserves original mail, links and CIDs', async () => {
    const urls = [source, 'https://images.example.test/hero.png', 'https://images.example.test/body.png',
      'https://images.example.test/table.png', 'https://images.example.test/cell.png', 'https://images.example.test/heading.png']
    const requested: string[] = []
    const h = await fixture({ defaultPolicy: { remoteImages: true }, media: { network: network(async target => { requested.push(target.url); return response() }) } })
    const inline: Attachment = { id: 'inline-native-part', filename: 'inline.png', contentType: 'image/png', size: png.length,
      url: `https://provider.example.test/private?token=${SECRET}`, inline: true, contentId: 'verified@example.test' }
    const original = `<html><head><style>
      .hero { background: #123456 url("${urls[1]}") center / cover no-repeat; }
      .tiny { width:1px; height:1px; background-image:url("https://images.example.test/hidden.png"); }
      </style></head><body background="${urls[2]}">
      <table background="${urls[3]}"><tr><th background="${urls[5]}">Heading</th><td class="hero" background="${urls[4]}">Content</td></tr></table>
      <div style="background-image:url('${urls[1]}')">Same artwork</div><span class="tiny"></span>
      <img src="${source}" width="200" height="100" data-openmail-src="https://evil.example.test/alternate.png" data-inbox-tracking="true">
      <img src="https://images.example.test/pixel" width="1" height="1"><img src="https://awstrack.me/asset.png" width="200">
      <img src="cid:verified@example.test"><img src="cid:missing-native-mapping"><img src="data:image/png;base64,${png.toString('base64')}">
      <a href="https://clicked.example.test/page">Clicked link</a></body></html>`
    const { account, box } = await h.connect('alice', 'media-content', [native('original', { bodyHtml: original, attachments: [inline] })])
    box.attachment('original', inline, png)
    await h.sync('alice', account.id)
    const id = (await h.page()).items[0]!.id
    const database = new Database(h.database, { readonly: true })
    try {
      const before = database.query('SELECT * FROM sdk_messages WHERE id=?').get(id)
      const events = await h.inbox.changes('alice')
      const initial = await h.request('alice', `/messages/${id}`)
      const tag = initial.headers.get('etag')
      const message = await initial.json() as Message
      const paths = resources(message)
      expect(paths).toHaveLength(urls.length)
      expect(requested).toEqual([])
      expect(message.bodyHtml).toContain('href="https://clicked.example.test/page"')
      expect(message.bodyHtml).toContain(`/v1/blobs/${message.attachments[0]!.id}`)
      expect(message.bodyDocument!.html).toContain('cid:missing-native-mapping')
      expect(message.bodyDocument!.html).toContain('src="data:image/png;base64,')
      expect(message.bodyDocument!.styles).toContain('#123456')
      expect(message.bodyDocument!.styles).not.toContain('hidden.png')
      expect(message.bodyDocument!.html).not.toContain('evil.example.test')
      expect(message.bodyDocument!.html).not.toContain('awstrack.me')
      expect(message.bodyDocument!.html).not.toContain(SECRET)
      expect(message.bodyHtml).toContain(paths[0])
      for (const path of paths) {
        const image = await h.request('alice', path)
        expect(image.status).toBe(200)
        expect(image.headers.get('content-type')).toBe('image/png')
        expect(new Uint8Array(await image.arrayBuffer())).toEqual(new Uint8Array(png))
      }
      expect([...requested].sort()).toEqual([...urls].sort())
      expect((await h.request('alice', `/messages/${id}`, { headers: { 'if-none-match': tag! } })).status).toBe(304)
      expect(resources(await h.inbox.mailboxMessage('alice', account.id, id))).toEqual(paths)
      expect(database.query('SELECT * FROM sdk_messages WHERE id=?').get(id)).toEqual(before)
      expect((await h.inbox.changes('alice', { since: events.state })).events).toEqual([])
      expect(box.calls.mutate).toEqual([])
      expect(box.calls.getMessage).toEqual([])
      expect(box.calls.attachment).toEqual([])
      expect(JSON.stringify(h.logs)).not.toContain(SECRET)
      expect(JSON.stringify(h.logs)).not.toContain('https:')
    } finally { database.close() }
  })

  test('authorizes opaque references before network, cache and validators, without forwarding caller headers', async () => {
    const requests: Parameters<MediaNetwork['request']>[0][] = []
    const h = await fixture({ defaultPolicy: { remoteImages: true }, media: { network: network(async target => { requests.push(target); return response() }) } })
    await h.seed('alice', 'media-auth', [native('a', { bodyHtml: html }), native('b', { bodyHtml: html })])
    await h.seed('bob', 'media-other-owner', [native('c', { bodyHtml: html })])
    const [a, b] = (await h.page()).items
    const first = await h.inbox.message('alice', a!.id)
    const path = resources(first)[0]!
    const otherPath = resources(await h.inbox.message('alice', b!.id))[0]!
    expect(path).not.toBe(otherPath)
    await invalid(await h.request(null, path, { headers: { 'if-none-match': '*' } }), 401)
    await invalid(await h.request('bob', path), 404)
    await invalid(await h.request('alice', path.replace(a!.id, b!.id)), 404)
    await invalid(await h.request('alice', `/messages/${a!.id}/media/${'A'.repeat(43)}`), 404)
    await invalid(await h.request('alice', `${path}?url=${encodeURIComponent('http://127.0.0.1/private')}`), 400)
    expect(requests).toHaveLength(0)
    const good = await h.request('alice', path, { headers: { cookie: `session=${SECRET}`, referer: 'https://app.example.test/private',
      'x-provider-token': SECRET, 'user-agent': SECRET, range: 'bytes=0-1', 'if-range': SECRET } })
    expect(good.status).toBe(200)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ url: source, address: '93.184.216.34', family: 4 })
    expect(Object.keys(requests[0]!.headers).sort()).toEqual(['Accept', 'Accept-Encoding'])
    expect(JSON.stringify(requests[0]!.headers)).not.toContain(SECRET)
    expect(good.headers.get('cache-control')).toBe('private, no-cache, must-revalidate')
    expect(good.headers.get('content-security-policy')).toContain("sandbox; default-src 'none'")
    expect(good.headers.get('x-content-type-options')).toBe('nosniff')
    expect(good.headers.get('cross-origin-resource-policy')).toBe('same-origin')
    expect(good.headers.get('referrer-policy')).toBe('no-referrer')
    expect(good.headers.get('set-cookie')).toBeNull()
    const tag = good.headers.get('etag')!
    expect((await h.request('alice', path, { headers: { 'if-none-match': tag } })).status).toBe(304)
    expect((await h.request('alice', path, { method: 'HEAD' })).status).toBe(200)
    const foreign = await h.request('bob', path, { headers: { 'if-none-match': tag } })
    await invalid(foreign, 404)
    expect(foreign.headers.get('etag')).toBeNull()
    expect(requests).toHaveLength(1)
    await h.inbox.setPolicy('alice', { remoteImages: false })
    for (const method of ['GET', 'HEAD']) {
      const blocked = await h.request('alice', path, { method, headers: { 'if-none-match': tag } })
      expect(blocked.status).toBe(403)
      expect(blocked.headers.get('etag')).toBeNull()
      expect(blocked.headers.get('cache-control')).toBe('no-store')
    }
    expect(resources(await h.inbox.message('alice', a!.id))).toEqual([])
    expect(requests).toHaveLength(1)
    await h.inbox.setPolicy('alice', { remoteImages: true })
    expect(resources(await h.inbox.message('alice', a!.id))[0]).toBe(path)
    expect((await h.request('alice', path)).status).toBe(200)
    expect(requests).toHaveLength(2)
  })

  test('an injected legacy fetch without an explicit pinned media network fails closed', async () => {
    let calls = 0
    const h = await fixture({ defaultPolicy: { remoteImages: true }, fetch: Object.assign(async () => { calls++; throw new Error(SECRET) }, { preconnect() { calls++ } }) as typeof fetch })
    await h.seed('alice', 'media-offline', [native('a', { bodyHtml: html })])
    const message = await h.inbox.message('alice', (await h.page()).items[0]!.id)
    expect(calls).toBe(0)
    const result = await h.request('alice', resources(message)[0]!)
    expect(result.status).toBe(503)
    expect(await result.json()).toMatchObject({ code: 'MEDIA_NETWORK_DISABLED' })
    expect(calls).toBe(0)
  })

  test('browser-normalized HTTP schemes cannot bypass proxying, tracker filtering or disabled image policy', async () => {
    const requested: string[] = []
    const h = await fixture({ defaultPolicy: { remoteImages: true }, media: { network: network(async target => { requested.push(target.url); return response() }) } })
    await h.seed('alice', 'media-schemes', [
      native('loose', { bodyHtml: '<img src="https:images.example.test/art.png" width="200">' }),
      native('tiny', { bodyHtml: '<img src="https:images.example.test/tiny.png" width="1">' }),
      native('known', { bodyHtml: '<img src="https:awstrack.me/art.png" width="200">' }),
      native('control', { bodyHtml: '<img src="h&#9;ttps://images.example.test/art.png">' }),
      native('slashes', { bodyHtml: '<img src="\\\\images.example.test/art.png">' }),
      native('relative', { bodyHtml: '<img src="//images.example.test/art.png">' }),
      native('ftp', { bodyHtml: '<img src="ftp://images.example.test/art.png">' }),
      native('data', { bodyHtml: `<img src="data:image/png;base64,${png.toString('base64').slice(0, 20)}\n${png.toString('base64').slice(20)}">` }),
    ])
    const rows = (await h.page()).items
    for (const row of rows) {
      const message = await h.inbox.message('alice', row.id)
      const paths = resources(message)
      if (row.subject === 'Subject loose') {
        expect(paths).toHaveLength(1)
        expect((await h.request('alice', paths[0]!)).status).toBe(200)
      } else expect(paths).toEqual([])
      if (row.subject === 'Subject data') expect(message.bodyDocument!.html).toContain('data:image/png;base64,')
    }
    expect(requested).toEqual(['https://images.example.test/art.png'])
    await h.inbox.setPolicy('alice', { remoteImages: false })
    const blocked = await h.inbox.message('alice', rows.find(row => row.subject === 'Subject loose')!.id)
    expect(resources(blocked)).toEqual([])
    expect(blocked.bodyDocument!.html).not.toMatch(/\ssrc=/)
  })

  test('rejects unsafe URL encodings, ports and credentials before DNS or transport', async () => {
    let dns = 0, requests = 0
    const h = await fixture({ defaultPolicy: { remoteImages: true }, media: { network: {
      resolve: async () => { dns++; return ['93.184.216.34'] }, request: async () => { requests++; return response() },
    } } })
    const bad = ['http://127.1/a.png', 'http://2130706433/a.png', 'http://0x7f000001/a.png', 'http://0177.0.0.1/a.png',
      'http://0.0.0.0/a.png', 'http://169.254.169.254/a.png', 'http://10.1.2.3/a.png', 'http://172.16.0.1/a.png',
      'http://192.168.0.1/a.png', 'http://100.64.0.1/a.png', 'http://198.18.0.1/a.png', 'http://224.0.0.1/a.png',
      'http://[::1]/a.png', 'http://[::ffff:127.0.0.1]/a.png', 'http://[fc00::1]/a.png', 'http://[fe80::1]/a.png',
      'http://[2002:7f00:1::]/a.png', 'http://[2001:db8::1]/a.png', 'http://[3fff::1]/a.png',
      'https://images.example.test:444/a.png', `https://user:${SECRET}@images.example.test/a.png`,
      'https://localhost./a.png', 'https://service.local./a.png', 'https://service.internal/a.png']
    await h.seed('alice', 'media-unsafe', bad.map((url, i) => native(`u-${i}`, { bodyHtml: `<img src="${url}">` })))
    for (const row of (await h.page()).items) {
      const path = resources(await h.inbox.message('alice', row.id))[0]!
      expect(path).toBeDefined()
      const result = await h.request('alice', path)
      expect(result.status).toBe(403)
      expect(await result.json()).toMatchObject({ code: 'MEDIA_DESTINATION_BLOCKED' })
    }
    expect(dns).toBe(0)
    expect(requests).toBe(0)
  })

  test('validates every DNS answer and pins the accepted address instead of resolving it again', async () => {
    const answers: Record<string, string[]> = {
      'mixed.example.test': ['93.184.216.34', '127.0.0.1'], 'local.example.test': ['169.254.169.254'],
      'reserved.example.test': ['192.0.2.1'], 'v6-private.example.test': ['::ffff:8.8.8.8'],
      'valid.example.test': ['2606:4700:4700::1111'],
    }
    const requests: Parameters<MediaNetwork['request']>[0][] = []
    const resolutions: string[] = []
    const h = await fixture({ defaultPolicy: { remoteImages: true }, media: { network: {
      resolve: async host => { resolutions.push(host); return answers[host] ?? [] },
      request: async target => { requests.push(target); answers['valid.example.test'] = ['127.0.0.1']; return response() },
    } } })
    await h.seed('alice', 'media-dns', Object.keys(answers).map(host => native(host, { bodyHtml: `<img src="https://${host}/art.png">` })))
    for (const row of (await h.page()).items) {
      const result = await h.request('alice', resources(await h.inbox.message('alice', row.id))[0]!)
      expect(result.status).toBe(row.subject.includes('valid.example.test') ? 200 : 403)
    }
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ address: '2606:4700:4700::1111', family: 6, url: 'https://valid.example.test/art.png' })
    expect(resolutions.filter(host => host === 'valid.example.test')).toHaveLength(1)
  })

  test('the default transport really connects to its pinned address and retains Host on a controlled socket', async () => {
    const received: Headers[] = []
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) { received.push(request.headers); return response() } })
    cleanup.push(async () => { await server.stop(true) })
    const result = await pinnedMediaNetwork.request({ url: `http://deliberately-unresolvable.invalid:${server.port}/art.png`, address: '127.0.0.1', family: 4,
      headers: { Accept: 'image/png', 'Accept-Encoding': 'identity' } }, AbortSignal.timeout(1500))
    expect(result.status).toBe(200)
    expect(new Uint8Array(await result.arrayBuffer())).toEqual(new Uint8Array(png))
    expect(received).toHaveLength(1)
    expect(received[0]!.get('host')).toBe(`deliberately-unresolvable.invalid:${server.port}`)
    for (const header of ['authorization', 'cookie', 'referer', 'proxy-authorization']) expect(received[0]!.has(header)).toBe(false)
  })

  test('redirects revalidate DNS and destination, never fetch a private/tracker target, and have a finite hop limit', async () => {
    const requests: string[] = [], dns: string[] = []
    let answer = ['93.184.216.34']
    const h = await fixture({ defaultPolicy: { remoteImages: true }, media: { network: {
      resolve: async host => { dns.push(host); return answer },
      request: async target => {
        requests.push(target.url)
        const url = new URL(target.url)
        if (url.pathname === '/private.png') return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/a.png' } })
        if (url.pathname === '/tracking.png') return new Response(null, { status: 307, headers: { location: 'https://awstrack.me/a.png' } })
        if (url.pathname === '/rebind.png') { answer = ['127.0.0.1']; return new Response(null, { status: 302, headers: { location: '/final.png' } }) }
        if (url.pathname === '/loop.png') return new Response(null, { status: 301, headers: { location: '/loop.png' } })
        if (url.pathname === '/valid.png') return new Response(null, { status: 308, headers: { location: 'https://other.example.test/final.png' } })
        return response()
      },
    } } })
    await h.seed('alice', 'media-redirect', ['private', 'tracking', 'rebind', 'loop', 'valid'].map(name => native(name, { bodyHtml: `<img src="https://images.example.test/${name}.png">` })))
    const rows = (await h.page()).items
    for (const [name, expected, count] of [['private', 403, 1], ['tracking', 403, 1], ['rebind', 403, 1], ['loop', 502, 4], ['valid', 200, 2]] as const) {
      answer = ['93.184.216.34']; requests.length = 0; dns.length = 0
      const row = rows.find(row => row.subject === `Subject ${name}`)!
      const result = await h.request('alice', resources(await h.inbox.message('alice', row.id))[0]!)
      expect(result.status).toBe(expected)
      expect(requests).toHaveLength(count)
      expect(requests.some(url => /127\.0\.0\.1|awstrack/.test(url))).toBe(false)
      expect(dns).toHaveLength(name === 'rebind' ? 2 : count)
    }
  })

  test('deduplicates misses, bounds concurrent fetches, persists the cache and evicts/refreshes finite entries', async () => {
    let active = 0, maximum = 0, calls = 0
    const first = deferred<void>(), entered = deferred<void>()
    const h = await fixture({ defaultPolicy: { remoteImages: true }, media: { concurrency: 1, cacheEntries: 3, cacheBytes: png.length * 2, cacheTtlMs: 1000,
      network: network(async () => { calls++; active++; maximum = Math.max(active, maximum); if (calls === 1) { entered.resolve(); await first.promise } active--; return response() }),
    } })
    await h.seed('alice', 'media-cache', ['a', 'b', 'c'].map(name => native(name, { bodyHtml: `<img src="https://images.example.test/${name}.png">` })))
    const paths = await Promise.all((await h.page()).items.map(async row => resources(await h.inbox.message('alice', row.id))[0]!))
    const a = h.pending(Promise.resolve(h.request('alice', paths[0]!)))
    await bounded(entered.promise, 'first media fetch')
    const duplicate = h.pending(Promise.resolve(h.request('alice', paths[0]!))), b = h.pending(Promise.resolve(h.request('alice', paths[1]!)))
    first.resolve()
    expect((await a).status).toBe(200); expect((await duplicate).status).toBe(200); expect((await b).status).toBe(200)
    expect(calls).toBe(2); expect(maximum).toBe(1)
    h.clock.value++
    await h.request('alice', paths[0]!)
    h.clock.value++
    await h.request('alice', paths[2]!)
    expect(calls).toBe(3)
    await h.restart()
    expect((await h.request('alice', paths[0]!)).status).toBe(200)
    expect(calls).toBe(3)
    await h.request('alice', paths[1]!)
    expect(calls).toBe(4)
    const database = new Database(h.database, { readonly: true })
    try { expect(database.query<{ count: number; bytes: number }, []>('SELECT count(*) count,sum(length(content)) bytes FROM sdk_media_cache').get()).toEqual({ count: 2, bytes: png.length * 2 }) }
    finally { database.close() }
    h.clock.value += 1001
    await h.request('alice', paths[1]!)
    expect(calls).toBe(5)
  })

  test('entry limits also bound tiny cached resources independently of the byte budget', async () => {
    let calls = 0
    const h = await fixture({ defaultPolicy: { remoteImages: true }, media: { cacheEntries: 1, cacheBytes: 4096,
      network: network(async () => { calls++; return response() }),
    } })
    await h.seed('alice', 'media-entry-limit', ['a', 'b'].map(name => native(name, { bodyHtml: `<img src="https://images.example.test/${name}.png">` })))
    const paths = await Promise.all((await h.page()).items.map(async row => resources(await h.inbox.message('alice', row.id))[0]!))
    await h.request('alice', paths[0]!); h.clock.value++
    await h.request('alice', paths[1]!); h.clock.value++
    await h.request('alice', paths[0]!)
    expect(calls).toBe(3)
    const db = new Database(h.database, { readonly: true })
    try { expect(db.query<{ count: number }, []>('SELECT count(*) count FROM sdk_media_cache').get()!.count).toBe(1) }
    finally { db.close() }
  })

  test('a recoverable failure is explicit and negatively cached only briefly; upstream no-store is honored', async () => {
    let calls = 0, missing = true
    const h = await fixture({ defaultPolicy: { remoteImages: true }, media: { network: network(async () => {
      calls++
      return missing ? new Response(`<html>${SECRET}</html>`, { status: 404, headers: { 'content-type': 'text/html' } })
        : new Response(png, { headers: { 'content-type': 'image/png', 'cache-control': 'no-store' } })
    }) } })
    await h.seed('alice', 'media-retry', [native('a', { bodyHtml: html })])
    const path = resources(await h.inbox.message('alice', (await h.page()).items[0]!.id))[0]!
    const failed = await h.request('alice', path)
    expect(failed.status).toBe(404)
    expect(await failed.json()).toMatchObject({ code: 'MEDIA_UPSTREAM_404' })
    expect(failed.headers.get('etag')).toBeNull()
    missing = false
    expect((await h.request('alice', path)).status).toBe(404)
    expect(calls).toBe(1)
    h.clock.value += 30_001
    const fresh = await h.request('alice', path)
    expect(fresh.status).toBe(200)
    expect(fresh.headers.get('cache-control')).toBe('no-store')
    expect(fresh.headers.get('etag')).toBeNull()
    expect((await h.request('alice', path)).status).toBe(200)
    expect(calls).toBe(3)
    expect(JSON.stringify(h.logs)).not.toContain(SECRET)
    expect(JSON.stringify(h.logs)).not.toContain('https:')
  })

  test('policy changes and changed original bodies revoke in-flight and cached resources', async () => {
    const pending = deferred<Response>(), entered = deferred<void>()
    let slow = true, aborted = false
    const h = await fixture({ defaultPolicy: { remoteImages: true }, media: { network: network(async (_target, signal) => {
      if (!slow) return response()
      signal.addEventListener('abort', () => { aborted = true }, { once: true })
      entered.resolve(); return pending.promise
    }) } })
    const { account, box } = await h.seed('alice', 'media-revoke', [native('a', { bodyHtml: html })])
    const id = (await h.page()).items[0]!.id, path = resources(await h.inbox.message('alice', id))[0]!
    const loading = h.pending(Promise.resolve(h.request('alice', path)))
    await bounded(entered.promise, 'in-flight media')
    await h.inbox.setPolicy('alice', { remoteImages: false })
    expect((await bounded(loading, 'media revocation')).status).toBe(403)
    expect(aborted).toBe(true)
    pending.resolve(response()); slow = false
    await h.inbox.setPolicy('alice', { remoteImages: true })
    expect((await h.request('alice', path)).status).toBe(200)
    box.put(native('a', { bodyHtml: `${html}<p>Changed original</p>` }))
    await h.sync('alice', account.id)
    expect((await h.request('alice', path, { headers: { 'if-none-match': '*' } })).status).toBe(404)
    const replacement = resources(await h.inbox.message('alice', id))[0]!
    expect(replacement).not.toBe(path)
    expect((await h.request('alice', replacement)).status).toBe(200)
    expect(box.calls.mutate).toEqual([])
  })

  test('bounds DNS and response time, cancels stalled work and does not expose transport errors', async () => {
    for (const stall of ['dns', 'body', 'error'] as const) {
      let cancelled = false
      const h = await fixture({ defaultPolicy: { remoteImages: true }, media: { timeoutMs: 40, network: {
        resolve: async (_host, signal) => {
          if (stall !== 'dns') return ['93.184.216.34']
          signal.addEventListener('abort', () => { cancelled = true }, { once: true })
          return new Promise<string[]>(() => {})
        },
        request: async () => {
          if (stall === 'error') throw new Error(`${source} ${SECRET}`)
          return new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true } }), { headers: { 'content-type': 'image/png' } })
        },
      } } })
      await h.seed('alice', `media-${stall}`, [native('a', { bodyHtml: html })])
      const result = await bounded(Promise.resolve(h.request('alice', resources(await h.inbox.message('alice', (await h.page()).items[0]!.id))[0]!)), 'bounded media')
      expect(result.status).toBe(stall === 'error' ? 502 : 504)
      const body = await result.json()
      expect(body.code).toBe(stall === 'error' ? 'MEDIA_NETWORK' : 'MEDIA_TIMEOUT')
      expect(JSON.stringify(body)).not.toContain(SECRET)
      if (stall !== 'error') expect(cancelled).toBe(true)
      expect(JSON.stringify(h.logs)).not.toContain(source)
      expect(JSON.stringify(h.logs)).not.toContain(SECRET)
    }
  })

  test('bounds declared, streamed and decompressed bytes and rejects HTML, active SVG, spoofed and oversized raster content', async () => {
    const huge = Buffer.from(png); huge.writeUInt32BE(0x7fffffff, 16)
    const cases: Array<{ name: string; make: () => Response; status: number; code: string }> = [
      { name: 'length', make: () => new Response(png, { headers: { 'content-type': 'image/png', 'content-length': '129' } }), status: 413, code: 'MEDIA_TOO_LARGE' },
      { name: 'stream', make: () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(100)); c.enqueue(new Uint8Array(100)); c.close() } }), { headers: { 'content-type': 'image/png' } }), status: 413, code: 'MEDIA_TOO_LARGE' },
      { name: 'gzip', make: () => new Response(gzipSync(Buffer.alloc(4096)), { headers: { 'content-type': 'image/png', 'content-encoding': 'gzip' } }), status: 413, code: 'MEDIA_TOO_LARGE' },
      { name: 'deflate', make: () => new Response(deflateSync(Buffer.alloc(4096)), { headers: { 'content-type': 'image/png', 'content-encoding': 'deflate' } }), status: 413, code: 'MEDIA_TOO_LARGE' },
      { name: 'brotli', make: () => new Response(brotliCompressSync(Buffer.alloc(4096)), { headers: { 'content-type': 'image/png', 'content-encoding': 'br' } }), status: 413, code: 'MEDIA_TOO_LARGE' },
      { name: 'html', make: () => new Response('<html>not an image</html>', { headers: { 'content-type': 'text/html' } }), status: 415, code: 'MEDIA_TYPE_UNSUPPORTED' },
      { name: 'svg', make: () => new Response('<svg xmlns="http://www.w3.org/2000/svg" onload="unsafe()"/>', { headers: { 'content-type': 'image/svg+xml' } }), status: 415, code: 'MEDIA_INVALID_SVG' },
      { name: 'spoof', make: () => new Response('<html>not a png</html>', { headers: { 'content-type': 'image/png' } }), status: 415, code: 'MEDIA_INVALID_IMAGE' },
      { name: 'truncated', make: () => new Response(png.subarray(0, 30), { headers: { 'content-type': 'image/png' } }), status: 415, code: 'MEDIA_INVALID_IMAGE' },
      { name: 'canvas', make: () => new Response(huge, { headers: { 'content-type': 'image/png' } }), status: 415, code: 'MEDIA_INVALID_IMAGE' },
    ]
    const h = await fixture({ defaultPolicy: { remoteImages: true }, media: { maxBytes: 128, network: network(async target => cases.find(item => new URL(target.url).pathname === `/${item.name}.png`)!.make()) } })
    await h.seed('alice', 'media-validation', cases.map(item => native(item.name, { bodyHtml: `<img src="https://images.example.test/${item.name}.png">` })))
    for (const row of (await h.page()).items) {
      const expected = cases.find(item => row.subject === `Subject ${item.name}`)!
      const result = await h.request('alice', resources(await h.inbox.message('alice', row.id))[0]!)
      expect(result.status).toBe(expected.status)
      expect(await result.json()).toMatchObject({ code: expected.code })
      expect(result.headers.get('cache-control')).toBe('no-store')
      expect(result.headers.get('etag')).toBeNull()
    }
  })

  test('accepts bounded PNG/JPEG/GIF/WebP containers and decompresses supported HTTP encodings before validation', async () => {
    const jpeg = Buffer.from('/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMgD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABLAAEBAAAAAAAAAAAAAAAAAAAABgEBAAAAAAAAAAAAAAAAAAAABRABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAIAAgMBIgACEQADEQD/2gAMAwEAAhEDEQA/AIYA8Ff/2Q==', 'base64')
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
    const webp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64')
    const cases = [
      { name: 'png', type: 'image/png', data: png, expected: png, encoding: 'identity' },
      { name: 'jpeg', type: 'image/jpeg', data: jpeg, expected: jpeg, encoding: 'identity' },
      { name: 'gif', type: 'image/gif', data: gif, expected: gif, encoding: 'identity' },
      { name: 'webp', type: 'image/webp', data: webp, expected: webp, encoding: 'identity' },
      { name: 'gzip', type: 'image/png', data: gzipSync(png), expected: png, encoding: 'gzip' },
      { name: 'deflate', type: 'image/png', data: deflateSync(png), expected: png, encoding: 'deflate' },
      { name: 'brotli', type: 'image/png', data: brotliCompressSync(png), expected: png, encoding: 'br' },
    ]
    const h = await fixture({ defaultPolicy: { remoteImages: true }, media: { maxBytes: 1024, network: network(async target => {
      const item = cases.find(item => new URL(target.url).pathname === `/${item.name}`)!
      return new Response(item.data, { headers: { 'content-type': item.type, 'content-encoding': item.encoding } })
    }) } })
    await h.seed('alice', 'media-formats', cases.map(item => native(item.name, { bodyHtml: `<img src="https://images.example.test/${item.name}">` })))
    for (const row of (await h.page()).items) {
      const item = cases.find(item => row.subject === `Subject ${item.name}`)!
      const result = await h.request('alice', resources(await h.inbox.message('alice', row.id))[0]!)
      expect(result.status).toBe(200)
      expect(result.headers.get('content-type')).toBe(item.type)
      expect(result.headers.get('content-encoding')).toBeNull()
      expect(new Uint8Array(await result.arrayBuffer())).toEqual(new Uint8Array(item.expected))
    }
  })

  test('SVG preserves static artwork, clipping, gradients, inline styles and internal use under document-safe headers', async () => {
    const pathData = 'M2 2h100v20H2z'
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
      <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="320" height="37" viewBox="0 0 320 37" role="img" aria-label="Example mark" xml:space="preserve" style="enable-background:new 0 0 320 37">
      <title id="title">Example &amp; mark</title>
      <style type="text/css"><![CDATA[.ink { fill: url(#shade); stroke:#234567; stroke-width:2; }]]></style>
      <defs><clipPath id="crop"><path d="M0 0h320v37H0z"/></clipPath>
      <linearGradient id="shade" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="320" y2="37"><stop offset="0" style="stop-color:#123456;stop-opacity:1"/><stop offset="100%" style="stop-color:#abcdef"/></linearGradient>
      <symbol id="mark" viewBox="0 0 12 12"><path d="M0 0h12v12H0z" fill="#123456"/></symbol></defs>
      <g clip-path="url(#crop)"><path class="ink" fill-rule="evenodd" d="${pathData}"/><use xlink:href="#mark" x="105" y="2" width="12" height="12"/></g>
      <text x="120" y="12" style="font-family:Helvetica Neue;font-size:8px;fill:#123456">SVG</text></svg>`
    const requested: string[] = []
    const h = await fixture({ defaultPolicy: { remoteImages: true }, media: { network: network(async target => {
      requested.push(target.url)
      return new Response(svg, { headers: { 'content-type': 'image/svg+xml; charset=utf-8' } })
    }) } })
    const { box } = await h.seed('alice', 'svg-artwork', [native('svg', { bodyHtml: '<img src="https://images.example.test/artwork.svg" width="320" height="37">' })])
    const original = (await h.page()).items[0]!
    const before = await h.inbox.changes('alice')
    const path = resources(await h.inbox.message('alice', original.id))[0]!
    const response = await h.request('alice', path, { headers: { 'sec-fetch-dest': 'document' } })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/svg+xml')
    const csp = response.headers.get('content-security-policy')!
    expect(csp).toContain("sandbox; default-src 'none'; style-src 'unsafe-inline'")
    expect(csp).toContain("base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
    expect(csp).not.toMatch(/allow-scripts|allow-same-origin|https?:|data:/)
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin')
    expect(response.headers.get('x-frame-options')).toBe('DENY')
    const output = await response.text()
    const elements: Array<{ name: string; namespace: string; attributes: Record<string, string> }> = []
    const parser = new SaxesParser({ xmlns: true })
    parser.on('opentag', tag => elements.push({ name: tag.local, namespace: tag.uri,
      attributes: Object.fromEntries(Object.values(tag.attributes).map(attr => [attr.name, attr.value])) }))
    parser.write(output).close()
    expect(elements.every(element => element.namespace === 'http://www.w3.org/2000/svg')).toBe(true)
    expect(elements[0]!.attributes).toMatchObject({ width: '320', height: '37', viewBox: '0 0 320 37', 'aria-label': 'Example mark', 'xml:space': 'preserve' })
    expect(elements.filter(element => element.name === 'path').map(element => element.attributes.d)).toContain(pathData)
    expect(elements.find(element => element.name === 'g')!.attributes['clip-path']).toBe('url("#crop")')
    expect(elements.find(element => element.name === 'use')!.attributes.href).toBe('#mark')
    expect(elements.filter(element => element.name === 'stop').map(element => element.attributes.style)).toEqual(['stop-color:#123456;stop-opacity:1', 'stop-color:#abcdef'])
    expect(output).toContain('fill:url("#shade")')
    expect(output).toContain('Example &amp; mark')
    expect(output).not.toContain('enable-background')
    expect(output).not.toContain('https://images.example.test')
    expect(output).not.toContain('<?xml')
    const tag = response.headers.get('etag')!
    const hit = await h.request('alice', path)
    expect(await hit.text()).toBe(output)
    expect(hit.headers.get('etag')).toBe(tag)
    expect((await h.request('alice', path, { headers: { 'if-none-match': tag } })).status).toBe(304)
    expect(requested).toEqual(['https://images.example.test/artwork.svg'])
    await invalid(await h.request('bob', path, { headers: { 'if-none-match': tag } }), 404)
    expect((await h.inbox.message('alice', original.id)).revision).toBe(original.revision)
    expect((await h.inbox.changes('alice', { since: before.state })).events).toEqual([])
    expect(box.calls.mutate).toEqual([])
    await h.inbox.setPolicy('alice', { remoteImages: false })
    const disabled = await h.request('alice', path, { headers: { 'if-none-match': tag } })
    expect(disabled.status).toBe(403)
    expect(disabled.headers.get('etag')).toBeNull()
    expect(requested).toHaveLength(1)
  })

  test('font-family rejection remains bounded for hostile HTML and SVG font lists', async () => {
    const module = new URL('../server/sanitize.ts', import.meta.url).href
    const code = `import { sanitizeSvgImage, sanitizeEmailBody } from ${JSON.stringify(module)};
      const bad = "a ,".repeat(680) + "!";
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><text font-family="' + bad + '">x</text></svg>';
      const sheet = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><style>text{font-family:' + bad + '}</style><text>x</text></svg>';
      const html = sanitizeEmailBody('<p style="font-family:' + "a ,".repeat(330) + '!">Readable content</p>', 'Readable content', true);
      const valid = sanitizeSvgImage('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><text font-family="Helvetica Neue, Arial, &quot;Times New Roman&quot;, serif">x</text></svg>');
      console.log(JSON.stringify({ svg: sanitizeSvgImage(svg) === null, sheet: sanitizeSvgImage(sheet) === null, readable: (html.bodyHtml + html.bodyText).includes('Readable content'), valid: !!valid }));`
    const child = Bun.spawn([process.execPath, '--no-env-file', '-e', code], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
    const deadline = setTimeout(() => child.kill('SIGKILL'), 3000)
    try {
      const [exit, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      expect(exit).toBe(0)
      expect(error).toBe('')
      expect(JSON.parse(output)).toEqual({ svg: true, sheet: true, readable: true, valid: true })
    } finally { clearTimeout(deadline); if (child.exitCode === null) child.kill('SIGKILL') }
  })

  test('SVG canonical output survives repeated cache reads at stylesheet and attribute bounds', async () => {
    const cases = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><style>${Array.from({ length: 100 }, (_, i) => `.c${i}{${'fill:#123456;'.repeat(19)}}`).join('')}</style><path class="c0" d="M0 0h10v10z"/></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path style="${'fill:#123456;'.repeat(619)}" d="M0 0h10v10z"/></svg>`,
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><g id="a&#10;b"/><g id="a b"/><polygon points="10,20 30-40 5,5" fill="#123456"/><text>a&#13;b</text><style>.a&#13;>.b{fill:#123456}</style></svg>',
    ]
    const requested: string[] = []
    const h = await fixture({ defaultPolicy: { remoteImages: true }, media: { network: network(async target => {
      requested.push(target.url)
      return new Response(cases[Number(new URL(target.url).pathname.slice(1))], { headers: { 'content-type': 'image/svg+xml' } })
    }) } })
    await h.seed('alice', 'svg-stable', cases.map((_svg, i) => native(`stable-${i}`, { bodyHtml: `<img src="https://images.example.test/${i}" width="32" height="32">` })))
    for (const row of (await h.page()).items) {
      const path = resources(await h.inbox.message('alice', row.id))[0]!
      const first = await h.request('alice', path)
      expect(first.status).toBe(200)
      const body = await first.text(), tag = first.headers.get('etag')!
      for (let count = 0; count < 3; count++) {
        const cached = await h.request('alice', path)
        expect(cached.status).toBe(200)
        expect(await cached.text()).toBe(body)
        expect(cached.headers.get('etag')).toBe(tag)
      }
      expect((await h.request('alice', path, { headers: { 'if-none-match': tag } })).status).toBe(304)
      if (row.subject === 'Subject stable-2') {
        expect(body).toContain('id="a&#10;b"')
        expect(body).toContain('points="10,20 30-40 5,5"')
        expect(body).toContain('a&#13;b')
      }
    }
    expect(requested).toHaveLength(cases.length)
  })

  test('SVG normalization that exceeds canonical bounds fails before any successful cache entry', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><defs><linearGradient id="a"><stop offset="0" stop-color="#123456"/></linearGradient></defs><path style="${'fill:url(#a);'.repeat(580)}" d="M0 0h10v10z"/></svg>`
    let requests = 0
    const h = await fixture({ defaultPolicy: { remoteImages: true }, media: { network: network(async () => {
      requests++; return new Response(svg, { headers: { 'content-type': 'image/svg+xml' } })
    }) } })
    await h.seed('alice', 'svg-canonical-bound', [native('over-limit', { bodyHtml: '<img src="https://images.example.test/bound.svg" width="32" height="32">' })])
    const path = resources(await h.inbox.message('alice', (await h.page()).items[0]!.id))[0]!
    for (let count = 0; count < 3; count++) {
      const response = await h.request('alice', path)
      expect(response.status).toBe(415)
      expect((await response.json()).code).toBe('MEDIA_INVALID_SVG')
      expect(response.headers.get('etag')).toBeNull()
    }
    expect(requests).toBe(1)
  })

  test('SVG rejects active XML and every external subresource path without fetching nested resources', async () => {
    const outer = 'https://images.example.test'
    const nested = `https://nested.example.test/${SECRET}`
    const wrap = (inside: string, attributes = '') => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="32" height="32" ${attributes}>${inside}</svg>`
    const cases = [
      wrap('<path d="M0 0h8v8z"/>', `onload="${SECRET}"`),
      wrap(`<script>${SECRET}</script>`),
      wrap(`<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">${SECRET}</div></foreignObject>`),
      wrap(`<animate attributeName="href" values="${nested}"/>`),
      wrap(`<set attributeName="fill" to="url(${nested})"/>`),
      wrap(`<a href="${nested}"><path d="M0 0h8v8z"/></a>`),
      wrap(`<image href="${nested}"/>`),
      wrap('<image href="data:image/svg+xml;base64,PHN2Zy8+"/>'),
      wrap(`<use href="${nested}#shape"/>`),
      wrap('<use xlink:href="javascript&#58;alert(1)"/>'),
      wrap('<use href="%23shape"/><path id="shape" d="M0 0h8v8z"/>'),
      wrap(`<linearGradient id="g" href="//nested.example.test/${SECRET}"/>`),
      wrap(`<path d="M0 0h8v8z" fill="url(${nested})"/>`),
      wrap(`<style>@import url("${nested}");.ink{fill:red}</style><path class="ink" d="M0 0h8v8z"/>`),
      wrap(`<style>@font-face{font-family:Brand;src:url("${nested}")}</style><text>Text</text>`),
      wrap('<style>.ink{fill:u\\72l(https://nested.example.test/image)}</style>'),
      wrap(`<path style="background-image:url(${nested})" d="M0 0h8v8z"/>`),
      wrap(`<style>.ink{--image:url(${nested});fill:var(--image)}</style>`),
      wrap('<filter id="f"><feGaussianBlur stdDeviation="1000"/></filter>'),
      wrap('<pattern id="p" width="0.000001" height="0.000001"/>'),
      wrap('<mask id="m"><rect width="100000" height="100000"/></mask>'),
      wrap('<path d="M0 0h8v8z"/>', `xml:base="${nested}"`),
      wrap('<path d="M0 0h8v8z"/>', `evil:href="${nested}" xmlns:evil="urn:evil"`),
      wrap('<style>.ink{constructor:red}</style>'),
    ]
    const requested: string[] = []
    const h = await fixture({ defaultPolicy: { remoteImages: true }, media: { network: network(async target => {
      requested.push(target.url)
      const index = Number(new URL(target.url).pathname.match(/\d+/)![0])
      return new Response(cases[index]!, { headers: { 'content-type': 'image/svg+xml' } })
    }) } })
    await h.seed('alice', 'svg-unsafe', cases.map((_svg, index) => native(`unsafe-${index}`, { bodyHtml: `<img src="${outer}/invalid-${index}.svg">` })))
    for (const row of (await h.page()).items) {
      const result = await h.request('alice', resources(await h.inbox.message('alice', row.id))[0]!)
      expect(result.status).toBe(415)
      expect(result.headers.get('etag')).toBeNull()
      expect(result.headers.get('cache-control')).toBe('no-store')
      const body = await result.json()
      expect(body.code).toBe('MEDIA_INVALID_SVG')
      expect(JSON.stringify(body)).not.toContain(SECRET)
    }
    expect(requested).toHaveLength(cases.length)
    expect(requested.every(url => new URL(url).origin === outer)).toBe(true)
    expect(JSON.stringify(h.logs)).not.toContain(SECRET)
    expect(JSON.stringify(h.logs)).not.toContain(nested)
  })

  test('SVG requires well-formed namespace-correct XML and forbids DTDs, entity expansion and processing instructions', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path d="M0 0h8v8z"/></svg>'
    const cases: Array<string | Uint8Array> = [
      '<html xmlns="http://www.w3.org/1999/xhtml"><svg/></html>',
      '<svg xmlns="urn:not-svg"/>', '<svg/>',
      '<svg xmlns="http://www.w3.org/2000/svg"><g></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" width="2"/>',
      '<svg xmlns="http://www.w3.org/2000/svg"><bad:path/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><text>&unknown;</text></svg>',
      svg + svg, svg.slice(0, -6),
      `<!DOCTYPE svg SYSTEM "https://nested.example.test/${SECRET}">${svg}`,
      `<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///private/${SECRET}">]><svg xmlns="http://www.w3.org/2000/svg"><text>&x;</text></svg>`,
      '<!DOCTYPE svg [<!ENTITY a "ha"><!ENTITY b "&a;&a;&a;"><!ENTITY c "&b;&b;&b;">]><svg xmlns="http://www.w3.org/2000/svg"><text>&c;</text></svg>',
      `<?xml-stylesheet href="https://nested.example.test/${SECRET}" type="text/css"?>${svg}`,
      `<?xml version="1.1"?>${svg}`, `<?xml version="1.0" encoding="UTF-16"?>${svg}`,
      new Uint8Array([0xff, 0xfe, 0x3c, 0, 0x73, 0]),
    ]
    const h = await fixture({ defaultPolicy: { remoteImages: true }, media: { network: network(async target => {
      const index = Number(new URL(target.url).pathname.match(/\d+/)![0])
      const value = cases[index]!
      return new Response(typeof value === 'string' ? value : new Uint8Array(value), { headers: { 'content-type': 'image/svg+xml' } })
    }) } })
    await h.seed('alice', 'svg-xml', cases.map((_svg, index) => native(`xml-${index}`, { bodyHtml: `<img src="https://images.example.test/xml-${index}.svg">` })))
    for (const row of (await h.page()).items) {
      const result = await h.request('alice', resources(await h.inbox.message('alice', row.id))[0]!)
      expect(result.status).toBe(415)
      expect(await result.json()).toMatchObject({ code: 'MEDIA_INVALID_SVG' })
    }
    expect(JSON.stringify(h.logs)).not.toContain(SECRET)
  })

  test('SVG escapes CDATA/text during reconstruction and never promotes text or comments into active markup', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><!-- <script>ignored</script> -->'
      + '<title><![CDATA[</title><script>not executable</script>]]></title><path d="M0 0h8v8z" fill="#123456"/></svg>'
    const h = await fixture({ defaultPolicy: { remoteImages: true }, media: { network: network(async () => new Response(svg, { headers: { 'content-type': 'image/svg+xml' } })) } })
    await h.seed('alice', 'svg-text', [native('text', { bodyHtml: '<img src="https://images.example.test/text.svg">' })])
    const result = await h.request('alice', resources(await h.inbox.message('alice', (await h.page()).items[0]!.id))[0]!)
    expect(result.status).toBe(200)
    const output = await result.text()
    expect(output).not.toContain('<script')
    expect(output).not.toContain('<!--')
    expect(output).toContain('&lt;script&gt;not executable&lt;/script&gt;')
    const names: string[] = [], text: string[] = []
    const parser = new SaxesParser({ xmlns: true })
    parser.on('opentag', tag => names.push(tag.local))
    parser.on('text', value => text.push(value))
    parser.write(output).close()
    expect(names).toEqual(['svg', 'title', 'path'])
    expect(text).toContain('</title><script>not executable</script>')
  })

  test('SVG preserves non-ASCII exporter IDs as inert escaped metadata without relaxing URI references', async () => {
    const layerId = '图层_1 & " onload="not code'
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" id="图层_1 &amp; &quot; onload=&quot;not code" viewBox="0 0 1024 867">'
      + '<style>.paint{fill:url(#shade)}</style><linearGradient id="shade"><stop offset="0" style="stop-color:#123456"/><stop offset="1" style="stop-color:#abcdef"/></linearGradient>'
      + '<path class="paint" d="M0 0h100v100H0z"/></svg>'
    const h = await fixture({ defaultPolicy: { remoteImages: true }, media: { network: network(async () => new Response(svg, { headers: { 'content-type': 'image/svg+xml' } })) } })
    await h.seed('alice', 'svg-layer-id', [native('layer', { bodyHtml: '<img src="https://images.example.test/layer.svg">' })])
    const result = await h.request('alice', resources(await h.inbox.message('alice', (await h.page()).items[0]!.id))[0]!)
    expect(result.status).toBe(200)
    const nodes: Array<Record<string, string>> = []
    const parser = new SaxesParser({ xmlns: true })
    parser.on('opentag', tag => nodes.push(Object.fromEntries(Object.values(tag.attributes).map(attr => [attr.name, attr.value]))))
    parser.write(await result.text()).close()
    expect(nodes[0]!.id).toBe(layerId)
    expect(nodes[0]!.viewBox).toBe('0 0 1024 867')
    expect(nodes.every(attributes => !Object.hasOwn(attributes, 'onload'))).toBe(true)
  })

  test('SVG bounds source/decompressed size, dimensions, nesting, styles, geometry and internal reference expansion', async () => {
    const wrap = (inside: string, attributes = 'width="32" height="32"') => `<svg xmlns="http://www.w3.org/2000/svg" ${attributes}>${inside}</svg>`
    let expansion = '<defs><g id="g0"><path d="M0 0h8v8z"/></g>'
    for (let i = 1; i < 15; i++) expansion += `<g id="g${i}"><use href="#g${i - 1}"/><use href="#g${i - 1}"/></g>`
    expansion += '</defs><use href="#g14"/>'
    const cases = [
      wrap('<path d="M0 0h8v8z"/>', 'width="20000" height="1"'),
      wrap('', 'width="10000" height="10000"'), wrap('', 'width="0" height="1"'),
      wrap('', 'width="16384" viewBox="0 0 1 10"'), wrap('', 'viewBox="0 0 1e300 10"'),
      wrap('<g>'.repeat(40) + '<path d="M0 0h8v8z"/>' + '</g>'.repeat(40)),
      wrap('<path d="M0 0h8v8z"/>'.repeat(1025)),
      wrap('', Array.from({ length: 33 }, (_, index) => `data-a${index}="x"`).join(' ')),
      wrap('<style>' + Array.from({ length: 129 }, (_, index) => `.c${index}{fill:#123456}`).join('') + '</style>'),
      wrap(`<style>/*${'x'.repeat(33 * 1024)}*/</style>`),
      wrap(`<path d="M0 0${'L1 1'.repeat(17_000)}"/>`),
      wrap('<path d="M0 0h8v8z" style="stroke-dasharray:0.000001"/>'),
      wrap('<text style="font-size:10000%">Huge</text>'),
      wrap('<use id="a" href="#a"/>'), wrap('<use href="#missing"/>'),
      wrap('<g id="wrong"/><path d="M0 0h8v8z" fill="url(#wrong)"/>'),
      wrap(expansion),
    ]
    const h = await fixture({ defaultPolicy: { remoteImages: true }, media: { network: network(async target => {
      const index = Number(new URL(target.url).pathname.match(/\d+/)![0])
      return new Response(cases[index]!, { headers: { 'content-type': 'image/svg+xml' } })
    }) } })
    await h.seed('alice', 'svg-limits', cases.map((_svg, index) => native(`limit-${index}`, { bodyHtml: `<img src="https://images.example.test/limit-${index}.svg">` })))
    for (const row of (await h.page()).items) {
      const result = await h.request('alice', resources(await h.inbox.message('alice', row.id))[0]!)
      expect(result.status).toBe(415)
      expect(await result.json()).toMatchObject({ code: 'MEDIA_INVALID_SVG' })
    }
    for (const compressed of [false, true]) {
      const huge = wrap(`<!--${'x'.repeat(256 * 1024)}-->`)
      const large = await fixture({ defaultPolicy: { remoteImages: true }, media: { network: network(async () => new Response(compressed ? gzipSync(huge) : huge,
        { headers: { 'content-type': 'image/svg+xml', ...(compressed ? { 'content-encoding': 'gzip' } : {}) } })) } })
      await large.seed('alice', 'svg-byte-limit', [native('bytes', { bodyHtml: '<img src="https://images.example.test/bytes.svg">' })])
      const result = await large.request('alice', resources(await large.inbox.message('alice', (await large.page()).items[0]!.id))[0]!)
      expect(result.status).toBe(413)
      expect(await result.json()).toMatchObject({ code: 'MEDIA_TOO_LARGE' })
    }
  })

  test('SVG cache entries are rechecked before validators and unsafe cached XML is evicted, not served', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path d="M0 0h8v8z"/></svg>'
    let requests = 0
    const h = await fixture({ defaultPolicy: { remoteImages: true }, media: { network: network(async () => { requests++; return new Response(svg, { headers: { 'content-type': 'image/svg+xml' } }) }) } })
    await h.seed('alice', 'svg-cache', [native('cached', { bodyHtml: '<img src="https://images.example.test/cached.svg">' })])
    const path = resources(await h.inbox.message('alice', (await h.page()).items[0]!.id))[0]!
    const initial = await h.request('alice', path)
    expect(initial.status).toBe(200)
    const tag = initial.headers.get('etag')!
    const db = new Database(h.database)
    try {
      const unsafe = '<svg xmlns="http://www.w3.org/2000/svg" onload="unsafe()"/>'
      db.query("UPDATE sdk_media_cache SET content=? WHERE type='image/svg+xml'").run(Buffer.from(unsafe))
    } finally { db.close() }
    const invalidated = await h.request('alice', path, { headers: { 'if-none-match': tag } })
    expect(invalidated.status).toBe(415)
    expect(invalidated.headers.get('etag')).toBeNull()
    expect(await invalidated.json()).toMatchObject({ code: 'MEDIA_INVALID_SVG' })
    expect(requests).toBe(1)
    expect((await h.request('alice', path)).status).toBe(200)
    expect(requests).toBe(2)
  })
})
