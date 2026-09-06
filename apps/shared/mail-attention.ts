import type { MailFacts } from '../../packages/inbox-sdk/src/contracts'

export const ATTENTION_VERSION = 'baseline-2'
export type AttentionDecision = { category: 'Important' | 'Other'; reason: string; version: string }
export function conversationAttention(mail: { split: string; attentionCategory?: AttentionDecision['category']; attentionOverride?: { override: { category: AttentionDecision['category'] } | null }; messages: Array<{ pending?: boolean; outgoing?: boolean; nativeFolder?: string; attention?: AttentionDecision; memberships?: Array<{ done: boolean; snoozedUntil: string | null }> }> }, now = Date.now()): AttentionDecision['category'] {
  const eligible = mail.messages.filter(message => !message.pending && !message.outgoing && (!message.nativeFolder || message.nativeFolder === 'inbox')
    && (!message.memberships?.length || message.memberships.some(state => !state.done && (!state.snoozedUntil || Date.parse(state.snoozedUntil) <= now))))
  if (!eligible.length) return 'Important'
  if (mail.attentionOverride?.override) return mail.attentionOverride.override.category
  if (mail.attentionCategory) return mail.attentionCategory
  if (!eligible.some(message => message.attention)) return eligible.some(message => message.nativeFolder || message.memberships) ? 'Important' : mail.split === 'Other' ? 'Other' : 'Important'
  return eligible.every(message => message.attention?.category === 'Other') ? 'Other' : 'Important'
}
/** Fixed application policy. Explicit feedback is deliberately not an input. */
export function classifyAttention(message: { subject: string; preview: string; facts?: MailFacts }): AttentionDecision {
  const facts = message.facts ?? { version: 1 }
  const text = `${message.subject}\n${message.preview}`.slice(0, 4096)
  const result = (category: AttentionDecision['category'], reason: string) => ({ category, reason, version: ATTENTION_VERSION })
  // Clear requests win over subscription headers; delivery/receipt notices do not.
  if (/\b(?:mentioned you|you were mentioned|assigned to you|review requested|requested your review|build failed|deployment failed|incident|outage|urgent|support (?:request|ticket|reply)|action required|please (?:reply|respond|review|confirm)|invoice|payment (?:due|failed)|security (?:alert|notice|code)|suspicious|password reset|verification code|one[ -]time (?:code|password)|two[ -]factor|2fa)\b/i.test(text)) return result('Important', 'actionable-notification')
  if (/\b(?:receipt|payment (?:received|confirmation)|order (?:confirmation|confirmed|shipped)|delivery (?:confirmation|confirmed)|package delivered|tracking (?:number|update)|booking (?:confirmed|confirmation)|authentication report|dmarc|weekly usage|usage summary|usage report)\b/i.test(text)) return result('Other', 'routine-notification')
  if (facts.reply || /^\s*(?:re|fw|fwd):/i.test(message.subject)) return result('Important', 'conversation')
  if (facts.listPost) return result('Important', 'discussion-list')
  if (facts.nativeCategories?.includes('promotions')) return result('Other', 'native-promotions')
  if (facts.listId && (facts.listUnsubscribe || facts.bulk)) return result('Other', 'subscription-headers')
  const campaign = /\b(?:newsletter|digest|roundup|round-up|weekly|this week|this month|sale|\d+% off|limited[ -]time|new arrivals|shop now|special offer|exclusive offer|early bird|webinar|introducing|what['’]s new|latest (?:news|updates)|subscribe|subscription preferences|email preferences|view (?:this|in) (?:email|your browser)|you(?:'re| are) receiving this)\b/i.test(text)
  if ((facts.listUnsubscribe || facts.unsubscribeLink) && campaign) return result('Other', 'subscription-and-campaign')
  return result('Important', 'uncertain')
}
