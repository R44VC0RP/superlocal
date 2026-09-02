import { randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const MOCK_HOSTNAME = '127.0.0.1' as const
export const MOCK_UI_ORIGINS = Object.freeze([
  'https://super.local',
  'http://localhost:5178', 'http://127.0.0.1:5178', 'http://super.local:5178',
  'https://localhost:5178', 'https://127.0.0.1:5178', 'https://super.local:5178',
])

export class MockConfigurationError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'MockConfigurationError' }
}

export interface MockConfigOverrides {
  dataDir?: string
  port?: number
  token?: string
  encryptionKey?: string
  allowProviderWrites?: boolean
}

export interface MockConfig {
  dataDir: string
  port: number
  token: string
  encryptionKey: string
  allowProviderWrites: boolean
  upstreamPath: string
  cachePath: string
}

function checkToken(value: unknown): string {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{32,1024}$/.test(value.trim())) {
    throw new MockConfigurationError('MOCK_TOKEN_INVALID', 'MOCK_API_TOKEN must contain 32–1024 non-whitespace ASCII characters.')
  }
  return value.trim()
}

function checkKey(value: unknown): string {
  if (typeof value !== 'string') throw new MockConfigurationError('MOCK_KEY_INVALID', 'MOCK_ENCRYPTION_KEY must encode exactly 32 bytes as hex or base64.')
  const input = value.trim()
  if (/^[a-f0-9]{64}$/i.test(input)) return input.toLowerCase()
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(input)) {
    const bytes = Buffer.from(input, 'base64')
    if (bytes.length === 32 && bytes.toString('base64').replace(/=+$/, '') === input.replace(/=+$/, '')) return bytes.toString('hex')
  }
  throw new MockConfigurationError('MOCK_KEY_INVALID', 'MOCK_ENCRYPTION_KEY must encode exactly 32 bytes as hex or base64.')
}

function privateSecrets(path: string): { token: string; encryptionKey: string } {
  let fd: number | undefined
  try {
    try {
      fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      const record = { version: 1, token: randomBytes(32).toString('base64url'), encryptionKey: randomBytes(32).toString('hex') }
      writeFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8')
      fsyncSync(fd)
      return record
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    } finally { if (fd !== undefined) { closeSync(fd); fd = undefined } }
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = fstatSync(fd)
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 8192) {
      throw new MockConfigurationError('MOCK_SECRET_FILE_INVALID', 'The mock-only credential file must be a regular mode-0600 file.')
    }
    const parsed: unknown = JSON.parse(readFileSync(fd, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(',') !== 'encryptionKey,token,version' || (parsed as { version?: unknown }).version !== 1) {
      throw new MockConfigurationError('MOCK_SECRET_FILE_INVALID', 'Invalid mock-only credential file; refusing to regenerate existing credentials.')
    }
    const record = parsed as { token: unknown; encryptionKey: unknown }
    return { token: checkToken(record.token), encryptionKey: checkKey(record.encryptionKey) }
  } catch (error) {
    if (error instanceof MockConfigurationError) throw error
    throw new MockConfigurationError('MOCK_SECRET_FILE_UNAVAILABLE', 'Could not safely load the mock-only credential file. Existing credentials were not reset.')
  } finally { if (fd !== undefined) closeSync(fd) }
}

function checkDatabasePath(path: string): void {
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new MockConfigurationError('MOCK_DATABASE_PATH_INVALID', 'Mock databases must be regular files, not symlinks.')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/** Deliberately reads only MOCK_* configuration and NODE_ENV; never INBOX_*, OAuth, or real-mail secrets. */
export function readMockConfig(overrides: MockConfigOverrides = {}, environment: NodeJS.ProcessEnv = process.env): MockConfig {
  if (environment.NODE_ENV?.trim().toLowerCase() === 'production') throw new MockConfigurationError('MOCK_PRODUCTION_REFUSED', 'The offline mock API cannot run with NODE_ENV=production.')
  const configuredPort = overrides.port ?? environment.MOCK_API_PORT ?? 8790
  if (typeof configuredPort !== 'number' && !/^\d+$/.test(configuredPort)) throw new MockConfigurationError('MOCK_PORT_INVALID', 'MOCK_API_PORT must be an integer from 0 to 65535.')
  const port = Number(configuredPort)
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new MockConfigurationError('MOCK_PORT_INVALID', 'MOCK_API_PORT must be an integer from 0 to 65535.')
  const directory = overrides.dataDir ?? environment.MOCK_DATA_DIR ?? fileURLToPath(new URL('../data/', import.meta.url))
  if (typeof directory !== 'string' || !directory.trim() || directory.includes('\0')) throw new MockConfigurationError('MOCK_DATA_DIR_INVALID', 'MOCK_DATA_DIR must be a local directory path.')
  const dataDir = resolve(directory)
  const suppliedToken = overrides.token ?? environment.MOCK_API_TOKEN
  const suppliedKey = overrides.encryptionKey ?? environment.MOCK_ENCRYPTION_KEY
  let token = suppliedToken === undefined ? undefined : checkToken(suppliedToken)
  let encryptionKey = suppliedKey === undefined ? undefined : checkKey(suppliedKey)
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  if (token === undefined || encryptionKey === undefined) {
    const saved = privateSecrets(join(dataDir, 'mock-local.json'))
    token ??= saved.token
    encryptionKey ??= saved.encryptionKey
  }
  const upstreamPath = join(dataDir, 'mock-upstream.sqlite')
  const cachePath = join(dataDir, 'mock-inbox.sqlite')
  checkDatabasePath(upstreamPath); checkDatabasePath(cachePath)
  if (overrides.allowProviderWrites !== undefined && typeof overrides.allowProviderWrites !== 'boolean') throw new MockConfigurationError('MOCK_WRITE_POLICY_INVALID', 'allowProviderWrites must be a boolean.')
  return { dataDir, port, token, encryptionKey, allowProviderWrites: overrides.allowProviderWrites ?? true, upstreamPath, cachePath }
}
