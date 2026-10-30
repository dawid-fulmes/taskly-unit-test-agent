# ADR 0001: Claude Code custom subagent with repo-local skills

Status: Accepted

## Context

The assignment requires a custom agent with reusable skills that runs automatically on GitHub pull requests and covers both the frontend (React + TypeScript) and the backend (Node.js + Express + Prisma).

## Options

1. Claude Code with a custom subagent (`.claude/agents/`) and skills (`.claude/skills/`) versioned in the repo.
2. A bespoke agent loop built directly on an LLM API or agent SDK.
3. A hosted coding agent configured outside the repo.

## Decision

Use Claude Code. The agent is a custom subagent, and its capabilities are packaged as skills. Both live in the repository next to the code they test.

## Why

- Subagents and skills map one-to-one onto "custom agent + reusable skills", so the solution's structure matches the assignment's vocabulary.
- Agent and skill definitions are reviewed and versioned like any other code, and the same definitions run locally and in CI.
- No custom agent loop to build and maintain, which keeps the solution simple and defensible.
