# ADR 0013: CODEOWNERS for the agent, workflows and verifier

Status: Accepted

## Context

During a pull request run, the agent, skills, hooks and verifier scripts are taken from the base branch (ADR 0008). Once a pull request is merged, though, its changes to those files become the new base. Changes to test and TypeScript config are already routed to a human (ADR 0012).

## Options

1. Rely on normal review for these paths.
2. Require review from designated owners via `CODEOWNERS`.

## Decision

Option 2. `CODEOWNERS` covers:

- `.claude/` (agent, skills, hooks, settings),
- `.github/` (workflows),
- the verifier scripts,
- `vitest.config.*`, `vite.config.*` and `tsconfig*.json`.

In this single-maintainer repository the owner cannot approve their own pull requests. The ruleset therefore allows an admin bypass, and this is documented as a limitation. An admin already has write access to `main` and is outside the threat model (ADR 0008).

## Why

- Taking tooling from base protects a single run; `CODEOWNERS` protects what base becomes.
- These are exactly the files that decide what the agent can do and how its output is judged.
