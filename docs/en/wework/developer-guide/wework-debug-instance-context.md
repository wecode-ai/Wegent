---
sidebar_position: 35
---

# Debug Instance Labels

Wework can launch a debug Wework instance from the built-in Terminal of another running Wework window. To keep multiple worktrees and dev apps distinguishable, Wework passes the parent window context into the Terminal, and `wework/scripts/dev-mac-app.sh` forwards it to the debug instance.

The built-in Terminal can also inherit `ELECTRON_RUN_AS_NODE`,
`WEWORK_NODE_PATH`, and `WEWORK_NODE_RUNTIME_KIND` from the release app's Node
launcher. Before starting the debug Electron process, `dev-mac-app.sh` clears
those variables so the source checkout prepares its own Node launcher and
Electron starts in desktop application mode. The script also generates
development component resources such as
`wework/electron/resources/components.json` and explicitly passes that resource
root to the debug Electron process.

## Terminal Environment Variables

When Wework creates a local built-in Terminal PTY, it injects:

- `WEWORK_PARENT_TITLE`: the current runtime task title.
- `WEWORK_PARENT_PROJECT`: the current project name.
- `WEWORK_PARENT_WORKSPACE`: the current workspace path.

Task titles are limited to 60 Unicode characters before they are displayed in the frontend or written to `WEWORK_PARENT_TITLE`. Longer titles end with an ellipsis so oversized content cannot affect debug instance labels or Terminal startup.

These values are written only when the Terminal session is created. Existing Terminal sessions do not update after task switches or frontend hot reloads; close and reopen the Terminal to receive fresh context.

## Dev Script Variables

`wework/scripts/dev-mac-app.sh` reads the parent variables and generates debug instance variables:

- `WEWORK_DEV_TITLE`: the short debug instance label. Task runtimes automatically use a truncated task title; ordinary local terminals use the project and Git branch; a detached HEAD without task context uses the worktree directory name.
- `WEWORK_DEV_PORT`: the current Vite/ Electron dev server port.
- `WEWORK_DEV_WORKTREE`: the current worktree root path.
- `WEWORK_DEV_BRANCH`: the current Git branch, or empty when running on a detached HEAD.
- `WEWORK_DEV_INSTANCE_LABEL`: the instance number extracted from the `runtime-<id>` worktree directory; regular checkouts use a stable hash.
- `WEWORK_DEV_DOCK_TITLE`: the macOS Dock instance name, built from the automatically resolved short title and the first four instance characters.
- `WEWORK_DEV_EXECUTABLE_NAME`: a filesystem-safe Dock title used as the macOS executable name; path separators are replaced.
- `WEWORK_APP_IDENTIFIER`: the generated Electron application identity. It is derived from the current worktree path and isolates the single-instance lock, application data, and macOS menu bar icon position. The launcher intentionally ignores an identity inherited from its parent App; use `WEWORK_DEV_APP_IDENTIFIER` only when an identity must explicitly be reused.
- `WEWORK_USER_DATA_DIR`: the generated Electron user data directory. The launcher intentionally ignores a directory inherited from its parent App; use `WEWORK_DEV_USER_DATA_DIR` for an explicit override.

The macOS development launcher prepares a copy-on-write Electron App Bundle for
each display name. Task shells use their injected title directly; terminals
started from an existing runtime worktree can recover the title from the local
runtime index. The launcher then updates the Bundle metadata and renames the
main executable to `WEWORK_DEV_EXECUTABLE_NAME`, the filesystem-safe Dock title. The Dock hover label
therefore shows a value such as `Fix subscriptions · 5275`, while the icon badge
shows `5275`. The renamed development Bundle remains in source hot-reload mode
instead of switching to packaged resources.

The macOS tray derives a stable UUID v5 from `WEWORK_APP_IDENTIFIER` and passes
it to Electron as the `Tray` GUID. Electron writes that GUID to the native
`NSStatusItem.autosaveName`, allowing menu bar managers such as iBar to
recognize the same item after an application relaunch. A regression test locks
the release UUID, while distinct `WEWORK_APP_IDENTIFIER` values isolate debug
instances from the release app and other worktrees. Do not change the UUID
namespace or replace it with a random GUID because doing so resets users' menu
bar visibility rules again.

The script also exports these values as `VITE_WEWORK_*` so the frontend can display them at runtime.

## Frontend Display

Debug instances show a `Debug Wework` badge in the bottom-right corner. The badge shows the short label; hover or focus expands a details panel where each item can be copied individually.

If the variables are missing, first check that:

- The built-in Terminal was opened after the change.
- The debug app was started from that Terminal with `wework/scripts/dev-mac-app.sh`.
- The Terminal is checking `WEWORK_*` variables, not another prefix.
