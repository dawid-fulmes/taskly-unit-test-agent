---
name: analyze-change
description: Decide create, update or skip for every file in the test-agent plan manifest, citing the exact existing test for every skip. Use first, right after reading plan.json, before writing any test.
---

# Analyze change

For **every** entry in `plan.json` → `manifest`, choose exactly one action. Record each decision; `test-report` turns them into `report.json`.

## Decision rules

1. **`excludedOnBase: true`** → `skip` with reason `excluded-from-coverage`. Do not write tests for it.
2. **Existing tests already cover the changed behaviour** → `skip`, citing one specific existing test:
   - `file`: the repo-relative test file path, e.g. `backend/tests/mappers.test.ts`.
   - `testName`: the test's **exact Vitest full name**. Get it by running the file with `test-agent-run` and copying the `fullName` field from the JSON report.
   - The verifier runs that one test file alone with coverage. The skip is accepted only if the test exists, passes, and covers at least 80% of the changed lines. If you are not sure, do not skip.
3. **No test file exists for the source file** → `create`. Name the new file after the source file:
   - backend: `backend/tests/<module>.test.ts`, or `backend/tests/<module>.<topic>.test.ts` if that name is taken;
   - frontend: next to the component or module, `<Name>.test.tsx` or `<Name>.<topic>.test.tsx`.
4. **A test file exists but misses the changed behaviour** → prefer `create` with a new topic file (`<module>.<topic>.test.ts`). Use `update` only when the addition is a few `it(...)` blocks appended at the end of the existing file that reuse its existing helpers, with no new mocks, hooks, `return` statements or block comments.

## How to check coverage of changed lines

- `changedLines` lists the lines that matter. Read those lines of the source file to see which functions and branches they belong to.
- Find candidate tests in `plan.json` → `testFiles`: backend tests are named after the module (`router.test.ts` for `features/todos/router.ts`), and frontend tests sit next to the component. Read the candidates and look for the function name, route path or component name.
- Run the candidate test file with `test-agent-run`. A passing test that clearly exercises the changed branch is a skip candidate. A test that only touches the file elsewhere is not.

## Output of this step

A list with one entry per manifest file: `path`, `action`, and `testFile` (for create/update) or the skip citation. Then continue with `derive-test-intent`.
