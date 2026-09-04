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

| Before | Intended after |
| --- | --- |
| [Reminders focus](before-settings.png): 2px lavender outline, 2px offset | No bright rectangle; quiet focus treatment without moving or resizing controls |
| [Reader back focus](before-reader.png): lavender arrow outline | No bright arrow outline; existing back affordance remains |

## Scope

Remove bright custom focus outlines across app controls, including Settings,
reader/composer controls, sender context, AI details and auxiliary views. Keep
keyboard focus, editable carets, selected values, pointer behavior, mail selection
and the newest-message indicator. Preserve existing typography and appearance.
No mail/data/inference/authentication changes.

This baseline-only draft is opened before implementation. After captures,
affected checks and review approval are still required before merge/deployment.
