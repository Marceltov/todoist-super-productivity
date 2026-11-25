import type { PluginIssue, PluginSearchResult } from '@super-productivity/plugin-api';
import type { TodoistDue, TodoistTask } from './types';

const MINUTE = 60_000;
const WORK_DAY = 8 * 60 * MINUTE;

export const taskUrl = (taskId: string): string => `https://app.todoist.com/app/task/${taskId}`;

/** Recurring tasks get one SP task per occurrence: "<id>@<YYYY-MM-DD>". */
export const issueIdFor = (task: TodoistTask): string =>
  task.due?.is_recurring ? `${task.id}@${task.due.date.slice(0, 10)}` : task.id;

export const parseIssueId = (issueId: string): { taskId: string; occurrence?: string } => {
  const at = issueId.indexOf('@');
  return at < 0 ? { taskId: issueId } : { taskId: issueId.slice(0, at), occurrence: issueId.slice(at + 1) };
};

/** A datetime without offset is "floating" (local); `new Date` parses it as local time, with `Z`/offset as absolute. */
export const dueFields = (due: TodoistDue | null): { dueDay?: string; dueWithTime?: number } => {
  if (!due) return {};
  const timed = due.datetime || (due.date.length > 10 ? due.date : null); // API v1 puts the time into `date`
  if (timed) return { dueWithTime: new Date(timed).getTime() };
  return { dueDay: due.date.slice(0, 10) };
};

export const durationMs = (d: TodoistTask['duration']): number =>
  !d ? 0 : d.unit === 'day' ? d.amount * WORK_DAY : d.amount * MINUTE;

export const toIssue = (task: TodoistTask, issueId: string, checked: boolean): PluginIssue => ({
  id: issueId,
  title: task.content,
  content: task.content,
  url: taskUrl(task.id),
  body: task.description,
  description: task.description,
  checked,
  state: checked ? 'done' : 'open',
  lastUpdated: task.updated_at ? new Date(task.updated_at).getTime() : undefined,
  ...dueFields(task.due),
  durationMs: durationMs(task.duration),
  dueText: task.due?.string ?? '',
  isRecurring: task.due?.is_recurring ? 'yes' : '',
});

/**
 * A search/backlog result carries every field of a full issue: SP stores the synced fields of what was added as the
 * push baseline, and with an empty baseline it skips pushes until the next refresh.
 */
export const toSearchResult = (task: TodoistTask, id: string = issueIdFor(task)): PluginSearchResult =>
  toIssue(task, id, task.checked);
