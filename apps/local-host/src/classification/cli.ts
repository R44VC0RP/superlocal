import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, writeSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { classifyEmail, InferenceError } from './inference'
import { createDataset, inventory, openMailSource, privateDirectory } from './store'
import type { TrainingExample } from './model'
import { preprocessingVersion, promptVersion, taxonomyVersion, validateClassification, validateClassificationInput, type ClassificationInput } from './schema'

function readExamples(path: string): TrainingExample[] {
  return parseExamples(readFileSync(path, 'utf8'))
}

function parseExamples(text: string): TrainingExample[] {
  const rows = text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line))
  for (const row of rows) validateClassification(row.classification, row.input)
  return rows
}

function savePrivate(path: string, value: unknown) {
  const fd = openSync(path, 'wx', 0o600)
  try { writeSync(fd, JSON.stringify(value) + '\n') } finally { closeSync(fd) }
}

/** OS-released SQLite lock: a crash cannot leave a stale PID/lock-file claim. No mail is stored here. */
function refinementWriter(root: string): Database {
  const path = resolve(root, 'writer.sqlite'), fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid()) throw new Error('REFINEMENT_PRIVATE_WRITER_REQUIRED')
  } finally { closeSync(fd) }
  const writer = new Database(path)
  try { writer.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); return writer }
  catch (error) { writer.close(); throw new Error((error as { code?: string }).code === 'SQLITE_BUSY' ? 'REFINEMENT_WRITER_ACTIVE' : 'REFINEMENT_WRITER_FAILED') }
}

/** Append-only AI supervision; never imports records into the human review ledger. */
export async function refineFile(inputPath: string, outputDirectory: string, options: Omit<import('./refinement').RefinementOptions, 'completed' | 'onResult'> & { resume?: boolean; progress?: (count: number) => void }) {
  const { refinementProfile, refineExamples } = await import('./refinement')
  if (lstatSync(inputPath).size > 128 * 1024 * 1024) throw new Error('REFINEMENT_INPUT_TOO_LARGE')
  const inputText = readFileSync(inputPath, 'utf8'), inputHash = createHash('sha256').update(inputText).digest('hex')
  const examples = inputText.split('\n').filter(line => line.trim()).map(line => { const row = JSON.parse(line); return { exampleId: row.exampleId, input: row.input, primary: row.primary ?? row.classification } })
  if (!examples.length || examples.length > 5000 || new Set(examples.map(row => row.exampleId)).size !== examples.length) throw new Error('REFINEMENT_COHORT_INVALID')
  for (const row of examples) { if (typeof row.exampleId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(row.exampleId)) throw new Error('REFINEMENT_COHORT_INVALID'); validateClassification(row.primary, row.input) }
  const profile = refinementProfile(options.model), root = privateDirectory(outputDirectory), history = resolve(root, 'records.jsonl'), manifestPath = resolve(root, 'manifest.json')
  const writer = refinementWriter(root)
  try {
    const latest = new Map<string, import('./refinement').RefinementRecord>()
    if (options.resume) {
      for (const path of [manifestPath, history]) { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid()) throw new Error('REFINEMENT_PRIVATE_RESUME_REQUIRED') }
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (manifest.version !== 1 || manifest.inputHash !== inputHash || JSON.stringify(manifest.profile) !== JSON.stringify(profile) || manifest.examples !== examples.length) throw new Error('REFINEMENT_RESUME_MISMATCH')
      const previous = readFileSync(history, 'utf8')
      if (previous && !previous.endsWith('\n')) throw new Error('REFINEMENT_CHECKPOINT_INCOMPLETE')
      for (const line of previous.split('\n').filter(Boolean)) {
        const row = JSON.parse(line)
        if (latest.get(row.exampleId)?.status === 'succeeded') throw new Error('REFINEMENT_CHECKPOINT_CONFLICT')
        latest.set(row.exampleId, row)
      }
    } else {
      if (existsSync(history) || existsSync(manifestPath)) throw new Error('REFINEMENT_EXISTS_USE_RESUME')
      savePrivate(manifestPath, { version: 1, inputHash, examples: examples.length, profile, createdAt: new Date().toISOString(), labelSource: 'llm', interpretation: 'AI review and adjudication, not human labels or independent ground truth.' })
    }
    const fd = openSync(history, options.resume ? 'a' : 'wx', 0o600)
    try {
      let checkpoints = 0
      const records = await refineExamples(examples, { ...options, completed: [...latest.values()], onResult: record => {
        writeSync(fd, JSON.stringify(record) + '\n'); fsyncSync(fd); options.progress?.(++checkpoints)
      } })
      return { examples: records.length, succeeded: records.filter(row => row.status === 'succeeded').length, failed: records.filter(row => row.status === 'failed').length,
        unstarted: records.filter(row => row.status === 'unstarted').length, trainingEligible: records.filter(row => row.trainingEligible).length,
        adjudicated: records.filter(row => row.adjudicated).length, labelSource: 'llm', recordsPath: history }
    } finally { closeSync(fd) }
  } finally { writer.close() }
}

export async function trainExport(inputDirectory: string, outputDirectory: string, options: { deferTest?: boolean } = {}) {
  const { trainClassifier, evaluateClassifier, predictClassifier } = await import('./model')
  const manifestText = readFileSync(resolve(inputDirectory, 'manifest.json'), 'utf8'), manifest = JSON.parse(manifestText)
  if (manifest.version !== 1 || manifest.config?.taxonomyVersion !== taxonomyVersion || manifest.config?.preprocessingVersion !== preprocessingVersion) throw new Error('DATASET_VERSION_MISMATCH')
  const training = readExamples(resolve(inputDirectory, 'train.jsonl')), validation = readExamples(resolve(inputDirectory, 'validation.jsonl')), test = readExamples(resolve(inputDirectory, 'test.jsonl'))
  const seen = new Map<string, string>()
  for (const [split, examples] of [['train', training], ['validation', validation], ['test', test]] as const) {
    for (const example of examples) {
      if (!example.exampleId || !example.splitGroup) throw new Error('DATASET_SPLIT_IDENTITY_REQUIRED')
      for (const key of [`example:${example.exampleId}`, `group:${example.splitGroup}`]) {
        if (seen.has(key) && seen.get(key) !== split) throw new Error('DATASET_SPLIT_LEAKAGE')
        seen.set(key, split)
      }
    }
  }
  if (!training.length) throw new Error('EMPTY_TRAINING_SPLIT')
  const started = performance.now()
  const candidates = validation.length >= 20 ? [
    { dimensions: 4096, epochs: 24, groupBalance: false },
    { dimensions: 4096, epochs: 24, groupBalance: true },
    { dimensions: 8192, epochs: 24, groupBalance: true },
    { dimensions: 16384, epochs: 24, groupBalance: true },
  ] : [{ dimensions: 4096, epochs: 24, groupBalance: false }]
  const fitted = candidates.map(options => {
    const model = trainClassifier(training, validation, options)
    return { model, options, evaluation: evaluateClassifier(model, validation) }
  })
  const ranked = [...fitted].sort((a, b) => (b.evaluation.types.macroF1 ?? -1) - (a.evaluation.types.macroF1 ?? -1)
    || (b.evaluation.actions.microF1 ?? -1) - (a.evaluation.actions.microF1 ?? -1)
    || (b.evaluation.types.rawAccuracy ?? -1) - (a.evaluation.types.rawAccuracy ?? -1))
  const selected = ranked[0]!, model = selected.model
  const trainingMs = performance.now() - started
  const timings: number[] = []
  for (const row of (options.deferTest ? validation : test).slice(0, 100)) { const start = performance.now(); predictClassifier(model, row.input); timings.push(performance.now() - start) }
  timings.sort((a, b) => a - b)
  const metrics = { trainingSamples: training.length, validationSamples: validation.length, testSamples: test.length,
    validation: selected.evaluation, test: options.deferTest ? null : evaluateClassifier(model, test), testEvaluated: !options.deferTest, trainingMs,
    selection: { selected: selected.options, criterion: 'Validation type macro-F1, then action micro-F1, then raw type accuracy. These are selection metrics, not independent estimates.', candidates: fitted.map(value => ({ ...value.options, typeMacroF1: value.evaluation.types.macroF1, actionMicroF1: value.evaluation.actions.microF1, typeCoverage: value.evaluation.types.coverage })) },
    predictionTiming: { samples: timings.length, medianMs: timings.length ? timings[Math.floor(timings.length / 2)] : null, p95Ms: timings.length ? timings[Math.min(timings.length - 1, Math.ceil(timings.length * 0.95) - 1)] : null },
    interpretation: 'Metrics against unreviewed LLM labels measure teacher agreement, not human-verified accuracy. No claim of generalization beyond this held-out mailbox sample.',
  }
  const root = privateDirectory(outputDirectory)
  savePrivate(resolve(root, 'model.json'), { version: 1, model, trainingImplementationHash: createHash('sha256').update(readFileSync(resolve(import.meta.dir, 'model.ts'))).digest('hex'), dataset: { run: manifest.run, manifestHash: createHash('sha256').update(manifestText).digest('hex'), taxonomyVersion } })
  savePrivate(resolve(root, 'metrics.json'), metrics)
  return metrics
}

type Dataset = ReturnType<typeof createDataset>
export async function labelRun(dataset: Dataset, options: {
  run: string; apiKey: string; orgId?: string; concurrency: number; signal?: AbortSignal;
  classify?: typeof classifyEmail; progress?: (completed: number) => void;
}) {
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 64) throw new Error('INVALID_CONCURRENCY')
  const config = dataset.assertCurrent(options.run), classify = options.classify ?? classifyEmail
  let completed = 0, stopped: string | null = null, stoppedStatus: number | null = null, retryAfterMs = 0
  await Promise.all(Array.from({ length: options.concurrency }, async () => {
    while (!options.signal?.aborted && !stopped) {
      const job = dataset.claim(options.run)
      if (!job) return
      try {
        const result = await classify(job.input, { apiKey: options.apiKey, model: config.model, endpoint: config.endpoint, orgId: options.orgId, signal: options.signal })
        dataset.finish(options.run, job, result)
        completed++; options.progress?.(completed)
      } catch (error) {
        const code = error instanceof InferenceError ? error.code : 'LABEL_FAILED'
        const interrupted = options.signal?.aborted
        const rateLimited = error instanceof InferenceError && error.status === 429
        const configurationFailure = error instanceof InferenceError && [400, 401, 402, 403, 404, 429].includes(error.status ?? 0)
        const releaseAttempt = !!(interrupted || configurationFailure)
        const retry = releaseAttempt || error instanceof InferenceError && error.retryable && job.attempts < 3
        dataset.fail(options.run, job, interrupted ? 'INTERRUPTED' : code, retry, releaseAttempt)
        if (configurationFailure) { stopped = rateLimited ? 'RATE_LIMITED' : code; stoppedStatus = error.status ?? null }
        if (rateLimited) retryAfterMs = Math.max(retryAfterMs, error.retryAfterMs ?? 30_000)
        if (retry && !interrupted && !stopped) await Bun.sleep(Math.min(10_000, 1000 * 2 ** job.attempts))
      }
    }
  }))
  return { ...dataset.status(options.run), stopped: options.signal?.aborted ? 'INTERRUPTED' : stopped as string | null, stoppedStatus: stoppedStatus as number | null, retryAfterMs }
}

const help = `Offline email classification (does not change the inbox)

bun --no-env-file run classify <command> [options]

inventory --source /absolute/path/inbox.sqlite
prepare   --source /absolute/path/inbox.sqlite --run pilot-v1 [--limit 200|all] [--seed pilot-v1] [--model gpt-5.6-sol]
label     --dataset /absolute/path/labels.sqlite --run pilot-v1 --allow-email-upload [--concurrency 4] [--retry-failed]
status    --dataset /absolute/path/labels.sqlite --run pilot-v1
fork      --dataset /absolute/path/labels.sqlite --from pilot-v1 --run pilot-v2 [--model gpt-5.6-terra]
compare   --dataset /absolute/path/labels.sqlite --left pilot-v1 --right pilot-v2
review    --dataset /absolute/path/labels.sqlite --run pilot-v1 --input /private/reviews.jsonl
export    --dataset /absolute/path/labels.sqlite --run pilot-v1 --out /private/new-export [--reviewed-only] [--development-run previous-pilot]
train     --input /private/export-directory --out /private/new-model-directory [--defer-test]
evaluate  --model-file /private/model/model.json --input /private/export/test.jsonl [--policy-file /private/policy/policy.json]
predict   --model-file /private/model/model.json --input /private/examples.jsonl --out /private/new-predictions [--policy-file /private/policy/policy.json]
calibrate --model-file /private/model/model.json --input /private/calibration.jsonl --out /private/new-policy [--target-agreement .95] [--minimum-accepted 20] [--minimum-groups 5] [--lower-bound 0]
audit     --input /private/blind-inputs.jsonl --out /private/new-audit --allow-email-upload [--model gpt-5.6-terra] [--concurrency 4]
refine    --input /private/examples.jsonl --out /private/refinement --allow-email-upload [--model gpt-5.6-sol] [--concurrency 4] [--resume] [--retry-failed]

prepare defaults to a separate classification/labels.sqlite beside the source database.
Pass --dataset to override. Every run is an immutable selection and configuration.
label resumes unfinished work; a changed taxonomy/prompt requires a new run ID.
fork reuses the exact frozen inputs to compare another model or revised taxonomy/prompt.
--retry-failed explicitly retries exhausted failures, preserving previous attempt history.
Concurrency is bounded to 1–64. A 429 stops new claims and releases throttled attempts for resume; retryAfterMs reports the provider cooldown.
The explicitly read --key-file defaults to non-gittract.env in the project root (0600).
Set OPENCODE_API_KEY in that file; optional OPENCODE_ORG_ID supports session tokens.
Only label/audit/refine upload email content, to the fixed OpenCode Responses endpoint with store:false.
review is human-only: one {"exampleId":"...","classification":{...},"labelSource":"human"} attestation per line; corrections append. AI corrections belong in refine, not the human ledger.
Exports contain private mail: 0600 files outside this checkout; existing exports are not overwritten.
Unreviewed ambiguous/truncated results go to review.jsonl, not training files.
--development-run is repeatable; previously explored sender components cannot enter validation/test.
All labels are generic. Provider categories and personal importance are not training inputs.
train fits a local message-type/action baseline; validation selects a small fixed feature/epoch grid and abstention thresholds. Test stays held out until selection finishes.
--defer-test leaves final evaluation untouched while comparing learner families using validation only.
It does not train time sensitivity or risk prediction yet. LLM-label scores are teacher agreement.
predict runs locally without a key; each input line is a ClassificationInput or {input,exampleId}.
predict/evaluate also accept opt-in plain-JSON word-TFIDF/SVM artifacts; inference needs no Python.
predict reports abstainedActions separately: disabled/unsupported heads are not confident negative action labels.
calibrate selects each type/action threshold separately from labeled calibration data, never the release test. Policies bind to exact model bytes and report group support and descriptive Wilson bounds; they are not accuracy guarantees. No qualifying threshold means abstention, not a default cutoff.
audit sends only {exampleId,input} sources, never existing labels or predictions, to an independent LLM. It persists every success/failure/unstarted record; this is not human ground truth.
refine accepts up to 5000 {exampleId,input,classification} records. A blind source-only pass precedes anonymous adjudication where needed. Every stage is private and append-only; --resume requires identical inputs/model/profile, and --retry-failed retries only the failed stage. Refinements remain LLM labels, never human reviews.
`

function credentials(path: string) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid()) throw new Error('KEY_FILE_MUST_BE_PRIVATE_0600')
  const content = readFileSync(path, 'utf8')
  const apiKey = content.match(/^OPENCODE_API_KEY=([^\r\n]+)$/m)?.[1]?.trim()
  const orgId = content.match(/^OPENCODE_ORG_ID=([^\r\n]+)$/m)?.[1]?.trim()
  if (!apiKey || /\s/.test(apiKey)) throw new Error('OPENCODE_API_KEY_REQUIRED')
  return { apiKey, orgId }
}

async function main() {
  process.umask(0o077)
  const { values, positionals } = parseArgs({ args: Bun.argv.slice(2), allowPositionals: true, strict: true, options: {
    source: { type: 'string' }, dataset: { type: 'string' }, run: { type: 'string' }, from: { type: 'string' }, model: { type: 'string' },
    limit: { type: 'string', default: '200' }, seed: { type: 'string', default: 'pilot-v1' }, concurrency: { type: 'string', default: '4' },
    'key-file': { type: 'string' }, 'model-file': { type: 'string' }, 'allow-email-upload': { type: 'boolean' }, out: { type: 'string' }, input: { type: 'string' },
    left: { type: 'string' }, right: { type: 'string' }, 'reviewed-only': { type: 'boolean' }, 'retry-failed': { type: 'boolean' }, help: { type: 'boolean' },
    'development-run': { type: 'string', multiple: true },
    'defer-test': { type: 'boolean' },
    resume: { type: 'boolean' },
    'policy-file': { type: 'string' }, 'target-agreement': { type: 'string', default: '0.95' }, 'minimum-accepted': { type: 'string', default: '20' }, 'minimum-groups': { type: 'string', default: '5' }, 'lower-bound': { type: 'string', default: '0' },
  } })
  if (values.help || !positionals.length) { console.log(help); return }
  const command = positionals[0]
  if (positionals.length !== 1 || !['inventory', 'prepare', 'label', 'status', 'fork', 'compare', 'review', 'export', 'train', 'evaluate', 'predict', 'audit', 'refine', 'calibrate'].includes(command!)) throw new Error('UNKNOWN_COMMAND_USE_HELP')
  const required = (name: 'source' | 'run' | 'dataset' | 'out' | 'input' | 'left' | 'right' | 'from' | 'model-file'): string => {
    const value = values[name]
    if (!value?.trim()) throw new Error(`MISSING_${name.toUpperCase()}`)
    return value
  }
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2))
  if (command === 'refine') {
    if (!values['allow-email-upload']) throw new Error('EXPLICIT_ALLOW_EMAIL_UPLOAD_REQUIRED')
    const controller = new AbortController(), stop = () => controller.abort()
    process.once('SIGINT', stop); process.once('SIGTERM', stop)
    try {
      const result = await refineFile(required('input'), required('out'), { model: values.model ?? 'gpt-5.6-sol', ...credentials(values['key-file'] ?? resolve(import.meta.dir, '../../../../non-gittract.env')),
        concurrency: Number(values.concurrency), signal: controller.signal, resume: values.resume, retryFailed: values['retry-failed'], progress: count => { if (count % 100 === 0) print({ persistedCheckpoints: count }) } })
      print(result)
      if (result.failed || result.unstarted) process.exitCode = 1
    } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop) }
    return
  }
  if (command === 'audit') {
    if (!values['allow-email-upload']) throw new Error('EXPLICIT_ALLOW_EMAIL_UPLOAD_REQUIRED')
    const { auditExamples, auditInputHash } = await import('./audit')
    const examples = readFileSync(required('input'), 'utf8').split('\n').filter(line => line.trim()).map(line => { const row = JSON.parse(line); return { exampleId: row.exampleId, input: row.input } })
    const cohortHash = createHash('sha256').update(JSON.stringify(examples.map(row => [row.exampleId, auditInputHash(row.input)]))).digest('hex')
    const model = values.model ?? 'gpt-5.6-terra', key = credentials(values['key-file'] ?? resolve(import.meta.dir, '../../../../non-gittract.env'))
    const root = privateDirectory(required('out')), fd = openSync(resolve(root, 'audit.jsonl'), 'wx', 0o600)
    const controller = new AbortController(), stop = () => controller.abort()
    process.once('SIGINT', stop); process.once('SIGTERM', stop)
    try {
      let finished = 0
      const records = await auditExamples(examples, { model, ...key, concurrency: Number(values.concurrency), signal: controller.signal, onResult: record => {
        writeSync(fd, JSON.stringify(record) + '\n'); finished++
        if (finished % 25 === 0) print({ persistedAuditRecords: finished })
      } })
      const counts = { succeeded: records.filter(row => row.status === 'succeeded').length, failed: records.filter(row => row.status === 'failed').length, unstarted: records.filter(row => row.status === 'unstarted').length }
      savePrivate(resolve(root, 'manifest.json'), { version: 1, cohortHash, cohortSize: examples.length, taxonomyVersion, promptVersion, model, counts, createdAt: new Date().toISOString(), interpretation: 'Blind LLM audit, not human-reviewed ground truth.' })
      print({ model, cohortSize: examples.length, ...counts })
      if (counts.failed || counts.unstarted) process.exitCode = 1
    } finally { closeSync(fd); process.off('SIGINT', stop); process.off('SIGTERM', stop) }
    return
  }
  if (command === 'train') { print(await trainExport(required('input'), required('out'), { deferTest: values['defer-test'] })); return }
  if (command === 'evaluate' || command === 'predict' || command === 'calibrate') {
    const savedText = readFileSync(required('model-file'), 'utf8'), saved = JSON.parse(savedText)
    const { evaluateClassifier, evaluatePredictions, predictClassifier } = await import('./model')
    const { validateLinearModel, predictLinearClassifier } = await import('./linear')
    const payload = saved.model ?? saved
    const linear = payload.engine === 'word-tfidf-linear-svc' ? validateLinearModel(payload) : null
    if (!linear && (saved.version !== 1 || saved.dataset?.taxonomyVersion !== taxonomyVersion)) throw new Error('MODEL_VERSION_MISMATCH')
    const { applyPolicy, calibratePolicy, validatePolicy } = await import('./policy')
    const modelHash = createHash('sha256').update(savedText).digest('hex'), policyText = values['policy-file'] !== undefined ? readFileSync(values['policy-file'], 'utf8') : null
    let policy: import('./policy').Policy | null = null
    if (policyText !== null) {
      let parsed: unknown
      try { parsed = JSON.parse(policyText) } catch { throw new Error('CLASSIFIER_POLICY_INVALID') }
      policy = validatePolicy(parsed, modelHash)
    }
    const rawPredict = (input: ClassificationInput) => linear ? predictLinearClassifier(linear, input) : predictClassifier(saved.model, input)
    const rawInput = (p: ReturnType<typeof rawPredict>) => ({ rawPrimaryType: p.rawPrimaryType, typeScore: p.typeScore, actionScores: p.actionScores, eligible: p.eligible, eligibleActions: p.eligibleActions })
    const predict = (input: ClassificationInput) => { const result = rawPredict(input); return policy ? { ...result, ...applyPolicy(policy, modelHash, rawInput(result)) } : result }
    const metadata = linear ? { training: linear.training, warnings: ['UNCALIBRATED_SCORES', 'LINEAR_SVC_BASELINE', 'TEST_NOT_USED_FOR_SELECTION'] } : saved.model
    if (command === 'calibrate') {
      if (policy) throw new Error('CALIBRATION_REQUIRES_RAW_MODEL_NOT_POLICY')
      const inputBytes = readFileSync(required('input')), rows = parseExamples(inputBytes.toString('utf8'))
      const selected = calibratePolicy(rows.map(row => ({ exampleId: row.exampleId!, splitGroup: row.splitGroup!, truth: { primaryType: row.classification.primaryType, actions: row.classification.actions }, prediction: rawInput(rawPredict(row.input)) })),
        { modelHash, dataHash: createHash('sha256').update(inputBytes).digest('hex'), targetAgreement: Number(values['target-agreement']), minAccepted: Number(values['minimum-accepted']), minGroups: Number(values['minimum-groups']), requireLowerBound: Number(values['lower-bound']) })
      const directory = privateDirectory(required('out'))
      savePrivate(resolve(directory, 'policy.json'), selected)
      print({ samples: selected.samples, groups: selected.groups, criteria: selected.criteria, types: selected.types, actions: selected.actions, note: selected.note })
      return
    }
    if (command === 'evaluate') {
      const rows = readExamples(required('input'))
      print(linear || policy ? evaluatePredictions(metadata, rows, rows.map(row => predict(row.input))) : evaluateClassifier(saved.model, rows))
    }
    else {
      const rows = readFileSync(required('input'), 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line))
      const predictions = rows.map((row, index) => {
        const input = row.input ?? row
        validateClassificationInput(input)
        return { exampleId: typeof row.exampleId === 'string' ? row.exampleId : String(index), inputHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'), ...predict(input) }
      })
      const root = privateDirectory(required('out'))
      const fd = openSync(resolve(root, 'predictions.jsonl'), 'wx', 0o600)
      try { for (const prediction of predictions) writeSync(fd, JSON.stringify(prediction) + '\n') } finally { closeSync(fd) }
      savePrivate(resolve(root, 'manifest.json'), { version: 1, modelHash, policyHash: policyText !== null ? createHash('sha256').update(policyText).digest('hex') : null, count: predictions.length, localOnly: true, scores: 'Uncalibrated model scores, not probabilities.' })
      print({ predicted: predictions.length, abstained: predictions.filter(row => row.abstained).length, localOnly: true })
    }
    return
  }
  if (command === 'inventory') {
    const source = openMailSource(resolve(required('source')))
    try { print(inventory(source)) } finally { source.close() }
    return
  }
  const sourcePath = values.source ? resolve(values.source) : null
  const path = values.dataset ? resolve(values.dataset) : command === 'prepare' && sourcePath ? resolve(dirname(sourcePath), 'classification/labels.sqlite') : resolve(required('dataset'))
  if (sourcePath && resolve(path) === sourcePath) throw new Error('DATASET_MUST_NOT_BE_SOURCE')
  const dataset = createDataset(path)
  try {
    if (command === 'prepare') {
      const limit = values.limit === 'all' ? 'all' : Number(values.limit)
      if (limit !== 'all' && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error('INVALID_LIMIT')
      const source = openMailSource(resolve(required('source')))
      try { print(dataset.prepare(source, { run: required('run'), model: values.model ?? 'gpt-5.6-sol', seed: values.seed, limit })) } finally { source.close() }
    } else if (command === 'label') {
      if (!values['allow-email-upload']) throw new Error('EXPLICIT_ALLOW_EMAIL_UPLOAD_REQUIRED')
      if (values['retry-failed']) dataset.retryFailed(required('run'))
      const keyFile = values['key-file'] ?? resolve(import.meta.dir, '../../../../non-gittract.env')
      const controller = new AbortController(), stop = () => controller.abort()
      process.once('SIGINT', stop); process.once('SIGTERM', stop)
      try {
        const result = await labelRun(dataset, { run: required('run'), ...credentials(keyFile), concurrency: Number(values.concurrency), signal: controller.signal,
          progress: count => { if (count % 10 === 0) console.log(JSON.stringify({ completedThisInvocation: count })) },
        })
        print(result)
        if (result.stopped || result.counts.failed || result.counts.pending || result.counts.processing) process.exitCode = 1
      } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop) }
    } else if (command === 'status') print(dataset.status(required('run')))
    else if (command === 'fork') print(dataset.fork(required('from'), required('run'), values.model ?? 'gpt-5.6-sol'))
    else if (command === 'compare') print(dataset.compare(required('left'), required('right')))
    else if (command === 'review') {
      const records = readFileSync(required('input'), 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line))
      print(dataset.review(required('run'), records))
    } else if (command === 'export') print(dataset.export(required('run'), required('out'), !!values['reviewed-only'], values['development-run'] ?? []))
  } finally { dataset.close() }
}

if (import.meta.main) main().catch(error => {
  const code = error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : 'CLASSIFICATION_COMMAND_FAILED'
  console.error(`${code}. Use --help to check arguments. No email content or credentials were logged.`)
  process.exitCode = 1
})
