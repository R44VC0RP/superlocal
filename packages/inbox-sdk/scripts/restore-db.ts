import { join } from 'node:path'
import { restoreDatabaseBackup } from '../server/backup'

const arguments_ = process.argv.slice(2)

if (arguments_.includes('--help') || arguments_.includes('-h')) {
  console.info(
    'Usage: bun run scripts/restore-db.ts <backup> [destination] [--database path] [--overwrite]',
  )
  process.exit(0)
}

try {
  let source: string | undefined
  let destination: string | undefined
  let overwrite = false

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]

    if (argument === '--overwrite') {
      overwrite = true
    } else if (argument === '--source' || argument === '--destination' || argument === '--database') {
      const value = arguments_[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a path`)
      index += 1
      if (argument === '--source') source = value
      if (argument === '--destination' || argument === '--database') destination = value
    } else if (!argument.startsWith('-') && !source) {
      source = argument
    } else if (!argument.startsWith('-') && !destination) {
      destination = argument
    } else {
      throw new Error(`Unrecognized restore argument: ${argument}`)
    }
  }

  if (!source) throw new Error('A database backup source is required')

  destination ??= process.env.DATABASE_PATH ?? join(import.meta.dir, '..', 'data', 'openmail.sqlite')

  if (destination === ':memory:') {
    throw new Error('A separate restore process cannot replace an in-memory database')
  }

  console.info(JSON.stringify(restoreDatabaseBackup({ source, destination, overwrite })))
} catch (error) {
  console.error('Database restore failed:', error instanceof Error ? error.message : 'Unknown error')
  process.exitCode = 1
}
