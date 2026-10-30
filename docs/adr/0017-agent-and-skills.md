# ADR 0017: One agent, six skills

Status: Accepted

## Context

The agent must handle a frontend and a backend with different testing conventions, run the same way locally, in the pull request pipeline and in backfill (ADR 0015), and be easy to extend to another package. Skills are loaded on demand based on their description.

## Options

1. One large agent prompt containing all instructions.
2. Several specialised agents, for example one per stack.
3. One agent with small skills, most of them stack-agnostic.

## Decision

Option 3. One agent, `unit-test-agent`, with six skills:

| Skill | Responsibility | Stack-specific |
|---|---|---|
| `analyze-change` | Reads the manifest from `plan` and decides `create`, `update` or `skip` per file. A `skip` must name a specific existing test. | no |
| `derive-test-intent` | Lists the behaviours to test from the PR description, OpenAPI, types and validators **before** reading the implementation body, so tests do not just restate the code. | no |
| `backend-unit-tests` | Backend conventions: Vitest, Supertest against the app factory, mocking the repository layer, shared fixtures. `references/` holds examples from this repository. | yes |
| `frontend-unit-tests` | Frontend conventions: React Testing Library, `user-event`, queries by role and label, no snapshot-only tests. `references/` holds examples from this repository. | yes |
| `run-and-triage` | Runs our sandboxed runner (ADR 0010), reads failures and classifies them: a test bug (fix, at most 3 attempts), code contradicting intent (suspected defect with evidence, ADR 0014), or an environment problem (stop). | no |
| `test-report` | Assembles the JSON report according to the schema. | no |

Principles:

- Four skills are shared; only two know the stack. Supporting a new package means adding one skill.
- The same skills run locally, in the pull request pipeline and in backfill.
- Anything that can be computed is done by a script; a skill only says when to run it.
- Every skill has a precise `description`, because that is what triggers loading it.
- "Intent before implementation" is not enforced by a hook: the agent legitimately needs to read types and neighbouring files, so a read block would be brittle. Instead, the list of behaviours, each with its source (PR description, OpenAPI, type, validator), appears in the report and in the comment, so a reviewer can see whether a test follows from intent or from the code.

## Why

- Small, focused skills are easier to review, test and reuse than one long prompt.
- Writing down intent before reading the implementation is the main defence against tests that merely mirror the code.
- Keeping computation in scripts follows ADR 0002: the model proposes, deterministic code decides.
