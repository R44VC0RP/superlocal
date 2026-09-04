# Fast inbox startup

## Baseline and intended difference

Current deployed/review base: `840aa96b1c5d0d13ed76c6347a1d8fd8e7088598`
(PR #10). Hosted assets: `index-BOlQOhJc.js` / `index-Bk50KCF5.css`;
identical source builds locally as `index-DJqK7mx0.js`. Latest refs, merged PRs,
served revision and original Mac divergence were inspected. Unpublished Mac
classifier commits and the private README edit remain excluded and untouched.

Implementation: `9154136b1789dbdb0cf872a0d274d576043ed7e9`.

| Before | After |
| --- | --- |
| [Inbox](before-inbox.png) | [Inbox](after-inbox.png) |
| [Startup recording](before-startup.mp4) | [Startup recording](after-startup.mp4) |

Fictional existing SDK fixture: 160 messages / 80 Inbox conversations / two sources,
1440×1000 CSS pixels, DPR1, 100%, Carbon / Comfortable / Super Sans Normal,
optimized build, timing logging enabled. This initial visual fixture has AI off;
it is not the live AI-enabled performance reproduction. The recording's decoded
frames show a blank startup followed by the populated inbox; the settled image
was inspected. Real-mail screenshots, payloads and private traces are not published.

The separate live metadata-only trace establishes the failure: five signed-in
loads had median12.01s (11.03–14.81s). A fresh detailed trace delivered the mailbox
snapshot by1.172s but painted mail at10.164s. AI result pages serialize up to100
full message presentations for membership checks, and the initial snapshot's
catch-up unnecessarily forces a second serial metadata refresh before readiness.
An isolated100-result read took2.516s while a local health request stalled2.343s
(normal median0.7ms). These are live diagnostic observations, not fixture results.

## Scope

Replace full-body AI visibility checks with bounded owner/source/mailbox-checked
SDK metadata reads. Retain the snapshot's signed catch-up and owner/scope fences,
but remove unnecessary metadata work from the initial readiness gate. Keep
background result processing cooperative. No AI policy/model/UX redesign, new
browser mail cache, authentication relaxation, automatic rescan or provider writes.

Baseline-only draft commit `1303a0b` was published before implementation as PR #11.
A later AI-behavior discussion is separate from this narrowly scoped startup fix.
User/designated-reviewer approval is required before merge/deployment.

## Implementation and correctness

- Added `mailboxMessageSummary` to the actual SDK, client and HTTP API. It checks
  current owner/source generation and mailbox membership using bounded cached
  metadata. It never loads bodies, sanitizes HTML, or enriches missing legacy
  facts. Existing full-message and list APIs keep their behavior.
- AI result/change pages use that summary lookup and yield between bounded work
  slices. They retain the 100-event/decision prefix, pagination, deduplication,
  removals and client-side context fences; no inference or feedback policy changed.
- Bootstrap now captures a signed change baseline before reading metadata. This
  covers changes in the metadata-to-snapshot gap, so catch-up need not force all
  metadata to be fetched again. First display still requires complete signed
  catch-up. Real metadata events and explicit retry still refresh their fields.
- Complete existing suites: **239 API tests / 6,837 assertions** and **68 web
  tests passed**. SDK/host type checks, SDK build and optimized web build passed.
  The 10,000-history/33-arrival case retains its default five-second watchdog
  and passed in4,301.71ms. No new test files, dependencies, CI or raised budgets.

The new cases cover body-free reads even when legacy facts are absent, client/HTTP
owner/source/selector boundaries, deleted/generation-mismatched/detached records,
107-result pagination/removals, startup changes over multiple delta pages,
Done/deletion/unselection before first display, live metadata, manual preferences,
failed catch-up, scope reset, foreign-owner state and stopped-generation responses.

## Complex-email reproduction

The existing 160-message seed was extended through the actual mock adapter and
SDK with 1,000 unique fictional HTML messages. Each has83,184 bytes and1,548
opening tags (nested tables, spans and styles), without scripts or remote images.
The paired runtimes have1,160 canonical messages /1,128 threads /1,080 Inbox
conversations /1,160 memberships, two sources and1,000 identical saved AI results.
AI is enabled in Apply mode; no paid or external inference runs during measurement.
This is additional coverage, not a replacement for the full10k/50k fixtures.

Optimized builds,1440×1000/DPR1,Carbon/Comfortable/SuperSansNormal, visible browser,
normal cache and logging enabled. One warmup is excluded per build; five ordinary
reloads are measured. Candidate assets: `index-DafGZ9nT.js` / unchanged
`index-Bk50KCF5.css`.

| First inbox paint | Five samples (ms) | Median / p95 / max (ms) |
| --- | --- | --- |
| Baseline | 16687.7,17594.5,19111.9,14248.5,19561.5 | 17594.5 /19561.5 /19561.5 |
| Candidate | 302.2,291.9,259.1,245.9,246.2 | 259.1 /302.2 /302.2 |

Median improved98.5% in this local reproduction. Accounts requests drop3→2,
mailbox/config reads2→1, and initial mailbox-change reads2→1. All samples retain
32 visible rows at36px and a ready inbox. The discarded candidate warmup's one
401 is the unchanged loopback authentication probe followed by `/session`; it is
not the hosted Google-auth path. All measured reloads completed normally.

[Complex before](complex-before-inbox.png) · [Complex after](complex-after-inbox.png)

The complex-fixture settled images are RGB pixel-identical. The 160-message
before/after pair has unchanged geometry and only low-amplitude antialiasing
variation (maximum5/255 per channel). Both startup recordings were decoded and
inspected; they illustrate blank→inbox continuity, not quantitative timing.
These local measurements are not a claim of the same absolute latency on the
hosted two-vCPU machine.

## Full-scale checks

Apple M5 Max /48GiB, Bun1.4.0, Node24.16.0, Chromium152. Optimized builds with
logging enabled and unchanged1440×1000/DPR1/100% appearance. Complete pristine
paired caches:50,000 canonical messages /40,000 threads /75,000 memberships and
10,000 messages /8,000 threads /15,000 memberships. Two sources and three views
at both sizes. One warmup per build is excluded, not relabeled as a measured load.

Each cell is median /p95 /maximum milliseconds (five samples, nearest-rank p95).

| Scenario | Baseline | Candidate |
| --- | --- | --- |
| 50k navigation | 2990.6 /3596.6 /3596.6 | 2406.1 /2732.1 /2732.1 |
| 10k navigation | 776.3 /1127.4 /1127.4 | 580.2 /751.9 /751.9 |
| 50k cached open | 23.1 /32.3 /32.3 | 25.7 /28.7 /28.7 |
| 10k cached open | 20.1 /31.3 /31.3 | 26.9 /39.9 /39.9 |
| 50k E | 67.0 /104.5 /104.5 | 60.3 /117.7 /117.7 |
| 50k W | 70.3 /71.8 /71.8 | **64.3 /424.9 /424.9** |
| 10k E | 27.0 /56.6 /56.6 | 26.7 /38.1 /38.1 |
| 10k W | 26.9 /41.6 /41.6 | 29.1 /31.1 /31.1 |

All settled cached-open samples issued zero body requests. First body HTTP reads
were separately warmed and measured at2.3–8.4ms; those are request durations, not
first-body-paint claims. Ten Undo actions per size/build restored the reader URL;
maximum96.7/137.9ms for50k baseline/candidate and54.5/54.1ms for10k.

The harness restarted during the scale audit. Completed action timings were
recovered from the existing content-free performance ledger, not replayed.
Unreturned50k navigation batches were completed separately and saved per sample.
The worker's first cache loop advanced before prior frames/body loads settled;
those raw samples remain private diagnostic records, while the table uses the
corrected non-overlapping, body-ready protocol. Completed10k navigation was not
repeated. These were QA execution corrections, not changes to code or budgets.

### Retained action-latency finding

The interrupted50k candidate AI-off run includes one **424.9ms W** action, with a
successful364.8ms feedback request and26.1ms rebuild. Its cause is not established;
being in an interrupted run does not prove the restart caused it. It remains
recorded, exceeds the150ms target, and this startup fix does **not** claim to fix
that isolated spike. Review must explicitly account for this remaining finding;
do not call every recorded action budget green or silently waive it.

### Uninterrupted active-AI and arrival check

A separate50k candidate check admitted the full10,000-thread history job with the
same offline100ms/concurrency-two adapter. One new fictional reply was ingested
through the real mock adapter and SDK; final inventory50,001 messages /75,002
memberships. The reply remained unread with two active receiving memberships.

- E: `[80.5,73.5,84.2,74.1,80.7]`ms.
- W: `[70.3,63.9,65.9,84.0,70.1]`ms.
- Cached open: `[26.2,20.4,31.7,20.1,19.4]`ms; zero body requests.
- Ten Undo operations restored the same reader URL; maximum110.9ms. W created
  zero AI explicit-feedback rows. At capture653 history items had completed,
  9,345 were pending, two processing and zero failed; the job continued draining.

These final concurrent samples meet unchanged budgets, but do not erase the
separate AI-off outlier. The fictional job was then disabled/cancelled cleanly;
its queue became zero and all fixture data were retained. No real or paid
inference, production settings changes or original Mac changes occurred.

## Review status

Startup, ownership/catch-up correctness, matched media and concurrent AI checks
are complete. The isolated W finding remains disclosed rather than fixed in this
scope. **Not merged or deployed.** Keep the PR draft pending the reviewer’s
explicit decision on that finding and approval to deploy the startup-only fix.
No approval of previous PRs or of implementation is treated as a latency waiver.
