# Provider-agnostic inbox — review

Review base: `356a6a2e41396fa5d33256ea9fce8c08d0742332` (deployed PR21 merge). The user approved this scope after three read-only audits (provider-contract seams, design intuitiveness, over-engineering).

## Scope

Goal: the client UI wraps the inbox-sdk provider contract — add a provider, wire its inputs/outputs, and it works in the UI; good Important/Other classification; fast send/receive from any inbox.

User-visible changes (UIPR):

1. One From menu in compose listing every sendable mailbox and identity; the hidden Mailbox row and the "Unsaved recipient changes" status are removed.
2. Switching folders/splits shows the retained view immediately and replays bounded changes instead of reloading; the loading text is delayed so fast opens show nothing.
3. Split/folder counts show a number only when known, filled by one bounded count pass per view; unknown shows nothing instead of "…".
4. The sidebar sync footer shows only actionable states and genuine first-time import progress; idle/complete sources are quiet.
5. Add Accounts copy and fields come from each provider's descriptor, not hardcoded provider names.

Non-visual changes in the same PR: page-only providers (Inbound) poll newest-first and stop at known mail, backfill once with a durable cursor; arrivals from those providers are tagged as arrivals; one `identities()` provider method replaces three sending-identity mechanisms and one identity refresh per send; dead capability flags and legacy descriptor paths are removed; onboarding derives from provider definitions.

## Before evidence

Captured from the deployed application (`index-CGT2Zduy.js`) on a fictional 10,001-message mock fixture (2 sources, 3 views), Dark/Carbon, Superlocal, Comfortable, Super Sans Normal, 1440×1000, DPR1, optimized build. Media is added in a follow-up commit once inspected.

## After evidence

Pending.
