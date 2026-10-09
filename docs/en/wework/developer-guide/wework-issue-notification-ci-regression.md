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

Each comment navigation receives an internal `commentFocusKey` through the
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
