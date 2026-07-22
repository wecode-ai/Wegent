---
sidebar_position: 5
---

# Coding workbench

The right workspace displays project files, previews, and change reviews. Local file links in an AI response open the file and can jump to a referenced line.

Press `Command+J` to open or close the bottom workspace panel. Opening the panel does not create a new terminal automatically. Existing terminals are preserved per task and restored when you return to that task.

Select **+** in the bottom tab bar to choose **Terminal**, **IDE**, or **Desktop**, depending on the active device's capabilities. Terminal starts in the active project or the task's Git worktree. IDE opens in the system default browser. When available, Desktop opens in Wework's built-in browser.

## Use selected response text

Select text in an assistant response to add it to the current conversation composer or ask a follow-up question in the sidebar. These actions remain available while the response is streaming; later content updates do not dismiss an action menu that is already open.

## Review and undo changes

Supported Git tasks show a per-turn change card with file and line counts. Select **Review** to inspect the full diff, filter files, change wrapping, or copy a `git apply` command. The original execution device must be online.

Select **Undo** to reverse only that turn. Wework checks the reverse patch first and will not overwrite conflicting later changes.

Before pushing, review every changed file, run relevant tests, check for temporary or sensitive files, and confirm the commit and target branch. Preserve uncommitted changes before archiving a worktree task.
