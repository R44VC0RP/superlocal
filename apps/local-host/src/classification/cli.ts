import { createHash } from 'node:crypto'
import { closeSync, lstatSync, openSync, readFileSync, writeSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { classifyEmail, InferenceError } from './inference'
import { createDataset, inventory, openMailSource, privateDirectory } from './store'
import type { TrainingExample } from './model'
import { preprocessingVersion, taxonomyVersion, validateClassification, validateClassificationInput } from './schema'

function readExamples(path: string): TrainingExample[] {
  const rows = readFileSync(path, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line))
  for (const row of rows) validateClassification(row.classification, row.input)
  return rows
}

function savePrivate(path: string, value: unknown) {
  const fd = openSync(path, 'wx', 0o600)
  try { writeSync(fd, JSON.stringify(value) + '\n') } finally { closeSync(fd) }
}

export async function trainExport(inputDirectory: string, outputDirectory: string) {
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
  const candidates = validation.length >= 20 ? [{ dimensions: 4096, epochs: 24 }, { dimensions: 8192, epochs: 24 }, { dimensions: 8192, epochs: 48 }] : [{ dimensions: 4096, epochs: 24 }]
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
  for (const row of test.slice(0, 100)) { const start = performance.now(); predictClassifier(model, row.input); timings.push(performance.now() - start) }
  timings.sort((a, b) => a - b)
  const metrics = { trainingSamples: training.length, validationSamples: validation.length, testSamples: test.length,
    validation: selected.evaluation, test: evaluateClassifier(model, test), trainingMs,
    selection: { selected: selected.options, criterion: 'Validation type macro-F1, then action micro-F1, then raw type accuracy. These are selection metrics, not independent estimates.', candidates: fitted.map(value => ({ ...value.options, typeMacroF1: value.evaluation.types.macroF1, actionMicroF1: value.evaluation.actions.microF1, typeCoverage: value.evaluation.types.coverage })) },
    predictionTiming: { samples: timings.length, medianMs: timings.length ? timings[Math.floor(timings.length / 2)] : null, p95Ms: timings.length ? timings[Math.min(timings.length - 1, Math.ceil(timings.length * 0.95) - 1)] : null },
    interpretation: 'Metrics against unreviewed LLM labels measure teacher agreement, not human-verified accuracy. No claim of generalization beyond this held-out mailbox sample.',
  }
  const root = privateDirectory(outputDirectory)
  savePrivate(resolve(root, 'model.json'), { version: 1, model, dataset: { run: manifest.run, manifestHash: createHash('sha256').update(manifestText).digest('hex'), taxonomyVersion } })
  savePrivate(resolve(root, 'metrics.json'), metrics)
  return metrics
}

type Dataset = ReturnType<typeof createDataset>
export async function labelRun(dataset: Dataset, options: {
  run: string; apiKey: string; orgId?: string; concurrency: number; signal?: AbortSignal;
  classify?: typeof classifyEmail; progress?: (completed: number) => void;
}) {
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 16) throw new Error('INVALID_CONCURRENCY')
  const config = dataset.assertCurrent(options.run), classify = options.classify ?? classifyEmail
  let completed = 0, stopped: string | null = null
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
        const configurationFailure = error instanceof InferenceError && [400, 401, 403, 404].includes(error.status ?? 0)
        const releaseAttempt = !!(interrupted || configurationFailure)
        const retry = releaseAttempt || error instanceof InferenceError && error.retryable && job.attempts < 3
        dataset.fail(options.run, job, interrupted ? 'INTERRUPTED' : code, retry, releaseAttempt)
        if (configurationFailure) stopped = code
        if (retry && !interrupted && !stopped) await Bun.sleep(Math.min(10_000, 1000 * 2 ** job.attempts))
      }
    }
  }))
  return { ...dataset.status(options.run), stopped: options.signal?.aborted ? 'INTERRUPTED' : stopped }
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
export    --dataset /absolute/path/labels.sqlite --run pilot-v1 --out /private/new-export [--reviewed-only]
train     --input /private/export-directory --out /private/new-model-directory
evaluate  --model-file /private/model/model.json --input /private/export/test.jsonl
predict   --model-file /private/model/model.json --input /private/examples.jsonl --out /private/new-predictions

prepare defaults to a separate classification/labels.sqlite beside the source database.
Pass --dataset to override. Every run is an immutable selection and configuration.
label resumes unfinished work; a changed taxonomy/prompt requires a new run ID.
fork reuses the exact frozen inputs to compare another model or revised taxonomy/prompt.
--retry-failed explicitly retries exhausted failures, preserving previous attempt history.
The explicitly read --key-file defaults to non-gittract.env in the project root (0600).
Set OPENCODE_API_KEY in that file; optional OPENCODE_ORG_ID supports session tokens.
Only label uploads email content, to the fixed OpenCode Responses endpoint with store:false.
review input: one {"exampleId":"...","classification":{...}} record per line; corrections append.
Exports contain private mail: 0600 files outside this checkout; existing exports are not overwritten.
Unreviewed ambiguous/truncated results go to review.jsonl, not training files.
All labels are generic. Provider categories and personal importance are not training inputs.
train fits a local message-type/action baseline; validation selects a small fixed feature/epoch grid and abstention thresholds. Test stays held out until selection finishes.
It does not train time sensitivity or risk prediction yet. LLM-label scores are teacher agreement.
predict runs locally without a key; each input line is a ClassificationInput or {input,exampleId}.
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
    source: { type: 'string' }, dataset: { type: 'string' }, run: { type: 'string' }, from: { type: 'string' }, model: { type: 'string', default: 'gpt-5.6-sol' },
    limit: { type: 'string', default: '200' }, seed: { type: 'string', default: 'pilot-v1' }, concurrency: { type: 'string', default: '4' },
    'key-file': { type: 'string' }, 'model-file': { type: 'string' }, 'allow-email-upload': { type: 'boolean' }, out: { type: 'string' }, input: { type: 'string' },
    left: { type: 'string' }, right: { type: 'string' }, 'reviewed-only': { type: 'boolean' }, 'retry-failed': { type: 'boolean' }, help: { type: 'boolean' },
  } })
  if (values.help || !positionals.length) { console.log(help); return }
  const command = positionals[0]
  if (positionals.length !== 1 || !['inventory', 'prepare', 'label', 'status', 'fork', 'compare', 'review', 'export', 'train', 'evaluate', 'predict'].includes(command!)) throw new Error('UNKNOWN_COMMAND_USE_HELP')
  const required = (name: 'source' | 'run' | 'dataset' | 'out' | 'input' | 'left' | 'right' | 'from' | 'model-file'): string => {
    const value = values[name]
    if (!value?.trim()) throw new Error(`MISSING_${name.toUpperCase()}`)
    return value
  }
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2))
  if (command === 'train') { print(await trainExport(required('input'), required('out'))); return }
  if (command === 'evaluate' || command === 'predict') {
    const savedText = readFileSync(required('model-file'), 'utf8'), saved = JSON.parse(savedText)
    if (saved.version !== 1 || saved.dataset?.taxonomyVersion !== taxonomyVersion) throw new Error('MODEL_VERSION_MISMATCH')
    const { evaluateClassifier, predictClassifier } = await import('./model')
    if (command === 'evaluate') print(evaluateClassifier(saved.model, readExamples(required('input'))))
    else {
      const rows = readFileSync(required('input'), 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line))
      const predictions = rows.map((row, index) => {
        const input = row.input ?? row
        validateClassificationInput(input)
        return { exampleId: typeof row.exampleId === 'string' ? row.exampleId : String(index), inputHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'), ...predictClassifier(saved.model, input) }
      })
      const root = privateDirectory(required('out'))
      const fd = openSync(resolve(root, 'predictions.jsonl'), 'wx', 0o600)
      try { for (const prediction of predictions) writeSync(fd, JSON.stringify(prediction) + '\n') } finally { closeSync(fd) }
      savePrivate(resolve(root, 'manifest.json'), { version: 1, modelHash: createHash('sha256').update(savedText).digest('hex'), count: predictions.length, localOnly: true, scores: 'Uncalibrated model scores, not probabilities.' })
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
      try { print(dataset.prepare(source, { run: required('run'), model: values.model, seed: values.seed, limit })) } finally { source.close() }
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
    else if (command === 'fork') print(dataset.fork(required('from'), required('run'), values.model))
    else if (command === 'compare') print(dataset.compare(required('left'), required('right')))
    else if (command === 'review') {
      const records = readFileSync(required('input'), 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line))
      print(dataset.review(required('run'), records))
    } else if (command === 'export') print(dataset.export(required('run'), required('out'), !!values['reviewed-only']))
  } finally { dataset.close() }
}

if (import.meta.main) main().catch(error => {
  const code = error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : 'CLASSIFICATION_COMMAND_FAILED'
  console.error(`${code}. Use --help to check arguments. No email content or credentials were logged.`)
  process.exitCode = 1
})
