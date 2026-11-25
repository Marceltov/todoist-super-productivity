// Todoist API v1 shapes (only the fields this plugin uses).
export interface TodoistDue {
  date: string;
  datetime?: string | null;
  timezone?: string | null;
  is_recurring: boolean;
  string: string;
  lang?: string;
}

export interface TodoistTask {
  id: string;
  content: string;
  description: string;
  checked: boolean;
  completed_at?: string | null;
  updated_at?: string | null;
  due: TodoistDue | null;
  duration: { amount: number; unit: 'minute' | 'day' } | null;
  project_id: string;
  /** Increments on every completion, also for recurring tasks (verified live 2026-11-25). */
  completed_count?: number;
  labels?: string[];
}

/** Non-secret provider settings, as SP stores them in the synced provider config. */
export interface TodoistSyncConfig {
  filterQuery?: string;
  checkInterval?: string;
  projectIds?: string[];
}
