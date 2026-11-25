import type { PluginHttp } from '@super-productivity/plugin-api';
import type { TodoistTask } from './types';

// Todoist API v1. SP adds the provider's getHeaders() (the Bearer token) to every `http` call.
//
// Verified live on 2026-11-25 (scripts/verify-api.mjs):
// - Task fields include checked, completed_at, completed_count, postponed_count, due, duration, project_id.
// - due has no `datetime`; a timed due arrives in due.date ("2026-11-30T09:00:00").
// - GET /tasks?ids= omits closed tasks; GET /tasks/{id} still returns them (checked: true, completed_at).
// - A deleted task: GET /tasks/{id} → 404.
// - Closing a recurring task moves due.date and increments completed_count; rescheduling increments
//   postponed_count. GET /tasks/completed/by_completion_date listed nothing, so it isn't used.
// - Bad token → 401 with { error, error_code, error_extra, error_tag, http_code }. No rate-limit headers seen.
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

/** A single task, including closed ones (the batch endpoint omits those). Deleted → null (HTTP 404). */
export const getTask = async (http: PluginHttp, id: string): Promise<TodoistTask | null> => {
  try {
    return await withRetry(() => http.get<TodoistTask>(`${API}/tasks/${id}`));
  } catch (e) {
    if ((e as { status?: number })?.status === 404) return null;
    throw e;
  }
};

export const getProjects = (http: PluginHttp): Promise<{ id: string; name: string }[]> =>
  getAll<{ id: string; name: string }>(http, '/projects', {}).then((ps) => ps.map(({ id, name }) => ({ id, name })));

export const closeTask = (http: PluginHttp, id: string): Promise<unknown> =>
  withRetry(() => http.post(`${API}/tasks/${id}/close`, {}));

export const reopenTask = (http: PluginHttp, id: string): Promise<unknown> =>
  withRetry(() => http.post(`${API}/tasks/${id}/reopen`, {}));
