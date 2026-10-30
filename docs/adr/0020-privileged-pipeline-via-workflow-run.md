# ADR 0020: The privileged pipeline runs via `workflow_run` from `main`

Status: Accepted. Changes ADR 0016 (where the pipeline is triggered) and refines ADR 0008 and ADR 0019.

## Context

For `pull_request` events, GitHub takes workflow definitions from the pull request's merge ref, not from the base branch. A same-repository pull request author can therefore edit the pipeline in their own branch. That edited pipeline could read the model API key and the GitHub App private key, and could then create a green `test-agent/verified` itself. Checking out trusted scripts from base does not help when the workflow YAML itself is untrusted. This breaks ADR 0008 ("trusted tooling from base") and ADR 0019 ("no other actor can create a passing check").

## Options

1. Keep `pull_request` and narrow the threat model so that anyone with push access is out of scope.
2. Split the pipeline. An unprivileged `pull_request` workflow only records which pull request and commit to process. The whole pipeline runs via `workflow_run` from the definition on `main`, with secrets in environments restricted to `main`.

## Decision

Option 2.

- **Trigger workflow** (`pull_request`, no secrets, read-only permissions) uploads an artifact with the pull request number and head SHA. The artifact is untrusted data.
- **Pipeline workflow** (`workflow_run` on completion of the trigger workflow) always runs from `main`. It confirms through the API that the pull request exists and that its current head SHA equals both the artifact's SHA and `workflow_run.head_sha`. Otherwise it stops.
- Identity comes from the event, not the artifact: `workflow_run.triggering_actor` is used for the trailer rule (ADR 0016) and for who added a label.
- The model API key and the App private key live in environments whose deployment branches are restricted to `main`. A workflow edited on a pull request branch cannot enter them.
- If a pull request deletes or breaks the trigger workflow, no pipeline runs and the required check never appears, so merging stays blocked (fail-closed).
- Backfill (`workflow_dispatch`) uses the same reusable pipeline and the same `main`-restricted environments.
- Forks stay disabled in v1: the pipeline stops for pull requests whose head repository differs from the base repository. Because the privileged part already never runs pull request YAML, enabling forks later is a small, separate change.

## Why

- This is the documented safe pattern for running privileged steps on untrusted pull requests. Unlike `pull_request_target`, the privileged workflow never executes workflow code from the pull request.
- It restores the threat model as stated: a pull request author cannot read secrets or create the required check.
- It costs one small extra workflow and an API check, which is proportionate.
