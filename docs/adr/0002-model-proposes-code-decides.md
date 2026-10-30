# ADR 0002: The model proposes, deterministic code decides

Status: Accepted

## Context

The agent writes tests and describes what it did. A model's self-report can be wrong, optimistic, or manipulated through content in the pull request (code under test is untrusted). Reviewers need numbers and statuses they can trust.

## Options

1. Trust the agent's report and publish it as the result.
2. Let the agent produce changes only. Deterministic workflow code runs the checks and derives every number and status.

## Decision

Option 2. The model only proposes test changes and per-file decisions. All numbers and statuses shown on the pull request (check result, test counts, stability, coverage, cost, turns) come from deterministic code that runs independently of the model. Free-text output from the model is published only inside a collapsed section labelled as untrusted and never feeds any status.

## Why

- A prompt injection or hallucination cannot turn a red result green.
- Results are reproducible and auditable from workflow logs.
- Security is treated as equally important as test quality, because pull request code is untrusted input.
