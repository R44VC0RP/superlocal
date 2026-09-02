import { Database } from 'bun:sqlite'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { LocalConfigurationError, object, readPrivateJson, ROOT_DIR, writePrivateJson, type LocalConfig } from './config'

function exists(path: string): boolean {
  try { lstatSync(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function realPath(path: string): string {
  if (exists(path)) return realpathSync(path)
  return join(realPath(dirname(path)), relative(dirname(path), path))
}

function regularFile(path: string): void {
  if (exists(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) {
    throw new LocalConfigurationError('LOCAL_DATABASE_PATH_INVALID', 'Local runtime databases must be regular files, not symlinks.')
  }
}

/** A separate host ledger binds keys, mode and instance before opening any SDK/mail database. */
export function openLocalRuntime(config: LocalConfig) {
  const root = realPath(resolve(config.dataDir))
  const checkout = realpathSync(ROOT_DIR)
  const inside = relative(checkout, root)
  if (!inside || inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)) {
    throw new LocalConfigurationError('LOCAL_DATA_DIR_IN_CHECKOUT', 'Choose a dataDir outside the source checkout. Existing pilot data is never reused or migrated.')
  }
  const dataDir = join(root, config.mode)
  if (exists(dataDir) && lstatSync(dataDir).isSymbolicLink()) {
    throw new LocalConfigurationError('LOCAL_DATA_DIR_INVALID', 'The mode data directory must not be a symlink.')
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const stat = lstatSync(dataDir)
  if (!stat.isDirectory() || process.platform !== 'win32' && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)) {
    throw new LocalConfigurationError('LOCAL_DATA_DIR_PERMISSIONS', 'The mode data directory must be owned by you and private (chmod 700 on Unix).')
  }
  const secretPath = join(dataDir, 'runtime-secrets.json')
  const hostPath = join(dataDir, 'host.sqlite')
  const mailPaths = config.mode === 'mock' ? [join(dataDir, 'mock-inbox.sqlite'), join(dataDir, 'mock-upstream.sqlite')] : [join(dataDir, 'inbox.sqlite')]
  for (const path of [hostPath, ...mailPaths]) for (const suffix of ['', '-wal', '-shm']) regularFile(`${path}${suffix}`)
  const hasHost = exists(hostPath)
  const hasHostJournal = ['-wal', '-shm'].some(suffix => exists(`${hostPath}${suffix}`))
  const hasMail = mailPaths.some(path => ['', '-wal', '-shm'].some(suffix => exists(`${path}${suffix}`)))
  if (!hasHost && (hasMail || hasHostJournal)) {
    throw new LocalConfigurationError('LOCAL_RUNTIME_IDENTITY_MISSING', 'Mail databases exist without their host identity ledger. Restore the original paired runtime; no data was imported or reset.')
  }
  if (!exists(secretPath)) {
    if (hasHost || hasMail) throw new LocalConfigurationError('LOCAL_KEY_MISSING', 'Runtime keys are missing for an existing database. Restore runtime-secrets.json from the same instance; new keys were NOT generated.')
    writePrivateJson(secretPath, { version: 1, instanceId: config.instanceId, mode: config.mode, encryptionKey: randomBytes(32).toString('hex'), sessionKey: randomBytes(32).toString('hex') })
  }
  const saved = readPrivateJson(secretPath, 'runtime-secrets.json')
  if (!object(saved) || saved.version !== 1 || saved.instanceId !== config.instanceId || saved.mode !== config.mode ||
    typeof saved.encryptionKey !== 'string' || !/^[0-9a-f]{64}$/.test(saved.encryptionKey) || typeof saved.sessionKey !== 'string' || !/^[0-9a-f]{64}$/.test(saved.sessionKey)) {
    throw new LocalConfigurationError('LOCAL_KEYS_INVALID', 'Runtime keys are invalid or belong to a different instance/mode. They were not regenerated.')
  }
  const binding = JSON.stringify([config.instanceId, config.mode, saved.sessionKey])
  const proof = createHmac('sha256', Buffer.from(saved.encryptionKey, 'hex')).update(binding).digest('hex')
  const database = new Database(hostPath, { readwrite: true, create: !hasHost })
  try {
    if (!hasHost) {
      chmodSync(hostPath, 0o600)
      database.exec('CREATE TABLE local_identity (id INTEGER PRIMARY KEY CHECK (id=1), instance_id TEXT NOT NULL, mode TEXT NOT NULL, key_proof TEXT NOT NULL)')
      database.query('INSERT INTO local_identity VALUES (1,?,?,?)').run(config.instanceId, config.mode, proof)
    }
    const table = database.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_identity'").get()
    const identity = table ? database.query<{ instance_id: string; mode: string; key_proof: string }, []>('SELECT * FROM local_identity WHERE id=1').get() : null
    if (!identity || identity.instance_id !== config.instanceId || identity.mode !== config.mode) {
      throw new LocalConfigurationError('LOCAL_RUNTIME_IDENTITY_MISMATCH', 'The data directory belongs to a different or unrecognized host instance. No mail database was opened.')
    }
    if (!/^[0-9a-f]{64}$/.test(identity.key_proof) || !timingSafeEqual(Buffer.from(proof, 'hex'), Buffer.from(identity.key_proof, 'hex'))) {
      throw new LocalConfigurationError('LOCAL_KEY_MISMATCH', 'Runtime keys do not match the existing database. Restore the original paired keys; automatic key rotation is forbidden.')
    }
    database.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;')
    return { dataDir, database, encryptionKey: saved.encryptionKey, sessionKey: saved.sessionKey }
  } catch (error) { database.close(); throw error }
}
