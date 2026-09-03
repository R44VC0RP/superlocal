## Codebase map

- `apps/web` — React UI. Email reading: `ThreadView.tsx`, `MessageBody.tsx`
  (sandboxed srcdoc iframe), `message.css`; settings in `Settings.tsx`; demo
  seeds in `data.ts`.
- `packages/inbox-sdk` — SDK + server. Sanitization lives only in
  `server/sanitize.ts`; Gmail MIME decoding in `server/sdk/gmail.ts`; core
  sync/policy in `src/core.ts`; tests in `tests/`.
- `apps/local-host` — local host process; `apps/mock-api` — mock provider.

## Commands

- Always run bun with `--no-env-file`.
- Verify with: `bun --no-env-file run typecheck && bun --no-env-file run build`,
  `bun --no-env-file run test:web`, and
  `INBOX_TEST_LIVE=false bun --no-env-file run test:api`.
- The dev stack is managed by `scripts/dev.ts`; running services and their
  PIDs/logs are listed in `data/runtime/services.json`. Check it before
  starting servers; do not spawn duplicates.

## Data and privacy

- `*.sqlite` files contain real mail. Open them read-only, never print message
  bodies or credentials, and never commit them. `data/`, `superlocal.local.json`,
  and `apps/web/reference/` are gitignored and must stay out of history.
- Screenshots or dumps that may show real mail go under `data/qa/<topic>/`
  (chmod 700), never into git or handoff text.

## Email renderer invariants

- Email HTML renders only inside the isolated, scriptless srcdoc iframe in
  `apps/web/src/MessageBody.tsx`; never inject email HTML into the app DOM.
- Sanitization happens once, server-side, in `packages/inbox-sdk/server/sanitize.ts`;
  do not add client-side re-sanitization or global CSS overrides for email content.
- Keep the SDK remote-image/tracking policy and the Settings UI description in
  sync; verify both sides when changing either.

## Performance contract

- Ordinary mail events reconcile through bounded SDK deltas, not full-mailbox
  scans. Full inventories are for bootstrap and explicit recovery/scope changes.
  Do not hide stale-cursor failures, increase retries, or weaken ownership and
  revision fences to make a benchmark pass.
- Read/star/body updates rebuild only affected source/thread identities. A valid
  cached open performs no body request and publishes no replacement mail model.
  Unaffected conversations retain their object identities. Body/media policy,
  scope and content changes must still invalidate the appropriate cache.
- Done/W/Undo complete from durable, conditional receipts, not a full refresh or
  provider settlement. Keep captured membership scope, newer intents and later
  replies safe. Pending is not failed, and queued mail is not sent mail.
- Keep virtualized render inputs bounded (`getWindow`, `getHighlighted`, and
  sender-conversation accessors), rather than passing full render-entry/mail
  graphs to leaf components. Compile predicates once per selection pass, use
  indexed/set lookups for bulk selection, and reuse formatters/indexes with
  correct immutable-data, scope and clock invalidation.
- Normal use and acceptance measurements use `bun --no-env-file run start`
  (optimized local UI), with timing logs enabled. `dev` is for HMR development;
  development-only timings are not release evidence. Logging must stay bounded,
  content-free and off the action's critical path.

Reference acceptance budgets on comparable local hardware, with mail already
cached in SQLite:

| Scenario | Budget |
| --- | --- |
| Cached open, at both ~6.5k and 50k messages | 100ms |
| E/W completion, at both sizes | 150ms |
| Fresh navigation to usable inbox, ~6.5k–10k messages | 1.5s |
| Fresh navigation to usable inbox, 50k messages | 4s |

These are measured acceptance targets, not brittle wall-clock unit assertions.
For changes to queries, reconciliation, caching, selectors, virtualization or
rendering, run the relevant existing regressions and compare base/head in the
same optimized build mode, fixture state, viewport and environment. Record
revision, fixture seed/counts (canonical messages versus projected rows), browser
and runtime versions, hardware, logging state, cache/warmup conditions, and at
least five action samples with median/p95/max. Report first body load, cached
open, frame estimates, animation duration, and startup separately. Include
concurrent arrivals/actions: an idle empty inbox is not a scale test.

Use the existing fictional mock/SDK setup; do not depend on one developer's
private database or temporary fixture path. If an old fixture is unavailable,
recreate a fictional equivalent and measure both base and head against the same
dataset. Never lower dataset size, drop checks, raise budgets, or disable logging
merely to obtain a pass. A budget/contract change needs explicit user approval
and recorded evidence. Extend the existing two SDK/four web test files only;
new test files, frameworks and CI are not authorized by this policy. Do not run
unchanged expensive suites twice or benchmark documentation-only edits.

The SDK-backed case in `apps/web/tests/mail-model.test.ts` guards cached opening,
incremental updates, E/W/Undo and unaffected identities. The bounded-read and
receipt cases in `packages/inbox-sdk/tests/api.test.ts` guard paging, cache
validators, ownership and concurrency. Preserve these behavioral checks, not
merely their names or the existence of test files.

## UIPRs

A **UIPR** is required for any change that can affect visible UI or interaction:
layout, styling, copy, loading/empty/error states, focus, keyboard/pointer behavior,
motion, virtualization, or email rendering. A backend/sanitizer change that alters
the rendered result also qualifies, even if no CSS file changes.

1. Before editing UI, identify the review base, affected scenarios and expected
   differences. Capture the **before** state from that actual base using fictional
   mail in an isolated profile. Load `personal-design` as required.
2. Open a **draft PR titled `UIPR: <scope>`** on an isolated review branch before
   implementation; a baseline-evidence-only initial commit is allowed if needed
   to open the draft. Use `.github/pull_request_template.md`. If permissions or a
   safe base are unavailable, stop and ask—do not bypass the UIPR requirement.
3. Implement on that branch and capture matching **after** evidence. Use screenshots
   for static changes and screen recordings for interaction, loading, scrolling
   or animation changes. Match fixture state, viewport, zoom, theme and density;
   label the base/head revisions. Exercise relevant edge states, not only the
   happy path. A saved media file is not proof: inspect it and verify the outcome.
4. Put reviewable before/after media links or embeds in the PR, with expected
   differences, correctness checks, and performance evidence when relevant.
   A local `data/qa/` path, missing baseline, broken link, or uninspected capture
   does not satisfy the requirement. Only approved fictional media may be
   published; never upload real mail, even blurred/redacted, credentials, private
   browser chrome, or raw private logs.
5. Keep the PR draft until evidence and required checks are complete. Obtain
   user/designated-reviewer approval before merge or deployment; agents do not
   self-approve or auto-merge. Fix unexpected UI differences, or obtain a documented
   exception before proceeding. Non-UI-only PRs explain why visual evidence is N/A.

UIPRs do not authorize publishing unrelated work. Inspect the branch/base diff
before pushing: local `main` may contain unpublished commits that must not hitch
a ride. If the requested UI change cannot be isolated safely, ask for the base
and publishing decision before implementation. Do not push `main`, rewrite
history, upload private evidence, or sweep other work into the PR. These are
mandatory agent/review rules and test checks, not configured GitHub branch
protection; do not claim automatic remote enforcement or add CI without approval.

## Browser QA

- Use read-only browser-control sessions named `superlocal-*`; delete them when
  the audit ends. Shard large mail-corpus audits across parallel browser-qa
  subagents by thread index.
- If a subagent cannot load a skill (permission denied), that is not a blocker
  for a read-only audit: proceed with the audit and note the denial in the report.

## Git history

- Commit each completed, verified feature change or bug fix as a focused change.
  Explain what changed, why, removed/replaced behavior, and verification in the
  commit message; include the commit hash in the handoff.
- The coordinating agent owns commits in a shared checkout. Subagents report
  their exact changed files and checks; do not concurrently stage or commit.
- Stage only the files or hunks belonging to that change and inspect the staged
  diff. Never include unrelated work, credentials, private configuration, runtime
  data, real email content, or private screenshots/logs. Do not push or rewrite
  history unless explicitly requested.
