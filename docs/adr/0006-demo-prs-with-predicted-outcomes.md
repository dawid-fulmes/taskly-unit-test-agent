# ADR 0006: Demo pull requests with predicted outcomes

Status: Accepted

## Context

A single happy-path demo shows that the workflow runs, but not that it makes correct decisions or resists abuse.

## Options

1. One example feature pull request.
2. Several pull requests covering distinct scenarios, with the expected outcome written down before each run.

## Decision

Option 2. Demo pull requests:

- documentation only,
- new feature spanning frontend and backend,
- refactor,
- feature with a deliberate bug,
- prompt injection attempt.

The expected verdict and per-file actions are recorded before the agent runs and compared with the actual result.

## Why

- Predicting outcomes up front turns the demo into a test of the agent rather than a showcase.
- The scenarios exercise skip, create/update, defect detection and security behaviour.
