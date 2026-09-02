import type { Attachment, MailFolder, Participant } from '../src/types'
import { auth, initAuth } from './auth'
import { sqlite, initDatabase } from './db'

type DemoAccount = {
  id: string
  userId: string
  name: string
  email: string
  color: string
  signature: string
}

type SeedMessage = {
  direction: 'inbound' | 'outbound'
  from?: Participant
  text: string
  html?: string
  attachments?: Attachment[]
  cc?: Participant[]
  folder?: MailFolder
  read?: boolean
}

type SeedThread = {
  account: 'openmail' | 'studio' | 'personal' | 'jordan'
  subject: string
  folder: MailFolder
  daysAgo: number
  messages: SeedMessage[]
  labels?: string[]
  starred?: boolean
  unread?: boolean
  snoozeHours?: number
  scheduleHours?: number
}

const people = {
  priya: { name: 'Priya Shah', email: 'priya@openmail.dev' },
  marcus: { name: 'Marcus Chen', email: 'marcus@openmail.dev' },
  elena: { name: 'Elena Rodriguez', email: 'elena@openmail.dev' },
  devon: { name: 'Devon Brooks', email: 'devon@openmail.dev' },
  naomi: { name: 'Naomi Park', email: 'naomi@openmail.dev' },
  sam: { name: 'Sam Okafor', email: 'sam@openmail.dev' },
  tess: { name: 'Tess Laurent', email: 'tess@studioform.co' },
  oliver: { name: 'Oliver Reed', email: 'oliver@studioform.co' },
  maya: { name: 'Maya Thompson', email: 'maya@northline.com' },
  ben: { name: 'Ben Carter', email: 'ben@fieldwork.studio' },
  claire: { name: 'Claire Morgan', email: 'claire.morgan@gmail.com' },
  theo: { name: 'Theo Williams', email: 'theo.williams@gmail.com' },
  jordan: { name: 'Jordan Lee', email: 'jordan@example.com' },
} satisfies Record<string, Participant>

const attachment = {
  brief: {
    id: 'attachment-project-brief',
    filename: 'OpenMail-Project-Brief.pdf',
    contentType: 'application/pdf',
    size: 922,
    url: '/fixtures/project-brief.pdf',
  },
  invoice: {
    id: 'attachment-invoice-1847',
    filename: 'Studioform-Invoice-1847.pdf',
    contentType: 'application/pdf',
    size: 816,
    url: '/fixtures/invoice-1847.pdf',
  },
  roadmap: {
    id: 'attachment-roadmap-notes',
    filename: 'Q3-Roadmap-Workshop.txt',
    contentType: 'text/plain',
    size: 1_340,
    url: '/fixtures/roadmap-notes.txt',
  },
  metrics: {
    id: 'attachment-activation-metrics',
    filename: 'activation-cohorts-q3.csv',
    contentType: 'text/csv',
    size: 601,
    url: '/fixtures/metrics-q3.csv',
  },
  editorial: {
    id: 'attachment-editorial-cover',
    filename: 'design-review-cover.svg',
    contentType: 'image/svg+xml',
    size: 2_244,
    url: '/fixtures/design-review-cover.svg',
    inline: true,
    contentId: 'design-review-cover',
  },
  materials: {
    id: 'attachment-material-study',
    filename: 'material-notes.svg',
    contentType: 'image/svg+xml',
    size: 1_966,
    url: '/fixtures/material-notes.svg',
    inline: true,
    contentId: 'material-notes',
  },
} satisfies Record<string, Attachment>

function inbound(from: Participant, text: string, options: Omit<SeedMessage, 'direction' | 'from' | 'text'> = {}): SeedMessage {
  return { direction: 'inbound', from, text, ...options }
}

function outbound(text: string, options: Omit<SeedMessage, 'direction' | 'text'> = {}): SeedMessage {
  return { direction: 'outbound', text, ...options }
}

const designNewsletterHtml = `
<article style="max-width:620px;margin:0 auto;font-family:Georgia,serif;color:#272431">
  <p style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#756a86">The Interface Review / Issue 142</p>
  <img src="cid:design-review-cover" alt="An editorial illustration about quieter software" style="width:100%;border-radius:12px" />
  <h1 style="font-size:38px;line-height:1.08;letter-spacing:-1px">The case for quieter software</h1>
  <p style="font-size:17px;line-height:1.7">Great products do not compete for your attention. They make the next useful action obvious, then get out of the way.</p>
  <p style="font-size:16px;line-height:1.7">This week: how small teams are replacing notification badges with thoughtful defaults, why an empty state deserves a real point of view, and three interfaces worth stealing from.</p>
  <a href="https://example.com/interface-review/142" style="color:#7057b8">Read issue 142</a>
  <p style="font-family:Arial,sans-serif;font-size:12px;color:#857f8d">Written by Nora Bell in Portland, Oregon.</p>
</article>`

const studioNewsletterHtml = `
<article style="max-width:640px;margin:0 auto;background:#fbf8f2;color:#2d322b;font-family:Georgia,serif">
  <img src="cid:material-notes" alt="A collage of paper, clay, and forest-green samples" style="display:block;width:100%" />
  <div style="padding:28px 32px">
    <p style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:2px;text-transform:uppercase">Material Notes / No. 38</p>
    <h1 style="font-size:34px;line-height:1.12">What happens when a brand feels like a place?</h1>
    <p style="font-size:16px;line-height:1.7">A visit to three independent hotels rethinking tactile identity: brass room keys, warm newsprint, and a shade of green borrowed from the local hills.</p>
    <a href="https://example.com/material-notes/38" style="color:#58765b">Explore the field notes</a>
  </div>
</article>`

const threads: SeedThread[] = [
  {
    account: 'openmail', subject: 'Monday kickoff: inbox launch checklist', folder: 'inbox', daysAgo: 0.02,
    labels: ['product', 'launch'], starred: true, unread: true,
    messages: [
      inbound(people.priya, 'Morning Alex,\n\nI pulled the remaining launch blockers into one checklist. Search indexing is green, and Devon is finishing the keyboard shortcut pass. Can you sanity-check the migration copy before our 10:30?\n\nThe updated brief is attached.\n\nPriya', { attachments: [attachment.brief] }),
      outbound('On it. The migration copy looks solid, but I would soften "import everything" until we confirm how archived threads are handled. I will bring a revised version to the kickoff.'),
      inbound(people.priya, 'Perfect. Marcus also found a small issue with inline image permissions, so let us cover that right after copy. Room Atlas or the usual Meet link.', { cc: [people.marcus] }),
    ],
  },
  {
    account: 'openmail', subject: 'Re: Settings page hierarchy', folder: 'inbox', daysAgo: 0.09,
    labels: ['design'], starred: true, unread: true,
    messages: [
      inbound(people.elena, 'I pushed two directions for the settings page. Version A keeps account controls in the left rail; version B moves them into a compact account switcher. Do you have a preference before I polish the details?'),
      outbound('Version B feels calmer. Keep signatures near the account selector, and let us avoid a second tab bar inside the panel. The density controls can live under Appearance.'),
      inbound(people.elena, 'Agreed. I tightened the spacing and added a small preview for each density option. New frames are ready whenever you have five minutes.'),
    ],
  },
  {
    account: 'openmail', subject: 'Production deploy completed: v0.18.4', folder: 'inbox', daysAgo: 0.14,
    labels: ['engineering'], unread: true,
    messages: [inbound({ name: 'Vercel', email: 'notifications@vercel.com' }, 'Deployment successful\n\nProject: openmail-web\nEnvironment: Production\nCommit: 9a4ec12 - Fix conversation grouping for forwarded messages\nDuration: 42 seconds\n\nAll health checks are passing.')],
  },
  {
    account: 'openmail', subject: 'Activation numbers after the new onboarding', folder: 'inbox', daysAgo: 0.22,
    labels: ['analytics', 'product'], starred: true,
    messages: [
      inbound(people.naomi, 'The first full cohort is in. Account connection is up from 61% to 74%, and time to first sent message fell from 11 minutes to just under 7. The interesting gap is still mobile handoff.'),
      outbound('That is a meaningful jump. Can you split it by Gmail vs. custom-domain users and pull the raw cohort export? I want to make sure we are not just seeing a mix shift.'),
      inbound(people.naomi, 'Attached. The gain holds across both segments: Gmail +11 points, custom domains +15. Mobile handoff remains flat, so I have a separate exploration ready for Wednesday.', { attachments: [attachment.metrics] }),
    ],
  },
  {
    account: 'openmail', subject: 'Can we move Thursday onboarding by 30 minutes?', folder: 'inbox', daysAgo: 0.35,
    labels: ['team'],
    messages: [
      inbound(people.devon, 'I have a dentist appointment that runs into the first half of our Thursday onboarding review. Could we shift from 2:00 to 2:30? I can still have the test account matrix ready beforehand.'),
      outbound('2:30 works for me. I updated the invite and kept the same video link. Hope the appointment is quick.'),
    ],
  },
  {
    account: 'openmail', subject: 'Screen reader pass: conversation actions', folder: 'inbox', daysAgo: 0.52,
    labels: ['accessibility', 'engineering'], unread: true,
    messages: [
      inbound(people.sam, 'VoiceOver now announces sender, subject, unread state, and attachment count in the thread list. The remaining issue is that the archive button loses its accessible name after an optimistic update.'),
      outbound('Nice catch. I suspect the icon button is remounting without its label when the query cache updates. Can you add a regression test around keyboard focus too?'),
      inbound(people.sam, 'Already in the branch. Focus now returns to the next conversation, and the action keeps its label throughout the transition. Ready for review.'),
    ],
  },
  {
    account: 'openmail', subject: 'Your Figma invoice for August', folder: 'inbox', daysAgo: 0.66,
    labels: ['receipts'],
    messages: [inbound({ name: 'Figma Billing', email: 'billing@figma.com' }, 'Thanks for using Figma.\n\nYour August invoice for the OpenMail organization is ready.\nProfessional plan: 6 editor seats\nAmount charged: $90.00\nPayment method: Visa ending in 4242\n\nYour receipt is available in organization settings.')],
  },
  {
    account: 'openmail', subject: 'Northline customer demo: Friday prep', folder: 'inbox', daysAgo: 0.81,
    labels: ['customers', 'sales'], starred: true,
    messages: [
      inbound(people.maya, 'Our operations team is excited to see shared inbox workflows on Friday. The biggest questions are account separation, attachment previews, and whether we can snooze vendor follow-ups.'),
      outbound('We can cover all three. I will use two sample accounts and show the exact path from a vendor message to a snoozed follow-up. Anything else your security lead needs?'),
      inbound(people.maya, 'A quick explanation of where OAuth tokens are stored would help. Five minutes at the end is plenty. We will have four people on the call.'),
    ],
  },
  {
    account: 'openmail', subject: 'Security review notes: token encryption', folder: 'inbox', daysAgo: 0.93,
    labels: ['security'], unread: true,
    messages: [inbound(people.marcus, 'Finished the first pass on provider credentials. Tokens are encrypted at rest, refresh failures are isolated per account, and the logs no longer include provider payloads. One follow-up: rotate the development encryption key before the external beta.')],
  },
  {
    account: 'openmail', subject: 'The case for quieter software', folder: 'inbox', daysAgo: 1.08,
    labels: ['newsletters', 'design'], starred: true,
    messages: [inbound({ name: 'Nora at The Interface Review', email: 'nora@interfacereview.example' }, 'The Interface Review, issue 142\n\nGreat products do not compete for your attention. They make the next useful action obvious, then get out of the way.\n\nThis week: calmer notifications, thoughtful empty states, and three interfaces worth stealing from.', { html: designNewsletterHtml, attachments: [attachment.editorial] })],
  },
  {
    account: 'openmail', subject: 'Elena mentioned you in Inbox / Thread Detail', folder: 'inbox', daysAgo: 1.19,
    labels: ['design', 'notifications'], unread: true,
    messages: [inbound({ name: 'Figma', email: 'notifications@figma.com' }, 'Elena Rodriguez mentioned you in OpenMail / Inbox / Thread Detail:\n\n"@Alex, this is the version with the tighter reply composer and the account color moved into the sender line. Does the attachment row still feel too prominent?"\n\nView the comment in Figma.')],
  },
  {
    account: 'openmail', subject: '[Linear] Your weekly project digest', folder: 'inbox', daysAgo: 1.43,
    labels: ['engineering', 'notifications'],
    messages: [inbound({ name: 'Linear', email: 'notifications@linear.app' }, 'Here is what changed in Inbox Launch this week:\n\nCompleted: 12 issues\nIn progress: 7 issues\nNew: 4 issues\n\nHighlights: unified account switcher, scheduled send foundation, and attachment download permissions.')],
  },
  {
    account: 'openmail', subject: '[openmail/web] Review requested: optimistic thread actions', folder: 'inbox', daysAgo: 1.58,
    labels: ['engineering'], unread: true,
    messages: [inbound({ name: 'GitHub', email: 'notifications@github.com' }, 'Marcus Chen requested your review on pull request #318.\n\nOptimistic thread actions with rollback on provider failure\n\nChanges: archive, trash, star, and mark-read now update immediately while preserving account-scoped cache keys.\n\n3 files changed, 184 additions, 39 deletions.')],
  },
  {
    account: 'openmail', subject: 'Early beta feedback from the Finley team', folder: 'inbox', daysAgo: 1.86,
    labels: ['customers', 'research'],
    messages: [
      inbound(people.priya, 'Three people at Finley completed the first beta session. They loved the keyboard shortcuts and clean message view. All three missed the account filter because the selected state was too subtle.'),
      outbound('That matches what we saw in the hallway test. Let us increase the selected background contrast before we consider adding more UI. Did anyone try the search operators?'),
      inbound(people.priya, 'Two did. from: worked as expected; has:attachment was the one they asked for. I captured the clips and linked them in the research doc.'),
    ],
  },
  {
    account: 'openmail', subject: 'Re: Importing labels from existing Gmail accounts', folder: 'inbox', daysAgo: 2.12,
    labels: ['customers', 'support'],
    messages: [
      inbound({ name: 'Rina Patel', email: 'rina@finleyhealth.com' }, 'Quick question before I connect my work account: will my existing Gmail labels come across automatically, or should I recreate them after the import?'),
      outbound('Your existing labels come across automatically during the first sync. We preserve the label names and apply them to the matching conversations. Nothing is changed in Gmail.'),
    ],
  },
  {
    account: 'openmail', subject: 'Attribution dashboard is ready for a first look', folder: 'inbox', daysAgo: 2.47,
    labels: ['analytics'],
    messages: [
      inbound(people.naomi, 'I finished the first version of the acquisition dashboard. It covers referral source, signup-to-connection rate, and the first meaningful action for each weekly cohort.'),
      outbound('Could you add a separate cut for people invited by a teammate? I have a hunch invited users understand the unified inbox faster than people landing on the homepage.'),
      inbound(people.naomi, 'Added. Invited users connect their first account 18% faster, but they are less likely to discover scheduled send. Interesting onboarding tradeoff.'),
    ],
  },
  {
    account: 'openmail', subject: 'Provider sync edge case with forwarded attachments', folder: 'inbox', daysAgo: 2.8,
    labels: ['engineering'],
    messages: [
      inbound(people.marcus, 'Found a weird one: forwarding a message with two inline images and one PDF can produce duplicate attachment IDs when the provider omits Content-ID.'),
      outbound('Let us hash provider message ID plus filename and position when Content-ID is absent. We should also make sure the inline images do not appear in the downloadable attachment count.'),
      inbound(people.marcus, 'Implemented and added fixtures for both Gmail and Outlook payload shapes. The thread now shows one downloadable file and keeps both inline images visible.'),
    ],
  },
  {
    account: 'openmail', subject: 'Welcome to Railway Pro', folder: 'inbox', daysAgo: 3.1,
    labels: ['receipts'],
    messages: [inbound({ name: 'Railway', email: 'team@railway.app' }, 'Your OpenMail workspace is now on Railway Pro.\n\nYour plan includes team environments, usage-based billing, deployment metrics, and priority support. Your first billing cycle starts today.')],
  },
  {
    account: 'openmail', subject: 'Incident follow-up: delayed sync on Tuesday', folder: 'inbox', daysAgo: 3.62,
    labels: ['engineering', 'incident'], starred: true,
    messages: [
      inbound(people.devon, 'Tuesday\'s delayed sync affected 17 accounts for approximately nine minutes. The cause was a provider rate-limit response being retried without jitter.'),
      outbound('Thanks for the clean write-up. Please add the customer-facing impact, the exact recovery time, and whether any messages were lost or merely delayed.'),
      inbound(people.devon, 'Updated: no messages were lost, median delay was 6m 12s, and all affected accounts recovered by 14:19 UTC. Backoff now includes jitter and account-level circuit breaking.'),
    ],
  },
  {
    account: 'openmail', subject: 'Domain verification complete for openmail.dev', folder: 'inbox', daysAgo: 4.3,
    labels: ['infrastructure'],
    messages: [inbound({ name: 'Cloudflare', email: 'noreply@notify.cloudflare.com' }, 'Your domain openmail.dev has been verified successfully.\n\nDNS records are active and the email routing configuration is ready. No further action is required.')],
  },
  {
    account: 'studio', subject: 'Northline identity: revised presentation deck', folder: 'inbox', daysAgo: 0.18,
    labels: ['northline', 'client'], starred: true, unread: true,
    messages: [
      inbound(people.tess, 'I rebuilt the first six slides around the "quietly capable" positioning. The forest-green wordmark is working, but I am still unsure about pairing it with the condensed serif.'),
      outbound('The positioning feels right. Keep the serif for editorial headlines only and let the wordmark breathe. We should show the hotel keycard before the stationery spread.'),
      inbound(people.tess, 'Updated. The new order makes the whole story click, and I swapped the warm-white background for a slightly cooler paper tone. Ready for Thursday.'),
    ],
  },
  {
    account: 'studio', subject: 'Invoice #1847 from Studioform', folder: 'inbox', daysAgo: 0.73,
    labels: ['finance', 'northline'], unread: true,
    messages: [inbound({ name: 'Studioform Accounts', email: 'accounts@studioform.co' }, 'Hi Alex,\n\nInvoice #1847 for the Northline brand identity milestone is attached.\n\nAmount due: $4,800.00\nDue date: September 12\nProject: Northline / Phase 2\n\nThank you,\nStudioform Accounts', { attachments: [attachment.invoice] })],
  },
  {
    account: 'studio', subject: 'Photography selects for the Fieldwork site', folder: 'inbox', daysAgo: 1.34,
    labels: ['fieldwork', 'creative'],
    messages: [
      inbound(people.ben, 'The photographer delivered 86 selects. I narrowed them to 18, with a stronger emphasis on the workshop and material details. There are two possible hero shots.'),
      outbound('The hands-at-the-workbench image feels most honest. Can we crop a landscape and portrait version before committing? The homepage needs both desktop and narrow mobile treatments.'),
      inbound(people.ben, 'Both crops are in the shared folder. The portrait version actually gives us more room for the headline, so I think we have a winner.'),
    ],
  },
  {
    account: 'studio', subject: 'Material Notes No. 38: a brand that feels like a place', folder: 'inbox', daysAgo: 1.97,
    labels: ['newsletters', 'inspiration'],
    messages: [inbound({ name: 'Material Notes', email: 'hello@materialnotes.example' }, 'Material Notes, No. 38\n\nWhat happens when a brand feels like a place? We visited three independent hotels rethinking tactile identity through brass room keys, warm newsprint, and colors borrowed from the local landscape.', { html: studioNewsletterHtml, attachments: [attachment.materials] })],
  },
  {
    account: 'studio', subject: 'Print estimate: Northline welcome cards', folder: 'inbox', daysAgo: 2.34,
    labels: ['northline', 'production'],
    messages: [
      inbound({ name: 'Eva at Common Press', email: 'eva@commonpress.example' }, 'For 500 welcome cards on 300gsm recycled stock with one-color letterpress, the estimate is $860 plus shipping. A second ink color adds $190. Production time is eight business days.'),
      outbound('Thanks, Eva. Please hold a slot for the one-color version while we confirm the final quantity. Could you send a sample of the recycled stock with your next courier run?'),
    ],
  },
  {
    account: 'studio', subject: 'New comment on Studioform / Brand Components', folder: 'inbox', daysAgo: 3.05,
    labels: ['design', 'notifications'], unread: true,
    messages: [inbound({ name: 'Figma', email: 'notifications@figma.com' }, 'Oliver Reed commented on Studioform / Brand Components:\n\n"The small-size lockup is losing legibility below 120px. I made an alternate with wider tracking and a simplified mark."')],
  },
  {
    account: 'studio', subject: 'Workshop agenda for Tuesday', folder: 'inbox', daysAgo: 4.72,
    labels: ['team', 'planning'],
    messages: [
      inbound(people.oliver, 'Proposed agenda: Northline presentation rehearsal, Fieldwork photo selects, autumn project capacity, and a quick review of our proposal template. Ninety minutes should cover it.'),
      outbound('Looks good. Let us start with capacity while everyone is fresh, then move into the Northline rehearsal. I have notes from last week\'s roadmap workshop attached.', { attachments: [attachment.roadmap] }),
    ],
  },
  {
    account: 'personal', subject: 'Cabin weekend: groceries and arrival time', folder: 'inbox', daysAgo: 0.28,
    labels: ['family', 'travel'], starred: true, unread: true,
    messages: [
      inbound(people.claire, 'We booked the cabin for the second weekend in September. Check-in is 4 pm Friday, and the host says the kitchen has the basics but no coffee grinder.'),
      outbound('I can bring the grinder, beans, and breakfast stuff. If Theo is driving up after work, maybe he can grab the cooler and a couple bags of ice.'),
      inbound(people.claire, 'Perfect. Theo is in, and Mom is bringing the big pot for soup. I will share the grocery list tonight. Cannot wait.'),
    ],
  },
  {
    account: 'personal', subject: 'Your order from Alder Books has shipped', folder: 'inbox', daysAgo: 0.94,
    labels: ['orders'],
    messages: [inbound({ name: 'Alder Books', email: 'orders@alderbooks.example' }, 'Your order is on its way.\n\nOrder AB-29104\n- The Creative Act: A Way of Being\n- Ways of Seeing\n\nEstimated delivery: Thursday, August 27\nTracking updates will appear once the carrier scans your package.')],
  },
  {
    account: 'personal', subject: 'Reservation confirmed: Lark & Pine', folder: 'inbox', daysAgo: 1.26,
    labels: ['reservations'],
    messages: [inbound({ name: 'Lark & Pine', email: 'reservations@larkandpine.example' }, 'Your table is confirmed.\n\nFriday at 7:15 pm\nParty of 4\nLark & Pine, 81 Mercer Street\n\nPlease let us know about any dietary requirements before you arrive.')],
  },
  {
    account: 'personal', subject: 'Sunday ride if the weather holds?', folder: 'inbox', daysAgo: 1.74,
    labels: ['friends'],
    messages: [
      inbound(people.theo, 'Forecast says clear skies Sunday morning. Want to do the river loop and stop at that bakery in Millbrook? I can meet at the bridge around 8:30.'),
      outbound('Yes, count me in. 8:30 at the bridge works. Let us take the longer way back if the wind is not too bad.'),
    ],
  },
  {
    account: 'personal', subject: 'A note from your local library', folder: 'inbox', daysAgo: 2.19,
    labels: ['community'], unread: true,
    messages: [inbound({ name: 'Riverside Public Library', email: 'notices@riversidelibrary.example' }, 'Good news: your hold is ready for pickup.\n\nTitle: Four Thousand Weeks\nPickup location: Main Branch, front desk\nPlease collect by next Tuesday at 6 pm.')],
  },
  {
    account: 'personal', subject: 'Monthly statement is available', folder: 'inbox', daysAgo: 3.41,
    labels: ['finance'],
    messages: [inbound({ name: 'Mercury', email: 'notifications@mercury.com' }, 'Your August account statement is ready to view. Sign in to your account to review transactions, download the statement, or update your notification preferences.')],
  },
  {
    account: 'personal', subject: 'Neighborhood garden volunteer morning', folder: 'inbox', daysAgo: 5.14,
    labels: ['community'],
    messages: [inbound({ name: 'Friends of Riverside Garden', email: 'hello@riversidegarden.example' }, 'We are getting the neighborhood garden ready for autumn this Saturday from 9 to noon. Bring gloves if you have them; tools, coffee, and pastries will be provided. All experience levels welcome.')],
  },
  {
    account: 'personal', subject: 'Your September train tickets', folder: 'inbox', daysAgo: 6.38,
    labels: ['travel', 'receipts'],
    messages: [inbound({ name: 'Amtrak', email: 'tickets@amtrak.com' }, 'Your trip is confirmed.\n\nFriday, September 11\nNew York Penn Station to Hudson\nDepart 2:45 pm / Arrive 4:51 pm\n\nPassenger: Alex Morgan\nConfirmation: R8D4KC')],
  },
  {
    account: 'openmail', subject: 'Follow-up: account isolation demo recording', folder: 'sent', daysAgo: 0.46,
    labels: ['customers', 'sales'],
    messages: [
      inbound(people.maya, 'Could you send the recording from yesterday\'s walkthrough? Our security lead missed the section about account-scoped search.'),
      outbound('Absolutely. I added the recording and timestamped the account isolation section at 12:40. It also shows what happens when two teammates connect different provider accounts.'),
    ],
  },
  {
    account: 'openmail', subject: 'Notes for next week\'s product review', folder: 'sent', daysAgo: 1.17,
    labels: ['product', 'planning'],
    messages: [
      inbound(people.priya, 'Can you send your top three discussion points before Friday? I want the review to focus on decisions, not status updates.'),
      outbound('My three: default reading mode, when to expose advanced search, and whether snooze presets should be account-specific. I added supporting screenshots to the agenda.'),
    ],
  },
  {
    account: 'studio', subject: 'Re: Northline kickoff materials', folder: 'sent', daysAgo: 1.9,
    labels: ['northline', 'client'],
    messages: [
      inbound(people.maya, 'Our founders asked if we can have the workshop summary before Monday\'s board meeting.'),
      outbound('Attached is the concise project brief, including the positioning statement, audience priorities, and the first identity direction. Let me know if a slide version would be more useful.', { attachments: [attachment.brief] }),
    ],
  },
  {
    account: 'personal', subject: 'Re: Cabin host questions', folder: 'sent', daysAgo: 2.64,
    labels: ['travel'],
    messages: [
      inbound({ name: 'Mara at Pine Hollow', email: 'mara@pinehollow.example' }, 'Happy to confirm: the cabin has two parking spaces, a small fire pit, and reliable Wi-Fi. Do you need an early check-in?'),
      outbound('Thanks, Mara. Standard check-in is fine, and two parking spaces are perfect. We will bring our own firewood unless you recommend picking some up nearby.'),
    ],
  },
  {
    account: 'openmail', subject: 'Updated launch copy for the homepage', folder: 'sent', daysAgo: 3.32,
    labels: ['launch', 'marketing'],
    messages: [
      inbound(people.elena, 'The homepage hero still says "all your email, one place." It feels accurate but generic. Any better direction before I lock the layout?'),
      outbound('Try "Your inbox, without the noise." Supporting line: "Bring every account together in a calmer, faster place to work." It says what changes without promising magic.'),
    ],
  },
  {
    account: 'studio', subject: 'Availability for the October brand sprint', folder: 'sent', daysAgo: 5.83,
    labels: ['new-business'],
    messages: [
      inbound({ name: 'Lydia Grant', email: 'lydia@junipergoods.example' }, 'We are exploring a small brand refresh for October. Do you have capacity for a two-week strategy and visual identity sprint?'),
      outbound('We have an opening in the second half of October. A two-week sprint would cover discovery, one core identity direction, and a practical handoff kit. Happy to share a sample scope.'),
    ],
  },
  {
    account: 'openmail', subject: 'Resolved: attachment preview caching', folder: 'archive', daysAgo: 7.25,
    labels: ['engineering'],
    messages: [
      inbound(people.marcus, 'Preview URLs were being cached across account switches because the cache key only included the attachment ID.'),
      outbound('Merged the fix with accountId and userId in the key. Added a regression test using identical provider attachment IDs from two separate accounts.'),
    ],
  },
  {
    account: 'openmail', subject: 'Beta onboarding interviews: summary', folder: 'archive', daysAgo: 9.48,
    labels: ['research', 'product'],
    messages: [
      inbound(people.priya, 'Interview summary is ready: six sessions, four recurring themes, and one clear opportunity around explaining account colors during setup.'),
      outbound('Read it and added comments. The strongest insight is that people understand unified inboxes immediately when the sender line keeps the account visible.'),
    ],
  },
  {
    account: 'studio', subject: 'Fieldwork contract signed', folder: 'archive', daysAgo: 12.75,
    labels: ['fieldwork', 'contracts'], starred: true,
    messages: [
      inbound(people.ben, 'Signed contract is complete. We are officially set for discovery on the 14th and first concepts two weeks later.'),
      outbound('Wonderful. Calendar invites are out, and Tess will send the short pre-workshop questionnaire tomorrow morning.'),
    ],
  },
  {
    account: 'personal', subject: 'Re: birthday dinner photos', folder: 'archive', daysAgo: 16.2,
    labels: ['family'],
    messages: [
      inbound(people.claire, 'Finally uploaded the photos from Dad\'s birthday dinner. The one with the cake and all the candles is a classic.'),
      outbound('These are great. I printed the cake photo for Mom, and she has already put it on the fridge.'),
    ],
  },
  {
    account: 'openmail', subject: 'Q2 planning workshop notes', folder: 'archive', daysAgo: 21.4,
    labels: ['planning', 'product'],
    messages: [
      inbound(people.naomi, 'Sharing the cleaned-up notes from our planning workshop. The key decisions are grouped by customer outcomes, platform work, and experiments.', { attachments: [attachment.roadmap] }),
      outbound('Thanks. I linked this from the team hub and pulled the three committed outcomes into the public roadmap draft.'),
    ],
  },
  {
    account: 'studio', subject: 'Studio insurance renewal confirmed', folder: 'archive', daysAgo: 29.8,
    labels: ['finance', 'operations'],
    messages: [
      inbound({ name: 'Hearth Insurance', email: 'renewals@hearthinsurance.example' }, 'Your Studioform professional liability policy has been renewed for another twelve months. Your updated certificate is available in the policy portal.'),
      outbound('Received, thank you. Please update the billing contact to accounts@studioform.co for future renewal notices.'),
    ],
  },
  {
    account: 'openmail', subject: 'Thoughts on the launch announcement', folder: 'drafts', daysAgo: 0.12,
    labels: ['launch'],
    messages: [outbound('Hi everyone,\n\nAfter months of small decisions and a lot of careful testing, we are almost ready to share OpenMail. The thing I am proudest of is not a headline feature. It is how quietly the whole experience fits together.\n\nStill need to add the beta link and')],
  },
  {
    account: 'studio', subject: 'Proposal: Juniper Goods autumn sprint', folder: 'drafts', daysAgo: 0.78,
    labels: ['new-business'],
    messages: [outbound('Hi Lydia,\n\nBased on our call, I would structure the sprint around three focused workstreams:\n\n1. Audience and positioning workshop\n2. One flexible visual identity direction\n3. A lightweight launch toolkit\n\nBudget and timing:')],
  },
  {
    account: 'personal', subject: 'Cabin grocery list', folder: 'drafts', daysAgo: 1.48,
    labels: ['family', 'travel'],
    messages: [outbound('Coffee beans\nOat milk\nEggs\nSourdough\nSoup ingredients\nApples\nTrail snacks\n\nAsk Claire about allergies before finalizing.')],
  },
  {
    account: 'openmail', subject: 'Search operators worth shipping first', folder: 'drafts', daysAgo: 2.06,
    labels: ['product'],
    messages: [outbound('Initial shortlist:\n\nfrom: - high intent, easy to explain\nhas:attachment - requested in 4 of 6 sessions\nis:unread - useful with multiple accounts\nlabel: - needs clearer naming before launch\n\nOpen question: should account: accept the address or display name?')],
  },
  {
    account: 'openmail', subject: 'Circle back: customer reference for Northline', folder: 'snoozed', daysAgo: 1.63,
    labels: ['customers', 'sales'], snoozeHours: 6,
    messages: [
      inbound(people.maya, 'Our CEO would be happy to act as a reference once the team has been using the beta for another week. Could you remind me next Tuesday?'),
      outbound('Absolutely. I will check back next Tuesday after your team has had a little more time with the shared inbox workflow.'),
    ],
  },
  {
    account: 'studio', subject: 'Paper stock samples arriving next week', folder: 'snoozed', daysAgo: 2.91,
    labels: ['northline', 'production'], snoozeHours: 30,
    messages: [
      inbound({ name: 'Eva at Common Press', email: 'eva@commonpress.example' }, 'The recycled stock sample and two warmer alternatives are on their way. Courier delivery is expected next Monday afternoon.'),
      outbound('Great, thank you. I will compare them under daylight and send our final selection once the package arrives.'),
    ],
  },
  {
    account: 'personal', subject: 'Annual bike service reminder', folder: 'snoozed', daysAgo: 4.36,
    labels: ['errands'], snoozeHours: 52,
    messages: [
      inbound({ name: 'Millbrook Cycles', email: 'service@millbrookcycles.example' }, 'Your commuter bike is due for its annual service. We have appointments available next week, including early drop-off on Thursday.'),
      outbound('Thanks for the reminder. I need to check my schedule before booking, but Thursday morning may work.'),
    ],
  },
  {
    account: 'openmail', subject: 'Monday beta cohort welcome', folder: 'scheduled', daysAgo: 0.11,
    labels: ['launch', 'customers'], scheduleHours: 18,
    messages: [outbound('Hi everyone,\n\nWelcome to the next OpenMail beta group. Your invitations are ready, and we would love your first impressions after connecting an account.\n\nIf anything feels confusing or unexpectedly delightful, reply directly. Every note reaches the team.\n\nAlex')],
  },
  {
    account: 'studio', subject: 'Northline: materials ready for your review', folder: 'scheduled', daysAgo: 0.49,
    labels: ['northline', 'client'], scheduleHours: 28,
    messages: [outbound('Hi Maya,\n\nThe revised identity presentation is ready, including the updated wordmark, hotel keycard concepts, and production estimates for the welcome cards.\n\nLooking forward to walking through it together.\n\nAlex', { attachments: [attachment.brief] })],
  },
  {
    account: 'personal', subject: 'Happy birthday, Mom!', folder: 'scheduled', daysAgo: 1.08,
    labels: ['family'], scheduleHours: 71,
    messages: [outbound('Happy birthday, Mom!\n\nI hope your morning starts with good coffee and absolutely no errands. Claire and I have something planned for dinner, so keep the evening free.\n\nLove,\nAlex')],
  },
  {
    account: 'openmail', subject: 'Exclusive offer: 10,000 verified startup leads', folder: 'spam', daysAgo: 0.87,
    messages: [inbound({ name: 'Growth Pipeline Pro', email: 'offers@pipeline-discounts.example' }, 'Unlock a hand-curated list of 10,000 startup decision-makers today only. Guaranteed conversions, unlimited exports, and a 97% open rate. Reply YES for a special founder discount.')],
  },
  {
    account: 'studio', subject: 'Increase your domain authority instantly', folder: 'spam', daysAgo: 3.26,
    messages: [inbound({ name: 'Search Ranking Team', email: 'outreach@rank-boost-mail.example' }, 'We noticed studioform.co is missing from several premium search directories. Our automated placement package can add hundreds of backlinks within 48 hours. Limited spots remaining.')],
  },
  {
    account: 'personal', subject: 'Package delivery failed - confirm now', folder: 'spam', daysAgo: 5.77,
    messages: [inbound({ name: 'Parcel Notification', email: 'tracking@parcel-update-alert.example' }, 'A parcel could not be delivered because your address information is incomplete. Confirm your details immediately to avoid a return processing fee.')],
  },
  {
    account: 'openmail', subject: 'Canceled: old staging environment check-in', folder: 'trash', daysAgo: 2.53,
    messages: [inbound({ name: 'Google Calendar', email: 'calendar-notification@google.com' }, 'This event has been canceled.\n\nOld staging environment check-in\nOrganizer: Devon Brooks\nThe associated video meeting link is no longer active.')],
  },
  {
    account: 'studio', subject: 'Outdated proof: Northline welcome cards v2', folder: 'trash', daysAgo: 6.13,
    messages: [inbound({ name: 'Eva at Common Press', email: 'eva@commonpress.example' }, 'Please disregard the v2 proof I sent this morning. The trim marks were based on the previous card dimensions. A corrected version will follow shortly.')],
  },
  {
    account: 'personal', subject: 'Your trial is ending soon', folder: 'trash', daysAgo: 8.49,
    messages: [inbound({ name: 'Cloud Storage Plus', email: 'updates@storageplus.example' }, 'Your 14-day trial ends in three days. Upgrade now to keep expanded storage, automatic photo backups, and shared family folders.')],
  },
  {
    account: 'jordan', subject: 'Jordan: private quarterly planning notes', folder: 'inbox', daysAgo: 0.16,
    labels: ['private', 'planning'], starred: true, unread: true,
    messages: [
      inbound({ name: 'Avery Kim', email: 'avery@jordanstudio.example' }, 'The confidential quarterly planning notes are ready. Please keep the acquisition discussion between us until the board meeting.'),
      outbound('Understood. I will review the notes privately tonight and bring a short summary to the board meeting.'),
    ],
  },
  {
    account: 'jordan', subject: 'Your personal account security update', folder: 'inbox', daysAgo: 1.42,
    labels: ['security'], unread: true,
    messages: [inbound({ name: 'Security Team', email: 'security@jordanstudio.example' }, 'A new passkey was added to your account from a recognized device. If this was not you, contact your account administrator immediately.')],
  },
  {
    account: 'jordan', subject: 'Re: Friday lunch at Cedar House', folder: 'sent', daysAgo: 2.85,
    labels: ['personal'],
    messages: [
      inbound({ name: 'Riley Adams', email: 'riley.adams@example.com' }, 'Still on for lunch at Cedar House Friday? I can get there around 12:15.'),
      outbound('Friday at 12:15 works perfectly. I booked a table under my name.'),
    ],
  },
]

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function renderMessageHtml(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => `<p style="margin:0 0 16px;line-height:1.65">${escapeHtml(paragraph).replaceAll('\n', '<br />')}</p>`)
    .join('\n')
}

function getOrCreateUser(email: string, name: string): Promise<string> {
  const existing = sqlite.query('SELECT id FROM user WHERE email = ?').get(email) as { id: string } | null

  if (existing) return Promise.resolve(existing.id)

  return auth.api.signUpEmail({ body: { email, name, password: 'OpenMail123!' } }).then(() => {
    const created = sqlite.query('SELECT id FROM user WHERE email = ?').get(email) as { id: string } | null

    if (!created) throw new Error(`Demo user was not created: ${email}`)

    return created.id
  })
}

export async function seedDemoData(): Promise<void> {
  if (process.env.NODE_ENV === 'production' && process.env.SEED_DEMO !== 'true') {
    throw new Error('Demo seeding is disabled in production; explicitly set SEED_DEMO=true to enable it')
  }

  const alexUserId = await getOrCreateUser('demo@example.com', 'Alex Morgan')
  const jordanUserId = await getOrCreateUser('jordan@example.com', 'Jordan Lee')
  const now = Date.now()

  const accounts: Record<SeedThread['account'], DemoAccount> = {
    openmail: {
      id: 'demo-account-openmail', userId: alexUserId, name: 'OpenMail', email: 'alex@openmail.dev',
      color: '#696a70', signature: 'Alex Morgan\nProduct & Design\nOpenMail',
    },
    studio: {
      id: 'demo-account-studioform', userId: alexUserId, name: 'Studioform', email: 'alex@studioform.co',
      color: '#22c55e', signature: 'Alex Morgan\nStudioform\nstudioform.co',
    },
    personal: {
      id: 'demo-account-personal', userId: alexUserId, name: 'Personal', email: 'alex.personal@example.com',
      color: '#f59e0b', signature: 'Alex',
    },
    jordan: {
      id: 'demo-account-jordan', userId: jordanUserId, name: 'Jordan Studio', email: 'jordan@example.com',
      color: '#3b82f6', signature: 'Jordan Lee\nJordan Studio',
    },
  }

  sqlite.query(`
    UPDATE mail_accounts SET color = ?
    WHERE id = ? AND user_id = ? AND provider = 'mock' AND color IN ('#8b5cf6', '#68665f')
  `).run(accounts.openmail.color, accounts.openmail.id, alexUserId)

  const existingAccounts = new Set(
    Object.values(accounts)
      .filter((account) => sqlite.query('SELECT id FROM mail_accounts WHERE id = ?').get(account.id))
      .map((account) => account.id),
  )

  if (existingAccounts.size === Object.keys(accounts).length) return

  const insertAccount = sqlite.query(`
    INSERT INTO mail_accounts (
      id, user_id, name, email, provider, color, credentials_encrypted, sync_status,
      last_sync_at, unread_count, signature, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const insertMessage = sqlite.query(`
    INSERT INTO messages (
      id, thread_id, account_id, user_id, from_json, to_json, cc_json, bcc_json,
      subject, preview, body_text, body_html, received_at, is_read, is_starred,
      folder, labels_json, attachments_json, snoozed_until, scheduled_at,
      read_receipt, provider_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const updateUnreadCount = sqlite.query(`
    UPDATE mail_accounts
    SET unread_count = (
      SELECT COUNT(*) FROM messages
      WHERE account_id = mail_accounts.id AND folder = 'inbox' AND is_read = 0
    )
    WHERE id = ?
  `)

  const seed = sqlite.transaction(() => {
    for (const account of Object.values(accounts)) {
      if (existingAccounts.has(account.id)) continue

      const createdAt = new Date(now - 42 * 86_400_000).toISOString()
      insertAccount.run(
        account.id, account.userId, account.name, account.email, 'mock', account.color,
        null, 'connected', new Date(now - 90_000).toISOString(), 0, account.signature, createdAt,
      )
    }

    threads.forEach((thread, threadIndex) => {
      const account = accounts[thread.account]
      if (existingAccounts.has(account.id)) return

      const accountParticipant: Participant = {
        name: thread.account === 'jordan' ? 'Jordan Lee' : 'Alex Morgan',
        email: account.email,
      }
      const firstInbound = thread.messages.find((message) => message.direction === 'inbound')?.from
      const threadId = `demo-thread-${String(threadIndex + 1).padStart(3, '0')}`

      thread.messages.forEach((message, messageIndex) => {
        const messageId = `${threadId}-message-${messageIndex + 1}`
        const receivedAt = new Date(
          now - thread.daysAgo * 86_400_000 - (thread.messages.length - messageIndex - 1) * 5_400_000,
        ).toISOString()
        const isOutbound = message.direction === 'outbound'
        const from = isOutbound ? accountParticipant : message.from ?? people.priya
        const to = isOutbound ? [firstInbound ?? people.priya] : [accountParticipant]
        const folder = message.folder ?? (isOutbound && thread.folder === 'inbox' ? 'sent' : thread.folder)
        const isLastMessage = messageIndex === thread.messages.length - 1
        const isRead = message.read ?? (isOutbound || !thread.unread || !isLastMessage)
        const snoozedUntil = thread.folder === 'snoozed'
          ? new Date(now + (thread.snoozeHours ?? 12) * 3_600_000).toISOString()
          : null
        const scheduledAt = thread.folder === 'scheduled'
          ? new Date(now + (thread.scheduleHours ?? 24) * 3_600_000).toISOString()
          : null
        const preview = message.text.replace(/\s+/g, ' ').trim().slice(0, 180)

        insertMessage.run(
          messageId,
          threadId,
          account.id,
          account.userId,
          JSON.stringify(from),
          JSON.stringify(to),
          JSON.stringify(message.cc ?? []),
          JSON.stringify([]),
          thread.subject,
          preview,
          message.text,
          message.html ?? renderMessageHtml(message.text),
          receivedAt,
          Number(isRead),
          Number(Boolean(thread.starred)),
          folder,
          JSON.stringify(thread.labels ?? []),
          JSON.stringify(message.attachments ?? []),
          snoozedUntil,
          scheduledAt,
          Number(isOutbound && ['customers', 'client'].some((label) => thread.labels?.includes(label))),
          `mock-${messageId}`,
          receivedAt,
        )
      })
    })

    for (const account of Object.values(accounts)) {
      if (!existingAccounts.has(account.id)) updateUnreadCount.run(account.id)
    }
  })

  seed()
}

if (import.meta.main) {
  initDatabase()
  await initAuth()
  await seedDemoData()
}
