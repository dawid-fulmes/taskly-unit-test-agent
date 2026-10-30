# ADR 0004: Code contradicting the spec is reported as a defect

Status: Accepted

## Context

When the changed code behaves differently from what the pull request description or the OpenAPI contract says, an agent can "make tests pass" by asserting the current, wrong behaviour. That locks the bug in.

## Options

1. Write tests that match the current code.
2. Write tests that match the spec and let them fail.
3. Do not bend the test; report a suspected defect.

## Decision

Option 3. The file gets the action `suspected defect` with the contradiction described, and the `test-agent/verified` check is red.

## Why

- Tests that encode a bug are worse than no tests.
- A red check forces a human decision on which side (code or spec) is wrong.
