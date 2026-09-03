import { isIP } from 'node:net'
import { InboxError, type Inbox, type MediaContent } from 'inbox-sdk'
import { fetchPublicImage, pinnedMediaNetwork } from 'inbox-sdk/media'
import { parse } from 'tldts'

export type SenderDomainInfo = {
  hostname: string
  rootDomain: string | null
  kind: 'domain' | 'mail-provider' | 'unavailable'
  websiteUrl: string | null
  registrationUrl: string | null
  iconUrl: string | null
  imagePolicy: 'allowed' | 'blocked' | 'offline'
}

const MAX_IMAGE_BYTES = 256 * 1024
const CACHE_BYTES = 4 * 1024 * 1024
const CACHE_ENTRIES = 128
const CACHE_TTL = 24 * 60 * 60_000
const NEGATIVE_TTL = 60_000
const TIMEOUT = 8_000
const CONCURRENCY = 4
const MAX_QUEUED = 16
const MAX_WAITERS = 64
const safeHeaders = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "sandbox; default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin', 'Referrer-Policy': 'no-referrer', Vary: 'Origin, Cookie',
}
// A deliberately small, explicit service list, not an inference about the person's employer or identity.
const personalMail = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'ymail.com', 'aol.com', 'icloud.com', 'me.com', 'mac.com',
  'proton.me', 'protonmail.com', 'pm.me', 'fastmail.com', 'hey.com',
])

class DomainError extends InboxError {}
function issue(code: string, status: number, retryable = false): DomainError {
  return new DomainError(`HOST_SENDER_DOMAIN_${code}`, 'Sender-domain branding is unavailable.', status, retryable)
}

function domain(input: string): Pick<SenderDomainInfo, 'hostname' | 'rootDomain' | 'kind'> {
  const invalid = () => issue('INVALID', 400)
  // Only hostnames: never silently extract a host from an email address, URL, or credentials.
  if (input.length > 254 || !/^[a-z\d.-]+$/i.test(input)) throw invalid()
  const hostname = input.toLowerCase().replace(/\.$/, '')
  const labels = hostname.split('.')
  if (hostname.length > 253 || labels.length < 2 || labels.some(label => !/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(label))) throw invalid()
  // URL normalization also catches shortened, octal and hexadecimal IPv4 spellings.
  let url: URL
  try { url = new URL(`https://${hostname}`) } catch { throw invalid() }
  if (isIP(url.hostname) || url.hostname !== hostname
    || /(?:^|\.)(?:localhost|local|internal|lan|home|corp|onion|arpa|alt)$/.test(hostname)) throw invalid()
  const parsed = parse(hostname, { allowPrivateDomains: true, extractHostname: false, validateHostname: true, detectIp: true, detectSpecialUse: true })
  if (parsed.hostname !== hostname || parsed.isIp) throw invalid()
  // Unlisted/special-use suffixes are local-only metadata; PSL recognition is NOT sender authentication.
  const rootDomain = !parsed.isSpecialUse && (parsed.isIcann || parsed.isPrivate) ? parsed.domain : null
  return { hostname, rootDomain, kind: rootDomain ? personalMail.has(rootDomain) ? 'mail-provider' : 'domain' : 'unavailable' }
}

function failure(error: unknown, signal: AbortSignal): InboxError {
  if (signal.aborted) return signal.reason instanceof DomainError ? signal.reason : issue('CANCELLED', 503, true)
  if (error instanceof DomainError) return error
  // Only fixed SDK media codes escape. Transport errors may include upstream URLs or other private details.
  if (error instanceof InboxError && /^MEDIA_[A-Z0-9_]{1,60}$/.test(error.code)) {
    return new InboxError(error.code, 'Sender-domain branding is unavailable.', error.status, error.retryable)
  }
  return issue('UNAVAILABLE', 502, true)
}

function interruptible<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(failure(undefined, signal))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

function problem(error: InboxError): Response {
  return Response.json({ code: error.code, error: error.message, retryable: error.retryable }, { status: error.status,
    headers: { ...safeHeaders, ...(error.retryable ? { 'Retry-After': String(NEGATIVE_TTL / 1000) } : {}),
      ...(error.status === 405 ? { Allow: 'GET' } : {}) } })
}

type CacheEntry = { result: MediaContent | InboxError; expires: number }
type Job = { controller: AbortController; promise: Promise<MediaContent> }

/** Auth/Origin checks belong to the outer host. This instance's bounded memory belongs to exactly one owner. */
export function createSenderDomainHost(input: { inbox: Pick<Inbox, 'policy'>; owner: string; offline: boolean }): {
  fetch(request: Request): Promise<Response>
  close(): Promise<void>
} {
  const { inbox, owner } = input
  // An omitted/malformed mode fails closed too. Mock hosts must never escape their injected-fetch boundary.
  const offline = input.offline !== false
  const network = offline ? undefined : pinnedMediaNetwork
  const cache = new Map<string, CacheEntry>()
  const jobs = new Map<string, Job>()
  const queue: Array<() => void> = []
  const pending = new Set<Promise<Response>>()
  const shutdown = new AbortController()
  let bytes = 0, active = 0, closed = false
  let closing: Promise<void> | undefined

  function check(signal: AbortSignal) {
    if (closed) throw issue('CLOSED', 503)
    if (signal.aborted) throw failure(undefined, signal)
  }

  function remove(root: string) {
    const entry = cache.get(root)
    if (entry && !(entry.result instanceof InboxError)) bytes -= entry.result.content.byteLength
    cache.delete(root)
  }

  function prune() {
    const now = Date.now()
    for (const [root, entry] of cache) if (entry.expires <= now) remove(root)
    while (cache.size > CACHE_ENTRIES || bytes > CACHE_BYTES) remove(cache.keys().next().value!)
  }
  const sweep = setInterval(prune, 60_000)
  sweep.unref()

  function save(root: string, result: MediaContent | InboxError, lifetime: number) {
    if (closed || lifetime <= 0) return
    remove(root)
    const stored = result instanceof InboxError ? result : { ...result, content: new Uint8Array(result.content) }
    cache.set(root, { result: stored, expires: Date.now() + lifetime })
    if (!(stored instanceof InboxError)) bytes += stored.content.byteLength
    prune()
  }

  async function imagePolicy(signal: AbortSignal): Promise<SenderDomainInfo['imagePolicy']> {
    check(signal)
    if (offline) return 'offline'
    let allowed: boolean
    try { allowed = (await interruptible(inbox.policy(owner), signal)).remoteImages === true }
    catch { check(signal); throw issue('POLICY_UNAVAILABLE', 503, true) }
    check(signal)
    if (allowed) return 'allowed'
    // A disabled-policy observation invalidates this owner's cache and cancels already-started work.
    cache.clear(); bytes = 0
    for (const job of jobs.values()) job.controller.abort(issue('IMAGES_DISABLED', 403))
    return 'blocked'
  }

  async function authorize(signal: AbortSignal) {
    const policy = await imagePolicy(signal)
    if (policy !== 'allowed') throw issue(policy === 'offline' ? 'OFFLINE' : 'IMAGES_DISABLED', policy === 'offline' ? 503 : 403)
    check(signal)
  }

  function releaseSlot() { const next = queue.shift(); if (next) next(); else active-- }
  async function slot(signal: AbortSignal): Promise<() => void> {
    if (active >= CONCURRENCY) {
      let resume!: () => void
      const ready = new Promise<void>(resolve => { resume = resolve; queue.push(resume) })
      try { await interruptible(ready, signal) }
      catch (error) {
        const index = queue.indexOf(resume)
        if (index >= 0) queue.splice(index, 1)
        else releaseSlot()
        throw error
      }
    } else active++
    return releaseSlot
  }

  async function icon(root: string | null, signal: AbortSignal): Promise<MediaContent> {
    await authorize(signal) // Policy precedes even negative cache reads; no validators bypass it.
    if (!root) throw issue('UNAVAILABLE', 404)
    prune()
    const cached = cache.get(root)
    if (cached) {
      cache.delete(root); cache.set(root, cached)
      if (cached.result instanceof InboxError) throw cached.result
      return cached.result
    }
    let job = jobs.get(root)
    if (!job) {
      if (jobs.size >= CONCURRENCY + MAX_QUEUED) throw issue('BUSY', 429, true)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(issue('TIMEOUT', 504, true)), TIMEOUT)
      // The original sender hostname and address never go to this service, only the PSL-derived root.
      const source = new URL('https://www.google.com/s2/favicons')
      source.searchParams.set('domain', root)
      source.searchParams.set('sz', '128')
      const promise = (async () => {
        let release: (() => void) | undefined
        try {
          release = await slot(controller.signal)
          const result = await fetchPublicImage({ source: source.href, network, signal: controller.signal,
            maxBytes: MAX_IMAGE_BYTES, cacheTtlMs: CACHE_TTL, authorize: () => authorize(controller.signal) })
          await authorize(controller.signal)
          save(root, result, result.lifetime)
          return result
        } catch (error) {
          const safe = failure(error, controller.signal)
          if (!closed && (safe.code.startsWith('MEDIA_') && safe.code !== 'MEDIA_NETWORK_DISABLED'
            || ['HOST_SENDER_DOMAIN_UNAVAILABLE', 'HOST_SENDER_DOMAIN_TIMEOUT'].includes(safe.code))) save(root, safe, NEGATIVE_TTL)
          throw safe
        } finally { clearTimeout(timer); release?.(); jobs.delete(root) }
      })()
      job = { controller, promise }
      jobs.set(root, job)
    }
    return interruptible(job.promise, signal)
  }

  async function dispatch(request: Request, signal: AbortSignal): Promise<Response> {
    check(signal)
    const url = new URL(request.url)
    if (url.search || url.hash) throw issue('INVALID', 400)
    const match = /^\/host\/sender-domains\/([^/]+)(\/icon)?$/.exec(url.pathname)
    if (!match) throw issue('NOT_FOUND', 404)
    if (request.method !== 'GET') throw issue('METHOD_NOT_ALLOWED', 405)
    if (match[1]!.length > 3 * 254) throw issue('INVALID', 400)
    let hostname: string
    try { hostname = decodeURIComponent(match[1]!) } catch { throw issue('INVALID', 400) }
    const metadata = domain(hostname)
    if (match[2]) {
      const image = await icon(metadata.rootDomain, signal)
      await authorize(signal) // Recheck after both cache hits and asynchronous/singleflight results.
      return new Response(new Uint8Array(image.content), { headers: { ...safeHeaders, 'Content-Type': image.contentType,
        'Content-Security-Policy': image.contentType === 'image/svg+xml'
          ? "sandbox; default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
          : safeHeaders['Content-Security-Policy'] } })
    }
    const policy = await imagePolicy(signal)
    if (policy === 'allowed') prune()
    const { rootDomain: root } = metadata
    const unavailable = root && policy === 'allowed' && cache.get(root)?.result instanceof InboxError
    const info: SenderDomainInfo = { ...metadata,
      websiteUrl: root ? `https://${root}/` : null,
      registrationUrl: root ? `https://lookup.icann.org/en/lookup?name=${encodeURIComponent(root)}` : null,
      iconUrl: root && policy === 'allowed' && !unavailable ? `/host/sender-domains/${encodeURIComponent(root)}/icon` : null,
      imagePolicy: policy }
    check(signal)
    return Response.json(info, { headers: safeHeaders })
  }

  return {
    fetch(request) {
      if (closed) return Promise.resolve(problem(issue('CLOSED', 503)))
      if (pending.size >= MAX_WAITERS) return Promise.resolve(problem(issue('BUSY', 429, true)))
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(issue('TIMEOUT', 504, true)), TIMEOUT)
      const signal = AbortSignal.any([request.signal, shutdown.signal, controller.signal])
      const task = dispatch(request, signal).catch(error => problem(failure(error, signal)))
      pending.add(task)
      void task.then(() => { clearTimeout(timer); pending.delete(task) })
      return task
    },
    close() {
      if (closing) return closing
      closed = true
      clearInterval(sweep)
      shutdown.abort(issue('CLOSED', 503))
      for (const job of jobs.values()) job.controller.abort(issue('CLOSED', 503))
      cache.clear(); bytes = 0
      return closing = (async () => {
        await Promise.allSettled([...pending, ...[...jobs.values()].map(job => job.promise)])
        queue.length = 0
      })()
    },
  }
}
