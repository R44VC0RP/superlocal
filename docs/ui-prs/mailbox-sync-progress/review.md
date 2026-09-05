# Mailbox sync progress

## Scope and baseline

Show compact, honest mail-sync activity in the right sidebar immediately above its footer. Identify the working source/mailboxes, report actual stages/counts when available, distinguish provider backoff from failure, and stay quiet when idle. No fabricated completion percentage, automatic retry button, provider reconfiguration, or AI processing change.

This is a stacked draft based on PR #12 (`dabfede15fba37bb08c0f55b0359a78d16011d58`), preserving the pending unified Settings/triage work. Production remains PR #11/main `18c78f673e1cc8ca7112f851f3ed6cf797c59c62`, verified healthy before work. PR #12 and its W-latency release decision remain unapproved. This PR grants no approval or deployment of either change.

The original Mac private README edit and two unpublished classifier commits are excluded and preserved. Baseline-only commit `67f23af` and draft PR #13 preceded application edits. Feature commit: `f97ffda`.

## Before and after

| Scenario | Before | After |
| --- | --- | --- |
| Mail workspace, sidebar footer | [Before](before-idle.png) | Idle leaves the existing sidebar unchanged |
| Actual delayed provider sync | [Before active](before-active.png) · [Before recording](before-sync.mp4) | [Active work](after-active.png) · [After recording](after-sync.mp4) |
| Committed batch, further work pending | No sidebar sync status | [20 records saved](after-batch.png) |
| Rate-limit backoff / status transport failure | No sidebar sync status | [Retry eligibility](after-waiting.png) · [Unavailable, last reported state](after-unavailable.png) |
| Open mobile sidebar | Existing collapsed/open sidebar behavior | [Active progress at 390×844](after-mobile.png) |

The matching captures use the retained fictional 160-message/two-source fixture: 1440×1000, DPR 1, 100% zoom, Carbon / Comfortable / Super Sans Normal, optimized builds. Both recordings wrap only the offline mock provider's real `sync` boundary with the same ten-second delay and request one 20-record reset page for the same source. They do not alter status responses or fabricate UI progress. Both actually commit 20 records with further work pending; only the candidate displays that state. Recordings are 1036×720 at 25 fps, not timing evidence. Images and decoded recording frames were inspected.

Baseline assets: `index-DIdeZpiv.js`. Initial captured candidate: `index-DqBuabP5.js` with `index-kKVWxxy0.css`; final: `index-CWPNzOho.js` with the same CSS. Final review restored existing sync/cursor semantics and corrected transient credential-failure wording; captured normal active/batch/wait/unavailable layouts did not change. The final loaded build was separately exercised with an actual in-flight rename and released old syncing response.

No real mail, private account data or credentials are present. The fixture uses loopback authentication, so its footer has the existing Help/Calendar/Settings controls, not the hosted-only Sign out button. The insertion is immediately above that same unchanged footer. No fake Sign out control was inserted.

## Changes

| Before | After |
| --- | --- |
| Sidebar has no persistent mail-sync status | A compact source/mailbox list sits above the unchanged footer, with meaningful activity glyphs, saved-batch record counts, backoff eligibility and failures; successful idle work stays hidden |
| Account metadata exposes only last sync, coverage and problem code | SDK `mailboxSyncStatus` and read-only `POST /v1/mailbox-sync/status` expose owner-checked, effective-source-scoped active lanes and the last successfully committed batch |
| No independent activity transport | A leaf component polls the local SDK every two seconds while its sidebar/document is visible, with one request in flight; errors back off, stale rows are labeled and stop animating |
| Progress could otherwise be confused with completion | No percentage or unknown denominator; counts mean records in the last committed batch, not new/unique mail or cumulative imports; retry times are eligibility, not promises |
| No status-region accommodation for inbox zero | The existing footer can grow upward only when status is present; source content, footer controls, reader and chosen appearance remain intact |

The status read never calls providers, queries message bodies/inventories, emits mail-change events, mutates canonical data or invalidates client read caches. Activity is ephemeral and cannot survive a process restart as a false spinner; persisted failure/backoff state does survive. Paused/detached source selection, owner isolation, connection generation and late completion are fenced. A maximum of 1,000 mailbox IDs is accepted, grouped by source; overlapping views are not summed into invented totals.

Initial scope is **primary inbox synchronization**, including normal automatic initial/reconnect work and mailbox refresh/backfill. Non-inbox native folders and legacy unscoped manual-domain synchronization are not represented. AI jobs and outgoing sends are separate workflows, not silently folded into mail-sync counts. Last-batch details disappear on restart or when the effective source selection no longer matches; ordinary mailbox metadata edits do not cancel sync or discard matching progress. `lastSyncAt` remains the existing source-wide timestamp, not a claim of completed inbox coverage. Very short syncs can finish between polling samples.

## Verification

- Final full API suite: **249 passed, 0 failed, 7,017 assertions**, 32.45 seconds. The unchanged five-second 10,000-thread/33rd-arrival stress case passed at **4,518.37 ms**. Review regressions additionally verify that metadata edits do not cancel/deduplicate differently, legacy unscoped sync is unchanged, local nonadvancing cursors retain their checkpoints, and source-wide retry behavior is preserved.
- Full web suite: **68 passed, 0 failed**, 74.84 seconds. SDK/host type checks, SDK build and optimized web TypeScript/Vite build passed. Only the existing `packages/inbox-sdk/tests/api.test.ts` was extended; no dependencies, new test files or CI were added.
- New SDK regressions hold real provider promises, exercise both lanes, verify committed-versus-unique counts, no event/provider/message-query side effects on reads, client cache preservation, redacted failure handling, rollback cleanup, restart, rate-limit cooldowns and owner/scope/connection fences.
- Browser QA observed actual active sync after 1,071 ms, a committed 20-record batch, SDK recovery from injected offline-provider rate limits/errors, and unavailable status after a failed status read with no stale spinner. A 5.2-second held status response produced exactly one in-flight read. Polling stopped in Settings (zero requests over 4.5 seconds) and resumed on return. An unsent draft retained its identity/text through two polls and a Settings roundtrip, then was discarded; reader URL/expansion survived sync. Reduced motion produced no spinner animation. The open 390×844 sidebar showed progress without overflow; pre-existing mobile mail-row wrapping matched baseline and was not changed.
- Final-build recheck captured a real old **syncing** response, renamed the mailbox while its provider call was pending, and let the actual 20-record sync complete successfully. Releasing the older response did not restore the old spinning state. The temporary name was conditionally restored. This verifies both observational telemetry and the frontend late-response fence in the real app.
- A genuine background-tab visibility transition was not exercised; Settings/sidebar visibility was. Native keyboard-only/forced-colors coverage and live provider reconnection are not claimed.

## Performance

Apple M5 Max / 48 GiB, Bun 1.4.0, Node 24.16.0, Chromium 152, 1440×1000 / DPR 1 / 100%, logging on and optimized builds. Paired fixtures were normalized through real offline PR12 SDK sync/repair into new common seeds, then identically cloned: **10,000 canonical messages / 8,000 threads / 15,000 memberships**, and **50,000 / 40,000 / 75,000**, two sources/three views. Original fixture body bytes and upstream payload hashes were unchanged. AI was off, with no inference calls.

Five samples per case after one excluded navigation warmup; normal cache, no clearing or throttling. Values are **median / p95 / maximum milliseconds**.

| Scenario | PR12 baseline | Candidate |
| --- | ---: | ---: |
| 10k navigation to observed usable rows | 834 / 1350 / 1350 | 844 / 1350 / 1350 |
| 50k navigation to observed usable rows | 2725 / 2751 / 2751 | 2375 / 2721 / 2721 |
| 10k cached open | 14 / 14.5 / 14.5 | 14.3 / 15.2 / 15.2 |
| 50k cached open | 17.2 / 21.1 / 21.1 | 18.2 / 20.8 / 20.8 |
| 10k E | 26.3 / 35.8 / 35.8 | 29.5 / 32.4 / 32.4 |
| 10k W | 35.1 / 35.6 / 35.6 | 19.4 / 31.4 / 31.4 |
| 50k E | 109.3 / 117.6 / 117.6 | 56.7 / 69.3 / 69.3 |
| 50k W | 97.9 / 111.6 / 111.6 | 54.5 / 89.9 / 89.9 |

Accepted cached opens made **zero body requests**. E/W use completed application receipt telemetry plus the application's next-two-frame estimate, not an immediate post-dispatch frame; all 40 paired Undo operations restored the exact reader URL. First body loading and animation timing are not included in cached-open claims. Navigation includes automation observation overhead and two frames, not a standalone browser-paint/Core Web Vitals measurement. No causal speedup is attributed to this widget.

The initial navigation/50k pair used `index-DqBuabP5.js`; final 10k actions used `index-CWPNzOho.js`. The final review revision restored pre-existing sync deduplication/cursor/retry behavior and adjusted one transient-credential label; mail action, cache and navigation paths were unchanged. Final SDK regressions and in-flight metadata/late-response checks cover that revision. Five status reads over 9.256 seconds caused zero body/account/mailbox requests and retained the reader URL. Status state stays in the leaf component rather than publishing a replacement mail model.

### Active sync and arrivals

Final-build measurements ran with **50,002 canonical messages / 75,002 memberships** during three actual SDK sync calls, each waiting at the offline provider boundary for 20 seconds. Every sample independently confirmed `syncing` with an active latest lane before dispatch; all three calls completed HTTP 200.

| Active-sync scenario | Median / p95 / maximum ms |
| --- | ---: |
| Cached open (zero body requests) | 17.8 / 20.1 / 20.1 |
| E | 100.3 / 106.9 / 106.9 |
| W | 110.7 / 140.8 / 140.8 |

All ten concurrent-case Undo operations restored the exact reader URL. The status later settled to idle for both sources, with no problem or retry deadline. Two bounded fictional arrivals were verified in the real SDK cache, each unread, not deleted, not Done/snoozed and in its one expected mailbox membership.

Setup correction retained: the initial 45-second mock hold exceeded the SDK's existing 30-second I/O deadline and correctly returned `NETWORK`; these attempts are excluded from performance claims. The product timeout was not increased. A second arrival was inserted after a corrected sync became visibly active. SDK event timestamps establish that both arrivals committed **before** the recorded action samples, so the table qualifies actions during subsequent active syncs, not exact simultaneous arrival-commit/action latency. The first-arrival/failed-hold evidence was retained rather than overwritten.

## Review gate

Implementation, stated qualification and inspected evidence are complete. Remain draft pending user/designated-reviewer approval. PR12's previously disclosed concurrent W maximum **205.7 ms** against the **150 ms** budget is not erased or waived by these passing samples. Neither PR12 nor PR13 is approved for merge/deployment. No live mail/configuration mutation, paid inference or forced live provider sync was performed.
