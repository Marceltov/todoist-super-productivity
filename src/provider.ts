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
import { closeTask, filterTasks, getActiveTasks, getProjects, getTask, reopenTask, searchQuery } from './todoist-api';
import type { TodoistSyncConfig, TodoistTask } from './types';

export interface ProviderDeps {
  getToken(): Promise<string | null>;
  book: OccurrenceBook;
  cache: RefreshCache;
}

// Tasks assigned to me, plus unassigned tasks in my own (non-shared) projects. Verified live 2026-11-25.
const DEFAULT_FILTER = 'assigned to: me | (!assigned & !shared)';

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
  let backlogKey = '';

  /** A task Todoist deleted. Keeps the last known fields so the title mapping never blanks the SP title. */
  const deletedIssue = (id: string): PluginIssue => {
    const last = cache.get(id, Infinity);
    return {
      ...(last ?? {}),
      id,
      title: last?.title ?? '',
      url: taskUrl(parseIssueId(id).taskId),
      state: 'deleted',
      checked: last?.checked ?? false,
    };
  };

  const rememberPush = (id: string, checked: boolean) => {
    const last = cache.get(id, Infinity);
    if (last) cache.set({ ...last, checked, state: checked ? 'done' : 'open' });
  };

  const fetchIssues = async (ids: string[], http: PluginHttp): Promise<PluginIssue[]> => {
    const parsed = ids.map((id) => ({ id, ...parseIssueId(id) }));
    const taskIds = [...new Set(parsed.map((p) => p.taskId))];
    const live = new Map((await getActiveTasks(http, taskIds)).map((t) => [t.id, t] as const));
    // The batch omits closed tasks; a single GET still returns them (or 404 when deleted).
    const missing = taskIds.filter((id) => !live.has(id));
    const looked = await Promise.all(missing.map(async (id) => [id, await getTask(http, id)] as const));
    const closedOrGone = new Map(looked);

    return parsed.map(({ id, taskId, occurrence }) => {
      const t = live.get(taskId) ?? closedOrGone.get(taskId) ?? undefined;
      let issue: PluginIssue;
      if (!t) issue = deletedIssue(id);
      else if (occurrence) issue = toIssue(t, id, book.resolve(id, t) === 'done');
      else issue = toIssue(t, id, t.checked);
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
