import { taxonomy, taxonomyVersion, type Classification } from './schema'

type EmailType = Classification['primaryType']
type Action = Classification['actions'][number]
export const policyVersion = 1
const types = Object.keys(taxonomy.types) as EmailType[], actions = Object.keys(taxonomy.actions) as Action[]
const maxRows = 50_000, maxScore = 1e6
const note = 'Calibration label agreement, not human truth. Scores are uncalibrated; threshold selection is not probability calibration. The Wilson 95% lower bound is descriptive, not a statistical guarantee after adaptive threshold search or with dependent groups. Independent evaluation is required.'

export type PolicyPrediction = Readonly<{
  /** Null, nonfinite or out-of-range scores cannot select a threshold or emit a label. */
  rawPrimaryType: EmailType; typeScore: number | null; actionScores: Readonly<Record<Action, number | null>>
  /** Raw source/training support, NOT an earlier threshold decision. Actions are independently eligible. */
  eligible: boolean; eligibleActions: readonly Action[]
}>
export type PolicyRow = Readonly<{ exampleId: string; splitGroup: string; truth: Readonly<{ primaryType: EmailType; actions: readonly Action[] }>; prediction: PolicyPrediction }>
type Criteria = Readonly<{ targetAgreement: number; minAccepted: number; minGroups: number; requireLowerBound: number }>
export type PolicyOptions = Readonly<{ modelHash: string; dataHash: string } & Partial<Criteria>>
export type PolicySelection = Readonly<{
  threshold: number | null; method: 'midpoint' | 'inclusive_score' | 'disabled'
  status: 'selected' | 'reserved_unknown' | 'no_positive_labels' | 'insufficient_support' | 'agreement_not_met'
  candidates: number; candidateGroups: number; positives: number; accepted: number; correct: number
  precision: number | null; lowerBound: number | null; groups: number
}>
export type Policy = Readonly<{
  version: typeof policyVersion; taxonomyVersion: string; modelHash: string; dataHash: string
  criteria: Criteria; samples: number; groups: number; note: typeof note
  types: Readonly<Record<EmailType, PolicySelection>>; actions: Readonly<Record<Action, PolicySelection>>
}>

function fail(code = 'CLASSIFIER_POLICY_INVALID'): never { throw new Error(code) }
const bounded = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
const count = (v: unknown): v is number => bounded(v, 0, maxRows) && Number.isInteger(v)
const score = (v: unknown): v is number => bounded(v, -maxScore, maxScore)
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 1_024 && v.trim().length > 0
const hash = (v: unknown): v is string => typeof v === 'string' && v.length === 64 && [...v].every(c => '0123456789abcdef'.includes(c))
// Exact bounded shapes reject prototypes, accessors, symbols and extra fields before reading values.
function shape(v: unknown, required: readonly string[], optional: readonly string[] = []): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return false
  const keys = Reflect.ownKeys(v)
  return keys.length <= required.length + optional.length && required.every(k => Object.hasOwn(v, k)) && keys.every(k => {
    const d = Object.getOwnPropertyDescriptor(v, k)!
    return typeof k === 'string' && (required.includes(k) || optional.includes(k)) && 'value' in d && d.enumerable
  })
}
function actionList(v: unknown): v is readonly Action[] {
  if (!Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype || v.length > actions.length || Reflect.ownKeys(v).length !== v.length + 1) return false
  const seen = new Set<Action>()
  for (let i = 0; i < v.length; i++) {
    const d = Object.getOwnPropertyDescriptor(v, String(i))
    if (!d || !('value' in d) || !d.enumerable || !actions.includes(d.value) || seen.has(d.value)) return false
    seen.add(d.value)
  }
  return true
}
function criteria(v: unknown): v is Criteria {
  return shape(v, ['targetAgreement', 'minAccepted', 'minGroups', 'requireLowerBound']) && bounded(v.targetAgreement, 0, 1) && v.targetAgreement > 0 &&
    count(v.minAccepted) && v.minAccepted > 0 && count(v.minGroups) && v.minGroups > 0 && bounded(v.requireLowerBound, 0, 1)
}
function prediction(v: unknown): asserts v is PolicyPrediction {
  if (!shape(v, ['rawPrimaryType', 'typeScore', 'actionScores', 'eligible', 'eligibleActions']) ||
    typeof v.rawPrimaryType !== 'string' || v.rawPrimaryType.length > 64 || typeof v.eligible !== 'boolean' || !actionList(v.eligibleActions) ||
    !(v.typeScore === null || typeof v.typeScore === 'number') || !shape(v.actionScores, actions) ||
    !Object.values(v.actionScores).every(s => s === null || typeof s === 'number')) fail('CLASSIFIER_POLICY_PREDICTION_INVALID')
}
const supported = (p: PolicyPrediction, action: Action) => p.eligibleActions.includes(action) && score(p.actionScores[action])
function lowerBound(correct: number, accepted: number): number {
  const p = correct / accepted, z2 = 1.959963984540054 ** 2
  return Math.max(0, (p + z2 / (2 * accepted) - Math.sqrt(z2 * (p * (1 - p) / accepted + z2 / (4 * accepted ** 2)))) / (1 + z2 / accepted))
}
type Candidate = { score: number; correct: boolean; group: string }
function select(candidates: Candidate[], rules: Criteria, reserved = false): PolicySelection {
  const positives = candidates.reduce((sum, c) => sum + Number(c.correct), 0), candidateGroups = new Set(candidates.map(c => c.group)).size
  const status = reserved ? 'reserved_unknown' : !positives ? 'no_positive_labels' : candidates.length < rules.minAccepted || candidateGroups < rules.minGroups ? 'insufficient_support' : 'agreement_not_met'
  let choice: PolicySelection = { threshold: null, method: 'disabled', status, candidates: candidates.length, candidateGroups, positives, accepted: 0, correct: 0, precision: null, lowerBound: null, groups: 0 }
  if (status !== 'agreement_not_met') return choice
  candidates.sort((a, b) => b.score - a.score)
  let correct = 0
  const groups = new Set<string>()
  for (let i = 0; i < candidates.length; i++) {
    const current = candidates[i], next = candidates[i + 1]
    correct += Number(current.correct); groups.add(current.group)
    if (next?.score === current.score) continue // Ties are indivisible, independent of input ordering.
    const accepted = i + 1, precision = correct / accepted, bound = lowerBound(correct, accepted)
    if (accepted < rules.minAccepted || groups.size < rules.minGroups || precision < rules.targetAgreement || bound < rules.requireLowerBound) continue
    const midpoint = next ? current.score / 2 + next.score / 2 : NaN // Avoid sum overflow.
    const between = Number.isFinite(midpoint) && midpoint > next!.score && midpoint < current.score
    // Adjacent floating-point scores may have no representable midpoint; >= the upper score preserves the same set.
    choice = { ...choice, threshold: between ? midpoint : current.score, method: between ? 'midpoint' : 'inclusive_score', status: 'selected', accepted, correct, precision, lowerBound: bound, groups: groups.size }
  }
  return choice // Last qualifying prefix maximizes coverage; no numeric fallback when none qualifies.
}

/** Pure selection on caller-supplied calibration labels, not training or independent evaluation. IDs/groups are not retained. */
export function calibratePolicy(rows: readonly PolicyRow[], options: PolicyOptions): Policy {
  if (!shape(options, ['modelHash', 'dataHash'], ['targetAgreement', 'minAccepted', 'minGroups', 'requireLowerBound']) || !hash(options.modelHash) || !hash(options.dataHash)) fail('CLASSIFIER_POLICY_OPTIONS_INVALID')
  const rules: Criteria = { targetAgreement: options.targetAgreement === undefined ? 0.9 : options.targetAgreement, minAccepted: options.minAccepted === undefined ? 20 : options.minAccepted,
    minGroups: options.minGroups === undefined ? 5 : options.minGroups, requireLowerBound: options.requireLowerBound === undefined ? 0 : options.requireLowerBound }
  if (!criteria(rules)) fail('CLASSIFIER_POLICY_OPTIONS_INVALID')
  if (!Array.isArray(rows) || Object.getPrototypeOf(rows) !== Array.prototype || rows.length > maxRows || Reflect.ownKeys(rows).length !== rows.length + 1) fail('CLASSIFIER_POLICY_ROWS_INVALID')
  const typeRows = Object.fromEntries(types.map(t => [t, [] as Candidate[]])) as Record<EmailType, Candidate[]>
  const actionRows = Object.fromEntries(actions.map(a => [a, [] as Candidate[]])) as Record<Action, Candidate[]>
  const ids = new Set<string>(), groups = new Set<string>()
  for (let i = 0; i < rows.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(rows, String(i))
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail('CLASSIFIER_POLICY_ROWS_INVALID')
    const row: unknown = descriptor.value
    if (!shape(row, ['exampleId', 'splitGroup', 'truth', 'prediction']) || !text(row.exampleId) || !text(row.splitGroup) ||
      !shape(row.truth, ['primaryType', 'actions']) || !types.includes(row.truth.primaryType as EmailType) || !actionList(row.truth.actions)) fail('CLASSIFIER_POLICY_ROWS_INVALID')
    if (ids.has(row.exampleId)) fail('CLASSIFIER_POLICY_DUPLICATE_ID')
    ids.add(row.exampleId); groups.add(row.splitGroup); prediction(row.prediction)
    const p = row.prediction, label = p.rawPrimaryType
    if (p.eligible && types.includes(label) && label !== 'unknown' && score(p.typeScore)) typeRows[label].push({ score: p.typeScore, correct: row.truth.primaryType === label, group: row.splitGroup })
    // Include negatives of every truth type, including unknown/unsupported types; never filter by truth support.
    for (const action of actions) if (supported(p, action)) actionRows[action].push({ score: p.actionScores[action]!, correct: row.truth.actions.includes(action), group: row.splitGroup })
  }
  return validatePolicy({ version: policyVersion, taxonomyVersion, modelHash: options.modelHash, dataHash: options.dataHash, criteria: rules, samples: rows.length, groups: groups.size, note,
    types: Object.fromEntries(types.map(t => [t, select(typeRows[t], rules, t === 'unknown')])), actions: Object.fromEntries(actions.map(a => [a, select(actionRows[a], rules)])) }, options.modelHash)
}

const validated = new WeakSet<object>()
/** Only exact, bounded JSON shapes are accepted. Deep freezing makes the validation cache mutation-safe. */
export function validatePolicy(value: unknown, modelHash: string): Policy {
  if (!hash(modelHash)) fail('CLASSIFIER_POLICY_MODEL_MISMATCH')
  if (value && typeof value === 'object' && validated.has(value)) {
    if ((value as Policy).modelHash !== modelHash) fail('CLASSIFIER_POLICY_MODEL_MISMATCH')
    return value as Policy
  }
  if (!shape(value, ['version', 'taxonomyVersion', 'modelHash', 'dataHash', 'criteria', 'samples', 'groups', 'note', 'types', 'actions']) ||
    value.version !== policyVersion || value.taxonomyVersion !== taxonomyVersion || !hash(value.modelHash) || !hash(value.dataHash) || value.note !== note ||
    !criteria(value.criteria) || !count(value.samples) || !count(value.groups) || value.groups > value.samples || Boolean(value.groups) !== Boolean(value.samples) || !shape(value.types, types) || !shape(value.actions, actions)) fail()
  if (value.modelHash !== modelHash) fail('CLASSIFIER_POLICY_MODEL_MISMATCH')
  const rules = value.criteria
  for (const [label, item] of [...Object.entries(value.types), ...Object.entries(value.actions)]) {
    if (!shape(item, ['threshold', 'method', 'status', 'candidates', 'candidateGroups', 'positives', 'accepted', 'correct', 'precision', 'lowerBound', 'groups']) ||
      !count(item.candidates) || item.candidates > value.samples || !count(item.candidateGroups) || item.candidateGroups > Math.min(item.candidates, value.groups) || Boolean(item.candidateGroups) !== Boolean(item.candidates) ||
      !count(item.positives) || item.positives > item.candidates || !count(item.accepted) || item.accepted > item.candidates ||
      !count(item.correct) || item.correct > Math.min(item.accepted, item.positives) || item.positives - item.correct > item.candidates - item.accepted ||
      !count(item.groups) || item.groups > Math.min(item.accepted, item.candidateGroups)) fail()
    if (item.threshold === null) {
      const expected = label === 'unknown' ? 'reserved_unknown' : !item.positives ? 'no_positive_labels' : item.candidates < rules.minAccepted || item.candidateGroups < rules.minGroups ? 'insufficient_support' : 'agreement_not_met'
      if (item.method !== 'disabled' || item.status !== expected || item.accepted !== 0 || item.correct !== 0 || item.groups !== 0 || item.precision !== null || item.lowerBound !== null) fail()
    } else if (label === 'unknown' || !item.positives || !score(item.threshold) || !['midpoint', 'inclusive_score'].includes(item.method as string) || item.status !== 'selected' ||
      item.accepted < rules.minAccepted || item.groups < rules.minGroups || !bounded(item.precision, rules.targetAgreement, 1) || item.precision !== item.correct / item.accepted ||
      !bounded(item.lowerBound, rules.requireLowerBound, 1) || item.lowerBound !== lowerBound(item.correct, item.accepted)) fail()
  }
  if (Object.values(value.types).reduce<number>((sum, item) => sum + (item as PolicySelection).candidates, 0) > value.samples) fail()
  for (const item of [...Object.values(value.types), ...Object.values(value.actions)]) Object.freeze(item)
  Object.freeze(value.criteria); Object.freeze(value.types); Object.freeze(value.actions); Object.freeze(value)
  validated.add(value)
  return value as Policy
}

/** Omit unsupported/vetoed heads from eligibleActions. Never infer raw support from earlier threshold decisions. */
export function applyPolicy(policy: Policy, modelHash: string, input: PolicyPrediction): { primaryType: EmailType; actions: Action[]; abstained: boolean; abstainedActions: Action[] } {
  policy = validatePolicy(policy, modelHash); prediction(input)
  const label = input.rawPrimaryType, threshold = types.includes(label) ? policy.types[label].threshold : null
  const primaryType = input.eligible && label !== 'unknown' && threshold !== null && score(input.typeScore) && input.typeScore >= threshold ? label : 'unknown'
  const abstainedActions = actions.filter(a => !supported(input, a) || policy.actions[a].threshold === null)
  return { primaryType, actions: actions.filter(a => !abstainedActions.includes(a) && input.actionScores[a]! >= policy.actions[a].threshold!), abstained: primaryType === 'unknown', abstainedActions }
}
