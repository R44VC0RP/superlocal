# Unified settings and reliable triage

## Scope and current baseline

Settings now replaces the email workspace with one continuous page. AI status and explanations come first; accounts, mailboxes, appearance, inbox, writing, calendar, workflow, advanced preferences and shortcuts follow inline. Section links scroll rather than opening ordinary settings dialogs.

- Hosted/review base: `18c78f673e1cc8ca7112f851f3ed6cf797c59c62` (PR #11), rechecked healthy with no intervening main change.
- Baseline-only draft: `45f0094`, published before application edits.
- Triage correction: `6561a1c`.
- Settings implementation: `94b801c`.
- Original Mac private README edit, two unpublished offline-classifier commits and other worktrees are preserved and excluded.

This remains a **draft** pending the review decision on the disclosed action-latency finding. No merge, deployment or paid historical refresh is approved by this review record.

## Before and after

| Scenario | Before | After |
| --- | --- | --- |
| Settings entry | [Sidebar](before-settings.png) | [Continuous workspace](after-settings.png) |
| AI controls | [Separate dialog](before-ai.png) | [Inline controls](after-settings.png) |
| Navigation and scrolling | [Old entry](before-settings.mp4) | [New entry and continuous scroll](after-settings.mp4) |
| Appearance | Existing preferences | [Inline theme, font, density and images](after-appearance.png) |

Additional controlled fictional status examples: [idle with failures](after-status.png), [partial historical completion and unknown costs](after-history.png). These use complete, scoped GET-response fixtures; they are **not** live-mail counts or a claim that the fixture ran paid inference. Real offline history processing was exercised separately at full scale.

The matching entry captures use the same retained fictional 160-message/two-source seed, 1440×1000, DPR 1, 100% zoom, Carbon / Comfortable / Super Sans Normal. The final capture runtime was copied from the untouched baseline, not the mutated acceptance-test instance. AI is unconfigured/off in the matching pair; production AI remains independently enabled. Images and decoded recording frames were inspected. Recordings illustrate interaction, not quantitative latency.

Baseline assets: `index-DafGZ9nT.js` / `index-Bk50KCF5.css`. Final assets: `index-DIdeZpiv.js` / `index-DR6vr4SN.css`.

## What changed

| Before | After |
| --- | --- |
| Sidebar links, ordinary modal pages and a hidden More Preferences section | All ordinary preferences in one central scroller with section jumps; duplicated aliases consolidated |
| Settings navigation could remount forms or bypass pending edits | Stable sections, explicit save boundaries, dirty/busy exit guards and browser Back/Forward handling |
| AI mode, progress, failures and explanation scattered behind controls/details | Saved mode, current queue, partial failures and explanations alongside controls; unsaved changes clearly separate |
| Hidden reader/calendar/snippet handlers could consume settings keystrokes | Underlying views remain mounted but hidden/inert; their capture handlers and mail shortcuts respect Settings |
| Account setup automatically left settings after a short delay | Completion remains inline and cannot discard unrelated settings drafts |

Reader identity, manually expanded older messages, nonzero scroll, unsent drafts and calendar/snippet state remain intact. Provider authorization and destructive confirmations remain transactional. Existing local-only/inert preferences are not newly implemented provider features.

## General triage correction

The demonstrated failure was a host rule, not a sender exception: any truncated excerpt overwrote validated model certainty with `insufficient`, which then promoted otherwise non-actionable campaigns into Important.

The exception is deliberately narrow. Only a validated **clear** promotion, newsletter or cold outreach with no response needed, no actions, no urgency/deadline, no observed risk and grounded type evidence keeps its clarity despite excerpt limits. Genuine model uncertainty, contradictory evidence, requests, deadlines, risk and manual choices remain protected. Strict quotation validation and all source/context budgets remain unchanged.

Input policy is versioned separately as `input-2`. Old certainty is never guessed or rewritten. Existing jobs and ordinary startup/reads do not gain paid-rescan permission. A newly requested, bounded historical Process job can refresh affected older uncertain marketing assessments without a manual override; other current assessments remain reusable. Existing cache provenance remains honest. No provider-Spam movement, W/Done training change, model switch or automatic full rescan was added.

### Private real-mail validation

The user explicitly authorized a bounded sample. An isolated **actual SDK and actual triage service** processed 12 selected snapshots through the configured model, preserving body text, facts and recipient/self semantics. Six routine campaigns became Other; six account/security/review/incident messages stayed Important: **12/12 expected results**, versus 6/12 in saved baseline assessments. This selected sample does not establish mailbox-wide accuracy.

Exactly 12 external inference calls, concurrency at most two, no retries, invalid results, unexpected network or provider writes. The direct-price estimate was $0.192199, **not verified Console billing**. Private messages, quotes, prompts, identities, credentials and raw reports are not published.

## Correctness verification

- Full API suite: **241 passed, 0 failed, 6,894 assertions**, 30.74 s. The unchanged five-second 10,000-thread/33rd-arrival stress watchdog passed at 4,064.23 ms.
- Full web suite: **68 passed, 0 failed**, 69.14 s. SDK and host type checks, SDK build and optimized web TypeScript/Vite build passed. Only existing test files were extended; no dependencies or CI were added.
- Browser QA verified one scroller and no horizontal overflow at 1440×1000, 900×900 and 390×844; selected appearance retained; opening/jumping produced no configuration writes or AI jobs.
- Actual preference and mailbox saves persisted after reload and were restored. Dirty cancellation, controlled 412 conflict and a held-save busy exit retained edits. Back/Forward and command-palette section targets preserved drafts.
- Three exact message IDs remained expanded and reader scroll stayed **250 → 250 px** at 900×500. Reader hash and unsent draft survived Settings. Calendar range and snippet identities/selection survived settings keyboard input. Temporary fixture drafts were discarded; no message was sent.

AI status checks covered unconfigured, disabled, idle, processing, paused and finished-with-failures states, plus stale progress after failed refresh. QA found one real issue: manual refresh failure left the old status visible until polling. The final error-path-only fix now shows **Progress unavailable** immediately; targeted QA observed it 266 ms after failure, before the five-second poll, with the draft intact. The passing unchanged suites were not rerun for that isolated follow-up; final build and affected browser behavior were rechecked.

A malformed early job fixture and premature dispatch-only timing windows were corrected as QA assumptions, not app fixes. A Browser Control context-replacement incident while attempting unrelated snippet editing was not treated as a verified application defect; the relevant non-editing snippet preservation path was subsequently checked successfully. Native Tab/forced-colors and real provider reconnection were not comprehensively audited.

## Performance

Apple M5 Max, 48 GiB, Bun 1.4.0, Node 24.16.0, Chromium 152; optimized builds, logging enabled, visible browser, 1440×1000/DPR1/100%, matching selected appearance. Normal cache, no throttling or cache clearing; one excluded navigation warmup per build/size. Complete paired copies: **10,000 canonical messages / 8,000 threads / 15,000 memberships**, and **50,000 / 40,000 / 75,000**, each two sources/three views.

Five samples per case. Values are **median / p95 / max, milliseconds** (with five samples, observed p95 equals max).

| Scenario | Baseline | Candidate |
| --- | ---: | ---: |
| 10k navigation → first rows, double-frame estimate | 555.1 / 845.0 / 845.0 | 541.8 / 834.6 / 834.6 |
| 50k navigation → first rows, double-frame estimate | 2601.5 / 2764.0 / 2764.0 | 2020.0 / 2080.5 / 2080.5 |
| 10k settled cached open | 9.8 / 12.6 / 12.6 | 12.2 / 14.4 / 14.4 |
| 50k settled cached open | 15.1 / 16.6 / 16.6 | 14.5 / 17.2 / 17.2 |
| 10k E | 27.0 / 48.8 / 48.8 | 32.3 / 32.4 / 32.4 |
| 10k W | 28.6 / 34.2 / 34.2 | 30.3 / 47.0 / 47.0 |
| 50k E, corrected non-overlap protocol | 60.1 / 118.3 / 118.3 | 52.3 / 89.1 / 89.1 |
| 50k W, corrected non-overlap protocol | **103.5 / 292.2 / 292.2** | 62.9 / 82.6 / 82.6 |
| 10k Settings open | 39.0 / 66.2 / 66.2 | 55.7 / 68.2 / 68.2 |
| 50k Settings open | 40.1 / 50.3 / 50.3 | 55.0 / 93.9 / 93.9 |

Action samples come from the application's completed receipt/next-frame instrumentation, not a double-frame immediately after dispatch. Cached cases waited for first body readiness and prior frames/exit; all accepted cached samples issued **zero body requests**. First body HTTP/paint was excluded from cached numbers; no new first-body-paint claim is made. Exit animation is not receipt latency. No causal startup speedup is attributed to the settings layout.

Quantitative candidate samples used `index-C1CGeWJC.js` and the final CSS, immediately before the isolated failed-status-refresh catch fix. That follow-up only changes the manual status error path, not the measured success, mail action, cache or navigation paths; final assets and affected error behavior were separately verified rather than replaying unchanged suites/benchmarks.

### Concurrent history and arrival

Full 50k candidate, explicit 10,000-thread offline history job, fake 100 ms/concurrency-two adapter. A single new fictional reply through the mock provider/real SDK did not navigate away from Settings; queue progress continued. Its source has one view, so final totals are **50,001 messages / 75,001 memberships**, not 75,002. It remained unread with its one expected active membership. No AI explicit-feedback rows were created by W.

| Concurrent case, n=5 | Median / p95 / max ms |
| --- | ---: |
| Cached open | 15.9 / 17.8 / 17.8 |
| E | 112.2 / 130.7 / 130.7 |
| W | **104.8 / 205.7 / 205.7** |

All correlated E/W Undo operations restored the same reader URL. The job was active during measurements. The parent verified cancellation and corrected an inaccurate worker cleanup report by explicitly disabling **only this fictional runtime**; final queue empty, AI disabled, data retained. Live AI settings/jobs were never altered.

## Remaining review decision

**The candidate's concurrent W maximum of 205.7 ms exceeds the 150 ms target.** Its cause is not established; it is not claimed fixed or waived. Baseline W also reached 292.2 ms. Original rapid-loop evidence is retained separately: actual E 235.4 ms, W 180 ms, cached-open action 109.8 ms and custom observation window 151.7 ms. Corrected non-overlap results do not erase those observations.

PR #11's earlier accepted W deferral is not treated as blanket approval here. The reviewer must explicitly accept deferring the disclosed W finding for this settings/triage release, or request investigation before release. No performance budget was raised, dataset reduced or logging disabled.

- [x] Current applicable app baseline reconciled; unrelated private work excluded.
- [x] Matching fictional before/after media captured and inspected.
- [x] Relevant correctness checks passed; the remaining performance failure is disclosed.
- [x] No private mail, credentials, prompts or raw logs in public evidence.
- [ ] Reviewer decides whether to defer the disclosed W finding.
- [ ] Reviewer approves merge/deployment of this exact change.

Older affected live assessments still require an explicit bounded historical refresh after deployment; merely restarting does not silently pay to reprocess them.
