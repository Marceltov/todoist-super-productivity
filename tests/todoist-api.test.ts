import { closeTask, filterTasks, getActiveTasks, getCompletedSince, getProjects, reopenTask, searchQuery, withRetry } from '../src/todoist-api';
import { fakeHttp, httpError } from './fake-http';
import { task } from './factories';

const API = 'https://api.todoist.com/api/v1';

test('filterTasks follows next_cursor across two pages', async () => {
  const { http, calls } = fakeHttp((c) =>
    c.params?.cursor === 'c1'
      ? { results: [task({ id: '3' })], next_cursor: null }
      : { results: [task({ id: '1' }), task({ id: '2' })], next_cursor: 'c1' });
  const tasks = await filterTasks(http, 'assigned to: me');
  expect(tasks.map((t) => t.id)).toEqual(['1', '2', '3']);
  expect(calls).toHaveLength(2);
  expect(calls[0]).toMatchObject({ url: `${API}/tasks/filter`, params: { query: 'assigned to: me', limit: '200' } });
  expect(calls[1].params).toMatchObject({ cursor: 'c1' });
});

test('filterTasks rejects >1024-char query without calling http', async () => {
  const { http, calls } = fakeHttp(() => ({ results: [], next_cursor: null }));
  await expect(filterTasks(http, 'x'.repeat(1025))).rejects.toThrow('Filter query is longer than 1024 characters');
  expect(calls).toHaveLength(0);
});

test('searchQuery neutralises operators', () => {
  expect(searchQuery('assigned to: me', 'milk & (eggs) | x')).toBe('(assigned to: me) & search: milk eggs x');
  expect(searchQuery('assigned to: me', '  ')).toBe('assigned to: me');
});

test('getActiveTasks chunks 250 ids into 3 requests', async () => {
  const { http, calls } = fakeHttp(() => ({ results: [], next_cursor: null }));
  await getActiveTasks(http, Array.from({ length: 250 }, (_, i) => String(i)));
  expect(calls).toHaveLength(3);
  expect(calls[0]).toMatchObject({ url: `${API}/tasks` });
  expect(calls[0].params!.ids.split(',')).toHaveLength(100);
  expect(calls[2].params!.ids.split(',')).toHaveLength(50);
});

test('getActiveTasks with no ids makes no request', async () => {
  const { http, calls } = fakeHttp(() => ({ results: [], next_cursor: null }));
  expect(await getActiveTasks(http, [])).toEqual([]);
  expect(calls).toHaveLength(0);
});

test('getCompletedSince queries by completion date and returns items', async () => {
  const { http, calls } = fakeHttp(() => ({ items: [{ task_id: '5', completed_at: '2026-11-30T10:00:00Z' }], next_cursor: null }));
  const items = await getCompletedSince(http, '2026-11-01T00:00:00Z');
  expect(items).toEqual([{ task_id: '5', completed_at: '2026-11-30T10:00:00Z' }]);
  expect(calls[0]).toMatchObject({ url: `${API}/tasks/completed/by_completion_date` });
  expect(calls[0].params).toMatchObject({ since: '2026-11-01T00:00:00Z' });
  expect(calls[0].params!.until).toBeTruthy();
});

test('getProjects follows the cursor', async () => {
  const { http } = fakeHttp((c) => c.params?.cursor
    ? { results: [{ id: 'p2', name: 'Home' }], next_cursor: null }
    : { results: [{ id: 'p1', name: 'Inbox' }], next_cursor: 'n' });
  expect(await getProjects(http)).toEqual([{ id: 'p1', name: 'Inbox' }, { id: 'p2', name: 'Home' }]);
});

test('closeTask posts to /tasks/9/close, reopenTask to /reopen', async () => {
  const { http, calls } = fakeHttp(() => null);
  await closeTask(http, '9');
  await reopenTask(http, '9');
  expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`POST ${API}/tasks/9/close`, `POST ${API}/tasks/9/reopen`]);
});

test('withRetry retries once after 429 with Retry-After 1', async () => {
  vi.useFakeTimers();
  let n = 0;
  const p = withRetry(async () => { if (n++ === 0) throw httpError(429, { 'Retry-After': '1' }); return 'ok'; });
  await vi.advanceTimersByTimeAsync(999);
  expect(n).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  await expect(p).resolves.toBe('ok');
  vi.useRealTimers();
});

test('withRetry rethrows other errors immediately', async () => {
  await expect(withRetry(async () => { throw httpError(500); })).rejects.toThrow('HTTP 500');
});
