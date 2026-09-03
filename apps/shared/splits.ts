export type SplitPreferences = {
  version: 1
  splits: string[]
  inactiveSplits: string[]
  splitRules: Record<string, string>
  splitAliases: Record<string, string>
}
export const splitTemplates: Record<string, string> = {
  Github: 'from:notifications@github.com',
  Inbound: '(from:feedback@inbound.new OR from:support@inbound.new)',
  Calendar: '(subject:"invitation:" OR subject:"accepted:" OR subject:"declined:")',
  Newsletters: '(subject:newsletter OR subject:digest)',
  Receipts: '(subject:receipt OR subject:invoice)',
}
export function attentionSplit(preferences: Pick<SplitPreferences, 'splitAliases' | 'splitRules'>, name: string): 'Important' | 'Other' | undefined {
  if (typeof preferences.splitRules[name] === 'string' && preferences.splitRules[name].trim()) return undefined
  const original = typeof preferences.splitAliases[name] === 'string' && preferences.splitAliases[name] || name
  return original === 'Important' || original === 'Other' ? original : undefined
}
/** Remove only the complete, unchanged old seed signature. Names alone are never evidence of ownership. */
export function normalizeSplits(input: Record<string, unknown>): SplitPreferences {
  const strings = (value: unknown) => Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === 'string' && !!v.trim()))] : []
  const rules = (value: unknown): Record<string, string> => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {}
  let splits = strings(input.splits), inactiveSplits = strings(input.inactiveSplits)
  const splitRules = rules(input.splitRules), splitAliases = rules(input.splitAliases)
  const seeded = ['Important', 'Github', 'Inbound', 'Calendar', 'Other']
  if (input.version !== 1 && splits.filter(name => seeded.includes(name)).join('\0') === seeded.join('\0') && !inactiveSplits.some(name => seeded.includes(name))) {
    splits = splits.filter(name => !['Github', 'Inbound', 'Calendar'].includes(name) || Object.hasOwn(splitRules, name) || Object.hasOwn(splitAliases, name))
  }
  for (const name of [...splits, ...inactiveSplits]) {
    const original = typeof splitAliases[name] === 'string' && splitAliases[name] || name
    if (!Object.hasOwn(splitRules, name) && Object.hasOwn(splitTemplates, original)) splitRules[name] = splitTemplates[original]
  }
  const value: SplitPreferences = { version: 1, splits, inactiveSplits, splitRules, splitAliases }
  for (const category of ['Important', 'Other'] as const) {
    const existing = [...splits, ...inactiveSplits].find(name => attentionSplit(value, name) === category)
    if (existing) {
      if (!splits.includes(existing)) { splits.push(existing); inactiveSplits = inactiveSplits.filter(name => name !== existing) }
    } else {
      let name: string = category
      while ([...splits, ...inactiveSplits].includes(name)) name += ' inbox'
      splits.push(name); splitAliases[name] = category
    }
  }
  return { ...value, splits, inactiveSplits: inactiveSplits.filter(name => !splits.includes(name)) }
}
