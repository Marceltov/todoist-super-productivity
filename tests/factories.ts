import type { TodoistDue, TodoistTask } from '../src/types';

export const due = (date: string, o: Partial<TodoistDue> = {}): TodoistDue => ({
  date, datetime: null, timezone: null, is_recurring: false, string: date, lang: 'en', ...o,
});
export const task = (o: Partial<TodoistTask> = {}): TodoistTask => ({
  id: '1', content: 'Task', description: '', checked: false, completed_at: null,
  updated_at: '2026-11-25T10:00:00Z', due: null, duration: null, project_id: 'p1', completed_count: 0, labels: [], ...o,
});
/** A weekly recurring task currently due on `date`. */
export const rec = (id: string, date: string, o: Partial<TodoistTask> = {}): TodoistTask =>
  task({ id, due: due(date, { is_recurring: true, string: 'every week' }), ...o });
