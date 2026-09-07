# Forwarded duplicates: verification and review blockers

> Historical report for the superseded mailbox-wide implementation. The user requested request-batch-only compaction afterward. See [the current design and verification](batch-scope.md); the timings and blockers below are retained history, not current acceptance evidence.

**The PR remains draft.** The requested hiding/toggle workflow passes, but release acceptance is not complete: the 6.5k inbox can remain stale after Undo, and some first-body/action/Undo tails exceed the baseline or action budget. The same stale-Undo class was observed before this feature. These findings are not waived or attributed to a cause without evidence.

## Revisions and environment

- Base: `9b77590`, also the running production baseline when reviewed. Feature: `53e2c51`; upgrade-query invalidation: `1037c24`; final implementation measured: `9923ade`.
- Optimized local UI, `scripts/dev.ts --built` after the normal optimized build. Base asset `index-BZ8CYD8Y.js`; candidate `index-DgaI4SAZ.js`; CSS unchanged. Timing logs enabled.
- Apple M5 Max, 48 GiB RAM, macOS 27.0, Bun 1.4.0, Chrome 152, 1440×960 CSS pixels, DPR 1, 100% zoom. Carbon/dark, Comfortable density, same browser profile and settings.
- Fictional mock/SDK data: 6,500 canonical messages / 3,331 native conversations / 6,662 mailbox-plus-unified projected conversations; 50,000 / 25,081 / 50,162 respectively before suppression. Two sources; one membership per message. The 50k fixture preserves the exact 6.5k canonical prefix. Generation anchor: 2026-09-07T00:48:45.593Z. Includes incoming/sent mail, attachments, manual forwards, unique replies and the verified original/copy pair.
- No real mail, credentials or raw private logs are published. Manual forwards without the required directional/content proof remain visible. Do not infer that every similarly titled fixture row qualifies for hiding.

## Method

Each completed series has five samples; the baseline 6.5k W series retains seven samples because supplemental cycles were needed to capture five Undo readings. No slow observations were replaced. Tables show **median / p95 / max**, milliseconds; nearest-rank p95 equals max at these sample sizes.

Startup is the browser clock from navigation to observing the original target row, not completion of background counts. First-body is thread-load telemetry, not an independently measured body-paint time. First-open action completion is separate. Every measured first-body window had one body GET; every cached-open window had **zero**. No full inbox-query request occurred inside measured mutation windows. Actions/Undo used their normal conditional endpoints, lookup and bounded delta reconciliation.

At 6.5k, the numeric Important count was awaited after recording startup and before first-body opening. At 50k it was not. Comparisons use the matching protocol at each size. At 50k, Done cycles 1–2 had the body ready; cycles 3–5 followed reload and waited for the reader heading, not body completion. W always waited for the body. Baseline 6.5k Done cycles 4–5 used that post-reload overlap. Background count, provider and metadata work remained enabled. Frame estimates and animation durations were **not independently measured**; the same CSS asset was used, but that is not a substitute for motion measurement.

## 6.5k comparison

| Metric | Base `9b77590` | Candidate `9923ade` |
| --- | ---: | ---: |
| Startup | 181.6 / 236.6 / 236.6 | 191.1 / 204.3 / 204.3 |
| First-body thread load | 18.1 / 33.0 / 33.0 | 12.8 / 22.5 / 22.5 |
| Cached open | 27.9 / 29.1 / 29.1 | 27.5 / 28.8 / 28.8 |
| Done | 67.8 / 258.9 / 258.9 | Incomplete: one sample, 86.9 |
| Done Undo | 51.2 / 78.5 / 78.5 | Incomplete: one sample, 90.6 |
| W | 39.9 / 50.3 / 50.3 | Not exercised after correctness failure |
| W Undo | 66.2 / 89.9 / 89.9 | Not exercised after correctness failure |

The candidate's first Done/Undo cycle reopened the original reader, but returning to Important left the project absent despite HTTP 200 and successful Undo telemetry. Reload restored it. Testing stopped at that correctness boundary rather than replacing the sample. The baseline had shown the same class of stale list in its second Done cycle.

Reproduction: open original project → E → Undo → original reader reopens → Back to inbox. Compare [baseline stale list](base-6500-undo-stale.png) and [candidate stale list](head-6500-undo-stale.png). All fixture mutations were ultimately restored and verified after reload.

## 50k comparison

| Metric | Base `9b77590` | Initial candidate `1037c24` | Final implementation `9923ade` |
| --- | ---: | ---: | ---: |
| Startup | 148.5 / 342.3 / 342.3 | 327.9 / 387.6 / 387.6 | 257.1 / 369.5 / 369.5 |
| First-body thread load | 489.7 / 725.4 / 725.4 | 473.0 / 553.7 / 553.7 | 527.4 / 1282.8 / 1282.8 |
| First-open action | 24.8 / 25.9 / 25.9 | 26.0 / 26.8 / 26.8 | 25.1 / 26.2 / 26.2 |
| Cached open | 27.1 / 29.2 / 29.2 | 28.1 / 29.6 / 29.6 | 28.0 / 28.6 / 28.6 |
| Done | 458.7 / 501.1 / 501.1 | 384.5 / 394.9 / 394.9 | 406.7 / 497.9 / 497.9 |
| Done Undo | 180.8 / 260.0 / 260.0 | 289.1 / 602.6 / 602.6 | 165.1 / 431.6 / 431.6 |
| W | 48.9 / 193.1 / 193.1 | Stopped before W | 38.0 / 46.7 / 46.7 |
| W Undo | 55.4 / 87.3 / 87.3 | Stopped before W | 49.5 / 501.8 / 501.8 |

Startup and cached-open targets pass. Final W actions pass 150ms. Post-reload Done cycles 3–5 still exceed 150ms, as on the baseline. First-body and Undo tail observations remain concerning; the final first-body maximum included an approximately 1276ms body GET, and the slow W Undo included an approximately 384ms account GET before its Undo request. Causality is not established.

The first candidate was retained as failed evidence, then investigated. A read-only inventory found 24,919 same-source referenced pairs whose bodies were unnecessarily loaded during classification. `9923ade` rejects those using indexed parent metadata. The existing SDK guard now proves **zero body hydration for ordinary referenced replies**, while all cross-source proof regressions pass. This removes identified unnecessary work; it does not establish that every observed latency tail was caused by it or is fixed.

All ten final 50k Done/W Undo cycles restored the original correctly, including final reload.

## Interleaved activity at 50k

After the timing series, three fictional messages were added through the existing mock provider: original, forwarded copy, and a unique reply on the forwarded conversation (50,003 canonical messages). Both resulting arrival conversations remained visible through an unrelated project E/Undo and reload; the unique reply was verified in the scriptless Email content iframe. See [arrival isolation](scale-arrivals.png).

Arrival ingestion had already completed before inspection, so this is **not** evidence of simultaneous ingestion and mutation. Actual refresh/action interleaving and Undo/delta overlap were observed:

| Observation | Driver-observed UTC time |
| --- | --- |
| First refresh sync request | 01:22:53.641 |
| E invocation began | 01:22:53.720 |
| First / second sync response | 01:22:53.764 / 01:22:53.978 |
| Done POST began | 01:22:53.979 |
| Delta request interval | 01:22:54.095–01:22:54.107 |
| Undo POST interval | 01:22:54.098–01:22:54.107 |

## Raw samples

Arrays are milliseconds, in observation order. Empty/incomplete series are not assigned summary percentiles.

```json
{
  "base6500": {
    "startup": [181.6,162.6,236.6,183.1,140.3],
    "firstBody": [18.1,14.3,33.0,29.8,11.4],
    "cachedOpen": [26.6,27.5,27.9,28.5,29.1],
    "done": [39.2,67.8,44.2,258.9,206.6],
    "doneUndo": [78.5,47.9,50.8,51.2,63.3],
    "w": [42.2,50.3,39.3,40.0,39.8,36.6,39.9],
    "wUndo": [56.8,89.9,79.7,49.1,66.2]
  },
  "head6500": {
    "startup": [204.3,200.3,190.7,191.1,174.2],
    "firstBody": [22.5,11.6,14.1,12.3,12.8],
    "firstOpenAction": [32.8,21.7,26.0,26.8,25.5],
    "cachedOpen": [25.6,28.8,28.4,27.0,27.5],
    "doneIncomplete": [86.9],
    "doneUndoIncomplete": [90.6],
    "w": [], "wUndo": []
  },
  "base50000": {
    "startup": [170.8,147.4,145.7,148.5,342.3],
    "firstBody": [506.9,394.3,410.7,725.4,489.7],
    "firstOpenAction": [24.8,25.4,25.9,24.0,23.9],
    "cachedOpen": [29.2,29.2,27.1,25.8,26.4],
    "done": [47.0,46.4,478.2,458.7,501.1],
    "doneUndo": [65.1,47.5,260.0,236.9,180.8],
    "w": [193.1,40.8,38.5,51.9,48.9],
    "wUndo": [71.8,48.8,49.6,87.3,55.4]
  },
  "initialHead50000": {
    "startup": [223.6,387.6,385.5,194.2,327.9],
    "firstBody": [491.5,553.7,449.8,473.0,467.3],
    "firstOpenAction": [25.7,26.0,25.7,26.8,26.5],
    "cachedOpen": [28.0,28.1,27.6,28.9,29.6],
    "done": [48.8,45.4,384.5,394.9,384.7],
    "doneUndo": [602.6,48.4,285.4,336.4,289.1],
    "w": [], "wUndo": []
  },
  "finalHead50000": {
    "startup": [369.5,207.3,181.1,351.6,257.1],
    "firstBody": [1282.8,527.4,583.9,490.7,478.5],
    "firstOpenAction": [24.5,25.1,26.2,25.8,23.8],
    "cachedOpen": [27.4,28.0,28.6,24.9,28.2],
    "done": [55.1,51.3,472.7,497.9,406.7],
    "doneUndo": [86.5,46.3,165.1,431.6,374.4],
    "w": [46.7,36.6,37.7,38.7,38.0],
    "wUndo": [501.8,49.5,48.4,46.3,75.2]
  }
}
```

## Automated verification

Full feature batch: 352 API tests and 94 web tests passed, with SDK/host/web typechecks and optimized builds. The query-upgrade follow-up was checked against an actual base-service query and the host regression. The ordinary-reply optimization passed SDK typecheck/build, five forwarding tests (111 assertions), and the host forwarding regression. No test files, dependencies, CI jobs, thresholds or existing safety checks were removed or relaxed.

The default-on switch, saved off/on behavior, original preference, account-specific access and explicit forwarded-reader access passed browser checks. The reported live pair matched in a read-only content comparison, without publishing its content or identifiers. Those functional results do not override the outstanding Undo/performance acceptance findings above.
