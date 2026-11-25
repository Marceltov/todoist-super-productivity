import { RefreshCache } from '../src/interval';
import { OccurrenceBook } from '../src/occurrences';
import { createProvider } from '../src/provider';
import { API } from '../src/todoist-api';
import type { TodoistTask } from '../src/types';
import { due, rec, task } from './factories';
import { type Call, fakeHttp, httpError } from './fake-http';

const memoryStorage = () => { let d: string | null = null; return { load: async () => d, save: async (x: string) => { d = x; } }; };

const setup = async (o: { token?: string | null; now?: () => number } = {}) => {
  const book = await OccurrenceBook.load(memoryStorage());
  const cache = new RefreshCache(o.now ?? (() => 0));
  const provider = createProvider({ getToken: async () => (o.token === undefined ? 'tok' : o.token), book, cache });
  return { book, cache, provider };
};
const cfg = (o: Record<string, unknown> = {}) => ({ filterQuery: 'assigned to: me', checkInterval: '5m', ...o });
const page = (results: unknown[]) => ({ results, next_cursor: null });

/** Routes fake Todoist calls: filter results, active tasks by id, completed items. */
/** Routes fake Todoist calls. `active`: open tasks; `closed`: closed tasks (only GET /tasks/{id} returns them). */
const todoist = (d: { filter?: TodoistTask[]; active?: TodoistTask[]; closed?: TodoistTask[]; projects?: unknown[] }) =>
  (c: Call) => {
    if (c.url === `${API}/tasks/filter`) return page(d.filter ?? []);
    if (c.url === `${API}/tasks`) {
      const ids = c.params!.ids.split(',');
      return page((d.active ?? []).filter((t) => ids.includes(t.id)));
    }
    const single = c.method === 'GET' && c.url.match(/\/tasks\/([^/]+)$/);
    if (single) {
      const t = [...(d.active ?? []), ...(d.closed ?? [])].find((x) => x.id === single[1]);
      if (!t) throw httpError(404);
      return t;
    }
    if (c.url === `${API}/projects`) return page(d.projects ?? []);
    return null;
  };

describe('config', () => {
  test('has filter, interval and projects fields, and no token field', async () => {
    const { provider } = await setup();
    const keys = provider.configFields.map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(['filterQuery', 'checkInterval', 'projectIds']));
    expect(provider.configFields.some((f) => f.type === 'password' || /token/i.test(f.key))).toBe(false);
    expect(provider.configFields.find((f) => f.key === 'projectIds')!.type).toBe('multiSelect');
  });

  test('filter hint says to leave it empty and explains the default in words', async () => {
    const { provider } = await setup();
    const f = provider.configFields.find((x) => x.key === 'filterQuery')!;
    expect(f.label).toBe('Todoist filter (optional)');
    expect(f.description).toBe(
      'Leave empty to import tasks assigned to you plus unassigned tasks in your own projects ' +
      '(assigned to: me | (!assigned & !shared)). Narrow it further with Projects below.',
    );
  });

  test('loadOptions returns projects as label/value', async () => {
    const { provider } = await setup();
    const { http } = fakeHttp(todoist({ projects: [{ id: 'p1', name: 'Home' }] }));
    const field = provider.configFields.find((f) => f.key === 'projectIds')!;
    expect(await field.loadOptions!(cfg(), http)).toEqual([{ label: 'Home', value: 'p1' }]);
  });

  test('getHeaders: Bearer token, or nothing without token', async () => {
    expect(await (await setup()).provider.getHeaders(cfg())).toEqual({ Authorization: 'Bearer tok' });
    expect(await (await setup({ token: null })).provider.getHeaders(cfg())).toEqual({});
  });

  test('no token → testConnection false without calling Todoist', async () => {
    const { provider } = await setup({ token: null });
    const { http, calls } = fakeHttp(todoist({}));
    expect(await provider.testConnection!(cfg(), http)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test('testConnection: true when the filter runs, false on error', async () => {
    const { provider } = await setup();
    expect(await provider.testConnection!(cfg(), fakeHttp(todoist({})).http)).toBe(true);
    expect(await provider.testConnection!(cfg(), fakeHttp(() => { throw httpError(401); }).http)).toBe(false);
  });
});

describe('import', () => {
  test('searchIssues runs the filter with the term, live', async () => {
    const { provider } = await setup();
    const { http, calls } = fakeHttp(todoist({ filter: [task({ id: '1', content: 'Milk' })] }));
    const r = await provider.searchIssues('milk', cfg(), http);
    await provider.searchIssues('milk', cfg(), http);
    expect(r).toEqual([expect.objectContaining({ id: '1', title: 'Milk' })]);
    expect(calls[0].params!.query).toBe('(assigned to: me) & search: milk');
    expect(calls).toHaveLength(2);
  });

  test('empty filter setting uses the default: mine, plus unassigned in my own projects', async () => {
    const { provider } = await setup();
    const { http, calls } = fakeHttp(todoist({}));
    await provider.getNewIssuesForBacklog!(cfg({ filterQuery: '' }), http);
    expect(calls[0].params!.query).toBe('assigned to: me | (!assigned & !shared)');
  });

  test('project selection filters backlog and search; empty selection keeps all', async () => {
    const tasks = [task({ id: '1', project_id: 'home' }), task({ id: '2', project_id: 'shared' })];
    const { provider } = await setup();
    const { http } = fakeHttp(todoist({ filter: tasks }));
    expect((await provider.searchIssues('', cfg({ projectIds: ['home'] }), http)).map((r) => r.id)).toEqual(['1']);
    expect((await provider.getNewIssuesForBacklog!(cfg({ projectIds: ['home'] }), http)).map((r) => r.id)).toEqual(['1']);
    const fresh = await setup();
    expect((await fresh.provider.getNewIssuesForBacklog!(cfg({ projectIds: [] }), http)).map((r) => r.id)).toEqual(['1', '2']);
  });

  test('backlog result is served from cache within interval', async () => {
    let now = 0;
    const { provider } = await setup({ now: () => now });
    const { http, calls } = fakeHttp(todoist({ filter: [task({ id: '1' })] }));
    await provider.getNewIssuesForBacklog!(cfg(), http);
    now = 299_000;
    await provider.getNewIssuesForBacklog!(cfg(), http);
    expect(calls).toHaveLength(1);
    now = 300_000;
    await provider.getNewIssuesForBacklog!(cfg(), http);
    expect(calls).toHaveLength(2);
  });

  test('recurring: backlog imports one occurrence; search does not block it', async () => {
    const { provider } = await setup();
    const { http } = fakeHttp(todoist({ filter: [rec('5', '2026-11-30')] }));
    expect((await provider.searchIssues('', cfg(), http)).map((r) => r.id)).toEqual(['5@2026-11-30']);
    expect((await provider.getNewIssuesForBacklog!(cfg(), http)).map((r) => r.id)).toEqual(['5@2026-11-30']);
  });

  test('recurring: next occurrence is not imported while the previous is open', async () => {
    let now = 0;
    const { provider, book } = await setup({ now: () => now });
    book.idToImport(rec('5', '2026-11-30'));
    const { http } = fakeHttp(todoist({ filter: [rec('5', '2026-12-07')] }));
    expect(await provider.getNewIssuesForBacklog!(cfg(), http)).toEqual([]);
    expect(await provider.searchIssues('', cfg(), http)).toEqual([]);
  });
});

describe('refresh', () => {
  test('found one-off task maps to an issue; fresh cache avoids a second call', async () => {
    let now = 0;
    const { provider } = await setup({ now: () => now });
    const { http, calls } = fakeHttp(todoist({ active: [task({ id: '1', content: 'Milk', due: due('2026-11-30') })] }));
    const [i] = await provider.getByIds!(['1'], cfg(), http);
    expect(i).toMatchObject({ id: '1', title: 'Milk', checked: false, dueDay: '2026-11-30' });
    now = 1000;
    await provider.getByIds!(['1'], cfg(), http);
    expect(calls).toHaveLength(1);
  });

  test('getById returns one issue, throws when nothing comes back', async () => {
    const { provider } = await setup();
    const { http } = fakeHttp(todoist({ active: [task({ id: '1' })] }));
    expect((await provider.getById('1', cfg(), http)).id).toBe('1');
    const p = await setup();
    const err = fakeHttp(() => { throw httpError(500); });
    await expect(p.provider.getById('2', cfg(), err.http)).rejects.toThrow();
  });

  test('closed in Todoist (not in batch, single get says checked) → checked true', async () => {
    const { provider } = await setup();
    const { http } = fakeHttp(todoist({ closed: [task({ id: '1', content: 'Milk', checked: true })] }));
    expect((await provider.getByIds!(['1'], cfg(), http))[0]).toMatchObject({ id: '1', title: 'Milk', checked: true, state: 'done' });
  });

  test('deleted in Todoist (404) → state deleted', async () => {
    const { provider } = await setup();
    const { http } = fakeHttp(todoist({}));
    expect((await provider.getByIds!(['1'], cfg(), http))[0]).toMatchObject({ id: '1', state: 'deleted' });
    expect(provider.deletedStates).toEqual(['deleted']);
  });

  test('network error in getByIds propagates and marks nothing', async () => {
    const { provider, book } = await setup();
    const { http } = fakeHttp(() => { throw httpError(503); });
    await expect(provider.getByIds!(['5@2026-11-30', '1'], cfg(), http)).rejects.toThrow('HTTP 503');
    expect(book.isCompleted('5@2026-11-30')).toBe(false);
  });

  test('error while looking up a missing task propagates (never "deleted")', async () => {
    const { provider } = await setup();
    const { http } = fakeHttp((c) => { if (c.url === `${API}/tasks/1`) throw httpError(500); return page([]); });
    await expect(provider.getByIds!(['1'], cfg(), http)).rejects.toThrow('HTTP 500');
  });

  test('recurring completed in Todoist (count up) → done; rescheduled (count same) → open with new due', async () => {
    const a = await setup();
    a.book.idToImport(rec('5', '2026-11-30', { completed_count: 1 }));
    const done = fakeHttp(todoist({ active: [rec('5', '2026-12-07', { completed_count: 2 })] }));
    expect((await a.provider.getByIds!(['5@2026-11-30'], cfg(), done.http))[0]).toMatchObject({ id: '5@2026-11-30', checked: true });
    const b = await setup();
    b.book.idToImport(rec('5', '2026-11-30', { completed_count: 1 }));
    const moved = fakeHttp(todoist({ active: [rec('5', '2026-12-01', { completed_count: 1 })] }));
    expect((await b.provider.getByIds!(['5@2026-11-30'], cfg(), moved.http))[0])
      .toMatchObject({ id: '5@2026-11-30', checked: false, dueDay: '2026-12-01' });
  });

  test('recurring present in batch needs no single lookups', async () => {
    const { provider } = await setup();
    const { http, calls } = fakeHttp(todoist({ active: [rec('5', '2026-11-30')] }));
    await provider.getByIds!(['5@2026-11-30'], cfg(), http);
    expect(calls).toHaveLength(1);
  });
});

describe('push', () => {
  test('one-off: done → close, undone → reopen', async () => {
    const { provider } = await setup();
    const { http, calls } = fakeHttp(() => null);
    await provider.updateIssue!('9', { checked: true }, cfg(), http);
    await provider.updateIssue!('9', { checked: false }, cfg(), http);
    expect(calls.map((c) => c.url)).toEqual([`${API}/tasks/9/close`, `${API}/tasks/9/reopen`]);
  });

  test('updateIssue ignores fields it does not know', async () => {
    const { provider } = await setup();
    const { http, calls } = fakeHttp(() => null);
    await provider.updateIssue!('9', { foo: 'x' }, cfg(), http);
    expect(calls).toHaveLength(0);
  });

  test('recurring: closes only the matching occurrence', async () => {
    const { provider, book } = await setup();
    const now = fakeHttp(todoist({ active: [rec('5', '2026-11-30')] }));
    await provider.updateIssue!('5@2026-11-30', { checked: true }, cfg(), now.http);
    expect(now.calls.some((c) => c.url === `${API}/tasks/5/close`)).toBe(true);
    expect(book.isCompleted('5@2026-11-30')).toBe(true);

    const later = await setup();
    const moved = fakeHttp(todoist({ active: [rec('6', '2026-12-07')] }));
    await later.provider.updateIssue!('6@2026-11-30', { checked: true }, cfg(), moved.http);
    expect(moved.calls.some((c) => c.url.endsWith('/close'))).toBe(false);
    expect(later.book.isCompleted('6@2026-11-30')).toBe(true);
  });

  test('recurring: un-ticking does nothing in Todoist', async () => {
    const { provider } = await setup();
    const { http, calls } = fakeHttp(() => null);
    await provider.updateIssue!('5@2026-11-30', { checked: false }, cfg(), http);
    expect(calls).toHaveLength(0);
  });

  test('after a push, the cached issue reflects the pushed done-ness', async () => {
    const { provider } = await setup();
    const { http } = fakeHttp(todoist({ active: [task({ id: '1' })] }));
    await provider.getByIds!(['1'], cfg(), http);
    await provider.updateIssue!('1', { checked: true }, cfg(), http);
    expect((await provider.getByIds!(['1'], cfg(), http))[0]).toMatchObject({ checked: true, state: 'done' });
  });
});

describe('push dates', () => {
  const posts = (calls: Call[]) => calls.filter((c) => c.method === 'POST').map((c) => [c.url, c.body]);

  test('planned day → due_date', async () => {
    const { provider } = await setup();
    const { http, calls } = fakeHttp(() => null);
    await provider.updateIssue!('9', { dueDay: '2026-12-03' }, cfg(), http);
    expect(posts(calls)).toEqual([[`${API}/tasks/9`, { due_date: '2026-12-03' }]]);
  });

  test('planned time → due_datetime in UTC, even when dueDay is cleared in the same change', async () => {
    const { provider } = await setup();
    const { http, calls } = fakeHttp(() => null);
    await provider.updateIssue!('9', { dueWithTime: Date.UTC(2026, 11, 3, 13), dueDay: null }, cfg(), http);
    expect(posts(calls)).toEqual([[`${API}/tasks/9`, { due_datetime: '2026-12-03T13:00:00.000Z' }]]);
  });

  test('date removed in SP → "no date"', async () => {
    const { provider } = await setup();
    const { http, calls } = fakeHttp(() => null);
    await provider.updateIssue!('9', { dueDay: null }, cfg(), http);
    expect(posts(calls)).toEqual([[`${API}/tasks/9`, { due_string: 'no date' }]]);
  });

  test('clearing dueDay while a time is set (mutual exclusion) does not remove the date', async () => {
    const { provider } = await setup();
    const { http } = fakeHttp(todoist({ active: [task({ id: '9', due: due('2026-12-03T13:00:00Z') })] }));
    await provider.getByIds!(['9'], cfg(), http);
    const push = fakeHttp(() => null);
    await provider.updateIssue!('9', { dueDay: null }, cfg(), push.http);
    expect(push.calls).toHaveLength(0);
  });

  test('clearing dueWithTime while a day is set does not remove the date', async () => {
    const { provider } = await setup();
    const { http } = fakeHttp(todoist({ active: [task({ id: '9', due: due('2026-12-03') })] }));
    await provider.getByIds!(['9'], cfg(), http);
    const push = fakeHttp(() => null);
    await provider.updateIssue!('9', { dueWithTime: null }, cfg(), push.http);
    expect(push.calls).toHaveLength(0);
  });

  test('recurring occurrences never get dates pushed (Todoist would drop the recurrence)', async () => {
    const { provider } = await setup();
    const { http, calls } = fakeHttp(() => null);
    await provider.updateIssue!('5@2026-11-30', { dueDay: '2026-12-03' }, cfg(), http);
    expect(calls).toHaveLength(0);
  });

  test('done and date in one change → both pushed', async () => {
    const { provider } = await setup();
    const { http, calls } = fakeHttp(() => null);
    await provider.updateIssue!('9', { checked: true, dueDay: '2026-12-03' }, cfg(), http);
    expect(posts(calls).map(([u]) => u)).toEqual(expect.arrayContaining([`${API}/tasks/9`, `${API}/tasks/9/close`]));
  });

  test('after a date push, a refresh within the interval returns the pushed date', async () => {
    const { provider } = await setup();
    const { http } = fakeHttp(todoist({ active: [task({ id: '9', due: due('2026-11-30') })] }));
    await provider.getByIds!(['9'], cfg(), http);
    await provider.updateIssue!('9', { dueDay: '2026-12-03' }, cfg(), fakeHttp(() => null).http);
    expect((await provider.getByIds!(['9'], cfg(), http))[0]).toMatchObject({ dueDay: '2026-12-03', dueWithTime: undefined });
  });
});

describe('push title and estimate', () => {
  const posts = (calls: Call[]) => calls.filter((c) => c.method === 'POST').map((c) => [c.url, c.body]);

  test('renamed in SP → content, also for recurring tasks', async () => {
    const { provider } = await setup();
    const { http, calls } = fakeHttp(() => null);
    await provider.updateIssue!('9', { content: 'Buy oat milk' }, cfg(), http);
    await provider.updateIssue!('5@2026-11-30', { content: 'Bins out' }, cfg(), http);
    expect(posts(calls)).toEqual([
      [`${API}/tasks/9`, { content: 'Buy oat milk' }],
      [`${API}/tasks/5`, { content: 'Bins out' }],
    ]);
  });

  test('an empty title is never pushed', async () => {
    const { provider } = await setup();
    const { http, calls } = fakeHttp(() => null);
    await provider.updateIssue!('9', { content: '  ' }, cfg(), http);
    expect(calls).toHaveLength(0);
  });

  test('estimate → duration in minutes; removed estimate → no duration', async () => {
    const { provider } = await setup();
    const { http, calls } = fakeHttp(() => null);
    await provider.updateIssue!('9', { durationMs: 2_700_000 }, cfg(), http);
    await provider.updateIssue!('9', { durationMs: 0 }, cfg(), http);
    expect(posts(calls)).toEqual([
      [`${API}/tasks/9`, { duration: 45, duration_unit: 'minute' }],
      [`${API}/tasks/9`, { duration: null }],
    ]);
  });

  test('title, estimate and date in one change → one update request', async () => {
    const { provider } = await setup();
    const { http, calls } = fakeHttp(() => null);
    await provider.updateIssue!('9', { content: 'X', durationMs: 600_000, dueDay: '2026-12-03' }, cfg(), http);
    expect(posts(calls)).toEqual([
      [`${API}/tasks/9`, { content: 'X', duration: 10, duration_unit: 'minute', due_date: '2026-12-03' }],
    ]);
  });

  test('after pushing title and estimate, a refresh returns them', async () => {
    const { provider } = await setup();
    const { http } = fakeHttp(todoist({ active: [task({ id: '9', content: 'Old' })] }));
    await provider.getByIds!(['9'], cfg(), http);
    await provider.updateIssue!('9', { content: 'New', durationMs: 600_000 }, cfg(), fakeHttp(() => null).http);
    expect((await provider.getByIds!(['9'], cfg(), http))[0]).toMatchObject({ title: 'New', content: 'New', durationMs: 600_000 });
  });
});

describe('definition', () => {
  test('field mappings: everything both ways by default, no notes', async () => {
    const { provider } = await setup();
    const m = Object.fromEntries(provider.fieldMappings!.map((f) => [f.taskField, f]));
    expect(m.isDone).toMatchObject({ issueField: 'checked', defaultDirection: 'both' });
    expect(m.title).toMatchObject({ issueField: 'content', defaultDirection: 'both' });
    expect(m.dueDay).toMatchObject({ defaultDirection: 'both', mutuallyExclusive: ['dueWithTime'] });
    expect(m.dueWithTime).toMatchObject({ defaultDirection: 'both', mutuallyExclusive: ['dueDay'] });
    expect(m.timeEstimate).toMatchObject({ issueField: 'durationMs', defaultDirection: 'both' });
    expect(m.notes).toBeUndefined();
    expect(m.isDone.toIssueValue(true, { issueId: '1' })).toBe(true);
    expect(m.isDone.toTaskValue(false, { issueId: '1' })).toBe(false);
  });

  test('extractSyncValues and issue link', async () => {
    const { provider } = await setup();
    expect(Object.keys(provider.extractSyncValues!({ id: '1', title: 'x' })).sort())
      .toEqual(['checked', 'content', 'dueDay', 'dueWithTime', 'durationMs']);
    expect(provider.getIssueLink('5@2026-11-30', cfg())).toBe('https://app.todoist.com/app/task/5');
  });
});
