import { Database } from 'bun:sqlite'
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { getDatabaseSchemaVersion } from './migrations'

const encryptedBackupHeader = Buffer.from('OPENMAIL_BACKUP_V1\0', 'ascii')
const initializationVectorLength = 12
const authenticationTagLength = 16
const backupFilePattern =
  /^openmail-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f\d]{16}\.sqlite(?:\.enc)?$/

export interface DatabaseBackupOptions {
  destination?: string
  directory?: string
  overwrite?: boolean
  encryptionKey?: string | null
  now?: Date
}

export interface DatabaseRestoreOptions {
  source: string
  destination: string
  overwrite?: boolean
  encryptionKey?: string | null
}

export interface DatabaseBackupMetadata {
  path: string
  createdAt: string
  sizeBytes: number
  encrypted: boolean
  schemaVersion: number
  integrity: 'ok'
}

export interface DatabaseBackupSchedulerOptions {
  directory?: string
  intervalMs?: number
  retention?: number
  encryptionKey?: string | null
  onBackup?: (metadata: DatabaseBackupMetadata) => void
  onError?: (error: Error) => void
}

function assertSafePath(path: string, label: string): void {
  if (!path || path.includes('\0') || path.split(/[\\/]/).includes('..')) {
    throw new Error(`${label} must not be empty or contain traversal segments`)
  }
}

function decodeEncryptionKey(value: string, label: string): Buffer {
  const configured = value.trim()

  if (/^[a-f\d]{64}$/i.test(configured)) {
    return Buffer.from(configured, 'hex')
  }

  if (!/^[A-Za-z\d+/]+={0,2}$/.test(configured)) {
    throw new Error(`${label} must be an independently generated 32-byte hex or base64 value`)
  }

  const decoded = Buffer.from(configured, 'base64')

  if (
    decoded.length !== 32 ||
    decoded.toString('base64').replace(/=+$/, '') !== configured.replace(/=+$/, '')
  ) {
    throw new Error(`${label} must be an independently generated 32-byte hex or base64 value`)
  }

  return decoded
}

function getBackupEncryptionKey(configured?: string | null): Buffer | null {
  const value = configured === undefined ? process.env.BACKUP_ENCRYPTION_KEY : configured

  if (!value?.trim()) return null

  const key = decodeEncryptionKey(value, 'BACKUP_ENCRYPTION_KEY')
  const credentialKey = process.env.CREDENTIAL_ENCRYPTION_KEY?.trim()

  if (credentialKey) {
    let decodedCredentialKey: Buffer | null = null

    try {
      decodedCredentialKey = decodeEncryptionKey(credentialKey, 'CREDENTIAL_ENCRYPTION_KEY')
    } catch {
      decodedCredentialKey = null
    }

    if (decodedCredentialKey && timingSafeEqual(key, decodedCredentialKey)) {
      throw new Error('BACKUP_ENCRYPTION_KEY must not reuse CREDENTIAL_ENCRYPTION_KEY')
    }
  }

  return key
}

function resolveBackupDestination(
  database: Database,
  options: DatabaseBackupOptions,
  encrypted: boolean,
  createdAt: Date,
): string {
  const configuredDirectory = options.directory ?? process.env.DATABASE_BACKUP_DIR

  if (configuredDirectory) assertSafePath(configuredDirectory, 'Backup directory')

  let directory = configuredDirectory ? resolve(configuredDirectory) : undefined
  let destination: string

  if (options.destination) {
    assertSafePath(options.destination, 'Backup destination')
    destination = directory && !isAbsolute(options.destination)
      ? resolve(directory, options.destination)
      : resolve(options.destination)
  } else {
    if (!directory) {
      if (database.filename === ':memory:' || !database.filename) {
        throw new Error('An in-memory database backup requires an explicit backup directory')
      }

      directory = join(dirname(resolve(database.filename)), 'backups')
    }

    const timestamp = createdAt.toISOString().replace(/[:.]/g, '-')
    const suffix = encrypted ? '.sqlite.enc' : '.sqlite'
    destination = join(directory, `openmail-${timestamp}-${randomBytes(8).toString('hex')}${suffix}`)
  }

  if (directory && destination !== directory && !destination.startsWith(`${directory}${sep}`)) {
    throw new Error('Backup destination must remain inside the configured backup directory')
  }

  if (database.filename && database.filename !== ':memory:') {
    const source = resolve(database.filename)

    if ([source, `${source}-wal`, `${source}-shm`, `${source}-journal`].includes(destination)) {
      throw new Error('Backup destination must not replace the active database or its journal')
    }
  }

  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })

  if (directory) {
    const root = realpathSync(directory)
    const parent = realpathSync(dirname(destination))

    if (parent !== root && !parent.startsWith(`${root}${sep}`)) {
      throw new Error('Backup destination must not escape its configured directory through a symlink')
    }
  }

  return destination
}

function assertSafeDestination(destination: string, overwrite: boolean): void {
  try {
    const existing = lstatSync(destination)

    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error('Database destination must be a regular file, not a symlink')
    }

    if (!overwrite) {
      throw new Error('Database destination already exists; pass --overwrite to replace it')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  for (const suffix of ['-wal', '-shm', '-journal']) {
    if (existsSync(`${destination}${suffix}`)) {
      throw new Error('Database destination has active journal files; stop the application first')
    }
  }
}

function writeAll(descriptor: number, data: Buffer): void {
  let offset = 0

  while (offset < data.length) {
    offset += writeSync(descriptor, data, offset, data.length - offset)
  }
}

function readExact(descriptor: number, length: number): Buffer {
  const result = Buffer.allocUnsafe(length)
  let offset = 0

  while (offset < length) {
    const count = readSync(descriptor, result, offset, length - offset, null)

    if (count === 0) throw new Error('Encrypted database backup is truncated')
    offset += count
  }

  return result
}

function encryptDatabaseFile(source: string, destination: string, key: Buffer): void {
  const input = openSync(source, 'r')
  let output: number | undefined

  try {
    output = openSync(destination, 'wx', 0o600)
    const iv = randomBytes(initializationVectorLength)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const chunk = Buffer.allocUnsafe(1024 * 1024)
    cipher.setAAD(encryptedBackupHeader)
    writeAll(output, encryptedBackupHeader)
    writeAll(output, iv)

    for (;;) {
      const count = readSync(input, chunk, 0, chunk.length, null)
      if (count === 0) break
      writeAll(output, cipher.update(chunk.subarray(0, count)))
    }

    writeAll(output, cipher.final())
    writeAll(output, cipher.getAuthTag())
    fsyncSync(output)
  } finally {
    closeSync(input)
    if (output !== undefined) closeSync(output)
  }
}

function decryptDatabaseFile(source: string, destination: string, key: Buffer): void {
  const size = statSync(source).size
  const overhead = encryptedBackupHeader.length + initializationVectorLength + authenticationTagLength

  if (size <= overhead) throw new Error('Encrypted database backup is truncated')

  const input = openSync(source, 'r')
  let output: number | undefined

  try {
    const header = readExact(input, encryptedBackupHeader.length)

    if (!header.equals(encryptedBackupHeader)) {
      throw new Error('Unrecognized encrypted database backup format')
    }

    const iv = readExact(input, initializationVectorLength)
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    const chunk = Buffer.allocUnsafe(1024 * 1024)
    let remaining = size - overhead
    output = openSync(destination, 'wx', 0o600)
    decipher.setAAD(encryptedBackupHeader)

    while (remaining > 0) {
      const count = readSync(input, chunk, 0, Math.min(chunk.length, remaining), null)
      if (count === 0) throw new Error('Encrypted database backup is truncated')
      writeAll(output, decipher.update(chunk.subarray(0, count)))
      remaining -= count
    }

    decipher.setAuthTag(readExact(input, authenticationTagLength))
    writeAll(output, decipher.final())
    fsyncSync(output)
  } finally {
    closeSync(input)
    if (output !== undefined) closeSync(output)
  }
}

function isEncryptedDatabaseBackup(path: string): boolean {
  const descriptor = openSync(path, 'r')

  try {
    const header = Buffer.alloc(encryptedBackupHeader.length)
    const count = readSync(descriptor, header, 0, header.length, null)
    return count === header.length && header.equals(encryptedBackupHeader)
  } finally {
    closeSync(descriptor)
  }
}

function verifyDatabaseFile(path: string): number {
  const database = new Database(path, { readonly: true })

  try {
    const results = database
      .query<{ integrity_check: string }, []>('PRAGMA integrity_check')
      .all()

    if (results.length !== 1 || results[0]?.integrity_check !== 'ok') {
      throw new Error('Database integrity check failed')
    }

    return getDatabaseSchemaVersion(database)
  } finally {
    database.close()
  }
}

function synchronizeFile(path: string): void {
  const descriptor = openSync(path, 'r')

  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

function publishDatabaseFile(source: string, destination: string, overwrite: boolean): void {
  if (overwrite) {
    renameSync(source, destination)
  } else {
    try {
      linkSync(source, destination)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error('Database destination already exists; pass --overwrite to replace it')
      }

      throw error
    }

    unlinkSync(source)
  }

  synchronizeFile(dirname(destination))
}

export function createDatabaseBackup(
  database: Database,
  options: DatabaseBackupOptions = {},
): DatabaseBackupMetadata {
  const createdAt = options.now ?? new Date()

  if (Number.isNaN(createdAt.getTime())) throw new Error('Backup creation time must be a valid date')

  const encryptionKey = getBackupEncryptionKey(options.encryptionKey)
  const destination = resolveBackupDestination(database, options, encryptionKey !== null, createdAt)
  const overwrite = options.overwrite === true
  assertSafeDestination(destination, overwrite)
  const stagingDirectory = mkdtempSync(join(dirname(destination), '.openmail-backup-'))
  chmodSync(stagingDirectory, 0o700)

  try {
    const snapshot = join(stagingDirectory, 'snapshot.sqlite')
    database.query('VACUUM INTO ?').run(snapshot)
    chmodSync(snapshot, 0o600)
    synchronizeFile(snapshot)
    const schemaVersion = verifyDatabaseFile(snapshot)
    let staged = snapshot

    if (encryptionKey) {
      staged = join(stagingDirectory, 'snapshot.sqlite.enc')
      encryptDatabaseFile(snapshot, staged, encryptionKey)
      unlinkSync(snapshot)
    }

    chmodSync(staged, 0o600)
    const sizeBytes = statSync(staged).size
    publishDatabaseFile(staged, destination, overwrite)

    return {
      path: destination,
      createdAt: createdAt.toISOString(),
      sizeBytes,
      encrypted: encryptionKey !== null,
      schemaVersion,
      integrity: 'ok',
    }
  } finally {
    rmSync(stagingDirectory, { recursive: true, force: true })
  }
}

export function restoreDatabaseBackup(options: DatabaseRestoreOptions): DatabaseBackupMetadata {
  assertSafePath(options.source, 'Backup source')
  assertSafePath(options.destination, 'Restore destination')
  const source = resolve(options.source)
  const destination = resolve(options.destination)

  if (source === destination) {
    throw new Error('Backup source and restore destination must be different files')
  }

  const sourceInformation = lstatSync(source)

  if (!sourceInformation.isFile() || sourceInformation.isSymbolicLink()) {
    throw new Error('Backup source must be a regular file, not a symlink')
  }

  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
  const overwrite = options.overwrite === true
  assertSafeDestination(destination, overwrite)
  const encrypted = isEncryptedDatabaseBackup(source)
  const encryptionKey = encrypted ? getBackupEncryptionKey(options.encryptionKey) : null

  if (encrypted && !encryptionKey) {
    throw new Error('BACKUP_ENCRYPTION_KEY is required to restore an encrypted database backup')
  }

  const stagingDirectory = mkdtempSync(join(dirname(destination), '.openmail-restore-'))
  chmodSync(stagingDirectory, 0o700)

  try {
    const restored = join(stagingDirectory, 'restored.sqlite')

    if (encryptionKey) {
      decryptDatabaseFile(source, restored, encryptionKey)
    } else {
      copyFileSync(source, restored, constants.COPYFILE_EXCL)
      chmodSync(restored, 0o600)
      synchronizeFile(restored)
    }

    const schemaVersion = verifyDatabaseFile(restored)
    chmodSync(restored, 0o600)
    const sizeBytes = statSync(restored).size
    publishDatabaseFile(restored, destination, overwrite)

    return {
      path: destination,
      createdAt: new Date().toISOString(),
      sizeBytes,
      encrypted,
      schemaVersion,
      integrity: 'ok',
    }
  } finally {
    rmSync(stagingDirectory, { recursive: true, force: true })
  }
}

export function pruneDatabaseBackups(directory: string, retention: number): string[] {
  assertSafePath(directory, 'Backup directory')

  if (!Number.isSafeInteger(retention) || retention < 1) {
    throw new Error('Database backup retention must be a positive integer')
  }

  const root = resolve(directory)
  const backups = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && backupFilePattern.test(entry.name))
    .map((entry) => entry.name)
    .sort((first, second) => second.localeCompare(first))

  const removed = backups.slice(retention).map((name) => join(root, name))

  for (const path of removed) unlinkSync(path)

  if (removed.length > 0) synchronizeFile(root)

  return removed
}

function configuredPositiveInteger(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value.trim() === '') return fallback

  const parsed = Number(value)

  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`)
  }

  return parsed
}

export function startDatabaseBackupScheduler(
  database: Database,
  options: DatabaseBackupSchedulerOptions = {},
): () => void {
  const intervalMs = options.intervalMs ?? configuredPositiveInteger(
    process.env.DATABASE_BACKUP_INTERVAL_MS,
    24 * 60 * 60 * 1000,
    'DATABASE_BACKUP_INTERVAL_MS',
  )
  const retention = options.retention ?? configuredPositiveInteger(
    process.env.DATABASE_BACKUP_RETENTION_COUNT,
    7,
    'DATABASE_BACKUP_RETENTION_COUNT',
  )

  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 2_147_483_647) {
    throw new Error('Database backup interval must be between 1 and 2147483647 milliseconds')
  }

  if (!Number.isSafeInteger(retention) || retention < 1) {
    throw new Error('Database backup retention must be a positive integer')
  }

  let stopped = false
  let running = false

  function tick(): void {
    if (stopped || running) return

    running = true

    try {
      const metadata = createDatabaseBackup(database, {
        directory: options.directory,
        encryptionKey: options.encryptionKey,
      })
      pruneDatabaseBackups(dirname(metadata.path), retention)
      options.onBackup?.(metadata)
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error('Database backup failed')

      if (options.onError) {
        options.onError(error)
      } else {
        console.error('OpenMail database backup failed:', error.message)
      }
    } finally {
      running = false
    }
  }

  tick()
  const timer = setInterval(tick, intervalMs)
  timer.unref?.()

  return () => {
    stopped = true
    clearInterval(timer)
  }
}
