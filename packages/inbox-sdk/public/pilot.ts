import { ApiError, createInboxClient } from '../src/client'
import { createGoogleOAuthClient } from '../server/google-client'
import type { Account, Connection, Mailbox, MailboxMessageSummary } from '../src/contracts'

const client = createInboxClient({ headers: { 'X-Inbox-Pilot': '1' } })
const google = createGoogleOAuthClient(client)
const selected = new Set<string>()
const busy = new Set<HTMLButtonElement>()
let mailboxes: Mailbox[] = []
let accounts: Account[] = []
let selectionInitialized = false
let nextCursor: string | null = null
let loaded = 0
let listVersion = 0
let readerVersion = 0
let refreshVersion = 0
let googleConfigured = false

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag)
  if (text !== undefined) result.textContent = text
  return result
}

function status(text: string, error = false): void {
  element('status').textContent = text
  element('status').dataset.error = String(error)
}

function syncable(): Mailbox[] {
  return mailboxes.filter(mailbox => selected.has(mailbox.id) && mailbox.status === 'active' &&
    (mailbox.receiving === 'ready' || mailbox.selector.kind === 'all' && mailbox.receiving === 'unverified') &&
    accounts.some(account => account.id === mailbox.sourceId && account.status === 'connected' && account.capabilities.sync))
}

function updateControls(): void {
  element<HTMLButtonElement>('google').disabled = !googleConfigured || busy.has(element('google'))
  const syncing = ['sync', 'backfill'].some(id => busy.has(element(id)))
  for (const id of ['sync', 'backfill']) element<HTMLButtonElement>(id).disabled = syncable().length === 0 || syncing
}

async function run(control: HTMLButtonElement, work: () => Promise<void>): Promise<void> {
  if (busy.has(control)) return
  busy.add(control)
  control.disabled = true
  updateControls()
  status('Working...')
  try { await work() }
  catch (error) {
    status(error instanceof ApiError ? `${error.code} (${error.status}): ${error.message}` :
      'Could not reach the local server. Check that bun run dev is running, then click Refresh.', true)
  } finally {
    busy.delete(control)
    control.disabled = false
    updateControls()
  }
}

function button(text: string, work: () => Promise<void>): HTMLButtonElement {
  const result = node('button', text)
  result.type = 'button'
  result.onclick = () => { void run(result, work) }
  return result
}

function closeMessage(): void {
  readerVersion++
  element('reader').hidden = true
  element('message-body').textContent = ''
  element('message-json').textContent = ''
  for (const row of element('messages').querySelectorAll('button')) row.setAttribute('aria-pressed', 'false')
}

async function connectGoogle(connectionId?: string): Promise<void> {
  const attempt = await google.startGoogleOAuth(connectionId ? { connectionId } : {})
  if (!attempt.authorizeUrl) throw new ApiError('The API did not return a sign-in link.', 502, 'INVALID_RESPONSE')
  status('Opening Google sign-in...')
  location.assign(attempt.authorizeUrl)
}

function connectionRow(connection: Connection): HTMLLIElement {
  const row = node('li')
  row.append(node('strong', `${connection.name || connection.providerId} (${connection.providerId})`), node('span', ` - ${connection.status}`))
  for (const account of accounts.filter(account => connection.sourceIds.includes(account.id))) {
    row.append(node('p', `${account.email || 'API-key source'} | Coverage: ${account.sync.coverage} | Last sync: ${account.sync.lastSyncAt ? new Date(account.sync.lastSyncAt).toLocaleString() : 'not yet'}${account.sync.problem ? ` | ${account.sync.problem}` : ''}`))
  }
  const actions = node('div')
  actions.className = 'actions'
  const candidates = node('ul')
  if (connection.status === 'connected') {
    actions.append(button('Choose mailbox views', async () => {
      const choices = await client.mailboxCandidates(connection.id)
      candidates.replaceChildren()
      for (const candidate of choices) {
        const item = node('li')
        const existing = mailboxes.some(mailbox => mailbox.sourceId === candidate.sourceId && mailbox.status !== 'detached' && JSON.stringify(mailbox.selector) === JSON.stringify(candidate.selector))
        const add = button(existing ? `${candidate.name} (added)` : `Add ${candidate.name}`, async () => {
          const mailbox = await client.createMailbox({ sourceId: candidate.sourceId, selector: candidate.selector, name: candidate.name })
          selected.add(mailbox.id)
          await refresh()
          status(`Added mailbox view: ${mailbox.name}.`)
        })
        add.disabled = existing || !candidate.canReceive || (candidate.selector.kind !== 'all' && !candidate.canFilter)
        item.append(add)
        if (candidate.unavailableReason) item.append(node('span', ` ${candidate.unavailableReason}`))
        candidates.append(item)
      }
      if (!choices.length) candidates.append(node('li', 'No receiving mailboxes are available for this connection.'))
      status('Mailbox choices loaded.')
    }))
  }
  if (connection.providerId === 'gmail' && connection.identity) actions.append(button('Reconnect Gmail', () => connectGoogle(connection.id)))
  row.append(actions, candidates)
  return row
}

async function refresh(): Promise<void> {
  const version = ++refreshVersion
  const session = await fetch('/ui/session', { method: 'POST', headers: { 'X-Inbox-Pilot': '1' }, credentials: 'same-origin', cache: 'no-store' })
  if (!session.ok) throw new ApiError('Open the pilot through localhost using bun run dev.', session.status, 'LOCAL_SESSION_REQUIRED')
  const config = await session.json() as { googleConfigured: boolean; inboundEnabled: boolean; allowProviderWrites: boolean }
  const [connections, sources, views] = await Promise.all([client.connections(), client.accounts(), client.mailboxes()])
  if (version !== refreshVersion) return
  googleConfigured = config.googleConfigured
  element('mode').textContent = config.allowProviderWrites ? 'Provider writes enabled on the server. This UI only reads mail and changes local workflow state.' :
    'Read-only provider access. Local done and snooze stay in the SDK.'
  if (!googleConfigured) element('mode').append(' Google OAuth is not configured.')
  element('inbound').hidden = !config.inboundEnabled
  accounts = sources
  mailboxes = views.filter(mailbox => mailbox.status !== 'detached')
  for (const id of selected) if (!mailboxes.some(mailbox => mailbox.id === id)) selected.delete(id)
  if (!selectionInitialized && mailboxes.length) {
    selected.add(mailboxes[0]!.id)
    selectionInitialized = true
  }
  element('connections').replaceChildren(...connections.map(connectionRow))
  if (!connections.length) element('connections').append(node('li', 'No accounts connected.'))
  element('mailboxes').replaceChildren()
  for (const mailbox of mailboxes) {
    const label = node('label')
    const checkbox = node('input')
    checkbox.type = 'checkbox'
    checkbox.checked = selected.has(mailbox.id)
    checkbox.onchange = () => {
      if (checkbox.checked) selected.add(mailbox.id)
      else selected.delete(mailbox.id)
      closeMessage()
      updateControls()
      void loadMessages().catch(showReadError)
    }
    const selector = mailbox.selector.kind === 'all' ? 'all source mail' : `${mailbox.selector.kind}: ${mailbox.selector.value}`
    label.append(checkbox, node('span', `${mailbox.name} (${selector})${mailbox.status !== 'active' ? ` - ${mailbox.status}` : ''}${mailbox.receiving !== 'ready' ? ` - ${mailbox.receiving}` : ''}`))
    element('mailboxes').append(label)
  }
  if (!mailboxes.length) element('mailboxes').append(node('p', 'No mailbox views yet. Gmail adds its mailbox automatically; choose views for Inbound above.'))
  updateControls()
  closeMessage()
  await loadMessages()
}

function showReadError(error: unknown): void {
  status(error instanceof ApiError ? `${error.code} (${error.status}): ${error.message}` : 'Could not load mail. Click Refresh to retry.', true)
}

function messageRow(message: MailboxMessageSummary): HTMLLIElement {
  const row = node('li')
  const mailboxId = message.memberships.find(membership => selected.has(membership.mailboxId))!.mailboxId
  const open = button('', () => showMessage(mailboxId, message.id))
  open.className = 'message'
  open.dataset.messageId = message.id
  open.setAttribute('aria-pressed', 'false')
  open.append(node('strong', `${message.isRead ? '' : 'Unread: '}${message.subject || '(No subject)'}`),
    node('small', `${message.from.name || message.from.email} | ${new Date(message.receivedAt).toLocaleString()}`),
    node('span', message.preview),
    node('small', message.memberships.map(membership => `${mailboxes.find(mailbox => mailbox.id === membership.mailboxId)?.name || membership.mailboxId}: ${membership.done ? 'done' : 'open'}${membership.snoozedUntil ? ', snoozed' : ''}`).join(' | ')))
  row.append(open)
  return row
}

async function loadMessages(more = false): Promise<void> {
  const version = ++listVersion
  if (!more) {
    nextCursor = null
    loaded = 0
    element('messages').replaceChildren()
  }
  element('more').hidden = true
  if (!selected.size) {
    element('message-count').textContent = 'Choose a mailbox view to read its messages.'
    return
  }
  element('message-count').textContent = 'Loading cached messages...'
  const page = await client.mailboxMessages({ mailboxIds: [...selected], search: element<HTMLInputElement>('search').value.trim() || undefined,
    limit: 50, ...(more && nextCursor ? { cursor: nextCursor } : {}) })
  if (version !== listVersion) return
  loaded += page.items.length
  nextCursor = page.nextCursor
  element('messages').append(...page.items.map(messageRow))
  element('message-count').textContent = page.total ? `${loaded} of ${page.total} matching messages. Overlapping views are deduplicated.` :
    'No cached messages match. Sync the selected views or change the search.'
  element('more').hidden = !nextCursor
}

async function showMessage(mailboxId: string, id: string, focus = true): Promise<void> {
  const version = ++readerVersion
  const message = await client.mailboxMessage(mailboxId, id)
  if (version !== readerVersion) return
  for (const row of element('messages').querySelectorAll<HTMLButtonElement>('button')) row.setAttribute('aria-pressed', String(row.dataset.messageId === id))
  element('subject').textContent = message.subject || '(No subject)'
  element('message-meta').textContent = `From: ${message.from.name} <${message.from.email}>\nTo: ${message.to.map(person => person.email).join(', ')}${message.cc.length ? `\nCc: ${message.cc.map(person => person.email).join(', ')}` : ''}\nReceived: ${new Date(message.receivedAt).toLocaleString()}`
  element('message-body').textContent = message.bodyText || 'No plain-text body. The stored HTML is available in the API response below.'
  element('message-json').textContent = JSON.stringify(message, null, 2)
  element('memberships').replaceChildren()
  for (const membership of message.memberships.filter(item => selected.has(item.mailboxId))) {
    const state = node('div')
    state.className = 'actions'
    const view = mailboxes.find(mailbox => mailbox.id === membership.mailboxId)
    state.append(node('span', `${view?.name || membership.mailboxId}: ${membership.done ? 'done' : 'open'}${membership.snoozedUntil ? `, snoozed until ${new Date(membership.snoozedUntil).toLocaleString()}` : ''}`))
    for (const [label, input] of [
      [membership.done ? 'Reopen here' : 'Done here', { done: !membership.done }],
      [membership.snoozedUntil ? 'Unsnooze here' : 'Snooze here for 1 hour', { snoozedUntil: membership.snoozedUntil ? null : new Date(Date.now() + 3600_000).toISOString() }],
    ] as const) {
      state.append(button(label, async () => {
        await client.setMailboxState(membership.mailboxId, id, input, membership.revision)
        await loadMessages()
        if (version !== readerVersion) return
        await showMessage(mailboxId, id, false)
        status('Local mailbox state saved. Provider mail was not changed.')
      }))
    }
    element('memberships').append(state)
  }
  element('attachments').replaceChildren()
  for (const attachment of message.attachments) {
    const item = node('li')
    item.append(button(`Download ${attachment.filename} (${attachment.size} bytes)`, async () => {
      const file = await client.download(attachment.id)
      const url = URL.createObjectURL(new Blob([new Uint8Array(file.content).buffer], { type: file.info.contentType }))
      const link = node('a')
      link.href = url
      link.download = file.info.filename
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      status('Attachment downloaded.')
    }))
    element('attachments').append(item)
  }
  element('reader').hidden = false
  if (focus) {
    element('reader').focus({ preventScroll: true })
    if (matchMedia('(max-width: 700px)').matches) element('reader').scrollIntoView({ block: 'start' })
  }
  status('Message loaded without marking it read.')
}

element<HTMLButtonElement>('google').onclick = () => { void run(element('google'), () => connectGoogle()) }
element<HTMLButtonElement>('refresh').onclick = () => { void run(element('refresh'), async () => { await refresh(); status('Refreshed from the SDK.') }) }
element<HTMLButtonElement>('close-message').onclick = closeMessage
element<HTMLButtonElement>('more').onclick = () => { void run(element('more'), async () => { await loadMessages(true); status('Cached page loaded.') }) }
element<HTMLFormElement>('search-form').onsubmit = event => {
  event.preventDefault()
  closeMessage()
  void run(element('search-form').querySelector<HTMLButtonElement>('button[type="submit"]')!, async () => { await loadMessages(); status('Search complete.') })
}
element<HTMLFormElement>('inbound-form').onsubmit = event => {
  event.preventDefault()
  const input = element<HTMLInputElement>('inbound-key')
  const apiKey = input.value.trim()
  if (!apiKey) return
  input.value = ''
  void run(element('inbound-form').querySelector('button')!, async () => {
    await client.createConnection({ providerId: 'inbound', credentials: { apiKey } })
    await refresh()
    element<HTMLDetailsElement>('inbound').open = false
    status('Inbound connected. Choose its mailbox views above to start syncing.')
  })
}
for (const [id, lane] of [['sync', 'latest'], ['backfill', 'backfill']] as const) {
  element<HTMLButtonElement>(id).onclick = () => { void run(element(id), async () => {
    const views = [...new Map(syncable().map(mailbox => [mailbox.sourceId, mailbox])).values()]
    let synchronized = 0
    let hasMore = false
    for (const mailbox of views) {
      status(`Syncing ${mailbox.name}...`)
      const result = await client.syncMailbox(mailbox.id, { lane, limit: 50 })
      synchronized += result.synchronized
      hasMore ||= result.hasMore
    }
    await refresh()
    status(`Synchronized ${synchronized} messages.${hasMore ? ' More history is available; use Import older mail.' : ''}`)
  }) }
}

const googleResult = new URL(location.href).searchParams.get('google')
if (googleResult) history.replaceState(null, '', '/')
void run(element('refresh'), async () => {
  await refresh()
  status(googleResult === 'connected' ? 'Google connected. Select its mailbox and click Sync selected.' :
    googleResult === 'failed' ? 'Google sign-in did not complete. Check the registered callback and test-user access, then try again.' : '', googleResult === 'failed')
})
