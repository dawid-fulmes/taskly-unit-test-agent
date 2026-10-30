# ADR 0015: Coverage backfill is a mode of the same agent

Status: Accepted

## Context

Besides reacting to pull requests, the assignment requires adding missing unit tests and raising coverage across the existing frontend and backend. The tests in the repository must be written by the agent, not by hand, because they are part of the demo.

## Options

1. A separate backfill agent with its own skills.
2. The same agent and skills in a different mode, with its output going through the normal pull request pipeline.
3. Writing the backfill tests by hand.

## Decision

Option 2.

- **Trigger.** A separate workflow on `workflow_dispatch` with inputs `app` (`frontend` or `backend`) and `max_files` (default 8).
- **Target.** About 90% line coverage in each app. Backfill is repeated, run after run, until the target is reached or the backfill budget is spent. Coverage before the first run and after the last is reported from the real runs.
- **Manifest.** Not a diff: the files with the most uncovered lines according to a fresh coverage run, up to `max_files`.
- **Output.** Backfill runs the same reusable pipeline as pull requests with `mode: backfill` (ADR 0016). The same gates run inside the workflow before anything reaches the bot branch, and only then is a pull request opened, so backfill gets no special trust. The pull request pipeline sees the `Test-Agent-Run` trailer and leaves the pull request to regular CI.
- **One pull request per app**, so each is reviewable on its own.
- **Model key** lives in a separate GitHub environment with required reviewers, because backfill is manual and costs more. The pull request pipeline does not use that environment, since a required review would block every run.
- **Intent without a pull request description.** Expected behaviour comes only from OpenAPI, types and validators. Where none of them defines the behaviour, the agent writes a characterization test and marks it as such.
- **Defects in backfill** do not block anything; they are listed in the comment for review.
- **Ratchet.** After merging, coverage thresholds in `vitest.config.*` are raised to just below the level reached, so the gap does not come back. This is a small pull request made by a human, because agent patches may only touch test files and config changes go through `CODEOWNERS` (ADR 0012, ADR 0013).

## Why

- One agent and one skill set means one thing to secure, test and explain.
- Routing backfill through the pull request pipeline avoids a second, less-guarded path into the codebase.
- Characterization tests are honest about pinning current behaviour rather than claiming it is correct.
- An approval gate on the expensive manual run is cheap; on every pull request it would be friction.
