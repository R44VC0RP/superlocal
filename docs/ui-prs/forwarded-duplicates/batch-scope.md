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

## Current release browser measurements

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

**PR stays draft for the retained latency failures and remaining live-arrival evidence gap. No main merge or deployment was performed.**
