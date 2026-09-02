import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { createDatabaseBackup } from '../server/backup'

const arguments_ = process.argv.slice(2)

if (arguments_.includes('--help') || arguments_.includes('-h')) {
  console.info(
    'Usage: bun run scripts/backup-db.ts [destination] [--database path] [--directory path] [--overwrite]',
  )
  process.exit(0)
}

try {
  let databasePath = process.env.DATABASE_PATH ?? join(import.meta.dir, '..', 'data', 'openmail.sqlite')
  let destination: string | undefined
  let directory: string | undefined
  let overwrite = false

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]

    if (argument === '--overwrite') {
      overwrite = true
    } else if (argument === '--database' || argument === '--destination' || argument === '--directory') {
      const value = arguments_[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a path`)
      index += 1
      if (argument === '--database') databasePath = value
      if (argument === '--destination') destination = value
      if (argument === '--directory') directory = value
    } else if (!argument.startsWith('-') && !destination) {
      destination = argument
    } else {
      throw new Error(`Unrecognized backup argument: ${argument}`)
    }
  }

  if (databasePath === ':memory:') {
    throw new Error('A separate backup process cannot access an in-memory database')
  }

  const database = new Database(databasePath, { readonly: true })

  try {
    database.exec('PRAGMA busy_timeout = 5000')
    console.info(JSON.stringify(createDatabaseBackup(database, { destination, directory, overwrite })))
  } finally {
    database.close()
  }
} catch (error) {
  console.error('Database backup failed:', error instanceof Error ? error.message : 'Unknown error')
  process.exitCode = 1
}
