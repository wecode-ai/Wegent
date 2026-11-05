---
sidebar_position: 8
---

# Wework automations

Wework automations start Codex Runtime tasks on a fixed schedule, at a recurring
interval, or at a specific time. Open **Automations** from the Wework sidebar;
the entry is available without enabling experimental features.

## Source rules in collaboration and My stand-in

Project **Automatic processing** has one **New rule** entry. It follows the personal stand-in
connection flow: choose email, messages, a project, or time; choose the specific connection;
then configure its trigger and action. Email and message sources reuse the personal connection
search and selection list rather than a separate provider/resource form. After selecting a source,
configure the event, optional message conditions, published Issue title, authorized result and
project handler. Source conditions and publication requirements remain private on the collection
device. The project stores the rule name, assignment, Issue instructions and published results.

My stand-in keeps its **Connections** entry. **Edit handling rule** exposes the
same message conditions and handling instructions while preserving immediate
processing, work grouping and native operation confirmations. Disabling handling
does not revoke the account connection. Scheduled tasks retain the Automations
entry and their existing conversation and notification behavior.

Original messages, account details, credentials, private attachments and collection
records are not published as project events or execution context. Explicitly
configure the result authorized for publication; published Issues and results
follow project permissions. Do not place private information in shared rule names
or Issue handling instructions.

The device where a rule is configured collects its source. Collection pauses while
the device is closed or asleep and resumes from its persisted position. Open **Run history**
beside a rule to inspect runs and open published Issues. Failed
publications that support recovery can be retried from the rule history, reusing the same
run and any prepared result. Failed runs already accepted by the project recover
through the existing project retry flow without delivering the message again.
Changing or disabling a rule cancels older runs that
have not been delivered. Work already delivered remains in the project run history. New source rules do not replay messages from before they were enabled.

Local source rules may continue during a cloud transport outage using the same previously
verified device and account connection. Account switching, connection configuration changes
or invalid account authentication invalidate that evidence. A denied project operation does not affect other local rules.
Cloud delivery and execution still require current online authorization. You can remove
your device's private source rule and inspect its history after losing project administration.
Members without project settings access can open **My source rules** in the project header.
It hides creation and toggle actions and disables editing while retaining
**Remove my private rule**. An authorized project member must clean up shared automation and
connection settings. Switching accounts, service addresses or collection devices immediately
clears the previous identity's rules, editor drafts and run history. “Delivered”
means the server accepted the publication; “Issue
created” links to its result. “Recheck source” clears a recovered connection error
without resetting its collection checkpoint.

## Local scheduled mode

Local automations are stored in the current device's Executor data directory and
are scheduled by the local Executor.

- Users select a project instead of entering a filesystem working directory.
  Automations created from the current project or task inherit that project;
  selecting **None** gives each new task an independent workspace instead of
  grouping it under the current project.
- When a project has Wework-managed worktrees, the project selector lists both
  the primary workspace and each worktree. Selecting a worktree runs the
  scheduled task directly in that worktree directory.
- Creating, editing, disabling, and running automations works without a Wegent connection.
- Recurring runs missed while Wework is closed are recorded as skipped instead of being replayed.
- A missed one-time run executes once after Wework starts again.
- A new trigger is skipped while another run of the same automation is active.
- Configuration and run history are not synchronized to the cloud.

## Cloud mode

**Cloud** includes both Wegent cloud devices and Remote Docker devices. After
you select a device, its Executor stores, schedules, and runs the automation;
Wework does not need to remain open when a run is triggered.

- A device must be online, run a compatible Executor version, and use the
  Claude Code shell before it can be selected. Offline or incompatible devices
  remain visible but are disabled.
- A Remote Docker host must remain running and connected to Wegent when a run
  is scheduled.
- Configuration and run history stay on the selected Executor. They are not
  synchronized or migrated between the local device, cloud devices, and Remote
  Docker devices.
- The location and device are locked after an automation is saved. Create a new
  automation to move the schedule to another Executor.
- Recurring runs missed by more than one minute while the Executor is stopped
  are recorded as skipped. A missed one-time run executes once when the
  Executor recovers.

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
- **Existing task** selects a pinned, continuable task on a local, cloud, or
  Remote Docker device and appends every later run to that task. Regular
  history and a task that is merely open are not selected automatically; pin
  the task in the sidebar first. Tasks on offline or incompatible devices stay
  visible but cannot be selected.

## Viewing details

When **Automations** opens, Wework displays the first task after the initial
load. After you close the detail pane with its top-right close button, the pane
stays closed. Select a task in the list to open its details again.

Automations run unattended by default. If Codex requests user input, Wework does
not guess an answer and marks the run as **Needs attention**.
