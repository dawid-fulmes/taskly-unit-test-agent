# ADR 0010: Sandboxed test runner for the agent

Status: Accepted

## Context

The agent needs to run tests while it works. The Claude Code process holds the model API key in its environment, and child processes inherit it by default. Tests are pull request code, so they must never see the key or reach the network.

## Options

1. Let the agent run `npm test` through its normal shell tool.
2. Give the agent a single runner that executes Vitest with an empty environment and no network.

## Decision

Option 2. The only way the agent can execute code is one runner that starts Vitest with `env -i` and no network access, either inside the Claude Code sandbox or in a container with `--network none`. The model API key is never visible to tests.

## Why

- Removing the key from the test process's environment is a hard boundary, not a prompt instruction.
- A single runner keeps the agent's executable surface small and auditable.
