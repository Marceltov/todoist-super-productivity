import type { PluginIssue, PluginSearchResult } from '@super-productivity/plugin-api';

const DEFAULT_MS = 5 * 60_000;
const MIN_MS = 60_000;
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parses SP-style durations ("5m", "1h 30m", "90s"); invalid or empty → 5 min; never below 1 min. */
export const parseInterval = (text: string | undefined): number => {
  const t = (text ?? '').trim().toLowerCase();
  if (!/^(\d+\s*[smhd]\s*)+$/.test(t)) return DEFAULT_MS;
  const ms = [...t.matchAll(/(\d+)\s*([smhd])/g)].reduce((sum, [, n, u]) => sum + Number(n) * UNIT_MS[u], 0);
  return Math.max(ms, MIN_MS);
};

/**
 * SP polls every minute (manifest pollIntervalMs); this cache makes the plugin talk to Todoist only once per
 * user-configured interval. In-memory only: an app restart simply fetches fresh data.
 */
export class RefreshCache {
  private issues = new Map<string, { at: number; issue: PluginIssue }>();
  private backlog?: { at: number; results: PluginSearchResult[] };

  constructor(private readonly now: () => number = Date.now) {}

  get(issueId: string, maxAgeMs: number): PluginIssue | undefined {
    const e = this.issues.get(issueId);
    return e && this.now() - e.at < maxAgeMs ? e.issue : undefined;
  }

  set(issue: PluginIssue): void {
    this.issues.set(issue.id, { at: this.now(), issue });
  }

  getBacklog(maxAgeMs: number): PluginSearchResult[] | undefined {
    return this.backlog && this.now() - this.backlog.at < maxAgeMs ? this.backlog.results : undefined;
  }

  setBacklog(results: PluginSearchResult[]): void {
    this.backlog = { at: this.now(), results };
  }
}
