---
name: frontend-unit-tests
description: Conventions for writing Vitest + React Testing Library unit tests for the Taskly React frontend (components, hooks, API client, utils), with user-event and accessible queries. Use when a manifest file's app is frontend.
---

# Frontend unit tests

Stack: React 19, TypeScript, Vite 6, TanStack Query 5, styled-components, Vitest 4 with jsdom, React Testing Library, `@testing-library/user-event`, `@testing-library/jest-dom` (loaded by `src/test/setup.ts`). Tests sit **next to** the file they test: `TodoForm.tsx` → `TodoForm.test.tsx` or `TodoForm.<topic>.test.tsx`.

## Patterns from this repository

- **Components**: render with props, drive them with `userEvent.setup()`, query by role or label (`getByRole('button', { name: 'Save task' })`, `getByLabelText(/Task title/)`), assert visible outcomes (`toBeVisible`, `toHaveValue`) and callback calls. Mock the design system at the top of the file: `vi.mock('../../../design-system', () => import('../../../design-system/mocks'))`, with the relative path adjusted. See `references/component.md`.
- **Hooks**: `renderHook` from `@testing-library/react`. Wrap state changes in `act`. Hooks that use TanStack Query need a `QueryClientProvider` wrapper with a fresh `QueryClient({ defaultOptions: { queries: { retry: false } } })`. See `references/hook.md`.
- **API client** (`features/todos/api/todos.ts`): mock `../../../lib/http` with `vi.mock(..., () => ({ request: vi.fn() }))` and assert the exact `request` arguments, as in `api/todos.test.ts`.
- **Shared data**: `todoFixture` from `src/test/todoFixture.ts`. Do not edit it; spread it for variations.
- No snapshot-only tests. Every test asserts behaviour a user or caller can observe.

## Rules the verifier enforces (a violation rejects the whole patch)

- Only new or appended test files matching `frontend/src/**/*.test.{ts,tsx}`. Never touch components, `src/test/*`, `design-system/mocks.tsx` or config files.
- Every new file contains at least one `expect(`. No `.skip`, `.only`, `.todo`, `.fails`, `.skipIf`, `.runIf`, no snapshot matchers.
- Do not name anything `it`, `test`, `describe`, `vi`, `expect` or `task`. Call a todo item `todo` or `item`.
- Do not use `Object.assign`, `Object.defineProperty`, `delete`, `arguments`, `require`, `Reflect`, `globalThis`, unicode or hex escapes (`\u…`, `\x…`), or `obj[key] = …` with a variable key.
- A dynamic `import()` is allowed only with a single string literal path, as in the design-system mock above.
- Do not import from `@vitest/*` or `vitest/<subpath>`. Import test functions only from `'vitest'`, without renaming them.
- In an **existing** file you may only append. The added lines must not use `vi.mock`, lifecycle hooks, `return` statements or `/* */` comments. If you need any of these, create a new file instead.
- The added code must compile, because the verifier runs `tsc --noEmit`.

## Running

```
test-agent-run frontend src/features/todos/components/TodoSearch.test.tsx
```

The run has no network and no environment variables. Tests run three times in random order under different time zones. Avoid real timers, `Date.now()` without `vi.useFakeTimers()` and a fixed time, and order dependencies.
