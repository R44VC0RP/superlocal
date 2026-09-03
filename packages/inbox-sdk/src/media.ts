import type { Database } from 'bun:sqlite'
import { Resolver } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { Readable } from 'node:stream'
import { checkServerIdentity } from 'node:tls'
import { promisify } from 'node:util'
import { brotliDecompress, gunzip, inflate } from 'node:zlib'
import { InboxError, type MediaContent, type MediaNetwork, type MediaOptions } from './contracts'
import { isTrackingImage } from './email-images'
import { MAX_SVG_IMAGE_BYTES, sanitizeSvgImage } from '../server/sanitize'

const MiB = 1024 * 1024
const MAX_REDIRECTS = 3
const MAX_QUEUED = 64
const MAX_WAITERS = 128
const NEGATIVE_TTL = 30_000
const MAX_PIXELS = 32_000_000
const blocked = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.31.196.0', 24], ['192.52.193.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['192.175.48.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(address, prefix, 'ipv4')
const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')
// Exclude special-use, documentation and IPv4-transition ranges within global unicast.
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['2620:4f:8000::', 48], ['3ffe::', 16], ['3fff::', 20]] as const) {
  blocked.addSubnet(address, prefix, 'ipv6')
}

class MediaError extends InboxError {}

function issue(code: string, status = 502, retryable = false): MediaError {
  return new MediaError(code, 'Email media is unavailable.', status, retryable)
}

function publicAddress(address: string): 4 | 6 {
  const family = isIP(address)
  if (family === 4 && !blocked.check(address, 'ipv4')) return 4
  if (family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6')) return 6
  throw issue('MEDIA_DESTINATION_BLOCKED', 403)
}

function destination(source: string): URL {
  if (source.length > 8192 || /[\x00-\x20\x7f\\]/.test(source)) throw issue('MEDIA_DESTINATION_BLOCKED', 403)
  let url: URL
  try { url = new URL(source) } catch { throw issue('MEDIA_DESTINATION_BLOCKED', 403) }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw issue('MEDIA_DESTINATION_BLOCKED', 403)
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (isIP(host)) publicAddress(host)
  else if (host.length > 253 || !host.includes('.') || !/^[a-z\d.-]+$/i.test(host)
    || /(?:^|\.)(?:localhost|local|internal|lan|onion|home\.arpa)$/i.test(host)) {
    throw issue('MEDIA_DESTINATION_BLOCKED', 403)
  }
  let decoded = url.href
  try { decoded = decodeURIComponent(decoded) } catch { /* Check literal malformed escapes too. */ }
  if (isTrackingImage({ src: decoded })) throw issue('MEDIA_TRACKER_BLOCKED', 403)
  url.hash = ''
  return url
}

function aborted(signal: AbortSignal): InboxError {
  return signal.reason instanceof MediaError ? signal.reason : issue('MEDIA_CANCELLED', 503, true)
}

function interruptible<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(aborted(signal))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/** No ambient fetch/proxy, pooled sockets, secondary DNS lookup, or disabled certificate checks. */
export const pinnedMediaNetwork: MediaNetwork = {
  async resolve(hostname, signal) {
    const resolver = new Resolver({ timeout: 3000, tries: 1 })
    const cancel = () => resolver.cancel()
    signal.throwIfAborted()
    signal.addEventListener('abort', cancel, { once: true })
    const optional = (promise: Promise<string[]>) => promise.catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENODATA' || error.code === 'ENOTFOUND') return []
      throw error
    })
    try { return (await Promise.all([optional(resolver.resolve4(hostname)), optional(resolver.resolve6(hostname))])).flat() }
    finally { signal.removeEventListener('abort', cancel); resolver.cancel() }
  },
  request(target, signal) {
    return new Promise((resolve, reject) => {
      const url = new URL(target.url)
      const hostname = url.hostname.replace(/^\[|\]$/g, '')
      const request = url.protocol === 'https:' ? httpsRequest : httpRequest
      const req = request(url, {
        method: 'GET', headers: { ...target.headers }, agent: false,
        family: target.family, signal,
        lookup: (_hostname, _options, callback) => callback(null, target.address, target.family),
        rejectUnauthorized: true, servername: isIP(hostname) ? undefined : hostname,
        checkServerIdentity: (_hostname, certificate) => checkServerIdentity(hostname, certificate),
        maxHeaderSize: 16 * 1024,
      }, response => {
        try {
          // Only these upstream headers are needed. Never reflect cookies or other server metadata.
          const headers = new Headers()
          for (const key of ['content-type', 'content-length', 'content-encoding', 'location', 'cache-control']) {
            const value = response.headers[key]
            if (typeof value === 'string') headers.set(key, value)
          }
          const status = response.statusCode ?? 502
          if (status < 200 || status > 599) throw issue('MEDIA_RESPONSE_INVALID')
          if ([204, 205, 304].includes(status)) {
            response.destroy()
            resolve(new Response(null, { status, headers }))
          } else resolve(new Response(Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>, { status, headers }))
        } catch {
          response.destroy()
          reject(issue('MEDIA_RESPONSE_INVALID'))
        }
      })
      req.once('error', () => reject(signal.aborted ? aborted(signal) : issue('MEDIA_NETWORK', 502, true)))
      req.end()
    })
  },
}

function imageType(bytes: Uint8Array, declared: string): string {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const type = declared.split(';', 1)[0]!.trim().toLowerCase().replace(/^image\/jpg$/, 'image/jpeg')
  const fits = (width: number, height: number) => width > 0 && height > 0 && width <= 16384 && height <= 16384 && width * height <= MAX_PIXELS
  let width = 0, height = 0, valid = false
  if (type === 'image/png') {
    if (b.length >= 45 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      && b.readUInt32BE(8) === 13 && b.toString('ascii', 12, 16) === 'IHDR') {
      width = b.readUInt32BE(16); height = b.readUInt32BE(20)
      const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }
      if (!depths[b[25]!]?.includes(b[24]!) || b[26] !== 0 || b[27] !== 0 || b[28]! > 1) throw issue('MEDIA_INVALID_IMAGE', 415)
      let data = false
      for (let offset = 8; offset + 12 <= b.length;) {
        const size = b.readUInt32BE(offset), tag = b.toString('ascii', offset + 4, offset + 8)
        if (size > b.length - offset - 12) break
        if (tag === 'IHDR' && offset !== 8) break
        if (tag === 'IDAT') data = true
        offset += size + 12
        if (tag === 'IEND') { valid = data && size === 0 && offset === b.length; break }
      }
    }
  } else if (type === 'image/gif') {
    if (b.length >= 14 && /^GIF8[79]a$/.test(b.toString('ascii', 0, 6)) && b.at(-1) === 0x3b) {
      width = b.readUInt16LE(6); height = b.readUInt16LE(8)
      let offset = 13 + (b[10]! & 0x80 ? 3 * 2 ** ((b[10]! & 7) + 1) : 0), frames = 0
      const blocks = (start: number) => {
        while (start < b.length) {
          const size = b[start++]!
          if (size === 0) return start
          if (size > b.length - start) return -1
          start += size
        }
        return -1
      }
      while (offset >= 0 && offset < b.length) {
        const tag = b[offset++]
        if (tag === 0x3b) { valid = frames > 0 && offset === b.length; break }
        if (tag === 0x21) { offset = blocks(offset + 1); continue }
        if (tag !== 0x2c || offset + 9 > b.length || ++frames > 1024) break
        if (!fits(b.readUInt16LE(offset + 4), b.readUInt16LE(offset + 6))) break
        const packed = b[offset + 8]!
        offset += 9 + (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0)
        if (offset >= b.length || b[offset]! < 2 || b[offset]! > 8) break
        offset = blocks(offset + 1)
      }
    }
  } else if (type === 'image/jpeg') {
    if (b.length >= 4 && b.readUInt16BE(0) === 0xffd8 && b.readUInt16BE(b.length - 2) === 0xffd9) {
      for (let offset = 2; offset + 4 <= b.length;) {
        if (b[offset++] !== 0xff) break
        while (b[offset] === 0xff) offset++
        const marker = b[offset++]
        if (marker === undefined || offset + 2 > b.length) break
        const size = b.readUInt16BE(offset)
        if (size < 2 || offset + size > b.length) break
        if (marker === 0xda) { valid = width > 0 && size >= 6 && offset + size < b.length - 2; break }
        if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && size >= 8) {
          if (width > 0) break
          height = b.readUInt16BE(offset + 3); width = b.readUInt16BE(offset + 5)
        }
        offset += size
      }
    }
  } else if (type === 'image/webp') {
    if (b.length >= 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' && b.readUInt32LE(4) === b.length - 8) {
      let image = false, offset = 12
      while (offset + 8 <= b.length) {
        const tag = b.toString('ascii', offset, offset + 4), size = b.readUInt32LE(offset + 4), start = offset + 8
        if (size > b.length - start) break
        if (tag === 'VP8X' && size === 10) { width = 1 + b.readUIntLE(start + 4, 3); height = 1 + b.readUIntLE(start + 7, 3) }
        else if (tag === 'VP8 ' && size >= 10 && b.subarray(start + 3, start + 6).equals(Buffer.from([0x9d, 1, 0x2a]))) {
          if (!fits(b.readUInt16LE(start + 6) & 0x3fff, b.readUInt16LE(start + 8) & 0x3fff)) break
          width ||= b.readUInt16LE(start + 6) & 0x3fff; height ||= b.readUInt16LE(start + 8) & 0x3fff; image = true
        } else if (tag === 'VP8L' && size >= 5 && b[start] === 0x2f) {
          const dimensions = b.readUInt32LE(start + 1)
          if (!fits((dimensions & 0x3fff) + 1, ((dimensions >>> 14) & 0x3fff) + 1)) break
          width ||= (dimensions & 0x3fff) + 1; height ||= ((dimensions >>> 14) & 0x3fff) + 1; image = true
        } else if (tag === 'ANMF' && size >= 24) {
          if (!fits(1 + b.readUIntLE(start + 6, 3), 1 + b.readUIntLE(start + 9, 3))) break
          image = true
        }
        offset = start + size + (size % 2)
      }
      valid = image && offset === b.length
    }
  } else throw issue('MEDIA_TYPE_UNSUPPORTED', 415)
  // Container/header validation is not a pixel decoder. Only raster MIME is served, under a sandbox CSP.
  if (!valid || !fits(width, height)) {
    throw issue('MEDIA_INVALID_IMAGE', 415)
  }
  return type
}

function imageContent(bytes: Uint8Array, declared: string, maximum: number, canonical = false): MediaContent {
  if (declared.split(';', 1)[0]!.trim().toLowerCase() !== 'image/svg+xml') {
    return { contentType: imageType(bytes, declared), content: bytes }
  }
  if (bytes.byteLength > MAX_SVG_IMAGE_BYTES) throw issue('MEDIA_TOO_LARGE', 413)
  let svg: string | null = null
  let text = ''
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); svg = sanitizeSvgImage(text) } catch { /* No raw XML or decoder errors escape. */ }
  // A cacheable vector must be a stable reconstruction under the same bounds.
  // Reject expansion over a limit before the first 200, not on every other cache hit.
  if (!svg || (canonical ? svg !== text : sanitizeSvgImage(svg) !== svg)) throw issue('MEDIA_INVALID_SVG', 415)
  const content = new TextEncoder().encode(svg)
  if (content.byteLength > maximum) throw issue('MEDIA_TOO_LARGE', 413)
  return { contentType: 'image/svg+xml', content }
}

const decompress = { gzip: promisify(gunzip), deflate: promisify(inflate), br: promisify(brotliDecompress) }

async function content(response: Response, maximum: number, signal: AbortSignal): Promise<Uint8Array> {
  const length = response.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) throw issue('MEDIA_TOO_LARGE', 413)
  const encoding = (response.headers.get('content-encoding') ?? 'identity').trim().toLowerCase()
  if (encoding !== 'identity' && !Object.hasOwn(decompress, encoding)) throw issue('MEDIA_ENCODING_UNSUPPORTED', 415)
  if (!response.body) throw issue('MEDIA_INVALID_IMAGE', 415)
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await interruptible(reader.read(), signal)
      if (done) break
      size += value.byteLength
      if (size > maximum) throw issue('MEDIA_TOO_LARGE', 413)
      chunks.push(value)
    }
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  const bytes = Buffer.concat(chunks, size)
  if (encoding === 'identity') return bytes
  try {
    const decoded = await interruptible(decompress[encoding as keyof typeof decompress](bytes, { maxOutputLength: maximum }), signal)
    if (decoded.byteLength > maximum) throw issue('MEDIA_TOO_LARGE', 413)
    return decoded
  }
  catch (error) {
    if (signal.aborted) throw aborted(signal)
    if (error instanceof MediaError) throw error
    const large = (error as NodeJS.ErrnoException)?.code === 'ERR_BUFFER_TOO_LARGE'
    throw issue(large ? 'MEDIA_TOO_LARGE' : 'MEDIA_INVALID_IMAGE', large ? 413 : 415)
  }
}

/** Server-only image fetch. The caller owns the deadline, policy and cache; no transport is chosen implicitly. */
export async function fetchPublicImage(input: {
  source: string; network: MediaNetwork | undefined; signal: AbortSignal
  maxBytes: number; cacheTtlMs: number; authorize: () => void | Promise<void>
}): Promise<MediaContent & { lifetime: number }> {
  const { network, signal, maxBytes: maximum, cacheTtlMs: ttl } = input
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 16 * MiB
    || !Number.isSafeInteger(ttl) || ttl < 1 || ttl > 7 * 24 * 60 * 60_000) {
    throw new InboxError('VALIDATION', 'Invalid media limits.')
  }
  const authorize = async () => {
    signal.throwIfAborted()
    await interruptible(Promise.resolve(input.authorize()), signal)
    signal.throwIfAborted()
  }
  await authorize()
  if (!network) throw issue('MEDIA_NETWORK_DISABLED', 503)
  let url = destination(input.source)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await authorize()
    const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '')
    const addresses = isIP(hostname) ? [hostname] : await interruptible(network.resolve(hostname, signal), signal)
    if (!addresses.length || addresses.length > 32) throw issue('MEDIA_DNS', 502, true)
    const families = addresses.map(publicAddress)
    const address = addresses[0]!, family = families[0]!
    await authorize()
    const response = await interruptible(network.request({ url: url.href, address, family,
      headers: Object.freeze({ Accept: 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml', 'Accept-Encoding': 'identity' }) }, signal), signal)
    try {
      await authorize()
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (hop === MAX_REDIRECTS) throw issue('MEDIA_REDIRECT_LIMIT', 502)
        const location = response.headers.get('location')
        if (!location || location.length > 8192) throw issue('MEDIA_REDIRECT_INVALID', 502)
        try { url = destination(new URL(location, url).href) }
        catch (error) { throw error instanceof InboxError ? error : issue('MEDIA_REDIRECT_INVALID', 502) }
        continue
      }
      if (response.status !== 200) throw issue(`MEDIA_UPSTREAM_${response.status}`, response.status === 404 ? 404 : 502, response.status >= 500 || response.status === 429)
      const declared = response.headers.get('content-type') ?? ''
      const svg = declared.split(';', 1)[0]!.trim().toLowerCase() === 'image/svg+xml'
      const bytes = await content(response, svg ? Math.min(maximum, MAX_SVG_IMAGE_BYTES) : maximum, signal)
      const image = imageContent(bytes, declared, maximum)
      const control = response.headers.get('cache-control') ?? ''
      const maxAge = /(?:^|,)\s*max-age\s*=\s*"?(\d+)/i.exec(control)?.[1]
      const lifetime = /(?:^|,)\s*(?:no-store|no-cache)\b/i.test(control) ? 0 : Math.min(ttl, maxAge === undefined ? ttl : Number(maxAge) * 1000)
      await authorize()
      return { ...image, lifetime, noStore: /(?:^|,)\s*no-store\b/i.test(control) }
    } finally { void response.body?.cancel().catch(() => {}) }
  }
  throw issue('MEDIA_REDIRECT_LIMIT', 502)
}

type CacheRow = { resource: string; type: string | null; content: Uint8Array | null; code: string | null; status: number; retryable: number; expires: number }
type Job = { owner: string; controller: AbortController; promise: Promise<MediaContent> }

export function createMediaStore(input: {
  database: Database; now: () => number; options?: MediaOptions; injectedFetch: boolean
  log?: (event: { code: string; operation: string }) => void
}) {
  const { database: db, now } = input, options = input.options ?? {}
  function setting(value: number | undefined, fallback: number, maximum: number): number {
    const result = value ?? fallback
    if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new InboxError('VALIDATION', 'Invalid media limits.')
    return result
  }
  const timeout = setting(options.timeoutMs, 10_000, 30_000)
  const maximum = setting(options.maxBytes, 8 * MiB, 16 * MiB)
  const concurrency = setting(options.concurrency, 4, 16)
  const cacheBytes = setting(options.cacheBytes, 64 * MiB, 256 * MiB)
  const cacheEntries = setting(options.cacheEntries, 512, 2048)
  const ttl = setting(options.cacheTtlMs, 24 * 60 * 60_000, 7 * 24 * 60 * 60_000)
  // Legacy fetch cannot promise DNS pinning. Never silently escape a host's network boundary.
  const network = options.network ?? (input.injectedFetch ? undefined : pinnedMediaNetwork)
  db.exec(`CREATE TABLE IF NOT EXISTS sdk_media_cache (
    resource TEXT PRIMARY KEY, owner TEXT NOT NULL, message_id TEXT NOT NULL,
    type TEXT, content BLOB, code TEXT, status INTEGER NOT NULL, retryable INTEGER NOT NULL,
    expires INTEGER NOT NULL, accessed INTEGER NOT NULL, FOREIGN KEY(message_id) REFERENCES sdk_messages(id) ON DELETE CASCADE
  ); CREATE INDEX IF NOT EXISTS sdk_media_expiry ON sdk_media_cache(expires);`)
  const jobs = new Map<string, Job>()
  const queue: Array<() => void> = []
  let active = 0, waiters = 0, closed = false

  function prune() {
    db.query('DELETE FROM sdk_media_cache WHERE expires<=? OR length(content)>? OR message_id IN (SELECT id FROM sdk_messages WHERE deleted=1)').run(now(), maximum)
    db.query('UPDATE sdk_media_cache SET expires=? WHERE code IS NULL AND expires>?').run(now() + ttl, now() + ttl)
    while (true) {
      const totals = db.query<{ count: number; bytes: number }, []>('SELECT COUNT(*) count,COALESCE(SUM(length(content)),0) bytes FROM sdk_media_cache').get()!
      if (totals.count <= cacheEntries && totals.bytes <= cacheBytes) break
      db.exec('DELETE FROM sdk_media_cache WHERE resource=(SELECT resource FROM sdk_media_cache ORDER BY accessed,rowid LIMIT 1)')
    }
  }
  prune()
  const sweep = setInterval(() => { try { prune() } catch { input.log?.({ code: 'MEDIA_CACHE_CLEANUP', operation: 'media' }) } }, 60_000)
  sweep.unref()

  function save(owner: string, messageId: string, resource: string, result: MediaContent | InboxError, lifetime: number) {
    if (lifetime <= 0 || !(result instanceof InboxError) && result.content.byteLength > cacheBytes) return
    db.transaction(() => {
      const error = result instanceof InboxError ? result : null
      db.query('INSERT OR REPLACE INTO sdk_media_cache VALUES (?,?,?,?,?,?,?,?,?,?)').run(resource, owner, messageId,
        error ? null : (result as MediaContent).contentType, error ? null : (result as MediaContent).content,
        error?.code ?? null, error?.status ?? 200, Number(error?.retryable ?? false), now() + lifetime, now())
      prune()
    }).immediate()
  }

  function releaseSlot() { const next = queue.shift(); if (next) next(); else active-- }

  async function slot(signal: AbortSignal): Promise<() => void> {
    if (active >= concurrency) {
      let resume!: () => void
      const pending = new Promise<void>(resolve => { resume = resolve; queue.push(resume) })
      try { await interruptible(pending, signal) }
      catch (error) {
        const index = queue.indexOf(resume)
        if (index >= 0) queue.splice(index, 1)
        else releaseSlot() // An abort raced with transfer of the occupied slot.
        throw error
      }
    } else active++
    return releaseSlot
  }

  return {
    async get(owner: string, messageId: string, resource: string, source: string, authorize: () => void): Promise<MediaContent> {
      authorize()
      if (closed) throw issue('MEDIA_CANCELLED', 503, true)
      const cached = db.query<CacheRow, [string, string, string]>('SELECT * FROM sdk_media_cache WHERE owner=? AND message_id=? AND resource=?').get(owner, messageId, resource)
      if (cached && cached.expires > now()) {
        if (cached.code) throw issue(cached.code, cached.status, !!cached.retryable)
        if (cached.content && cached.type && cached.content.byteLength <= maximum) {
          // Only rebuilt SVG is stored. Recheck it against the current static-vector policy on hits,
          // so a future policy tightening cannot serve formerly accepted active XML from the cache.
          if (cached.type === 'image/svg+xml') {
            try {
              const image = imageContent(cached.content, cached.type, maximum, true)
              db.query('UPDATE sdk_media_cache SET accessed=? WHERE resource=?').run(now(), resource)
              return image
            } catch (error) {
              db.query('DELETE FROM sdk_media_cache WHERE resource=? AND owner=?').run(resource, owner)
              throw error
            }
          }
          db.query('UPDATE sdk_media_cache SET accessed=? WHERE resource=?').run(now(), resource)
          return { contentType: cached.type, content: new Uint8Array(cached.content) }
        }
      }
      if (waiters >= MAX_WAITERS) throw issue('MEDIA_BUSY', 429, true)
      let job = jobs.get(resource)
      if (!job) {
        if (jobs.size >= concurrency + MAX_QUEUED) throw issue('MEDIA_BUSY', 429, true)
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(issue('MEDIA_TIMEOUT', 504, true)), timeout)
        const promise = (async () => {
          let release: (() => void) | undefined
          try {
            release = await slot(controller.signal)
            const result = await fetchPublicImage({ source, network, signal: controller.signal, authorize, maxBytes: maximum, cacheTtlMs: ttl })
            authorize(); controller.signal.throwIfAborted()
            save(owner, messageId, resource, result, result.lifetime)
            return result
          } catch (error) {
            authorize()
            const safe = controller.signal.aborted ? aborted(controller.signal) : error instanceof MediaError ? error : issue('MEDIA_NETWORK', 502, true)
            input.log?.({ code: safe.code, operation: 'media' })
            if (!['MEDIA_NETWORK_DISABLED', 'MEDIA_CANCELLED', 'MEDIA_IMAGES_DISABLED'].includes(safe.code)) save(owner, messageId, resource, safe, NEGATIVE_TTL)
            throw safe
          } finally { clearTimeout(timer); release?.(); jobs.delete(resource) }
        })()
        job = { owner, controller, promise }
        jobs.set(resource, job)
      }
      waiters++
      try { const result = await job.promise; authorize(); return { contentType: result.contentType, content: new Uint8Array(result.content), ...(result.noStore ? { noStore: true } : {}) } }
      finally { waiters-- }
    },
    block(owner: string) {
      for (const job of jobs.values()) if (job.owner === owner) job.controller.abort(issue('MEDIA_IMAGES_DISABLED', 403))
      db.query('DELETE FROM sdk_media_cache WHERE owner=?').run(owner)
    },
    async close() {
      closed = true; clearInterval(sweep)
      for (const job of jobs.values()) job.controller.abort(issue('MEDIA_CANCELLED', 503, true))
      await Promise.allSettled([...jobs.values()].map(job => job.promise))
    },
  }
}
