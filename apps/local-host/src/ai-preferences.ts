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

/** A decision table, not a confidence model. Numeric values retain the saved-score
 * contract: before a manual override, 20 means Important, 0 means Other, and -100 records suspected risk.
 * Reading time and correspondence volume never turn routine mail into a task.
 */
export function scoreAiTriage(
  assessment: AiAssessment,
  signals: AiScoreSignals,
  options: { personalization?: boolean; override?: AiCategory | null } = {},
): AiScore {
  let score = 0, name = 'no_obligation_gate', reason = 'No required action or matching interest';
  const decide = (value: number, signal: string, explanation: string) => {
    score = value; name = signal; reason = explanation;
  }
  if (assessment.risk === 'spam_suspected' || assessment.risk === 'phishing_suspected') {
    decide(-100, 'risk_gate', 'Suspected spam or phishing remains Other');
  } else if (assessment.certainty !== 'clear' || assessment.type === 'unknown' ||
    assessment.response === 'unknown' || assessment.task === 'unknown' || assessment.task === undefined) {
    decide(20, 'uncertainty_gate', 'Uncertain or legacy assessment stays Important for review');
  } else if (assessment.response === 'needed' || assessment.task === 'required') {
    decide(20, 'actionability_gate', 'A required reply or task remains outstanding');
  } else if (options.personalization !== false && !['promotion', 'cold_outreach'].includes(assessment.type)) {
    if (Number.isFinite(signals.interestMatches) && signals.interestMatches >= 1) {
      decide(20, 'interests', 'Matches explicit local interests');
    } else if (Number.isFinite(signals.explicitAffinity) && signals.explicitAffinity > 0) {
      decide(20, 'explicit_feedback', 'Matches explicit sender feedback');
    } else if (Number.isFinite(signals.learnedTopicAffinity) && signals.learnedTopicAffinity > 0) {
      decide(20, 'topic_affinity', 'Matches topics from explicit feedback');
    }
  }
  const category = options.override === 'Important' || options.override === 'Other'
    ? options.override : score >= 20 ? 'Important' : 'Other';
  const reasons = [reason];
  if (options.override === 'Important' || options.override === 'Other') reasons.push(`Manual category override: ${options.override}`);
  return { category, score, reasons, contributions: [{ name, value: score }], version: AI_PREFERENCE_VERSION };
}
