import { Database } from 'bun:sqlite'
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, type Stats } from 'node:fs'
import { lstat, mkdir, open, opendir, rename, rmdir, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { InboxError } from 'inbox-sdk'
import { ISSUE_LIMITS, type IssueCapture, type IssueDetail, type IssueImage, type IssueLog, type IssuePage, type IssueSummary, type IssueWrite } from '../../shared/issue-reports'
import { object, ROOT_DIR, type LocalConfig } from './config'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const HASH = /^[0-9a-f]{64}$/
const REPORT_BYTES = 64 * 1024
const TIMING_BYTES = 256 * 1024
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin', 'Referrer-Policy': 'no-referrer', Vary: 'Origin, Cookie' }
const activeScopes = new Map<string, number>()
function fail(status: number, code: string, message: string): never { throw new InboxError(`HOST_ISSUE_${code}`, message, status) }
function invalid(): never { return fail(400, 'INVALID', 'Invalid issue metadata or request.') }
function unsafe(): never { return fail(409, 'UNSAFE_STORAGE', 'Issue storage must contain only owned, private regular files and directories. Existing files were not changed.') }
function quota(): never { return fail(507, 'QUOTA', 'The local issue storage limit has been reached. Existing reports were preserved.') }
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const encode = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
const jsonl = (values: unknown[]) => values.length ? values.map(value => JSON.stringify(value)).join('\n') + '\n' : ''
const finite = (value: unknown, min: number, max: number, integer = false): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value))
const oneOf = (value: unknown, values: readonly string[]): value is string => typeof value === 'string' && values.includes(value)
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) invalid()
  return value
}
function text(value: unknown, max: number, multiline = false): string {
  if (typeof value !== 'string' || value.length > max || (multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(value)) invalid()
  return value
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid()
  return value
}

const credentialKey = /(?:token|secret|password|passwd|credential|authorization|cookie|session|api[-_]?key|^key$|^code$|^auth$)/i
function cleanURL(url: URL): string {
  url.username = ''; url.password = ''
  for (const key of [...url.searchParams.keys()]) if (credentialKey.test(key)) url.searchParams.set(key, '[redacted]')
  // Keep normal app hashes (including route parameters), but not OAuth/key fragments.
  if (url.hash) {
    const hash = url.hash.slice(1), split = hash.indexOf('?')
    const prefix = split >= 0 ? hash.slice(0, split + 1) : ''
    const params = new URLSearchParams(split >= 0 ? hash.slice(split + 1) : hash)
    let changed = false
    for (const key of [...params.keys()]) if (credentialKey.test(key)) { params.set(key, '[redacted]'); changed = true }
    if (changed) url.hash = prefix + params.toString()
  }
  return url.href
}
function redact(value: string): string {
  return value.replace(/https?:\/\/[^\s<>"']+/gi, raw => { try { return cleanURL(new URL(raw)) } catch { return '[redacted URL]' } })
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, '[redacted credential]')
    .replace(/((?:["']?)(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|password|passwd|secret|authorization|cookie|session[_-]?(?:key|id|token)?)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&}]+)/gi, '$1[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted credential]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,})\b/g, '[redacted credential]')
}
function logs(value: unknown): IssueLog[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > ISSUE_LIMITS.logs) invalid()
  return value.map(entry => {
    const row = record(entry, ['time', 'level', 'message'])
    if (!oneOf(row.level, ['debug', 'log', 'info', 'warn', 'error'])) invalid()
    return { time: timestamp(row.time), level: row.level as IssueLog['level'], message: redact(text(row.message, ISSUE_LIMITS.logCharacters, true)).slice(0, ISSUE_LIMITS.logCharacters) }
  })
}
function normalize(value: unknown, id: string, scope: string, origins: Set<string>): IssueWrite & { logs: IssueLog[] } {
  const row = record(value, ['id', 'scope', 'revision', 'prompt', 'url', 'title', 'capturedAt', 'updatedAt', 'viewport', 'build', 'rendering', 'logs'])
  if (row.id !== id || !UUID.test(id) || !finite(row.revision, 0, Number.MAX_SAFE_INTEGER - 1, true)) invalid()
  if (row.scope !== scope) fail(409, 'SCOPE', 'This issue belongs to a different local host scope.')
  let url: URL
  try { url = new URL(text(row.url, 8192)) } catch { return invalid() }
  if (!['http:', 'https:'].includes(url.protocol) || !origins.has(url.origin)) invalid()
  const viewport = record(row.viewport, ['width', 'height', 'pixelRatio'])
  if (!finite(viewport.width, 1, 16384, true) || !finite(viewport.height, 1, 16384, true) || !finite(viewport.pixelRatio, 0.1, 16)) invalid()
  const result: IssueWrite & { logs: IssueLog[] } = {
    id, scope, revision: row.revision, prompt: text(row.prompt, ISSUE_LIMITS.promptCharacters, true), url: cleanURL(url),
    title: text(row.title, 512), capturedAt: timestamp(row.capturedAt), updatedAt: timestamp(row.updatedAt),
    viewport: { width: viewport.width, height: viewport.height, pixelRatio: viewport.pixelRatio }, logs: logs(row.logs),
  }
  if (row.build !== undefined) {
    const build = record(row.build, ['mode', 'assets'])
    if (!oneOf(build.mode, ['optimized', 'development', 'unknown']) || !Array.isArray(build.assets) || build.assets.length > 32) invalid()
    const assets = build.assets.map(asset => {
      const path = text(asset, 512)
      if (!/^\/(?!\/)[A-Za-z0-9_./@-]+$/.test(path) || path.split('/').some(part => part === '.' || part === '..') || !/\.(?:[cm]?js|css|tsx?)$/.test(path)) invalid()
      return path
    })
    result.build = { mode: build.mode as NonNullable<IssueCapture['build']>['mode'], assets: [...new Set(assets)].sort() }
  }
  if (row.rendering !== undefined) {
    if (!Array.isArray(row.rendering) || row.rendering.length > ISSUE_LIMITS.frames) invalid()
    result.rendering = row.rendering.map(entry => {
      const frame = record(entry, ['width', 'height', 'scrollWidth', 'bodyScrollWidth', 'scale'])
      if (!finite(frame.width, 0, 1_000_000) || !finite(frame.height, 0, 1_000_000)) invalid()
      const output: NonNullable<IssueCapture['rendering']>[number] = { width: frame.width, height: frame.height }
      for (const key of ['scrollWidth', 'bodyScrollWidth', 'scale'] as const) if (frame[key] !== undefined) {
        if (!finite(frame[key], key === 'scale' ? 0.0001 : 0, key === 'scale' ? 100 : 1_000_000)) invalid()
        output[key] = frame[key]
      }
      return output
    })
  }
  return result
}

/** Bounded container/header inspection only: no image decoder or external resources. */
function imageInfo(b: Buffer, contentType: string): IssueImage {
  let width = 0, height = 0, valid = false
  if (contentType === 'image/png' && b.length >= 45 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && b.readUInt32BE(8) === 13 && b.toString('ascii', 12, 16) === 'IHDR') {
    width = b.readUInt32BE(16); height = b.readUInt32BE(20)
    const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }
    if (!depths[b[25]!]?.includes(b[24]!) || b[26] !== 0 || b[27] !== 0 || b[28]! > 1) fail(415, 'IMAGE', 'Use a bounded PNG or JPEG screenshot.')
    let data = false, chunks = 0
    for (let offset = 8; offset + 12 <= b.length && ++chunks <= 65536;) {
      const size = b.readUInt32BE(offset), tag = b.toString('ascii', offset + 4, offset + 8)
      if (size > b.length - offset - 12 || tag === 'IHDR' && offset !== 8 || ['acTL', 'fcTL', 'fdAT'].includes(tag)) break
      if (tag === 'IDAT' && size > 0) data = true
      offset += size + 12
      if (tag === 'IEND') { valid = data && size === 0 && offset === b.length; break }
    }
  } else if (contentType === 'image/jpeg' && b.length >= 4 && b.readUInt16BE(0) === 0xffd8 && b.readUInt16BE(b.length - 2) === 0xffd9) {
    let markers = 0
    for (let offset = 2; offset + 4 <= b.length && ++markers <= 65536;) {
      if (b[offset++] !== 0xff) break
      while (b[offset] === 0xff) offset++
      const marker = b[offset++]
      if (marker === undefined || offset + 2 > b.length) break
      const size = b.readUInt16BE(offset)
      if (size < 2 || offset + size > b.length) break
      if (marker === 0xda) { valid = width > 0 && size >= 6 && offset + size < b.length - 2; break }
      if ([0xc0, 0xc1, 0xc2].includes(marker) && size >= 8) {
        if (width || b[offset + 2] !== 8) break
        height = b.readUInt16BE(offset + 3); width = b.readUInt16BE(offset + 5)
      }
      offset += size
    }
  }
  if (!valid || !width || !height || width > 16384 || height > 16384 || width * height > 64 * 1024 * 1024) fail(415, 'IMAGE', 'Use a bounded PNG or JPEG screenshot.')
  return { contentType: contentType as IssueImage['contentType'], bytes: b.length, width, height, sha256: sha(b) }
}

async function multipart(request: Request): Promise<{ metadata: unknown; screenshot: Buffer; image: IssueImage }> {
  const type = request.headers.get('content-type') ?? ''
  const boundary = /^multipart\/form-data;\s*boundary=(?:"([A-Za-z0-9'()+_,./:=?-]{1,70})"|([A-Za-z0-9'()+_,./:=?-]{1,70}))$/i.exec(type)
  if (!boundary || request.headers.has('content-encoding') && request.headers.get('content-encoding') !== 'identity') fail(415, 'MULTIPART', 'Use unencoded multipart/form-data with report and screenshot parts.')
  const length = request.headers.get('content-length')
  if (length && (!/^\d+$/.test(length) || Number(length) > ISSUE_LIMITS.requestBytes)) fail(413, 'SIZE', 'Issue input exceeds the size limit.')
  if (!request.body) invalid()
  const reader = request.body.getReader(), chunks: Uint8Array[] = []
  let size = 0, timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      (async () => {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > ISSUE_LIMITS.requestBytes) { void reader.cancel().catch(() => undefined); fail(413, 'SIZE', 'Issue input exceeds the size limit.') }
          chunks.push(value)
        }
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new InboxError('HOST_ISSUE_TIMEOUT', 'Issue upload timed out.', 408)); void reader.cancel().catch(() => undefined) }, 15_000) }),
    ])
  } finally { clearTimeout(timer); reader.releaseLock() }
  // Bun's formData() derives a File's MIME from its filename, not its part header.
  // Parse only this two-part protocol so neither the filename nor MIME sniffing can override the declared type.
  const bytes = Buffer.concat(chunks), delimiter = Buffer.from(`--${boundary[1] ?? boundary[2]}`), next = Buffer.concat([Buffer.from('\r\n'), delimiter])
  const parts = new Map<string, { bytes: Buffer; type: string; file: boolean }>()
  let offset = 0, finished = false
  while (!finished) {
    if (parts.size >= 2 || !bytes.subarray(offset, offset + delimiter.length).equals(delimiter) || bytes.toString('ascii', offset + delimiter.length, offset + delimiter.length + 2) !== '\r\n') invalid()
    offset += delimiter.length + 2
    const endHeaders = bytes.indexOf('\r\n\r\n', offset)
    if (endHeaders < offset || endHeaders - offset > 2048) invalid()
    const headerBytes = bytes.subarray(offset, endHeaders)
    if (headerBytes.some(byte => byte !== 13 && byte !== 10 && (byte < 32 || byte > 126))) invalid()
    const fields = new Map<string, string>()
    for (const line of headerBytes.toString('ascii').split('\r\n')) {
      const match = /^(Content-Disposition|Content-Type):\s*(.+)$/i.exec(line)
      if (!match || fields.has(match[1]!.toLowerCase())) invalid()
      fields.set(match[1]!.toLowerCase(), match[2]!)
    }
    const disposition = /^form-data;\s*name="(report|screenshot)"(?:;\s*filename="[^"\r\n]{1,255}")?$/.exec(fields.get('content-disposition') ?? '')
    if (!disposition) invalid()
    const name = disposition[1]!, file = /;\s*filename=/.test(disposition[0]), contentType = fields.get('content-type')?.toLowerCase() ?? ''
    if (parts.has(name) || file !== (name === 'screenshot') || name === 'report' && contentType && !['application/json', 'text/plain', 'text/plain; charset=utf-8', 'application/json; charset=utf-8'].includes(contentType)) invalid()
    const start = endHeaders + 4
    let end = bytes.indexOf(next, start)
    while (end >= 0 && !['--', '\r\n'].includes(bytes.toString('ascii', end + next.length, end + next.length + 2))) end = bytes.indexOf(next, end + next.length)
    if (end < 0) invalid()
    if (end - start > (name === 'report' ? ISSUE_LIMITS.metadataBytes : ISSUE_LIMITS.screenshotBytes)) fail(413, 'SIZE', 'Issue input exceeds the size limit.')
    parts.set(name, { bytes: bytes.subarray(start, end), type: contentType, file })
    offset = end + 2
    if (bytes.toString('ascii', offset + delimiter.length, offset + delimiter.length + 2) === '--') {
      const suffix = bytes.subarray(offset + delimiter.length + 2)
      if (suffix.length && !suffix.equals(Buffer.from('\r\n'))) invalid()
      finished = true
    }
  }
  const report = parts.get('report'), screenshot = parts.get('screenshot')
  if (parts.size !== 2 || !report || !screenshot) invalid()
  let metadata: unknown
  try { metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(report.bytes)) } catch { return invalid() }
  return { metadata, screenshot: screenshot.bytes, image: imageInfo(screenshot.bytes, screenshot.type) }
}

function owned(stat: Stats, directory: boolean, privateMode = true): void {
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) || stat.uid !== process.getuid?.() || (privateMode ? (stat.mode & 0o777) !== (directory ? 0o700 : 0o600) : (stat.mode & 0o022) !== 0)) unsafe()
}
async function directory(path: string, create: boolean, privateMode = true): Promise<boolean> {
  try { owned(await lstat(path), true, privateMode); return true } catch (error) {
    if (!missing(error)) throw error
    if (!create) return false
    try { await mkdir(path, { mode: 0o700 }); await syncDirectory(dirname(path)) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    owned(await lstat(path), true, privateMode)
    return true
  }
}
async function syncDirectory(path: string): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { owned(await file.stat(), true, false); await file.sync() } finally { await file.close() }
}
async function readFile(path: string, max: number, tail = false): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await file.stat(); owned(stat, false)
    if (!tail && stat.size > max) unsafe()
    const position = tail ? Math.max(0, stat.size - max) : 0
    const buffer = Buffer.alloc(Math.min(stat.size, max))
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, position + offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    const result = buffer.subarray(0, offset)
    return tail && position > 0 ? result.subarray(result.indexOf(10) >= 0 ? result.indexOf(10) + 1 : result.length) : result
  } finally { await file.close() }
}
async function writeFile(path: string, contents: string | Buffer): Promise<void> {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { owned(await file.stat(), false); await file.writeFile(contents); await file.sync() } finally { await file.close() }
}

// Intentionally independent of the optional performance feature. Only its content-free schema is retained.
function timing(value: unknown, captured: number, mode: string): Record<string, unknown> | null {
  if (!object(value) || !finite(value.at, captured - 60_000, captured + 1000) || !finite(value.durationMs, 0, 86_400_000) || !oneOf(value.kind, ['action', 'input', 'work', 'refresh', 'rebuild', 'thread', 'request']) || !oneOf(value.outcome, ['ok', 'error', 'ignored', 'hidden'])) return null
  if (value.mode !== undefined && value.mode !== mode) return null
  const out: Record<string, unknown> = { kind: value.kind, at: value.at, durationMs: value.durationMs, outcome: value.outcome }
  const enums: Record<string, string[]> = {
    action: ['done', 'not-important', 'undo', 'undo-done', 'undo-feedback', 'open', 'read', 'unread', 'star', 'trash', 'spam', 'inbox', 'remind', 'label', 'undo-label', 'save-draft', 'send', 'search', 'other'],
    route: ['mailboxes', 'mailbox-page', 'mailbox-action', 'feedback', 'operation', 'message-body', 'draft', 'other'],
    method: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD'],
  }
  for (const [key, choices] of Object.entries(enums)) if (value[key] !== undefined) { if (!oneOf(value[key], choices)) return null; out[key] = value[key] }
  for (const key of ['queueMs', 'acceptedMs', 'processingMs', 'networkMs', 'messages', 'conversations', 'pages', 'status', 'receivedAt']) if (value[key] !== undefined) {
    const count = ['messages', 'conversations', 'pages', 'status'].includes(key)
    if (!finite(value[key], 0, key === 'receivedAt' ? 8.64e15 : key === 'status' ? 599 : count ? 1_000_000 : 86_400_000, count)) return null
    out[key] = value[key]
  }
  if (value.full !== undefined) { if (typeof value.full !== 'boolean') return null; out.full = value.full }
  // IDs, arbitrary keys, URLs and free-form logs never leave the timing source file.
  return out
}
async function timings(dataDir: string, capturedAt: string, mode: string): Promise<{ contents: string; count: number }> {
  const rows: string[] = []; let size = 0
  await directory(dataDir, false)
  for (const name of ['performance.jsonl.1', 'performance.jsonl']) {
    let bytes: Buffer
    try { bytes = await readFile(join(dataDir, name), TIMING_BYTES, true) } catch (error) { if (missing(error)) continue; throw error }
    for (const line of bytes.toString('utf8').split('\n')) {
      if (!line || line.length > 4096) continue
      let value: unknown
      try { value = JSON.parse(line) } catch { continue }
      const row = timing(value, Date.parse(capturedAt), mode)
      if (!row) continue
      const encoded = JSON.stringify(row) + '\n'; const length = Buffer.byteLength(encoded)
      if (size + length > TIMING_BYTES) break
      rows.push(encoded); size += length
    }
  }
  return { contents: rows.join(''), count: rows.length }
}

type Stored = IssueSummary & { version: 1; captureFingerprint: string; lastFingerprint: string }
function summary(stored: Stored): IssueSummary {
  const { version: _version, captureFingerprint: _capture, lastFingerprint: _last, ...report } = stored
  return report
}
function captured(input: IssueWrite): IssueCapture {
  const { logs: _logs, revision: _revision, ...capture } = input
  return capture
}

/** No directories or report scans are performed until an authenticated issue route is used. */
export function createIssueReports(config: LocalConfig, runtime: { dataDir: string; sessionKey: string }, owner: string) {
  const scope = createHmac('sha256', runtime.sessionKey).update(JSON.stringify(['local-issues-v1', owner, config.instanceId, config.mode])).digest('hex')
  const origins = new Set(config.web.allowedOrigins)
  const data = join(ROOT_DIR, 'data'), root = join(data, 'issues'), instance = join(root, config.instanceId), path = join(instance, config.mode)
  async function ensure(create: boolean): Promise<boolean> {
    if (!UUID.test(config.instanceId) || !oneOf(config.mode, ['mock', 'real'])) unsafe()
    if (!await directory(ROOT_DIR, false, false)) unsafe()
    for (const [entry, privateMode] of [[data, false], [root, true], [instance, true], [path, true]] as const) {
      if (!await directory(entry, create, privateMode)) return false
      if (create) await syncDirectory(entry)
    }
    return true
  }
  async function stored(id: string): Promise<Stored | null> {
    if (!await ensure(false) || !await directory(join(path, id), false)) return null
    let value: unknown
    try { value = JSON.parse((await readFile(join(path, id, 'report.json'), REPORT_BYTES)).toString('utf8')) } catch (error) { if (missing(error)) unsafe(); throw error }
    if (!object(value)) unsafe()
    const keys = ['version', 'captureFingerprint', 'lastFingerprint', 'id', 'scope', 'revision', 'prompt', 'url', 'title', 'capturedAt', 'updatedAt', 'viewport', 'build', 'rendering', 'storage', 'status', 'image', 'logCount', 'timingCount']
    if (Object.keys(value).some(key => !keys.includes(key)) || value.version !== 1 || value.id !== id || value.scope !== scope || value.storage !== 'repo' || !oneOf(value.status, ['new', 'in-progress', 'needs-review', 'fixed']) || !finite(value.revision, 1, Number.MAX_SAFE_INTEGER - 1, true) || !finite(value.logCount, 0, ISSUE_LIMITS.logs, true) || !finite(value.timingCount, 0, TIMING_BYTES, true) || typeof value.captureFingerprint !== 'string' || !HASH.test(value.captureFingerprint) || typeof value.lastFingerprint !== 'string' || !HASH.test(value.lastFingerprint)) unsafe()
    const { version: _version, captureFingerprint: _capture, lastFingerprint: _last, storage: _storage, status: _status, image: rawImage, logCount: _logs, timingCount: _timings, ...capture } = value
    try {
      normalize(capture, id, scope, origins)
      const image = record(rawImage, ['contentType', 'bytes', 'width', 'height', 'sha256'])
      if (!oneOf(image.contentType, ['image/png', 'image/jpeg']) || !finite(image.bytes, 1, ISSUE_LIMITS.screenshotBytes, true) || !finite(image.width, 1, 16384, true) || !finite(image.height, 1, 16384, true) || image.width * image.height > 64 * 1024 * 1024 || typeof image.sha256 !== 'string' || !HASH.test(image.sha256)) unsafe()
    } catch { unsafe() }
    return value as Stored
  }
  async function scan(): Promise<{ ids: string[]; bytes: number }> {
    if (!await ensure(false)) return { ids: [], bytes: 0 }
    const ids: string[] = []; let bytes = 0, entries = 0
    const dir = await opendir(path)
    for await (const entry of dir) {
      if (++entries > ISSUE_LIMITS.maxReports + 5) quota()
      if (entry.name === '.write-lock.sqlite' || entry.name === '.write-lock.sqlite-journal') {
        let stat: Stats
        try { stat = await lstat(join(path, entry.name)) } catch (error) { if (entry.name.endsWith('-journal') && missing(error)) continue; throw error }
        owned(stat, false)
        if (stat.size !== 0 && (entry.name === '.write-lock.sqlite' || stat.size !== 512)) unsafe()
        continue
      }
      if (!UUID.test(entry.name) && !/^\.pending-[0-9a-f-]{36}$/.test(entry.name)) unsafe()
      const bundle = join(path, entry.name)
      await directory(bundle, false)
      if (UUID.test(entry.name)) { ids.push(entry.name); if (ids.length > ISSUE_LIMITS.maxReports) quota() }
      let files = 0
      for await (const file of await opendir(bundle)) {
        if (++files > 6 || !['report.json', 'screenshot.jpg', 'screenshot.png', 'browser-logs.jsonl', 'timings.jsonl'].includes(file.name) && !/^\.report-[0-9a-f-]{36}\.tmp$/.test(file.name)) unsafe()
        const stat = await lstat(join(bundle, file.name)); owned(stat, false); bytes += stat.size
      }
    }
    return { ids, bytes }
  }
  async function write(id: string, request: Request): Promise<IssueSummary> {
    const upload = await multipart(request), input = normalize(upload.metadata, id, scope, origins)
    const { prompt: _prompt, updatedAt: _updated, ...capture } = captured(input)
    const captureFingerprint = sha(JSON.stringify({ ...capture, logs: input.logs, image: upload.image.sha256 }))
    const lastFingerprint = sha(JSON.stringify([captureFingerprint, input.prompt]))
    await ensure(true)
    const lock = join(path, '.write-lock.sqlite')
    // No schema or report data: SQLite is only a crash-released advisory lock on this stable inode.
    // Creation/close stays synchronous so a separate fd cannot close after another local SQLite connection has locked it.
    let fd: number | undefined
    try { fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); owned(fstatSync(fd), false); fsyncSync(fd) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    finally { if (fd !== undefined) closeSync(fd) }
    const identity = lstatSync(lock); owned(identity, false)
    if (identity.size !== 0) unsafe()
    // SQLite creates a private 512-byte rollback header even for an empty EXCLUSIVE transaction.
    // Only that bounded companion (or its just-created empty state) is admitted, never WAL/SHM or report data.
    for (const suffix of ['-journal', '-wal', '-shm']) {
      try {
        const stat = lstatSync(lock + suffix); owned(stat, false)
        if (suffix !== '-journal' || stat.size !== 0 && stat.size !== 512) unsafe()
      } catch (error) { if (!missing(error)) throw error }
    }
    const database = new Database(lock, { readwrite: true, create: false })
    try {
      database.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;')
      const current = lstatSync(lock); owned(current, false)
      if (current.dev !== identity.dev || current.ino !== identity.ino || current.size !== 0) unsafe()
    } catch (error) {
      database.close()
      if ((error as { code?: string }).code === 'SQLITE_BUSY') fail(503, 'BUSY', 'Another issue save is in progress. Retry shortly.')
      throw error
    }
    try {
      const old = await stored(id)
      if (old) {
        if (old.captureFingerprint !== captureFingerprint) fail(409, 'IMMUTABLE', 'The original issue capture and diagnostics cannot be replaced.')
        if (old.lastFingerprint === lastFingerprint && old.prompt === input.prompt) { await syncDirectory(join(path, id)); await syncDirectory(path); return summary(old) }
        if (input.revision !== old.revision) fail(412, 'CONFLICT', 'This issue was edited elsewhere. Reload it before saving your description.')
      } else if (input.revision !== 0) fail(412, 'CONFLICT', 'A new issue must start at revision zero.')
      const inventory = await scan()
      if (!old && inventory.ids.length >= ISSUE_LIMITS.maxReports) quota()
      const recent = old ? { contents: '', count: old.timingCount } : await timings(runtime.dataDir, input.capturedAt, config.mode)
      const next: Stored = old ? { ...old, prompt: input.prompt, updatedAt: new Date().toISOString(), revision: old.revision + 1, lastFingerprint }
        : { ...captured(input), scope, version: 1, storage: 'repo', status: 'new', revision: 1, updatedAt: new Date().toISOString(), image: upload.image, logCount: input.logs.length, timingCount: recent.count, captureFingerprint, lastFingerprint }
      const metadata = encode(next), browserLogs = jsonl(input.logs)
      if (Buffer.byteLength(metadata) > REPORT_BYTES) invalid()
      const additional = Buffer.byteLength(metadata) + (old ? 0 : upload.screenshot.length + Buffer.byteLength(browserLogs) + Buffer.byteLength(recent.contents))
      if (inventory.bytes + additional > ISSUE_LIMITS.totalBytes) quota()
      if (old) {
        const bundle = join(path, id), temp = join(bundle, `.report-${randomUUID()}.tmp`)
        try {
          await writeFile(temp, metadata)
          // Cooperative host writers share the advisory lock. This extra recheck is best-effort only
          // for agents editing files directly; non-cooperating filesystem writers do not get atomic CAS.
          const current = await stored(id)
          if (JSON.stringify(current) !== JSON.stringify(old)) fail(412, 'CONFLICT', 'This issue changed during the save. Reload it before saving.')
          await rename(temp, join(bundle, 'report.json')); await syncDirectory(bundle); await syncDirectory(path)
        } finally { await unlink(temp).catch(error => { if (!missing(error)) throw error }) }
      } else {
        const temp = join(path, `.pending-${randomUUID()}`)
        await mkdir(temp, { mode: 0o700 })
        const files = ['report.json', upload.image.contentType === 'image/png' ? 'screenshot.png' : 'screenshot.jpg', 'browser-logs.jsonl', 'timings.jsonl']
        try {
          for (const [index, contents] of [metadata, upload.screenshot, browserLogs, recent.contents].entries()) await writeFile(join(temp, files[index]!), contents)
          await syncDirectory(temp)
          await rename(temp, join(path, id)); await syncDirectory(path)
        } catch (error) {
          // Only this request's own temporary bundle can be removed; committed captures are never deleted.
          if (await directory(temp, false)) {
            for (const name of files) await unlink(join(temp, name)).catch(error => { if (!missing(error)) throw error })
            await rmdir(temp)
          }
          throw error
        }
      }
      return summary(next)
    } finally { try { database.exec('ROLLBACK') } finally { database.close() } }
  }
  const signCursor = (value: string) => createHmac('sha256', runtime.sessionKey).update(`${scope}\0${value}`).digest('base64url')
  async function list(url: URL): Promise<IssuePage> {
    if ([...url.searchParams.keys()].some(key => !['limit', 'cursor'].includes(key)) || url.searchParams.getAll('limit').length > 1 || url.searchParams.getAll('cursor').length > 1) invalid()
    const rawLimit = url.searchParams.get('limit'), limit = rawLimit === null ? ISSUE_LIMITS.pageSize : Number(rawLimit)
    if (rawLimit !== null && !/^[1-9]\d?$/.test(rawLimit) || !finite(limit, 1, ISSUE_LIMITS.maxPageSize, true)) invalid()
    let after: { capturedAt: string; id: string } | undefined
    const cursor = url.searchParams.get('cursor')
    if (cursor !== null) {
      if (!/^[A-Za-z0-9_-]{1,256}\.[A-Za-z0-9_-]{43}$/.test(cursor)) invalid()
      const [encoded, signature] = cursor.split('.')
      if (!timingSafeEqual(Buffer.from(signCursor(encoded!)), Buffer.from(signature!))) invalid()
      let row: Record<string, unknown>
      try { row = record(JSON.parse(Buffer.from(encoded!, 'base64url').toString('utf8')), ['capturedAt', 'id']); timestamp(row.capturedAt) } catch { return invalid() }
      if (typeof row.id !== 'string' || !UUID.test(row.id)) invalid()
      after = { capturedAt: row.capturedAt as string, id: row.id }
    }
    const { ids } = await scan(), reports: IssueSummary[] = []
    for (const id of ids) { const report = await stored(id); if (report) reports.push(summary(report)) }
    reports.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt) || b.id.localeCompare(a.id))
    const remaining = after ? reports.filter(report => report.capturedAt < after.capturedAt || report.capturedAt === after.capturedAt && report.id < after.id) : reports
    const items = remaining.slice(0, limit), last = items.at(-1)
    const encoded = last && remaining.length > limit ? Buffer.from(JSON.stringify({ capturedAt: last.capturedAt, id: last.id })).toString('base64url') : null
    return { scope, items, nextCursor: encoded ? `${encoded}.${signCursor(encoded)}` : null }
  }
  return {
    scope,
    async fetch(request: Request): Promise<Response> {
      if (oneOf(request.headers.get('sec-fetch-site'), ['same-site', 'cross-site'])) fail(403, 'ORIGIN', 'Issue diagnostics require a same-origin request.')
      const active = activeScopes.get(path) ?? 0
      if (active >= 4) fail(503, 'BUSY', 'The issue inbox is busy. Retry shortly.')
      activeScopes.set(path, active + 1)
      try {
        const url = new URL(request.url)
        if (url.pathname === '/host/issues' && request.method === 'GET') return Response.json(await list(url), { headers })
        const match = /^\/host\/issues\/([^/]+)(\/screenshot)?$/.exec(url.pathname)
        if (!match || !UUID.test(match[1]!) || url.search) invalid()
        const id = match[1]!
        if (!match[2] && request.method === 'PUT') return Response.json(await write(id, request), { headers })
        if (request.method !== 'GET') fail(405, 'METHOD', 'Use GET for issue reads or PUT to save an issue.')
        const report = await stored(id)
        if (!report) fail(404, 'NOT_FOUND', 'Issue not found in this local host scope.')
        if (match[2]) {
          const extension = report.image.contentType === 'image/png' ? 'png' : 'jpg'
          const bytes = await readFile(join(path, id, `screenshot.${extension}`), ISSUE_LIMITS.screenshotBytes)
          if (bytes.length !== report.image.bytes || sha(bytes) !== report.image.sha256) unsafe()
          imageInfo(bytes, report.image.contentType)
          return new Response(new Uint8Array(bytes), { headers: { ...headers, 'Content-Type': report.image.contentType, 'Content-Disposition': `inline; filename="screenshot.${extension}"`, 'Content-Length': String(bytes.length) } })
        }
        const contents = await readFile(join(path, id, 'browser-logs.jsonl'), ISSUE_LIMITS.metadataBytes)
        let rows: unknown[]
        try { rows = contents.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) } catch { return unsafe() }
        const browserLogs = logs(rows)
        if (browserLogs.length !== report.logCount) unsafe()
        const detail: IssueDetail = { ...summary(report), logs: browserLogs }
        return Response.json(detail, { headers })
      } finally {
        const remaining = (activeScopes.get(path) ?? 1) - 1
        if (remaining) activeScopes.set(path, remaining); else activeScopes.delete(path)
      }
    },
  }
}
