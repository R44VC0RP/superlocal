import type { ClassificationInput } from './schema'

/** Availability veto only: never changes the fitted feature vector or invents evidence from headers/markers. */
export function hasCurrentText(input: Pick<ClassificationInput, 'subject' | 'bodyText'>, bodyLimit = 60_000): boolean {
  const meaningful = (value: string, body: boolean) => {
    let header = false
    for (const source of value.split(/\r\n?|\n/u)) {
      const normalized = source.normalize('NFKC'), line = normalized.trim()
      if (!line) { header = false; continue }
      if (body && (/^(?:from|to|cc|bcc|date|sent|subject|reply-to|message-id)\s*:/i.test(line) || header && /^\s/u.test(normalized))) { header = true; continue }
      header = false
      if (body && (line === '--' || /^(?:On .{0,300}\bwrote:|[- _]{2,}(?:original|forwarded) message\b|Begin forwarded message:)/i.test(line))) break
      if (body && line.startsWith('>')) continue
      for (const token of line.split(/\s+/u)) {
        const unwrapped = token.replace(/^[<(\[{'"“‘]+/u, '')
        // Bounded token scans, not a backtracking address regex on a long near-match.
        if (unwrapped.includes('@') || /^(?:https?:\/\/|www\.)/iu.test(unwrapped)) continue
        const word = unwrapped.replace(/[<>\[\]{}()'"“”‘’.,;:!?]/gu, '')
        if (!/^(?:email|url|link|date)$/i.test(word) && /\p{L}/u.test(word)) return true
      }
    }
    return false
  }
  const subject = input.subject.normalize('NFKC').trim().replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/i, '')
  return meaningful(subject, false) || meaningful(bodyLimit < 60_000 ? [...input.bodyText].slice(0, bodyLimit).join('') : input.bodyText, true)
}
