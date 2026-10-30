# ADR 0003: How results appear on the pull request

Status: Accepted

## Context

The agent's results must be visible in the context of the pull request. Reviewers need a fast pass/fail signal first and details second. Repeated pushes must not flood the pull request or trigger the agent on its own commits.

## Options

1. A new comment on every run.
2. One check plus one comment that is updated in place, plus a bot commit with the tests.
3. Results only as workflow artifacts or job summary.

## Decision

Option 2:

- **Check run** `test-agent/verified` is the primary signal. It is created by our GitHub App in the `publish` job (ADR 0019); its conclusions are defined in ADR 0007.
- **One sticky comment**, updated in place on every run. Order: one-line verdict; per-file table with action `create`, `update`, `skip` or `suspected defect` (for `skip`, the existing test that already covers the code); the behaviours the agent derived, each with its source (ADR 0017), escaped as model text; independent verification for frontend and backend (typecheck, full suites, stability, changed-lines coverage before and after); run metadata (skills used, turns, cost); model narrative in a collapsed `<details>` marked untrusted.
- **The bot always comments**, including when it does nothing, and states why. The only exception is pull requests from forks (ADR 0008).
- **Bot commit** with the tests is pushed to the pull request branch only when verification passed, using a GitHub App token (ADR 0011). It carries a `Test-Agent-Run: <run id>` trailer; the workflow does not run the agent for commits with that trailer.

## Why

- The check gives a one-glance answer; the comment explains it without noise.
- Never pushing unverified tests keeps the pull request branch green-or-unchanged.
- The trailer prevents the agent from re-triggering on its own commit and ties each commit to a specific run.
