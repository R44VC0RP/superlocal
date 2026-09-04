import type { BlobInfo, ChangeEvent, Draft, DraftInput, Inbox, Label, MailboxInput, MailboxQuery, MutationInput, Policy, Query, SyncRequest } from './contracts'

export interface InboxClientOptions {
  /** API origin or same-origin mount path, without /v1. */
  baseUrl?: string
  fetch?: typeof globalThis.fetch
  headers?: HeadersInit
  /** Explicit authentication partition. Omitting it disables the in-memory cache. */
  cacheScope?: string
  cacheMaxEntries?: number
}

export interface InboxRequestOptions { signal?: AbortSignal }
export interface InboxEventsOptions extends InboxRequestOptions {
  since?: string
  reconnect?: boolean
  reconnectMs?: number
}
export interface InboxSubscriptionOptions extends InboxEventsOptions { onError?: (error: unknown) => void }
export type InboxEvent = ChangeEvent | { type: 'ready' | 'reset.required'; state: string }

export class ApiError extends Error {
  readonly name = 'ApiError'
  constructor(
    message: string,
    readonly status: number,
    readonly code = 'HTTP_ERROR',
    readonly retryable = false,
    readonly retryAfterMs?: number,
  ) { super(message) }
}

type Result<K extends keyof Inbox> = Awaited<ReturnType<Inbox[K]>>
type CacheEntry = { etag: string; text: string; headers: Headers }
const MAX_CACHE_BODY = 1024 * 1024
const MAX_EVENT_BUFFER = 64 * 1024
const changeTypes = new Set(['mail.changed', 'account.updated', 'draft.updated', 'operation.updated', 'label.updated', 'policy.updated', 'connection.updated', 'mailbox.updated', 'membership.updated'])

function apiProblem(value: unknown, status: number, headers?: Headers): ApiError {
  const problem = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const retryAfter = headers?.get('retry-after')?.trim()
  const delay = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000
    : retryAfter && /^[A-Za-z]{3}, /.test(retryAfter) ? Date.parse(retryAfter) - Date.now() : NaN
  return new ApiError(
    typeof problem.error === 'string' ? problem.error : 'Request failed', status,
    typeof problem.code === 'string' ? problem.code : 'HTTP_ERROR', problem.retryable === true,
    Number.isFinite(delay) ? Math.min(2147483647, Math.max(0, delay)) : undefined,
  )
}

function queryString(query: object): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value))
  const encoded = params.toString()
  return encoded ? `?${encoded}` : ''
}

function resourceId(value: string): string {
  if (!value || value === '.' || value === '..') throw new ApiError('Invalid resource ID', 400, 'INVALID_INPUT')
  return encodeURIComponent(value)
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
  })
}

/** Framework-free fetch client; all cached reads revalidate with the authenticated API. */
export function createInboxClient(options: InboxClientOptions = {}) {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis)
  const baseUrl = (options.baseUrl ?? '').replace(/\/+$/, '')
  const maximum = options.cacheMaxEntries ?? 64
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new RangeError('cacheMaxEntries must be a nonnegative integer')
  let headers = new Headers(options.headers)
  let scope = options.cacheScope
  let credentialsVersion = 0
  let cacheVersion = 0
  let credentialsController = new AbortController()
  const cache = new Map<string, CacheEntry>()

  function clearCache(): void { cacheVersion++; cache.clear() }

  function setCredentials(next: { headers?: HeadersInit; cacheScope?: string }): void {
    const replacement = new Headers(next.headers)
    credentialsController.abort(new DOMException('Credentials changed', 'AbortError'))
    credentialsController = new AbortController()
    credentialsVersion++
    headers = replacement
    scope = next.cacheScope
    clearCache()
  }

  function url(path: string): string {
    if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith('//') || /[\r\n\\#]/.test(path)) {
      throw new ApiError('Requests must use an API-relative path', 400, 'INVALID_PATH')
    }
    const relative = path.startsWith('/') ? path : `/${path}`
    return `${baseUrl}${relative === '/health' || relative.startsWith('/health?') || relative === '/v1' || relative.startsWith('/v1/') ? relative : `/v1${relative}`}`
  }

  async function perform<T>(path: string, init: RequestInit = {}, binary = false): Promise<{ data: T; headers: Headers }> {
    const target = url(path)
    const method = (init.method ?? 'GET').toUpperCase()
    binary ||= method === 'GET' && /\/v1\/blobs\//.test(target)
    const readPost = method === 'POST' && ['/v1/mailbox-snapshot', '/v1/mailbox-changes'].some(path => target.endsWith(path))
    const mutation = !readPost && !['GET', 'HEAD', 'OPTIONS'].includes(method)
    if (mutation) clearCache()
    const version = credentialsVersion
    const generation = cacheVersion
    const signal = init.signal
      ? AbortSignal.any([init.signal, credentialsController.signal])
      : credentialsController.signal
    const requestHeaders = new Headers(headers)
    new Headers(init.headers).forEach((value, key) => requestHeaders.set(key, value))
    if (!requestHeaders.has('accept')) requestHeaders.set('Accept', binary ? 'application/octet-stream' : 'application/json')
    if (typeof init.body === 'string' && !requestHeaders.has('content-type')) requestHeaders.set('Content-Type', 'application/json')
    const canCache = !!scope && maximum > 0 && method === 'GET' && !binary && init.cache !== 'no-store'
      && !/\/v1\/(?:blobs(?:\/|\?|$)|events(?:\?|$))/.test(target)
      && !requestHeaders.has('range') && !requestHeaders.has('if-range') && !requestHeaders.has('if-none-match')
    // Include per-request credentials and representation headers, not just the URL or caller's scope label.
    const key = JSON.stringify([scope, target, [...requestHeaders.entries()].sort(([a], [b]) => a.localeCompare(b)), init.credentials ?? 'include'])
    let cached = canCache ? cache.get(key) : undefined
    if (cached) requestHeaders.set('If-None-Match', cached.etag)
    const ensureCurrent = () => {
      signal.throwIfAborted()
      if (version !== credentialsVersion) throw new DOMException('Credentials changed', 'AbortError')
    }
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        ensureCurrent()
        const response = await fetcher(target, { ...init, method, headers: requestHeaders, credentials: init.credentials ?? 'include', cache: 'no-store', signal })
        ensureCurrent()
        if (response.status === 304) {
          const returnedTag = response.headers.get('etag')
          if (cached && generation === cacheVersion && canCache && (!returnedTag || returnedTag === cached.etag)) {
            cache.delete(key)
            if (!/(?:^|,)\s*no-store\b/i.test(response.headers.get('cache-control') ?? '')) {
              cache.set(key, cached)
              while (cache.size > maximum) cache.delete(cache.keys().next().value!)
            }
            return { data: JSON.parse(cached.text) as T, headers: new Headers(cached.headers) }
          }
          requestHeaders.delete('If-None-Match')
          cache.delete(key)
          cached = undefined
          continue
        }
        if (!response.ok) {
          if (version === credentialsVersion) cache.delete(key)
          let problem: unknown
          try { problem = await response.json() } catch { problem = null }
          ensureCurrent()
          throw apiProblem(problem, response.status, response.headers)
        }
        if (response.status === 204 || method === 'HEAD') return { data: undefined as T, headers: response.headers }
        if (binary) {
          const data = new Uint8Array(await response.arrayBuffer())
          ensureCurrent()
          return { data: data as T, headers: response.headers }
        }
        const contentType = response.headers.get('content-type') ?? ''
        const text = await response.text()
        ensureCurrent()
        let data: unknown = text
        const isJson = /\bapplication\/(?:[\w.+-]+\+)?json\b/i.test(contentType)
        if (isJson) {
          try { data = JSON.parse(text) }
          catch { throw new ApiError('The API returned invalid JSON', 502, 'INVALID_RESPONSE') }
        }
        const tag = response.headers.get('etag')
        if (canCache && isJson && response.status === 200 && tag && generation === cacheVersion
          && !/(?:^|,)\s*no-store\b/i.test(response.headers.get('cache-control') ?? '')
          && response.headers.get('vary')?.trim() !== '*' && new TextEncoder().encode(text).byteLength <= MAX_CACHE_BODY) {
          cache.delete(key)
          cache.set(key, { text, etag: tag, headers: new Headers(response.headers) })
          while (cache.size > maximum) cache.delete(cache.keys().next().value!)
        } else if (canCache && generation === cacheVersion) cache.delete(key)
        return { data: data as T, headers: response.headers }
      }
      throw new ApiError('The API returned 304 without a usable cached representation', 502, 'CACHE_MISS', true)
    } finally { if (mutation && version === credentialsVersion) clearCache() }
  }

  async function request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    return (await perform<T>(path, init)).data
  }

  function write<T>(path: string, method: string, input: unknown, requestOptions: InboxRequestOptions = {}, extraHeaders?: HeadersInit): Promise<T> {
    return request<T>(path, { method, body: input === undefined ? undefined : JSON.stringify(input), signal: requestOptions.signal, headers: extraHeaders })
  }

  async function conditional<T>(path: string, expectedRevision: number, method: 'PATCH' | 'DELETE' | 'PUT', input: unknown, requestOptions: InboxRequestOptions, field: 'revision' | 'version' = 'revision'): Promise<T> {
    const signal = AbortSignal.any([credentialsController.signal, ...(requestOptions.signal ? [requestOptions.signal] : [])])
    const current = await perform<Record<'revision' | 'version', number>>(path, { signal, cache: 'no-store' })
    signal.throwIfAborted()
    if (current.data[field] !== expectedRevision) throw new ApiError('The resource has changed', 412, 'PRECONDITION_FAILED')
    const tag = current.headers.get('etag')
    if (!tag || !/^"[^"\r\n]+"$/.test(tag)) throw new ApiError('The API did not provide an entity ETag', 502, 'INVALID_RESPONSE')
    return write<T>(path, method, input, { signal }, { 'If-Match': tag })
  }

  function events(eventOptions: InboxEventsOptions = {}): AsyncIterableIterator<InboxEvent> {
    const controller = new AbortController()
    const version = credentialsVersion
    const signal = AbortSignal.any([controller.signal, credentialsController.signal, ...(eventOptions.signal ? [eventOptions.signal] : [])])
    const reconnectMs = eventOptions.reconnectMs ?? 1000
    if (!Number.isSafeInteger(reconnectMs) || reconnectMs < 0 || reconnectMs > 2147483647) throw new RangeError('reconnectMs must be a nonnegative integer')
    if (eventOptions.since !== undefined && (!eventOptions.since || eventOptions.since.length > 4096 || /[\u0000-\u001f\u007f]/.test(eventOptions.since))) {
      throw new ApiError('Invalid event state', 400, 'INVALID_CURSOR')
    }
    async function* stream(): AsyncGenerator<InboxEvent, void, unknown> {
      let cursor = eventOptions.since
      let retryMs = reconnectMs
      let failures = 0
      while (!signal.aborted && version === credentialsVersion) {
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
        let body: ReadableStream<Uint8Array> | null | undefined
        let retryAfterMs = 0
        const startedAt = Date.now()
        const cancelReader = () => { void reader?.cancel().catch(() => {}) }
        try {
          const requestHeaders = new Headers(headers)
          requestHeaders.set('Accept', 'text/event-stream')
          if (cursor !== undefined) requestHeaders.set('Last-Event-ID', cursor)
          const response = await fetcher(url(`/events${queryString(cursor === undefined ? {} : { since: cursor })}`), { headers: requestHeaders, credentials: 'include', cache: 'no-store', signal })
          body = response.body
          if (signal.aborted || version !== credentialsVersion) { await response.body?.cancel().catch(() => {}); return }
          if (!response.ok) {
            let problem: unknown
            try { problem = await response.json() } catch { problem = null }
            throw apiProblem(problem, response.status, response.headers)
          }
          if (!(response.headers.get('content-type') ?? '').toLowerCase().startsWith('text/event-stream') || !response.body) {
            throw new ApiError('The API did not return an event stream', 502, 'INVALID_EVENT_STREAM')
          }
          reader = response.body.getReader()
          signal.addEventListener('abort', cancelReader, { once: true })
          if (signal.aborted) return
          const decoder = new TextDecoder()
          let buffer = ''
          let eventType = ''
          let eventId: string | undefined
          let data: string[] = []
          let dataSize = 0
          let pendingCR = false
          while (!signal.aborted) {
            const { done, value } = await reader.read()
            if (signal.aborted || version !== credentialsVersion) return
            if (done) break
            let chunk = decoder.decode(value, { stream: true })
            if (!chunk) continue
            if (pendingCR && chunk.startsWith('\n')) chunk = chunk.slice(1)
            pendingCR = chunk.endsWith('\r')
            chunk = chunk.replace(/\r\n?/g, '\n')
            buffer += chunk
            let newline: number
            while ((newline = buffer.indexOf('\n')) >= 0) {
              if (signal.aborted || version !== credentialsVersion) return
              const line = buffer.slice(0, newline)
              buffer = buffer.slice(newline + 1)
              if (line.length > MAX_EVENT_BUFFER) throw new ApiError('Event frame exceeds the size limit', 502, 'INVALID_EVENT_STREAM')
              if (line === '') {
                if (data.length) {
                  let parsed: unknown
                  try { parsed = JSON.parse(data.join('\n')) }
                  catch { throw new ApiError('The API returned invalid event JSON', 502, 'INVALID_EVENT_STREAM') }
                  if (!parsed || typeof parsed !== 'object') throw new ApiError('The API returned an invalid event', 502, 'INVALID_EVENT_STREAM')
                  const payload = parsed as Record<string, unknown>
                  if (eventType === 'error') throw apiProblem(parsed, 503)
                  if (eventType === 'ready' || eventType === 'reset.required') {
                    if (typeof payload.state !== 'string' || !payload.state || payload.state.length > 4096 || /[\u0000-\u001f\u007f]/.test(payload.state)) throw new ApiError('The API returned invalid event state', 502, 'INVALID_EVENT_STREAM')
                    clearCache()
                    // ready anchors the starting cursor, never the end of undelivered replay.
                    cursor = payload.state
                    yield { type: eventType, state: payload.state }
                  } else if (changeTypes.has(eventType)) {
                    if (typeof payload.id !== 'string' || !payload.id || payload.id.length > 4096 || payload.type !== eventType || eventId !== payload.id || /[\u0000-\u001f\u007f]/.test(payload.id)
                      || payload.accountId !== null && typeof payload.accountId !== 'string' || typeof payload.entityId !== 'string' || typeof payload.at !== 'string'
                      || payload.mailboxId !== undefined && (typeof payload.mailboxId !== 'string' || !payload.mailboxId || payload.mailboxId.length > 512 || /[\u0000-\u001f\u007f/\\]/.test(payload.mailboxId))
                      || !['created', 'updated', 'deleted'].includes(String(payload.change)) || !['arrival', 'initial', 'backfill', 'mutation'].includes(String(payload.reason))) {
                      throw new ApiError('The API returned an invalid change event', 502, 'INVALID_EVENT_STREAM')
                    }
                    cursor = payload.id
                    clearCache()
                    yield {
                      id: payload.id, type: eventType as ChangeEvent['type'], accountId: payload.accountId as string | null,
                      entityId: payload.entityId as string, change: payload.change as ChangeEvent['change'],
                      reason: payload.reason as ChangeEvent['reason'], at: payload.at as string,
                      ...(payload.mailboxId === undefined ? {} : { mailboxId: payload.mailboxId as string }),
                    }
                  }
                }
                eventType = ''
                eventId = undefined
                data = []
                dataSize = 0
                continue
              }
              if (line.startsWith(':')) continue
              const colon = line.indexOf(':')
              const field = colon < 0 ? line : line.slice(0, colon)
              const rawValue = colon < 0 ? '' : line.slice(colon + 1)
              const fieldValue = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue
              if (field === 'event') eventType = fieldValue
              else if (field === 'id' && !fieldValue.includes('\0')) eventId = fieldValue
              else if (field === 'data') {
                data.push(fieldValue)
                dataSize += fieldValue.length + 1
                if (dataSize > MAX_EVENT_BUFFER) throw new ApiError('Event frame exceeds the size limit', 502, 'INVALID_EVENT_STREAM')
              } else if (field === 'retry' && /^\d+$/.test(fieldValue)) retryMs = Math.min(30000, Math.max(100, Number(fieldValue)))
            }
            if (buffer.length > MAX_EVENT_BUFFER) throw new ApiError('Event frame exceeds the size limit', 502, 'INVALID_EVENT_STREAM')
          }
        } catch (error) {
          if (signal.aborted || version !== credentialsVersion) return
          if (eventOptions.reconnect === false) throw error
          if (error instanceof ApiError && !error.retryable) throw error
          if (!(error instanceof ApiError) && !(error instanceof TypeError)) throw error
          if (error instanceof ApiError) retryAfterMs = error.retryAfterMs ?? 0
        } finally {
          signal.removeEventListener('abort', cancelReader)
          // A rejected content type can still have a live response body; release it too.
          if (reader) await reader.cancel().catch(() => {})
          else await body?.cancel().catch(() => {})
          reader?.releaseLock()
        }
        if (eventOptions.reconnect === false) return
        // Rapid failures/early closes must not turn every tab into a one-second retry loop.
        // A healthy stream rotation resets the backoff, but a ready frame alone does not.
        failures = Date.now() - startedAt >= 30000 ? 0 : Math.min(failures + 1, 8)
        const backoff = failures ? Math.min(30000, Math.max(1000, retryMs) * 2 ** (failures - 1)) : retryMs
        const delay = failures ? backoff * (0.75 + Math.random() * 0.25) : backoff
        await wait(Math.max(retryAfterMs, delay), signal)
      }
    }
    const iterator = stream()
    return {
      [Symbol.asyncIterator]() { return this },
      next: () => iterator.next(),
      return: async () => { controller.abort(); return iterator.return(undefined) },
      throw: async (error?: unknown) => { controller.abort(); return iterator.throw(error) },
    }
  }

  return {
    request,
    events,
    subscribe: (listener: () => void, eventOptions: InboxSubscriptionOptions = {}): (() => void) => {
      const iterator = events(eventOptions)
      void (async () => {
        try { for await (const event of iterator) if (event.type !== 'ready') listener() }
        catch (error) { eventOptions.onError?.(error) }
      })()
      return () => { void iterator.return?.().catch(() => {}) }
    },
    clearCache,
    setCredentials,
    providers: (requestOptions: InboxRequestOptions = {}) => request<Result<'providers'>>('/providers', requestOptions),
    connections: (requestOptions: InboxRequestOptions = {}) => request<Result<'connections'>>('/connections', requestOptions),
    connection: (id: string, requestOptions: InboxRequestOptions = {}) => request<Result<'connection'>>(`/connections/${resourceId(id)}`, requestOptions),
    credentialState: (id: string, requestOptions: InboxRequestOptions = {}) => request<Result<'credentialState'>>(`/connections/${resourceId(id)}/credentials`, { ...requestOptions, cache: 'no-store' }),
    updateCredentials: (id: string, credentials: Record<string, unknown>, version: number, requestOptions: InboxRequestOptions = {}) =>
      conditional<Result<'updateCredentials'>>(`/connections/${resourceId(id)}/credentials`, version, 'PUT', { credentials }, requestOptions, 'version'),
    createConnection: (input: Parameters<Inbox['createConnection']>[1], requestOptions: InboxRequestOptions = {}) => write<Result<'createConnection'>>('/connections', 'POST', input, requestOptions),
    disconnectConnection: (id: string, requestOptions: InboxRequestOptions = {}) => write<void>(`/connections/${resourceId(id)}`, 'DELETE', undefined, requestOptions),
    mailboxCandidates: (connectionId: string, requestOptions: InboxRequestOptions = {}) => request<Result<'mailboxCandidates'>>(`/connections/${resourceId(connectionId)}/mailbox-candidates`, requestOptions),
    mailboxes: (requestOptions: InboxRequestOptions = {}) => request<Result<'mailboxes'>>('/mailboxes', requestOptions),
    mailbox: (id: string, requestOptions: InboxRequestOptions = {}) => request<Result<'mailbox'>>(`/mailboxes/${resourceId(id)}`, requestOptions),
    createMailbox: (input: MailboxInput, requestOptions: InboxRequestOptions = {}) => write<Result<'createMailbox'>>('/mailboxes', 'POST', input, requestOptions),
    updateMailbox: (id: string, input: Parameters<Inbox['updateMailbox']>[2], revision: number, requestOptions: InboxRequestOptions = {}) => conditional<Result<'updateMailbox'>>(`/mailboxes/${resourceId(id)}`, revision, 'PATCH', input, requestOptions),
    syncMailbox: (id: string, input: SyncRequest = {}, requestOptions: InboxRequestOptions = {}) => write<Result<'syncMailbox'>>(`/mailboxes/${resourceId(id)}/sync`, 'POST', input, requestOptions),
    mailboxMessages: (input: MailboxQuery, requestOptions: InboxRequestOptions = {}) => {
      if (!Array.isArray(input.mailboxIds) || input.mailboxIds.length < 1 || input.mailboxIds.length > 50
        || input.mailboxIds.some((value) => typeof value !== 'string' || !value || value.length > 512 || /[\u0000-\u001f\u007f/\\,]/.test(value))) {
        throw new ApiError('Select between 1 and 50 valid mailbox IDs', 400, 'INVALID_INPUT')
      }
      return request<Result<'mailboxMessages'>>(`/mailbox-messages${queryString({ ...input, mailboxIds: [...new Set(input.mailboxIds)].sort().join(',') })}`, requestOptions)
    },
    mailboxMessage: (mailboxId: string, messageId: string, requestOptions: InboxRequestOptions = {}) => request<Result<'mailboxMessage'>>(`/mailboxes/${resourceId(mailboxId)}/messages/${resourceId(messageId)}`, requestOptions),
    mailboxSnapshot: (input: Parameters<Inbox['mailboxSnapshot']>[1], requestOptions: InboxRequestOptions = {}) => write<Result<'mailboxSnapshot'>>('/mailbox-snapshot', 'POST', input, requestOptions),
    mailboxChanges: (input: Parameters<Inbox['mailboxChanges']>[1], requestOptions: InboxRequestOptions = {}) => write<Result<'mailboxChanges'>>('/mailbox-changes', 'POST', input, requestOptions),
    setMailboxStates: (input: Parameters<Inbox['setMailboxStates']>[1], requestOptions: InboxRequestOptions = {}) => write<Result<'setMailboxStates'>>('/mailbox-actions', 'POST', input, requestOptions),
    undoMailboxStates: (id: string, requestOptions: InboxRequestOptions = {}) => write<Result<'undoMailboxStates'>>(`/mailbox-actions/${resourceId(id)}/undo`, 'POST', undefined, requestOptions),
    setMailboxState: async (mailboxId: string, messageId: string, input: Parameters<Inbox['setMailboxState']>[3], revision: number, requestOptions: InboxRequestOptions = {}): Promise<Result<'setMailboxState'>> => {
      const path = `/mailboxes/${resourceId(mailboxId)}/messages/${resourceId(messageId)}`
      const signal = AbortSignal.any([credentialsController.signal, ...(requestOptions.signal ? [requestOptions.signal] : [])])
      const current = await perform<Result<'mailboxMessage'>>(path, { signal, cache: 'no-store' })
      signal.throwIfAborted()
      const membership = current.data.memberships?.find((item) => item.mailboxId === mailboxId && item.messageId === messageId)
      if (!membership) throw new ApiError('The API did not provide the requested membership', 502, 'INVALID_RESPONSE')
      if (membership.revision !== revision) throw new ApiError('The resource has changed', 412, 'PRECONDITION_FAILED')
      const tag = current.headers.get('etag')
      if (!tag || !/^"[^"\r\n]+"$/.test(tag)) throw new ApiError('The API did not provide an entity ETag', 502, 'INVALID_RESPONSE')
      return write<Result<'setMailboxState'>>(`${path}/state`, 'PATCH', input, { signal }, { 'If-Match': tag })
    },
    connect: (input: Parameters<Inbox['connect']>[1], requestOptions: InboxRequestOptions = {}) => write<Result<'connect'>>('/accounts', 'POST', input, requestOptions),
    reconnect: (id: string, credentials: Record<string, unknown>, requestOptions: InboxRequestOptions = {}) => write<Result<'reconnect'>>(`/accounts/${resourceId(id)}/reconnect`, 'POST', credentials, requestOptions),
    disconnect: (id: string, requestOptions: InboxRequestOptions = {}) => write<void>(`/accounts/${resourceId(id)}`, 'DELETE', undefined, requestOptions),
    accounts: (requestOptions: InboxRequestOptions = {}) => request<Result<'accounts'>>('/accounts', requestOptions),
    account: (id: string, requestOptions: InboxRequestOptions = {}) => request<Result<'account'>>(`/accounts/${resourceId(id)}`, requestOptions),
    sync: (id: string, input: SyncRequest = {}, requestOptions: InboxRequestOptions = {}) => write<Result<'sync'>>(`/accounts/${resourceId(id)}/sync`, 'POST', input, requestOptions),
    folders: (accountId: string, requestOptions: InboxRequestOptions = {}) => request<Result<'folders'>>(`/accounts/${resourceId(accountId)}/folders`, requestOptions),
    cachedFolders: (accountId: string, requestOptions: InboxRequestOptions = {}) => request<Result<'cachedFolders'>>(`/accounts/${resourceId(accountId)}/folders?cached=true`, requestOptions),
    createFolder: (accountId: string, name: string, requestOptions: InboxRequestOptions = {}) => write<Result<'createFolder'>>(`/accounts/${resourceId(accountId)}/folders`, 'POST', { name }, requestOptions),
    messages: (input: Query = {}, requestOptions: InboxRequestOptions = {}) => request<Result<'messages'>>(`/messages${queryString(input)}`, requestOptions),
    message: (id: string, requestOptions: InboxRequestOptions = {}) => request<Result<'message'>>(`/messages/${resourceId(id)}`, requestOptions),
    threads: (input: Query = {}, requestOptions: InboxRequestOptions = {}) => request<Result<'threads'>>(`/threads${queryString(input)}`, requestOptions),
    thread: (id: string, input: Pick<Query, 'cursor' | 'limit' | 'sort'> = {}, requestOptions: InboxRequestOptions = {}) => request<Result<'thread'>>(`/threads/${resourceId(id)}${queryString(input)}`, requestOptions),
    labels: (accountId?: string, requestOptions: InboxRequestOptions = {}) => request<Label[]>(`/labels${queryString({ accountId })}`, requestOptions),
    label: (id: string, requestOptions: InboxRequestOptions = {}) => request<Label>(`/labels/${resourceId(id)}`, requestOptions),
    createLabel: (accountId: string, name: string, requestOptions: InboxRequestOptions = {}) => write<Label>('/labels', 'POST', { accountId, name }, requestOptions),
    updateLabel: (id: string, name: string, revision: number, requestOptions: InboxRequestOptions = {}) => conditional<Label>(`/labels/${resourceId(id)}`, revision, 'PATCH', { name }, requestOptions),
    deleteLabel: (id: string, requestOptions: InboxRequestOptions = {}) => write<void>(`/labels/${resourceId(id)}`, 'DELETE', undefined, requestOptions),
    upload: (accountId: string, file: Parameters<Inbox['upload']>[2], requestOptions: InboxRequestOptions = {}) => {
      const form = new FormData()
      form.set('accountId', accountId)
      form.set('file', new Blob([new Uint8Array(file.content).buffer], { type: file.contentType }), file.filename)
      if (file.inline !== undefined) form.set('inline', String(file.inline))
      if (file.contentId !== undefined) form.set('contentId', file.contentId)
      return request<BlobInfo>('/blobs', { method: 'POST', body: form, signal: requestOptions.signal })
    },
    download: async (id: string, requestOptions: InboxRequestOptions = {}): Promise<Result<'download'>> => {
      const result = await perform<Uint8Array>(`/blobs/${resourceId(id)}`, requestOptions, true)
      let info: BlobInfo
      try {
        info = JSON.parse(decodeURIComponent(result.headers.get('x-inbox-blob-info') ?? ''))
        if (info.id !== id || typeof info.accountId !== 'string' || typeof info.filename !== 'string' || typeof info.contentType !== 'string' || info.size !== result.data.byteLength) throw new Error()
      } catch { throw new ApiError('The API returned invalid attachment metadata', 502, 'INVALID_RESPONSE') }
      return { info, content: result.data }
    },
    drafts: (accountId?: string, requestOptions: InboxRequestOptions = {}) => request<Draft[]>(`/drafts${queryString({ accountId })}`, requestOptions),
    createDraft: (input: DraftInput, requestOptions: InboxRequestOptions = {}) => write<Draft>('/drafts', 'POST', input, requestOptions),
    draft: (id: string, requestOptions: InboxRequestOptions = {}) => request<Draft>(`/drafts/${resourceId(id)}`, requestOptions),
    updateDraft: (id: string, input: Partial<DraftInput>, revision: number, requestOptions: InboxRequestOptions = {}) => conditional<Draft>(`/drafts/${resourceId(id)}`, revision, 'PATCH', input, requestOptions),
    deleteDraft: (id: string, revision: number, requestOptions: InboxRequestOptions = {}) => conditional<void>(`/drafts/${resourceId(id)}`, revision, 'DELETE', undefined, requestOptions),
    submit: (id: string, input: Parameters<Inbox['submit']>[2], requestOptions: InboxRequestOptions = {}) => {
      const { idempotencyKey, ...payload } = input
      return write<Result<'submit'>>(`/drafts/${resourceId(id)}/submit`, 'POST', payload, requestOptions, { 'Idempotency-Key': idempotencyKey })
    },
    mutate: (input: MutationInput, requestOptions: InboxRequestOptions = {}) => {
      const { idempotencyKey, ...payload } = input
      return write<Result<'mutate'>>('/operations', 'POST', payload, requestOptions, { 'Idempotency-Key': idempotencyKey })
    },
    operation: (id: string, requestOptions: InboxRequestOptions = {}) => request<Result<'operation'>>(`/operations/${resourceId(id)}`, requestOptions),
    cancel: (id: string, requestOptions: InboxRequestOptions = {}) => write<Result<'cancel'>>(`/operations/${resourceId(id)}/cancel`, 'POST', undefined, requestOptions),
    reschedule: (id: string, sendAt: string, requestOptions: InboxRequestOptions = {}) => write<Result<'reschedule'>>(`/operations/${resourceId(id)}/reschedule`, 'POST', { sendAt }, requestOptions),
    undo: (id: string, requestOptions: InboxRequestOptions = {}) => write<Result<'undo'>>(`/operations/${resourceId(id)}/undo`, 'POST', undefined, requestOptions),
    policy: (requestOptions: InboxRequestOptions = {}) => request<Policy>('/policy', requestOptions),
    setPolicy: (input: Partial<Policy>, requestOptions: InboxRequestOptions = {}) => write<Policy>('/policy', 'PATCH', input, requestOptions),
    changes: (input: { since?: string; limit?: number } = {}, requestOptions: InboxRequestOptions = {}) => request<Result<'changes'>>(`/changes${queryString(input)}`, requestOptions),
  }
}

export type InboxClient = ReturnType<typeof createInboxClient>
