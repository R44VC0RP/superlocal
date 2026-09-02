import { createInboxClient } from '../src/client'
import { createGoogleOAuthClient } from '../server/google-client'

const [command, ...args] = process.argv.slice(2)
if (!command || command === '--help') {
  console.info('Usage:\n  bun run connect gmail [connection-id]\n  bun run connect inbound\n  bun run connect list\n  bun run connect candidates <connection-id>\n  bun run connect mailbox <connection-id> <domain-or-address>\n  bun run connect status <oauth-attempt-id>')
  process.exit(0)
}
const token = process.env.INBOX_API_TOKEN
if (!token) throw new Error('INBOX_API_TOKEN is required. Run bun run dev first, then run this command from the project directory.')
const client = createInboxClient({
  baseUrl: process.env.INBOX_URL || `http://localhost:${process.env.PORT || 8788}`,
  headers: { Authorization: `Bearer ${token}` },
})
const google = createGoogleOAuthClient(client)

try {
  if (command === 'gmail') {
    const attempt = await google.startGoogleOAuth(args[0] ? { connectionId: args[0] } : {})
    console.info(`Open this private, one-use link in your browser before ${attempt.expiresAt}:\n${attempt.authorizeUrl}\n\nAfter authorization: bun run connect status ${attempt.id}`)
  } else if (command === 'inbound') {
    const apiKey = process.env.INBOUND_API_KEY
    if (!apiKey) throw new Error('Set INBOUND_API_KEY in your private local environment before connecting Inbound.')
    const connection = await client.createConnection({ providerId: 'inbound', credentials: { apiKey } })
    console.info(JSON.stringify({ connection, candidates: await client.mailboxCandidates(connection.id) }, null, 2))
    console.info(`Select a mailbox with: bun run connect mailbox ${connection.id} <domain-or-address>`)
  } else if (command === 'list') {
    console.info(JSON.stringify({ connections: await client.connections(), mailboxes: await client.mailboxes() }, null, 2))
  } else if (command === 'candidates' && args[0]) {
    console.info(JSON.stringify(await client.mailboxCandidates(args[0]), null, 2))
  } else if (command === 'mailbox' && args[0] && args[1]) {
    const choices = await client.mailboxCandidates(args[0])
    const value = args[1]
    const candidate = choices.find(choice => choice.selector.kind !== 'all' && choice.selector.value === value)
    if (!candidate) throw new Error('No verified candidate matches that domain or address. List the connection candidates first.')
    const mailbox = await client.createMailbox({ sourceId: candidate.sourceId, name: candidate.name, selector: candidate.selector })
    console.info(JSON.stringify(mailbox, null, 2))
    console.info('The configured mailbox is now eligible for background synchronization. No send or mutation test was started.')
  } else if (command === 'status' && args[0]) {
    console.info(JSON.stringify(await google.googleOAuthAttempt(args[0]), null, 2))
  } else {
    throw new Error('Invalid command. Run bun run connect --help.')
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Connection command failed.')
  process.exitCode = 1
}
