import type { PluginHttp } from '@super-productivity/plugin-api';
import type { TodoistTask } from './types';

// Todoist API v1. SP adds the provider's getHeaders() (the Bearer token) to every `http` call.
export const API = 'https://api.todoist.com/api/v1';
const MAX_QUERY = 1024;
const IDS_PER_REQUEST = 100;

interface Page<T> { results?: T[]; items?: T[]; next_cursor: string | null }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** On HTTP 429, wait Retry-After seconds (default 5, max 60) and retry once. Other errors propagate. */
export const withRetry = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    const err = e as { status?: number; headers?: { get?: (k: string) => string | null } };
    if (err?.status !== 429) throw e;
    const secs = Number(err.headers?.get?.('Retry-After') ?? 5);
    await sleep(Math.min(Number.isFinite(secs) && secs > 0 ? secs : 5, 60) * 1000);
    return fn();
  }
};

/** GETs every page of a cursor-paginated endpoint. */
const getAll = async <T>(http: PluginHttp, path: string, params: Record<string, string>): Promise<T[]> => {
  const out: T[] = [];
  let cursor: string | null = null;
  do {
    const page: Page<T> = await withRetry(() =>
      http.get<Page<T>>(`${API}${path}`, { params: cursor ? { ...params, cursor } : params }));
    out.push(...(page.results ?? page.items ?? []));
    cursor = page.next_cursor ?? null;
  } while (cursor);
  return out;
};

export const filterTasks = async (http: PluginHttp, query: string): Promise<TodoistTask[]> => {
  if (query.length > MAX_QUERY) throw new Error('Filter query is longer than 1024 characters');
  return getAll<TodoistTask>(http, '/tasks/filter', { query, limit: '200' });
};

/** Restricts the filter to a free-text search; strips operator characters so the term can't change the query. */
export const searchQuery = (filter: string, term: string): string => {
  const clean = term.replace(/[&|!(),\\]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean ? `(${filter}) & search: ${clean}` : filter;
};

export const getActiveTasks = async (http: PluginHttp, ids: string[]): Promise<TodoistTask[]> => {
  const out: TodoistTask[] = [];
  for (let i = 0; i < ids.length; i += IDS_PER_REQUEST) {
    out.push(...(await getAll<TodoistTask>(http, '/tasks', { ids: ids.slice(i, i + IDS_PER_REQUEST).join(',') })));
  }
  return out;
};

export interface Completion { task_id: string; completed_at: string; content?: string }

/** Tasks completed since `sinceIso`, including completions of recurring tasks (confirmed in the live spike). */
export const getCompletedSince = async (http: PluginHttp, sinceIso: string): Promise<Completion[]> => {
  const items = await getAll<Record<string, unknown>>(http, '/tasks/completed/by_completion_date', {
    since: sinceIso,
    until: new Date().toISOString(),
  });
  return items.map((it) => ({
    task_id: String(it.task_id ?? it.id),
    completed_at: String(it.completed_at ?? ''),
    ...(typeof it.content === 'string' ? { content: it.content } : {}),
  }));
};

export const getProjects = (http: PluginHttp): Promise<{ id: string; name: string }[]> =>
  getAll<{ id: string; name: string }>(http, '/projects', {}).then((ps) => ps.map(({ id, name }) => ({ id, name })));

export const closeTask = (http: PluginHttp, id: string): Promise<unknown> =>
  withRetry(() => http.post(`${API}/tasks/${id}/close`, {}));

export const reopenTask = (http: PluginHttp, id: string): Promise<unknown> =>
  withRetry(() => http.post(`${API}/tasks/${id}/reopen`, {}));
