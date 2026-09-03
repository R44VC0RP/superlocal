import { preprocessingVersion, sourceFactKeys, taxonomy, taxonomyVersion, validateClassificationInput, type Classification, type ClassificationInput } from './schema'

type EmailType = Classification['primaryType']
type Action = Classification['actions'][number]
type Ranges = Array<[number, number]>
type Mapping = Array<[number, string]>
type Selection = { method: 'validation' | 'conservative_default' | 'disabled'; threshold: number; accepted: number | null; precision: number | null }
type Support = { samples: number; types: Record<EmailType, number>; actions: Record<Action, { positive: number; negative: number }>; labelSources: { llm: number; human: number; unspecified: number } }
export type LinearModel = {
  engine: 'word-tfidf-linear-svc'; version: 1; taxonomyVersion: string; preprocessingVersion: string
  /** Exact train_alternatives word-only recipe, not a configurable feature pipeline. */
  recipe: 'quoted-headers-url-email-subject2-body24000-word12-sublinear-idf-l2-booleans035-l2-v1'
  sourceBooleans: string[]
  /** Array position is the feature index. Vocabulary and all learned parameters are private. */
  vocabulary: string[]; idf: number[]
  unicode: { version: '15.0.0'; word: Ranges; space: Ranges; cased: Ranges; ignorable: Ranges; lower: Mapping; fold: Mapping }
  types: { classes: EmailType[]; coef: number[][]; intercept: number[]; selection: Selection }
  actions: Record<Action, { coef: number[] | null; intercept: number; constant: 0 | 1 | null; selection: Selection }>
  training: Support; validation: Support
  selection: { minimumAccepted: 20; targetPrecision: 0.9; minimumClassSamples: 3 }
}

const types = Object.keys(taxonomy.types) as EmailType[], actions = Object.keys(taxonomy.actions) as Action[]
const recipe = 'quoted-headers-url-email-subject2-body24000-word12-sublinear-idf-l2-booleans035-l2-v1'
const booleans = [...sourceFactKeys, 'bodyTruncated'], maxVocabulary = 80_000
function invalid(): never { throw new Error('CLASSIFIER_LINEAR_MODEL_INVALID') }
const bounded = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
const count = (v: unknown): v is number => bounded(v, 0, 50_000) && Number.isInteger(v)
const obj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const keys = (v: unknown, names: readonly string[]): v is Record<string, unknown> => obj(v) && Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k))
const numbers = (v: unknown, size: number, min = -1e6, max = 1e6): v is number[] => Array.isArray(v) && v.length === size && v.every(x => bounded(x, min, max))
type Compiled = { vocabulary: Map<string, number>; lower: Map<number, string>; fold: Map<number, string>; cased: RegExp; ignorable: RegExp; words: RegExp; headers: RegExp; urls: RegExp; emails: RegExp; emailStarts: RegExp; spaces: RegExp; space: RegExp }
const compiled = new WeakMap<LinearModel, Compiled>()

// Reject non-JSON objects/accessors and bound traversal before reading model properties.
function plain(value: unknown): void {
  let nodes = 0, characters = 0
  function visit(v: unknown, depth: number): void {
    if (++nodes > 1_500_000 || depth > 8) invalid()
    if (typeof v === 'string') { if ((characters += v.length) > 12_000_000) invalid(); return }
    if (v === null || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v)) return
    if (typeof v !== 'object' || v === null) invalid()
    const array = Array.isArray(v), proto = Object.getPrototypeOf(v), own = Reflect.ownKeys(v)
    if (array ? proto !== Array.prototype || own.length !== v.length + 1 : proto !== Object.prototype && proto !== null) invalid()
    for (const key of own) {
      if (typeof key !== 'string' || (characters += key.length) > 24_000_000) invalid()
      const descriptor = Object.getOwnPropertyDescriptor(v, key)!
      if (!('value' in descriptor) || !(array && key === 'length') && !descriptor.enumerable) invalid()
      if (array && key !== 'length' && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= v.length)) invalid()
      if (!(array && key === 'length')) visit(descriptor.value, depth + 1)
    }
  }
  visit(value, 0)
}

function rangeClass(value: unknown): string {
  if (!Array.isArray(value) || !value.length || value.length > 2_000) invalid()
  let previous = -1
  return `[${value.map(range => {
    if (!Array.isArray(range) || range.length !== 2 || !range.every(n => Number.isInteger(n) && bounded(n, 0, 0x10ffff)) || range[0] > range[1] || range[0] <= previous) invalid()
    previous = range[1]
    return `\\u{${range[0].toString(16)}}-\\u{${range[1].toString(16)}}`
  }).join('')}]`
}

function mapping(value: unknown, limit: number, maxLength: number): Map<number, string> {
  if (!Array.isArray(value) || value.length > limit) invalid()
  let previous = -1
  return new Map(value.map(pair => {
    if (!Array.isArray(pair) || pair.length !== 2 || !Number.isInteger(pair[0]) || !bounded(pair[0], 0, 0x10ffff) || pair[0] <= previous || typeof pair[1] !== 'string' || pair[1].length > maxLength) invalid()
    previous = pair[0]
    return [pair[0], pair[1]]
  }))
}

function support(value: unknown, training: boolean): asserts value is Support {
  if (!keys(value, ['samples', 'types', 'actions', 'labelSources']) || !count(value.samples) || training && !value.samples || !keys(value.types, types) || !keys(value.actions, actions) || !keys(value.labelSources, ['llm', 'human', 'unspecified'])) invalid()
  if (!Object.values(value.types).every(count) || Object.values(value.types).reduce<number>((a, b) => a + (b as number), 0) !== value.samples || !Object.values(value.labelSources).every(count) || Object.values(value.labelSources).reduce<number>((a, b) => a + (b as number), 0) !== value.samples) invalid()
  for (const label of actions) {
    const item = value.actions[label]
    if (!keys(item, ['positive', 'negative']) || !count(item.positive) || !count(item.negative) || item.positive + item.negative !== value.samples) invalid()
  }
}

function selection(value: unknown, samples: number, type: boolean): asserts value is Selection {
  if (!keys(value, ['method', 'threshold', 'accepted', 'precision']) || !['validation', 'conservative_default', 'disabled'].includes(value.method as string) || !bounded(value.threshold, type ? 0 : -1e6, 1e6) || !(value.accepted === null || count(value.accepted) && value.accepted <= samples) || !(value.precision === null || bounded(value.precision, 0, 1))) invalid()
  if (value.method === 'validation' && (!count(value.accepted) || value.accepted < 20 || !bounded(value.precision, 0.9, 1))) invalid()
  if (value.method === 'conservative_default' && (type || value.threshold !== 0)) invalid()
  if (value.method === 'disabled' && (value.accepted !== 0 || value.precision !== null)) invalid()
}

/** Validates plain JSON and deeply freezes it. Cached compilation is safe only for this immutable object.
 * Errors never include model contents. This engine is opt-in; native models are not changed.
 */
export function validateLinearModel(value: unknown): LinearModel {
  if (obj(value) && compiled.has(value as LinearModel)) return value as LinearModel
  plain(value)
  if (!keys(value, ['engine', 'version', 'taxonomyVersion', 'preprocessingVersion', 'recipe', 'sourceBooleans', 'vocabulary', 'idf', 'unicode', 'types', 'actions', 'training', 'validation', 'selection']) || value.engine !== 'word-tfidf-linear-svc' || value.version !== 1 || value.taxonomyVersion !== taxonomyVersion || value.preprocessingVersion !== preprocessingVersion || value.recipe !== recipe || !Array.isArray(value.sourceBooleans) || value.sourceBooleans.join('|') !== booleans.join('|')) invalid()
  if (!Array.isArray(value.vocabulary) || !value.vocabulary.length || value.vocabulary.length > maxVocabulary || !value.vocabulary.every(v => typeof v === 'string' && v.length > 0 && v.length <= 48_000) || new Set(value.vocabulary).size !== value.vocabulary.length || !numbers(value.idf, value.vocabulary.length, 1, 32)) invalid()
  const dimensions = value.vocabulary.length + booleans.length
  support(value.training, true); support(value.validation, false)
  if (!keys(value.selection, ['minimumAccepted', 'targetPrecision', 'minimumClassSamples']) || value.selection.minimumAccepted !== 20 || value.selection.targetPrecision !== 0.9 || value.selection.minimumClassSamples !== 3) invalid()
  const head = value.types, training = value.training
  if (!keys(head, ['classes', 'coef', 'intercept', 'selection']) || !Array.isArray(head.classes)) invalid()
  const classes = head.classes
  if (classes.length < 3 || classes.length > types.length || !classes.every(v => types.includes(v) && training.types[v as EmailType] > 0) || new Set(classes).size !== classes.length || classes.join('|') !== [...classes].sort().join('|') || !types.every(t => Boolean(training.types[t]) === classes.includes(t)) || !Array.isArray(head.coef) || head.coef.length !== classes.length || !head.coef.every(row => numbers(row, dimensions)) || !numbers(head.intercept, classes.length)) invalid()
  selection(head.selection, value.validation.samples, true)
  if (!keys(value.actions, actions)) invalid()
  for (const label of actions) {
    const action = value.actions[label], counts = value.training.actions[label]
    if (!keys(action, ['coef', 'intercept', 'constant', 'selection']) || !bounded(action.intercept, -1e6, 1e6)) invalid()
    selection(action.selection, value.validation.samples, false)
    if (action.selection.method === 'validation' && action.selection.accepted! * action.selection.precision! > value.validation.actions[label].positive + 1e-9) invalid()
    if (action.constant === null ? !numbers(action.coef, dimensions) || !counts.positive || !counts.negative : action.coef !== null || ![0, 1].includes(action.constant as number) || action.intercept !== 0 || (action.constant ? counts.negative : counts.positive) !== 0) invalid()
    if ((counts.positive < 3 || counts.negative < 3 || action.constant !== null) && action.selection.method !== 'disabled') invalid()
  }
  const unicode = value.unicode
  if (!keys(unicode, ['version', 'word', 'space', 'cased', 'ignorable', 'lower', 'fold']) || unicode.version !== '15.0.0') invalid()
  const word = rangeClass(unicode.word), space = rangeClass(unicode.space)
  const lower = mapping(unicode.lower, 2_000, 3), fold = mapping(unicode.fold, 25_000, 36)
  const state: Compiled = { vocabulary: new Map(value.vocabulary.map((v, i) => [v, i])), lower, fold,
    cased: new RegExp(rangeClass(unicode.cased), 'u'), ignorable: new RegExp(rangeClass(unicode.ignorable), 'u'), words: new RegExp(`${word}{2,}`, 'gu'),
    // Python IGNORECASE also matches long s. Anchors are handled without nested whitespace backtracking.
    headers: new RegExp(`(?:[fF][rR][oO][mM]|[tT][oO]|[cC][cC]|[bB][cC][cC]|[dD][aA][tT][eE]|[sSſ][eE][nN][tT])${space}*:[^\\n]*`, 'gu'),
    urls: new RegExp(`(?:[hH][tT][tT][pP][sSſ]?://|[wW][wW][wW]\\.)[^${space.slice(1, -1)}]+`, 'gu'),
    emails: new RegExp(`[${word.slice(1, -1)}.+%\\-]+@[${word.slice(1, -1)}.\\-]+\\.[A-Za-z]{2,}`, 'uy'), emailStarts: new RegExp(`[${word.slice(1, -1)}.+%\\-]+`, 'gu'), spaces: new RegExp(`${space}+`, 'gu'), space: new RegExp(space, 'u') }
  function freeze(v: unknown): void { if (v && typeof v === 'object') { for (const child of Object.values(v)) freeze(child); Object.freeze(v) } }
  freeze(value)
  compiled.set(value as LinearModel, state)
  return value as LinearModel
}

function removeHeaders(value: string, state: Compiled): string {
  let result = '', end = 0, match: RegExpExecArray | null
  state.headers.lastIndex = 0
  while ((match = state.headers.exec(value))) {
    let start = match.index
    while (start > end && state.space.test(value[start - 1])) start--
    if (start > end && value[start - 1] === '>') {
      start--
      while (start > end && state.space.test(value[start - 1])) start--
    }
    // Python MULTILINE recognizes only LF. Choose the earliest legal anchor in
    // the whitespace prefix, preserving Python's greedy cross-line consumption.
    const anchor = start === 0 ? 0 : value.indexOf('\n', start - 1) + 1
    if (start !== 0 && anchor === 0 || anchor > match.index) continue
    result += value.slice(end, anchor) + ' '
    end = state.headers.lastIndex
  }
  return result + value.slice(end)
}

function maskEmails(value: string, state: Compiled): string {
  if (!value.includes('@')) return value
  let result = '', end = 0, start: RegExpExecArray | null
  state.emailStarts.lastIndex = 0
  while ((start = state.emailStarts.exec(value))) {
    if (value[state.emailStarts.lastIndex] !== '@') continue
    // Try only the start of a maximal local-part run, avoiding quadratic retries.
    // Resume at the actual match end so adjacent addresses retain Python behavior.
    state.emails.lastIndex = start.index
    const match = state.emails.exec(value)
    if (!match) continue
    result += value.slice(end, start.index) + ' email '
    end = state.emails.lastIndex; state.emailStarts.lastIndex = end
  }
  return result + value.slice(end)
}

function text(input: ClassificationInput, state: Compiled): string {
  const clean = (value: string) => maskEmails(removeHeaders(value, state).replace(state.urls, ' url '), state).replace(state.spaces, ' ').replace(/^ +| +$/g, '')
  const subject = clean(input.subject), chars = [...`${subject} ${subject} ${clean([...input.bodyText].slice(0, 24_000).join(''))}`]
  // Python str.lower (including contextual final sigma), then NFKD with nonzero
  // combining classes removed. Artifact tables avoid host ICU/Unicode-version drift.
  let result = ''
  for (let i = 0; i < chars.length; i++) {
    let lowered = state.lower.get(chars[i].codePointAt(0)!) ?? chars[i]
    if (chars[i] === 'Σ') {
      let before = i - 1, after = i + 1
      while (before >= 0 && state.ignorable.test(chars[before])) before--
      while (after < chars.length && state.ignorable.test(chars[after])) after++
      if (before >= 0 && state.cased.test(chars[before]) && (after === chars.length || !state.cased.test(chars[after]))) lowered = 'ς'
    }
    for (const char of lowered) result += state.fold.get(char.codePointAt(0)!) ?? char
  }
  return result
}

function features(model: LinearModel, input: ClassificationInput, state: Compiled): { entries: Array<[number, number]>; grounded: boolean } {
  const tokens = text(input, state).match(state.words) ?? [], counts = new Map<number, number>()
  const add = (term: string) => { const id = state.vocabulary.get(term); if (id !== undefined) counts.set(id, (counts.get(id) ?? 0) + 1) }
  for (const token of tokens) add(token)
  for (let i = 1; i < tokens.length; i++) add(`${tokens[i - 1]} ${tokens[i]}`)
  const entries = [...counts].sort((a, b) => a[0] - b[0]).map(([id, frequency]): [number, number] => [id, (1 + Math.log(frequency)) * model.idf[id]])
  const wordNorm = Math.sqrt(entries.reduce((sum, [, value]) => sum + value * value, 0))
  if (wordNorm) for (const entry of entries) entry[1] /= wordNorm
  booleans.forEach((key, i) => { if ((key === 'bodyTruncated' ? input.bodyTruncated : input.facts[key]) === true) entries.push([model.vocabulary.length + i, 0.35]) })
  const norm = Math.sqrt(entries.reduce((sum, [, value]) => sum + value * value, 0))
  if (norm) for (const entry of entries) entry[1] /= norm
  return { entries, grounded: counts.size > 0 }
}

/** Uncalibrated SVM scores, not probabilities. No identity features or email side effects. */
export function predictLinearClassifier(model: LinearModel, input: ClassificationInput): { primaryType: EmailType; rawPrimaryType: EmailType; typeScore: number; actions: Action[]; actionScores: Record<string, number>; abstained: boolean } {
  model = validateLinearModel(model); validateClassificationInput(input)
  const vector = features(model, input, compiled.get(model)!)
  const dot = (row: number[], intercept: number) => vector.entries.reduce((sum, [id, value]) => sum + row[id] * value, 0) + intercept
  const scores = model.types.coef.map((row, i) => dot(row, model.types.intercept[i]))
  const ranked = scores.map((score, i) => ({ score, i })).sort((a, b) => b.score - a.score || a.i - b.i)
  const rawPrimaryType = model.types.classes[ranked[0].i], typeScore = ranked[0].score - ranked[1].score
  const abstained = !vector.grounded || rawPrimaryType === 'unknown' || model.training.types[rawPrimaryType] < 3 || model.types.selection.method === 'disabled' || typeScore < model.types.selection.threshold
  const actionScores: Record<string, number> = {}, selected: Action[] = []
  for (const label of actions) {
    const head = model.actions[label]
    const score = head.constant === null ? dot(head.coef!, head.intercept) : head.constant ? 1e9 : -1e9
    actionScores[label] = score
    if (vector.grounded && head.selection.method !== 'disabled' && score >= head.selection.threshold) selected.push(label)
  }
  return { primaryType: abstained ? 'unknown' : rawPrimaryType, rawPrimaryType, typeScore, actions: selected, actionScores, abstained }
}
