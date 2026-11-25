# Todoist for Super Productivity

A [Super Productivity](https://super-productivity.com) plugin that keeps a chosen part of your Todoist in sync with
Super Productivity, in both directions. Todoist can stay the list you share with others while Super Productivity is
where you plan your day.

- **Pick what comes in:** a Todoist filter plus a project selection. You add tasks from the side panel with **+**, the
  same way as GitHub issues, or turn on auto-import.
- **Two-way sync:**
  - Ticking a task off in either app completes it in the other.
  - Planning a day or a time in Super Productivity (including adding a task to *Today*) sets the due date in
    Todoist.
  - Title, estimate (Todoist *duration*) and labels sync too.
- **Recurring tasks:** each occurrence becomes its own Super Productivity task. Moving one occurrence keeps the
  series ("every Monday" stays "every Monday"), and the next occurrence is offered after you complete the current one.
- **Tags in Todoist colours:** Todoist labels become tags with a label icon. The task's Todoist project becomes a tag
  with a `#` icon. Both get their Todoist colour.
- **Private by design:** the API token stays on your device, in Super Productivity's secret storage, so it is never
  synced or exported.

Requires the Super Productivity **desktop app 20 or newer**.

## Install

1. Download `todoist-sync-<version>.zip` from [Releases](../../releases).
2. In Super Productivity, go to **Settings → Plugins → Choose Plugin File** and pick the ZIP.
3. **Quit Super Productivity completely (Cmd+Q / Alt+F4) and open it again.** This is also needed after every
   update; otherwise the old plugin code keeps running.

## Set up

1. **Token:** in Settings → Plugins → Todoist, click **⚙** and paste your personal API token. You find it in Todoist
   under *Settings → Integrations → Developer*.
2. **Add the integration:** in the right panel, click **+** and then **Todoist**.
   - **Todoist filter (optional):** leave it empty for "tasks assigned to me, plus unassigned tasks in my own
     projects" (`assigned to: me | (!assigned & !shared)`), or enter any
     [Todoist filter](https://todoist.com/help/articles/introduction-to-filters-V98wIH).
   - **Projects:** limit the import to some Todoist projects. Leave it empty for all.
   - **Check Todoist every:** for example `5m` or `1h 30m` (default 5 minutes, minimum 1 minute).
   - **Two-Way Sync:** every field syncs **both ways** by default. You can change each field there. Tick
     **Auto-create tags** so labels and projects that don't exist as tags yet are created.
3. Click **Test Connection**, then **Save**. Your tasks now appear in the Todoist panel. Add them with **+**.

## Good to know

- **Shared projects:** whatever you change in Super Productivity (done, dates, titles, labels) is visible to
  everyone in the shared Todoist project.
- **Recurring tasks:** removing the date of a recurring task in Super Productivity is never sent to Todoist, because
  that would end the series. Un-ticking a completed occurrence doesn't reopen anything in Todoist.
- **Deleted in Todoist:** the task is marked as removed in Super Productivity. A network error never counts as
  "deleted" or "done".
- **Moving tasks between projects** isn't synced: Super Productivity's sync interface has no project field. Use the
  project tag to see where a task comes from, and plan in *Today* / *Planner*.
- **A label named exactly like a project** is treated as the project tag and isn't sent back as a label.
- The plugin runs inside Super Productivity without a sandbox (as all Super Productivity plugins do), so only install
  it from this repository.

## What is sent where

Only to `api.todoist.com`: your token (as the `Authorization` header), search terms, task ids, and the fields you
change (done, title, due date/time, duration, labels). Nothing else leaves your device. Todoist's privacy policy:
https://doist.com/privacy

## Development

```bash
npm install
npm test            # vitest
npm run typecheck
npm run build       # dist/plugin.js (one IIFE) + manifest + icon
npm run pack        # todoist-sync-<version>.zip
```

`scripts/verify-api.mjs` checks the Todoist API behaviour the plugin relies on, against a throwaway project whose name
starts with `sp-test`. It reads a token from `.dev-token`, which is git-ignored.

Design decisions: [`docs/adr/`](docs/adr/).

## License

MIT
