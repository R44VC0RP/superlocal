# Superlocal

Desktop-focused email, backed by a provider-agnostic Inbox SDK. Bring your mailboxes into one unified inbox while keeping their identities, credentials, and provider capabilities separate.

![Unified inbox showing the included fictional mailboxes](docs/screenshots/unified-inbox.png)

## Run locally

Requires **Bun 1.4+**.

1. Install dependencies:
   ```sh
   bun --no-env-file install
   ```
2. Start the app:
   ```sh
    bun --no-env-file run start
   ```
3. Open **http://localhost:5178**.

The first run starts two fictional mailboxes through the real Inbox SDK. No provider credentials, OAuth setup, OpenCan, or machine-specific services are needed. **Ctrl-C stops both the client and local host.**

`start` builds and serves the optimized client locally. Use `bun --no-env-file run dev` for hot-reloading development; development-mode React diagnostics add overhead on large mailboxes. Both commands keep the same local-only host, sessions, and provider configuration.

## One inbox, separate mailboxes

- **Unified by default.** Every added mailbox joins the unified view. Choose a smaller selection in **Settings → Mailboxes** when you want one.
- **Keyboard-first navigation.** **Ctrl+0** opens Unified inbox; **Ctrl+1–9** open your ordered pinned mailboxes.
- **Many mailboxes, one view.** Search and bulk-select provider mailboxes instead of creating hundreds of permanent tabs. Adding views triggers one initial sync per source, not one per domain.
- **Source-aware actions.** Overlapping views share one canonical message. Replies retain the correct sender; Done and snooze remain local mailbox workflows rather than upstream labels.
- **Isolated email rendering.** Received HTML stays in a script-disabled iframe. The SDK sanitizes content and serves eligible remote media through authenticated routes; image settings and known-tracker blocking remain authoritative.

<details>
<summary>See the reader and mailbox settings</summary>

### Reading a conversation

![A conversation from the fictional mock inbox](docs/screenshots/conversation.png)

### Choosing mailboxes and shortcuts

![Per-user unified inbox selection and pinned mailbox shortcuts](docs/screenshots/mailbox-settings.png)

</details>

The screenshots use only the included fictional mock data, at a slightly enlarged viewing scale.

## Providers and roadmap

The goal is **ready-to-connect providers out of the box**: choose a service, complete its authorization, and select mailboxes in the same UI. You will still need the provider account, required permissions, and any domain/DNS setup that service requires.

| Provider | Current state | Direction |
| --- | --- | --- |
| Mock mailboxes | Included and offline | Keep the full app usable immediately, without personal credentials. |
| Gmail | Implemented; host OAuth client configuration required | Make authorization, reconnects, and multi-account setup simpler. |
| [Inbound.new](https://inbound.new) | Implemented; API-key onboarding and domain/address views | Improve large-domain onboarding, import progress, and recovery within the provider's sync limits. |
| iCloud / IMAP | In progress | Email + app-specific-password setup for iCloud, secure IMAP/SMTP presets, and end-to-end provider qualification. |
| [Resend](https://resend.com/docs/dashboard/receiving/introduction) | Planned | Add a sending/receiving adapter using received-email APIs, attachment retrieval, and verified webhook ingestion. |
| [Cloudflare Email Service](https://developers.cloudflare.com/email-service/) | Planned | Bridge Email Routing / Email Workers into durable SDK mail storage, and integrate supported sending APIs or SMTP. |

Resend and Cloudflare support email workflows, but that does not automatically give them traditional IMAP folders or native read flags. Their adapters should expose real capabilities while the SDK supplies reusable local workflows.

### What we are working toward

1. **Less setup outside the app.** Provider presets, guided authorization, connection checks, and useful reconnect errors instead of routine configuration-file editing.
2. **More interchangeable providers.** Finish IMAP/iCloud support, then add Resend and Cloudflare without introducing separate frontend mail APIs.
3. **Better large-inbox progress.** Keep cached mail usable while imports run, show meaningful progress and partial failures, and extend paging as mailbox collections grow.
4. **Personalized Important / Other.** Add optional per-user learning from explicit corrections, with reversible feedback and conservative handling of uncertain mail.

For current unified-inbox decisions, import limits, and open product questions, see [unified-inbox-decisions.md](unified-inbox-decisions.md). Apple's separate OAuth opportunity is recorded in [apple-provider.ind](apple-provider.ind).

## Architecture

```text
Client → Inbox SDK APIs → provider adapters
```

| Package | Responsibility |
| --- | --- |
| `apps/web` | React client: inbox views, reading, composing, and settings. |
| `apps/local-host` | Application sessions, provider onboarding, runtime paths, and connection policy. |
| `packages/inbox-sdk` | Normalized mail contracts, SQLite storage, encrypted credentials, queries, jobs, drafts, events, and provider translation. |
| `apps/mock-api` | A fictional upstream and real `InboxProvider` implementation, not a fake SDK HTTP layer. |

The SDK currently runs on Bun and SQLite. The included host is local-only; public deployment authentication and team access controls are not implemented.

## Connect real providers

The current Gmail and Inbound connectors use the local host configuration:

1. Stop the app and open the generated, git-ignored `superlocal.local.json`.
2. Set `mode` to `real` and enable `providers.gmail.enabled` and/or `providers.inbound.enabled`.
3. For Gmail, configure the host's Google OAuth web client. Register **`http://localhost:5178/v1/oauth/google/callback`** for the default local setup. Google does not accept `.local` redirect domains; use the configured localhost origin for local authorization.
4. Restart the app and open **Settings → Add Accounts**. Inbound takes an API key, then offers discovered mailboxes. Gmail uses the host-managed OAuth flow.
5. Use **Settings → Mailboxes** to choose unified inclusion and pinned shortcuts.

Provider credentials are submitted to the host, encrypted per connection by the SDK, and not returned by the mail APIs. Mock and real modes stay separate. The Gmail OAuth defaults reference `SUPERLOCAL_GOOGLE_CLIENT_ID` and `SUPERLOCAL_GOOGLE_CLIENT_SECRET`; export them explicitly, or configure the corresponding `providers.gmail.oauth` values as private strings or `{ "env": "YOUR_VARIABLE_NAME" }` references. No SDK `.env` file or unrelated ambient credentials are imported.

Real connections default to normal mail access (`allowProviderWrites.real: true`). For an optional read-only host, set it to `false`; Gmail can use `https://www.googleapis.com/auth/gmail.readonly` with `openid` and `email` rather than modify/send scopes. Reauthorize old read-only grants before sending or modifying mail. Provider capabilities and OAuth permissions still determine which native actions are available.

<details>
<summary>Runtime storage and advanced local configuration</summary>

Keep the generated `instanceId` with its data. Runtime databases, encryption keys, and session keys live **outside the checkout**:

| Platform | Default location |
| --- | --- |
| macOS | `~/Library/Application Support/superlocal/<instanceId>/` |
| Linux | `$XDG_DATA_HOME/superlocal/<instanceId>/`, defaulting to `~/.local/share` |
| Windows | `%LOCALAPPDATA%/superlocal/<instanceId>/` |

`dataDir` can point to another private directory. Back up the whole instance together: missing or mismatched keys fail closed and are never silently regenerated. Old pilot databases and `.env.local` credentials are not imported automatically.

The launcher serves the client on port **5178** and the SDK host on **8790**. `web.port`, `backend.port`, `web.origin`, and `web.allowedOrigins` control the local addresses. A null `web.origin` uses `http://localhost:<web.port>`. An existing OpenCan setup can expose `https://super.local`; Superlocal does not install or manage OpenCan.

For an isolated run, set `SUPERLOCAL_CONFIG` to a new configuration path and `SUPERLOCAL_DATA_DIR` to a separate private directory. The configuration's parent directory must exist. `SUPERLOCAL_WEB_PORT`, `SUPERLOCAL_API_PORT`, and `SUPERLOCAL_WEB_ORIGIN` override addresses. `bun --no-env-file run dev:host` starts only the backend.

</details>

## Development

From the repository root:

```sh
bun --no-env-file run test:web
INBOX_TEST_LIVE=false bun --no-env-file run test:api
bun --no-env-file run typecheck
bun --no-env-file run build
```

Live-provider qualification is separate from deterministic tests. Never commit credentials, private configuration, runtime databases, real mail, or private diagnostic captures.
