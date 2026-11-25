---
status: accepted
date: 2026-11-25
---

# Standalone Super Productivity plugin with two-way Todoist sync

## Context and Problem Statement

Super Productivity (SP) only ships a one-time Todoist importer. Its maintainers have said ongoing two-way sync is
out of scope for the app (super-productivity#548). We want a chosen subset of Todoist tasks in SP, where we plan our
day, without giving up Todoist as a list that is shared with other people. The question is where the sync lives and
which fields it owns.

## Considered Options

* A standalone SP issue-provider plugin, on SP's public plugin API (v20+)
* A contribution to SP as a bundled provider
* A separate local sync service, talking to SP through its MCP endpoint or local REST API

## Decision Outcome

Chosen option: "a standalone SP issue-provider plugin", because SP's plugin API already provides everything a
provider needs (search, refresh, field mappings with per-field sync directions, pushes through `updateIssue`), and a
bundled provider was ruled out upstream. A local service can't complete tasks through SP's assistant interfaces.

Details that follow from this:

* **All mapped fields sync both ways by default** (done, title, due day/time, estimate ↔ duration, tags ↔ labels).
  Users can change each field's direction in SP's Two-Way Sync settings. Planning in SP is meant to be visible to the
  people the Todoist list is shared with.
* **The API token lives in SP's device-local secret storage** (`setSecret`), entered through the plugin's own
  settings dialog. It does not go into `configFields`, which SP syncs and exports.
* **Search results carry every synced field.** SP takes the push baseline of a newly added task from the search
  result. An incomplete result makes SP skip pushes until the next refresh.
* **The check interval is a plugin setting:** the manifest polls every minute, and an in-memory cache limits Todoist
  calls to the configured interval.
* **Project tags:** a task's Todoist project is shown as a display-only tag (icon `tag`), recognised by project name
  and never pushed as a label. SP's sync interface has no project field, so moving tasks between projects isn't
  synced.

### Consequences

* Good, because it works with any SP desktop install (v20+) without waiting for upstream.
* Bad, because the SP plugin API is marked experimental, so an SP update can break the plugin.
* Bad, because updates are installed by hand (upload the ZIP, then restart SP).
