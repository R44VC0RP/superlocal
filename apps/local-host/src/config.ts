import { randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT_DIR = fileURLToPath(new URL('../../../', import.meta.url))
export type Mode = 'mock' | 'real'
export type SecretSource = string | { env: string } | null
/** Trusted endpoint presets, never supplied by the browser or containing mail passwords. */
export interface ImapHostPreset {
  id: string
  name: string
  imap: { host: string; port: number; secure: boolean }
  smtp?: { host: string; port: number; secure: boolean }
  sentCopy: 'server' | 'append'
}
export interface LocalConfig {
  configPath: string
  instanceId: string
  mode: Mode
  dataDir: string
  web: { port: number; origin: string; allowedOrigins: string[] }
  backend: { port: number }
  auth: { method: 'loopback' | 'google'; sessionHours: number; allowedEmails?: string[] }
  allowProviderWrites: boolean
  providers: {
    mock: { enabled: boolean }
    gmail: { enabled: boolean; oauth: { clientId: SecretSource; clientSecret: SecretSource; scopes: string[] } }
    inbound: { enabled: boolean }
    imap: { enabled: boolean; servers: ImapHostPreset[] }
  }
}

export class LocalConfigurationError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'LocalConfigurationError' }
}

function invalid(field: string): never {
  throw new LocalConfigurationError('LOCAL_CONFIG_INVALID', `Invalid ${field} in the local configuration. No credentials or databases were reset.`)
}

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function record(value: unknown, field: string, keys: string[]): Record<string, unknown> {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) invalid(field)
  return value
}

/** Only generated/explicit configuration is read; error messages never include its contents. */
export function readPrivateJson(path: string, description: string): unknown {
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 65_536 || process.platform !== 'win32' &&
      ((stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.())) {
      throw new LocalConfigurationError('LOCAL_FILE_PERMISSIONS', `${description} must be an owner-only regular file (chmod 600 on Unix).`)
    }
    return JSON.parse(readFileSync(fd, 'utf8'))
  } catch (error) {
    if (error instanceof LocalConfigurationError) throw error
    throw new LocalConfigurationError('LOCAL_FILE_UNAVAILABLE', `Could not safely read ${description}. It was not replaced or regenerated.`)
  } finally { if (fd !== undefined) closeSync(fd) }
}

/** Exclusive creation prevents a first run from overwriting an existing configuration or key. */
export function writePrivateJson(path: string, value: unknown): boolean {
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fsyncSync(fd)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw new LocalConfigurationError('LOCAL_FILE_CREATE_FAILED', 'Could not create an owner-only local configuration file. Existing files were not changed.')
  } finally { if (fd !== undefined) closeSync(fd) }
}

function port(value: unknown, field: string): number {
  if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value)
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) invalid(field)
  return value
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') invalid(field)
  return value
}

function origin(value: unknown, google = false): string {
  try {
    if (typeof value !== 'string') invalid('web origin')
    const url = new URL(value)
    if (url.origin !== value || !['http:', 'https:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1', '[::1]', 'super.local'].includes(url.hostname) && !(google && url.protocol === 'https:')) invalid('web origin')
    return value
  } catch { return invalid('web origin (public origins require Google authentication and HTTPS)') }
}

/** Exact addresses only: case/edge whitespace normalize; Gmail dots and plus tags do not. */
export function normalizeAllowedEmails(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 256) invalid('auth.allowedEmails')
  return [...new Set(value.map(email => {
    if (typeof email !== 'string') invalid('auth.allowedEmails')
    const normalized = email.trim().toLowerCase()
    if (normalized.length > 254 || !/^[a-z0-9.!#$%&'+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(normalized) || normalized.includes('..')) invalid('auth.allowedEmails (exact email addresses only)')
    return normalized
  }))]
}

function secretSource(value: unknown, field: string): SecretSource {
  if (value === null) return null
  if (typeof value === 'string' && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value)) return value
  if (object(value) && Object.keys(value).join(',') === 'env' && typeof value.env === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value.env)) return { env: value.env }
  return invalid(field)
}

export function resolveSecret(source: SecretSource, environment: NodeJS.ProcessEnv): string | undefined {
  const value = typeof source === 'string' ? source : source === null ? undefined : environment[source.env]
  if (value === undefined || value === '') return undefined
  if (value.length > 4096 || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value)) invalid('explicit OAuth credential')
  return value
}

function defaults() {
  return {
    version: 1, instanceId: randomUUID(), mode: 'mock', dataDir: null,
    web: { port: 5178, origin: null, allowedOrigins: ['https://super.local'] },
    backend: { port: 8790 }, auth: { method: 'loopback', sessionHours: 12 },
    allowProviderWrites: { mock: true, real: true },
    providers: {
      mock: { enabled: true },
      gmail: { enabled: false, oauth: {
        clientId: { env: 'SUPERLOCAL_GOOGLE_CLIENT_ID' }, clientSecret: { env: 'SUPERLOCAL_GOOGLE_CLIENT_SECRET' },
        scopes: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.send'],
      } },
      inbound: { enabled: false },
      imap: { enabled: true, servers: [] },
    },
  }
}

function userDataDir(environment: NodeJS.ProcessEnv): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support')
  if (process.platform === 'win32') return environment.LOCALAPPDATA && isAbsolute(environment.LOCALAPPDATA) ? environment.LOCALAPPDATA : join(homedir(), 'AppData', 'Local')
  return environment.XDG_DATA_HOME && isAbsolute(environment.XDG_DATA_HOME) ? environment.XDG_DATA_HOME : join(homedir(), '.local', 'share')
}

export function loadLocalConfig(options: { configPath?: string; environment?: NodeJS.ProcessEnv } = {}): LocalConfig {
  const environment = options.environment ?? process.env
  const configPath = resolve(options.configPath ?? environment.SUPERLOCAL_CONFIG ?? join(ROOT_DIR, 'superlocal.local.json'))
  writePrivateJson(configPath, defaults())
  const input = record(readPrivateJson(configPath, 'superlocal.local.json'), 'root', ['version', 'instanceId', 'mode', 'dataDir', 'web', 'backend', 'auth', 'allowProviderWrites', 'providers'])
  if (input.version !== 1) invalid('version')
  if (typeof input.instanceId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.instanceId)) invalid('instanceId')
  if (input.mode !== 'mock' && input.mode !== 'real') invalid('mode')
  const web = record(input.web, 'web', ['port', 'origin', 'allowedOrigins'])
  const backend = record(input.backend, 'backend', ['port'])
  const auth = record(input.auth, 'auth', ['method', 'sessionHours', 'allowedEmails'])
  const authMethod = environment.SUPERLOCAL_AUTH_METHOD ?? auth.method
  if (authMethod !== 'loopback' && authMethod !== 'google') invalid('auth.method')
  if (authMethod === 'loopback' && environment.NODE_ENV?.trim().toLowerCase() === 'production') {
    throw new LocalConfigurationError('LOCAL_PRODUCTION_REFUSED', 'This loopback development host cannot run with NODE_ENV=production.')
  }
  const allowedEmails = normalizeAllowedEmails(environment.SUPERLOCAL_AUTH_ALLOWED_EMAILS === undefined ? auth.allowedEmails ?? [] :
    environment.SUPERLOCAL_AUTH_ALLOWED_EMAILS.trim() === '' ? [] : environment.SUPERLOCAL_AUTH_ALLOWED_EMAILS.split(','))
  const writes = record(input.allowProviderWrites, 'allowProviderWrites', ['mock', 'real'])
  const providers = record(input.providers, 'providers', ['mock', 'gmail', 'inbound', 'imap'])
  const mock = record(providers.mock, 'providers.mock', ['enabled'])
  const gmail = record(providers.gmail, 'providers.gmail', ['enabled', 'oauth'])
  const inbound = record(providers.inbound, 'providers.inbound', ['enabled'])
  const imap = record(providers.imap ?? { enabled: true, servers: [] }, 'providers.imap', ['enabled', 'servers'])
  if (!Array.isArray(imap.servers ?? []) || ((imap.servers ?? []) as unknown[]).length > 16) invalid('providers.imap.servers')
  const imapServers: ImapHostPreset[] = ((imap.servers ?? []) as unknown[]).map(value => {
    const server = record(value, 'IMAP server preset', ['id', 'name', 'imap', 'smtp', 'sentCopy'])
    if (typeof server.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(server.id) || server.id === 'icloud') invalid('IMAP preset id')
    if (typeof server.name !== 'string' || !server.name.trim() || server.name.length > 80 || /[\x00-\x1f\x7f]/.test(server.name)) invalid('IMAP preset name')
    const endpoint = (value: unknown) => {
      const input = record(value, 'mail endpoint', ['host', 'port', 'secure'])
      if (typeof input.host !== 'string' || input.host.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(input.host) ||
        /(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/i.test(input.host)) invalid('public mail server hostname')
      return { host: input.host.toLowerCase(), port: port(input.port, 'mail server port'), secure: bool(input.secure, 'mail transport (false requires STARTTLS)') }
    }
    if (server.sentCopy !== 'server' && server.sentCopy !== 'append') invalid('IMAP Sent-copy policy')
    return { id: server.id, name: server.name, imap: endpoint(server.imap), ...(server.smtp ? { smtp: endpoint(server.smtp) } : {}), sentCopy: server.sentCopy }
  })
  if (new Set(imapServers.map(server => server.id)).size !== imapServers.length) invalid('unique IMAP preset ids')
  const oauth = record(gmail.oauth, 'providers.gmail.oauth', ['clientId', 'clientSecret', 'scopes'])
  if (typeof auth.sessionHours !== 'number' || !Number.isInteger(auth.sessionHours) || auth.sessionHours < 1 || auth.sessionHours > 24) invalid('auth (1–24 sessionHours)')
  if (!Array.isArray(oauth.scopes) || oauth.scopes.length > 64 || oauth.scopes.some(scope => typeof scope !== 'string' || !/^[\x21\x23-\x5b\x5d-\x7e]{1,2048}$/.test(scope)) ||
    !oauth.scopes.includes('openid') || !oauth.scopes.includes('email') || oauth.scopes.join(' ').length > 8192) invalid('providers.gmail.oauth.scopes')
  if (!Array.isArray(web.allowedOrigins) || web.allowedOrigins.length > 16) invalid('web.allowedOrigins')
  const webPort = port(environment.SUPERLOCAL_WEB_PORT ?? web.port, 'web.port')
  const apiPort = port(environment.SUPERLOCAL_API_PORT ?? backend.port, 'backend.port')
  if (webPort === apiPort) invalid('ports (web and backend must differ)')
  const webOrigin = origin(environment.SUPERLOCAL_WEB_ORIGIN ?? web.origin ?? `http://localhost:${webPort}`, authMethod === 'google')
  const allowedOrigins = web.allowedOrigins.map(value => origin(value, authMethod === 'google'))
  const configuredDataDir = environment.SUPERLOCAL_DATA_DIR ?? input.dataDir
  if (configuredDataDir !== null && (typeof configuredDataDir !== 'string' || !configuredDataDir.trim() || configuredDataDir.includes('\0'))) invalid('dataDir')
  const dataDir = configuredDataDir === null ? join(userDataDir(environment), 'superlocal', input.instanceId) : resolve(dirname(configPath), configuredDataDir as string)
  const policy = { mock: bool(writes.mock, 'allowProviderWrites.mock'), real: bool(writes.real, 'allowProviderWrites.real') }
  const enabledMock = bool(mock.enabled, 'providers.mock.enabled')
  if (input.mode === 'mock' && !enabledMock) invalid('providers.mock.enabled (mock mode requires its offline provider)')
  return {
    configPath, instanceId: input.instanceId, mode: input.mode, dataDir,
    web: { port: webPort, origin: webOrigin, allowedOrigins: authMethod === 'google' ? [webOrigin] : [...new Set([webOrigin, `http://localhost:${webPort}`, `http://127.0.0.1:${webPort}`, ...allowedOrigins])] },
    backend: { port: apiPort }, auth: { method: authMethod, sessionHours: auth.sessionHours, allowedEmails }, allowProviderWrites: policy[input.mode],
    providers: { mock: { enabled: enabledMock }, inbound: { enabled: bool(inbound.enabled, 'providers.inbound.enabled') },
      imap: { enabled: bool(imap.enabled, 'providers.imap.enabled'), servers: imapServers }, gmail: {
      enabled: bool(gmail.enabled, 'providers.gmail.enabled'), oauth: {
        clientId: secretSource(oauth.clientId, 'providers.gmail.oauth.clientId'), clientSecret: secretSource(oauth.clientSecret, 'providers.gmail.oauth.clientSecret'), scopes: oauth.scopes as string[],
      },
    } },
  }
}
