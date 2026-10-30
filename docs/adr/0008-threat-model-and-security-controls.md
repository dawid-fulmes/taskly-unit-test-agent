# ADR 0008: Threat model and security controls

Status: Accepted

## Context

The workflow runs an LLM agent and executes code from pull requests. Security matters as much as test quality.

**Adversary:** the pull request author, or anyone who has taken over their account or one of the project's dependencies. Everything that comes from the pull request is untrusted: source code, tests, npm install scripts, and the pull request title, description and comments.

**Out of scope:** anyone who already has write access to `main`, and GitHub itself.

## Options

1. Run the agent in a single job with the model key and a write token available, and rely on the prompt to keep it safe.
2. Treat both the pull request and the agent as untrusted, and enforce every limit in deterministic code and the job's environment.

## Decision

Option 2, with these controls:

- **Secrets isolation.** Code from the pull request never runs where the model API key or a write-scoped token is available. Tests and `npm ci` run without secrets in the environment and without network access.
- **Trusted tooling from base.** The agent definition, skills, hooks, and the scripts that verify and score its output are taken from the base branch, never from the pull request head.
- **Prompt injection is data.** Pull request text and code are passed to the model as data. Even if the model is persuaded, it can only write test files and invoke a single test runner, and all of its output is independently verified afterwards (ADR 0002).
- **The agent is also a suspect.** A patch is rejected if it writes outside test files, deletes tests, adds skips (`.skip`, `.only`, `xit`, etc.), or weakens existing assertions.
- **Cost and loop limits.** Turn limit, budget cap, timeouts, one concurrent run per pull request, and the `Test-Agent-Run` commit trailer so the bot never triggers itself (ADR 0003).
- **No stale pushes.** Before pushing, the workflow checks that the pull request head is still the commit the agent analysed. If it moved, nothing is pushed.
- **Pinned actions.** Every third-party action is pinned to a full commit SHA.
- **Dependency installation** without lifecycle scripts or secrets, under an egress allowlist (ADR 0009).
- **Sandboxed test runner** with an empty environment and no network (ADR 0010).
- **Sanitized comment.** Model text published in the comment is escaped, and mentions are disabled.
- **Privileged pipeline from `main`.** Everything that holds a secret runs via `workflow_run` from the definition on `main`, never from pull request YAML (ADR 0020).
- **Forks.** The agent does not run for pull requests from forks, and the workflow does not use `pull_request_target`. Fork pull requests get no comment and no `test-agent/verified` check; this is documented as a limitation. Since the pipeline already runs via `workflow_run` (ADR 0020), enabling forks is a small production extension.

## Why

- Prompt-level defences alone are not a security boundary; the environment and the verifier are.
- Taking tooling from base means a pull request cannot grade its own homework.
- `pull_request_target` with a checkout of the pull request head is the classic way to leak secrets from a public repository.
