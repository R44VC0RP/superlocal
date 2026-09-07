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

The branch includes current `main` through `2ef1614`, including the latest AI settings and sidebar progress work. Matched captures use the same fictional fixture, 1440×960 viewport, 100% zoom, Carbon/dark appearance and Comfortable density. AI is unconfigured in the mock; its idle progress indicator is hidden.

The fixture has 406 canonical messages, 326 native conversations and 325 Inbox conversations. It includes a pair in the first batch, a pair with an archived original, and a pair whose original falls after the initial 200 raw rows.

| Scenario | Before | After |
| --- | --- | --- |
| Inbox batch | [Before](batch-inbox-before.png) | [After](batch-inbox-after.png) |
| Search containing both copies | [Before](batch-search-before.png) | [After](batch-search-after.png) |
| Mailboxes setting | [Before](batch-settings-before.png) | [After](batch-settings-after.png) |

[Before recording](batch-before.mp4) · [After recording](batch-after.mp4)

Verified assets: baseline `index-CzzxcNng.js`; final candidate `index-le0_olMp.js`; shared CSS `index-BM6XF745.css`. Captures were inspected. Earlier full workflow checks ran on the same batch backend with `index-DqnWbfjM.js`, before unrelated upstream AI UI updates; final captures/build identity were refreshed afterward.

Browser results:

- In-page pair: one Original Author row. Archived-original and off-page-original cases: forwarded copy remains in Inbox.
- `subject:"Batch scope: off-page"`: both matches now belong to one search response, so one original is shown. Adding `from:noah@atelier.test` to the in-page search retains the forward because the original does not match.
- Exactly one initial query and one automatic page request. Scrolling the existing buffer added none; scrolling farther added one page, with boundary notes 194–200 present exactly once.
- Settings OFF/ON persisted through reload and restored two/one in-page rows. Empty search recovered correctly. Three E/Undo cycles restored the original; no persistent stale-Undo failure occurred.
- The worker initially reported absent count badges after mutations/reload. A later parent read, without another action, confirmed Important 325 / Other 0 and one original. They were pending asynchronous native counts, not permanently lost or numerically deduplicated.

## Bounded work at 6.5k and 50k

Instrumented in-process host-service requests compared baseline and candidate against matching immutable fictional snapshot clones. These are **host-request work timings, not browser navigation, body paint, animation or E/W latency**.

The smaller dataset contains 6,500 messages / 3,331 native conversations; the larger retains 50,003 messages / 25,083 conversations, including the earlier three-message arrival exercise. The original fixtures and running UI fixture were not modified. Runtime: Bun 1.4.0, Apple M5 Max, macOS 27. Source fingerprints remained stable during measurement. The host/SDK baseline was `fb7a21d`; later upstream merges changed only frontend files, not measured host/SDK code.

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

- Full API suite: 353 passed. Full web suite: 94 passed. SDK build/typecheck, host typecheck and final optimized web build passed; the existing bundle-size warning remains.
- After head/Undo refinements, both host-service-backed web cases and all 12 existing bounded-host API cases passed. New assertions cover withheld AI originals, resident-copy removal, pinned-original restoration, real Done/Undo receipts, exact page membership, no refill and reversible per-row bookmarks.
- SDK tests cover batch-only parent lookup, privacy/generation fences, malformed data, collisions/cycles, same-source proof, proof-cache eviction/invalidation and no global forwarding maintenance. Existing unrelated tests were preserved; no new test files or dependencies were introduced.
- No global uniqueness across separately requested batches is promised. Stored totals and bulk capture semantics remain native, not globally compacted totals.
- The old mailbox-wide design's UI timing report is historical. Fresh full-size browser startup/body/E/W/frame measurements have not all been repeated for this design, so these host-request results do not claim that every release performance budget is satisfied. The PR remains draft for review; nothing was merged or deployed.
