import manifest from '../src/manifest.json';
import pkg from '../package.json';

test('manifest matches global constraints', () => {
  expect(manifest.id).toBe('todoist-sync');
  expect(manifest.version).toBe(pkg.version);
  expect(manifest.minSupVersion).toBe('20.0.0');
  expect(manifest.type).toBe('issueProvider');
  expect(manifest.issueProvider.pollIntervalMs).toBe(60000);
  expect(manifest.issueProvider).not.toHaveProperty('issueProviderKey');
  expect(manifest.issueProvider.defaultAutoAddToBacklog).toBe(false); // pick tasks by hand, like GitHub
  expect(manifest.dataSharing[0].hosts).toEqual(['api.todoist.com']);
  expect(manifest.dataSharing[0].data).toEqual(
    ['credentials', 'userText', 'ids', 'taskStatus', 'taskTitles', 'taskSchedule', 'projectAndTagNames']);
});
