# Inbox SDK

A headless, multi-account mail API. The v1 core uses Effect for runtime services,
bounded worker concurrency, scheduling, and resource cleanup; SQLite stores mail,
encrypted credentials, drafts, operation intents, and replayable changes. Hono is
the HTTP boundary. The client uses ordinary promises and fetch, not React or Effect.

## Development

Requires Bun 1.4 or newer.

```sh
bun install
bun run dev
```

The launcher generates an independent API token and credential-encryption key in
`.env.local` with mode 0600. The service listens on `127.0.0.1:8788` and uses
`data/inbox-v1.sqlite`. There are no demo users or automatic mailbox connections.
Existing OpenMail data and credentials are not imported.

The standalone host authenticates `Authorization: Bearer <INBOX_API_TOKEN>` as
one configured principal (`INBOX_OWNER_ID`, default `local`). A multi-user host
uses `createInboxApi({ inbox, authenticate })` with its own trusted authentication
function; never accept an owner ID supplied by the client as authentication.
Keep the loopback binding or place the service behind an HTTPS reverse proxy.

See `.env.example` for configuration. The new v1 database is deliberately separate
from the extracted OpenMail database. Remaining legacy server modules and demo
assets are not used by the v1 entry point.

## Authentication And Credentials

Application authentication belongs to the host. `createInboxApi({ authenticate })`
accepts a trusted owner from Better Auth, WorkOS, a custom session system, or an
API gateway. The caller's application token and a connection's provider token/key
are separate credentials. Neither a provider access token nor a client-supplied
owner ID automatically authenticates an Inbox SDK user.

Create a connection with `{ providerId, credentials }`. Credentials are opaque JSON
validated by the provider adapter and stored encrypted per connection; the core
does not implement OAuth consent or require a provider's client ID/secret. A host
can supply only an access token or API key, plus any configuration its adapter needs.

`GET /v1/connections/:id/credentials` returns only credential version, generation,
and connection status. `PUT` at the same path replaces the complete credential
record and requires that metadata response's `If-Match` ETag. The public client
performs the conditional exchange:

```ts
const state = await client.credentialState(connectionId)
await client.updateCredentials(connectionId, {
  accessToken: freshProviderToken,
  expiresAt: expirationTimestamp,
}, state.version)
```

Replacement fences old requests while retaining source/message/mailbox IDs. It
cannot revive a disconnected connection or silently bind another upstream store.
Verified identities and opaque-key stores require a trusted `verifyCredentials`
host callback; returning true asserts that the replacement addresses the same
store. Identity assertions accepted by the in-process connection/reconnect methods
are server-side only and are not accepted in HTTP credential-update bodies.

For background work, an embedded host can provide `resolveCredentials(context)`.
It receives the trusted owner, connection, current opaque record, abort signal,
and reason (`operation`, `expired`, or `rejected`), and returns a complete usable
record for that same connection. Changed records are encrypted and persisted;
cached mail reads do not call the resolver. Alternatively, hosts may register a
provider's generic `refresh` hook or push credentials through the HTTP API.
The refresh hook returns replacement fields merged into the stored record; an
old expiry hint is cleared if the refreshed fields omit a new expiry. Automatic
refresh drains existing requests, while an explicit credential PUT fences them.

OAuth refresh itself stays in the host. `CredentialError('unavailable')` represents
a recoverable host/token-store/configuration problem and does not revoke the grant.
Only explicit `CredentialError('revoked')` marks a connection for reconnection.
Credential responses and errors never expose stored secrets. `expiresAt`, when
supplied, is a valid timestamp hint; keys without an expiration need not include it.

## Connection Pilot

The standalone server defaults to read-only provider access. Mailbox-local done
and snooze still work, but sending, native mail mutations, and native folder
creation require `INBOX_ALLOW_PROVIDER_WRITES=true`. The library also exposes
`allowProviderWrites: false` for embedded hosts. Connecting does not send test mail.

### Gmail

This is an example host integration in `server/google-oauth.ts`,
`server/google-oauth-api.ts`, and `server/credential-refresh.ts`, not part of the
core API or its OpenAPI document. The browser/CLI use `server/google-client.ts`.
Applications may replace this entire flow with their existing OAuth/token store.

Configure a Google OAuth **web application** with `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET` in the private server environment. Register the exact
callback `http://localhost:8788/v1/oauth/google/callback`, or set
`GOOGLE_REDIRECT_URI` to your exact registered public callback. Start the server,
then run:

```sh
bun run connect gmail
```

The command returns a private one-use browser link. It establishes an HttpOnly
callback binding, redirects to Google consent, and exchanges the code on the
server using PKCE, state, nonce, and verified ID-token/UserInfo identity. Browser
callbacks return connection metadata, never OAuth tokens or an application session.
The link expires after ten minutes; do not share it. Status is available through
`bun run connect status <attempt-id>` without revealing the handoff token again.

Run the command again to authorize another Google account. Reauthorizing the same
verified identity preserves its connection, source, messages, and mailbox IDs.
Use `bun run connect gmail <connection-id>` for an explicit reconnect. Google app
credentials stay in server configuration, not in each stored connection. Read-only
deployments request Gmail readonly; enabling writes requires a new consent flow
with the additional scopes. Workspace service-account/delegated access is not
part of this pilot.

An outstanding generic sign-in link cannot revive a disconnected grant or replace
authorization established after that link was created. Disconnected grants need a
fresh explicit reconnect using their connection ID.

### Inbound

Set `INBOUND_API_KEY` in the private local environment, then run:

```sh
bun run connect inbound
bun run connect mailbox <connection-id> <domain-or-address>
bun run connect list
```

The first command validates the key and lists verified mailbox candidates. It does
not configure every domain automatically. Selecting a domain/address enables its
view and background synchronization. Exact-address views require trusted delivery
metadata; missing evidence is reported rather than guessed from To/CC headers.
Sending identities come from provider discovery, not arbitrary form input.

Inbound currently cannot prove that a replacement API key belongs to the same
upstream store. In-place credential replacement is therefore rejected; connect the
new key separately instead of silently rebinding existing cached mail.

### Sources And Views

Credentials are stored once per connection. The existing Account IDs identify mail
sources; mailbox views reference those sources. An additive migration moves old
source credentials into isolated connection records without changing stored IDs.
No sources are merged on matching email addresses or message contents.

`GET /v1/mailbox-messages?mailboxIds=...` returns one canonical source message even
when it matches several selected mailboxes. Each result includes its contextual
memberships. Native read/star/archive affect the shared record. Mailbox-local done
and snooze affect only that membership. Detaching one view does not delete shared
messages, attachments, or sibling connections. It cancels undispatched work bound
to that view rather than choosing another sender automatically.

The original source APIs remain explicit, owner-authorized whole-source access.
They are not narrowed merely because a configured view is narrow. Background
polling and `syncMailbox` use selected receiving scopes where supported. This is
a private-owner pilot, not a team ACL/delegated-folder system; do not treat a view
filter as an authorization grant to another application user.

## Package Boundaries

| Import | Purpose |
| --- | --- |
| `inbox-sdk` | `createInbox`, core contracts, and built-in provider definitions |
| `inbox-sdk/http` | `createInboxApi`, the authenticated HTTP/SSE boundary |
| `inbox-sdk/client` | Framework-independent client, bounded private cache, and SSE consumption |
| `inbox-sdk/providers` | Gmail, Outlook, IMAP/SMTP, and Inbound definitions |
| `inbox-sdk/provider` | Adapter interface, normalized failures, and provider-level types |
| `inbox-sdk/types` | Public v1 resources and operation contracts |

Create independent core instances with explicit storage, provider definitions,
encryption keys, and optional clock/transport dependencies. Importing the package
does not start a server or open a database. Call `start()` to run polling/workers,
`runDue()` or `poll()` for bounded host-driven execution, and `close()` for cleanup.
Caller-supplied Database instances remain caller-owned.

Provider registration accepts arbitrary IDs through one definition containing
identity, descriptors, a factory, and optionally credential refresh. Native
provider cursors and credentials remain below the public API boundary. A provider
definition is trusted server code, not a sandbox for untrusted plugins.

## HTTP Surface

Private core `/v1` routes require host authentication; `/health` is public.
The example host separately mounts Google handoff/callback GET routes, protected
by one-use capabilities and a binding cookie. Its start/status routes remain
owner-authenticated. A core API mounted without that host has no Google routes.

| Resource | Operations |
| --- | --- |
| Providers/accounts | Discovery, connect, inspect, reconnect, disconnect, sync, list/create provider folders |
| Connections | Versioned credential replacement, host credential hooks, verified candidate discovery |
| Mailboxes | Configured selectors, canonical union queries, per-membership done/snooze, scoped sync |
| Messages/threads | Body-free paginated queries, full message content, paginated conversation members |
| Labels | Local label creation, revision-guarded rename, deletion, and message associations |
| Blobs/drafts | Byte uploads/downloads, incomplete drafts, reply/forward preparation, revision-guarded edits |
| Operations | Durable mutations and draft submissions, status, pre-dispatch cancellation, rescheduling, guarded undo |
| Policy/changes | Image privacy, undo-send delay, resumable changes, SSE events, and OpenAPI |

Use `/v1/openapi.json` for request details. Mutations and submissions use an
`Idempotency-Key`; draft/label conditional updates use their current `ETag` in
`If-Match`. Messages use stable SDK IDs, not native provider IDs. Local labels
and local drafts do not imply native synchronization with another mail client.

The TypeScript client mirrors these operations without an owner parameter:

```ts
import { createInboxClient } from 'inbox-sdk/client'

const client = createInboxClient({
  baseUrl: 'http://127.0.0.1:8788',
  headers: { Authorization: `Bearer ${process.env.INBOX_API_TOKEN}` },
  cacheScope: 'local',
})

const accounts = await client.accounts()
const page = await client.messages({ accountId: accounts[0]?.id, limit: 50 })
```

Browser applications must use an appropriate authenticated host/proxy and exact
allowed origins; never put a shared deployment token in a public frontend bundle.
Cache scope identifies the client principal, not an authorization mechanism.

## Events And Consistency

`GET /v1/events` is an authenticated SSE stream. A new subscription gets a `ready`
event with a current state token. Resume with `Last-Event-ID` or `since`. Retained
changes replay after reconnection; expired history emits `reset.required` with a
fresh state. `/v1/changes` exposes the same durable journal without streaming.

Events contain resource IDs and change metadata, not bodies or provider secrets.
Connection, mailbox, and membership changes use separate event types and optional
`mailboxId` context. Adding another membership is not another mail arrival.
Changes are committed before subscribers are notified. `reason` distinguishes
initial import/backfill from newly observed arrivals and local mutations. Clients
invalidate affected cached queries and fetch authoritative data. Desktop
notification permission and presentation belong to the application.

The SDK currently discovers provider changes by polling, every 15 seconds by
default. SSE does not make provider detection instantaneous. Provider webhooks,
native push, Web Push to closed browsers, and a plugin framework are separate
future capabilities.

Operation acceptance is durable, not a delivery guarantee. Workers claim with
expiring fenced leases. Sends whose external acceptance is unknown become
`uncertain`; they are not automatically resent. Cancellation only succeeds before
dispatch. A successful send means provider acceptance, not recipient delivery.

## The Two Contracts

There are exactly two test files:

1. `tests/provider.test.ts`: fixed adapter qualification, controlled upstream
   failures, and explicitly opted-in live mailbox checks.
2. `tests/api.test.ts`: functional API/client, isolation, persistence, worker,
   cache, and SSE acceptance scenarios against controlled providers.

```sh
bun run typecheck
bun run build
bun test tests/provider.test.ts tests/api.test.ts
```

These are TDD product contracts. Missing functionality stays an ordinary failing
test, not a skipped test or a weakened expectation. Passing offline cases does not
certify an adapter's live operation. Required live or second-account checks that
were not executed mean qualification is incomplete.

Live qualification requires explicit `INBOX_TEST_LIVE=true`, a provider ID (or
candidate definition module), and test credentials. Sender/recipient default to
the test mailbox where supported. Use dedicated mailboxes: a live run sends mail
and changes only its tracked test-created resources. Two-account qualification
requires a second controlled mailbox. Do not point these checks at arbitrary
recipients or production mailboxes expecting them to be mutation-free.

The behavior assertions are the contract. New provider setup may connect a
candidate to the existing exam; it may not change passing criteria or downgrade
required capabilities to hide failures.
