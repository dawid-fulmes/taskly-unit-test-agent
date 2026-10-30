# ADR 0016: One reusable pipeline, and how bot commits are handled

Status: Accepted. Amended by ADR 0020: in `pr` mode the pipeline is started via `workflow_run` from `main`, and the trailer rule uses `workflow_run.triggering_actor` as the sender.

## Context

Two entry points, pull requests and backfill (ADR 0015), need the same gates. Bot commits land on pull request branches and would otherwise re-trigger the pipeline. Check runs on GitHub are attached to a specific SHA, so a required check set on an older head does not carry over to a new commit.

## Options

1. Separate workflows for pull requests and backfill, and re-verify every bot commit in the pull request pipeline.
2. One reusable workflow with stages `plan → generate → verify → publish` and a `mode` input (`pr` or `backfill`). Bot commits are verified before they are pushed and are not re-run through the agent pipeline.

## Decision

Option 2.

- **Stages.** `plan` builds the manifest, `generate` runs the agent, `verify` runs the gates on exactly the agent's patch against exactly the analysed head, `publish` pushes with a compare-and-swap on the head SHA (ADR 0008) and updates the comment.
- **Trailer authenticity.** The trailer counts only when the event's sender (with ADR 0020: `workflow_run.triggering_actor`) is our GitHub App. The bot login is read from a repository variable, not hard-coded. The commit author is ignored because it can be forged. In every other case the commit is treated as a normal commit and the pipeline runs as usual, so a forged trailer gains nothing.
- **Commits with an authentic `Test-Agent-Run` trailer.** The agent does not start and the gates do not run. The commit was already verified before it reached the branch. Regular CI, triggered because the push uses a GitHub App token (ADR 0011), independently checks the whole codebase.
- **Check run follows the SHA.** `publish` creates the `test-agent/verified` check run on the new bot commit, not only on the previous head, so a required check does not hang. A run triggered by a trailer commit never overwrites the check run or the comment.
- **Backfill mode.** The gates run inside the workflow before anything reaches the bot branch; only then is a pull request opened. The pull request pipeline sees the trailer and does nothing besides regular CI. In backfill mode a verified defect does not turn the check red; it is listed in the comment.

## Why

- One pipeline means one set of gates to secure and explain; the mode only changes the manifest source and the defect policy.
- Verifying the exact patch on the exact head, then pushing with compare-and-swap, makes re-verification of the bot commit redundant.
- Creating the check run on the bot commit is required for branch protection to work at all.
