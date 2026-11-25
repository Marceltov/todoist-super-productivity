import { todoistHex } from '../src/colors';
import { tagUpdates } from '../src/tag-style';

test('todoistHex maps Todoist colour names, unknown → charcoal', () => {
  expect(todoistHex('berry_red')).toBe('#b8256f');
  expect(todoistHex('blue')).toBe('#4073ff');
  expect(todoistHex('nope')).toBe('#808080');
  expect(todoistHex(undefined)).toBe('#808080');
});

test('tagUpdates only touches tags whose colour or icon differ', () => {
  const existing = [
    { id: 't1', title: 'Household', color: '#aaaaaa', icon: null },
    { id: 't2', title: 'errands', color: '#808080', icon: 'label' },
    { id: 't3', title: 'mine', color: '#123456', icon: 'star' },
  ];
  const styles = [
    { title: 'Household', color: '#b8256f', icon: 'tag' },
    { title: 'errands', color: '#808080', icon: 'label' },
    { title: 'not-yet-created', color: '#808080', icon: 'label' },
  ];
  expect(tagUpdates(existing, styles)).toEqual([{ id: 't1', updates: { color: '#b8256f', icon: 'tag' } }]);
});
