import type {
  IssueProviderPluginDefinition,
  PluginFieldMapping,
  PluginHttp,
  PluginIssue,
  PluginSearchResult,
} from '@super-productivity/plugin-api';
import { parseInterval, RefreshCache } from './interval';
import { PROJECT_TAG_PREFIX, parseIssueId, tagsFor, taskUrl, toIssue, toSearchResult, withoutProjectTags } from './mapping';
import { OccurrenceBook } from './occurrences';
import { todoistHex } from './colors';
import type { TagStyle } from './tag-style';
import { closeTask, filterTasks, getActiveTasks, getLabels, getProjects, getTask, moveOccurrence, reopenTask, searchQuery, updateTask } from './todoist-api';
import type { TodoistSyncConfig, TodoistTask } from './types';

export interface ProviderDeps {
  getToken(): Promise<string | null>;
  book: OccurrenceBook;
  cache: RefreshCache;
  /** Called with the Todoist look (colour, icon) of the tags of tasks just fetched. */
  onTagStyles?(styles: TagStyle[]): void;
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

const mapping = (taskField: PluginFieldMapping['taskField'], issueField: string, extra: Partial<PluginFieldMapping> = {}): PluginFieldMapping => ({
  taskField,
  issueField,
  defaultDirection: 'pullOnly',
  toIssueValue: (v) => v,
  toTaskValue: (v) => v,
  ...extra,
});

const SYNC_FIELDS = ['checked', 'content', 'dueDay', 'dueWithTime', 'durationMs', 'labels'] as const;

export function createProvider(deps: ProviderDeps): IssueProviderPluginDefinition {
  const { book, cache } = deps;
  let backlogKey = '';
  let meta: { at: number; projects: Map<string, { name: string; color?: string }>; labelColors: Map<string, string | undefined> } | undefined;

  /** Project names/colours and label colours, fetched at most once per check interval (or for an unknown project). */
  const metaFor = async (http: PluginHttp, intervalMs: number, projectIds: string[]) => {
    const stale = !meta || Date.now() - meta.at >= intervalMs;
    if (stale || projectIds.some((id) => !meta!.projects.has(id))) {
      const [projects, labels] = await Promise.all([getProjects(http), getLabels(http)]);
      meta = {
        at: Date.now(),
        projects: new Map(projects.map((p) => [p.id, { name: p.name, color: p.color }] as const)),
        labelColors: new Map(labels.map((l) => [l.name, l.color] as const)),
      };
    }
    return meta!;
  };

  /** Project name per task (for the "#Project" tag), and the Todoist look of the tasks' tags, reported once. */
  const projectNamesFor = async (http: PluginHttp, intervalMs: number, tasks: TodoistTask[]) => {
    if (!tasks.length) return new Map<string, string>();
    const m = await metaFor(http, intervalMs, tasks.map((t) => t.project_id));
    const names = new Map([...m.projects].map(([id, p]) => [id, p.name] as const));
    if (deps.onTagStyles) {
      const styles = new Map<string, TagStyle>();
      for (const t of tasks) {
        const project = m.projects.get(t.project_id);
        for (const title of tagsFor(t, project?.name)) {
          if (styles.has(title)) continue;
          styles.set(title, title.startsWith(PROJECT_TAG_PREFIX)
            ? { title, color: todoistHex(project?.color), icon: 'tag' }
            : { title, color: todoistHex(m.labelColors.get(title)), icon: 'label' });
        }
      }
      if (styles.size) deps.onTagStyles([...styles.values()]);
    }
    return names;
  };

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

  const pushDone = async (id: string, taskId: string, occurrence: string | undefined, checked: boolean, http: PluginHttp) => {
    if (occurrence) {
      if (!checked) return; // reopening a recurring task would touch the shared list unpredictably
      const [live] = await getActiveTasks(http, [taskId]);
      // Still the same occurrence? Use the completion counter (survives a moved date); fall back to the date.
      const baseline = book.openCount(id);
      const same = baseline !== undefined
        ? (live?.completed_count ?? 0) === baseline
        : live?.due?.date.slice(0, 10) === occurrence;
      if (live && !live.checked && same) await closeTask(http, taskId);
      await book.markCompleted(id);
    } else if (checked) {
      await closeTask(http, taskId);
    } else {
      await reopenTask(http, taskId);
    }
    rememberPush(id, checked);
  };

  /** SP planned (or unplanned) the task. A time wins over a day; clearing one half of the mutually exclusive pair
   *  while the other is still set is not a removal. Returns null when there is nothing to send. */
  const dueUpdate = (id: string, changes: Record<string, unknown>) => {
    const last = cache.get(id, Infinity);
    const time = changes.dueWithTime;
    const day = changes.dueDay;
    if (typeof time === 'number' && time > 0) {
      return { body: { due_datetime: new Date(time).toISOString() }, patch: { dueDay: undefined, dueWithTime: time } };
    }
    if (typeof day === 'string' && day) {
      return { body: { due_date: day }, patch: { dueDay: day, dueWithTime: undefined } };
    }
    const otherStillSet = 'dueDay' in changes ? !('dueWithTime' in changes) && !!last?.dueWithTime : !!last?.dueDay;
    if (otherStillSet) return null;
    return { body: { due_string: 'no date' }, patch: { dueDay: undefined, dueWithTime: undefined } };
  };

  /** Title, estimate and (non-recurring) dates go to Todoist in one update request. */
  const pushFields = async (id: string, taskId: string, occurrence: string | undefined, changes: Record<string, unknown>, http: PluginHttp) => {
    const body: Record<string, unknown> = {};
    const patch: Partial<PluginIssue> = {};
    if (typeof changes.content === 'string' && changes.content.trim()) {
      body.content = changes.content;
      Object.assign(patch, { content: changes.content, title: changes.content });
    }
    if (Array.isArray(changes.labels)) {
      const labels = withoutProjectTags(changes.labels as string[]);
      body.labels = labels;
      const lastTags = (cache.get(id, Infinity)?.labels as string[] | undefined) ?? [];
      const projectTags = lastTags.filter((t) => t.startsWith(PROJECT_TAG_PREFIX));
      patch.labels = [...labels, ...projectTags];
    }
    if ('durationMs' in changes) {
      const ms = Number(changes.durationMs) || 0;
      Object.assign(body, ms > 0 ? { duration: Math.max(1, Math.round(ms / 60_000)), duration_unit: 'minute' } : { duration: null });
      patch.durationMs = ms > 0 ? ms : 0;
    }
    if ('dueDay' in changes || 'dueWithTime' in changes) {
      const due = dueUpdate(id, changes);
      if (due && !occurrence) {
        Object.assign(body, due.body);
        Object.assign(patch, due.patch);
      } else if (due && occurrence && !('due_string' in due.body)) {
        // Recurring: move just this occurrence and keep the series. Removing the date is never pushed (ends the series).
        const live = await getTask(http, taskId);
        if (live?.due?.is_recurring) {
          await moveOccurrence(http, live, due.body.due_datetime
            ? { date: `${String(due.body.due_datetime).slice(0, 19)}Z`, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }
            : { date: String(due.body.due_date) });
          Object.assign(patch, due.patch);
        }
      }
    }
    if (Object.keys(body).length > 0) await updateTask(http, taskId, body);
    const last = cache.get(id, Infinity);
    if (last && Object.keys(patch).length > 0) cache.set({ ...last, ...patch });
  };

  const fetchIssues = async (ids: string[], http: PluginHttp, intervalMs: number): Promise<PluginIssue[]> => {
    const parsed = ids.map((id) => ({ id, ...parseIssueId(id) }));
    const taskIds = [...new Set(parsed.map((p) => p.taskId))];
    const live = new Map((await getActiveTasks(http, taskIds)).map((t) => [t.id, t] as const));
    // The batch omits closed tasks; a single GET still returns them (or 404 when deleted).
    const missing = taskIds.filter((id) => !live.has(id));
    const looked = await Promise.all(missing.map(async (id) => [id, await getTask(http, id)] as const));
    const closedOrGone = new Map(looked);
    const found = [...live.values(), ...looked.flatMap(([, t]) => (t ? [t] : []))];
    const names = await projectNamesFor(http, intervalMs, found);

    return parsed.map(({ id, taskId, occurrence }) => {
      const t = live.get(taskId) ?? closedOrGone.get(taskId) ?? undefined;
      let issue: PluginIssue;
      if (!t) issue = deletedIssue(id);
      else if (occurrence) issue = toIssue(t, id, book.resolve(id, t) === 'done', names.get(t.project_id));
      else issue = toIssue(t, id, t.checked, names.get(t.project_id));
      cache.set(issue);
      return issue;
    });
  };

  const getByIds = async (ids: string[], config: Record<string, unknown>, http: PluginHttp): Promise<PluginIssue[]> => {
    const { intervalMs } = settings(config);
    const stale = ids.filter((id) => !cache.get(id, intervalMs));
    const fetched = stale.length ? await fetchIssues(stale, http, intervalMs) : [];
    const byId = new Map(fetched.map((i) => [i.id, i] as const));
    return ids.map((id) => byId.get(id) ?? cache.get(id, Infinity)).filter((i): i is PluginIssue => !!i);
  };

  return {
    configFields: [
      {
        key: 'filterQuery',
        type: 'input',
        label: 'Todoist filter (optional)',
        description:
          'Leave empty to import tasks assigned to you plus unassigned tasks in your own projects ' +
          `(${DEFAULT_FILTER}). Narrow it further with Projects below.`,
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
      const { filter, projectIds, intervalMs } = settings(config);
      const tasks = (await filterTasks(http, searchQuery(filter, term))).filter(inProjects(projectIds));
      const names = await projectNamesFor(http, intervalMs, tasks);
      return tasks.flatMap((t): PluginSearchResult[] => {
        const id = t.due?.is_recurring ? book.peekId(t) : t.id;
        return id ? [toSearchResult(t, id, names.get(t.project_id))] : [];
      });
    },

    async getNewIssuesForBacklog(config, http) {
      const { filter, projectIds, intervalMs } = settings(config);
      const key = JSON.stringify([filter, projectIds]);
      const cached = key === backlogKey ? cache.getBacklog(intervalMs) : undefined;
      if (cached) return cached;
      const tasks = (await filterTasks(http, filter)).filter(inProjects(projectIds));
      const names = await projectNamesFor(http, intervalMs, tasks);
      const results = tasks.flatMap((t): PluginSearchResult[] => {
        const id = t.due?.is_recurring ? book.idToImport(t) : t.id;
        return id ? [toSearchResult(t, id, names.get(t.project_id))] : [];
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
      mapping('title', 'content', { defaultDirection: 'both' }),
      // Everything syncs both ways by default (Marcel: planning in SP should show in the shared Todoist list).
      // Users can change the direction per field in the integration's Two-Way Sync section.
      mapping('dueDay', 'dueDay', { defaultDirection: 'both', mutuallyExclusive: ['dueWithTime'] }),
      mapping('dueWithTime', 'dueWithTime', { defaultDirection: 'both', mutuallyExclusive: ['dueDay'] }),
      mapping('timeEstimate', 'durationMs', { defaultDirection: 'both' }),
      // Todoist labels ↔ SP tags; the "#Project" tag is display-only and never becomes a label.
      mapping('tagIds', 'labels', {
        defaultDirection: 'both',
        toIssueValue: (v) => withoutProjectTags(Array.isArray(v) ? (v as string[]) : []),
        toTaskValue: (v) => (Array.isArray(v) ? v : []),
      }),
    ],

    extractSyncValues: (issue) => Object.fromEntries(SYNC_FIELDS.map((f) => [f, issue[f]])),

    deletedStates: ['deleted'],

    async updateIssue(id, changes, _config, http) {
      const { taskId, occurrence } = parseIssueId(id);
      await pushFields(id, taskId, occurrence, changes, http);
      if ('checked' in changes) await pushDone(id, taskId, occurrence, Boolean(changes.checked), http);
    },
  };
}
