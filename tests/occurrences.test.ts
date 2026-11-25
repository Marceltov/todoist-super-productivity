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

test('rescheduled occurrence stays open', async () => {
  const book = await OccurrenceBook.load(memory());
  expect(book.resolve('5@2026-11-30', rec('5', '2026-12-01'), new Set())).toBe('open');
});

test('advanced with a completion record is done and frees the task', async () => {
  const book = await OccurrenceBook.load(memory());
  book.idToImport(rec('5', '2026-11-30'));
  expect(book.resolve('5@2026-11-30', rec('5', '2026-12-07'), new Set(['5']))).toBe('done');
  expect(book.idToImport(rec('5', '2026-12-07'))).toBe('5@2026-12-07');
});

test('same date and unchecked is open; checked is done; missing is unknown', async () => {
  const book = await OccurrenceBook.load(memory());
  expect(book.resolve('5@2026-11-30', rec('5', '2026-11-30'), new Set())).toBe('open');
  expect(book.resolve('6@2026-11-30', rec('6', '2026-11-30', { checked: true }), new Set())).toBe('done');
  expect(book.resolve('7@2026-11-30', undefined, new Set())).toBe('unknown');
});

test('an open occurrence seen in resolve becomes the task\'s open one', async () => {
  const book = await OccurrenceBook.load(memory());
  book.resolve('5@2026-11-30', rec('5', '2026-11-30'), new Set());
  expect(book.idToImport(rec('5', '2026-12-07'))).toBeNull();
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
