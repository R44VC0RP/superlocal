# Hosted startup transport

## Current baseline

Review base and deployed source: `4fe8579a0a0b52cec15bc33a783b264cea78b50c` (PR18). This initial commit contains only inspected fictional before evidence; implementation has not started. The separate original checkout's private changes and unpublished history are excluded.

The reported hosted startup delay was reproduced using content-free timing metadata: 34 sequential snapshot HTTP requests, 19.53 MB transferred uncompressed, and 5.26 seconds to the next-frame estimate after rows appeared. These diagnostic observations are not five-sample acceptance results; no real mail or credentials are published here.

## Before evidence

![Current 10k inbox](10k-before.png)

[Current 10k startup recording](10k-before-startup.mp4)

- Fictional immutable seed: 10,000 canonical messages, 8,000 source threads, 15,000 projected memberships, two sources and three receiving views. Important shows 6,000 conversations. No AI configuration or new inference.
- Optimized build, timing logs enabled; JS `index-VkD8qFXr.js`, CSS `index-Cx__i9xy.css`.
- Agent Browser, 1440×1000 CSS viewport, DPR 1, 100% zoom. Dark (stored Carbon), Comfortable, Superlocal, Super Sans Normal.
- Recording includes one explicit 50 ms admission delay per snapshot request, to expose the sequential-request cost. This is a controlled latency model, not a complete recreation of production network/server conditions. No response buffering or bandwidth shaping is added.
- Inspected still and decoded recording: current flat inbox layout preserved; recording shows the existing blank startup followed by the populated list. Recorded startup frame estimate 2403 ms is illustrative, n=1, not qualification.
- Recording captured 1440×1000; encoded fitted to 1036×720. No browser chrome, credentials or real mail.

## Planned change and review boundary

Replace serial per-page HTTP waits with a bounded SDK snapshot stream using the same page reads and signed catch-up. Keep page, membership, inventory, owner/source/generation, abort and freshness limits unchanged. Do not publish partial inventory as ready or add a loader to conceal the delay. No global authenticated-response compression is planned in this patch.

After evidence, matched base/head performance, existing regression results, truncation/abort/scope/concurrency checks, and final source/build revisions are pending. Keep this PR draft. The user approved creating the draft and implementing the fix, not merging or deploying it.
