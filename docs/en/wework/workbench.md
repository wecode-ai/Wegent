---
sidebar_position: 5
---

# Coding workbench

The right workspace displays project files, previews, and change reviews. Local file links in an AI response open the file and can jump to a referenced line.

Press `Command+J` to open or close the bottom workspace panel. Opening the panel does not create a new terminal automatically. Existing terminals are preserved per task and restored when you return to that task.

Select **+** in the bottom tab bar to choose **Terminal**, **IDE**, or **Desktop**, depending on the active device's capabilities. Terminal starts in the active project or the task's Git worktree. IDE opens in the system default browser. When available, Desktop opens in Wework's built-in browser.

## Navigate long conversations

When a conversation is taller than the current viewport, turn markers appear along the left side of the message area. The navigation stays centered in the conversation viewport instead of scrolling with message content. Select a marker to jump to that turn, or hover over it to preview the user request and assistant response summary.

## Switch conversations and restore position

The desktop workbench caches recently used conversation panes. Runtime state, recent messages, right-workspace tabs, and panel state remain intact while switching, so returning to a conversation restores the workspace as it was left. Up to 10 ordinary conversation panes are cached and older panes are evicted by recent use.

Conversations with a running Terminal or Wework built-in browser are not evicted by the ordinary cache limit. Terminal processes, tabs, and output buffers remain live, while built-in browser pages, addresses, and tab state are preserved. After those resources are closed, the conversation follows the ordinary cache policy again. Hidden conversations do not handle shortcuts or browser-open events intended for the active conversation.

A conversation opens at its latest message the first time. Conversations that were at the bottom remain at the bottom, while conversations viewed in the middle restore their distance from the bottom. Long conversations mount only messages near the viewport and reuse measured message heights to limit WebView memory growth while scrolling.

Message, scroll-position, virtual-measurement, and conversation-pane caches are bounded. Archiving a task evicts its cached state immediately. If an older entry has already been evicted, Wework reloads the complete transcript from the local runtime when it is opened again.

## Use selected response text

Select text in an assistant response to add it to the current conversation composer or ask a follow-up question in the sidebar. These actions remain available while the response is streaming; later content updates do not dismiss an action menu that is already open.

## Review and undo changes

Supported Git tasks show a per-turn change card with file and line counts. Select **Review** to inspect the full diff, filter files, change wrapping, or copy a `git apply` command. The original execution device must be online.

Select **Undo** to reverse only that turn. Wework checks the reverse patch first and will not overwrite conflicting later changes.

Before pushing, review every changed file, run relevant tests, check for temporary or sensitive files, and confirm the commit and target branch. Preserve uncommitted changes before archiving a worktree task.
