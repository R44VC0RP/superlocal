# Fast inbox startup

## Baseline and intended difference

Current deployed/review base: `840aa96b1c5d0d13ed76c6347a1d8fd8e7088598`
(PR #10). Hosted assets: `index-BOlQOhJc.js` / `index-Bk50KCF5.css`;
identical source builds locally as `index-DJqK7mx0.js`. Latest refs, merged PRs,
served revision and original Mac divergence were inspected. Unpublished Mac
classifier commits and the private README edit remain excluded and untouched.

[Before inbox](before-inbox.png) · [Before startup recording](before-startup.mp4)

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

This baseline-only draft is opened before implementation. Matching after media,
AI-enabled/complex-body regression checks and performance qualification are pending.
A later AI-behavior discussion is separate from this narrowly scoped startup fix.
User/designated-reviewer approval is required before merge/deployment.
