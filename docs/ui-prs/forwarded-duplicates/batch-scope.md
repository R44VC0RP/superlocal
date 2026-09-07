# Request-batch duplicate compaction

This replaces the original PR design with the user's requested flow: **filter the view, take the requested batch, then compact only that batch**. No original is looked up elsewhere in the mailbox, and no additional page is fetched to replace a compacted row.

## Current behavior

1. Important, Other, folder, mailbox and search filters select the normal response candidates.
2. The existing request limit and byte limits determine the raw batch. The app currently requests 100 conversations and prefetches one more 100-row batch; it does not automatically fill gaps left by compaction.
3. Both the original and copy must occur in that same batch. Strict header/content proof selects the original; uncertain, mixed or incomplete conversations remain visible.
4. The next request is independent. Identical batches can reuse a bounded 32-entry proof cache; database or receiving-scope changes invalidate it. Rendering and cached reader opens do not invoke matching.
5. Counts remain native stored-conversation totals. Counts, explicit lookup, body reads, captures and ingestion do not run duplicate detection. Normal bounded new-head requests may compact their own filtered head batch, never arbitrary resident history.

The old global RFC indexes, forwarding-event table creation, dependency graph and added ingestion-event work have been removed. Existing historical test-clone artifacts are inert; fresh SDK instances create none of them.

The comparison is provider-agnostic and also permits proven same-source forwarding. Native drafts/outbox/pending mail is excluded. The existing 500-message proof cap remains: if complete histories in a response exceed it, the entire response is kept rather than partially comparing arbitrary chunks. This is presentation-only; native records, direct links and action targets remain independent.

A consequence of view-local matching: if the original leaves Inbox after Done, its still-Inbox copy can appear in a subsequent response. Undo restores the original and removes its now-redundant resident copy when both occur in the requested head. A pinned reader is no longer mistaken for an already-visible list row, addressing the observed stale-Undo path. This does not synchronize workflow state across copies.

## Baseline and visible evidence

The branch includes current `main` through `a56173a`, including the latest AI settings, sidebar progress and optional type-label work. Matched captures use the same fictional fixture, 1440×960 viewport, 100% zoom, Carbon/dark appearance and Comfortable density. AI is unconfigured in the mock; its idle progress indicator is hidden.

The fixture has 406 canonical messages, 326 native conversations and 325 Inbox conversations. It includes a pair in the first batch, a pair with an archived original, and a pair whose original falls after the initial 200 raw rows.

| Scenario | Before | After |
| --- | --- | --- |
| Inbox batch | [Before](batch-inbox-before.png) | [After](batch-inbox-after.png) |
| Search containing both copies | [Before](batch-search-before.png) | [After](batch-search-after.png) |
| Mailboxes setting | [Before](batch-settings-before.png) | [After](batch-settings-after.png) |

[Before recording](batch-before.mp4) · [After recording](batch-after.mp4)

Final stills use verified assets: baseline `index-BgrRbzWJ.js`; candidate `index-jirXAW5I.js`; shared CSS `index-BM6XF745.css`. Recordings use the preceding `2ef1614` integration (`index-CzzxcNng.js` / `index-le0_olMp.js`); the later change adds an AI label toggle outside these visible scenarios. Earlier full workflow checks used the same batch backend with `index-DqnWbfjM.js`. Builds and affected stills were refreshed after the upstream changes; captures were inspected.

Browser results:

- In-page pair: one Original Author row. Archived-original and off-page-original cases: forwarded copy remains in Inbox.
- `subject:"Batch scope: off-page"`: both matches now belong to one search response, so one original is shown. Adding `from:noah@atelier.test` to the in-page search retains the forward because the original does not match.
- Exactly one initial query and one automatic page request. Scrolling the existing buffer added none; scrolling farther added one page, with boundary notes 194–200 present exactly once.
- Settings OFF/ON persisted through reload and restored two/one in-page rows. Empty search recovered correctly. Three E/Undo cycles restored the original; no persistent stale-Undo failure occurred.
- The worker initially reported absent count badges after mutations/reload. A later parent read, without another action, confirmed Important 325 / Other 0 and one original. They were pending asynchronous native counts, not permanently lost or numerically deduplicated.

## Bounded work at 6.5k and 50k

Instrumented in-process host-service requests compared baseline and candidate against matching immutable fictional snapshot clones. These are **host-request work timings, not browser navigation, body paint, animation or E/W latency**.

The smaller dataset contains 6,500 messages / 3,331 native conversations; the larger retains 50,003 messages / 25,083 conversations, including the earlier three-message arrival exercise. The original fixtures and running UI fixture were not modified. Runtime: Bun 1.4.0, Apple M5 Max, macOS 27. Source fingerprints remained stable during measurement. The host/SDK baseline was `fb7a21d`. Later upstream work changes AI UI and optional type labeling; it does not change the measured window/SDK implementation, and automatic labeling is off in these fixtures.

Each sample is one query requesting 100 raw rows plus its next-page request for 100. Five samples per revision/size; values below are milliseconds, median / p95 / max (nearest-rank p95 equals max).

| Dataset | Baseline | Candidate |
| --- | ---: | ---: |
| 6,500 | 67.48 / 91.14 / 91.14 | 69.72 / 87.64 / 87.64 |
| 50,003 | 70.38 / 71.95 / 71.95 | 71.11 / 85.09 / 85.09 |

Every baseline pair returned **100 + 100** rows; every candidate pair returned **99 + 100**. Each request fetched exactly 100 native conversations: compaction caused **no refill**. Every ID passed to the resolver matched the independently captured, hide-disabled filtered response batch. Unread filtering and an original at ordinal four outside a three-row response also passed.

The first candidate samples loaded 103/177 proof bodies at 6.5k and 104/175 at 50k, all belonging to the request batches. Each of the four repeated samples loaded **zero proof bodies**. Counts invoked **zero resolver calls**. No request SQL referenced historical global forwarding objects, and fresh candidate SDKs created none.

Raw query-plus-page samples:

```json
{
  "base6500": [91.14,72.12,67.38,67.48,66.50],
  "candidate6500": [87.64,81.07,68.80,67.37,69.72],
  "base50003": [70.86,70.38,71.95,68.46,68.97],
  "candidate50003": [85.09,72.07,66.38,65.70,71.11]
}
```

## Regression verification and limits

- Full API suite: 353 passed. Full web suite: 94 passed. After the final upstream type-label merge, its new lifecycle test, teaching test, five batch-proof tests and host batch regression passed. SDK build/typecheck, host typecheck and final optimized web build passed; the existing bundle-size warning remains.
- After head/Undo refinements, both host-service-backed web cases and all 12 existing bounded-host API cases passed. New assertions cover withheld AI originals, resident-copy removal, pinned-original restoration, real Done/Undo receipts, exact page membership, no refill and reversible per-row bookmarks.
- SDK tests cover batch-only parent lookup, privacy/generation fences, malformed data, collisions/cycles, same-source proof, proof-cache eviction/invalidation and no global forwarding maintenance. Existing unrelated tests were preserved; no new test files or dependencies were introduced.
- No global uniqueness across separately requested batches is promised. Stored totals and bulk capture semantics remain native, not globally compacted totals.
- The old mailbox-wide design's UI timing report is historical. Current batch-design browser measurements are below. They expose remaining performance failures, not a blanket release-budget pass. The PR remains draft; nothing was merged into main or deployed.

## Initial release browser measurements

These measurements precede the subsequent [background-read latency improvements](#background-read-latency-improvements). They remain intact as the before reference.

Matched optimized builds: base `0699537`, candidate `5630b0c` (including the latest Get me to zero change). Served JavaScript was verified as `index-DskQ7YA-.js` / `index-CotLFh1L.js`, with shared `index--Kkdv2hC.css`. Hardware/runtime: Apple M5 Max, macOS 27.0, Bun 1.4.0, Chrome 152.0.0.0, Agent Browser; 1440×960, DPR 1, dark theme, Comfortable density, 36px rows. Timing logs stayed enabled. No builds or full suites ran during timed actions.

Fixtures are SQLite-backed fictional mock mail: **6,500 canonical messages / 3,331 native conversations**, and **50,003 / 25,083**, across two sources. All bodies were already cached in SQLite. Fresh paired clones matched canonical, membership, body-version and workflow digests; obsolete global-forwarding derived objects were removed only from these clones. Initial memberships were not Done or snoozed. Seed identity is the existing fictional `Fictional project update` / `Fictional workshop review scale-pair-*` corpus; canonical row digests were `19ad17c0fd9faeb89154c469304803caae589cd97004714e1e71912af2b224d2` (6,500) and `1cac4562ddb1bbf7df863412bd1f2238ad228849b3cd2d847fdc8b66f7c07324` (50,003). No private mail database was used. Canonical counts are not projected list-row counts: each ordinary first load consumes 100+100 native conversation rows; the candidate compacts the proven pair without refilling.

Each variant received one untimed initial navigation, then five reload → original-row → first-body → Back → cached-body cycles. The host, SQLite/OS caches and initial query projection were warm; **startup here is fresh browser navigation to a usable row, not cold process/bootstrap time**. Browser-clock body measurements include automation overhead and observe visible plaintext, not paint/INP. All first opens issued one body GET; all cached opens issued zero.

Next came five body-ready E/Undo and five body-ready W/Undo cycles, followed by separate five E/Undo and five W/Undo cycles immediately after opening the heading, without waiting for the body. All cold inputs observed the body not yet ready. W is Done + not important, not a move to Other. Undo was clicked immediately in the auto-advanced reader; each cycle checked both the restored original reader and its inbox row before any reload. Final restoration was separately verified after reload. All **80/80 normal action/Undo cycles restored correctly**, with no stale-list recovery reloads.

Values below are **median / p95 / max**, milliseconds; n=5 per cell, nearest-rank p95 equals max. Actions use the existing app handler-to-two-rAF telemetry, not end-to-end paint. Undo is reported separately; the documented 150ms E/W target is not silently redefined as a separate Undo budget.

| Scenario | Base 6,500 | Candidate 6,500 | Base 50,003 | Candidate 50,003 |
| --- | ---: | ---: | ---: | ---: |
| Navigation to usable row | 164.4 / 859.2 / 859.2 | 164.2 / 174.7 / 174.7 | 241.6 / 262.4 / 262.4 | 260.2 / 368.0 / 368.0 |
| First visible body | 281.6 / 385.1 / 385.1 | 385.2 / 392.3 / 392.3 | 883.3 / 910.5 / 910.5 | 883.1 / 890.3 / 890.3 |
| Cached visible body | 69.4 / 77.1 / 77.1 | 79.0 / 82.2 / 82.2 | 65.4 / 73.8 / 73.8 | 67.5 / 78.8 / 78.8 |
| Body-ready E | 54.4 / 76.6 / 76.6 | 50.9 / 68.2 / 68.2 | 38.5 / 131.3 / 131.3 | **49.6 / 186.7 / 186.7** |
| Undo after body-ready E | 105.6 / 152.4 / 152.4 | 129.5 / 152.2 / 152.2 | 137.5 / 530.5 / 530.5 | 47.2 / 538.9 / 538.9 |
| Body-ready W | 52.6 / 58.4 / 58.4 | 55.7 / 60.4 / 60.4 | 42.2 / 52.1 / 52.1 | 49.1 / 53.3 / 53.3 |
| Undo after body-ready W | 140.7 / 159.8 / 159.8 | 114.0 / 163.7 / 163.7 | 45.7 / 45.9 / 45.9 | 46.3 / 96.8 / 96.8 |
| Before-body E | 216.3 / 253.3 / 253.3 | 220.7 / 295.0 / 295.0 | 419.5 / 473.2 / 473.2 | 416.0 / 497.4 / 497.4 |
| Undo after before-body E | 362.2 / 593.7 / 593.7 | 367.6 / 434.9 / 434.9 | 261.8 / 282.7 / 282.7 | 251.5 / 486.3 / 486.3 |
| Before-body W | 235.3 / 545.4 / 545.4 | 223.6 / 230.0 / 230.0 | 424.3 / 551.4 / 551.4 | 413.0 / 427.9 / 427.9 |
| Undo after before-body W | 428.6 / 477.2 / 477.2 | 377.3 / 441.0 / 441.0 | 247.2 / 363.4 / 363.4 | 308.9 / 339.5 / 339.5 |

[All five raw latency samples per series](release-samples.json).

**Acceptance remains failed:** cached opens and measured navigation pass at both sizes, but the candidate's first body-ready E at 50k took **186.7ms** (163.8ms to acceptance), above 150ms. Its other four samples were 41.3–50.8ms; the outlier is retained, not replaced. Every before-body E/W sample exceeded 150ms on both base and candidate. Similar delays on base establish an existing problem in that scenario, but do not explain away the candidate's body-ready outlier or prove its cause. First body at 50k remains about 0.88s; Undo also has substantial outliers on both revisions. No budgets, logging, fixture sizes or correctness checks were weakened.

### Frames and animations

The per-action frame estimate is `durationMs - acceptedMs`: the app's two-rAF estimate, **not paint or INP**. Values are median / p95 / max, n=5:

| Action frame estimate | Base 6,500 | Candidate 6,500 | Base 50,003 | Candidate 50,003 |
| --- | ---: | ---: | ---: | ---: |
| Body-ready E | 14.6 / 23.1 / 23.1 | 13.0 / 28.5 / 28.5 | 24.0 / 29.5 / 29.5 | 22.9 / 27.8 / 27.8 |
| Body-ready W | 20.1 / 25.1 / 25.1 | 12.6 / 22.5 / 22.5 | 23.8 / 25.9 / 25.9 | 24.5 / 25.2 / 25.2 |
| Before-body E | 18.5 / 21.8 / 21.8 | 14.2 / 24.8 / 24.8 | 7.6 / 14.9 / 14.9 | 15.4 / 21.9 / 21.9 |
| Before-body W | 21.9 / 28.6 / 28.6 | 22.0 / 23.7 / 23.7 | 14.7 / 18.1 / 18.1 | 9.5 / 22.8 / 22.8 |

Bounded DOM observations found 254ms and 128ms thread-message animations on both revisions (delay 0, one iteration). The 6.5k base also captured 160ms back-gutter / 150ms back-arrow animations in one Undo window. No 200ms list-exit animation was observed in this reader-auto-advance flow. Action and immediate-Undo windows overlap, so their animations are not exclusively attributed to one action. These animation durations are separate from acceptance latency.

Per-window rAF medians were approximately 16.6–17.4ms. Maximum observed intervals were 83.4ms / 149.9ms at base/candidate 6.5k and 49.7ms / 35.2ms at base/candidate 50k. All per-cycle frame intervals, accepted times and Undo estimates remain in the retained content-free QA records; these observations do not claim sustained FPS or a paint benchmark.

### Capture limitations and preserved failures

The first baseline trial used the preceding `a56173a` build. A bad locator contaminated its first startup/body timing, and an incorrect wait for Inbox after E allowed Undo to expire. The trial was retained; its exact receipt was restored with SDK `undoMailboxStates`, explicitly **cleanup, not measured UI Undo**. Main then advanced to `0699537`; both measured builds were updated and a fresh baseline clone used.

The clean 6.5k base run completed all action cycles, but a QA record-copy mistake lost four visible-body timestamps. Its original five startup samples remain `[187.3,161.9,267.1,180.3,254.4]`; the initial visible-body/cached values remain 399.2/76.3ms and four missing values. A disclosed five-open supplemental capture supplied the complete open-series table above. It did not replace slow application samples. All other variants retained their full planned records without retries or dropped timings.

Current matched inbox stills, captured before supplemental arrivals, use the same fictional fixture and settings. The expected difference is the hidden forwarded row; the original and uncertain mixed-conversation forwards remain visible:

| Dataset | Base `0699537` | Candidate `5630b0c` |
| --- | --- | --- |
| 6,500 | [Before](release-6500-before.png) | [After](release-6500-after.png) |
| 50,003 | [Before](release-50003-before.png) | [After](release-50003-after.png) |

The earlier small-fixture search/Settings media and recordings above retain their labeled revisions; they are not presented as recordings of these latest scale runs.

### Concurrent arrival and final verification

Supplemental arrivals were separate from every tabled timing series. Each used one idempotent fictional upstream receive and the running host's real mailbox sync, not a second SDK or direct canonical-state write.

On the 50k candidate, sync ran at **03:03:47.636–47.722Z**, overlapping UI Undo begun at **47.615Z**. E took 46.9ms; Undo took 212.9ms. The original reader and inbox row restored, and exact-subject Search found the incoming message without a reload. The arrival was dated 00:00Z, behind the visible newest rows; it was not observed in the visible inbox buffer during the bounded wait. This proves concurrent arrival availability and restoration, **not live new-head presentation or a matched concurrency latency comparison**. The arrival was not opened or acted on, and no send was repeated.

A supplemental 6.5k base arrival overlapped E/Undo as confirmed by the host: Done at 02:50:50.823Z, receive at .963Z, Undo at .989Z. Browser Control restarted during the observation and lost in-memory evidence. Read-only receipt verification confirmed Undo had completed and the original was not Done; no cleanup mutation was necessary. Browser visibility/latency from that interrupted attempt is not counted as acceptance evidence. The tooling failure is recorded separately, rather than interpreted as no actions having happened.

After all browser timings, the current integration passed **94 web tests and 354 API tests**, with the host typecheck and both optimized web builds also passing. The combined test command's 120-second wrapper first interrupted API execution after web completed; API alone was then rerun to completion (354 pass, zero fail). This is disclosed as a runner timeout, not an application test failure. The existing bundle-size warning remains. Final refs still matched base `0699537`; no concurrent source edits were swept in. Owned QA services and the browser session were stopped; no listeners remained on 5198/8818. The user's ordinary application was left running.

**This initial gate failed. No main merge or deployment was performed.**

## Background-read latency improvements

The follow-up fixes preserve the action/Undo protocol and address work running beside it:

- Host counts no longer perform a redundant mailbox-wide `mailboxCounts()` scan before their bounded traversal. The first existing conversation page supplies the same snapshot/scope fence, and is consumed within the unchanged five-page budget. Count pages yield to the event loop. Exact totals, incomplete results, clock checks and concurrent-change rejection remain intact.
- The fictional provider's folder listing no longer hydrates every full message on the host thread. It reads only folder/read metadata in yielding 512-row keyset pages, using its existing immutable version history and indexes. Folders and high-water are captured before the first yield; latest-version/tombstone handling and repeated ownership checks preserve one coherent snapshot during arrivals, moves, read changes and deletion. No schema, index, cache, dependency or new test file was added.

This deliberately trades some background folder-list completion time for shorter uninterrupted work. Read-only 25k-message-per-source checks preserved all 10 folder counts: monolithic metadata took about 61–65ms; paged reads took about 137–157ms total, with typical individual pages about 2–4ms and one 18.46ms outlier. These microbenchmarks are diagnostic, not UI acceptance.

The CPU/network traces showed E/W mutation requests dispatched within a few milliseconds rather than waiting on the client body loader. On the original cold path, the full count scan and mock folder hydration occupied the host while body/action HTTP requests waited. No receipt was acknowledged early, no flag dependency removed, and no owner/revision fence weakened.

### Latest 50k result: improved, not release-ready

Before is `a7caebc` (same runtime source as the earlier measured `5630b0c`); after is the source in this follow-up, identified by the hashes in [the raw samples](latency-samples.json). Fresh clones exactly matched the earlier initial canonical/native/membership/body-version/workflow digests: **50,003 messages / 25,083 conversations**, all bodies cached. Hardware, runtime, UI asset `index-CotLFh1L.js`, 1440×960/DPR 1, dark/Comfortable settings and logging were unchanged. CPU profiling was off and no builds or tests ran during the final measurement. One untimed warm navigation preceded the same 25 planned samples.

Values are **median / p95 / max**, milliseconds; five samples per series, nearest-rank p95.

| Scenario | Before | After |
| --- | ---: | ---: |
| Navigation to usable row | 260.2 / 368.0 / 368.0 | 162.7 / 351.7 / 351.7 |
| First visible body | 883.1 / 890.3 / 890.3 | 144.2 / 163.3 / 163.3 |
| Cached visible body | 67.5 / 78.8 / 78.8 | 63.1 / 68.5 / 68.5 |
| Body-ready E | 49.6 / 186.7 / 186.7 | 52.1 / 68.8 / 68.8 |
| Body-ready W | 49.1 / 53.3 / 53.3 | 50.2 / 53.7 / 53.7 |
| No-body-wait E | 416.0 / 497.4 / 497.4 | **94.3 / 197.8 / 197.8** |
| No-body-wait W | 413.0 / 427.9 / 427.9 | 78.1 / 79.0 / 79.0 |
| Undo after body-ready E | 47.2 / 538.9 / 538.9 | 47.5 / 230.6 / 230.6 |
| Undo after body-ready W | 46.3 / 96.8 / 96.8 | 45.6 / 47.7 / 47.7 |
| Undo after no-body-wait E | 251.5 / 486.3 / 486.3 | 178.6 / 212.5 / 212.5 |
| Undo after no-body-wait W | 308.9 / 339.5 / 339.5 | 158.3 / 197.3 / 197.3 |

All 20 action/Undo cycles restored the original reader and inbox row; final persistence survived reload. First opens made one body GET each, cached opens zero. The first planned cold E happened to be body-ready before input without a body wait; it is explicitly recorded and was not replaced. The other nine no-body-wait inputs had no body ready.

The remaining failure is cold E4: **197.8ms**, including 187.5ms to acceptance, against the unchanged 150ms target. Its mutation request took 173ms; a concurrent sync-status request took 118ms and an inbox page 230ms. The hypothesis that counts/folder listing explained every outlier was incomplete. Periodic SDK/background work remains a suspect, not a proven cause of this final miss. After three implementation attempts, further code changes stopped rather than selectively rerunning or waiving the failure.

Frames remain separate from acceptance: latest action frame-estimate medians/p95/max were E warm 20.6/23.1/23.1ms, W warm 22.9/26.4/26.4ms, E no-body-wait 14.1/22.4/22.4ms and W no-body-wait 14.7/19.8/19.8ms. Observed rAF intervals were 16.7/33.3/35.3ms; the same 254ms/128ms thread animations remained. These are not paint/INP measurements.

[Matched before still](release-50003-after.png) · [Inspected latest after still](latency-50003-after.png). No visible layout or mail-content change is expected beyond the existing duplicate behavior. New interaction recordings, the latest-code 6.5k rerun and latest-code live-arrival acceptance remain incomplete; old media is not relabeled as that evidence.

Intermediate failures were also retained: count yielding alone left cold E up to 161.6ms and W up to 319ms in diagnostics; monolithic metadata projection plus count yielding left cold E at 161.5/231.6ms in its fresh full-size trial. Profiling-on runs and those intermediate results are not used as a final pass. The final paged-folder run retained every planned sample.

Existing API regressions now verify count scheduling with real Done/Undo receipts, no preliminary inventory count, exact/empty/cached totals, stale-count rejection, and folder snapshot consistency while 1,100 fictional messages undergo concurrent changes. Targeted tests and host/mock typechecks passed. With the final source frozen and browser timings complete, the full suites passed: **94 web tests and 354 API tests** (111,053 API assertions). Owned QA services and the browser session were stopped; the user's normal app remained untouched.

**This checkpoint remained draft and unmerged; it did not complete all release gates.**

## Sync and secondary-work optimization

Following the Fable review, `bcb4d1d` applies three narrow changes against current-app base `5a2e72c` (including main `d197878`):

1. Gmail and the mock provider explicitly opt out of unused known-message sync inventories. Other provider definitions retain the original eager arrays and snapshot timing by default. IMAP/Inbound hints are not deleted or evaluated lazily after a concurrent write.
2. Optional sender statistics wait for actions already queued when the reader settles, then recheck cancellation and scope before dispatch. Existing action receipts, W flag dependencies and ownership/revision fences remain unchanged.
3. Projected rows reuse their unchanged encoded byte size, recalculating after each trimming mutation. Byte limits and incomplete/oversized-row handling are unchanged.

Automatic prefetch, count traversal, head refreshes and the strict duplicate proof were not removed. There are no new queues, timers, caches, dependencies, migrations or test files in this follow-up.

### Confirmed work reduction

Five real two-source quiet-sync request pairs per variant, with zero changed messages and no remaining page. These are **sync HTTP timings, not Done or navigation latency**. Values are median / p95 / max in milliseconds:

| Canonical messages | Before | After |
| --- | ---: | ---: |
| 6,500 | 25.65 / 43.98 / 43.98 | 1.36 / 10.81 / 10.81 |
| 50,003 | 110.69 / 120.56 / 120.56 | 1.25 / 12.98 / 12.98 |

The SDK regression additionally observes eight inventory queries for default/enabled hints versus **zero** for opted-out hints, while retaining arrivals, flags, deletion and the original hint snapshot across delayed provider access. Tests cover the real Gmail/mock definitions and conservative defaults for other providers. Sender tests hold Done acknowledgement, including failure and cancellation; statistics cannot dispatch ahead of that action.

### Matched browser verification

Fresh paired clones again matched the recorded initial canonical/native/membership/body-version/workflow digests: 6,500/3,331 and 50,003/25,083 messages/conversations. Same Apple M5 Max, macOS 27.0, Bun 1.4.0, Chrome 152, 1440×960/DPR 1, dark/Comfortable settings and logging. Base asset: `index-BEuUtuY0.js`; final head: `index-T48BoRxP.js`; CSS unchanged. CPU profiling, builds and test suites were off during timing. Five quiet-sync pairs and one warm navigation preceded each variant's unchanged 25-sample protocol.

[All raw latency samples](sync-optimization-samples.json). Values below are median / p95 / max, n=5 per cell. The first three rows retain the original **pre-automation-command to DOM** clock. Extra trusted-click instrumentation was added without replacing those measurements: its bounded passive listener records the actual click's `timeStamp`, `timeOrigin` and `isTrusted`, avoiding time spent waiting for Playwright to dispatch. Before-50k did not record that extra timestamp, so its gesture value is unavailable—not inferred from app telemetry.

| Scenario | Before 6,500 | After 6,500 | Before 50,003 | After 50,003 |
| --- | ---: | ---: | ---: | ---: |
| Navigation to usable row | 161.4 / 255.3 / 255.3 | 162.0 / 264.8 / 264.8 | 163.9 / 245.6 / 245.6 | 278.0 / 872.2 / 872.2 |
| First body, pre-command clock | 161.5 / 188.9 / 188.9 | 168.8 / 173.6 / 173.6 | 189.6 / 354.9 / 354.9 | 259.6 / 903.5 / 903.5 |
| Cached body, pre-command clock | 63.0 / 69.4 / 69.4 | 68.2 / 71.5 / 71.5 | 78.3 / 82.3 / 82.3 | 69.0 / 113.8 / 113.8 |
| Cached body, trusted click clock | 28.6 / 32.1 / 32.1 | 29.6 / 36.7 / 36.7 | — | 33.6 / 60.9 / 60.9 |
| Body-ready E | 38.0 / 65.3 / 65.3 | 64.3 / 75.9 / 75.9 | 46.7 / 180.2 / 180.2 | 47.7 / 79.6 / 79.6 |
| Body-ready W | 38.3 / 56.9 / 56.9 | 48.6 / 83.3 / 83.3 | 43.1 / 53.4 / 53.4 | 46.9 / 62.6 / 62.6 |
| No-body-wait E | 143.5 / 243.7 / 243.7 | **109.8 / 413.3 / 413.3** | 110.6 / 113.3 / 113.3 | **136.4 / 200.4 / 200.4** |
| No-body-wait W | 79.5 / 102.3 / 102.3 | 74.6 / 98.2 / 98.2 | 82.2 / 84.4 / 84.4 | **75.2 / 160.0 / 160.0** |
| Undo after body-ready E | 147.5 / 170.0 / 170.0 | 148.1 / 181.1 / 181.1 | 44.2 / 298.9 / 298.9 | 44.9 / 220.4 / 220.4 |
| Undo after body-ready W | 142.0 / 160.3 / 160.3 | 158.3 / 175.3 / 175.3 | 44.6 / 126.3 / 126.3 | 43.9 / 65.2 / 65.2 |
| Undo after no-body-wait E | 239.5 / 376.3 / 376.3 | 218.1 / 373.4 / 373.4 | 196.4 / 341.5 / 341.5 | 261.6 / 310.1 / 310.1 |
| Undo after no-body-wait W | 205.1 / 327.4 / 327.4 | 211.1 / 260.3 / 260.3 | 177.3 / 184.7 / 184.7 | 227.3 / 237.7 / 237.7 |

**The work reduction is proven; an across-the-board UI latency improvement is not.** Final cold E misses were 413.3ms at 6.5k and 200.4/150.4ms at 50k; cold W also reached 160ms at 50k. The 150ms target was not changed. The older cached pre-command clock retained its 113.8ms head sample; its trusted-click-to-body measurement was 60.9ms. All measured final trusted cached clicks were below 100ms. This distinguishes measurement boundaries rather than silently discarding the older upper-bound miss.

All **40/40 final-head action/Undo cycles** restored the original reader and inbox row, with persistence after reload; all 80 paired before/after cycles did so. First/cached body GET counts remained 1/0. All final warm inputs had their bodies ready and all final no-body-wait inputs did not. Before-6500 cold E5 happened to be body-ready without a wait; it remained in its planned series.

The intermediate head without sender gating is retained separately, including cached pre-command bounds of 128.7/180.3ms and cold E at 203.9/150.3ms. No slow sample was replaced. Residual tails could have other causes; request overlap alone does not identify them, and unused sync work was not asserted to explain every previous outlier.

Animation timing remains separate: both revisions showed the same 254ms/128ms thread-message animations. Final rAF interval median/p95/max was 16.7/17.7/82.8ms at 6.5k and 16.7/17.7/117.5ms at 50k. All per-action frame estimates, accepted times and rAF arrays remain retained; these are not paint/INP claims.

### Current media and arrival check

All media is inspected fictional mail on the current baseline, not private browser chrome:

| Dataset | Before `5a2e72c` | After `bcb4d1d` |
| --- | --- | --- |
| 6,500 | [Still](sync-before-6500.png) | [Still](sync-after-6500.png) |
| 50,003 | [Still](sync-before-50003.png) | [Still](sync-after-50003.png) |

[Before interaction](sync-before.mp4) · [After interaction](sync-after.mp4). Each is a separate illustrative reload/open/E/Undo cycle, outside the timed sample arrays; leading idle time was trimmed after inspecting the recordings. The after clip briefly shows the independent forwarded row during receipt restoration and subsequent head-batch reconciliation, then returns to the compacted view. This is not a promise of atomic cross-response deduplication. Original restoration was verified without a recovery reload.

A separate newest-timestamp fictional arrival appeared as the first Important row without reload or search while the restored original remained visible: [arrival evidence](sync-arrival.png). Upstream receive ran at 15:13:17.325–17.437Z and overlapped UI Undo (17.348Z start, 26.4ms to acceptance). SDK import then completed at 17.442Z, and the row was observed at 17.648Z. Thus receive overlapped Undo; **SDK import did not overlap the Undo transaction**. No repeat send, search, selection or opening of the new arrival was used. This supplemental record does not change the timed fixture counts or constitute a five-sample concurrency benchmark.

Final verification on frozen source: **94 web tests and 358 API tests passed** (111,152 API assertions), with SDK/host/mock typechecks and optimized web build passing. New coverage stays in the existing API/web test files; existing byte-budget, paging, ownership and receipt regressions were retained. The existing bundle-size warning remains. Owned QA services/session were stopped, and the user's normal app was not stopped.

**Optimizations are verified and committed; PR #25 remains draft and unmerged because release latency tails still miss the target.**

## Optimistic Inbox Done feedback

The user requested immediate UI feedback rather than waiting for durable Done acknowledgement. Ordinary Inbox Done/E now removes the displayed row or advances immediately, with a quiet “Marking Done…” status. It does not change canonical memberships, counts, receipt ownership, or guided-zero progress. Confirmation and conditional Undo still require the durable receipt. Search, other folders, W, bulk captured selections, guided-zero, and contexts without complete window targets retain their existing action path.

A bounded, command-owned presentation overlay covers only exact captured membership revisions and source generations (32 commands / 4,096 targets total). Later replies and newer memberships remain visible. A definite rejection reveals current canonical mail rather than writing an old snapshot back; automatic reader restoration is cancelled by newer navigation or input. Unknown acknowledgement reveals current data with “Done not confirmed” and explicit same-ID Retry. It does not submit a new command or guess an inverse. The existing one same-ID transport retry remains unchanged.

### Matched delayed-response evidence

Before: `c72cb22`, served `index-T48BoRxP.js`. After: optimistic-Done implementation, measured and recorded with `index-BoVtvDuU.js`; final `index-BO-LrtnR.js` adds only the complete-window-target admission guard, preserving the old action path for unsupported contexts. A final real held-request/Undo smoke check verified that final asset, immediate advance, no premature Undo, and restoration. CSS remains `index--Kkdv2hC.css`.

[Before: reader waits for receipt](optimistic-before.mp4) · [After: immediate advance, then confirmed Undo](optimistic-after.mp4) · [Genuine conflict: automatic rollback](optimistic-failure.mp4)

All three fictional-mail recordings were inspected as contact sheets. Same optimized build mode, Agent Browser/Chrome 152, Apple M5 Max/macOS 27.0/Bun 1.4.0, 1440×960/DPR 1, dark/Comfortable, logging enabled. Fresh initial-digest-matched fictional clones contained 6,500 canonical messages / 3,331 native conversations and 50,003 / 25,083. Bodies were cached. No profiling, builds or suites ran during timing. Before's corrected control held one original-target Done request for 1,501ms; the original reader was still visible 166.5ms after input. An earlier incorrectly matched route delayed nothing and is retained privately as a failed setup, not baseline evidence.

After held each original-target request for 1,500ms before forwarding it to the real SDK. Each size used four reader E samples and one list-button sample; the fourth 6.5k reader sample used reduced motion. All ten cycles showed pending feedback before receipt, withheld success/Undo until confirmation, and restored through real Undo, including after reload. The final-asset smoke cycle also restored.

Values are milliseconds, median / p95 / max, n=5:

| Measurement | 6,500 | 50,003 |
| --- | ---: | ---: |
| Trusted input → observed DOM feedback | 25.6 / 55.1 / 55.1 | 14.2 / 16.0 / 16.0 |
| `done-feedback` telemetry | 19.6 / 43.1 / 43.1 | 25.5 / 33.0 / 33.0 |
| `done` durable telemetry, including imposed delay | 1539.9 / 1591.1 / 1591.1 | 1543.4 / 1554.9 / 1554.9 |
| Confirmed Undo | 61.2 / 83.6 / 83.6 | 61.3 / 83.9 / 83.9 |

Complete sample arrays, in execution order:

- 6.5k trusted input → DOM: `[11.4,25.6,6.8,55.1,28.2]`; visual telemetry: `[19.6,8,19.2,42.8,43.1]`; durable: `[1539.9,1538.1,1535.8,1591.1,1543.4]`; Undo: `[60.6,83.6,81.3,61.2,45.1]`.
- 50k trusted input → DOM: `[14.2,8,16,14.8,12.4]`; visual telemetry: `[20.7,18.3,33,32.4,25.5]`; durable: `[1554.9,1553.8,1538.9,1533.8,1543.4]`; Undo: `[44.8,83.9,61.3,62,40.8]`.

These are DOM/handler measurements, not paint/INP or animation-completion measurements. They prove visual acknowledgement is independent of durable latency; they do **not** replace the earlier ordinary-operation performance series, remeasure startup/first-body/cached-open, or waive any prior tail failure. Optional loaded-page-boundary and navigation-away-during-pagination browser checks were not performed.

### Real failures and recovery

1. A second authorized client reaffirmed the original's existing `done:false` state while the UI request was held, advancing only its revision. The real SDK rejected the stale UI request with HTTP 412. The UI had advanced in 43.6ms, then automatically restored the original and showed the rejection; no Undo request was sent. A response-waiter setup error was retained; the actual 412 and restoration were separately observed without repeating the action.
2. With the same real conflict on A, the user marked the next conversation B Done before A settled. A→B took 42.5ms and B→C 65.3ms. A's 412 did not pull the reader back from C; B subsequently succeeded and real Undo restored B. Both A and B remained in Inbox. The earlier rejection notice was still visible, so this did not establish a distinct second error-notice instance.
3. A sidecar delivered the exact captured UI command ID/payload to the real SDK, obtained its committed receipt, then stopped only the owned QA server before the browser received acknowledgement. Both browser attempts failed with connection refused, retaining the same ID/payload; the UI showed “Done not confirmed”, no Undo and no automatic inverse. After restart, the first Retry correctly remained unconfirmed on HTTP 401. The existing background Retry re-established the local session; explicit command Retry then fetched the already-committed receipt with **zero new Done POSTs**. One real Undo restored the original. The 401-blocked attempt remains retained, not relabelled as successful recovery.

Existing test-file coverage includes held acknowledgements, canonical object preservation, revision/scope/concurrent-arrival safety, admission limits, rejected commands, ambiguous acknowledgements and same-ID recovery. Final store regressions: **94 web tests and 358 API tests passed**, with 111,152 API assertions; SDK/host/mock typechecks and build passed. The final App-only admission guard was typechecked/built and browser-smoked afterward; unchanged full suites were not repeated. The existing bundle warning remains. No new test files, dependencies, retries, provider writes, or database migrations were introduced.

PR #25 remains draft and unmerged. Immediate feedback is verified; earlier durable-latency misses remain documented and are not silently converted into passing release gates.
