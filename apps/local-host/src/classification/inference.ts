import { classificationSchema, labelingInstructions, validateClassification, validateClassificationInput, type Classification, type ClassificationInput } from './schema'

const endpoint = 'https://opencode.ai/inference/openai/v1/responses'
const defaultModel = 'gpt-5.6-sol'
const timeoutMs = 120_000
const maxRequestBytes = 1_048_576
const maxResponseBytes = 262_144
const maxOutputCharacters = 32_768
const errorCodes = new Set([
  'INFERENCE_AUTH_MISSING', 'INFERENCE_AUTH_INVALID', 'INFERENCE_ENDPOINT_INVALID', 'INFERENCE_OPTIONS_INVALID',
  'INFERENCE_INPUT_INVALID', 'INFERENCE_INPUT_TOO_LARGE', 'INFERENCE_HTTP_ERROR', 'INFERENCE_TIMEOUT', 'INFERENCE_ABORTED',
  'INFERENCE_NETWORK_ERROR', 'INFERENCE_RESPONSE_TOO_LARGE', 'INFERENCE_RESPONSE_INVALID', 'INFERENCE_RESPONSE_FAILED',
  'INFERENCE_INCOMPLETE', 'INFERENCE_REFUSED', 'INFERENCE_OUTPUT_MISSING', 'INFERENCE_OUTPUT_INVALID',
  'INFERENCE_CLASSIFICATION_INVALID', 'INFERENCE_FAILURE',
  'CLASSIFICATION_INPUT_INVALID', 'CLASSIFICATION_SHAPE_INVALID', 'CLASSIFICATION_DUPLICATE_LABEL',
  'CLASSIFICATION_CONTRADICTION', 'CLASSIFICATION_EVIDENCE_LABEL_MISMATCH', 'CLASSIFICATION_EVIDENCE_NOT_FOUND',
  'CLASSIFICATION_EVIDENCE_MISSING', 'CLASSIFICATION_DEADLINE_NOT_GROUNDED',
])

/** Only fixed codes and an HTTP status can cross this boundary; never retain a response, request, or cause. */
export class InferenceError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly status?: number
  readonly retryAfterMs?: number

  constructor(code: string, retryable = false, status?: number, retryAfterMs?: number) {
    const safeCode = errorCodes.has(code) ? code : 'INFERENCE_FAILURE'
    super(safeCode)
    this.name = 'InferenceError'
    this.code = safeCode
    this.retryable = retryable === true
    if (Number.isInteger(status) && status! >= 100 && status! <= 599) this.status = status
    if (Number.isFinite(retryAfterMs) && retryAfterMs! >= 0) this.retryAfterMs = Math.ceil(retryAfterMs!)
  }
}

export type InferenceOptions = {
  apiKey: string
  model?: string
  endpoint?: string
  orgId?: string
  signal?: AbortSignal
  fetcher?: typeof fetch
}

export type InferenceResult = {
  classification: Classification
  responseId: string | null
  model: string
  usage: { inputTokens: number; outputTokens: number }
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(value)
const tokenCount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 10_000_000

function authorizedEndpoint(value: string | undefined): string {
  try {
    const url = new URL(value ?? endpoint)
    if (url.protocol === 'https:' && url.hostname === 'opencode.ai' && url.pathname === '/inference/openai/v1/responses' &&
      !url.port && !url.username && !url.password && !url.search && !url.hash) return endpoint
  } catch { /* A malformed URL must not be included in the error. */ }
  throw new InferenceError('INFERENCE_ENDPOINT_INVALID')
}

async function readResponse(response: Response): Promise<unknown> {
  if (!response.body) throw new InferenceError('INFERENCE_OUTPUT_MISSING')
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0
  let text = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > maxResponseBytes) {
        void reader.cancel().catch(() => {})
        throw new InferenceError('INFERENCE_RESPONSE_TOO_LARGE')
      }
      try { text += decoder.decode(chunk.value, { stream: true }) }
      catch { throw new InferenceError('INFERENCE_RESPONSE_INVALID', true) }
    }
    try { text += decoder.decode() }
    catch { throw new InferenceError('INFERENCE_RESPONSE_INVALID', true) }
  } finally { reader.releaseLock() }
  try { return JSON.parse(text) }
  catch { throw new InferenceError('INFERENCE_RESPONSE_INVALID', true) }
}

function parseResult(value: unknown, input: ClassificationInput): InferenceResult {
  if (!object(value)) throw new InferenceError('INFERENCE_RESPONSE_INVALID')
  if (value.status === 'incomplete' || value.status === 'cancelled' || value.incomplete_details != null) throw new InferenceError('INFERENCE_INCOMPLETE')
  if (value.status === 'failed' || value.error != null) throw new InferenceError('INFERENCE_RESPONSE_FAILED')
  if (value.status !== 'completed') throw new InferenceError('INFERENCE_INCOMPLETE')
  if (!Array.isArray(value.output) || !value.output.length) throw new InferenceError('INFERENCE_OUTPUT_MISSING')

  let output = ''
  for (const item of value.output) {
    if (!object(item)) throw new InferenceError('INFERENCE_RESPONSE_INVALID')
    // Reasoning is never retained or returned. No tool calls are requested or executed.
    if (item.type === 'reasoning') continue
    if (item.type !== 'message' || (item.role !== undefined && item.role !== 'assistant') || !Array.isArray(item.content)) throw new InferenceError('INFERENCE_RESPONSE_INVALID')
    if (item.status !== undefined && item.status !== 'completed') throw new InferenceError('INFERENCE_INCOMPLETE')
    for (const content of item.content) {
      if (!object(content)) throw new InferenceError('INFERENCE_RESPONSE_INVALID')
      if (content.type === 'refusal') throw new InferenceError('INFERENCE_REFUSED')
      if (content.type !== 'output_text' || typeof content.text !== 'string') throw new InferenceError('INFERENCE_OUTPUT_INVALID', true)
      output += content.text
      if (output.length > maxOutputCharacters) throw new InferenceError('INFERENCE_RESPONSE_TOO_LARGE')
    }
  }
  if (!output.trim()) throw new InferenceError('INFERENCE_OUTPUT_MISSING')

  let parsed: unknown
  try { parsed = JSON.parse(output) }
  catch { throw new InferenceError('INFERENCE_OUTPUT_INVALID', true) }
  let classification: Classification
  try { classification = validateClassification(parsed, input) }
  catch (error) {
    const code = error instanceof Error && errorCodes.has(error.message) ? error.message : 'INFERENCE_CLASSIFICATION_INVALID'
    throw new InferenceError(code, true)
  }

  if (!identifier(value.model) || (value.id != null && (typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(value.id))) ||
    !object(value.usage) || !tokenCount(value.usage.input_tokens) || !tokenCount(value.usage.output_tokens)) throw new InferenceError('INFERENCE_RESPONSE_INVALID')
  return {
    classification, responseId: typeof value.id === 'string' ? value.id : null, model: value.model,
    usage: { inputTokens: value.usage.input_tokens, outputTokens: value.usage.output_tokens },
  }
}

/** One bounded request only. Callers own retry scheduling and persistence. */
export async function classifyEmail(input: ClassificationInput, options: InferenceOptions): Promise<InferenceResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | undefined
  let timedOut = false
  let removeAbortListener = () => {}
  let removeExternalListener = () => {}
  try {
    if (typeof options?.apiKey !== 'string' || !options.apiKey.trim()) throw new InferenceError('INFERENCE_AUTH_MISSING')
    if (options.apiKey.length > 4_096 || !/^[\x21-\x7e]+$/.test(options.apiKey)) throw new InferenceError('INFERENCE_AUTH_INVALID')
    const url = authorizedEndpoint(options.endpoint)
    const model = options.model ?? defaultModel
    if (!identifier(model) || (options.orgId !== undefined && !/^[a-zA-Z0-9_-]{1,200}$/.test(options.orgId))) throw new InferenceError('INFERENCE_OPTIONS_INVALID')
    try { validateClassificationInput(input) }
    catch { throw new InferenceError('INFERENCE_INPUT_INVALID') }
    if (options.signal?.aborted) throw new InferenceError('INFERENCE_ABORTED')

    // Snapshot the validated source once: callers cannot change evidence while the request is in flight.
    const source: ClassificationInput = {
      subject: input.subject, from: input.from, to: [...input.to], cc: [...input.cc], receivedAt: input.receivedAt,
      bodyText: input.bodyText, bodyTruncated: input.bodyTruncated, facts: { ...input.facts },
    }
    const sourceText = JSON.stringify(source)
    const body = JSON.stringify({
      model, store: false, stream: false, max_output_tokens: 6_000,
      instructions: labelingInstructions,
      input: [{ role: 'user', content: [{ type: 'input_text', text: sourceText }] }],
      tools: [], tool_choice: 'none',
      text: { format: { type: 'json_schema', name: 'email_classification', strict: true, schema: classificationSchema } },
    })
    if (new TextEncoder().encode(body).byteLength > maxRequestBytes) throw new InferenceError('INFERENCE_INPUT_TOO_LARGE')
    const headers: Record<string, string> = { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' }
    if (options.orgId) headers['x-opencode-org-id'] = options.orgId

    controller = new AbortController()
    const requestController = controller
    const aborted = new Promise<never>((_, reject) => {
      const onAbort = () => reject(new InferenceError(timedOut ? 'INFERENCE_TIMEOUT' : 'INFERENCE_ABORTED', timedOut))
      requestController.signal.addEventListener('abort', onAbort, { once: true })
      removeAbortListener = () => requestController.signal.removeEventListener('abort', onAbort)
    })
    const onExternalAbort = () => requestController.abort()
    options.signal?.addEventListener('abort', onExternalAbort, { once: true })
    removeExternalListener = () => options.signal?.removeEventListener('abort', onExternalAbort)
    if (options.signal?.aborted) requestController.abort()
    timer = setTimeout(() => { timedOut = true; requestController.abort() }, timeoutMs)

    const request = async (): Promise<InferenceResult> => {
      const response = await (options.fetcher ?? fetch)(url, { method: 'POST', headers, body, redirect: 'error', signal: requestController.signal })
      if (!response.ok) {
        // Do not read error bodies: gateways can echo email, credentials, or prompts there.
        void response.body?.cancel().catch(() => {})
        const retryAfter = response.headers.get('retry-after')
        const retryAfterMs = retryAfter === null ? undefined : /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now())
        throw new InferenceError('INFERENCE_HTTP_ERROR', response.status === 408 || response.status === 429 || response.status >= 500, response.status, retryAfterMs)
      }
      if (response.redirected) throw new InferenceError('INFERENCE_ENDPOINT_INVALID')
      return parseResult(await readResponse(response), source)
    }
    return await Promise.race([request(), aborted])
  } catch (error) {
    if (error instanceof InferenceError) throw new InferenceError(error.code, error.retryable, error.status, error.retryAfterMs)
    if (controller?.signal.aborted) throw new InferenceError(timedOut ? 'INFERENCE_TIMEOUT' : 'INFERENCE_ABORTED', timedOut)
    // Native fetch, stream, JSON, and caller-supplied fetch errors may include sensitive data.
    throw new InferenceError('INFERENCE_NETWORK_ERROR', true)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    removeExternalListener()
    removeAbortListener()
    controller?.abort()
  }
}
