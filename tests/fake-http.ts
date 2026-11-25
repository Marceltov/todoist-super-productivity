import type { PluginHttp, PluginHttpOptions } from '@super-productivity/plugin-api';

export interface Call { method: string; url: string; params?: Record<string, string>; body?: unknown }

/** A PluginHttp that records calls; `route` answers each one (return a value, or throw to simulate an error). */
export const fakeHttp = (route: (c: Call) => unknown) => {
  const calls: Call[] = [];
  const handle = async (method: string, url: string, body?: unknown, o?: PluginHttpOptions) => {
    const c: Call = { method, url, params: o?.params, body };
    calls.push(c);
    return route(c);
  };
  const http: PluginHttp = {
    get: (url, o) => handle('GET', url, undefined, o) as never,
    post: (url, body, o) => handle('POST', url, body, o) as never,
    put: (url, body, o) => handle('PUT', url, body, o) as never,
    patch: (url, body, o) => handle('PATCH', url, body, o) as never,
    delete: (url, o) => handle('DELETE', url, undefined, o) as never,
    request: (method, url, body, o) => handle(method, url, body, o) as never,
  };
  return { http, calls };
};

/** Shape of SP's (Angular) HTTP error. */
export const httpError = (status: number, headers: Record<string, string> = {}) =>
  Object.assign(new Error(`HTTP ${status}`), { status, headers: { get: (k: string) => headers[k] ?? null } });
