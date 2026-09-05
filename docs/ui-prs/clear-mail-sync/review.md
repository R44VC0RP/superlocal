# Clear mail-sync progress

## Baseline

Review/application base: `ca3c9a924c24d597a9e5ee912fc57bb449435bc2` (PR #17). The hosted sign-in page still serves the recorded release assets `index-QrZyKKmi.js` / `index-CqbImCAc.css`. The matching optimized local build serves `index-z42NitiB.js` / the same CSS. The original Mac checkout's two unpublished offline-classifier commits and private README edit are preserved and excluded. Unapproved PR #18 is not included.

Before evidence was captured and inspected before implementation. The app uses its existing offline mock seed: 160 fictional messages, two sources, 80 inbox conversations. AI is off and provider network transport is disabled. The screenshots match the supplied Carbon sidebar; the rest of the fixture uses Comfortable / Super Sans Normal at 1440×1000 CSS pixels, DPR1, 100% zoom. Loopback authentication has no hosted Sign out button.

The status endpoint alone is intercepted with complete, source-scoped responses to keep the exact active → between-batches transition repeatable. The last-batch count of 100 is controlled presentation data, not a claim that the fixture imported 100 new messages. Mail data and other APIs remain real offline SDK responses. This review verifies presentation, not live provider throughput.

| Scenario | Before | After |
| --- | --- | --- |
| Active latest sync | [Checking for mail](before-active.png) | Pending |
| Between batches | [Waiting for the next batch](before-batch.png) | Pending |
| Active → between batches | [Recording](before.mp4) | Pending |

The baseline recording was decoded and inspected. Its 1440×1000 viewport is encoded at 1036×720/25fps; it is visual evidence, not latency evidence.

## Planned change

Replace ambiguous checking/waiting wording with mail-sync wording and a compact indeterminate activity bar. Keep between-batch state explicit, preserve last-batch semantics, and do not invent totals or a percentage. Error, reconnect, retry, pause and unavailable states must not imply active transfer. No scheduler, polling, provider, cache or mail-model changes.

Implementation, edge-state checks and after evidence are pending. This remains draft; no merge or deployment is authorized.
