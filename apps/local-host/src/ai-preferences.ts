import {
  AI_PREFERENCE_VERSION,
  type AiAssessment, type AiCategory, type AiScore, type AiScoreSignals,
} from '../../shared/ai-triage'

/** Local matching only. Never turn interests or feedback into model instructions. */
export function normalizeAiTopic(value: unknown): string {
  if (typeof value !== 'string' || value.length > 256) return ''
  const topic = value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  return topic.length <= 64 && topic.split(' ').length <= 8 ? topic : ''
}

export function normalizeAiTopics(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  return [...new Set(values.slice(0, 64).map(normalizeAiTopic).filter(Boolean))]
}

/** Whole topic/phrase matches, never substring matches such as "ai" in "retail". */
export function countAiTopicMatches(topics: unknown, interests: unknown): number {
  const wanted = normalizeAiTopics(interests)
  return Math.min(8, normalizeAiTopics(topics).filter(topic => wanted.some(interest =>
    ` ${topic} `.includes(` ${interest} `) || ` ${interest} `.includes(` ${topic} `),
  )).length)
}

function bounded(value: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : 0
}

/**
 * Versioned, additive local weights, with explicit safety and manual-override gates.
 * Affinities are signed [-1, 1]. correspondenceDays counts distinct confirmed
 * correspondence days, not inbound volume. readingSeconds is active reading only.
 * W/Done, queue state, and native mailbox placement are deliberately not signals.
 */
export function scoreAiTriage(
  assessment: AiAssessment,
  signals: AiScoreSignals,
  options: { personalization?: boolean; override?: AiCategory | null } = {},
): AiScore {
  const contributions: AiScore['contributions'] = []
  const reasons: string[] = []
  const add = (name: string, value: number, reason: string) => {
    if (!value) return
    contributions.push({ name, value })
    reasons.push(reason)
  }
  const typeWeight: Record<AiAssessment['type'], number> = {
    conversation: 15, request: 32, notification: 0, invoice: 5, receipt: -25,
    newsletter: -15, promotion: -40, cold_outreach: -45, invitation: 15, other: -5, unknown: 0,
  }
  add('message_type', typeWeight[assessment.type] ?? 0, `Message type: ${assessment.type}`)
  const responseWeight = { needed: 45, optional: 8, not_needed: -8, waiting: -10, unknown: 0 }
  add('response', responseWeight[assessment.response] ?? 0, `Response: ${assessment.response}`)
  const urgencyWeight = { immediate: 45, deadline: 30, routine: 0, none: -5, unknown: 0 }
  add('urgency', urgencyWeight[assessment.urgency] ?? 0, `Urgency: ${assessment.urgency}`)
  // Only retained legacy assessments use message type as a proxy for personal work.
  // Optional reviews, other people's tasks and waiting threads do not inherit it.
  const personalAction = assessment.response === 'needed' || assessment.task === 'required' ||
    assessment.task === undefined && ['request', 'conversation', 'invoice', 'invitation'].includes(assessment.type)
  if (personalAction) add('requested_actions', Math.min(3, new Set(assessment.actions).size) * 8, 'Specific action requested')

  if (options.personalization !== false) {
    add('correspondence_days', Math.floor(bounded(signals.correspondenceDays, 0, 14)) * 2, 'Established correspondence on distinct days')
    add('active_reading', Math.floor(bounded(signals.readingSeconds, 0, 240) / 60), 'Small active-reading affinity')
    add('explicit_feedback', Math.round(bounded(signals.explicitAffinity, -1, 1) * 80), 'Explicit sender feedback')
    const interests = Math.min(3, Math.floor(bounded(signals.interestMatches, 0, 8)))
    add('interests', interests > 0 ? 45 + interests * 5 : 0, 'Matches explicit local interests')
    add('topic_affinity', Math.round(bounded(signals.learnedTopicAffinity, -1, 1) * 50), 'Learned local topic affinity')
  }

  let score = contributions.reduce((sum, item) => sum + item.value, 0)
  const risky = assessment.risk === 'spam_suspected' || assessment.risk === 'phishing_suspected'
  if (risky) {
    add('risk_gate', -100 - score, 'Suspected spam or phishing remains Other; risk is not urgency')
    score = -100
  } else if (assessment.certainty !== 'clear' || assessment.type === 'unknown' || assessment.response === 'unknown' || assessment.task === 'unknown') {
    if (score < 20) add('uncertainty_gate', 20 - score, 'Uncertain assessment stays Important for review')
    else reasons.push('Uncertain assessment stays Important for review')
    score = Math.max(20, score)
  } else if (assessment.task === 'required' || !['promotion', 'newsletter', 'cold_outreach'].includes(assessment.type) &&
    (assessment.response === 'needed' || assessment.urgency === 'immediate' || assessment.urgency === 'deadline' ||
      assessment.task === undefined && personalAction && assessment.actions.some(action => action !== 'other'))) {
    // Disinterest learned from an earlier message cannot bury a genuine new task.
    // Only a manual choice for this captured conversation can override this floor.
    if (score < 20) add('actionability_gate', 20 - score, 'Requested action remains Important independently of personal interest')
    score = Math.max(20, score)
  }
  const category = options.override === 'Important' || options.override === 'Other'
    ? options.override : score >= 20 ? 'Important' : 'Other'
  if (options.override === 'Important' || options.override === 'Other') reasons.push(`Manual category override: ${options.override}`)
  if (!reasons.length) reasons.push('No strong importance signal')
  // Never mutate the assessment: a manual override or an interest cannot clear risk.
  return { category, score, reasons, contributions, version: AI_PREFERENCE_VERSION }
}
