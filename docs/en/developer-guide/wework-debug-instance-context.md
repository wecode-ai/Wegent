---
sidebar_position: 35
---

# Debug Instance Labels

Wework can launch a debug Wework instance from the built-in Terminal of another running Wework window. To keep multiple worktrees and dev apps distinguishable, Wework passes the parent window context into the Terminal, and `wework/scripts/dev-mac-app.sh` forwards it to the debug instance.

## Terminal Environment Variables

When Wework creates a local built-in Terminal PTY, it injects:

- `WEWORK_PARENT_TITLE`: the current runtime task title.
- `WEWORK_PARENT_PROJECT`: the current project name.
- `WEWORK_PARENT_WORKSPACE`: the current workspace path.

Task titles are limited to 60 Unicode characters before they are displayed in the frontend or written to `WEWORK_PARENT_TITLE`. Longer titles end with an ellipsis so oversized content cannot affect debug instance labels or Terminal startup.

These values are written only when the Terminal session is created. Existing Terminal sessions do not update after task switches or frontend hot reloads; close and reopen the Terminal to receive fresh context.

## Dev Script Variables

`wework/scripts/dev-mac-app.sh` reads the parent variables and generates debug instance variables:

- `WEWORK_DEV_TITLE`: the short debug instance label. It uses `WEWORK_PARENT_TITLE` first, then the Git branch, then the worktree directory name.
- `WEWORK_DEV_PORT`: the current Vite/Tauri dev server port.
- `WEWORK_DEV_WORKTREE`: the current worktree root path.
- `WEWORK_DEV_BRANCH`: the current Git branch, or empty when running on a detached HEAD.

The script also exports these values as `VITE_WEWORK_*` so the frontend can display them at runtime.

## Frontend Display

Debug instances show a `Debug Wework` badge in the bottom-right corner. The badge shows the short label; hover or focus expands a details panel where each item can be copied individually.

If the variables are missing, first check that:

- The built-in Terminal was opened after the change.
- The debug app was started from that Terminal with `wework/scripts/dev-mac-app.sh`.
- The Terminal is checking `WEWORK_*` variables, not another prefix.
