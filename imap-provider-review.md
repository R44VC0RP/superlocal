# IMAP / iCloud provider review

Qualification window: September 2–3, 2026. Protocol/API qualification and scoped desktop browser acceptance are complete for the subset below. This is not a claim that every IMAP server, extension, encoding, or Apple identity is supported.

## Capability and qualification matrix

**D** = deterministic native-peer / SDK tests; **R** = authorized live reads; **W** = authorized writes to newly created QA mail only; **S** = server-dependent or explicitly unsupported; **N** = not exercised. Live checks used one iCloud account, not a second live account.

| Method / product behavior | Evidence | Boundary |
| --- | --- | --- |
| Host email + app-specific-password connection | D, R | Actual authenticated host onboarding, then SDK connection/credential encryption. No browser mail-password persistence or raw SDK credential-write bypass. |
| Host reconnect / credential replacement | D, R | Same authenticated mailbox, preset, and usernames; source identity and preferences retained. Revoked-password stopping is D, not deliberate live Apple revocation. |
| `getAccount` | D, R | IMAP and configured SMTP authentication; normal certificate/hostname verification. Receive-only configurations remain possible. |
| `listFolders` | D, R | Selectable paths, Unicode names, custom roles and special-use discovery. `Noselect` containers are not treated as mailboxes. No native folder deletion/rename API. |
| `createFolder` | D, W | One uniquely named Unicode QA folder was created and retained. ACL/quota failures remain upstream errors. |
| `listMessages` | D, R | Mailbox-scoped search and account/query/UIDVALIDITY-bound continuations; at most 25 hydrated messages per page. Native pagination is UID-based, not a guarantee of globally sorted historical internal dates. |
| `listThreads`, `getThread` | D, R | RFC References/In-Reply-To grouping; a complete test conversation was read across mailboxes. Not native server threading. Direct thread listing rejects more than 10,000 matching messages; thread hydration rejects more than 1,000 messages. The SDK serves indexed cached thread pages. |
| `sync` initial and backfill pages | D, R | Bounded bodies, stable snapshot watermark and explicit completion. The live account was only partially imported; no full historical body import was performed. |
| `sync` new arrivals / flags | D, W | Real SMTP arrival and separately changed test-owned flags reached SDK reads. Incremental continuations retain the original MODSEQ/watermark until complete. |
| `sync` deletion / UIDVALIDITY / reconnect | D; reconnect R | SDK supplies known native IDs for durable reconciliation. Vanished mailbox instances are hidden without inventing Archive membership or claiming global deletion. UIDVALIDITY replacement and external deletion are D, not destructive live tests. |
| Read/unread, flag/unflag | D, W | Native flags checked on test mail. Reads use EXAMINE/BODY.PEEK semantics; unsupported/read-only mailbox flags fail explicitly. |
| Custom folder / Archive / Trash moves | D, W, S | Requires UIDPLUS/COPYUID evidence. iCloud lacked MOVE: five moves used COPY + targeted UID EXPUNGE, retaining the destination copy and canonical SDK identity. No mailbox-wide expunge fallback. |
| Move identity / concurrent sync echo | D, W | Native IDs include account + mailbox + UIDVALIDITY + UID. SDK preserves the original public ID from an authoritative mutation receipt, including a concurrently imported destination echo. RFC Message-ID/subject matching is not used to guess a move destination. |
| Permanent deletion | D, S; live N | Advertised only with safe per-UID removal support. No standalone permanent-delete operation or folder deletion was performed live. |
| Keyword labels | Unsupported | Native `labels` remains false. SDK local labels are independent and remain available. |
| `getMessage` MIME/body | D, R | Plain/HTML alternatives, explicit empty plain text, decoded charsets, RFC headers, Reply-To, references, recipients, dates. Unknown/invalid decoding fails instead of silently substituting UTF-8. Encrypted MIME/Apple proprietary content is not decrypted. |
| `getAttachment` / SDK authenticated blobs | D, R | Exact binary and zero-byte data, Unicode filenames, and real inline CIDs. Ordinary attachments are lazy. Initial IMAP sizes are encoded MIME octet sizes; explicit downloads return actual decoded sizes. |
| HTML presentation / media | D, R | Four test-message frames were checked in the browser: authenticated CID images loaded and no scripts were present. Existing central sanitization and isolation remain; no mail HTML enters the application DOM. |
| `send` / exact-parent reply | D, W | SMTP envelope/To/CC/BCC separation, primary From identity, exact parent/references, multipart Unicode content, binary/empty/inline attachments. Other From aliases are rejected unless separately implemented/qualified. |
| Exactly one Sent copy | D, W, S | iCloud did not save the initial SMTP probe in Sent on repeated reads over ten minutes later. The iCloud host preset therefore appends once after acceptance. The qualified reply produced one native Sent copy and one canonical SDK Sent record. |
| Uncertain send / partial result | D | SDK idempotency prevents repeat dispatch; ambiguous network outcomes are not retried as sends. Accepted SMTP with unconfirmed APPEND is a partial result, not a resend. No deliberate live mid-DATA fault injection. |
| Local drafts/autosave/restart | D, W (SDK-local) | A reply draft was edited, recovered after isolated host restart, and submitted. Native `drafts` remains false; existing upstream Drafts were not edited/imported. |
| Schedule/cancel / send Undo | D, W (SDK-local) | Future scheduling and hold-window Undo were cancelled before dispatch. Native `scheduledSend` remains false; SDK scheduled-send/undo features remain true. |
| Local Done / snooze | D, W (SDK-local) | Zero upstream writes, retained through moves/undo, then cleared on the QA message. Not IMAP flags or folders. |
| Unified selection, pins and source ownership | D, R | Saved selected-empty policy survived connection creation; all-mode/pins survived reconnect. Browser checks confirmed intentionally empty Unified inbox, access through the individual pin, and restoration of preferences without changing source identity. |
| Desktop onboarding / exact-parent reply / recovery | D, R; SDK-local writes | Connection/reconnect fields and password clearing were exercised with an intercepted rejection, not another live login attempt. A probe-targeted draft retained its source, mailbox, From and saved text after reload, then was discarded. Reader and account controls were checked at 1440×1000 and 1200×1000. No extra mail was sent. |
| `disconnect` / cancellation | D, R | Pending connection rejection, locks, SMTP sockets/transports and credential-generation fencing. Disconnect uses transport close, never IMAP CLOSE. |
| IDLE / Apple push / native scheduling | Unsupported | Server advertisement is not implementation. SDK polling remains the delivery mechanism; `pushNotifications`, `nativeThreads`, native drafts and native scheduling are false. |

## Failures reproduced and corrected

The original focused suite had **70 passes and 6 failures**: missing RFC/custom headers and reply references, and conversations split across message pagination. The suite was not made green by disabling those methods.

Live checks also exposed two iCloud-specific fidelity problems: zero-octet MIME parts return no downloadable literal stream, and ENVELOPE can omit In-Reply-To even when the original header is present. Empty parts now use the fetched BODYSTRUCTURE's authoritative zero length; reply metadata uses the original header.

A whole-mailbox modification scan took about 12 seconds before body hydration and a subsequent SDK poll hit its request deadline. Incremental flag fetches now target only stored UIDs plus actual new arrivals, not all historical messages. Only actually enabled CONDSTORE (and a mailbox without NOMODSEQ) enables modification queries. Otherwise, comparing confirmed flags avoids re-downloading unchanged immutable message bodies. List/sync hydration is capped at 25 messages. A partially completed delta may require another poll before arrivals beyond its pinned watermark are returned; tests cover this explicitly. Delivery was reconciled without resending the accepted message.

Integration also caught a fresh-mock regression: injecting cancellation and sync hints into credential/operation objects violated the mock provider's strict validation. Runtime hints now travel in separate optional factory/sync context arguments. Existing provider inputs and mock guards remain unchanged. A completely fresh runtime constructed with 160 fictional messages and closed successfully; the original isolated mock also closed and reopened with all 160 messages retained.

The qualified iCloud connection advertised CONDSTORE/QRESYNC but neither was enabled in the observed session. The actual live fallback was therefore exercised, not merely inferred from CAPABILITY. Two final unchanged-mail polls took approximately **0.30–0.38 seconds**, with zero body downloads, while inbox coverage correctly remained partial. A Unicode search in the QA folder also passed. These are observed samples, not a general server-latency guarantee.

## Secure host configuration

Fresh checkouts still default to **offline mock mode**. Enabling real mode exposes iCloud onboarding but does not itself connect an account. An existing real configuration without an `imap` section gets the same enabled iCloud preset; it does not gain credentials or an automatic account import.

The iCloud preset is host-owned:

| Protocol | Endpoint | Policy |
| --- | --- | --- |
| IMAP | `imap.mail.me.com:993` | Implicit TLS, certificate and hostname checks, full mailbox address as the documented alternative username. |
| SMTP | `smtp.mail.me.com:587` | Mandatory STARTTLS/authentication, no opportunistic downgrade, full mailbox address. |

Generic servers are opt-in, trusted local-host presets in `providers.imap.servers`. Each preset declares `id`, `name`, `imap: { host, port, secure }`, optional `smtp: { host, port, secure }`, and an explicitly qualified `sentCopy: "server" | "append"`. `secure: false` means **mandatory STARTTLS**, not plaintext. Browser input selects an approved preset and optional usernames; it cannot supply endpoints, TLS settings, proxies, or credential-bearing URLs. Only public DNS-form names are accepted by configuration validation. The host administrator is responsible for approving the configured upstream; arbitrary browser-entered IMAP hosts/DNS are not supported.

No mail passwords belong in configuration, examples, environment files, URLs or reports. Password bytes are not trimmed/normalized. Host errors contain actionable fixed text, not server AUTH/SMTP responses. The host asserts a stable endpoint/login identity for replacement credentials; unverified generic SDK replacements cannot rebind an account merely by claiming the same email.

## Limits and honest unsupported behavior

- Budgets: 25 messages per list/sync page; 8 MiB per displayed representation; 32 MiB aggregate hydrated body data per batch; 25 MiB decoded attachment/download budget; 128 KiB headers; at most one million UIDs in an inventory. Outgoing data is locally bounded, but server limits may be lower (including Apple's published mail limits).
- Without CONDSTORE, polling revisits known imported UIDs plus new arrivals. SDK callers get durable known-ID reconciliation automatically. Direct adapter consumers must supply `SyncOptions.knownMessageIds` after replacing an adapter instance to reconcile previously imported flags/removals; a cursor alone is not a complete mailbox inventory.
- Missing COPYUID is a **partial operation**, never permission to search for a similar Message-ID and claim continuity. A COPY without mapping is not followed by source removal. Partial writes retain confirmed flags where available, are not blindly retried, and cannot use automatic undo. A pending action aimed at a retired concurrent sync-echo ID may fail and require refreshing the canonical record; the SDK does not guess/replay it against different mail.
- Aliases, custom domains, legacy-address login variants, unknown server extensions, ACL variants, unsupported MIME encodings, S/MIME/PGP decryption, Mail Drop, Apple OAuth and Apple push are not broadly qualified. Native keyword labels remain unsupported. The adapter's virtual Starred listing is Inbox-scoped; the product's indexed Starred query covers cached source messages.
- IMAP SMTP submission has no server-side exactly-once guarantee. SDK idempotency and conservative uncertain-send handling protect retries; external/network ambiguity must remain visible. Generic servers must explicitly choose a qualified Sent policy rather than assuming iCloud behavior.

## Verification evidence

All deterministic commands used `INBOX_TEST_LIVE=false` and Bun's `--no-env-file`. Deliberate iCloud runs were separate, guarded, isolated runtime checks—not the indiscriminate live-provider suite.

| Check | Result |
| --- | --- |
| Focused IMAP native-peer + SDK integration | 97 passing tests; original 6 failures resolved, boundaries added. |
| Combined IMAP/Gmail/Inbound provider selection | 227 passing: IMAP 97, Gmail 56, Inbound 74; 47 unrelated tests filtered, including deferred Outlook scope. |
| SDK/API suite | 146 passing, including host onboarding boundary coverage (baseline 145). |
| SDK typecheck/declaration build; local-host typecheck | Passed. |
| Existing web suite and web build | 45 passing in the integrated checkout, including the separate sender-context additions; production/TypeScript build passed. |
| Scoped browser acceptance | Connection fields/error clearing, safe test-message/CID rendering, exact-parent draft/autosave/reload/discard, empty Unified view and pinned individual access passed. Zero remaining drafts or prohibited write requests. |
| New dependencies / test files | None. SDK tests remain two files; web tests remain four files. |

Commands:

```sh
INBOX_TEST_LIVE=false bun --no-env-file test packages/inbox-sdk/tests/provider.test.ts --test-name-pattern 'imap|IMAP|[Gg]mail|[Ii]nbound'
INBOX_TEST_LIVE=false bun --no-env-file test packages/inbox-sdk/tests/api.test.ts
bun --no-env-file run typecheck
bun --no-env-file run build
bun --no-env-file run typecheck:host
bun --no-env-file run test:web
bun --no-env-file run build:web
```

Live credentials stayed outside the checkout and were read from the authorization handoff only once; later authentication used encrypted SDK connections. All evidence/identifiers, inventories, operation records and comparison details remain private under ignored `data/qa/imap/` with owner-only permissions. No real mail, credentials or protocol traces belong in this document or Git.

The final comparison found no missing pre-existing identifiers, persistent flag changes, size/date changes, or UIDVALIDITY changes; both sampled original-source hashes matched. The transient session-specific `Recent` flag is not a persistent read/unread flag and was excluded from that comparison. Tested runtime versions were Bun 1.4.0, ImapFlow 1.7.6, and Nodemailer 9.0.5; no dependency or lockfile change was needed.

Two clearly labeled self-addressed transmissions and one QA folder are retained for authorized cleanup. The original probe's missing Sent copy was saved once during qualification; the subsequent reply exercised production post-SMTP APPEND. No standalone permanent-delete or folder-delete operation was run. COPY-based moves removed only the test-owned source instances after a destination copy was confirmed. Existing mail was protected by read-only opens/PEEK and pre/post UID/flag/size/date inventories, with source-content hashes for two recent samples; final comparison details are in the private preservation report. Browser acceptance used only those test messages, blocked native changes and submission, and restored its local preferences and mailbox configuration.

## Questions and coordinating-session handoff

1. Decide the default historical-backfill experience before enabling this large account in the main runtime. Qualification and browser acceptance intentionally did not call `host.start()`; they used bounded explicit synchronization or cached reads. The standard SDK background poller can progress backfill. The test account was not automatically imported into the main installation.
2. Approve/qualify each additional generic endpoint preset and its Sent-copy policy before describing it as a supported service. A configurable generic interface is not evidence for every server/identity variant. APPEND without APPENDUID can confirm a saved copy without identifying it: the SDK keeps a non-mutable submission identity until Sent reconciliation, without re-appending or resending. A dedicated pending-identity UI indicator is not implemented.
3. Coordinate eventual Apple-side app-password revocation and retained test-artifact cleanup separately. Local disconnect only closes sessions/removes SDK credentials; it does not revoke an Apple app-specific password. No irreversible live deletion is authorized by this review.
4. Apple OAuth remains deferred. Obtain Apple registration/transport documentation through the official route before implementing it; do not substitute Sign in with Apple, another application's registration, cookies, or the ordinary Apple Account password.
