import { dueFields, durationMs, issueIdFor, parseIssueId, toIssue, toSearchResult } from '../src/mapping';
import { due, task } from './factories';

test('issueIdFor: plain id for one-off, id@date for recurring', () => {
  expect(issueIdFor(task({ id: '42', due: due('2026-11-30') }))).toBe('42');
  expect(issueIdFor(task({ id: '42', due: due('2026-11-30', { is_recurring: true }) }))).toBe('42@2026-11-30');
});

test('issueIdFor: recurring with datetime uses the date part', () => {
  const d = due('2026-11-30T09:00:00', { is_recurring: true, datetime: '2026-11-30T09:00:00' });
  expect(issueIdFor(task({ id: '42', due: d }))).toBe('42@2026-11-30');
});

test('parseIssueId round-trips', () => {
  expect(parseIssueId('42@2026-11-30')).toEqual({ taskId: '42', occurrence: '2026-11-30' });
  expect(parseIssueId('42')).toEqual({ taskId: '42' });
});

test('dueFields: date-only stays a day, no time shift', () => {
  expect(dueFields(due('2026-11-30'))).toEqual({ dueDay: '2026-11-30' });
});

test('dueFields: floating datetime is local time', () => {
  expect(dueFields(due('2026-11-30', { datetime: '2026-11-30T09:00:00' })))
    .toEqual({ dueWithTime: new Date(2026, 10, 30, 9, 0, 0).getTime() });
});

test('dueFields: Z datetime is absolute', () => {
  expect(dueFields(due('2026-11-30', { datetime: '2026-11-30T09:00:00Z' })))
    .toEqual({ dueWithTime: Date.UTC(2026, 10, 30, 9) });
});

test('dueFields: no due gives nothing', () => {
  expect(dueFields(null)).toEqual({});
});

test('durationMs', () => {
  expect(durationMs({ amount: 45, unit: 'minute' })).toBe(2_700_000);
  expect(durationMs({ amount: 1, unit: 'day' })).toBe(28_800_000);
  expect(durationMs(null)).toBe(0);
});

test('toIssue sets done state and link', () => {
  const i = toIssue(task({ id: '7', content: 'Buy milk' }), '7', true);
  expect(i).toMatchObject({ id: '7', title: 'Buy milk', checked: true, state: 'done',
    url: 'https://app.todoist.com/app/task/7' });
});

test('toIssue carries due, duration and recurrence for mappings and display', () => {
  const t = task({ id: '5', due: due('2026-11-30', { is_recurring: true, string: 'every mon' }),
    duration: { amount: 30, unit: 'minute' }, description: 'notes' });
  expect(toIssue(t, '5@2026-11-30', false)).toMatchObject({
    id: '5@2026-11-30', state: 'open', dueDay: '2026-11-30', durationMs: 1_800_000,
    dueText: 'every mon', isRecurring: 'yes', description: 'notes', body: 'notes',
    url: 'https://app.todoist.com/app/task/5',
  });
});

test('toSearchResult uses occurrence id and passes due time', () => {
  const t = task({ id: '8', content: 'Call', due: due('2026-11-30', { datetime: '2026-11-30T09:00:00Z' }) });
  expect(toSearchResult(t)).toMatchObject({ id: '8', title: 'Call', dueWithTime: Date.UTC(2026, 10, 30, 9) });
});

test('dueFields: API v1 timed due in date field (no datetime) is a time', () => {
  expect(dueFields(due('2026-11-30T09:00:00'))).toEqual({ dueWithTime: new Date(2026, 10, 30, 9).getTime() });
});

test('toIssue: labels plus the project name as a tag', () => {
  expect(toIssue(task({ labels: ['errands'] }), '1', false, 'Household').labels).toEqual(['errands', 'Household']);
  expect(toIssue(task({ labels: ['errands'] }), '1', false).labels).toEqual(['errands']);
});
