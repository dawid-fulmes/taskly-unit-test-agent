---
name: run-and-triage
description: Run the written tests with test-agent-run, classify every failure as a test bug, a code-versus-intent defect, or an environment problem, fix test bugs (max 3 attempts per file) and back suspected defects with an evidence test and a citation. Use after writing tests and before writing the report.
---

# Run and triage

Run each test file you wrote:

```
test-agent-run <backend|frontend> <path relative to the app dir>
```

Read the JSON report. For every failing test, look at `failureMessages` and classify it.

## 1. Test bug (wrong setup, wrong import, wrong expectation about something no source defines)

Fix **your test**, never the source. You get at most **3 attempts per test file**. If the file still fails after the third attempt, overwrite it with empty content using `Write`. An empty new file is dropped from the patch. Then record the manifest file as `gave-up`. If you appended to an existing file, `Edit` your appended lines away again. Do not remove assertions just to make a test pass.

## 2. The code contradicts its intent (a suspected defect)

This applies when a test asserts behaviour that a source states (`backend/openapi.json` or the PR description), and the code does something else.

- **Do not bend the test.** Remove that test case from the regular test file so the committed tests pass.
- Write an **evidence test** that asserts the intended behaviour, in an `__evidence__` directory:
  - backend: `backend/tests/__evidence__/<topic>.test.ts`
  - frontend: `frontend/src/<same dir as the component>/__evidence__/<topic>.test.tsx`
- The evidence test must **fail on an assertion** (an `expect(...)` mismatch). An import error, a syntax error or a thrown `TypeError` does not count. Run it and confirm the failure message starts with `AssertionError`.
- Keep it minimal: one `it` with the request or render, and the assertion that shows the contradiction.
- Add a citation:
  - `{ "kind": "openapi", "pointer": "/paths/~1api~1todos/get/responses/422" }`, a JSON pointer that must exist in `backend/openapi.json` (escape `/` in keys as `~1`), or
  - `{ "kind": "pr-description", "quote": "..." }`, copied **verbatim** from `plan.json` → `description`, at least 10 characters with real words.
- The verifier runs the evidence test 3 times on the PR head and checks the citation. If it does not fail 3 times on an assertion, or the citation does not resolve, the defect claim is rejected.
- In backfill mode, defects are reported but never block.

## 3. Environment problem (cannot load modules, Prisma client missing, runner errors)

Do not try to work around it. Stop working on that file, record it as `gave-up`, and describe the problem in the narrative.

## Before you finish

- Run every remaining test file once more. All of them must pass, apart from evidence tests, which must fail.
- Run the full file (not a single test) for each create/update. The verifier will also run the whole suite, a typecheck and three stability runs.
