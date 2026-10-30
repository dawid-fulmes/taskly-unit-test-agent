# Repository test pattern (from `backend/tests/repository.test.ts`)

```ts
import { afterEach, it, expect, vi } from 'vitest';
import { createDatabase } from '../src/core/database.ts';
import { TodoRepository } from '../src/features/todos/repository.ts';
import { record, todo } from './fixture.ts';

afterEach(() => vi.restoreAllMocks());

function setup() {
  // Construct the real Prisma delegate, but mock its IO: no PostgreSQL is needed.
  const database = createDatabase('postgresql://test:test@localhost:5432/test');
  return { database, repository: new TodoRepository(database) };
}

it('lists tasks in newest-first order and maps database rows', async () => {
  const { database, repository } = setup();
  const findMany = vi.spyOn(database.todo, 'findMany').mockResolvedValue([record]);
  expect(await repository.list()).toEqual([todo]);
  expect(findMany).toHaveBeenCalledWith({ orderBy: [{ created_at: 'desc' }, { id: 'desc' }] });
});

it('gets a task by ID and handles missing tasks', async () => {
  const { database, repository } = setup();
  const findUnique = vi.spyOn(database.todo, 'findUnique').mockResolvedValueOnce(record).mockResolvedValueOnce(null);
  expect(await repository.get(1)).toEqual(todo);
  expect(findUnique).toHaveBeenCalledWith({ where: { id: 1 } });
  expect(await repository.get(2)).toBeNull();
});
```

Notes:
- `afterEach(() => vi.restoreAllMocks())` is fine in a **new** file. It is not allowed as an addition to an existing file.
- Assert the exact Prisma query object. That is where filters, ordering and `where` clauses live.
- Dates in `record` are `Date` objects, and in `todo` they are ISO strings. The mapper converts between them.
