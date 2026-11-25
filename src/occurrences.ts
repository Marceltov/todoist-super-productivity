import { issueIdFor, parseIssueId } from './mapping';
import type { TodoistTask } from './types';

/**
 * Bookkeeping for recurring Todoist tasks, where each occurrence is its own SP task ("<id>@<date>").
 * Rule: at most one open SP task per recurring Todoist task. The next occurrence is only imported once the
 * previous one is known completed, so rescheduling an occurrence in Todoist moves the existing SP task instead of
 * creating a duplicate.
 */
export interface OccurrenceState {
  /** todoistTaskId -> the open SP issue id and the task's completed_count when it became open */
  open: Record<string, { id: string; count: number }>;
  completed: string[]; // issue ids known completed (most recent last)
}

export interface Storage {
  load(): Promise<string | null>;
  save(data: string): Promise<void>;
}

const MAX_COMPLETED = 500;

export class OccurrenceBook {
  private constructor(private state: OccurrenceState, private readonly storage: Storage) {}

  static async load(storage: Storage): Promise<OccurrenceBook> {
    let state: OccurrenceState = { open: {}, completed: [] };
    try {
      const raw = await storage.load();
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<OccurrenceState>;
        const open = Object.fromEntries(
          Object.entries(parsed.open ?? {}).filter(([, v]) => v && typeof v === 'object' && typeof v.id === 'string'),
        );
        state = { open, completed: parsed.completed ?? [] };
      }
    } catch {
      // Unreadable bookkeeping: start fresh. Worst case is one extra import that SP's id check deduplicates.
    }
    return new OccurrenceBook(state, storage);
  }

  /** The issue id that should exist in SP for this recurring task, or null while another occurrence is open. */
  peekId(task: TodoistTask): string | null {
    const id = issueIdFor(task);
    const open = this.state.open[task.id];
    return !open || open.id === id || this.isCompleted(open.id) ? id : null;
  }

  /** Like peekId, and records the returned id as the task's open occurrence (backlog import). */
  idToImport(task: TodoistTask): string | null {
    const id = this.peekId(task);
    if (id && this.state.open[task.id]?.id !== id) {
      this.state.open[task.id] = { id, count: task.completed_count ?? 0 };
      void this.persist();
    }
    return id;
  }

  /** completed_count of the task when this occurrence became open; undefined if it isn't the recorded open one. */
  openCount(issueId: string): number | undefined {
    const open = this.state.open[parseIssueId(issueId).taskId];
    return open?.id === issueId ? open.count : undefined;
  }

  isCompleted(issueId: string): boolean {
    return this.state.completed.includes(issueId);
  }

  async markCompleted(issueId: string): Promise<void> {
    if (!this.isCompleted(issueId)) {
      this.state.completed = [...this.state.completed, issueId].slice(-MAX_COMPLETED);
    }
    const { taskId } = parseIssueId(issueId);
    if (this.state.open[taskId]?.id === issueId) delete this.state.open[taskId];
    await this.persist();
  }

  /**
   * Done-ness of an occurrence from the live base task. Todoist increments completed_count on every completion,
   * and only postponed_count on a reschedule, so a higher count than when the occurrence became open means done.
   */
  resolve(issueId: string, live: TodoistTask | undefined): 'open' | 'done' | 'unknown' {
    if (this.isCompleted(issueId)) return 'done';
    if (!live) return 'unknown';
    const { taskId } = parseIssueId(issueId);
    const count = live.completed_count ?? 0;
    const open = this.state.open[taskId];
    if (live.checked || (open?.id === issueId && count > open.count)) {
      void this.markCompleted(issueId);
      return 'done';
    }
    if (!open) {
      // First sighting (e.g. added via search): today's count is the baseline.
      this.state.open[taskId] = { id: issueId, count };
      void this.persist();
    }
    return 'open';
  }

  private persist(): Promise<void> {
    return this.storage.save(JSON.stringify(this.state)).catch(() => undefined);
  }
}
