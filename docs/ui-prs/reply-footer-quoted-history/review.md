# Reply footer and quoted history

## Scope and baseline

Combined draft [PR15](https://github.com/R44VC0RP/superlocal/pull/15) now includes the reply/footer work and the subsequent live exploratory QA repairs. The original footer/quote evidence below qualifies that slice; it is not presented as a complete audit of the combined branch.

## Exploratory QA integration

The user requested ten live browser QA workers, authorized interactive testing and fixes without a separate UIPR for each finding, and subsequently reaffirmed that permission. Sending was restricted to two explicitly approved owned addresses. Exactly one labeled test message and one reply were sent and their destination content verified; no external contacts were emailed. Real-mail screenshots, addresses, drafts, logs and provider payloads remain private and are not included in this review.

The coordinator integrated the exact reviewed footer/quote head `41995cc` without rewriting it. Focused additional changes:

- `1d292f9`: accessible command selection and opener focus; safe backdrop dismissal; Calendar cancellation returns to the stable heading.
- `e492549`: per-draft error retirement after confirmed recovery; corrected recipient validation resumes autosave without retrying conflicts or ambiguous network failures.
- `948449d`: bounded Inbound capacity and ordered listing lookahead, plus a distinction between connected accounts and sync health.
- Navigation changes retain bounded per-view scroll positions and in-memory search history, restore Search focus, preserve Settings section URLs, and fit navigation controls at tablet widths. No global preference or ownership migration.

### Inbound diagnosis and remaining upstream failure

The original adapter refused the selected aggregate inventory above 10,000 records before returning a first page. A bounded metadata-only check also exceeded its old 8 MiB snapshot accounting budget. The replacement remains bounded at 20,000 records / 16 MiB, with four ordered listing requests in flight, a 4 MiB streamed successful-listing response cap, the unchanged 200-page verification budget and 30-second SDK deadline. Cursor replay, prefix validation, source/delivery identity and failures are retained. No page is skipped to make progress appear complete.

A particular upstream listing page independently returned HTTP 500 twice while the following page succeeded. That remains an external failure, not a completed-sync claim. Larger snapshots and parallel prefix verification remove local obstacles but do not repair the provider's failing response. No forced provider retry, reconnect, account removal, historical AI processing or credential change was performed during diagnosis.

### Combined correctness evidence

- Combined source: 252 API tests / 7,560 assertions passed; unchanged five-second stress watchdog completed in 4,151.41 ms. Optimized web build passed (`index-dTGfxQe5.js` / `index-DhjA4v3r.css`). SDK/host types and SDK build passed.
- Web: the 68-test suite passed before the narrowly scoped recipient-recovery follow-up; its extended, existing SDK-backed case then passed separately, covering actual saved content, held/lost acknowledgment, HTTP 412, newer errors and other-draft isolation. Unchanged passing cases were not rerun.
- Provider suite: 302 passed and six deferred Outlook cases failed. All six reproduced on unchanged `4fb6510`; no Outlook behavior was changed. Forty focused Inbound cases passed, including a complete fictional 15,482-record traversal, replay, out-of-order pages, smaller limits, cancellation/settlement and response bounds.
- Native fictional UI retests passed scroll/account/folder/reader return, search Back/Forward and focus, actionable query errors, Settings deep-link reload, 390/768/1440 layouts, command selection/Tab/destination focus, Calendar dismissals, corrected-recipient persistence, and per-draft error isolation. Test drafts were discarded. A controlled metadata response verified sync-health copy appears beside Connected and clears when healthy without additional polling.
- Independent source reviews found no introduced high/medium navigation or Inbound correctness regression. These reviews are not substitutes for real upstream completion.

The snippet editor repeatedly triggered Browser Control execution-context loss, including on an isolated fictional fixture. Source review found no demonstrated application loop or navigation cause. The driver issue is recorded privately; no speculative application fix is claimed. Ten simultaneous live tabs also hit the existing stream cap and visibly fell back to polling; completed audit tabs were closed, not accommodated by raising the limit.

### Final integrated screenshots

Same independent fictional 168-message seed and unchanged saved reply, 100% zoom and selected appearance; baseline `4fb6510`, combined `bd15f51`. Captures were inspected by the QA worker and coordinator. Native Tab/Enter/Space preserved all quote text, resized the iframe 228→337→228px, and continued working after Settings/Back with the exact saved reply intact.

| Scenario | Baseline | Combined |
| --- | --- | --- |
| Reader / reply footer, 1440×1000 | ![Baseline reader](combined-before-reader.png) | ![Combined reader](combined-after-reader.png) |
| Inbox navigation, 768×900 | ![Baseline tablet](combined-before-tablet.png) | ![Combined tablet](combined-after-tablet.png) |

At 768px, the old sidebar extended to x=820 and put Settings beyond the viewport. The combined sidebar ends at x=768 and Settings at x=754. The Browser Control badge partly overlays the bottom controls in these images; independent DOM measurements verified their actual bounds. Sequential fixture reloads resolved a localhost cookie collision between paired instance copies without altering credentials or product code. The original disclosure recording below remains the unchanged interaction treatment; the integrated native checks verify it still works.

### Final combined scale qualification

Final application source is `bd15f51`; committing the pending navigation patch did not change measured assets. The coordinator verified all 20 measured action/Undo pairs against the durable content-free ledger and exact restored reader hashes. Both datasets are independently copied from the same per-size pristine seeds used by the baseline, not matched to each other. Appearance is unchanged: the stored Carbon setting is labeled **Dark** in Settings, with Superlocal style, Comfortable density and Super Sans Normal. One warmup per case was excluded; five retained samples per row, same hardware/runtime described below, optimized builds and logging enabled.

| Combined scenario | Median / p95 / max (ms) |
| --- | ---: |
| 10k startup | 1330.5 / 1346.6 / 1346.6 |
| 50k startup | 2765.8 / 2781.3 / 2781.3 |
| 10k native cached click → body ready | 80.8 / 83.4 / 83.4 |
| 50k native cached click → body ready | 83.5 / 85.9 / 85.9 |
| 10k E | 48.9 / 56.5 / 56.5 |
| 10k W | 40.3 / 61.7 / 61.7 |
| 50k E | 89.9 / 91.7 / 91.7 |
| 50k W | 77.7 / 89.0 / 89.0 |

Every measured cached open issued zero body requests. Native click-to-ready includes automation/readiness overhead and is **not directly comparable** to the earlier handler-only cache numbers. The same 50k opens produced handler-only median/p95/max **28.3 / 29.1 / 29.1 ms**. No first-body latency or causal speedup claim is made for the combined build; original first-body measurements remain below. Startup, cached opening and E/W all meet their unchanged budgets. Two additional 50k Undo observations were **153.8 and 155.5 ms** and remain recorded. One raw E sample reports acceptedMs 91.3 versus durationMs 90.1; it is retained exactly, without an acceptance-to-frame decomposition claim.

A further actual mock-provider reply was staged in the 50k candidate, then a real SDK sync and E action were dispatched concurrently. Sync returned 200; receipt-based E was **87.8 ms**, Undo **130.8 ms**, and the exact reader hash returned with the new reply visible. Read-only verification found **50,001 messages / 75,002 memberships**; the arriving reply remained unread, undeleted and not Done or snoozed in either membership. This is one concurrency correctness smoke, not an n=5 simultaneous-arrival latency benchmark. Earlier baseline W and concurrent timing exceptions below are not erased or waived.

- Approved base: PR12 merge `4fb65106b72855497ada4eafe3ea2862bd2753d5`; application tree matches the qualified `1881b6c` tree. The original Mac README edit, private config/databases and two unpublished classifier commits remain untouched and excluded.
- Baseline-only draft commit: `9e06eda`, created before application edits. Source implementation: **`f71e5553649f28dda8ba01cf8b30b8b222ee491c`**.
- Hosted asset identity at baseline: `index-Ba2d0NbS.js` / `index-kKVWxxy0.css`. The release coordinator owns production. Local optimized baseline: `index-CWPNzOho.js`; candidate: `index-CsE3T75m.js`. Both use `index-kKVWxxy0.css`.
- Matching visual fixture: default offline mock seed plus eight fictional received examples, **168 canonical messages / two sources / one saved reply**. Independent copies of the same seed; no real email, external inference or provider traffic.
- Appearance: **Carbon / Comfortable / Super Sans (SuperMailSans) / Normal**, 1440×1000 CSS px, DPR1, 100% zoom. Existing sender formatting and scriptless isolation remain intact.

## Before and after

| Scenario | Before | After |
| --- | --- | --- |
| Reply footer and collapsed history | ![Before](before-reader.png) | ![After](after-reader.png) |
| History disclosure | ![Baseline recording](before-reader.gif) | ![Native expand/reclose recording](after-reader.gif) |
| Full older reply remains available | Always visible above | ![Expanded history](after-expanded.png) |

Screenshots and decoded recording frames were inspected. Embedded GIFs render directly in GitHub; the original [before MP4](before-reader.mp4) and [after MP4](after-reader.mp4) remain downloadable. The after recording is an unchanged-speed six-second excerpt showing the native disclosure expand and reclose, not a latency benchmark. Supplementary fictional edge states: [unsaved recipient](after-unsaved-recipient.png), [save conflict](after-save-error.png), [expanded mobile quote](after-mobile-expanded.png), [popped-out reply](after-popout.png).

## Changes

| Before | After |
| --- | --- |
| Routine saved/saving text was a third footer group, moving Send toward the center | Send / Send later / Remind me remain at left, utility icons at right; actionable unsaved-recipient feedback remains above the footer |
| Complete quote history always rendered | Native, keyboard-accessible Show/Hide quoted text inside the existing iframe; every sanitized quoted node remains available |
| Unused, sender-spoofable quote classes | Server-only structural annotation of at most two adjacent nodes; size/depth/event bounds and a cheap no-quote fast path |
| Reader link-only Tab traversal could bypass a new disclosure | Tab includes generated summaries; Enter/Space retain native activation; iframe height updates on toggle |

Autosave and submission logic are unchanged. Save failures, local writing recovery and explicit Reload saved draft confirmation remain. There was no Share draft implementation to remove.

### Conservative detection

Eligible shapes are a trailing Yahoo `yahoo-quoted-begin` attribution plus `blockquote.iosymail`, a Gmail attribution plus quoted block, or an explicit citation block. Detection requires preceding current content and rejects later meaningful content through every ancestor. It never hides a broad Gmail wrapper.

Generic quotations, plain text, unpaired headers, header-only Outlook shapes, quote-only messages, signatures without current content, new inline/bottom replies and over-budget/ambiguous documents stay visible. Sender-supplied collapse markers are stripped. Text, inline attachments and remote-image/tracker policy are preserved. The generated disclosure has a 44px target; no iframe scripts or client re-sanitization were added.

New text placed by an email author *inside* an actual quoted block cannot be distinguished reliably without additional metadata. The disclosure is always reversible rather than deleting that content.

## Correctness verification

- **68 web tests**, **252 API tests / 7,560 assertions**, zero failures. SDK and host type checks, SDK build, optimized web TypeScript/Vite build, and `git diff --check` passed. Only existing API tests were extended; no dependencies, test files or CI added. The unchanged 10,000-thread/33rd-arrival API watchdog passed at 4,481.66ms.
- Native browser QA verified Tab from the preceding link to the disclosure, Enter to expand, Space to collapse, visible Yahoo/Gmail/cite quote content, and visible inline/bottom/generic/plain text.
- Actual fixture PATCH saves returned 200 and persisted across reload. Original draft body/recipient were restored. Incomplete recipient input produced **Unsaved recipient changes above the footer**. Schedule/reminder/formatting/snippet menus and popped-out reply layout worked without sending.
- A parent-owned interception of **only the fictional draft PATCH** returned a controlled 412. Writing and error alert/recovery remained visible; Keep editing preserved writing, and confirmed Reload draft restored the saved original. The interception was removed and restoration reverified after reload.
- At 1440/900/390 widths, document and iframe widths had no horizontal overflow. Native expand/reclose heights were 228→337→228, 228→361→228 and 276→481→276px. Mobile quote/footer remained readable/reachable, and mobile Formatting activation worked.

The initial read-only QA correctly could not exercise trusted interactions. Ryan then explicitly authorized an interaction-enabled session **for disposable localhost fixtures only**; the blocked checks above were completed, not counted as passes beforehand. Browser Control logged sandbox script refusals during some native actions; scripts remained blocked and the native disclosure still functioned. Attachment Tab traversal was not directly tested in the browser; SDK media-preservation cases passed. A separate new-message composer was not created; inline and popped-out shared composers were exercised.

## Performance

Apple M5 Max / 48GiB, macOS27, Bun1.4.0, Node24.16.0, Chrome152, Browser Control0.5.1. Optimized builds, performance logging on, 1440×1000/DPR1/100%, same selected appearance, independent copies of complete common seeds: **10,000 canonical messages / 8,000 threads / 15,000 memberships** and **50,000 / 40,000 / 75,000**, two sources/three views each. No budgets lowered, cache clearing, throttling or reduced data.

At least five samples per case; one excluded startup warmup per size/build. Startup is rows-ready plus two frames. Action values are the application's handler-to-next-double-frame estimate *after completed receipt*, not browser paint or full native input latency. First browser body reads are separate from settled cached opens; cached samples issued zero body GETs. Exit animation is not receipt latency. Candidate measurements use the identical source now committed as `f71e555`.

| Scenario | Baseline median / p95 / max (ms) | Candidate median / p95 / max (ms) |
| --- | ---: | ---: |
| 10k startup → rows | 828.8 / 839.4 / 839.4 | 1335.6 / 1342.7 / 1342.7 |
| 10k first body ready | 37.9 / 48.6 / 48.6 | 80.8 / 107.3 / 107.3 |
| 10k settled cached open | 24.1 / 31.0 / 31.0 | 27.7 / 28.7 / 28.7 |
| 10k E | 33.9 / 36.7 / 36.7 | 45.7 / 47.6 / 47.6 |
| 10k W | 37.2 / 50.3 / 50.3 | 49.0 / 52.8 / 52.8 |
| 50k startup → rows | 2730.5 / 2733.3 / 2733.3 | 2724.4 / 2813.8 / 2813.8 |
| 50k first body ready | 135.8 / 208.7 / 208.7 | 192.8 / 242.2 / 242.2 |
| 50k settled cached open | 16.8 / 31.8 / 31.8 | 29.1 / 30.1 / 30.1 |
| 50k E | 58.8 / 111.3 / 111.3 | 63.8 / 116.8 / 116.8 |
| 50k W | 66.7 / 391.4 / 391.4 | 66.8 / 70.8 / 70.8 |

All final candidate n=5 startup, cached-open and E/W sets meet their respective targets; all 20 correlated E/W Undo actions restored the exact reader hash. Baseline used scoped synthetic dispatch; candidate used trusted native input after permission was granted. The handler-completion values remain useful, but this is **not a full input-latency or causal speedup comparison**. The 10k startup/body-ready values increased; no startup improvement is claimed. First-body cases used matched mixed HTML/plain-text threads and 2–3 GETs. The last 10k cache sample followed an excluded exact-thread rewarm; it issued zero GETs. The five 50k Done records were recovered from the content-free application timing ledger after an observation execute timed out, not rerun.

### Concurrent arrival and remaining findings

After the main five-sample sets, one new fictional reply was delivered through the actual mock provider in each 50k runtime, with sync and Done requests started 3ms apart on the candidate and 11ms apart on the baseline. Correlated Undo restored the reader, and the arriving reply rendered in its iframe. Read-only database verification found **50,001 canonical messages / 75,002 memberships** per runtime; the new reply remained unread, undeleted and not Done in both memberships. This is one correctness/latency smoke per build, not an n=5 concurrent-load benchmark.

- Concurrent-smoke baseline E / Undo: **227.1 / 73.5ms**; candidate E / Undo: **137.5 / 280.9ms**. The high baseline E and candidate Undo observation are retained; no latency fix or waiver is claimed.
- An exploratory candidate W action returned an error (34.9ms) and no Undo control before the final settled five-sample run. Its HTTP/root cause was not established. The subsequent qualified W samples do **not** erase this observation; unrelated W debugging is outside this PR.
- The first concurrency observation incorrectly searched the parent document for HTML iframe text, and the baseline observation briefly encountered an unloaded iframe body. Fresh frame-specific reads verified both outcomes without repeating the actions. These were observation errors, not evidence of lost replies.
- The new disclosure has no animated transition; native toggle plus the next resize frame determines expansion. Underlying reader/list animation was unchanged and was not conflated with the completed receipt metrics.

The baseline 50k W pass already recorded two 150ms-budget breaches: **391.4ms and 236.8ms**. The older PR12 concurrent W finding of **205.7ms** also remains recorded; neither is a global waiver or claimed fixed by this footer/quote work.

## Review gate

- [x] Baseline captured and inspected before implementation; isolated branch excludes unrelated/private work.
- [x] Matching fictional after screenshots and native disclosure recording inspected.
- [x] Functional regressions, native interaction, persistence and recovery checks passed.
- [x] Candidate scale/arrival evidence complete; timing exceptions retained above for reviewer decision.
- [ ] Ryan/release coordinator approves exact reviewed revision before merge/deployment.
