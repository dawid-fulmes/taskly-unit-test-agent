# Component test pattern (from `frontend/src/features/todos/components/TodoForm.test.tsx`)

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TodoForm } from './TodoForm'

vi.mock('../../../design-system', () => import('../../../design-system/mocks'))

describe('TodoForm', () => {
  it('rejects a whitespace-only title without submitting', async () => {
    const onSubmit = vi.fn()
    const user = userEvent.setup()
    render(<TodoForm onSubmit={onSubmit} onCancel={vi.fn()} busy={false} error={null} />)
    await user.type(screen.getByLabelText(/Task title/), '   ')
    await user.click(screen.getByRole('button', { name: 'Save task' }))
    expect(screen.getByText('Enter a task title.')).toBeVisible()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
```

Notes:
- The `vi.mock` line must use a literal path relative to the test file.
- Prefer `getByRole` and `getByLabelText`. Use `getByText` only for messages.
- Await every `user.*` call. Use `findBy…` for content that appears after an async update.
