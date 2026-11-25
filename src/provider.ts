import type {
  IssueProviderPluginDefinition,
  PluginFieldMapping,
  PluginHttp,
  PluginIssue,
  PluginSearchResult,
} from '@super-productivity/plugin-api';
import { parseInterval, RefreshCache } from './interval';
import { parseIssueId, tagsFor, taskUrl, toIssue, toSearchResult } from './mapping';
import { OccurrenceBook, type Storage } from './occurrences';
import { todoistHex } from './colors';
import type { TagStyle } from './tag-style';
import { closeTask, deleteTask, filterTasks, getActiveTasks, getLabels, getProjects, getTask, moveOccurrence, reopenTask, searchQuery, updateTask } from './todoist-api';
import type { TodoistSyncConfig, TodoistTask } from './types';

export interface ProviderDeps {
  getToken(): Promise<string | null>;
  book: OccurrenceBook;
  cache: RefreshCache;
  /** Reports why Test Connection failed (shown to the user). */
  onConnectionError?(message: string): void;
  /** Persists the last known fields per task, so a task deleted in Todoist keeps its title and dates after a restart. */
  lastKnownStorage?: Storage;
  /** Persists every Todoist project name seen, so tags of renamed projects are still never pushed as labels. */
  projectNameStorage?: Storage;
  /** Called with the Todoist look (colour, icon) of the tags of tasks just fetched. */
  onTagStyles?(styles: TagStyle[]): void;
}

// Tasks assigned to me, plus unassigned tasks in my own (non-shared) projects. Verified live 2026-11-25.
const DEFAULT_FILTER = 'assigned to: me | (!assigned & !shared)';

const MAX_PARALLEL_LOOKUPS = 5;

/** Runs `fn` over `items` with at most `limit` calls in flight, keeping the order of results. */
const mapLimit = async <T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> => {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};

/** A readable reason for a failed connection test. */
const connectionError = (e: unknown): string => {
  const err = e as { status?: number; message?: string; error?: { error?: string } | string };
  const detail = typeof err?.error === 'string' ? err.error : err?.error?.error ?? err?.message ?? '';
  if (err?.message?.includes('Filter query is longer')) return err.message;
  if (err?.status === 401 || err?.status === 403) {
    return 'The Todoist token was rejected. Set a new one in Settings → Plugins → Todoist (⚙).';
  }
  if (err?.status === 400) return `Todoist couldn't run the filter: ${detail}`;
  if (!err?.status) return "Couldn't reach Todoist. Check the internet connection.";
  return `Todoist answered with HTTP ${err.status}: ${detail}`;
};

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
  let meta:
    | { at: number; projects: Map<string, { name: string; color?: string }>; labelColors: Map<string, string | undefined>; missing: Set<string> }
    | undefined;

  /** Project names/colours and label colours, fetched at most once per check interval (or for an unknown project). */
  const metaFor = async (http: PluginHttp, intervalMs: number, projectIds: string[]) => {
    await namesLoaded;
    const stale = !meta || Date.now() - meta.at >= intervalMs;
    // Refetch for a project id not seen yet, but not again for one Todoist doesn't list (e.g. archived).
    if (stale || projectIds.some((id) => !meta!.projects.has(id) && !meta!.missing.has(id))) {
      const [projects, labels] = await Promise.all([getProjects(http), getLabels(http)]);
      meta = {
        at: Date.now(),
        projects: new Map(projects.map((p) => [p.id, { name: p.name, color: p.color }] as const)),
        labelColors: new Map(labels.map((l) => [l.name, l.color] as const)),
        missing: new Set<string>(),
      };
      projectIds.forEach((id) => !meta!.projects.has(id) && meta!.missing.add(id));
      rememberProjectNames(projects.map((p) => p.name));
    }
    return meta!;
  };

  /** Tags that stand for a Todoist project (known project names): display-only, never pushed as labels. */
  // Every project name ever seen (persisted), so a tag of a renamed project is still recognised as a project tag.
  const knownProjectNames = new Set<string>();
  const namesLoaded = (async () => {
    try {
      const raw = await deps.projectNameStorage?.load();
      const names = raw ? JSON.parse(raw) : [];
      if (Array.isArray(names)) names.forEach((n) => typeof n === 'string' && knownProjectNames.add(n));
    } catch {
      // unreadable: start empty
    }
  })();
  const rememberProjectNames = (names: string[]) => {
    const before = knownProjectNames.size;
    names.forEach((n) => knownProjectNames.add(n));
    if (knownProjectNames.size !== before) {
      void deps.projectNameStorage?.save(JSON.stringify([...knownProjectNames])).catch(() => undefined);
    }
  };
  const isProjectTag = (tag: string): boolean => knownProjectNames.has(tag);
  const withoutProjectTags = (tags: string[]): string[] => tags.filter((t) => !isProjectTag(t));
  // Last known synced fields per task (persisted), used when a task disappears from Todoist.
  const LAST_KNOWN_MAX = 500;
  const lastKnown = new Map<string, Partial<PluginIssue>>();
  const lastKnownLoaded = (async () => {
    try {
      const raw = await deps.lastKnownStorage?.load();
      const entries = raw ? JSON.parse(raw) : [];
      if (Array.isArray(entries)) for (const [k, v] of entries) if (typeof k === 'string' && v) lastKnown.set(k, v);
    } catch {
      // unreadable: start empty
    }
  })();
  const rememberLastKnown = (issues: PluginIssue[]) => {
    let changed = false;
    for (const i of issues) {
      if (i.state === 'deleted') continue;
      const entry = { title: i.title, content: i.content, dueDay: i.dueDay, dueWithTime: i.dueWithTime, durationMs: i.durationMs, labels: i.labels };
      if (JSON.stringify(lastKnown.get(i.id)) === JSON.stringify(entry)) continue;
      lastKnown.delete(i.id);
      lastKnown.set(i.id, entry);
      changed = true;
    }
    while (lastKnown.size > LAST_KNOWN_MAX) lastKnown.delete(lastKnown.keys().next().value as string);
    if (changed) void deps.lastKnownStorage?.save(JSON.stringify([...lastKnown])).catch(() => undefined);
  };

  /** issue id → its current project tag, so pulls and imports can add it back to SP's tags. */
  const projectTagById = new Map<string, string>();
  const rememberProjectTag = <T extends { id: string; projectTag?: unknown }>(issue: T): T => {
    if (typeof issue.projectTag === 'string' && issue.projectTag) projectTagById.set(issue.id, issue.projectTag);
    return issue;
  };

  /** Project name per task (for the project tag), and the Todoist look of the tasks' tags, reported once. */
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
          styles.set(title, title === project?.name
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
    const last = cache.get(id, Infinity) ?? (lastKnown.get(id) as PluginIssue | undefined);
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
      patch.labels = [...labels].sort();
    }
    if ('durationMs' in changes) {
      const ms = Number(changes.durationMs) || 0;
      Object.assign(body, ms > 0 ? { duration: Math.max(1, Math.round(ms / 60_000)), duration_unit: 'minute' } : { duration: null });
      patch.durationMs = ms > 0 ? ms : 0;
    }
    if ('dueDay' in changes || 'dueWithTime' in changes) {
      const due = dueUpdate(id, changes);
      // Removing the date of an occurrence is never pushed (it would end a series), so no lookup is needed then.
      const live = due && occurrence && !('due_string' in due.body) ? await getTask(http, taskId) : null;
      if (due && (!occurrence || (live && !live.due?.is_recurring))) {
        // One-off task, or an occurrence whose task stopped recurring in Todoist: a plain due update.
        Object.assign(body, due.body);
        Object.assign(patch, due.patch);
      } else if (due && live?.due) {
        // Recurring: move just this occurrence and keep the series. Removing the date is never pushed (ends the series).
        const liveTime = live.due.date.length > 10 ? live.due.date.slice(10) : ''; // e.g. "T09:00:00" or "T08:00:00Z"
        await moveOccurrence(http, live, due.body.due_datetime
          ? { date: `${String(due.body.due_datetime).slice(0, 19)}Z`, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }
          // Day-only move of a timed recurrence keeps its time of day (a bare date would drop it; verified live).
          : { date: `${String(due.body.due_date)}${liveTime}`, ...(liveTime && live.due.timezone ? { timezone: live.due.timezone } : {}) });
        Object.assign(patch, due.patch);
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
    const looked = await mapLimit(missing, MAX_PARALLEL_LOOKUPS, async (id) => [id, await getTask(http, id)] as const);
    await lastKnownLoaded;
    const closedOrGone = new Map(looked);
    const found = [...live.values(), ...looked.flatMap(([, t]) => (t ? [t] : []))];
    const names = await projectNamesFor(http, intervalMs, found);

    const issues = parsed.map(({ id, taskId, occurrence }) => {
      const t = live.get(taskId) ?? closedOrGone.get(taskId) ?? undefined;
      let issue: PluginIssue;
      if (!t) issue = deletedIssue(id);
      else if (occurrence) issue = toIssue(t, id, book.resolve(id, t) === 'done', names.get(t.project_id));
      else issue = toIssue(t, id, t.checked, names.get(t.project_id));
      cache.set(rememberProjectTag(issue));
      return issue;
    });
    rememberLastKnown(issues);
    return issues;
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
        key: 'isDeleteInTodoist',
        type: 'checkbox',
        label: 'Also delete in Todoist when I delete a task here',
        description:
          'Off by default. Applies after the undo time, also in shared projects, and is permanent: Todoist has no ' +
          'trash. Recurring tasks are never deleted, because that would delete the whole series.',
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
      if (!(await deps.getToken())) {
        deps.onConnectionError?.('No Todoist token is set. Add it in Settings → Plugins → Todoist (⚙).');
        return false;
      }
      try {
        await filterTasks(http, settings(config).filter);
        return true;
      } catch (e) {
        deps.onConnectionError?.(connectionError(e));
        return false;
      }
    },

    async searchIssues(term, config, http) {
      const { filter, projectIds, intervalMs } = settings(config);
      const tasks = (await filterTasks(http, searchQuery(filter, term))).filter(inProjects(projectIds));
      const names = await projectNamesFor(http, intervalMs, tasks);
      return tasks.flatMap((t): PluginSearchResult[] => {
        const id = t.due?.is_recurring ? book.peekId(t) : t.id;
        return id ? [rememberProjectTag(toSearchResult(t, id, names.get(t.project_id)))] : [];
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
        return id ? [rememberProjectTag(toSearchResult(t, id, names.get(t.project_id)))] : [];
      });
      backlogKey = key;
      cache.setBacklog(results);
      return results;
    },

    async getById(id, config, http) {
      // SP reads this right before a push to detect remote changes, so it always goes to Todoist (no cache):
      // otherwise a change someone made in Todoist within the interval could be overwritten.
      const [issue] = await fetchIssues([id], http, settings(config).intervalMs);
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
      // Todoist labels ↔ SP tags; the project tag is display-only and never becomes a label.
      mapping('tagIds', 'labels', {
        defaultDirection: 'both',
        toIssueValue: (v) => withoutProjectTags(Array.isArray(v) ? (v as string[]) : []),
        toTaskValue: (v, ctx) => {
          const labels = Array.isArray(v) ? (v as string[]) : [];
          const projectTag = projectTagById.get(ctx.issueId);
          return projectTag && !labels.includes(projectTag) ? [...labels, projectTag] : labels;
        },
      }),
    ],

    extractSyncValues: (issue) => ({
      ...Object.fromEntries(SYNC_FIELDS.map((f) => [f, issue[f]])),
      labels: Array.isArray(issue.labels) ? withoutProjectTags(issue.labels as string[]).sort() : [],
    }),

    deletedStates: ['deleted'],

    /** SP calls this after its undo window when a linked task is deleted. Opt-in; never for recurring tasks. */
    async deleteIssue(id, config, http) {
      if (!(config as TodoistSyncConfig).isDeleteInTodoist) return;
      const { taskId, occurrence } = parseIssueId(id);
      if (occurrence) return; // deleting one occurrence would delete the whole series in Todoist
      await deleteTask(http, taskId);
    },

    async updateIssue(id, changes, _config, http) {
      const { taskId, occurrence } = parseIssueId(id);
      await pushFields(id, taskId, occurrence, changes, http);
      if ('checked' in changes) await pushDone(id, taskId, occurrence, Boolean(changes.checked), http);
    },
  };
}
