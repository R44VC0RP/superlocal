# Unified inbox decisions

## Defaults chosen

- Unified inbox is the default mail view. It includes every added mailbox,
  including mailboxes added later, unless the user chooses a custom selection.
- Provider connections hold authorization; mailboxes are the domain/address/all
  views exposed by those connections. Discovering a domain does not silently
  add it, start an import, or grant access beyond the authenticated owner.
- Individual mailbox shortcuts use an ordered set of up to nine pins. New
  mailboxes do not displace existing pins. Unified inbox has a separate entry.
  Ctrl+0 opens Unified inbox without displacing Ctrl+1–9.
- Unified inbox and pin configuration is stored per owner in the application's private runtime, not
  provider labels, deployment secrets, or browser-only preferences. Existing
  custom splits, appearance settings, and saved mail/drafts remain intact.
- A custom selection with no mailboxes is intentionally empty. Pins and unified
  inclusion are independent: an excluded mailbox can still be opened directly.

## Mail and action semantics

- The same canonical message delivered to overlapping mailbox views appears
  once in Unified inbox. Conversations are grouped within a source; matching
  subjects or RFC Message-ID values do not merge different provider accounts.
- Read/star/folder actions use the original source records. Done and snooze
  remain local mailbox state; a unified action applies to the included
  memberships represented by that conversation, not excluded mailboxes.
- Reply and attachment actions keep exact original message/source identifiers.
  Unified inbox is never passed to a provider as a real account or sender.
- Opening a specific mailbox bookmark keeps that scope. Defaulting to Unified
  inbox must not silently replace a bookmarked conversation or an open draft.
- Changing configuration or switching inbox scopes does not relabel, move,
  mark read, or send upstream. Opening a conversation continues to honor the
  existing mark-as-read preference.

Local comments and invitation responses retain the underlying mailbox/thread
storage keys, rather than being copied to a new virtual-account key. An opened
conversation keeps its initial mailbox metadata context while it remains open;
independently consolidating annotations is deferred.

## Scale boundaries

- Preferences support up to 5,000 selected mailbox IDs, with nine independent
  pins. Cached message reads use the SDK's existing maximum of 50 mailbox IDs
  per request, with pagination and canonical deduplication across batches.
- Inbound accepts up to 5,000 raw selectors and 1,000 effective receiving
  streams. Every selector must be authorized; domain-covered address streams
  are eliminated only after that validation. Source head requests are bounded
  to four workers, not launched all at once.
- Inbound retains its 10,000-record, 8 MiB metadata, four-snapshot, 15-minute
  cursor, and 200-enumeration-request budgets. Exceeding a budget fails
  explicitly instead of returning a silently incomplete history.
- Existing Inbound pacing remains 110 ms per request. A 1,000-source initial
  head scan therefore has a roughly 110-second pacing floor before additional
  discovery/network/enumeration work. Mock and fixture test timings are not
  production-provider latency measurements.

## Questions for later review

1. Should an explicitly configured connection automatically add newly discovered
   domains? Default: no; newly added mailboxes join Unified inbox automatically,
   but discovery and attachment remain separate decisions.
2. Should some users prefer separate work/personal unified groups? Default:
   one Unified inbox with an optional custom mailbox selection; no new grouping
   hierarchy in this first implementation.
3. Should pins use permanently fixed shortcut slots after a mailbox is removed?
   Default: an ordered pin list; intentional reorder/removal updates the slots.
4. Should there be an independent default sending mailbox for Unified inbox?
   Default: preserve a valid real sending context and make the From identity
   explicit; never infer a new identity from a provider's broad domain access.
5. How should long first imports and bounded-history failures be presented?
   Default: show creation and per-source initial-sync progress, retain confirmed
   additions on failure, and keep cached mail available. More granular import
   progress and dedicated SDK thread/count paging for very large caches remain
   follow-up work; the current synchronized cache is not a completeness claim.

This file records product choices for review. It contains no account identifiers,
mail content, credentials, or deployment-specific configuration.
