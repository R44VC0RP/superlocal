import type { Database } from 'bun:sqlite'
import type { ConnectionSources, InboxScope, SavedInbox, SavedInboxInput } from '../../src/inbox-views'

export type { ConnectionSources, InboxScope, SavedInbox, SavedInboxInput }

const maxScopes = 100

export class InboxViewError extends Error {
  constructor(message: string, readonly status: 400 | 404 = 400) {
    super(message)
    this.name = 'InboxViewError'
  }
}

function canonicalSource(kind: InboxScope['kind'], input: unknown): string | null {
  if (typeof input !== 'string' || /[^\x20-\x7e]/.test(input)) return null
  const value = input.trim().toLowerCase()
  const domain = kind === 'domain' ? value : value.split('@')[1]
  if (!domain || domain.length > 253 || !domain.split('.').every((label) =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
  )) return null
  if (kind === 'domain') return value
  const parts = value.split('@')
  if (parts.length !== 2 || value.length > 254 || parts[0]!.length > 64 ||
    !/^[a-z0-9!#$%&'+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'+/=?^_`{|}~-]+)*$/.test(parts[0]!)) return null
  return value
}

function canonicalScopes(input: unknown): InboxScope[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > maxScopes) {
    throw new InboxViewError('Choose between 1 and 100 inbox scopes')
  }
  const scopes = new Map<string, InboxScope>()
  for (const scope of input) {
    if (!scope || (scope.kind !== 'domain' && scope.kind !== 'address')) {
      throw new InboxViewError('Invalid inbox scope kind')
    }
    const value = canonicalSource(scope.kind, scope.value)
    if (!value) throw new InboxViewError('Invalid inbox scope value')
    scopes.set(`${scope.kind}:${value}`, { kind: scope.kind, value })
  }
  return [...scopes.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, scope]) => scope)
}

interface InboxRow {
  id: string
  account_id: string
  name: string
  scopes_json: string
  default_sender: string | null
}

function savedInbox(row: InboxRow): SavedInbox {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    scopes: JSON.parse(row.scopes_json) as InboxScope[],
    defaultSender: row.default_sender,
  }
}

export class InboxViewStore {
  constructor(private readonly database: Database) {}

  list(userId: string): SavedInbox[] {
    return this.database.query<InboxRow, [string]>(
      'SELECT id, account_id, name, scopes_json, default_sender FROM sdk_inbox_views WHERE user_id = ? ORDER BY name, id',
    ).all(userId).map(savedInbox)
  }

  get(userId: string, id: string): SavedInbox | null {
    const row = this.database.query<InboxRow, [string, string]>(
      'SELECT id, account_id, name, scopes_json, default_sender FROM sdk_inbox_views WHERE user_id = ? AND id = ?',
    ).get(userId, id)
    return row ? savedInbox(row) : null
  }

  create(userId: string, input: SavedInboxInput, sources: ConnectionSources): SavedInbox {
    if (!input || typeof input.accountId !== 'string' || input.accountId.length === 0 || input.accountId.length > 256) {
      throw new InboxViewError('Invalid account ID')
    }
    if (!this.database.query('SELECT 1 FROM mail_accounts WHERE user_id = ? AND id = ?').get(userId, input.accountId)) {
      throw new InboxViewError('Account not found', 404)
    }
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 100 || /[\x00-\x1f\x7f]/.test(input.name)) {
      throw new InboxViewError('Inbox name must contain between 1 and 100 characters')
    }
    const scopes = canonicalScopes(input.scopes)
    const receivable = new Set((sources?.sources ?? []).flatMap((source) => {
      if (source.canReceive !== true || source.canFilter === false || (source.kind !== 'domain' && source.kind !== 'address')) return []
      const value = canonicalSource(source.kind, source.value)
      return value ? [`${source.kind}:${value}`] : []
    }))
    if (scopes.some((scope) => !receivable.has(`${scope.kind}:${scope.value}`))) {
      throw new InboxViewError('Inbox scopes must be discovered receivable sources')
    }
    let defaultSender: string | null = null
    if (input.defaultSender !== undefined && input.defaultSender !== null) {
      defaultSender = canonicalSource('address', input.defaultSender)
      if (!defaultSender || !(sources?.identities ?? []).some((identity) =>
        canonicalSource('address', identity.email) === defaultSender,
      )) throw new InboxViewError('Default sender must be a discovered sending identity')
      if (!scopes.some((scope) => scope.kind === 'address' ? scope.value === defaultSender : scope.value === defaultSender!.split('@')[1])) {
        throw new InboxViewError('Default sender must belong to a selected inbox source')
      }
    }
    const view: SavedInbox = {
      id: crypto.randomUUID(),
      accountId: input.accountId,
      name: input.name.trim(),
      scopes,
      defaultSender,
    }
    this.database.query(`
      INSERT INTO sdk_inbox_views (id, user_id, account_id, name, scopes_json, default_sender)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(view.id, userId, view.accountId, view.name, JSON.stringify(view.scopes), view.defaultSender)
    return view
  }

  delete(userId: string, id: string): boolean {
    return this.database.query('DELETE FROM sdk_inbox_views WHERE user_id = ? AND id = ?').run(userId, id).changes > 0
  }

  recordMessageSources(userId: string, accountId: string, messageId: string, message: {
    folder: string
    from: { email: string }
    sourceDomains?: string[]
    deliveryRecipients?: string[]
  }): void {
    this.database.transaction(() => {
      if (!this.database.query('SELECT 1 FROM messages WHERE user_id = ? AND account_id = ? AND id = ?')
        .get(userId, accountId, messageId)) throw new InboxViewError('Message not found', 404)

      // Only normalized adapter delivery proofs belong here, never incoming To/CC headers.
      const proofs = new Map<string, InboxScope>()
      for (const domain of message.folder === 'sent' ? [] : message.sourceDomains ?? []) {
        const value = canonicalSource('domain', domain)
        if (value) proofs.set(`domain:${value}`, { kind: 'domain', value })
      }
      const addresses = message.folder === 'sent' ? [message.from.email] : message.deliveryRecipients ?? []
      for (const address of addresses) {
        const value = canonicalSource('address', address)
        if (!value) continue
        const domain = value.split('@')[1]!
        proofs.set(`address:${value}`, { kind: 'address', value })
        proofs.set(`domain:${domain}`, { kind: 'domain', value: domain })
      }
      // Proofs are additive: detail refreshes can omit delivery metadata seen during sync.
      const insert = this.database.query(`
        INSERT INTO sdk_message_sources (user_id, account_id, message_id, kind, value)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING
      `)
      for (const { kind, value } of proofs.values()) insert.run(userId, accountId, messageId, kind, value)
    })()
  }
}

export function inboxMessagePredicate(view: SavedInbox, alias = 'm'): { sql: string; params: string[] } {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(alias)) throw new InboxViewError('Invalid message table alias')
  const scopes = canonicalScopes(view.scopes)
  const message = `"${alias}"`
  const storedView = `${alias}_inbox_view`
  const source = `${alias}_inbox_source`
  return {
    sql: `(${message}.account_id = ? AND EXISTS (
      SELECT 1 FROM sdk_inbox_views ${storedView}
      WHERE ${storedView}.id = ? AND ${storedView}.user_id = ${message}.user_id
        AND ${storedView}.account_id = ${message}.account_id
    ) AND EXISTS (
      SELECT 1 FROM sdk_message_sources ${source}
      WHERE ${source}.user_id = ${message}.user_id AND ${source}.account_id = ${message}.account_id
        AND ${source}.message_id = ${message}.id
        AND (${scopes.map(() => `(${source}.kind = ? AND ${source}.value = ?)`).join(' OR ')})
    ))`,
    params: [view.accountId, view.id, ...scopes.flatMap((scope) => [scope.kind, scope.value])],
  }
}
