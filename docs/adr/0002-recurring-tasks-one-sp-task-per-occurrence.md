---
status: accepted
date: 2026-11-25
---

# Recurring Todoist tasks: one SP task per occurrence

## Context and Problem Statement

A recurring Todoist task has a single id. Closing it doesn't close it: Todoist moves it to the next date. If SP
treated that id as one task, ticking it off in SP would be undone at the next refresh, and tracked time would pile
up on a single SP task. We need a model where completing an occurrence in either app behaves the way it does in
Todoist, without duplicates and without wrongly marking tasks done.

## Considered Options

* One SP task per occurrence, issue id `<todoistId>@<YYYY-MM-DD>`
* One SP task per series that reopens with the next date
* Leaving recurring tasks out

## Decision Outcome

Chosen option: "one SP task per occurrence", because completed occurrences stay done with their own tracked time,
and the next occurrence shows up as a new task, as in Todoist.

Rules that keep it correct, all verified against the live Todoist API (v1):

* **At most one open SP task per recurring Todoist task.** The next occurrence is only offered after the previous
  one is known completed. When an occurrence is merely rescheduled in Todoist, the existing SP task moves with it.
* **Completed or rescheduled is decided by `completed_count`.** Todoist increments it on every completion, and only
  increments `postponed_count` on a reschedule. The plugin records the count when an occurrence becomes open. The
  completed-tasks endpoint did not list recurring completions in testing.
* **Moving an occurrence from SP uses the Sync API** (`item_update` with the new date and the unchanged recurrence
  `string`/`lang`). The REST `due_date`/`due_datetime` fields would end the series.
* **Never pushed for recurring tasks:** removing the date, which would end the series, and un-ticking, where reopening
  is ambiguous on a shared list.

### Consequences

* Good, because history and time tracking per occurrence are correct, and shared recurring tasks keep their series.
* Bad, because the plugin keeps bookkeeping (open occurrence and baseline count per task) in SP's plugin data.
* Bad, because it relies on Todoist's `completed_count` semantics, which aren't formally documented.
