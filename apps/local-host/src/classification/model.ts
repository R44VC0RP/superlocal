import { preprocessingVersion, sourceFactKeys, taxonomy, taxonomyVersion, validateClassificationInput, type Classification, type ClassificationInput } from './schema'

type EmailType = Classification['primaryType']
type Action = Classification['actions'][number]
type LabelSources = { llm: number; human: number; unspecified: number }
export type TrainingExample = {
  input: ClassificationInput
  classification: Pick<Classification, 'primaryType' | 'actions'>
  labelSource?: 'llm' | 'human'
  exampleId?: string
  splitGroup?: string
  [key: string]: unknown
}
type Distribution = {
  samples: number
  types: Record<EmailType, number>
  actions: Record<Action, { positive: number; negative: number }>
  labelSources: LabelSources
}
type ThresholdSelection = { method: 'validation' | 'conservative_default' | 'disabled'; accepted: number | null; precision: number | null }
export type Model = {
  version: 1
  featureVersion: 1
  taxonomyVersion: string
  preprocessingVersion: string
  dimensions: number
  labels: { types: EmailType[]; actions: Action[] }
  weights: { types: number[][]; actions: number[][] }
  /** Hashes, not plaintext tokens. The entire model should still be treated as private. */
  lexicalHashes: number[]
  hyperparameters: { epochs: number; seed: number; learningRate: number; l2: number; minimumClassSamples: number; minimumKnownFraction: number }
  thresholds: { type: number; actions: Record<Action, number> }
  selection: { targetPrecision: number; minimumAccepted: number; type: ThresholdSelection; actions: Record<Action, ThresholdSelection> }
  training: Distribution
  validation: Distribution
  loss: { type: number[]; actions: number[] }
  warnings: string[]
}
export type Prediction = {
  primaryType: EmailType
  /** Winning pre-abstention softmax score, NOT the probability of the returned label. */
  typeScore: number
  actions: Action[]
  actionScores: Record<Action, number>
  /** Type abstention only; independently supported actions may still be returned. */
  abstained: boolean
}
export type LabelMetrics = {
  support: number
  trainingSupport: number
  predicted: number
  truePositive: number
  falsePositive: number
  falseNegative: number
  precision: number | null
  recall: number | null
  f1: number | null
}
export type Evaluation = {
  samples: number
  labelSources: LabelSources
  note: string
  types: { perClass: Record<EmailType, LabelMetrics>; supportedClasses: number; macroF1: number | null; accuracy: number | null; rawAccuracy: number | null; coverage: number | null; selectiveAccuracy: number | null }
  actions: { perClass: Record<Action, LabelMetrics & { negativeSupport: number; trainingNegativeSupport: number }>; supportedClasses: number; macroF1: number | null; microPrecision: number | null; microRecall: number | null; microF1: number | null; exactMatch: number | null }
  warnings: string[]
}

const types = Object.keys(taxonomy.types) as EmailType[]
const actions = Object.keys(taxonomy.actions) as Action[]
const maxExamples = 20_000, maxVocabulary = 65_536, reserved = 2 + sourceFactKeys.length
const scoreNote = 'Scores are uncalibrated model scores. Agreement with LLM labels is pseudo-label agreement, not ground-truth quality; human-label agreement also depends on review quality. Validation-selected thresholds require an untouched test set for an independent estimate.'
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = (code: string): never => { throw new Error(code) }
const mapTypes = <T>(make: (label: EmailType) => T) => Object.fromEntries(types.map(label => [label, make(label)])) as Record<EmailType, T>
const mapActions = <T>(make: (label: Action) => T) => Object.fromEntries(actions.map(label => [label, make(label)])) as Record<Action, T>
const count = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= maxExamples
const bounded = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
const average = (values: Array<number | null>) => {
  const present = values.filter((value): value is number => value !== null)
  return present.length ? present.reduce((sum, value) => sum + value, 0) / present.length : null
}

function validateExamples(examples: TrainingExample[]): void {
  if (!Array.isArray(examples) || examples.length > maxExamples) fail('CLASSIFIER_EXAMPLES_INVALID')
  for (const example of examples) {
    if (!object(example) || !object(example.classification) || !types.includes(example.classification.primaryType as EmailType) ||
      !Array.isArray(example.classification.actions) || example.classification.actions.length > actions.length ||
      !example.classification.actions.every(label => actions.includes(label as Action)) || new Set(example.classification.actions).size !== example.classification.actions.length ||
      example.labelSource !== undefined && example.labelSource !== 'llm' && example.labelSource !== 'human' ||
      example.exampleId !== undefined && (typeof example.exampleId !== 'string' || !example.exampleId.length || example.exampleId.length > 1_024) ||
      example.splitGroup !== undefined && (typeof example.splitGroup !== 'string' || !example.splitGroup.length || example.splitGroup.length > 1_024)) fail('CLASSIFIER_EXAMPLE_INVALID')
    validateClassificationInput(example.input)
  }
}

function distribution(examples: TrainingExample[]): Distribution {
  const result: Distribution = { samples: examples.length, types: mapTypes(() => 0), actions: mapActions(() => ({ positive: 0, negative: 0 })), labelSources: { llm: 0, human: 0, unspecified: 0 } }
  for (const example of examples) {
    result.types[example.classification.primaryType]++
    result.labelSources[example.labelSource ?? 'unspecified']++
    for (const label of actions) result.actions[label][example.classification.actions.includes(label) ? 'positive' : 'negative']++
  }
  return result
}

function hash(text: string): number {
  let value = 2166136261
  for (let index = 0; index < text.length; index++) value = Math.imul(value ^ text.charCodeAt(index), 16777619)
  return value >>> 0
}

function lexical(input: ClassificationInput): Array<Map<number, number>> {
  // Header identities are not features and must not alter text tokenization either.
  // This is a lexical baseline, not perfect de-identification or a semantic quotation parser.
  const normalize = (text: string) => text.normalize('NFKC').toLowerCase()
  const current = input.bodyText.replace(/\r\n?/g, '\n').split(/\n(?:on [^\n]{1,200}wrote:|[-_]{2,}\s*(?:original|forwarded) message[^\n]*|-- ?\n)/i, 1)[0]
    .split('\n').filter(line => !/^\s*>/.test(line)).join('\n')
  return [input.subject, current].map((source, field) => {
    const clean = normalize(source).replace(/(?:https?:\/\/|www\.)\S+|[\w.!#$%&'*+/=?^`{|}~-]+@[\w.-]+|\b[\w-]+(?:\.[\w-]+)+\b/gu, ' ')
    const tokens = (clean.match(/[\p{L}\p{M}]{2,40}/gu) ?? []).slice(0, field === 0 ? 160 : 1_200)
    const result = new Map<number, number>()
    const add = (key: string) => { const id = hash(key); result.set(id, (result.get(id) ?? 0) + 1) }
    let previous = ''
    for (const token of tokens) {
      add(`u:${token}`)
      if (previous) add(`b:${previous} ${token}`)
      previous = token
    }
    return result
  })
}

type Features = { indices: Uint16Array; values: Float32Array; knownFraction: number; known: number }
function features(input: ClassificationInput, dimensions: number, vocabulary: Set<number>): Features {
  const fields = lexical(input), all = new Set(fields.flatMap(field => [...field.keys()]))
  const known = [...all].filter(id => vocabulary.has(id)).length
  const values = new Map<number, number>()
  fields.forEach((field, index) => {
    let norm = 0
    for (const [id, frequency] of field) if (vocabulary.has(id)) norm += (1 + Math.log(frequency)) ** 2
    if (!norm) return
    const scale = (index === 0 ? 1.6 : 1) / Math.sqrt(norm)
    for (const [id, frequency] of field) {
      if (!vocabulary.has(id)) continue
      const bucket = reserved + id % (dimensions - reserved)
      const value = (id & 0x80000000 ? -1 : 1) * (1 + Math.log(frequency)) * scale
      values.set(bucket, (values.get(bucket) ?? 0) + value)
    }
  })
  values.set(0, 1)
  values.set(1, input.bodyTruncated ? 0.25 : 0)
  sourceFactKeys.forEach((key, index) => { if (typeof input.facts[key] === 'boolean') values.set(index + 2, input.facts[key] ? 0.25 : -0.25) })
  return { indices: Uint16Array.from(values.keys()), values: Float32Array.from(values.values()), knownFraction: all.size ? known / all.size : 0, known }
}

function dot(weights: number[], vector: Features): number {
  let result = 0
  for (let index = 0; index < vector.indices.length; index++) result += weights[vector.indices[index]] * vector.values[index]
  return result
}
const sigmoid = (value: number) => value >= 0 ? 1 / (1 + Math.exp(-value)) : Math.exp(value) / (1 + Math.exp(value))
function softmax(weights: number[][], vector: Features): number[] {
  const logits = weights.map(row => dot(row, vector)), max = Math.max(...logits)
  const exp = logits.map(value => Math.exp(value - max)), sum = exp.reduce((a, b) => a + b, 0)
  return exp.map(value => value / sum)
}
function update(weights: number[], vector: Features, change: number): void {
  for (let index = 0; index < vector.indices.length; index++) weights[vector.indices[index]] += change * vector.values[index]
}
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = Math.imul(state ^ state >>> 15, state | 1)
    value ^= value + Math.imul(value ^ value >>> 7, value | 61)
    return ((value ^ value >>> 14) >>> 0) / 4294967296
  }
}

function rawPrediction(model: Model, vector: Features) {
  const scores = softmax(model.weights.types, vector), winner = scores.indexOf(Math.max(...scores)), label = types[winner]
  const grounded = vector.known > 0 && vector.knownFraction >= model.hyperparameters.minimumKnownFraction
  const eligible = grounded && label !== 'unknown' && model.training.types[label] >= model.hyperparameters.minimumClassSamples && types.filter(type => model.training.types[type] > 0).length >= 2
  const actionScores = mapActions(action => sigmoid(dot(model.weights.actions[actions.indexOf(action)], vector)))
  return { label, typeScore: scores[winner], actionScores, grounded, eligible }
}
function prediction(model: Model, raw: ReturnType<typeof rawPrediction>): Prediction {
  const abstained = !raw.eligible || raw.typeScore < model.thresholds.type
  return {
    primaryType: abstained ? 'unknown' : raw.label,
    typeScore: raw.typeScore,
    actions: actions.filter(action => raw.grounded && model.training.actions[action].positive >= model.hyperparameters.minimumClassSamples &&
      model.training.actions[action].negative >= model.hyperparameters.minimumClassSamples && raw.actionScores[action] >= model.thresholds.actions[action]),
    actionScores: raw.actionScores,
    abstained,
  }
}

function chooseThreshold(candidates: Array<{ score: number; correct: boolean }>, fallback: number, enough: boolean, model: Model): { threshold: number; selection: ThresholdSelection } {
  if (!enough) {
    const accepted = candidates.filter(candidate => candidate.score >= fallback)
    const precision = accepted.length ? accepted.filter(candidate => candidate.correct).length / accepted.length : null
    // Scarce positives do not erase strong negative evidence against the fallback threshold.
    if (accepted.length < model.selection.minimumAccepted || precision! >= model.selection.targetPrecision) {
      return { threshold: fallback, selection: { method: 'conservative_default', accepted: accepted.length, precision } }
    }
  }
  candidates.sort((a, b) => b.score - a.score)
  let correct = 0, choice = { threshold: 1.01, selection: { method: 'disabled', accepted: 0, precision: null } as ThresholdSelection }
  for (let index = 0; index < candidates.length; index++) {
    correct += Number(candidates[index].correct)
    if (index + 1 < candidates.length && candidates[index + 1].score === candidates[index].score) continue
    const accepted = index + 1, precision = correct / accepted
    if (accepted >= model.selection.minimumAccepted && precision >= model.selection.targetPrecision) {
      choice = { threshold: candidates[index].score, selection: { method: 'validation', accepted, precision } }
    }
  }
  return choice
}

/** Fits only training examples. Validation is used only for threshold selection; no test input is accepted. */
export function trainClassifier(training: TrainingExample[], validation: TrainingExample[], opts: { epochs?: number; dimensions?: number; seed?: number } = {}): Model {
  validateExamples(training); validateExamples(validation)
  if (!training.length) fail('CLASSIFIER_TRAINING_EMPTY')
  if (!object(opts)) fail('CLASSIFIER_OPTIONS_INVALID')
  const epochs = opts.epochs ?? 24, dimensions = opts.dimensions ?? 4_096, seed = opts.seed ?? 42
  if (!Number.isInteger(epochs) || !bounded(epochs, 1, 100) || !Number.isInteger(dimensions) || !bounded(dimensions, 4_096, 8_192) || !Number.isInteger(seed) || !bounded(seed, 0, 4294967295)) fail('CLASSIFIER_OPTIONS_INVALID')
  const ids = new Set(training.flatMap(example => example.exampleId ? [example.exampleId] : []))
  const groups = new Set(training.flatMap(example => example.splitGroup ? [example.splitGroup] : []))
  if (validation.some(example => example.exampleId && ids.has(example.exampleId) || example.splitGroup && groups.has(example.splitGroup))) fail('CLASSIFIER_SPLIT_OVERLAP')
  const frequencies = new Map<number, number>()
  for (const example of training) {
    for (const id of new Set(lexical(example.input).flatMap(field => [...field.keys()]))) frequencies.set(id, (frequencies.get(id) ?? 0) + 1)
  }
  const lexicalHashes = [...frequencies].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, maxVocabulary).map(([id]) => id).sort((a, b) => a - b)
  const vocabulary = new Set(lexicalHashes)
  const defaultSelection = (): ThresholdSelection => ({ method: 'conservative_default', accepted: null, precision: null })
  const model: Model = {
    version: 1, featureVersion: 1, taxonomyVersion, preprocessingVersion, dimensions, labels: { types: [...types], actions: [...actions] },
    weights: { types: types.map(() => Array(dimensions).fill(0)), actions: actions.map(() => Array(dimensions).fill(0)) }, lexicalHashes,
    hyperparameters: { epochs, seed, learningRate: 0.25, l2: 0.0001, minimumClassSamples: 3, minimumKnownFraction: 0.2 },
    thresholds: { type: 0.8, actions: mapActions(() => 0.75) },
    selection: { targetPrecision: 0.9, minimumAccepted: 20, type: defaultSelection(), actions: mapActions(defaultSelection) },
    training: distribution(training), validation: distribution(validation), loss: { type: [], actions: [] }, warnings: ['UNCALIBRATED_SCORES', 'LEXICAL_BASELINE_NOT_SEMANTIC_GROUNDING', 'TEST_NOT_USED_FOR_SELECTION'],
  }
  if (training.some(example => !example.splitGroup) || validation.some(example => !example.splitGroup)) model.warnings.push('SPLIT_GROUPS_UNVERIFIED')
  if (frequencies.size > maxVocabulary) model.warnings.push('VOCABULARY_CAPPED')
  if (!lexicalHashes.length) model.warnings.push('NO_LEXICAL_TRAINING_SIGNAL')
  if (training.length < 100) model.warnings.push('SMALL_TRAINING_SET')
  if (model.training.labelSources.llm) model.warnings.push('TRAINED_ON_PSEUDO_LABELS')
  if (types.filter(label => model.training.types[label] > 0).length < 2) model.warnings.push('TYPE_DIVERSITY_INSUFFICIENT_ABSTAINING')
  for (const label of types) if (model.training.types[label] < model.hyperparameters.minimumClassSamples) model.warnings.push(`TYPE_LOW_SUPPORT_${label.toUpperCase()}`)
  const vectors = training.map(example => features(example.input, dimensions, vocabulary)), order = training.map((_, index) => index), next = random(seed)
  const targets = training.map(example => ({ type: types.indexOf(example.classification.primaryType), actions: actions.map(label => Number(example.classification.actions.includes(label))) }))
  const actionBalance = actions.map(label => Math.min(8, Math.sqrt((model.training.actions[label].negative + 1) / (model.training.actions[label].positive + 1))))
  actions.forEach((label, index) => {
    const support = model.training.actions[label]
    model.weights.actions[index][0] = Math.log((support.positive + 1) / (support.negative + 1))
    if (support.positive < model.hyperparameters.minimumClassSamples || support.negative < model.hyperparameters.minimumClassSamples) {
      model.thresholds.actions[label] = 1.01
      model.selection.actions[label] = { method: 'disabled', accepted: 0, precision: null }
      model.warnings.push(`ACTION_LOW_SUPPORT_${label.toUpperCase()}`)
    }
  })
  for (let epoch = 0; epoch < epochs; epoch++) {
    for (let index = order.length - 1; index > 0; index--) { const swap = Math.floor(next() * (index + 1)); [order[index], order[swap]] = [order[swap], order[index]] }
    const rate = model.hyperparameters.learningRate / Math.sqrt(1 + epoch * 0.15)
    for (const index of order) {
      const vector = vectors[index], target = targets[index], probabilities = softmax(model.weights.types, vector)
      for (let label = 0; label < types.length; label++) update(model.weights.types[label], vector, rate * (Number(label === target.type) - probabilities[label]))
      for (let label = 0; label < actions.length; label++) {
        const support = model.training.actions[actions[label]]
        if (!support.positive || !support.negative) continue
        const score = sigmoid(dot(model.weights.actions[label], vector))
        update(model.weights.actions[label], vector, rate * (target.actions[label] - score) * (target.actions[label] ? actionBalance[label] : 1))
      }
    }
    const decay = Math.exp(-rate * model.hyperparameters.l2 * training.length)
    for (const row of [...model.weights.types, ...model.weights.actions]) for (let index = 1; index < row.length; index++) row[index] *= decay
    let typeLoss = 0, actionLoss = 0
    for (let index = 0; index < vectors.length; index++) {
      typeLoss -= Math.log(Math.max(1e-15, softmax(model.weights.types, vectors[index])[targets[index].type]))
      for (let label = 0; label < actions.length; label++) {
        const score = sigmoid(dot(model.weights.actions[label], vectors[index]))
        actionLoss -= Math.log(Math.max(1e-15, targets[index].actions[label] ? score : 1 - score))
      }
    }
    model.loss.type.push(typeLoss / training.length)
    model.loss.actions.push(actionLoss / (training.length * actions.length))
  }
  const predictions = validation.map(example => rawPrediction(model, features(example.input, dimensions, vocabulary)))
  const typeSelection = chooseThreshold(predictions.flatMap((raw, index) => raw.eligible ? [{ score: raw.typeScore, correct: raw.label === validation[index].classification.primaryType }] : []), model.thresholds.type,
    validation.length >= model.selection.minimumAccepted && types.filter(label => model.validation.types[label] > 0).length >= 2, model)
  model.thresholds.type = typeSelection.threshold; model.selection.type = typeSelection.selection
  if (typeSelection.selection.method !== 'validation') model.warnings.push(`TYPE_THRESHOLD_${typeSelection.selection.method.toUpperCase()}`)
  for (const label of actions) {
    if (model.selection.actions[label].method === 'disabled') continue
    const support = model.validation.actions[label]
    const selected = chooseThreshold(predictions.flatMap((raw, index) => raw.grounded ? [{ score: raw.actionScores[label], correct: validation[index].classification.actions.includes(label) }] : []), model.thresholds.actions[label],
      support.positive >= model.selection.minimumAccepted && support.negative >= model.selection.minimumAccepted, model)
    model.thresholds.actions[label] = selected.threshold; model.selection.actions[label] = selected.selection
    if (selected.selection.method !== 'validation') model.warnings.push(`ACTION_THRESHOLD_${selected.selection.method.toUpperCase()}_${label.toUpperCase()}`)
  }
  return validateModel(model)
}

/** Validates deserialized JSON without including any contents in errors. */
export function validateModel(value: unknown): Model {
  const invalid = () => fail('CLASSIFIER_MODEL_INVALID')
  if (!object(value) || value.version !== 1 || value.featureVersion !== 1 || value.taxonomyVersion !== taxonomyVersion || value.preprocessingVersion !== preprocessingVersion ||
    !Number.isInteger(value.dimensions) || !bounded(value.dimensions, 4_096, 8_192) || !object(value.labels) ||
    !Array.isArray(value.labels.types) || !Array.isArray(value.labels.actions) || value.labels.types.length !== types.length || value.labels.actions.length !== actions.length ||
    value.labels.types.join('|') !== types.join('|') || value.labels.actions.join('|') !== actions.join('|') ||
    !object(value.weights) || !object(value.hyperparameters) || !object(value.thresholds) || !object(value.selection) || !object(value.loss)) return invalid()
  for (const [name, labels] of [['types', types], ['actions', actions]] as const) {
    const rows = value.weights[name]
    if (!Array.isArray(rows) || rows.length !== labels.length) return invalid()
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== value.dimensions) return invalid()
      for (const weight of row) if (!bounded(weight, -1e6, 1e6)) return invalid()
    }
  }
  if (!Array.isArray(value.lexicalHashes) || value.lexicalHashes.length > maxVocabulary) return invalid()
  let previous = -1
  for (const id of value.lexicalHashes) { if (!Number.isInteger(id) || !bounded(id, 0, 4294967295) || id <= previous) return invalid(); previous = id }
  const hp = value.hyperparameters
  if (!Number.isInteger(hp.epochs) || !bounded(hp.epochs, 1, 100) || !Number.isInteger(hp.seed) || !bounded(hp.seed, 0, 4294967295) ||
    hp.learningRate !== 0.25 || hp.l2 !== 0.0001 || hp.minimumClassSamples !== 3 || hp.minimumKnownFraction !== 0.2 ||
    !bounded(value.thresholds.type, 0, 1.01) || !object(value.thresholds.actions) || !actions.every(label => bounded((value.thresholds as Model['thresholds']).actions[label], 0, 1.01))) return invalid()
  for (const name of ['training', 'validation']) {
    const dist = value[name]
    if (!object(dist) || !count(dist.samples) || !object(dist.types) || !object(dist.actions) || !object(dist.labelSources)) return invalid()
    if (!types.every(label => count((dist.types as Record<string, unknown>)[label])) || types.reduce((sum, label) => sum + (dist.types as Record<string, number>)[label], 0) !== dist.samples) return invalid()
    for (const label of actions) {
      const support = dist.actions[label]
      if (!object(support) || !count(support.positive) || !count(support.negative) || support.positive + support.negative !== dist.samples) return invalid()
    }
    const sources = dist.labelSources
    if (!count(sources.llm) || !count(sources.human) || !count(sources.unspecified) || sources.llm + sources.human + sources.unspecified !== dist.samples || name === 'training' && !dist.samples) return invalid()
  }
  if (value.selection.targetPrecision !== 0.9 || value.selection.minimumAccepted !== 20 || !object(value.selection.actions)) return invalid()
  const selections = [value.selection.type, ...actions.map(label => (value.selection as Model['selection']).actions[label])]
  for (const selection of selections) {
    if (!object(selection) || !['validation', 'conservative_default', 'disabled'].includes(selection.method as string) ||
      !(selection.accepted === null || count(selection.accepted)) || !(selection.precision === null || bounded(selection.precision, 0, 1))) return invalid()
    if (selection.method === 'validation' && (!count(selection.accepted) || selection.accepted < 20 || !bounded(selection.precision, 0.9, 1))) return invalid()
  }
  for (const name of ['type', 'actions']) {
    const losses = value.loss[name]
    if (!Array.isArray(losses) || losses.length !== hp.epochs) return invalid()
    for (const loss of losses) if (!bounded(loss, 0, 100)) return invalid()
  }
  if (!Array.isArray(value.warnings) || value.warnings.length > 100) return invalid()
  for (const warning of value.warnings) if (typeof warning !== 'string' || !/^[A-Z][A-Z0-9_]{0,119}$/.test(warning)) return invalid()
  return value as Model
}

export function predictClassifier(model: Model, input: ClassificationInput): Prediction {
  validateModel(model); validateClassificationInput(input)
  return prediction(model, rawPrediction(model, features(input, model.dimensions, new Set(model.lexicalHashes))))
}

function metrics(support: number, trainingSupport: number, predicted: number, truePositive: number): LabelMetrics {
  const falsePositive = predicted - truePositive, falseNegative = support - truePositive, supported = support > 0 && trainingSupport > 0
  return { support, trainingSupport, predicted, truePositive, falsePositive, falseNegative,
    precision: supported && predicted ? truePositive / predicted : null,
    recall: supported ? truePositive / support : null,
    f1: supported ? 2 * truePositive / (2 * truePositive + falsePositive + falseNegative) : null }
}

/** Aggregate only: never returns message text, identities, evidence, or per-example results. */
export function evaluateClassifier(model: Model, examples: TrainingExample[]): Evaluation {
  validateModel(model); validateExamples(examples)
  const support = distribution(examples), vocabulary = new Set(model.lexicalHashes)
  const typeCounts = mapTypes(() => ({ predicted: 0, truePositive: 0 })), actionCounts = mapActions(() => ({ predicted: 0, truePositive: 0 }))
  let correct = 0, rawCorrect = 0, covered = 0, coveredCorrect = 0, exactActions = 0
  for (const example of examples) {
    const raw = rawPrediction(model, features(example.input, model.dimensions, vocabulary)), result = prediction(model, raw)
    const match = result.primaryType === example.classification.primaryType
    correct += Number(match); rawCorrect += Number(raw.label === example.classification.primaryType)
    covered += Number(!result.abstained); coveredCorrect += Number(!result.abstained && match)
    typeCounts[result.primaryType].predicted++
    if (match) typeCounts[result.primaryType].truePositive++
    for (const label of result.actions) { actionCounts[label].predicted++; actionCounts[label].truePositive += Number(example.classification.actions.includes(label)) }
    exactActions += Number(result.actions.length === example.classification.actions.length && result.actions.every(label => example.classification.actions.includes(label)))
  }
  const perType = mapTypes(label => metrics(support.types[label], model.training.types[label], typeCounts[label].predicted, typeCounts[label].truePositive))
  const perAction = mapActions(label => {
    const item = metrics(support.actions[label].positive, model.training.actions[label].positive, actionCounts[label].predicted, actionCounts[label].truePositive)
    if (!model.training.actions[label].negative || !support.actions[label].negative) { item.precision = null; item.recall = null; item.f1 = null }
    return { ...item, negativeSupport: support.actions[label].negative, trainingNegativeSupport: model.training.actions[label].negative }
  })
  const supportedActions = Object.values(perAction).filter(item => item.f1 !== null)
  // Unsupported per-label recall must not hide false alarms from aggregate action precision.
  const allActions = Object.values(perAction)
  const tp = allActions.reduce((sum, item) => sum + item.truePositive, 0), fp = allActions.reduce((sum, item) => sum + item.falsePositive, 0), fn = allActions.reduce((sum, item) => sum + item.falseNegative, 0)
  const warnings = [...model.warnings]
  if (examples.length < 100) warnings.push('SMALL_EVALUATION_SET')
  if (!examples.length) warnings.push('EVALUATION_EMPTY')
  if (support.labelSources.llm) warnings.push('EVALUATION_INCLUDES_PSEUDO_LABELS')
  if (support.labelSources.unspecified) warnings.push('EVALUATION_LABEL_SOURCE_UNSPECIFIED')
  for (const label of types) {
    if (!support.types[label] || !model.training.types[label]) warnings.push(`TYPE_METRICS_UNSUPPORTED_${label.toUpperCase()}`)
    else if (support.types[label] < 5) warnings.push(`TYPE_EVALUATION_LOW_SUPPORT_${label.toUpperCase()}`)
  }
  for (const label of actions) {
    if (perAction[label].f1 === null) warnings.push(`ACTION_METRICS_UNSUPPORTED_${label.toUpperCase()}`)
    else if (support.actions[label].positive < 5 || support.actions[label].negative < 5) warnings.push(`ACTION_EVALUATION_LOW_SUPPORT_${label.toUpperCase()}`)
  }
  return {
    samples: examples.length, labelSources: support.labelSources, note: scoreNote,
    types: { perClass: perType, supportedClasses: Object.values(perType).filter(item => item.f1 !== null).length, macroF1: average(Object.values(perType).map(item => item.f1)), accuracy: examples.length ? correct / examples.length : null,
      rawAccuracy: examples.length ? rawCorrect / examples.length : null, coverage: examples.length ? covered / examples.length : null, selectiveAccuracy: covered ? coveredCorrect / covered : null },
    actions: { perClass: perAction, supportedClasses: supportedActions.length, macroF1: average(Object.values(perAction).map(item => item.f1)), microPrecision: tp + fp ? tp / (tp + fp) : null,
      microRecall: tp + fn ? tp / (tp + fn) : null, microF1: 2 * tp + fp + fn ? 2 * tp / (2 * tp + fp + fn) : null, exactMatch: examples.length ? exactActions / examples.length : null },
    warnings: [...new Set(warnings)],
  }
}
