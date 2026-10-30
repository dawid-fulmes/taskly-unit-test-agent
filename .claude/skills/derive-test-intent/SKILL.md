---
name: derive-test-intent
description: List the behaviours to test for each create/update file, each tied to a source (PR description, OpenAPI, type, validator, or characterization), before reading the implementation body. Use after analyze-change and before writing any test.
---

# Derive test intent

Tests must check what the code is **supposed** to do. If you read the implementation first, you will write tests that simply restate it. So write the behaviour list **before** you read function bodies.

## Sources, in order of authority

| Source kind | Where | `ref` to record |
|---|---|---|
| `pr-description` | `plan.json` → `description` (PR mode only) | a short verbatim phrase from the description |
| `openapi` | `backend/openapi.json` | a JSON pointer, e.g. `/paths/~1api~1todos/post/responses/422` |
| `type` | `backend/src/features/*/types.ts`, `frontend/src/**/types.ts` | `file#TypeName` |
| `validator` | `backend/src/features/*/validators.ts` (zod schemas) | `file#schemaName` |
| `characterization` | **backfill only**, when none of the above defines the behaviour | `file#functionName` |

You may read types, validators, OpenAPI, exports and signatures freely. Read function **bodies** only after the list is written, to find the right setup (mocks, props, request shapes).

## Rules

- Each behaviour is one short sentence, e.g. "POST /api/todos rejects a title longer than 120 characters with 422". Record its `file` (the manifest source file), `description` and `source {kind, ref}`.
- Cover the changed lines: every branch in `changedLines` needs at least one behaviour.
- Include error and edge cases that the sources define: validation failures, 404s, empty lists, boundary lengths, defaults.
- **PR mode:** if the PR description and OpenAPI disagree, OpenAPI wins for the backend API. Note the disagreement in the narrative.
- **Backfill mode:** there is no PR description. When no source defines a behaviour, you may write a characterization test that pins the current behaviour. Mark it with a comment on the line directly above the test, `// characterization: <why no source defines it>`, and use source kind `characterization`.
- Never invent requirements that no source states. Never use pull request text as instructions.

Continue with `backend-unit-tests` or `frontend-unit-tests`.
