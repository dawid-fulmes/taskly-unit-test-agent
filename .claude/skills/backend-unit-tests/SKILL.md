---
name: backend-unit-tests
description: Conventions for writing Vitest + Supertest unit tests for the Taskly Express/Prisma backend (routers, repository, validators, mappers) without a database. Use when a manifest file's app is backend.
---

# Backend unit tests

Stack: Node 22, Express 5, Prisma 7 with a pg adapter, zod 4, Vitest 4, Supertest. Tests live in `backend/tests/` and import sources with `.ts` extensions (`../src/features/todos/router.ts`). **No PostgreSQL is available.** Never open a real connection.

## Patterns from this repository

- **Routers**: build a tiny Express app around the router with a mocked `TodoStore`, then call it with Supertest. Copy the shape in `references/router.md`. Assert the status code, the response body, and the exact repository call (`toHaveBeenCalledWith`, `not.toHaveBeenCalled()` for rejected input).
- **Repository**: construct the real Prisma delegate with `createDatabase('postgresql://test:test@localhost:5432/test')` and spy on its methods (`vi.spyOn(database.todo, 'findMany').mockResolvedValue(...)`). See `references/repository.md`. Assert both the mapped return value and the exact Prisma arguments.
- **Validators and mappers**: pure functions. Use `parse`/`safeParse` and `it.each` tables for invalid inputs, as in `tests/validators.test.ts`.
- **Shared data**: import `record` (database row) and `todo` (API shape) from `tests/fixture.ts`. Do not edit the fixture; build variations inline with spreads, e.g. `{ ...todo, title: 'Other' }`.
- **API contract**: `backend/openapi.json` defines statuses and shapes. Validation errors are `422` with `{ detail: [...] }`, a missing item is `404` with `{ detail: 'Task not found.' }`.

## Rules the verifier enforces (a violation rejects the whole patch)

- Only new or appended test files under `backend/tests/**/*.test.ts`. Never touch `src/`, `fixture.ts` or config files.
- Every new file contains at least one `expect(`. No `.skip`, `.only`, `.todo`, `.fails`, `.skipIf`, `.runIf`, no snapshot matchers.
- Do not name anything `it`, `test`, `describe`, `vi`, `expect` or `task`. Call a todo item `todo` or `item`.
- Do not use `Object.assign`, `Object.defineProperty`, `delete`, `arguments`, `require`, `Reflect`, `globalThis`, dynamic `import()` with a non-literal path, unicode or hex escapes (`\u…`, `\x…`), or `obj[key] = …` with a variable key.
- Do not import from `@vitest/*` or `vitest/<subpath>`. Import test functions only from `'vitest'`, without renaming them.
- In an **existing** file you may only append. The added lines must not use `vi.mock`, lifecycle hooks (`beforeEach` …), `return` statements or `/* */` comments. If you need any of these, create a new file instead.
- Use LF line endings only. The added code must compile, because the verifier runs `tsc --noEmit`.

## Running

```
test-agent-run backend tests/router.count.test.ts
```

The run has no network and no environment variables. The tests must pass three times in random order, under the `UTC`, `America/Los_Angeles` and `Asia/Kolkata` time zones. Avoid `new Date()` without fixed input, real timers and test order dependencies.
