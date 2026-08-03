# Design QA: Wework priority sidebar

## Sources

- Reference screenshot: `/Users/axb-mac/.wegent-executor/workspace/attachments/draft/1785728366836/image.png`
- Previous Wework screenshot: `/Users/axb-mac/.wegent-executor/workspace/attachments/draft/1785728373311/image.png`
- Reference implementation: `/Users/axb-mac/dev/aigc/wegent_workspace/chatgpt-app-asar/webview/assets/app-initial-DRyZ1Lin.js`
- Verified implementation screenshot: `wework/test-results/ai-verify/2026-08-03T03-51-11-593Z-40243/priority-sidebar.png`
- Recent-after-reopen screenshot: `wework/test-results/ai-verify/2026-08-03T06-19-53-806Z-59202/priority-recent-after-reopen.png`
- Dynamic-append screenshot: `wework/test-results/ai-verify/2026-08-03T06-19-53-806Z-59202/priority-dynamic-append.png`
- Desktop E2E evidence: `wework/test-results/desktop-e2e/2026-08-03T06-24-35-705Z-80140`

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
- Full Wework test suite: 2,588 passed.
- TypeScript typecheck: passed.
- Changed-file ESLint and Prettier checks: passed.
- Real isolated Tauri interaction chain: passed.
- CI-covered desktop `priority-filter` E2E checkpoint: passed.

## Result

Passed. The priority view now matches the relevant ChatGPT visual hierarchy and
session behavior, including the case where selecting an unread task must not make it
disappear immediately.
