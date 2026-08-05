# Design QA: Wework priority sidebar

## Sources

- User-provided ChatGPT and previous Wework priority-sidebar screenshots attached to
  the task.
- ChatGPT desktop implementation inspected from the supplied local app bundle; no
  extracted ChatGPT source or asset is shipped.
- Real Tauri screenshots were inspected during development and retained as local,
  ignored verification artifacts.
- Reproducible automated evidence is the `priority-filter` checkpoint in
  `wework/e2e/desktop/task-flow.e2e.mjs` and its Wework Desktop E2E CI job.

## Verification context

- Product: Wework desktop workbench
- Runtime: real isolated Tauri development instance
- Viewport capture: 2560 × 1440
- Sidebar width in capture: 500 physical pixels
- State: priority filter active, one running local project task

## Comparison

The ChatGPT priority list uses distinct two-line task rows: a primary title and a muted
source line with a project or local-device icon. Rows have more vertical breathing room
than ordinary sidebar history rows, while trailing status and hover actions occupy a
stable right-side rail.

The verified Wework implementation now matches those structural characteristics:

- priority rows use a 48-pixel minimum height and compact vertical padding;
- title and source metadata form a clear two-level hierarchy;
- project tasks show their project name and standalone tasks show Wework;
- waiting tasks use the compact blue attention dot;
- running tasks retain the animated progress indicator;
- hover actions remain visible and aligned without changing the row height;
- ordinary non-priority task rows retain their existing dense 30-pixel layout.

## Behavior parity

The implementation follows the session model used by ChatGPT's priority view:

- opening Priority snapshots the current priority, pinned, and recent task placement;
- reading or completing an unread task does not remove it during the active session;
- closing and reopening Priority rebuilds the snapshot, moving eligible handled tasks to
  the date-grouped Recent section;
- tasks that become urgent while Priority is open are appended without reordering the
  existing snapshot;
- a task already placed in Recent stays there if it becomes urgent during the same session;
- Recent includes the last seven local calendar days and groups entries as Today,
  Yesterday, or weekday;
- pinned tasks stay in Priority by default and move to a separate Pinned section when
  “Show pinned” is enabled;
- “Mark all as read” only affects unread tasks in Priority;
- bulk archive only targets the current Priority section, preserving Recent and Pinned;
- archived or deleted tasks are removed from the active snapshot.

Wework does not expose scheduled-task metadata through `RuntimeTaskSummary`, so the
ChatGPT “Show scheduled” option is intentionally not fabricated.

## QA plan and results

| Behavior               | Preconditions and exact steps                                                                                                       | Expected and actual result                                                                                                                                                          | Negative and recovery coverage                                                                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read persistence       | Start an isolated Tauri instance, create a waiting task, open Priority, open the task, answer its request, and wait for completion. | The handled task remains in Priority for the current session. Passed in real Tauri and the CI checkpoint.                                                                           | Closing and reopening Priority rebuilds placement; the handled task moves to Today under Recent and Priority shows its empty state.                                                   |
| Dynamic reconciliation | Keep Priority open with one Recent task, then create a new waiting task.                                                            | The new urgent task appends to Priority without moving the existing Recent task. Passed in real Tauri and component tests.                                                          | If an existing Recent task becomes unread, it remains in Recent for that session; deleting or archiving a task removes it from the snapshot.                                          |
| Show pinned            | Open Priority with a pinned waiting task, open the options menu, and toggle Show pinned on and off.                                 | On: the task moves to Pinned and Priority shows its empty state when no unpinned urgent task remains. Off: it returns to Priority. Passed in component and real-Tauri verification. | The global attention dot still reports the pinned urgent task while pinned items are not separated.                                                                                   |
| Seven-day Recent       | Activate Priority at a fixed local time with tasks on Today, Yesterday, the seventh-day cutoff, and one second before the cutoff.   | The first three dates are grouped and the older task is excluded. Passed in pure state-model tests, including the inclusive cutoff boundary.                                        | Reopening creates a fresh local-calendar cutoff; stale and missing tasks are pruned.                                                                                                  |
| Mark all read          | Open Priority with unread, waiting, pinned, and Recent tasks; choose Mark all as read.                                              | Only unread tasks currently placed in Priority receive the read action. Passed in component tests.                                                                                  | The action is disabled when Priority has no unread item and does not mutate Recent or separately pinned tasks.                                                                        |
| Bulk archive           | Open Priority with multiple urgent tasks and a Recent task; choose Archive tasks and confirm.                                       | Every Priority item is attempted; Recent and separately pinned items are not archived. Passed in component tests.                                                                   | A rejected item is logged and does not stop later items; the dialog closes. Dirty worktrees are collected into the force-confirmation recovery dialog, and cancel leaves them intact. |

## Cleanup

- Stopped the isolated Tauri session and its session-local Executor process group.
- Kept generated screenshots and desktop diagnostics under ignored test-result
  directories; no local authentication data or runtime artifacts are committed.
- The CI checkpoint creates and removes its own isolated workspace and task fixtures.

## Iteration history

1. Replaced the dense one-line priority rendering with a dedicated two-line layout.
2. Restored the original one-line markup for non-priority rows after focused tests
   detected a selector-level regression.
3. Added a one-pixel list gap and tightened section horizontal alignment.
4. Replaced the live-only filter with a stable priority-session snapshot and reconciliation
   model derived from the ChatGPT implementation.
5. Added separate pinned and seven-day Recent sections, plus matching bulk actions.
6. Verified read persistence, reopen behavior, dynamic append, and pinned placement in a
   real isolated Tauri session.
7. Added the same read-persistence and reopen flow to the CI-covered desktop
   `priority-filter` checkpoint.

## Verification

- Focused priority unit and component tests: 95 passed.
- Full Wework test suite after merging the latest `main`: 2,609 passed.
- TypeScript typecheck: passed.
- Changed-file ESLint and Prettier checks: passed.
- Real isolated Tauri interaction chain: passed.
- CI-covered desktop `priority-filter` E2E checkpoint: passed.

## Result

Passed. The priority view now matches the relevant ChatGPT visual hierarchy and
session behavior, including the case where selecting an unread task must not make it
disappear immediately.
