import { createHash } from 'node:crypto'
import { adjudicateEmail, classifyDeliberately, InferenceError, refinementProfile, type InferenceResult } from './inference'
import { validateClassification, validateClassificationInput, type Classification, type ClassificationInput } from './schema'

export { refinementProfile } from './inference'

export type RefinementRecord = {
  version: '1'; profileHash: string; cohortHash: string; exampleId: string; inputHash: string; primaryHash: string
  model: string; labelSource: 'llm'; bodyTruncated: boolean; originalClassification: Classification
  blind: InferenceResult | null; adjudicated: InferenceResult | null; selectedClassification: Classification | null
  trainingEligible: boolean; stage: 'blind' | 'adjudication' | 'complete'; status: 'unstarted' | 'succeeded' | 'failed'
  errorCode: string | null; httpStatus: number | null; retryAfterMs: number | null
}
export type RefinementOptions = {
  model: string; apiKey: string; orgId?: string; concurrency?: number; signal?: AbortSignal
  classifyDeliberately?: typeof classifyDeliberately; adjudicate?: typeof adjudicateEmail
  onResult?: (record: RefinementRecord) => void | Promise<void>
  /** Latest persisted record per ID, not the append-only checkpoint history. */
  completed?: RefinementRecord[]
  /** Explicit retry of the failed stage only; callers retain prior failures in their checkpoint history. */
  retryFailed?: boolean
}

const fail = (code: string): never => { throw new InferenceError(code) }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(value)
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const hash = (value: unknown) => digest(JSON.stringify(value))
const canonical = (value: unknown) => JSON.stringify(value, (_, item) => object(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
const noError = { errorCode: null, httpStatus: null, retryAfterMs: null }
const labels = (value: Classification) => [value.primaryType, [...value.secondaryTypes].sort(), [...value.actions].sort(), value.timeSensitivity, value.deadline, value.risk]
const needsAdjudication = (primary: Classification, blind: Classification) => primary.certainty !== 'clear' || blind.certainty !== 'clear' || hash(labels(primary)) !== hash(labels(blind))

function checkedResult(result: InferenceResult, input: ClassificationInput): InferenceResult {
  try {
    validateClassification(result.classification, input)
    if (!identifier(result.model) || !(result.responseId === null || typeof result.responseId === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(result.responseId)) ||
      !result.usage || ![result.usage.inputTokens, result.usage.outputTokens].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000)) fail('REFINEMENT_RESULT_INVALID')
    return structuredClone({ classification: result.classification, model: result.model, responseId: result.responseId,
      usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens } })
  } catch { return fail('REFINEMENT_RESULT_INVALID') }
}

function finish(record: RefinementRecord): void {
  const selected = record.adjudicated?.classification ?? record.blind!.classification
  Object.assign(record, noError, {
    stage: 'complete', status: 'succeeded', selectedClassification: structuredClone(selected),
    trainingEligible: !record.bodyTruncated && selected.certainty === 'clear' && selected.primaryType !== 'unknown',
  })
}

function restore(previous: RefinementRecord, initial: RefinementRecord, input: ClassificationInput): RefinementRecord {
  try {
    const stored = structuredClone(previous), record = structuredClone(initial)
    for (const key of ['version', 'profileHash', 'cohortHash', 'exampleId', 'inputHash', 'primaryHash', 'model', 'labelSource', 'bodyTruncated'] as const) {
      if (stored[key] !== record[key]) fail('REFINEMENT_RESUME_INVALID')
    }
    validateClassification(stored.originalClassification, input)
    if (hash(stored.originalClassification) !== record.primaryHash) fail('REFINEMENT_RESUME_INVALID')
    record.blind = stored.blind === null ? null : checkedResult(stored.blind, input)
    record.adjudicated = stored.adjudicated === null ? null : checkedResult(stored.adjudicated, input)
    const review = record.blind && needsAdjudication(record.originalClassification, record.blind.classification)
    if (stored.stage === 'complete' && stored.status === 'succeeded') {
      if (!record.blind || Boolean(record.adjudicated) !== Boolean(review)) fail('REFINEMENT_RESUME_INVALID')
      finish(record)
    } else {
      if (!['unstarted', 'failed'].includes(stored.status) || record.adjudicated ||
        !(stored.stage === 'blind' && !record.blind || stored.stage === 'adjudication' && record.blind && review)) fail('REFINEMENT_RESUME_INVALID')
      if (stored.errorCode !== null) {
        const safe = new InferenceError(stored.errorCode, false, stored.httpStatus ?? undefined, stored.retryAfterMs ?? undefined)
        if (safe.code !== stored.errorCode || (safe.status ?? null) !== stored.httpStatus || (safe.retryAfterMs ?? null) !== stored.retryAfterMs) fail('REFINEMENT_RESUME_INVALID')
      } else if (stored.httpStatus !== null || stored.retryAfterMs !== null || stored.status === 'failed') fail('REFINEMENT_RESUME_INVALID')
      if (stored.status === 'unstarted' && (stored.httpStatus !== null || stored.errorCode !== null && !['REFINEMENT_RATE_LIMITED', 'REFINEMENT_CONFIGURATION_STOPPED', 'INFERENCE_ABORTED'].includes(stored.errorCode))) fail('REFINEMENT_RESUME_INVALID')
      Object.assign(record, { stage: stored.stage, status: stored.status, errorCode: stored.errorCode, httpStatus: stored.httpStatus, retryAfterMs: stored.retryAfterMs })
    }
    // Reject altered selections, eligibility, metadata, or additional fields rather than trusting a checkpoint's labels.
    if (canonical(record) !== canonical(stored)) fail('REFINEMENT_RESUME_INVALID')
    return record
  } catch { return fail('REFINEMENT_RESUME_INVALID') }
}

/** LLM supervision only. Each stage makes at most one attempt per invocation; every successful blind pass is checkpointed before adjudication. */
export async function refineExamples(examples: Array<{ exampleId: string; input: ClassificationInput; primary: Classification }>, options: RefinementOptions): Promise<RefinementRecord[]> {
  const concurrency = options?.concurrency ?? 2
  if (!identifier(options?.model) || typeof options.apiKey !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(options.apiKey) ||
    (options.orgId !== undefined && !/^[a-zA-Z0-9_-]{1,200}$/.test(options.orgId)) ||
    !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16 ||
    (options.retryFailed !== undefined && typeof options.retryFailed !== 'boolean') ||
    [options.classifyDeliberately, options.adjudicate, options.onResult].some(value => value !== undefined && typeof value !== 'function') ||
    (options.completed !== undefined && !Array.isArray(options.completed))) fail('REFINEMENT_OPTIONS_INVALID')
  if (!Array.isArray(examples) || examples.some(row => !row || !identifier(row.exampleId))) fail('REFINEMENT_ID_INVALID')
  if (new Set(examples.map(row => row.exampleId)).size !== examples.length) fail('REFINEMENT_DUPLICATE_ID')
  const snapshots = examples.map(({ exampleId, input, primary }) => {
    try { validateClassificationInput(input); input = structuredClone(input) }
    catch { return fail('REFINEMENT_INPUT_INVALID') }
    try { validateClassification(primary, input); primary = structuredClone(primary) }
    catch { return fail('REFINEMENT_PRIMARY_INVALID') }
    return { exampleId, input, primary, inputHash: hash(input), primaryHash: hash(primary) }
  })
  const profile = refinementProfile(options.model)
  const cohortHash = hash(snapshots.map(row => [row.exampleId, row.inputHash, row.primaryHash]).sort((a, b) => a[0]! < b[0]! ? -1 : 1))
  const records: RefinementRecord[] = snapshots.map(row => ({
    version: profile.version, profileHash: profile.hash, cohortHash, exampleId: row.exampleId, inputHash: row.inputHash, primaryHash: row.primaryHash,
    model: options.model, labelSource: 'llm', bodyTruncated: row.input.bodyTruncated, originalClassification: row.primary,
    blind: null, adjudicated: null, selectedClassification: null, trainingEligible: false, stage: 'blind', status: 'unstarted', ...noError,
  }))
  const byId = new Map(records.map((row, index) => [row.exampleId, index])), seen = new Set<string>()
  for (const previous of options.completed ?? []) {
    if (!previous || !byId.has(previous.exampleId) || seen.has(previous.exampleId)) fail('REFINEMENT_RESUME_INVALID')
    seen.add(previous.exampleId)
    const index = byId.get(previous.exampleId)!
    records[index] = restore(previous, records[index]!, snapshots[index]!.input)
  }
  const { model, apiKey, orgId, signal, onResult, retryFailed } = options
  const blind = options.classifyDeliberately ?? classifyDeliberately, adjudicate = options.adjudicate ?? adjudicateEmail
  const requestOptions = { model, apiKey, orgId, signal }
  let next = 0, stopped = false, persistenceFailed = false, cooldown: number | null = null
  let stopCode = 'REFINEMENT_RATE_LIMITED'
  const publish = async (record: RefinementRecord) => {
    try { await onResult?.(structuredClone(record)) }
    catch { stopped = true; persistenceFailed = true }
  }
  const attempt = async (record: RefinementRecord, input: ClassificationInput, stage: 'blind' | 'adjudication') => {
    try {
      const candidates: [Classification, Classification] = [structuredClone(record.originalClassification), structuredClone(record.blind?.classification ?? record.originalClassification)]
      if (parseInt(digest(`superlocal-refinement-order-v1:${record.exampleId}`).slice(0, 2), 16) % 2) candidates.reverse()
      const result = checkedResult(await (stage === 'blind' ? blind(structuredClone(input), { ...requestOptions }) : adjudicate(structuredClone(input), candidates, { ...requestOptions })), input)
      Object.assign(record, noError)
      if (stage === 'blind') {
        record.blind = result
        record.stage = 'adjudication'
        record.status = 'unstarted'
      } else record.adjudicated = result
      if (record.adjudicated || !needsAdjudication(record.originalClassification, record.blind!.classification)) finish(record)
    } catch (error) {
      const safe = error instanceof InferenceError ? new InferenceError(error.code, false, error.status, error.retryAfterMs) : new InferenceError('INFERENCE_FAILURE')
      Object.assign(record, { status: 'failed', errorCode: safe.code, httpStatus: safe.status ?? null, retryAfterMs: safe.retryAfterMs ?? null })
      if (safe.status === 429) { stopped = true; cooldown = Math.max(cooldown ?? 0, safe.retryAfterMs ?? 0) }
      if ([400, 401, 402, 403, 404].includes(safe.status ?? 0) || ['INFERENCE_AUTH_MISSING', 'INFERENCE_AUTH_INVALID', 'INFERENCE_OPTIONS_INVALID', 'INFERENCE_ENDPOINT_INVALID'].includes(safe.code)) {
        stopped = true; stopCode = 'REFINEMENT_CONFIGURATION_STOPPED'
      }
    }
    await publish(record)
  }
  const worker = async () => {
    while (!stopped && !signal?.aborted && next < records.length) {
      const index = next++, record = records[index]!, input = snapshots[index]!.input
      if (record.stage === 'complete' || record.status === 'failed' && !retryFailed) continue
      const stage = record.stage
      await attempt(record, input, stage)
      if (stage === 'blind' && record.stage === 'adjudication' && record.status === 'unstarted' && !stopped && !signal?.aborted) await attempt(record, input, 'adjudication')
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, records.length) }, worker))
  if (persistenceFailed) fail('REFINEMENT_PERSISTENCE_FAILED')
  for (const record of records) if (record.status === 'unstarted') {
    Object.assign(record, { errorCode: signal?.aborted ? 'INFERENCE_ABORTED' : stopCode, httpStatus: null, retryAfterMs: cooldown })
    await publish(record)
    if (persistenceFailed) fail('REFINEMENT_PERSISTENCE_FAILED')
  }
  return records
}
