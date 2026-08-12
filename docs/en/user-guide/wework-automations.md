---
sidebar_position: 8
---

# Wework automations

Wework automations start Codex Runtime tasks on a fixed schedule, at a recurring
interval, or at a specific time. Open **Automations** from the Wework sidebar;
the entry is available without enabling experimental features.

## Local mode

Local automations are stored in the current device's Executor data directory and
are scheduled by the local Executor.

- Users select a project instead of entering a filesystem working directory.
  Automations created from the current project or task inherit that project;
  selecting **None** gives each new task an independent workspace instead of
  grouping it under the current project.
- Creating, editing, disabling, and running automations works without a Wegent connection.
- Recurring runs missed while Wework is closed are recorded as skipped instead of being replayed.
- A missed one-time run executes once after Wework starts again.
- A new trigger is skipped while another run of the same automation is active.
- Configuration and run history are not synchronized to the cloud.

## Cloud mode

Cloud automations are not currently available. The **Cloud** option remains
visible in Wework but cannot be selected. Automations are stored, scheduled,
and executed by the current device's local Executor.

## Schedule types

- **Fixed time** uses a Cron expression and IANA time zone. For example,
  `0 9 * * 1-5` runs at 9:00 AM on weekdays.
- **Interval** repeats in minutes, hours, or days.
- **One time** runs at a specific time and disables itself after scheduling.

## Persistent goals

When **Keep pursuing a goal** is enabled, Wework uses the task instructions as
a persistent Codex goal instead of a one-turn message. Codex can continue
working until it explicitly marks the goal complete or blocked. The setting
works with both conversation modes and is persisted with the automation.

## Conversation modes

- **Create a new task each run** creates an independent Codex task and is suitable
  for reports, checks, and recurring analysis.
- **Existing task** selects a pinned, continuable local task and appends every
  later run to that task. Regular history and a task that is merely open are
  not selected automatically; pin the task in the sidebar first.

## Viewing details

When **Automations** opens, Wework displays the first task after the initial
load. After you close the detail pane with its top-right close button, the pane
stays closed. Select a task in the list to open its details again.

Automations run unattended by default. If Codex requests user input, Wework does
not guess an answer and marks the run as **Needs attention**.
