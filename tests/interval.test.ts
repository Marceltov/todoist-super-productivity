import { parseInterval, RefreshCache } from '../src/interval';

test('parseInterval reads SP duration strings', () => {
  expect(parseInterval('5m')).toBe(300_000);
  expect(parseInterval('1h 30m')).toBe(5_400_000);
  expect(parseInterval('2h')).toBe(7_200_000);
});

test('parseInterval falls back to 5 minutes and clamps to 1 minute', () => {
  expect(parseInterval('')).toBe(300_000);
  expect(parseInterval(undefined)).toBe(300_000);
  expect(parseInterval('abc')).toBe(300_000);
  expect(parseInterval('10s')).toBe(60_000);
});

test('cache returns fresh entry, drops stale one', () => {
  let now = 0;
  const cache = new RefreshCache(() => now);
  cache.set({ id: 'a', title: 'A' });
  now = 299_999;
  expect(cache.get('a', 300_000)).toMatchObject({ id: 'a' });
  now = 300_000;
  expect(cache.get('a', 300_000)).toBeUndefined();
});

test('backlog cache follows the same age rule', () => {
  let now = 0;
  const cache = new RefreshCache(() => now);
  expect(cache.getBacklog(300_000)).toBeUndefined();
  cache.setBacklog([{ id: 'x', title: 'X' }]);
  now = 100;
  expect(cache.getBacklog(300_000)).toEqual([{ id: 'x', title: 'X' }]);
  now = 300_000;
  expect(cache.getBacklog(300_000)).toBeUndefined();
});

test('backlog entries can be dropped without refreshing', () => {
  const cache = new RefreshCache(() => 0);
  cache.setBacklog([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }]);
  cache.dropFromBacklog('a');
  expect(cache.getBacklog(300_000)).toEqual([{ id: 'b', title: 'B' }]);
});
