# Quiet focus styling

## Current baseline

Live/intended and review baseline: `7f6aa736618362f5b0441948756e264fe8b81d1e`
(PR #9 merged and deployed). The existing installation is healthy, with hosted
assets `index-COnCIj6v.js` / `index-CEstZs62.css`. Its exact source builds locally
as `index-RYlqcA7N.js`; the before fixture serves that verified optimized build.
Original Mac unpublished classifier commits and private README changes remain
excluded and untouched.

Fictional 160-message / two-source / 80-inbox-conversation SDK fixture, 1440×1000
CSS pixels, DPR1, 100% zoom, Carbon / Comfortable / Super Sans Normal. The supplied
user screenshot is not republished. Programmatic Playwright focus was verified
with `:focus-visible`; it reproduces the actual CSS ring without claiming native
Tab-key execution in a read-only browser session.

Implementation: `c5a0393f7f8acf243716156e5b677499bd99d57e`. The baseline-only
draft was opened at `492f2c203cabc12c3d0a96d5b68b48e582e93b4a`, before CSS edits.
Candidate optimized assets: `index-DJqK7mx0.js` / `index-Bk50KCF5.css`.

| Before | After |
| --- | --- |
| [Reminders focus](before-settings.png): 2px lavender outline, 2px offset | [Reminders focus](after-settings.png): no rectangle; subtle contrast emphasis, unchanged control bounds |
| [Reader back focus](before-reader.png): lavender arrow outline | [Reader back focus](after-reader.png): no outline; existing arrow/background affordance retained |

[900px Settings check](after-900.png) · [Focus and dialog recording](focus-motion.mp4)

The recording is supplemental candidate evidence, not a matched performance run:
58.04 seconds, 1036×720 encoded from the browser, with Settings focus checks,
AI-dialog controls, reader controls and a later 900px viewport change. Decoded
frames were inspected. The static before/after pairs above are both 1440×1000;
the 900px capture is an additional responsive check, not a paired baseline.

## Scope

Remove bright custom focus outlines across app controls, including Settings,
reader/composer controls, sender context, AI details and auxiliary views. Keep
keyboard focus, editable carets, selected values, pointer behavior, mail selection
and the newest-message indicator. Preserve existing typography and appearance.
No mail/data/inference/authentication changes.

## Verification

- **15 existing shortcut tests passed** (`bun --no-env-file test
  apps/web/tests/mail-shortcuts.test.ts`); the optimized `build:web` passed.
  No new test files, dependencies, CI or JavaScript changes. Staged secret scan:
  zero findings. Unchanged SDK/AI suites and scale benchmarks were not repeated.
- Settings Reminders, Split Inbox and Edit Profile retain `tabIndex=0` and
  `:focus-visible`, with `outline-style: none` and `filter: contrast(1.2)`.
  Reminders keeps exactly x1112.6328/y108/width292.3672/height24 CSS pixels.
- Reader back, header actions, sender controls and context disclosure have no
  bright outlines. Received message canvases and HTML iframes retain
  `filter: none`; the newest-message accent and selected mail row are untouched.
  AI selects/disclosures focus without changing their values or enabling AI.
- At 900×900, viewport/client/scroll widths are all 900px. Settings and the reader
  remain usable without horizontal overflow. The audit restored 1440×1000 and
  did not change appearance preferences or perform provider writes.
- Matching image comparison localizes differences above six grayscale levels to
  the Reminders focus region (1109,104–1410,136) and reader-back region
  (66,21–106,61). No measured control geometry changes. Parent inspected the
  final screenshots and decoded recording; the reader image was corrected to
  match the baseline's closed Settings panel.

This is focus-decoration CSS only: no queries, reconciliation, virtualization,
mail-body rendering or action scheduling changed. The small-fixture checks are
not new 50k latency evidence, and no application budget was changed.

Limits: focus was exercised with Playwright `focus()`, not native Tab traversal;
this is not a full accessibility/forced-colors audit. The selected Carbon theme
was verified; other appearance themes were not separately audited. The disabled,
unconfigured model select could not retain focus. The browser worker could not
load the design skill or inspect video frames; the parent applied the skill and
performed the missing media inspection.

## Review gate

Before/after evidence and affected checks are complete. **Not merged or deployed.**
PR #9 approval does not cover this separate change; user/designated-reviewer
approval is required for PR #10 before merge or deployment. These review records
are not configured branch protection.
