import { createHash } from 'node:crypto'
import { classifyEmail, InferenceError, type InferenceResult } from './inference'
import { taxonomy, validateClassification, validateClassificationInput, type Classification, type ClassificationInput } from './schema'

export type AuditRecord = {
  exampleId: string
  inputHash: string
  model: string
  status: 'succeeded' | 'failed' | 'unstarted'
  classification: Classification | null
  errorCode: string | null
  usage: InferenceResult['usage'] | null
  httpStatus: number | null
  retryAfterMs: number | null
}
export type AuditOptions = {
  model: string; apiKey: string; orgId?: string; concurrency?: number; signal?: AbortSignal
  classify?: typeof classifyEmail
  onResult?: (record: AuditRecord) => void | Promise<void>
}
export type PrimaryAuditRecord = { exampleId: string; inputHash: string; classification: Classification }
const fail = (code: string): never => { throw new Error(code) }
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(value)
const ratio = (numerator: number, denominator: number) => denominator ? numerator / denominator : null
function uniqueIds(records: Array<{ exampleId: string }>): void {
  if (!Array.isArray(records) || records.some(row => !row || !identifier(row.exampleId))) fail('AUDIT_ID_INVALID')
  if (new Set(records.map(row => row.exampleId)).size !== records.length) fail('AUDIT_DUPLICATE_ID')
}

/** Order-sensitive hash of the exact validated source JSON, never of labels or predictions. */
export function auditInputHash(input: ClassificationInput): string {
  validateClassificationInput(input)
  return createHash('sha256').update(JSON.stringify(input)).digest('hex')
}

/** One attempt per source; no retries or waiting workers after a rate limit. Persistence belongs to the caller. */
export async function auditExamples(examples: Array<{ exampleId: string; input: ClassificationInput }>, options: AuditOptions): Promise<AuditRecord[]> {
  uniqueIds(examples)
  const concurrency = options?.concurrency ?? 2
  if (!identifier(options?.model) || typeof options.apiKey !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(options.apiKey) ||
    (options.orgId !== undefined && !/^[a-zA-Z0-9_-]{1,200}$/.test(options.orgId)) ||
    !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) fail('AUDIT_OPTIONS_INVALID')
  // Snapshot every source before any request; additional input fields (including labels) are rejected.
  const inputs = examples.map(({ input }) => { validateClassificationInput(input); return JSON.parse(JSON.stringify(input)) as ClassificationInput })
  const records: AuditRecord[] = examples.map((example, index) => ({
    exampleId: example.exampleId, inputHash: auditInputHash(inputs[index]!), model: options.model, status: 'unstarted',
    classification: null, errorCode: null, usage: null, httpStatus: null, retryAfterMs: null,
  }))
  let next = 0, stopped = false, persistenceFailed = false, cooldown: number | null = null
  let stopCode = 'AUDIT_RATE_LIMITED'
  const publish = async (record: AuditRecord) => {
    try { await options.onResult?.(structuredClone(record)) }
    catch { stopped = true; persistenceFailed = true }
  }
  const worker = async () => {
    while (!stopped && !options.signal?.aborted && next < records.length) {
      const index = next++, record = records[index]!, input = inputs[index]!
      try {
        const result = await (options.classify ?? classifyEmail)(input, {
          model: options.model, apiKey: options.apiKey, orgId: options.orgId, signal: options.signal,
        })
        const classification = validateClassification(result.classification, input)
        if (!identifier(result.model) || !result.usage || ![result.usage.inputTokens, result.usage.outputTokens].every(value => Number.isSafeInteger(value) && value >= 0)) fail('AUDIT_RESULT_INVALID')
        Object.assign(record, { status: 'succeeded', classification, model: result.model, usage: result.usage })
      } catch (error) {
        const safe = error instanceof InferenceError ? new InferenceError(error.code, false, error.status, error.retryAfterMs) : new InferenceError('INFERENCE_FAILURE')
        Object.assign(record, { status: 'failed', errorCode: safe.code, httpStatus: safe.status ?? null, retryAfterMs: safe.retryAfterMs ?? null })
        if (safe.status === 429) { stopped = true; cooldown = Math.max(cooldown ?? 0, safe.retryAfterMs ?? 0) }
        if ([400, 401, 403, 404].includes(safe.status ?? 0)) { stopped = true; stopCode = 'AUDIT_CONFIGURATION_STOPPED' }
      }
      await publish(record)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, records.length) }, worker))
  if (persistenceFailed) fail('AUDIT_PERSISTENCE_FAILED')
  for (const record of records) if (record.status === 'unstarted') {
    record.errorCode = options.signal?.aborted ? 'INFERENCE_ABORTED' : stopCode
    record.retryAfterMs = cooldown
    await publish(record)
    if (persistenceFailed) fail('AUDIT_PERSISTENCE_FAILED')
  }
  return records
}

/** LLM-to-LLM agreement only. Changed-source pairs are rejected from comparison, not treated as agreements. */
export function compareAudits(primary: PrimaryAuditRecord[], audit: AuditRecord[]) {
  uniqueIds(primary); uniqueIds(audit)
  const validLabels = (value: Classification | null) => value && Object.hasOwn(taxonomy.types, value.primaryType) && Array.isArray(value.actions) &&
    value.actions.every(action => Object.hasOwn(taxonomy.actions, action)) && new Set(value.actions).size === value.actions.length
  for (const row of [...primary, ...audit]) if (!/^[a-f0-9]{64}$/.test(row.inputHash)) fail('AUDIT_HASH_INVALID')
  if (primary.some(row => !validLabels(row.classification)) || audit.some(row =>
    !['succeeded', 'failed', 'unstarted'].includes(row.status) || (row.status === 'succeeded'
      ? !validLabels(row.classification) || row.errorCode !== null
      : row.classification !== null || typeof row.errorCode !== 'string'))) fail('AUDIT_RECORD_INVALID')
  const byId = new Map(audit.map(row => [row.exampleId, row])), primaryIds = new Set(primary.map(row => row.exampleId))
  const perType = Object.fromEntries(Object.keys(taxonomy.types).map(type => [type, { primaryTotal: 0, primaryCompared: 0, auditorCompared: 0, agreed: 0 }])) as
    Record<Classification['primaryType'], { primaryTotal: number; primaryCompared: number; auditorCompared: number; agreed: number }>
  const result = {
    annotators: { primary: 'llm', auditor: 'llm' },
    note: 'LLM-to-LLM agreement is not human ground-truth accuracy. Rates use successful matching-source pairs; coverage includes every primary record.',
    total: primary.length, compared: 0, success: 0, failure: 0, unstarted: 0, missing: 0, inputHashMismatch: 0,
    unexpected: audit.filter(row => !primaryIds.has(row.exampleId)).length,
    coverage: null as number | null, primaryTypeAgreement: null as number | null, exactActionsAgreement: null as number | null,
    actionMicroPrecisionAgreement: null as number | null, actionMicroRecallAgreement: null as number | null,
    actionCounts: { shared: 0, primary: 0, auditor: 0 }, perType, disagreementIds: [] as string[],
  }
  let typeMatches = 0, actionMatches = 0
  for (const row of primary) {
    perType[row.classification.primaryType].primaryTotal++
    const other = byId.get(row.exampleId)
    if (!other) { result.missing++; continue }
    if (other.inputHash !== row.inputHash) { result.inputHashMismatch++; continue }
    if (other.status !== 'succeeded') { result[other.status === 'unstarted' ? 'unstarted' : 'failure']++; continue }
    const left = row.classification, right = other.classification!
    result.success++; result.compared++
    perType[left.primaryType].primaryCompared++; perType[right.primaryType].auditorCompared++
    const sameType = left.primaryType === right.primaryType
    const shared = left.actions.filter(action => right.actions.includes(action)).length
    const sameActions = shared === left.actions.length && shared === right.actions.length
    if (sameType) { typeMatches++; perType[left.primaryType].agreed++ }
    if (sameActions) actionMatches++
    if (!sameType || !sameActions) result.disagreementIds.push(row.exampleId)
    result.actionCounts.shared += shared; result.actionCounts.primary += left.actions.length; result.actionCounts.auditor += right.actions.length
  }
  result.coverage = ratio(result.compared, result.total)
  result.primaryTypeAgreement = ratio(typeMatches, result.compared)
  result.exactActionsAgreement = ratio(actionMatches, result.compared)
  result.actionMicroPrecisionAgreement = ratio(result.actionCounts.shared, result.actionCounts.primary)
  result.actionMicroRecallAgreement = ratio(result.actionCounts.shared, result.actionCounts.auditor)
  return result
}
