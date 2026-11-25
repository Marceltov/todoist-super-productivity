import { OccurrenceBook, type Storage } from '../src/occurrences';
import { rec } from './factories';

const memory = (): Storage & { data: string | null } => {
  const s = { data: null as string | null, load: async () => s.data, save: async (d: string) => { s.data = d; } };
  return s;
};

test('imports first occurrence, then nothing while open', async () => {
  const book = await OccurrenceBook.load(memory());
  expect(book.idToImport(rec('5', '2026-11-30'))).toBe('5@2026-11-30');
  expect(book.idToImport(rec('5', '2026-12-07'))).toBeNull();
});

test('idToImport is idempotent for the open occurrence itself', async () => {
  const book = await OccurrenceBook.load(memory());
  book.idToImport(rec('5', '2026-11-30'));
  expect(book.idToImport(rec('5', '2026-11-30'))).toBe('5@2026-11-30');
});

test('after completion the next occurrence imports', async () => {
  const book = await OccurrenceBook.load(memory());
  book.idToImport(rec('5', '2026-11-30'));
  await book.markCompleted('5@2026-11-30');
  expect(book.isCompleted('5@2026-11-30')).toBe(true);
  expect(book.idToImport(rec('5', '2026-12-07'))).toBe('5@2026-12-07');
});

test('peekId does not record anything', async () => {
  const book = await OccurrenceBook.load(memory());
  expect(book.peekId(rec('5', '2026-11-30'))).toBe('5@2026-11-30');
  expect(book.idToImport(rec('5', '2026-12-07'))).toBe('5@2026-12-07');
  expect(book.peekId(rec('5', '2026-12-14'))).toBeNull();
});

test('rescheduled occurrence (same completed_count) stays open', async () => {
  const book = await OccurrenceBook.load(memory());
  book.idToImport(rec('5', '2026-11-30', { completed_count: 2 }));
  expect(book.resolve('5@2026-11-30', rec('5', '2026-12-01', { completed_count: 2 }))).toBe('open');
});

test('completed_count went up → done, and the next occurrence can import', async () => {
  const book = await OccurrenceBook.load(memory());
  book.idToImport(rec('5', '2026-11-30', { completed_count: 2 }));
  expect(book.resolve('5@2026-11-30', rec('5', '2026-12-07', { completed_count: 3 }))).toBe('done');
  expect(book.idToImport(rec('5', '2026-12-07', { completed_count: 3 }))).toBe('5@2026-12-07');
});

test('completion detected even if Todoist kept the same date', async () => {
  const book = await OccurrenceBook.load(memory());
  book.idToImport(rec('5', '2026-11-30', { completed_count: 0 }));
  expect(book.resolve('5@2026-11-30', rec('5', '2026-11-30', { completed_count: 1 }))).toBe('done');
});

test('same date and unchanged count is open; checked is done; missing is unknown', async () => {
  const book = await OccurrenceBook.load(memory());
  expect(book.resolve('5@2026-11-30', rec('5', '2026-11-30'))).toBe('open');
  expect(book.resolve('6@2026-11-30', rec('6', '2026-11-30', { checked: true }))).toBe('done');
  expect(book.resolve('7@2026-11-30', undefined)).toBe('unknown');
});

test('an open occurrence first seen in resolve records its count as the baseline', async () => {
  const book = await OccurrenceBook.load(memory());
  expect(book.resolve('5@2026-11-30', rec('5', '2026-12-01', { completed_count: 4 }))).toBe('open');
  expect(book.idToImport(rec('5', '2026-12-07'))).toBeNull();
  expect(book.resolve('5@2026-11-30', rec('5', '2026-12-08', { completed_count: 5 }))).toBe('done');
});

test('state survives reload', async () => {
  const store = memory();
  const a = await OccurrenceBook.load(store);
  a.idToImport(rec('5', '2026-11-30'));
  await a.markCompleted('9@2026-11-01');
  const b = await OccurrenceBook.load(store);
  expect(b.idToImport(rec('5', '2026-12-07'))).toBeNull();
  expect(b.isCompleted('9@2026-11-01')).toBe(true);
});

test('corrupt stored data starts fresh', async () => {
  const store = memory();
  store.data = '{not json';
  const book = await OccurrenceBook.load(store);
  expect(book.idToImport(rec('5', '2026-11-30'))).toBe('5@2026-11-30');
});

test('an abandoned open occurrence completed in Todoist does not block the series (review #3)', async () => {
  const book = await OccurrenceBook.load(memory());
  book.idToImport(rec('5', '2026-11-30', { completed_count: 2 }));
  // SP task deleted, occurrence completed in Todoist: count went up, nobody called resolve()
  expect(book.peekId(rec('5', '2026-12-07', { completed_count: 3 }))).toBe('5@2026-12-07');
  expect(book.idToImport(rec('5', '2026-12-07', { completed_count: 3 }))).toBe('5@2026-12-07');
  expect(book.idToImport(rec('5', '2026-12-14', { completed_count: 3 }))).toBeNull();
});

test('a stored `completed` that is not a list is ignored on load', async () => {
  const store = memory();
  store.data = JSON.stringify({ open: {}, completed: 42 });
  const book = await OccurrenceBook.load(store);
  expect(book.isCompleted('5@2026-11-30')).toBe(false);
  expect(book.idToImport(rec('5', '2026-11-30'))).toBe('5@2026-11-30');
});

test('saves are serialized, so the last save holds the latest state', async () => {
  let data: string | null = null;
  let call = 0;
  const slowFirst: Storage = {
    load: async () => data,
    save: (d) => new Promise((r) => setTimeout(() => { data = d; r(); }, call++ === 0 ? 20 : 0)),
  };
  const book = await OccurrenceBook.load(slowFirst);
  book.idToImport(rec('5', '2026-11-30'));
  await book.markCompleted('5@2026-11-30');
  await new Promise((r) => setTimeout(r, 40));
  expect(JSON.parse(data!).completed).toEqual(['5@2026-11-30']);
});
