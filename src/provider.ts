import type {
  IssueProviderPluginDefinition,
  PluginFieldMapping,
  PluginHttp,
  PluginIssue,
  PluginSearchResult,
} from '@super-productivity/plugin-api';
import { parseInterval, RefreshCache } from './interval';
import { parseIssueId, taskUrl, toIssue, toSearchResult } from './mapping';
import { OccurrenceBook } from './occurrences';
import {
  closeTask,
  type Completion,
  filterTasks,
  getActiveTasks,
  getCompletedSince,
  getProjects,
  reopenTask,
  searchQuery,
} from './todoist-api';
import type { TodoistSyncConfig, TodoistTask } from './types';

export interface ProviderDeps {
  getToken(): Promise<string | null>;
  book: OccurrenceBook;
  cache: RefreshCache;
  now?: () => number;
}

const DEFAULT_FILTER = 'assigned to: me';
const DAY_MS = 86_400_000;
const MISSING_LOOKBACK_MS = 30 * DAY_MS;

const settings = (config: Record<string, unknown>) => {
  const c = config as TodoistSyncConfig;
  return {
    filter: (c.filterQuery ?? '').trim() || DEFAULT_FILTER,
    intervalMs: parseInterval(c.checkInterval),
    projectIds: Array.isArray(c.projectIds) ? c.projectIds : [],
  };
};

const inProjects = (projectIds: string[]) => (t: TodoistTask) =>
  projectIds.length === 0 || projectIds.includes(t.project_id);

const pullOnly = (taskField: PluginFieldMapping['taskField'], issueField: string, extra: Partial<PluginFieldMapping> = {}): PluginFieldMapping => ({
  taskField,
  issueField,
  defaultDirection: 'pullOnly',
  toIssueValue: (v) => v,
  toTaskValue: (v) => v,
  ...extra,
});

const SYNC_FIELDS = ['checked', 'content', 'dueDay', 'dueWithTime', 'durationMs'] as const;

export function createProvider(deps: ProviderDeps): IssueProviderPluginDefinition {
  const { book, cache } = deps;
  const now = deps.now ?? Date.now;
  let backlogKey = '';

  /** An issue for a task Todoist no longer lists as active; keeps the last known fields so nothing gets blanked. */
  const goneIssue = (id: string, state: 'done' | 'deleted', completion?: Completion): PluginIssue => {
    const last = cache.get(id, Infinity);
    const title = last?.title ?? completion?.content ?? '';
    return {
      ...(last ?? {}),
      id,
      title,
      content: last?.content ?? completion?.content ?? title,
      url: taskUrl(parseIssueId(id).taskId),
      state,
      checked: state === 'done' ? true : (last?.checked ?? false),
    };
  };

  const rememberPush = (id: string, checked: boolean) => {
    const last = cache.get(id, Infinity);
    if (last) cache.set({ ...last, checked, state: checked ? 'done' : 'open' });
  };

  const fetchIssues = async (ids: string[], http: PluginHttp): Promise<PluginIssue[]> => {
    const parsed = ids.map((id) => ({ id, ...parseIssueId(id) }));
    const live = new Map(
      (await getActiveTasks(http, [...new Set(parsed.map((p) => p.taskId))])).map((t) => [t.id, t] as const),
    );

    // Completions are only needed for tasks that vanished or recurring tasks whose date moved.
    let since = Infinity;
    for (const p of parsed) {
      const t = live.get(p.taskId);
      if (!t) since = Math.min(since, now() - MISSING_LOOKBACK_MS);
      else if (p.occurrence && !book.isCompleted(p.id) && t.due?.date.slice(0, 10) !== p.occurrence) {
        since = Math.min(since, new Date(`${p.occurrence}T00:00:00`).getTime() - DAY_MS);
      }
    }
    const completions = Number.isFinite(since) ? await getCompletedSince(http, new Date(since).toISOString()) : [];
    const completedById = new Map(completions.map((c) => [c.task_id, c] as const));
    const completedIds = new Set(completedById.keys());

    return parsed.map(({ id, taskId, occurrence }) => {
      const t = live.get(taskId);
      let issue: PluginIssue;
      if (occurrence) {
        const state = book.resolve(id, t, completedIds);
        if (state === 'unknown') {
          issue = completedIds.has(taskId) ? goneIssue(id, 'done', completedById.get(taskId)) : goneIssue(id, 'deleted');
        } else {
          issue = t ? toIssue(t, id, state === 'done') : goneIssue(id, 'done');
        }
      } else if (t) {
        issue = toIssue(t, id, t.checked);
      } else {
        issue = completedIds.has(taskId) ? goneIssue(id, 'done', completedById.get(taskId)) : goneIssue(id, 'deleted');
      }
      cache.set(issue);
      return issue;
    });
  };

  const getByIds = async (ids: string[], config: Record<string, unknown>, http: PluginHttp): Promise<PluginIssue[]> => {
    const { intervalMs } = settings(config);
    const stale = ids.filter((id) => !cache.get(id, intervalMs));
    const fetched = stale.length ? await fetchIssues(stale, http) : [];
    const byId = new Map(fetched.map((i) => [i.id, i] as const));
    return ids.map((id) => byId.get(id) ?? cache.get(id, Infinity)).filter((i): i is PluginIssue => !!i);
  };

  return {
    configFields: [
      {
        key: 'filterQuery',
        type: 'input',
        label: 'Todoist filter',
        description: `Which tasks to import, in Todoist filter syntax. Default: ${DEFAULT_FILTER}`,
      },
      {
        key: 'filterHelp',
        type: 'link',
        label: 'Todoist filter syntax',
        url: 'https://todoist.com/help/articles/introduction-to-filters-V98wIH',
      },
      {
        key: 'projectIds',
        type: 'multiSelect',
        label: 'Projects',
        description: 'Only import from these Todoist projects. Empty = all projects.',
        loadOptions: async (_config, http) =>
          (await getProjects(http)).map((p) => ({ label: p.name, value: p.id })),
      },
      {
        key: 'checkInterval',
        type: 'input',
        label: 'Check Todoist every',
        description: 'e.g. "5m" or "1h 30m" (default 5m, minimum 1m)',
      },
    ],

    async getHeaders(): Promise<Record<string, string>> {
      const token = await deps.getToken();
      return token ? { Authorization: `Bearer ${token}` } : {};
    },

    async testConnection(config, http) {
      if (!(await deps.getToken())) return false;
      try {
        await filterTasks(http, settings(config).filter);
        return true;
      } catch {
        return false;
      }
    },

    async searchIssues(term, config, http) {
      const { filter, projectIds } = settings(config);
      const tasks = (await filterTasks(http, searchQuery(filter, term))).filter(inProjects(projectIds));
      return tasks.flatMap((t): PluginSearchResult[] => {
        const id = t.due?.is_recurring ? book.peekId(t) : t.id;
        return id ? [toSearchResult(t, id)] : [];
      });
    },

    async getNewIssuesForBacklog(config, http) {
      const { filter, projectIds, intervalMs } = settings(config);
      const key = JSON.stringify([filter, projectIds]);
      const cached = key === backlogKey ? cache.getBacklog(intervalMs) : undefined;
      if (cached) return cached;
      const tasks = (await filterTasks(http, filter)).filter(inProjects(projectIds));
      const results = tasks.flatMap((t): PluginSearchResult[] => {
        const id = t.due?.is_recurring ? book.idToImport(t) : t.id;
        return id ? [toSearchResult(t, id)] : [];
      });
      backlogKey = key;
      cache.setBacklog(results);
      return results;
    },

    async getById(id, config, http) {
      const [issue] = await getByIds([id], config, http);
      if (!issue) throw new Error(`Todoist task ${id} not found`);
      return issue;
    },

    getByIds,

    getIssueLink: (id) => taskUrl(parseIssueId(id).taskId),

    issueDisplay: [
      { field: 'title', label: 'Task', type: 'link', linkField: 'url' },
      { field: 'dueText', label: 'Due', type: 'text', hideEmpty: true },
      { field: 'isRecurring', label: 'Repeats', type: 'text', hideEmpty: true },
      { field: 'description', label: 'Description', type: 'markdown', hideEmpty: true },
    ],

    fieldMappings: [
      {
        taskField: 'isDone',
        issueField: 'checked',
        defaultDirection: 'both',
        toIssueValue: (v) => Boolean(v),
        toTaskValue: (v) => Boolean(v),
      },
      pullOnly('title', 'content'),
      pullOnly('dueDay', 'dueDay', { mutuallyExclusive: ['dueWithTime'] }),
      pullOnly('dueWithTime', 'dueWithTime', { mutuallyExclusive: ['dueDay'] }),
      pullOnly('timeEstimate', 'durationMs'),
    ],

    extractSyncValues: (issue) => Object.fromEntries(SYNC_FIELDS.map((f) => [f, issue[f]])),

    deletedStates: ['deleted'],

    async updateIssue(id, changes, _config, http) {
      if (!('checked' in changes)) return; // only done-ness is ever pushed
      const checked = Boolean(changes.checked);
      const { taskId, occurrence } = parseIssueId(id);
      if (occurrence) {
        if (!checked) return; // reopening a recurring task would touch the shared list unpredictably
        const [live] = await getActiveTasks(http, [taskId]);
        if (live && !live.checked && live.due?.date.slice(0, 10) === occurrence) await closeTask(http, taskId);
        await book.markCompleted(id);
      } else if (checked) {
        await closeTask(http, taskId);
      } else {
        await reopenTask(http, taskId);
      }
      rememberPush(id, checked);
    },
  };
}
