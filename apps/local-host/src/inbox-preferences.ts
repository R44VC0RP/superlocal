import type { Database } from 'bun:sqlite'
import { InboxError, type Inbox, type Mailbox } from 'inbox-sdk'
import { object } from './config'

export type InboxViewPreferences = {
  revision: number
  unifiedMode: 'all' | 'selected'
  includedMailboxIds: string[]
  pinnedMailboxIds: string[]
}

export const INBOX_PREFERENCES_BODY_LIMIT = 262_144
const fields = ['revision', 'unifiedMode', 'includedMailboxIds', 'pinnedMailboxIds']
type PreferencesRow = {
  revision: number
  unified_mode: string
  included_mailbox_ids: string
  pinned_mailbox_ids: string
  pins_seeded: number
}

function mailboxIds(value: unknown, maximum: number, field: string): string[] {
  if (!Array.isArray(value) || value.length > maximum || value.some(id => typeof id !== 'string' || !id || id.length > 512 || id.trim() !== id || /[\x00-\x1f\x7f/\\]/.test(id)) || new Set(value).size !== value.length) {
    throw new InboxError('HOST_INBOX_PREFERENCES_INVALID', `${field} must be a list of at most ${maximum} unique mailbox IDs.`, 400)
  }
  return [...value]
}

function preferences(input: unknown): InboxViewPreferences {
  if (!object(input) || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).length !== fields.length || Object.keys(input).some(key => !fields.includes(key))) {
    throw new InboxError('HOST_INBOX_PREFERENCES_INVALID', 'Provide only revision, unifiedMode, includedMailboxIds, and pinnedMailboxIds.', 400)
  }
  if (typeof input.revision !== 'number' || !Number.isSafeInteger(input.revision) || input.revision < 1) {
    throw new InboxError('HOST_INBOX_PREFERENCES_INVALID', 'Use the positive integer revision from the current inbox preferences.', 400)
  }
  if (input.unifiedMode !== 'all' && input.unifiedMode !== 'selected') {
    throw new InboxError('HOST_INBOX_PREFERENCES_INVALID', 'Unified mode must be all or selected.', 400)
  }
  return { revision: input.revision, unifiedMode: input.unifiedMode,
    includedMailboxIds: mailboxIds(input.includedMailboxIds, 5000, 'Unified inclusion'),
    pinnedMailboxIds: mailboxIds(input.pinnedMailboxIds, 9, 'Pinned mailboxes') }
}

function savedPreferences(row: PreferencesRow): InboxViewPreferences {
  try {
    if (row.included_mailbox_ids.length > INBOX_PREFERENCES_BODY_LIMIT || row.pinned_mailbox_ids.length > INBOX_PREFERENCES_BODY_LIMIT || ![0, 1].includes(row.pins_seeded)) throw new Error()
    return preferences({ revision: row.revision, unifiedMode: row.unified_mode,
      includedMailboxIds: JSON.parse(row.included_mailbox_ids), pinnedMailboxIds: JSON.parse(row.pinned_mailbox_ids) })
  } catch { throw new InboxError('HOST_INBOX_PREFERENCES_UNREADABLE', 'Saved inbox preferences could not be read safely. They were not reset.', 500) }
}

function nextRevision(revision: number): number {
  if (!Number.isSafeInteger(revision + 1)) throw new InboxError('HOST_INBOX_PREFERENCES_UNWRITABLE', 'The inbox preferences revision cannot be advanced. No settings were changed.', 500)
  return revision + 1
}

/** Host-owned view settings only: no SDK policy, native mail state, discovery, or credential writes. */
export function createInboxViewPreferencesStore(database: Database, inbox: Pick<Inbox, 'mailboxes'>, owner: string) {
  database.transaction(() => database.exec(`CREATE TABLE IF NOT EXISTS local_inbox_preferences (
    owner TEXT PRIMARY KEY NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1 AND revision <= 9007199254740991),
    unified_mode TEXT NOT NULL CHECK (unified_mode IN ('all','selected')),
    included_mailbox_ids TEXT NOT NULL,
    pinned_mailbox_ids TEXT NOT NULL,
    pins_seeded INTEGER NOT NULL CHECK (pins_seeded IN (0,1))
  ) STRICT`)).immediate()
  const select = database.query<PreferencesRow, [string]>(`SELECT revision,unified_mode,included_mailbox_ids,pinned_mailbox_ids,pins_seeded
    FROM local_inbox_preferences WHERE owner=?`)
  const insert = database.query(`INSERT INTO local_inbox_preferences
    (owner,revision,unified_mode,included_mailbox_ids,pinned_mailbox_ids,pins_seeded) VALUES (?,?,?,?,?,?)`)
  const update = database.query(`UPDATE local_inbox_preferences SET revision=?,unified_mode=?,included_mailbox_ids=?,pinned_mailbox_ids=?,pins_seeded=?
    WHERE owner=? AND revision=?`)
  const conflict = () => new InboxError('HOST_INBOX_PREFERENCES_CONFLICT', 'Inbox preferences changed elsewhere. Reload them before saving again.', 412)
  const available = async () => (await inbox.mailboxes(owner)).filter(mailbox => mailbox.status !== 'detached')
  function initial(mailboxes: Mailbox[]): InboxViewPreferences {
    return { revision: 1, unifiedMode: 'all', includedMailboxIds: [], pinnedMailboxIds: mailboxes.slice(0, 9).map(mailbox => mailbox.id) }
  }
  function save(value: InboxViewPreferences, seeded: boolean, previousRevision: number | null): InboxViewPreferences {
    const included = JSON.stringify(value.includedMailboxIds), pinned = JSON.stringify(value.pinnedMailboxIds)
    if (previousRevision === null) insert.run(owner, value.revision, value.unifiedMode, included, pinned, Number(seeded))
    else if (update.run(value.revision, value.unifiedMode, included, pinned, Number(seeded), owner, previousRevision).changes !== 1) throw conflict()
    return value
  }
  return {
    async read(): Promise<InboxViewPreferences> {
      const mailboxes = await available()
      return database.transaction(() => {
        const row = select.get(owner)
        if (!row) return save(initial(mailboxes), mailboxes.length > 0, null)
        const current = savedPreferences(row)
        const ids = new Set(mailboxes.map(mailbox => mailbox.id))
        const includedMailboxIds = current.includedMailboxIds.filter(id => ids.has(id))
        // Paused or disconnected sources keep their views. Only detached/missing IDs are removed.
        const pinnedMailboxIds = row.pins_seeded ? current.pinnedMailboxIds.filter(id => ids.has(id)) : initial(mailboxes).pinnedMailboxIds
        const seeded = row.pins_seeded === 1 || mailboxes.length > 0
        if (includedMailboxIds.length === current.includedMailboxIds.length && pinnedMailboxIds.length === current.pinnedMailboxIds.length && seeded === Boolean(row.pins_seeded)) return current
        return save({ ...current, revision: nextRevision(current.revision), includedMailboxIds, pinnedMailboxIds }, seeded, current.revision)
      }).immediate()
    },
    async write(input: unknown): Promise<InboxViewPreferences> {
      const value = preferences(input)
      const mailboxes = await available()
      const ids = new Set(mailboxes.map(mailbox => mailbox.id))
      if ([...value.includedMailboxIds, ...value.pinnedMailboxIds].some(id => !ids.has(id))) {
        throw new InboxError('HOST_INBOX_MAILBOX_UNAVAILABLE', 'Select only added mailboxes that have not been detached, then try again.', 400)
      }
      return database.transaction(() => {
        const row = select.get(owner)
        const current = row ? savedPreferences(row) : initial(mailboxes)
        if (value.revision !== current.revision) throw conflict()
        // Even an explicit empty PUT permanently opts out of automatic pin seeding.
        return save({ ...value, revision: nextRevision(current.revision) }, true, row ? current.revision : null)
      }).immediate()
    },
  }
}
