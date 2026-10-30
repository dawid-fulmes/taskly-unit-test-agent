# ADR 0019: Jobs, permissions and verdict integrity

Status: Accepted

## Context

The pipeline has four stages (ADR 0016). Pull request code runs in some of them, and the verdict produced next to that code is what `publish` acts on. A malicious test could try to overwrite the verdict or the coverage report before it is handed over.

## Options

1. One job with all permissions.
2. Separate jobs with least privilege, pull request code isolated from where the verdict is computed, and `publish` re-checking what it can without running code.

## Decision

Option 2.

| Job | Secrets and permissions | Runs pull request code |
|---|---|---|
| `plan` | none; `contents: read` | no; diff and manifest only |
| `generate` | model API key | only through the sandboxed runner (ADR 0010) |
| `verify` | none; network only for `npm ci --ignore-scripts` | yes: baseline suites (head before the patch), suites after the patch, stability, coverage |
| `publish` | GitHub App token minted only in this job; `contents: write`, `checks: write`, `pull-requests: write` | never |

- All four jobs run in the pipeline started via `workflow_run` from `main`. The model API key and the App private key are in environments restricted to `main` (ADR 0020).
- `test-agent/verified` is a check run created by our GitHub App in `publish`, because only check runs support the `neutral` conclusion (ADR 0007). The repository ruleset requires this check with our App pinned as its source, so no other actor can create a passing `test-agent/verified`.
- In `verify`, tests run in a container with `--network none` against a copy of the workspace, and write raw results to a separate directory. The verdict is computed outside the container from those raw results.
- `publish` takes the patch from the `generate` artifact, not from `verify`, and checks its hash against the one `verify` verified. It then re-runs the cheap gates on the patch as data: allowed paths, no `.skip`/`.only`, no deleted tests.

### Accepted risk

The container does not fully close the gap: a malicious test can forge the raw results it produces itself. Only the pull request author can do this, and the only effect is a false green `test-agent/verified` on their own pull request plus our tests on their branch. Secrets stay safe, and nothing outside test files can be written. Regular CI is a separate required check that runs on the bot commit, so the real state still shows.

Two further residual risks were accepted during implementation:

- `prisma generate` executes pull request code (the `prisma` package from the head lockfile and `prisma.config.ts`; custom schema generators are rejected by the plan, ADR 0009) in a container with no network and no secrets, writing into the work copy that later runs reuse. Only the author's own pull request can be influenced.
- Tests written by the agent run in the same process as the Vitest task objects. The gates reject the known ways a test can reach and flip its own result (context and task access, reflection helpers, runner imports, `vitest/*` internals, dynamic imports, computed writes), but text gates over JavaScript cannot be complete. A prompt-injected agent could still write a test that reports itself as passing. The tests are visible in the pull request diff for human review; a separate trusted harness or mutation testing is a production extension.

## Why

- Each job holds only what it needs, and the write token never coexists with pull request code.
- Computing the verdict outside the container and re-checking the patch in `publish` limits what tampering can achieve to the author's own pull request.
- Closing the remaining gap fully would need a separate trusted execution environment, which is out of proportion for this risk.
