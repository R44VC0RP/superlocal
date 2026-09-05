# Mailbox sync progress

## Scope and baseline

Show compact, honest mail-sync activity in the right sidebar immediately above its footer. Identify the working source/mailboxes, report actual stages/counts when available, distinguish provider backoff from failure, and stay quiet when idle. No fabricated completion percentage, automatic retry button, provider reconfiguration, or AI processing change.

This is a stacked draft based on PR #12 (`dabfede15fba37bb08c0f55b0359a78d16011d58`), preserving the pending unified Settings/triage work. Production remains PR #11/main `18c78f673e1cc8ca7112f851f3ed6cf797c59c62`, verified healthy before work. PR #12 and its W-latency release decision remain unapproved. This PR grants no approval or deployment of either change.

The original Mac private README edit and two unpublished classifier commits are excluded and preserved. This baseline-only commit precedes implementation.

## Before and after

| Scenario | Before | After |
| --- | --- | --- |
| Mail workspace, sidebar footer | [Before](before-idle.png) | Pending implementation |
| Active sync, backoff, failure, recovery | No sidebar sync status | Pending implementation and recording |

The before image was captured and visually inspected from the optimized PR #12 build (`index-DIdeZpiv.js`) with the retained fictional 160-message/two-source fixture: 1440×1000, DPR 1, 100% zoom, Carbon / Comfortable / Super Sans Normal. No real mail, private account data or credentials are present. The fixture uses loopback authentication, so its footer has the existing Help/Calendar/Settings controls, not the hosted-only Sign out button; the intended insertion point is immediately above that same footer. No fake Sign out control was inserted.

## Verification plan

- SDK-owned, owner-scoped normalized sync activity; no host access to SDK tables or provider-specific frontend API.
- Actual active work and durable failure/backoff evidence; late-result, scope-change, disconnect and restart safety. Unknown totals remain indeterminate.
- Isolated UI updates: no progress-driven mail-model rebuilds, body fetches or navigation changes; bounded visible-document polling with one request in flight.
- Existing test files only, optimized build, logging on, comparable paired scale/action checks where affected. Prior action-latency findings remain disclosed, not implicitly waived.
- Inspect matching fictional screenshots and decoded recording frames; verify recovery, stale/unavailable status, reader/draft preservation and narrow layouts.

## Review gate

Implementation, after evidence and verification are pending. Remain draft; user/designated-reviewer approval is required before merge or deployment. No live mail/configuration mutation, paid inference or forced provider sync is authorized by this work.
