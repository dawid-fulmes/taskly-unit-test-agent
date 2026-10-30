# ADR 0007: Check conclusion semantics

Status: Accepted

## Context

The `test-agent/verified` check run (ADR 0003) needs a clear rule for when it is green, red or neutral. If the check turns red whenever the agent itself fails, teams learn to ignore it or disable it. The bot always comments (ADR 0003), so every outcome also needs a stated reason.

## Options

1. Red on any non-success, including agent failures.
2. Red only for problems in the pull request's code; neutral for agent-side failures and cases where the agent did not run.

## Decision

Option 2.

| Outcome | Conclusion | Agent runs | Commit |
|---|---|---|---|
| Tests created/updated and verified | success | yes | yes |
| All changes already covered by existing tests | success | yes | no |
| Nothing to test (no source changes) | success | no | no |
| Draft pull request | neutral | no | no |
| Test or TypeScript config changed (ADR 0012) | neutral | no | no |
| Pull request from a fork | no check, no comment (limitation, ADR 0008) | no | no |
| Budget exhausted, timeout, or the agent's patch failed verification | neutral | yes | no |
| Suspected defect with verified evidence (ADR 0014) | failure | yes | the other tests, only if all of them passed verification; the evidence test is never committed |
| Suspected defect dismissed by a human with the `dismiss` label | neutral | — | — |
| Suspected defect in backfill mode (ADR 0016) | not affected; listed in the comment | yes | the other tests, only if all of them passed verification |

When several outcomes apply in one run, precedence is failure > neutral > success. Commits are all-or-nothing: if any test file in the patch fails verification, nothing is committed. Before handing over to `verify`, the agent itself drops test files it could not fix within 3 attempts; those files are listed in the comment and do not block committing the rest.

In every case the sticky comment states the reason. For the cases where the agent fails (budget, timeout, failed verification), the comment explains how to re-run with a larger budget via a label.

## Why

- Red means "something is wrong with this code", never "the tool had a bad day". That keeps the signal trustworthy.
- An agent failure leaves the branch untouched, so there is nothing to block.
- A failing check caused by the tool is the fastest way to get the check disabled.
- On GitHub, a neutral conclusion counts as passing for required status checks, so neutral does not block merging. `neutral` exists only for check runs, not for commit statuses, which is why `test-agent/verified` is a check run (ADR 0019).
