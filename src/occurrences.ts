import { issueIdFor, parseIssueId } from './mapping';
import type { TodoistTask } from './types';

/**
 * Bookkeeping for recurring Todoist tasks, where each occurrence is its own SP task ("<id>@<date>").
 * Rule: at most one open SP task per recurring Todoist task. The next occurrence is only imported once the
 * previous one is known completed, so rescheduling an occurrence in Todoist moves the existing SP task instead of
 * creating a duplicate.
 */
export interface OccurrenceState {
  open: Record<string, string>; // todoistTaskId -> open SP issue id
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
        state = { open: parsed.open ?? {}, completed: parsed.completed ?? [] };
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
    return !open || open === id || this.isCompleted(open) ? id : null;
  }

  /** Like peekId, and records the returned id as the task's open occurrence (backlog import). */
  idToImport(task: TodoistTask): string | null {
    const id = this.peekId(task);
    if (id && this.state.open[task.id] !== id) {
      this.state.open[task.id] = id;
      void this.persist();
    }
    return id;
  }

  isCompleted(issueId: string): boolean {
    return this.state.completed.includes(issueId);
  }

  async markCompleted(issueId: string): Promise<void> {
    if (!this.isCompleted(issueId)) {
      this.state.completed = [...this.state.completed, issueId].slice(-MAX_COMPLETED);
    }
    const { taskId } = parseIssueId(issueId);
    if (this.state.open[taskId] === issueId) delete this.state.open[taskId];
    await this.persist();
  }

  /** Done-ness of an occurrence, from the live base task and the ids of tasks completed since it was due. */
  resolve(issueId: string, live: TodoistTask | undefined, completedTaskIds: Set<string>): 'open' | 'done' | 'unknown' {
    if (this.isCompleted(issueId)) return 'done';
    if (!live) return 'unknown';
    const { taskId, occurrence } = parseIssueId(issueId);
    const moved = live.due?.date.slice(0, 10) !== occurrence;
    if (live.checked || (moved && completedTaskIds.has(taskId))) {
      void this.markCompleted(issueId);
      return 'done';
    }
    // Same date, or moved without a completion record: a reschedule. The SP task keeps its id.
    if (!this.state.open[taskId]) {
      this.state.open[taskId] = issueId;
      void this.persist();
    }
    return 'open';
  }

  private persist(): Promise<void> {
    return this.storage.save(JSON.stringify(this.state)).catch(() => undefined);
  }
}
