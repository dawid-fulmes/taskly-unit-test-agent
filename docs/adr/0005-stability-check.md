# ADR 0005: Stability check scope

Status: Accepted

## Context

Generated tests can be flaky: order-dependent, timezone-dependent, or relying on shared state. Rerunning everything many times is slow and mostly re-tests code nobody changed.

## Options

1. Run the full suites N times.
2. Run the full suites once, and run only new or changed test files multiple times under perturbed conditions.

## Decision

Option 2. Full frontend and backend suites run once. New and changed test files run 3 times in random order, each with a different timezone.

## Why

- Flakiness risk is concentrated in the tests the agent just wrote.
- Random order and timezone changes catch the most common hidden dependencies at low cost.
