import type { Database } from 'bun:sqlite'
import { InboxError } from 'inbox-sdk'
import { normalizeSplits, type SplitPreferences } from '../../shared/splits'
import { object } from './config'

export type SavedSplitPreferences = SplitPreferences & { revision: number }
export function createSplitPreferencesStore(database: Database, owner: string) {
  database.exec('CREATE TABLE IF NOT EXISTS local_split_preferences (owner TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL) STRICT')
  const read = (): SavedSplitPreferences | null => {
    const row = database.query<{ revision: number; data: string }, [string]>('SELECT revision,data FROM local_split_preferences WHERE owner=?').get(owner)
    return row ? { ...JSON.parse(row.data), revision: row.revision } : null
  }
  return {
    read,
    write(input: unknown): SavedSplitPreferences {
      if (!object(input) || !Number.isSafeInteger(input.revision) || Number(input.revision) < 0 || input.version !== 1 || Object.keys(input).some(key => !['revision', 'version', 'splits', 'inactiveSplits', 'splitRules', 'splitAliases'].includes(key))) throw new InboxError('HOST_SPLITS_INVALID', 'Provide the current split preferences and revision.', 400)
      for (const key of ['splits', 'inactiveSplits'] as const) {
        const value = input[key]
        if (!Array.isArray(value) || value.length > 100 || value.some(name => typeof name !== 'string' || !name.trim() || name.length > 40 || name !== name.trim()) || new Set(value.map(name => name.toLowerCase())).size !== value.length) throw new InboxError('HOST_SPLITS_INVALID', 'Use up to 100 unique split names of at most 40 characters.', 400)
      }
      for (const key of ['splitRules', 'splitAliases']) {
        const value = input[key]
        if (!object(value) || Object.keys(value).length > 200 || Object.entries(value).some(([name, rule]) => name.length > 40 || typeof rule !== 'string' || rule.length > 4096)) throw new InboxError('HOST_SPLITS_INVALID', 'Invalid split filters or aliases.', 400)
      }
      return database.transaction(() => {
        const current = read()
        if ((current?.revision ?? 0) !== input.revision) throw new InboxError('HOST_SPLITS_CONFLICT', 'Splits changed elsewhere. Reload before saving again.', 412)
        const value = normalizeSplits(input), revision = Number(input.revision) + 1
        if (!Number.isSafeInteger(revision)) throw new InboxError('HOST_SPLITS_INVALID', 'The split revision cannot be advanced.', 400)
        database.query('INSERT INTO local_split_preferences VALUES (?,?,?) ON CONFLICT(owner) DO UPDATE SET revision=excluded.revision,data=excluded.data').run(owner, revision, JSON.stringify(value))
        return { ...value, revision }
      }).immediate()
    },
  }
}
