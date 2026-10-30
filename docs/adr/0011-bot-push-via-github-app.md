# ADR 0011: Bot commits are pushed with a GitHub App token

Status: Accepted

## Context

Pushes made with the workflow's `GITHUB_TOKEN` do not trigger other workflows. If the bot pushed with `GITHUB_TOKEN`, regular CI would not run on the commit that adds the tests.

## Options

1. Push with `GITHUB_TOKEN` and accept that CI does not run on the bot commit.
2. Push with a GitHub App installation token.

## Decision

Option 2. The bot commit is pushed with a GitHub App token, so regular CI runs on it. The `Test-Agent-Run` trailer (ADR 0003) still stops the agent from running on its own commit.

## Why

- The tests the bot adds go through the same CI as human-written code.
- An App identity is scoped to this repository and is clearly labelled as a bot in the history.
