## Scope

<!-- UI-affecting work uses a draft PR titled `UIPR: <scope>`. See AGENTS.md.
Open the draft with baseline evidence before implementation; remain draft until
evidence/checks are complete, then obtain reviewer approval before merge/deploy. -->

- Change and reason:
- Review base / before commit:
- Candidate / after commit:
<!-- Choose exactly one change classification. -->
- [ ] UIPR — visible UI, interaction, loading, motion or rendering can change.
- [ ] Non-UI only — visual evidence is N/A because:

## Before and after

<!-- Pair actual captures from the base and candidate. Use the same fictional
data/state, viewport, zoom, theme and density. Recordings are required for changed
interaction/loading/motion; still screenshots are enough for static changes.
Embed/link media the reviewer can access, not local paths. Never publish real
mail (even redacted), credentials, private browser chrome or raw private logs. -->

| Scenario | Before | After |
| --- | --- | --- |
| | | |

- Fixture seed/counts and starting state:
- Viewport, zoom, theme and density:
- Expected visible/behavior differences:
- Edge states checked (loading, empty, error, focus/keyboard, long content, widths):

## Performance and correctness

<!-- For performance-sensitive changes, use the optimized local build with
logging enabled. Give base/head results on the same fixture/environment, not
only test totals. Budgets and required scenarios are in AGENTS.md. -->

- Commands/checks and results:
- Performance impact, or reason N/A:
- Build mode, hardware/browser/runtime, dataset and cache/warmup conditions:
- Base → candidate median/p95/max (at least five action samples when applicable):
- Startup / first body load / cached open / E-W-Undo / request and rebuild counts:
- Known limits or approved exceptions:

## Review gate

- [ ] The branch contains only the intended change, not unrelated unpublished history.
- [ ] For a UIPR, matching before/after evidence is attached, inspected and reviewable.
- [ ] Published media is approved fictional data; no private mail, secrets or logs.
- [ ] Relevant regressions pass; performance budgets/checks were not weakened to pass.
- [ ] Unexpected UI changes are fixed or explicitly approved and documented.
- Reviewer / approval link (required before merge or deployment):

<!-- Checkboxes are a review record, not automated GitHub enforcement. Do not
self-approve, auto-merge, or claim branch protection that has not been configured. -->
