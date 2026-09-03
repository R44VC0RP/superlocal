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
