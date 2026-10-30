# Hook test patterns

Plain hook (from `frontend/src/hooks/useNotice.test.ts`):

```ts
import { renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'
import { useNotice } from './useNotice'

it('starts without a notice and exposes a notification callback', () => {
  const { result } = renderHook(() => useNotice())
  expect(result.current.message).toBe('')
  expect(result.current.notify).toEqual(expect.any(Function))
})
```

Query hook (TanStack Query) in a new file:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { expect, it, vi } from 'vitest'
import { request } from '../../../lib/http'
import { todoFixture } from '../../../test/todoFixture'
import { useTodosQuery } from './useTodosQuery'

vi.mock('../../../lib/http', () => ({ request: vi.fn() }))

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

it('loads todos through the API client', async () => {
  vi.mocked(request).mockResolvedValue([todoFixture])
  const { result } = renderHook(() => useTodosQuery(), { wrapper })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(result.current.data).toEqual([todoFixture])
})
```

Check the hook's real signature and return shape in its source before you write assertions.
