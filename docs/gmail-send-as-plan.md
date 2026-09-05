# Gmail sending aliases

Investigation baseline: upstream `18c78f673e1cc8ca7112f851f3ed6cf797c59c62`.
The deployed image reports `840aa96b1c5d0d13ed76c6347a1d8fd8e7088598`.
The intervening merged change improves inbox startup. Implementation should use
the current upstream baseline and preserve that change. No application code or
live deployment was changed during this investigation.

## Intended behavior

Keep one connected Gmail mailbox and one sync stream. Offer its verified Gmail
"Send mail as" addresses as sender choices, without creating separate mailbox
views, connections, or copies of mail. Gmail remains the authority for aliases;
creating or editing aliases stays in Gmail settings.

## What exists

- `packages/inbox-sdk/server/sdk/gmail.ts`: `getAccount` loads the primary
  profile address only. `send` accepts `input.from` and creates the MIME From
  header before submitting to Gmail.
- `packages/inbox-sdk/src/providers.ts`: Gmail has no discovery registration.
- `packages/inbox-sdk/src/core.ts`: `validateDraft` checks From against the
  primary address and `native.aliases`. Draft submission and queued dispatch
  both validate. Reply-all already excludes stored aliases from recipients.
- `apps/web/src/data.ts`: `Draft` already carries optional `from`.
- `apps/web/src/inbox.ts`: `draftInput` preserves that field, but `newDraft`
  explicitly supplies the mailbox default, and `moveDraft` resets it.
- `apps/web/src/Composer.tsx`: the From selector changes mailbox/account,
  not the sending identity within that mailbox.

Do not simply register Gmail with the current generic `discover` hook.
`core.ts:candidates` maps discovered address/domain sources into receiving views
and skips all-mail selectors. A verified sending alias is not proof of receiving
scope. Separate sending-identity discovery from mailbox-view discovery, or extend
the existing contract explicitly so Gmail retains its whole-mailbox candidate.

## Google contract

[List send-as aliases](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.settings.sendAs/list)
provides the primary address and custom aliases through
`GET /gmail/v1/users/me/settings/sendAs`.

Google currently lists `gmail.modify` among the accepted scopes. The deployed
configuration already requests it, so discovery should not require a new scope
or reconnect solely for this feature. Confirm with a read-only integration check
before treating the existing token grant as proven compatible.

The [SendAs resource](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.settings.sendAs)
describes verification status, display name, primary/default flags, Reply-To,
and optional SMTP routing. Normalize only the fields needed for sending. Do not
return the raw settings response, SMTP configuration, or signatures to clients.
Offer the primary identity and accepted custom aliases; never pending aliases.

## Proposed implementation

1. Add validated provider identity discovery. Persist approved identities against
   the existing source with its owner and connection-generation checks. Populate
   existing installations through explicit refresh without reconnecting accounts
   or clearing their databases. Missing scopes and discovery failures must be
   explicit; they must not grant arbitrary From addresses.
2. Expose an owner-scoped, typed list of sending identities to the web client.
   Keep identity refresh separate from full mail sync. Use bounded refresh and
   freshness rules, including before dispatch, so removed aliases cannot remain
   authorized indefinitely. On a failed refresh, retain draft content and show
   the failure instead of silently sending from another address.
3. Extend the composer to select `draft.from` within the selected mailbox.
   Preserve the choice across saves, reloads, pop-outs, replies and queued sends.
   On account changes, require an identity authorized by the new account.
4. Resolve reply From server-side when the caller has not explicitly chosen it.
   Prefer an unambiguous original recipient matching a verified identity. Retain
   the sender when continuing one's own sent conversation. If forwarding removed
   the original address or multiple aliases match, expose the choice rather than
   inventing delivery evidence. Header matches can select only already-verified
   identities and must never authorize new ones.
5. Leave new-message defaults unchanged initially. Importing Gmail's default
   sender, Reply-To behavior and signatures needs an explicit behavior decision;
   do not silently reinterpret existing mailbox defaults. Document any unsupported
   alias metadata in the first version.

## Verification and rollout

Extend the existing provider/API/web test files, not a new framework. Cover:

- Primary, accepted, pending, removed and malformed identities; discovery failure.
- Existing connections refreshing without losing source IDs or mailbox views.
- No arbitrary sender or cross-owner/cross-account alias acceptance.
- Draft persistence, account switching and queued-send alias revocation.
- Reply, reply-all and own-sent replies; ambiguous and missing recipient evidence.
- No extra inbox copies, full-mailbox scans, or identity requests per render.

Fictional fixtures prove local behavior, not Gmail compatibility. Before release,
use a controlled read-only discovery check and a separately authorized test send
to verify the received From and Reply-To, plus Gmail Sent placement. Do not use
real mail in UI evidence or publish credentials or OAuth responses.

The repository requires a UIPR workflow and fictional before/after evidence for
composer changes. Resolve the available skill/workflow requirements before
implementation. No PR, dependency execution, build, or tests were needed for
this source-only investigation.

No license file was found and GitHub reports no detected license. The public
GitHub fork exists, but publication or redistribution of a modified build should
not assume an open-source license grant. Clarify upstream permission before that
release step. Production remains on its pinned image until separate approval.
