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
