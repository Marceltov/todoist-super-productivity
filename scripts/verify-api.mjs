// Dev-only check of the Todoist API v1 behaviours the plugin relies on.
// Usage: node scripts/verify-api.mjs "sp-test"
//   - reads the token from .dev-token (git-ignored); never prints it
//   - only touches a project whose name starts with "sp-test"; it must contain one one-off task and one
//     recurring task. It closes the one-off (then reopens it) and closes the recurring task once (it advances).
//   - prints status codes, field names, ids and dates only
import { readFileSync } from 'node:fs';

const API = 'https://api.todoist.com/api/v1';
const token = readFileSync('.dev-token', 'utf8').trim();
const projectName = process.argv[2] ?? '';
if (!projectName.startsWith('sp-test')) {
  console.error('Pass the throwaway project name; it must start with "sp-test".');
  process.exit(1);
}

const call = async (method, path, { auth = token, params } = {}) => {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${auth}`, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
    body: method === 'POST' ? '{}' : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, json, headers: res.headers };
};
const keys = (o) => (o && typeof o === 'object' ? Object.keys(o).sort().join(', ') : String(o));
const log = (label, v) => console.log(`${label}: ${v}`);

// Find the project.
const projects = await call('GET', '/projects');
log('GET /projects status', projects.status);
log('project page keys', keys(projects.json));
const project = (projects.json?.results ?? []).find((p) => p.name === projectName);
if (!project) { console.error(`No project named "${projectName}"`); process.exit(1); }
log('project fields', keys(project));

// (a) filter response shape
const filter = await call('GET', '/tasks/filter', { params: { query: `#${projectName}`, limit: '200' } });
log('(a) GET /tasks/filter status', filter.status);
log('(a) page keys', keys(filter.json));
const tasks = filter.json?.results ?? [];
log('(a) task count', tasks.length);
if (tasks.length > 10) { console.error('More than 10 tasks: is this really the throwaway project? Aborting.'); process.exit(1); }
const oneOff = tasks.find((t) => !t.due?.is_recurring);
const recurring = tasks.find((t) => t.due?.is_recurring);
if (!oneOff || !recurring) { console.error('Need one one-off and one recurring task in the project.'); process.exit(1); }
log('(a) task fields', keys(oneOff));
log('(a) due fields (recurring)', keys(recurring.due));
log('(a) recurring due.date / datetime', `${recurring.due.date} / ${recurring.due.datetime ?? '-'}`);
log('(a) duration (one-off)', JSON.stringify(oneOff.duration));
log('(a) project_id present', 'project_id' in oneOff);

// (b) closed one-off task: single get and batch get
log('(b) close one-off', (await call('POST', `/tasks/${oneOff.id}/close`)).status);
const single = await call('GET', `/tasks/${oneOff.id}`);
log('(b) GET /tasks/{id} after close: status', single.status);
log('(b) ... checked / completed_at', single.json ? `${single.json.checked} / ${single.json.completed_at ?? '-'}` : '-');
const batch = await call('GET', '/tasks', { params: { ids: oneOff.id } });
log('(b) GET /tasks?ids= after close: status / count', `${batch.status} / ${(batch.json?.results ?? []).length}`);
log('(b) reopen one-off', (await call('POST', `/tasks/${oneOff.id}/reopen`)).status);

// (c) completion of a recurring task in the completed list
const before = recurring.due.date;
log('(c) close recurring', (await call('POST', `/tasks/${recurring.id}/close`)).status);
const after = await call('GET', `/tasks/${recurring.id}`);
log('(c) recurring due before -> after', `${before} -> ${after.json?.due?.date ?? '-'} (checked ${after.json?.checked})`);
const since = new Date(Date.now() - 86_400_000).toISOString();
const completed = await call('GET', '/tasks/completed/by_completion_date', { params: { since, until: new Date().toISOString() } });
log('(c) completed status / page keys', `${completed.status} / ${keys(completed.json)}`);
const items = completed.json?.items ?? completed.json?.results ?? [];
const match = items.find((it) => String(it.task_id ?? it.id) === recurring.id);
log('(c) completed item fields', items[0] ? keys(items[0]) : 'no items');
log('(c) recurring completion listed', match ? `yes (matched via ${'task_id' in match ? 'task_id' : 'id'})` : 'NO');
log('(c) one-off completion listed', items.some((it) => String(it.task_id ?? it.id) === oneOff.id) ? 'yes' : 'no');

// (d) bad token
const bad = await call('GET', '/projects', { auth: 'invalid-token' });
log('(d) bad token status', bad.status);
log('(d) bad token body keys', keys(bad.json));

// rate-limit headers, if any
log('rate-limit headers', [...filter.headers.keys()].filter((h) => /rate|retry/i.test(h)).join(', ') || 'none');
