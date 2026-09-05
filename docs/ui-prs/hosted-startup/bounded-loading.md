# Bounded inbox loading — draft qualification

The user requested a first window of100–300 conversations across the combined receiving scope, modest automatic older-mail prefetch, bounded browser residency, server-backed deeper history/search/counts and cleanup, and support beyond100,000 aggregated messages. Merely downloading the full inventory in one response is not the final design.

Current intended application baseline: PR20 review `01dd8d07049cc1557accb9957ec3037afe07d58b`, feature `2bc0e42f074a84423f62436c78ba285adcbcf4a8`. Main/production remains `4fe8579a0a0b52cec15bc33a783b264cea78b50c`. This refinement preserves the intended PR20 app, rather than going back to an older public UI.

The [10k current app](10k-after.png), [50k current app](50k-after.png), [10k loading](10k-after-startup.mp4) and [50k loading](50k-after-startup.mp4) were captured and inspected on the same intended source and assets before this refinement. They are the streaming-only baseline here, not the proposed bounded-window result.

## Above100k failure

![150k streaming-only baseline](150k-before.png)

[Inspected baseline recording](150k-before-startup.mp4)

A new entirely fictional paired fixture contains150,000 canonical/upstream messages,90,000 source/thread conversations,225,000 projected memberships, two sources and three receiving views. It includes75,000 messages shared across receiving memberships, plus recent routine content and explicit tasks. All canonical writes came through the real SDK and official mock-provider methods; no inference or fabricated assessments.

The unchanged SDK reproduces `SNAPSHOT_LIMIT` /413. Native startup on the current app shows zero rows and “Couldn't open the inbox · Request body exceeds the size limit” with Retry. That generic displayed wording is recorded as observed, not treated as the root cause. No cap was raised and no data was removed.

Captured1440×1000/DPR1/100%, Dark(Carbon), Comfortable, Superlocal, Super Sans Normal; JS `index--eWWOAiH.js`, CSS `index-Cx__i9xy.css`. Still and decoded recording inspected. Media is fictional and excludes private mail and browser chrome. Recording is fitted to1036×720.

## Required behavior

- First usable view comes from a bounded conversation page, not a full inventory. “Ready to use”, “more pages available”, “totals current” and provider-history completeness remain distinct.
- App-owned view semantics must run over the full authorized backend corpus. Unloaded rows are not absent, ineligible, zero search results or completed cleanup. Unknown totals stay explicitly unknown until established.
- Background prefetch and browser caches stop at finite budgets. Deeper navigation loads bounded pages; reader/drafts/selections/pending commands/Undo remain safe across eviction.
- Complete scoped conversation aggregates and explicit action-context completeness prevent actions against only a partial thread. Captured IDs/revisions still exclude later replies.
- Existing snapshot/page/action/privacy limits remain. Startup must stop depending on a100k whole-inventory snapshot, not increase that snapshot's cap.

The before-evidence checkpoint was published in `0978707` before implementation. Matching final after evidence and full qualification remain pending. No merge, deployment or live inbox mutation is authorized.

## Implementation checkpoint — not approval

SDK commits `5c20e54`, `a98e515` and `263ddcc` add cached conversation/message pages, exact counts, affected-thread deltas, body-free saved sorting lookup and durable reminder receipts. App commit `310b93a` replaces the new-host startup inventory with 100-row pages, automatic prefetch to 300, and a resident ceiling of 1000 conversations/32 MiB. An app-owned derived index supplies full-scope search/counts and frozen selection/cleanup captures through public SDK reads. `cd57bdb` keeps provisional Unknown attention in Important for review, never Other.

Cleanup recovery retains exact command IDs and captured metadata before dispatch, with explicit user Retry after reload. Opaque owner/capture-bound tokens replace content-bearing review strings. Conditional receipt verification, fresh batch provenance, a 500-membership batch limit, captured-query expiry recovery and source/scope fences remain mandatory.

### Completed checks

- Full API run: 309 tests, 109,051 assertions, 45.77s before the final focused host fixes; unchanged arrival watchdog 3375.83ms. After those fixes, all four bounded host groups passed with 217 assertions. This is not a claim that the full suite ran again on the final host source.
- Full web run on `310b93a`: 83 passed, zero failed, 94.153s. SDK/host types and optimized web build passed. Final host-only exclusion fix passed SDK/host types; frontend assets remain `index-DOE1alau.js` and `index-DYO1h_iS.css`.
- A real SDK 150k backend check returned correctly ordered pages of 100/100/100 conversations in 550/173/331ms, with zero body/provider-folder reads. These are individual backend samples, not browser-startup distributions. A diagnostic browser clone ultimately materialized all 90,000 conversations; cold full-index completion time was not qualified.
- Intermediate 150k browser checks confirmed zero startup snapshot requests, two automatic older-page requests, no unscrolled archive drain, bounded rendered rows, off-window search and cached-body reuse. They predate the final recovery fixes and are not final acceptance.

### React Scan diagnostic

The user requested React Scan. Version 0.5.7 was integrity-verified and injected before React on the fictional 150k fixture only. Production scanning was explicitly enabled; render logging and remote requests were disabled/blocked. No dependency or instrumentation is shipped. The tested intermediate assets were `index-BLJjRxJK.js` / `index-DYO1h_iS.css`, at 1440×1000/DPR1/100% with the required appearance.

| Observation | Result |
| --- | --- |
| Idle for 10.0s | 20 App/MailList renders and 20 bounded changes requests; **zero MailRow rerenders**, zero page/body requests, no long tasks |
| Scroll and return | One demanded older page; contiguous rows and restored top identity; one 60ms long task |
| Cached reopen | Same reader/body, zero body requests; no long task in the immediate observation; a 75ms task occurred later |
| Search | Correct known off-window fictional result; no observed long task |
| Type 27 characters | Exact input retained; 55 commits, 27 shell renders, no long tasks; owned diagnostic draft autosaved, survived reload and was discarded with observed 204/404 |

Scan's production render-duration values were unusable zeros. These observations show shell update activity, not proof of zero rendering cost or proof that all interactions meet budgets. First-open observation also contained 63/58ms long tasks; their cause is unresolved. The apparent empty-Drafts loading issue settled to the correct empty view once its query became current. All diagnostic images were inspected but are not matching final after evidence.

### Remaining gates and preserved failure

The first uninstrumented 10k cold navigation reached usable rows plus two animation frames in 898.4ms, with 32 virtualized DOM rows and no Scan. **This is n=1, not acceptance.** The following six-reload series stalled inside Browser Control; later state-only reads also timed out. No E/W/Undo series was started. Partial timing state is not recovered and no median/p95/max is claimed. The exact tab was found unselected; selecting it did not immediately resolve the pending execution. Its cause is not established as an application regression.

Final uninstrumented 10k/50k distributions, final 150k browser/concurrency/eviction/cleanup acceptance, current-build React Scan action follow-up and matching inspected after media are still required. Earlier streaming-only timing misses and release-specific exceptions remain in the existing review; none grants this refinement an exception. PR20 remains draft and undeployed.
