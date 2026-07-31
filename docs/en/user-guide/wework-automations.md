---
sidebar_position: 8
---

# Wework automations

Wework automations start Codex Runtime tasks on a fixed schedule, at a recurring
interval, or at a specific time. Open **Automations** from the Wework sidebar.

## Local mode

Local automations are stored in the current device's Executor data directory and
are scheduled by the local Executor.

- Users select a project instead of entering a filesystem working directory.
  Automations created from the current project or task inherit that project;
  selecting **None** uses the selected device's default directory.
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

## Conversation modes

- **Create a new task each run** creates an independent Codex task and is suitable
  for reports, checks, and recurring analysis.
- **Existing task** selects a pinned, continuable local task and appends every
  later run to that task. Regular history and a task that is merely open are
  not selected automatically; pin the task in the sidebar first.

Automations run unattended by default. If Codex requests user input, Wework does
not guess an answer and marks the run as **Needs attention**.
