import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runDatabaseMigrations } from './migrations'

const databasePath =
  process.env.DATABASE_PATH ?? join(import.meta.dir, '..', 'data', 'inbox.sqlite')

if (databasePath !== ':memory:') {
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 })
}

export const sqlite = new Database(databasePath, { create: true })

export function initDatabase(): void {
  sqlite.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
  `)

  runDatabaseMigrations(sqlite)
}

initDatabase()
