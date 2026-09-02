import type { Participant, SendAttachment } from 'inbox-sdk/provider'
import { MockMailStore, type StoreScope } from './store'
import { MOCK_OWNER } from './validation'

export const INITIAL_SEED_COUNTS = Object.freeze({ accounts: 2, messages: 160, threads: 128, inboxPerAccount: 48, attachments: 12 })

const profiles = [
  { seedKey: 'harbor', name: 'Mira Chen', email: 'mira@harbor.test', aliases: ['notes@harbor.test'], color: '#407B85' },
  { seedKey: 'atelier', name: 'Noah Ríos', email: 'noah@atelier.test', aliases: ['studio@atelier.test'], color: '#A16F48' },
]

const people: Participant[] = [
  { name: 'Zoë Étoile', email: 'zoe@lantern.test' },
  { name: 'Ibrahim Noor', email: 'ibrahim@meadow.test' },
  { name: '李明', email: 'ming@paperboat.test' },
  { name: 'Amélie Dubois', email: 'amelie@clover.test' },
  { name: 'Sofía Luna', email: 'sofia@orchard.test' },
  { name: 'Rowan Vale', email: 'rowan@tidepool.test' },
  { name: 'Asha Reed', email: 'asha@wildfern.test' },
  { name: 'Léon Park', email: 'leon@sunroom.test' },
]

// Written for this mock, not imported from mail, screenshots, contacts, or reference data.
const topics = [
  ['Saturday at the lantern workshop', 'Can we try the blue paper for the small lanterns? I have put two versions of the packing list together.'],
  ['A route for the river walk', 'The east path is open again. Let’s meet at the little footbridge and leave enough time for tea.'],
  ['Garden exchange — spring notes', 'The seed inventory is ready. There are more marigolds than expected, and the empty notes file is intentional.'],
  ['Lunch with the book circle', 'We chose a short collection of stories for the next gathering. Bring one passage you would like to read aloud.'],
  ['A tiny color study', 'Here is an inline image for the studio notebook. The image is included in the message, so it does not need an internet connection.'],
  ['Paper boats for the window', 'I folded three versions. The wide hull floats longest, but the narrow one catches the light beautifully.'],
  ['The orchard picnic plan', 'We have a blanket, a thermos, and a basket of pears. Shall we use the sheltered spot if it gets windy?'],
  ['Thank you for the listening session', 'The quiet ending made the whole piece feel different. I would love to hear your notes when you have a moment.'],
  ['Museum sketch morning', 'The imaginary museum has a new room of ceramic birds. A slow drawing session sounds like the right way to see it.'],
  ['A new shelf for the reading room', 'The shelf measurements are complete. There should be room for the tall atlases on the bottom row.'],
  ['Notebook index, with a small attachment', 'I made a plain-text index so that we can find our field observations without opening every notebook.'],
  ['Coffee after the rehearsal?', 'The rehearsal should end before the evening rain. We can meet by the covered courtyard afterward.'],
  ['Notes from the quiet room', 'The soft curtains made the room much easier to listen in. I wrote down a few observations about the arrangement.'],
  ['Invitation: a fictional neighborhood supper', 'Everyone is bringing a simple dish and a story about where it came from. There is no need to make anything elaborate.'],
  ['Rainy-day reading recommendations', 'I found three gentle mysteries, a book about clouds, and a wonderfully odd collection of maps.'],
  ['Could you check the poster wording?', 'The heading is settled, but the last sentence still feels too formal. A shorter invitation might work better.'],
  ['Blue teapot, safely returned', 'The teapot is back on the kitchen shelf. Thank you for lending it for the small afternoon gathering.'],
  ['A question about the seed library', 'Do we want separate envelopes for each variety, or one packet with a clear list of what is inside?'],
  ['Tomorrow’s community drawing table', 'I will bring the charcoal and a stack of spare paper. We still need someone to choose a few interesting objects.'],
  ['The afternoon light in the courtyard', 'For about ten minutes, the whole wall turned golden. I made a quick sketch rather than trying to describe it from memory.'],
  ['Fictional community bulletin', 'This is the shared bulletin sent independently to both mock accounts. Matching RFC headers do not make their stores the same.'],
  ['A small repair for the reading lamp', 'The shade only needed a new clip. The lamp is ready to go back beside the armchair.'],
  ['Which songs for the long walk?', 'I started a list with a few slow songs and some very cheerful ones. Please add something unexpected.'],
  ['Recipe notes: lemon and rosemary', 'The second batch needed less sugar and a little more lemon zest. I have written the quantities in the notebook.'],
  ['An invitation in two languages', 'Bonjour, こんにちは! The welcome note now has both translations. Thank you for checking that it still sounds warm.'],
  ['The little clay houses are dry', 'They are ready for the first firing. I marked the undersides so we can tell the experiments apart later.'],
  ['Weekend train-table puzzle', 'The fictional route has two equally pleasant stops. I am choosing between the sculpture garden and the old observatory.'],
  ['Please keep the cardboard offcuts', 'They are perfect for making small dividers for the seed drawers. Even the narrow strips will be useful.'],
  ['Re: a title that begins with Re:', 'This is a new conversation whose subject happens to start with Re:. Only explicit reply metadata determines its thread.'],
  ['An unexpectedly good soup', 'The lentils, fennel, and a spoon of mustard worked very well together. Next time I will make enough for everyone.'],
  ['Map of the imaginary island', 'The harbor is now on the north shore, and the footpath goes around the lake instead of through the marsh.'],
  ['The repaired kite is ready', 'The new spar is lighter, and the tail is a little longer. We should try it on a day with steady wind.'],
  ['A soft deadline for the zine', 'There is still room for one short poem and a page of sketches. A rough version is completely fine for now.'],
  ['A note about accessibility', 'The entrance description now includes the quiet route and the step-free path. Please tell me if anything is unclear.'],
  ['Borrowing the large mixing bowl', 'Would it be all right to borrow it for the weekend? I will return it with a slice of whatever we end up baking.'],
  ['A new name for the reading group', 'The current favorite is The Unhurried Pages. It seems to fit the way we talk about books.'],
  ['Window boxes, after the rain', 'The thyme has perked up, and the nasturtiums look very happy. I moved the smallest pot into a little more light.'],
  ['The first page of the travel notebook', 'I began with a drawing of a suitcase instead of an itinerary. It feels like a better place to start.'],
  ['A meeting with no agenda', 'Just an hour to share what we have been making. Bring a question, a half-finished idea, or nothing at all.'],
  ['A very small celebration', 'The last box is unpacked, and the table is finally clear. That seems like a good enough reason for cake.'],
  ['Sent: workshop materials confirmed', 'I have set aside the paper, string, and clips. Everything is labeled and ready for the workshop table.'],
  ['Sent: the draft itinerary', 'Here is the relaxed version of the plan. Nothing begins before breakfast, and there is room for wandering.'],
  ['Sent: thanks for the spare jars', 'The jars are already full of pencils and brushes. They are exactly the size the studio needed.'],
  ['Sent: our picnic contribution', 'We will bring bread, a fruit salad, and a few spare cups. Let us know if the location changes.'],
  ['Sent: a quiet rehearsal time', 'The early afternoon slot works well. I will arrive a little before it starts to help arrange the chairs.'],
  ['Sent: the revised welcome note', 'I shortened the opening and made the directions more precise. The final paragraph is still yours to change.'],
  ['Sent: a list of borrowed books', 'I checked the stack beside the sofa. The book of trees and the little poetry collection are both here.'],
  ['Sent: the window display sketch', 'The arrangement uses the three tallest objects on the left. The open space on the right makes it feel calmer.'],
  ['Archived: the winter seed order', 'This order was completed in the fictional past. We kept the details as a useful reference for next season.'],
  ['Archived: lantern night directions', 'The event has finished, but the directions may be useful if we use the same courtyard again.'],
  ['Archived: book circle reading list', 'These were the titles from our previous round of reading. The last selection led to an excellent conversation.'],
  ['Archived: a studio shelf plan', 'The shelf is built, and the plan can be put away. We used the shorter version with the wider bottom compartment.'],
  ['Archived: fabric exchange notes', 'All of the fabric found a new home. The small blue pieces became a very cheerful patchwork bag.'],
  ['Archived: a finished paper model', 'The model is complete and sitting by the window. Thank you for helping work out the awkward corner.'],
  ['Archived: the old rehearsal schedule', 'This schedule is no longer current. It stays here only as a record of the sessions we completed.'],
  ['Spam example: imaginary moon coupons', 'An entirely fictional promotional message used to populate the Spam folder. There are no real links or offers.'],
  ['Spam example: a pretend prize notice', 'This mock message is deliberately uninteresting and safely offline. No action is required.'],
  ['Spam example: endless paper umbrellas', 'A fictional bulk advertisement for a fictional shop. This sample never contacted an external mail service.'],
  ['Trash example: duplicate event note', 'This obsolete note is in Trash so that restoring and permanent deletion can be exercised.'],
  ['Trash example: an abandoned shopping list', 'The list was replaced with a newer version. There is nothing here that needs to be retained.'],
  ['Trash example: a cancelled room booking', 'The fictional booking was cancelled. The message is a safe example for mailbox cleanup.'],
  ['Field notes: birds at the footbridge', 'Three little birds were perched on the railing. I noted their silhouettes, not their species.'],
  ['Field notes: the shape of the clouds', 'Long low clouds moved across the ridge, and one small cloud remained almost perfectly still.'],
  ['Field notes: the sound of the courtyard', 'Footsteps, a kettle, and someone practicing scales through an open window. A surprisingly good afternoon soundtrack.'],
] as const

const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const escape = (value: string) => value.replace(/[&<>"']/g, character => entities[character]!)
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='

function seedAttachments(index: number): SendAttachment[] {
  if (index === 0) return [
    { filename: 'packing-list.txt', contentType: 'text/plain', content: 'Fictional lantern kit\nPaper\nString\nClips\n' },
    { filename: 'packing-list.txt', contentType: 'text/plain', content: 'Second version — add a spare pair of scissors.\n' },
  ]
  if (index === 2) return [
    { filename: 'récolte-種.csv', contentType: 'text/csv', content: 'plant,packets\nmarigold,12\nthyme,8\n' },
    { filename: 'empty-notes.txt', contentType: 'text/plain', content: new Uint8Array(0) },
  ]
  if (index === 4) return [{ filename: 'tiny-study.png', contentType: 'image/png', content: pixel, encoding: 'base64', inline: true, contentId: 'study@inline.test' }]
  if (index === 10) return [{ filename: 'notebook-index.txt', contentType: 'text/plain', content: '01 — Footbridge\n02 — Courtyard\n03 — Orchard\n' }]
  return []
}

export function seedMockMail(store: MockMailStore, owner = MOCK_OWNER): void {
  store.seedOnce(owner, () => {
    if (topics.length !== 64) throw new Error('The fictional seed must contain 64 independent conversations per store.')
    const anchor = Math.floor(Date.now() / 60_000) * 60_000 - 3_600_000
    for (const [accountIndex, profile] of profiles.entries()) {
      const mailbox = store.createMailbox({ ...profile, owner })
      const scope: StoreScope = { owner, storeId: mailbox.id, accountId: `seed:${mailbox.id}` }
      const fieldNotes = store.createFolder(scope, 'Field notes')
      store.createFolder(scope, 'Weekend plans')
      const labels = ['Projects', 'People', 'Later'].map(name => store.createFolder(scope, name, 'label'))
      const self: Participant = { name: profile.name, email: profile.email }
      for (const [index, [subject, note]] of topics.entries()) {
        const other = people[(index + accountIndex * 3) % people.length]!
        const sent = index >= 40 && index < 48
        const folder = index < 40 ? 'inbox' : sent ? 'sent' : index < 55 ? 'archive' : index < 58 ? 'spam' : index < 61 ? 'trash' : fieldNotes.id
        const timestamp = anchor - index * 5 * 3_600_000 - accountIndex * 2 * 3_600_000
        const bodyText = `${sent ? other.name : profile.name},\n\n${note}\n\nThis is entirely fictional mail in the Superlocal offline workspace.\n\n${sent ? profile.name : other.name}`
        const html = index % 3 === 0 || index === 4
          ? `<html><body><p>${escape(sent ? other.name : profile.name)},</p><p>${escape(note)}</p>${index === 4 ? '<p><img src="cid:study@inline.test" alt="Tiny inline study" width="48" height="48"></p>' : ''}<p><strong>Offline notebook</strong> · fictional correspondence</p><p>${escape(sent ? profile.name : other.name)}</p></body></html>` : ''
        const original = store.receive(scope, {
          from: sent ? self : other, to: sent ? other : self,
          ...(index % 11 === 0 ? { cc: [people[(index + 2) % people.length]!] } : {}),
          ...(index === 9 ? { replyTo: [{ name: 'Book circle desk', email: 'desk@readingroom.test' }] } : {}),
          subject, text: bodyText, html, folder,
          receivedAt: new Date(timestamp).toISOString(), isRead: sent || index % 3 !== 0,
          isStarred: index % 7 === 0, labels: index % 4 === 0 ? [labels[index % labels.length]!.id] : [],
          attachments: seedAttachments(index),
          rfcMessageId: index === 20 ? '<shared-bulletin@letters.test>' : `<${profile.seedKey}-${index}@seed.mock.test>`,
          deliveryRecipients: [profile.email], headers: { 'X-Fictional-Mail': 'Superlocal offline seed' },
        })
        if (index < 8) {
          const reply = store.receive(scope, {
            from: self, to: other, subject: `Re: ${subject}`, text: `Thank you, ${other.name}. That sounds good. I have added a few notes and will bring them along.`,
            folder: 'sent', isRead: true, threadId: original.threadId, inReplyTo: original.rfcMessageId,
            references: [original.rfcMessageId!], rfcMessageId: `<${profile.seedKey}-${index}-reply@seed.mock.test>`,
            receivedAt: new Date(timestamp + 900_000).toISOString(), deliveryRecipients: [profile.email],
          })
          store.receive(scope, {
            from: other, to: self, subject: `Re: ${subject}`, text: 'Perfect — see you there. Merci, and thank you for making time! 🌿',
            html: '<p>Perfect — see you there.</p><p><em>Merci</em>, and thank you for making time! 🌿</p>',
            folder: 'inbox', isRead: false, threadId: original.threadId, inReplyTo: reply.rfcMessageId,
            references: [original.rfcMessageId!, reply.rfcMessageId!], receivedAt: new Date(timestamp + 2_700_000).toISOString(),
            rfcMessageId: `<${profile.seedKey}-${index}-followup@seed.mock.test>`,
          })
        }
      }
    }
  })
}
