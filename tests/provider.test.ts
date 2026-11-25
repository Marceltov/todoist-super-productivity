import { RefreshCache } from '../src/interval';
import { OccurrenceBook } from '../src/occurrences';
import { createProvider } from '../src/provider';
import { API } from '../src/todoist-api';
import type { TodoistTask } from '../src/types';
import { due, rec, task } from './factories';
import { type Call, fakeHttp, httpError } from './fake-http';

const memoryStorage = () => { let d: string | null = null; return { load: async () => d, save: async (x: string) => { d = x; } }; };

const setup = async (o: { token?: string | null; now?: () => number; lastKnown?: ReturnType<typeof memoryStorage> } = {}) => {
  const book = await OccurrenceBook.load(memoryStorage());
  const cache = new RefreshCache(o.now ?? (() => 0));
  const styled: unknown[][] = [];
  const errors: string[] = [];
  const provider = createProvider({
    getToken: async () => (o.token === undefined ? 'tok' : o.token), book, cache,
    onTagStyles: (styles) => styled.push(styles),
    onConnectionError: (msg) => errors.push(msg),
    lastKnownStorage: o.lastKnown,
  });
  return { book, cache, provider, styled, errors };
};
const cfg = (o: Record<string, unknown> = {}) => ({ filterQuery: 'assigned to: me', checkInterval: '5m', ...o });
const page = (results: unknown[]) => ({ results, next_cursor: null });

/** Routes fake Todoist calls: filter results, active tasks by id, completed items. */
/** Routes fake Todoist calls. `active`: open tasks; `closed`: closed tasks (only GET /tasks/{id} returns them). */
const todoist = (d: { filter?: TodoistTask[]; active?: TodoistTask[]; closed?: TodoistTask[]; projects?: unknown[]; labels?: unknown[] }) =>
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
    if (c.url === `${API}/labels`) return page(d.labels ?? []);
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
    const filterCalls = calls.filter((c) => c.url.endsWith('/tasks/filter'));
    expect(filterCalls[0].params!.query).toBe('(assigned to: me) & search: milk');
    expect(filterCalls).toHaveLength(2);
  });

  test('empty filter setting uses the default: mine, plus unassigned in my own projects', async () => {
    const { provider } = await setup();
    const { http, calls } = fakeHttp(todoist({}));
    await provider.getNewIssuesForBacklog!(cfg({ filterQuery: '' }), http);
    expect(calls.find((c) => c.url.endsWith('/tasks/filter'))!.params!.query).toBe('assigned to: me | (!assigned & !shared)');
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
    expect(calls.filter((c) => c.url.includes('/tasks'))).toHaveLength(1);
    now = 300_000;
    await provider.getNewIssuesForBacklog!(cfg(), http);
    expect(calls.filter((c) => c.url.includes('/tasks'))).toHaveLength(2);
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

describe('baseline on add', () => {
  test('search and backlog results carry every synced field, so SP has a push baseline right after +', async () => {
    const { provider } = await setup();
    const t = task({ id: '9', content: 'Milk', due: due('2026-11-30'), duration: { amount: 30, unit: 'minute' } });
    const { http } = fakeHttp(todoist({ filter: [t] }));
    for (const [r] of [await provider.searchIssues('', cfg(), http), await provider.getNewIssuesForBacklog!(cfg(), http)]) {
      expect(provider.extractSyncValues!(r as never)).toEqual({
        checked: false, content: 'Milk', dueDay: '2026-11-30', dueWithTime: undefined, durationMs: 1_800_000, labels: [],
      });
      expect(r).toMatchObject({ lastUpdated: Date.parse('2026-11-25T10:00:00Z') });
    }
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
    expect(calls.filter((c) => c.url.includes('/tasks'))).toHaveLength(1);
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
    expect(calls.filter((c) => c.url.includes('/tasks'))).toHaveLength(1);
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

  test('recurring: ticking off a moved occurrence still closes it (same completed_count)', async () => {
    const { provider, book } = await setup();
    book.idToImport(rec('5', '2026-11-30', { completed_count: 1 }));
    const { http, calls } = fakeHttp(todoist({ active: [rec('5', '2026-12-02', { completed_count: 1 })] }));
    await provider.updateIssue!('5@2026-11-30', { checked: true }, cfg(), http);
    expect(calls.some((c) => c.url === `${API}/tasks/5/close`)).toBe(true);
  });

  test('recurring: already completed elsewhere (count went up) → no second close', async () => {
    const { provider, book } = await setup();
    book.idToImport(rec('5', '2026-11-30', { completed_count: 1 }));
    const { http, calls } = fakeHttp(todoist({ active: [rec('5', '2026-12-07', { completed_count: 2 })] }));
    await provider.updateIssue!('5@2026-11-30', { checked: true }, cfg(), http);
    expect(calls.some((c) => c.url.endsWith('/close'))).toBe(false);
    expect(book.isCompleted('5@2026-11-30')).toBe(true);
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

  const syncRoute = (live: TodoistTask, status: unknown = 'ok') => (c: Call) => {
    if (c.method === 'GET') return live;
    if (c.url === `${API}/sync`) {
      const uuid = (c.body as { commands: { uuid: string }[] }).commands[0].uuid;
      return { sync_status: { [uuid]: status } };
    }
    return null;
  };

  test('recurring: moving an occurrence keeps the recurrence (sync item_update with the series string)', async () => {
    const { provider } = await setup();
    const { http, calls } = fakeHttp(syncRoute(rec('5', '2026-11-30')));
    await provider.updateIssue!('5@2026-11-30', { dueDay: '2026-12-03' }, cfg(), http);
    const sync = calls.find((c) => c.url === `${API}/sync`)!;
    const cmd = (sync.body as { commands: { type: string; uuid: string; args: unknown }[] }).commands[0];
    expect(cmd.type).toBe('item_update');
    expect(cmd.uuid).toBeTruthy();
    expect(cmd.args).toEqual({ id: '5', due: { date: '2026-12-03', string: 'every week', lang: 'en', is_recurring: true } });
    expect(calls.some((c) => c.url === `${API}/tasks/5` && c.method === 'POST')).toBe(false);
  });

  test('recurring: planning a time sends a UTC datetime with the local time zone', async () => {
    const { provider } = await setup();
    const { http, calls } = fakeHttp(syncRoute(rec('5', '2026-11-30')));
    await provider.updateIssue!('5@2026-11-30', { dueWithTime: Date.UTC(2026, 11, 3, 13), dueDay: null }, cfg(), http);
    const args = (calls.find((c) => c.url === `${API}/sync`)!.body as { commands: { args: { due: Record<string, unknown> } }[] }).commands[0].args;
    expect(args.due).toMatchObject({ date: '2026-12-03T13:00:00Z', string: 'every week', is_recurring: true,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  });

  test('recurring: removing the date is never pushed (it would end the series)', async () => {
    const { provider } = await setup();
    const { http, calls } = fakeHttp(syncRoute(rec('5', '2026-11-30')));
    await provider.updateIssue!('5@2026-11-30', { dueDay: null }, cfg(), http);
    expect(calls).toHaveLength(0);
  });

  test('recurring: a failed sync command throws', async () => {
    const { provider } = await setup();
    const { http } = fakeHttp(syncRoute(rec('5', '2026-11-30'), { error: 'Invalid date' }));
    await expect(provider.updateIssue!('5@2026-11-30', { dueDay: '2026-12-03' }, cfg(), http)).rejects.toThrow('Invalid date');
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

describe('tags', () => {
  const projects = [{ id: 'p1', name: 'Household' }, { id: 'p2', name: 'Shared' }];

  test('refresh: Todoist labels plus the project name as tag', async () => {
    const { provider } = await setup();
    const { http } = fakeHttp(todoist({ active: [task({ id: '1', labels: ['errands'] })], projects }));
    const [issue] = await provider.getByIds!(['1'], cfg(), http);
    expect(issue.labels).toEqual(['errands']);
    expect(issue.projectTag).toBe('Household');
  });

  test('search results carry labels and the project tag for the tags on import', async () => {
    const { provider } = await setup();
    const { http } = fakeHttp(todoist({ filter: [task({ id: '1', project_id: 'p2', labels: ['phone'] })], projects }));
    const [r] = await provider.searchIssues('', cfg(), http);
    expect(r).toMatchObject({ labels: ['phone'], projectTag: 'Shared' });
  });

  test('project names are fetched once per interval', async () => {
    const { provider } = await setup();
    const { http, calls } = fakeHttp(todoist({ active: [task({ id: '1' }), task({ id: '2' })], projects }));
    await provider.getByIds!(['1'], cfg(), http);
    await provider.getByIds!(['2'], cfg(), http);
    expect(calls.filter((c) => c.url.endsWith('/projects'))).toHaveLength(1);
  });

  test('tag mapping: both ways; project tags (known project names) never become Todoist labels', async () => {
    const { provider } = await setup();
    await provider.getByIds!(['1'], cfg(), fakeHttp(todoist({ active: [task({ id: '1' })], projects })).http);
    const m = provider.fieldMappings!.find((f) => f.taskField === 'tagIds')!;
    expect(m).toMatchObject({ issueField: 'labels', defaultDirection: 'both' });
    expect(m.toIssueValue(['Household', 'errands'], { issueId: '1' })).toEqual(['errands']);
    expect(m.toTaskValue(['errands', 'Household'], { issueId: '1' })).toEqual(['errands', 'Household']);
  });

  test('pushing tags sets the Todoist labels without project tags', async () => {
    const { provider } = await setup();
    await provider.getByIds!(['9'], cfg(), fakeHttp(todoist({ active: [task({ id: '9' })], projects })).http);
    const { http, calls } = fakeHttp(() => null);
    await provider.updateIssue!('9', { labels: ['errands', 'Household', 'phone'] }, cfg(), http);
    expect(calls.map((c) => [c.url, c.body])).toEqual([[`${API}/tasks/9`, { labels: ['errands', 'phone'] }]]);
  });
});

describe('todoist-themed tags', () => {
  test('refresh reports Todoist colours and icons for the tags of returned tasks', async () => {
    const { provider, styled } = await setup();
    const { http } = fakeHttp(todoist({
      active: [task({ id: '1', labels: ['errands', 'shared-only'] })],
      projects: [{ id: 'p1', name: 'Household', color: 'berry_red' }],
      labels: [{ id: 'l1', name: 'errands', color: 'blue' }],
    }));
    await provider.getByIds!(['1'], cfg(), http);
    expect(styled.at(-1)).toEqual([
      { title: 'errands', color: '#4073ff', icon: 'label' },
      { title: 'shared-only', color: '#808080', icon: 'label' },
      { title: 'Household', color: '#b8256f', icon: 'tag' },
    ]);
  });

  test('labels are fetched once per interval', async () => {
    const { provider } = await setup();
    const { http, calls } = fakeHttp(todoist({ active: [task({ id: '1' }), task({ id: '2' })], projects: [{ id: 'p1', name: 'H' }] }));
    await provider.getByIds!(['1'], cfg(), http);
    await provider.getByIds!(['2'], cfg(), http);
    expect(calls.filter((c) => c.url.endsWith('/labels'))).toHaveLength(1);
  });
});

describe('review fixes', () => {
  const projects = [{ id: 'p1', name: 'Household' }];

  test('#1 synced labels are canonical: sorted, without the project tag, equal to the push value', async () => {
    const { provider } = await setup();
    const { http } = fakeHttp(todoist({ active: [task({ id: '1', labels: ['zeta', 'errands'] })], projects }));
    const [issue] = await provider.getByIds!(['1'], cfg(), http);
    const m = provider.fieldMappings!.find((f) => f.taskField === 'tagIds')!;
    expect(provider.extractSyncValues!(issue).labels).toEqual(['errands', 'zeta']);
    expect(m.toIssueValue(['Household', 'errands', 'zeta'], { issueId: '1' })).toEqual(provider.extractSyncValues!(issue).labels);
  });

  test('#1 pulled labels get the project tag added back for display', async () => {
    const { provider } = await setup();
    const { http } = fakeHttp(todoist({ active: [task({ id: '1', labels: ['errands'] })], projects }));
    await provider.getByIds!(['1'], cfg(), http);
    const m = provider.fieldMappings!.find((f) => f.taskField === 'tagIds')!;
    expect(m.toTaskValue(['errands'], { issueId: '1' })).toEqual(['errands', 'Household']);
  });

  test('#1 import: search result sync values give labels plus project tag', async () => {
    const { provider } = await setup();
    const { http } = fakeHttp(todoist({ filter: [task({ id: '1', labels: ['errands'] })], projects }));
    const [r] = await provider.searchIssues('', cfg(), http);
    const m = provider.fieldMappings!.find((f) => f.taskField === 'tagIds')!;
    expect(m.toTaskValue(provider.extractSyncValues!(r as never).labels, { issueId: '1' })).toEqual(['errands', 'Household']);
  });

  test('#2 getById (used by SP before a push) always reads Todoist, not the cache', async () => {
    const { provider } = await setup();
    const { http, calls } = fakeHttp(todoist({ active: [task({ id: '1' })], projects }));
    await provider.getByIds!(['1'], cfg(), http);
    await provider.getById('1', cfg(), http);
    expect(calls.filter((c) => c.url === `${API}/tasks`)).toHaveLength(2);
  });

  test('#5 a renamed project\'s old tag is never pushed as a label', async () => {
    const { provider } = await setup();
    await provider.getByIds!(['1'], cfg(), fakeHttp(todoist({ active: [task({ id: '1' })], projects })).http);
    // project renamed in Todoist
    await provider.getByIds!(['2'], cfg(), fakeHttp(todoist({
      active: [task({ id: '2', project_id: 'p9' })], projects: [{ id: 'p1', name: 'Home' }, { id: 'p9', name: 'X' }] })).http);
    const m = provider.fieldMappings!.find((f) => f.taskField === 'tagIds')!;
    expect(m.toIssueValue(['Household', 'errands'], { issueId: '1' })).toEqual(['errands']);
  });

  test('#5 known project names survive a restart (persisted)', async () => {
    const store = memoryStorage();
    const book = await OccurrenceBook.load(memoryStorage());
    const a = createProvider({ getToken: async () => 'tok', book, cache: new RefreshCache(), projectNameStorage: store });
    await a.getByIds!(['1'], cfg(), fakeHttp(todoist({ active: [task({ id: '1' })], projects })).http);
    await new Promise((r) => setTimeout(r, 0));
    const b = createProvider({ getToken: async () => 'tok', book, cache: new RefreshCache(), projectNameStorage: store });
    await b.getByIds!(['3'], cfg(), fakeHttp(todoist({ active: [task({ id: '3', project_id: 'p2' })], projects: [{ id: 'p2', name: 'Other' }] })).http);
    const m = b.fieldMappings!.find((f) => f.taskField === 'tagIds')!;
    expect(m.toIssueValue(['Household', 'errands'], { issueId: '1' })).toEqual(['errands']);
  });
});

describe('minor fixes', () => {
  const syncCmd = (calls: Call[]) =>
    (calls.find((c) => c.url === `${API}/sync`)?.body as { commands: { args: { due: Record<string, unknown> } }[] } | undefined)
      ?.commands[0].args.due;

  test('occurrence whose task stopped recurring → plain due update instead of a silent drop', async () => {
    const { provider } = await setup();
    const { http, calls } = fakeHttp((c) => (c.method === 'GET' ? task({ id: '5', due: due('2026-11-30') }) : null));
    await provider.updateIssue!('5@2026-11-30', { dueDay: '2026-12-03' }, cfg(), http);
    expect(calls.filter((c) => c.method === 'POST').map((c) => [c.url, c.body])).toEqual([[`${API}/tasks/5`, { due_date: '2026-12-03' }]]);
  });

  test('day-only move of a timed recurrence keeps the time of day (verified live)', async () => {
    const { provider } = await setup();
    const live = rec('5', '2026-11-30T09:00:00');
    const { http, calls } = fakeHttp((c) => {
      if (c.method === 'GET') return live;
      const uuid = (c.body as { commands: { uuid: string }[] }).commands[0].uuid;
      return { sync_status: { [uuid]: 'ok' } };
    });
    await provider.updateIssue!('5@2026-11-30', { dueDay: '2026-12-03' }, cfg(), http);
    expect(syncCmd(calls)).toMatchObject({ date: '2026-12-03T09:00:00', string: 'every week', is_recurring: true });
  });

  test('testConnection says why it failed', async () => {
    const none = await setup({ token: null });
    await none.provider.testConnection!(cfg(), fakeHttp(() => null).http);
    const bad = await setup();
    await bad.provider.testConnection!(cfg(), fakeHttp(() => { throw httpError(401); }).http);
    const filter = await setup();
    await filter.provider.testConnection!(cfg(), fakeHttp(() => { throw Object.assign(httpError(400), { error: { error: 'Invalid filter' } }); }).http);
    const offline = await setup();
    await offline.provider.testConnection!(cfg(), fakeHttp(() => { throw httpError(0); }).http);
    expect(none.errors[0]).toMatch(/no Todoist token/i);
    expect(bad.errors[0]).toMatch(/token was rejected/i);
    expect(filter.errors[0]).toMatch(/filter/i);
    expect(offline.errors[0]).toMatch(/couldn.t reach Todoist/i);
  });

  test('a task in an unknown (e.g. archived) project does not refetch projects on every refresh', async () => {
    const { provider } = await setup();
    const { http, calls } = fakeHttp(todoist({ active: [task({ id: '1', project_id: 'archived' }), task({ id: '2', project_id: 'archived' })], projects: [] }));
    await provider.getByIds!(['1'], cfg(), http);
    await provider.getByIds!(['2'], cfg(), http);
    expect(calls.filter((c) => c.url.endsWith('/projects'))).toHaveLength(1);
  });

  test('single-task lookups run at most 5 at a time', async () => {
    const { provider } = await setup();
    let inFlight = 0, peak = 0;
    const { http } = fakeHttp(async (c) => {
      if (c.url === `${API}/tasks`) return page([]);
      if (c.url.endsWith('/projects') || c.url.endsWith('/labels')) return page([]);
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      throw httpError(404);
    });
    await provider.getByIds!(Array.from({ length: 12 }, (_, i) => String(i)), cfg(), http);
    expect(peak).toBeLessThanOrEqual(5);
  });

  test('a task deleted in Todoist keeps its last known title and dates, even after a restart', async () => {
    const store = memoryStorage();
    const a = await setup({ lastKnown: store });
    await a.provider.getByIds!(['1'], cfg(), fakeHttp(todoist({ active: [task({ id: '1', content: 'Milk', due: due('2026-11-30') })] })).http);
    await new Promise((r) => setTimeout(r, 0));
    const b = await setup({ lastKnown: store });
    const [gone] = await b.provider.getByIds!(['1'], cfg(), fakeHttp(todoist({})).http);
    expect(gone).toMatchObject({ id: '1', state: 'deleted', title: 'Milk', content: 'Milk', dueDay: '2026-11-30' });
  });
});

describe('delete in Todoist (opt-in)', () => {
  test('off by default: deleting in SP leaves Todoist alone', async () => {
    const { provider } = await setup();
    const { http, calls } = fakeHttp(() => null);
    await provider.deleteIssue!('9', cfg(), http);
    expect(calls).toHaveLength(0);
  });

  test('when enabled, the Todoist task is deleted', async () => {
    const { provider } = await setup();
    const { http, calls } = fakeHttp(() => null);
    await provider.deleteIssue!('9', cfg({ isDeleteInTodoist: true }), http);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`DELETE ${API}/tasks/9`]);
  });

  test('never for recurring tasks: that would delete the whole series', async () => {
    const { provider } = await setup();
    const { http, calls } = fakeHttp(() => null);
    await provider.deleteIssue!('5@2026-11-30', cfg({ isDeleteInTodoist: true }), http);
    expect(calls).toHaveLength(0);
  });

  test('has an opt-in checkbox that explains the guard rails', async () => {
    const { provider } = await setup();
    const f = provider.configFields.find((x) => x.key === 'isDeleteInTodoist')!;
    expect(f.type).toBe('checkbox');
    expect(f.label).toBe('Also delete in Todoist when I delete a task here');
    expect(f.description).toMatch(/permanent/i);
    expect(f.description).toMatch(/recurring/i);
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
      .toEqual(['checked', 'content', 'dueDay', 'dueWithTime', 'durationMs', 'labels']);
    expect(provider.getIssueLink('5@2026-11-30', cfg())).toBe('https://app.todoist.com/app/task/5');
  });
});
