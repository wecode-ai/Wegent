---
sidebar_position: 40
---

# Issue notification and human-task CI regression

## Evidence and fix boundaries

PR #3763 at `f124f3d2e` failed desktop Core shards 12 and 15:

- The `project-assignment-notification` failure snapshot contains the bound
  Task entry below the viewport. The visible-element click command does not scroll.
  The scenario must check disclosure state, wait for the row, and scroll before
  clicking, while retaining its bound-model assertion.
- The first deep link in `collaboration-issue-comment-notification` highlights
  correctly. After reload, clicking the same notification does not highlight again:
  the unchanged route issues no new focus request, and the view deduplicates by
  comment ID indefinitely.

Each comment navigation receives an internal `focusRequest` through the
existing project route. Tab matching ignores that request identifier to reuse
the existing tab. Each request scrolls and highlights once; background message
updates do not rehighlight. A rapid repeat ends the old animation and starts a
new one on the next frame. No user-entered fields, model/device routing changes,
or human submission permission changes are introduced.

## QA plan

Environment: isolated Electron with real Backend, Socket.IO and devices; only
model services use the scenario's test service. Focused local Vitest checks run
before submission; existing GitHub Core shards provide desktop validation.
Do not drive a personal window, rerun to obtain green, increase timeouts, or skip assertions.

| Preconditions                                          | Action                                                                   | Expected result                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Human Issue has a bound remote AI-draft Task           | Change the new-chat default; expand, scroll to and reopen the bound Task | Retain the bound model; human submission remains required                         |
| First comment notification                             | Open its deep link                                                       | Scroll and highlight within existing budgets; other comments remain unhighlighted |
| Reload restored the same comment; previous flash ended | Click the same inbox notification                                        | Reuse the tab, issue a fresh focus, highlight again and persist read state        |
| Flash still active                                     | Refocus the same comment quickly                                         | Restart the animation rather than inherit its remaining duration                  |
| Focus request unchanged                                | Background messages or rerender                                          | No repeated scrolling or highlighting                                             |
| Comment not loaded, or focus cleared                   | Load it; leave and refocus                                               | Highlight after loading; refocusing is allowed                                    |
| Animation frame pending                                | Unmount                                                                  | Clean up animation frames and timers                                              |

Existing CI scenarios retain real remote-device, binding, delivery, human
submission/review and read-persistence assertions. Keep failure snapshots/logs
and inspect success screenshots. Fixtures use isolated users, projects and run
directories, cleaned up by the desktop runner.

## Verification record

2026-10-09: new repeated-notification routing and highlight assertions failed
before the fix and passed afterward. Seven focused files with 177 tests passed,
covering notification routing, comment focus, the Issue editor and human-task
drawers. ESLint, Prettier, TypeScript and both scenario syntax checks passed.
Local results do not
establish real remote-device or desktop E2E success; final verification belongs
to CI on the fix commit.

After the push, main introduced Issue archiving and conflicted in the properties
menu. The merge retains the archive label/callback and outside-click dismissal,
with a regression assertion covering both. Revalidate shared archive components,
the desktop editor and Backend endpoints after the merge.

Main subsequently unified Issue execution state and replies. The merge must keep
both the agent Team/model binding and the execution thread, workspace and Issue
session context, including bindings with no selected model. Focused tests caught
a missing database argument in the successful continuation status push to
`to_view`; it has been corrected. Verify original-session continuation, queued
replies, reassignment and manually bound agent models. The panel-reopening unit
test establishes its active project directly, reuses its interaction device and
asserts that the old panel closed before reopening. It retains the late-address
isolation assertion without increasing the timeout.

## Reassignment to the same human after unassignment

Core shard 12 at `f5bbaab0c` failed after human acceptance and reassignment:
`human_work.state` remained `accepted` instead of `none` for the new assignment.
The legacy PATCH endpoint cleared the assignee field without revoking its
assignment activity, so assigning the same human again was incorrectly
deduplicated. Direct human unassignment now reuses the existing event removal
service in the same version-checked transaction as the assignee update.

Regression coverage includes reassignment to the same or another human on
in-review and completed Issues. A new event ID preserves the Issue status until
the human explicitly starts work. Repeated assignment without unassignment stays
idempotent; version conflicts preserve assignments; workflow-step assignments
are not removed. Existing review records, desktop E2E assertions and timeouts
remain unchanged.

## Main-branch merge regression on 2026-10-10

Keep main's inline Issue title/description editing, attachment previews and
personal-task workspace selection alongside human processing, AI drafts, tag
editing and outside-click dismissal. Ordinary personal tasks do not inherit an
agent's project environment; human AI assistance still uses the latest saved
project device/directory and human assignment binding. Comment notifications
use the same internal `focusRequest` parameter throughout navigation. Timestamp
normalization uses the configurable database timezone without shifting SQLite
or already timezone-aware values twice.

Project creation/view switching and member, bot and group assignment component
tests are separate scenarios, each establishing its own prerequisites and
retaining the original assertions without extra timeouts or retries. Verify
shared components, desktop editors/drawers/notifications, Web details and
database timestamps after merging. Focused unit tests and type checks are not
real remote-device or desktop E2E acceptance.
