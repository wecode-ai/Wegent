---
sidebar_position: 5
---

# Coding workbench

## Use top-level tabs

The Wework desktop app uses top-level tabs for tasks, project spaces, agents, and other product pages. Sidebar links navigate within the active tab. A new tab is created only when you select the top-bar **+** or another explicit new-tab action from a tab menu.

The first main window starts with three default tabs: Task, Project spaces, and Agent. Every tab is an independent work instance. Two Task tabs retain separate conversations and unsent drafts, two Project-space tabs retain separate projects and routes, and two Agent tabs retain separate page state. Switching tabs does not synchronize content from another tab.

When many tabs are open, the tab list scrolls horizontally while the **+** and the rightmost feedback button remain visible. A tab can also be moved to a separate window from its context menu. After the move succeeds, the source window removes the tab and the destination window contains only the moved tab and its state; it does not create the three default tabs again. If destination-window creation fails, the source tab remains unchanged.

## Start a new task

The new-task page uses compact suggestion buttons to help choose a task direction. Selecting a direction reveals more specific prompts. Selecting a prompt writes it into the composer, where it can still be edited before sending.

Project selection, message input, quick phrases, and model selection share one composer surface. The composer shows a blue border while focused, and the simplified launcher preserves project, attachment, quick-phrase, and model controls.

## Files and terminals

The right workspace displays project files, previews, and change reviews. Multi-root projects show a folder selector in the Files tab. Switching folders changes only the file-tree and preview root; it does not change the execution directory used by the task, terminal, or conversation.

Local file and directory links in an AI response open in the Files tab. File links can jump to referenced lines, while directory links make that directory the file-tree root. In the macOS desktop app, the Files tab's **Open** and **Open location** actions support both files and directories.

Press `Command+J` to open or close the bottom workspace panel. Opening the panel does not create a new terminal automatically. Existing terminals are preserved per task and restored when you return to that task.

Select **+** in the bottom tab bar to choose **Terminal**, **IDE**, or **Desktop**, depending on the active device's capabilities. Terminal starts in the active project or the task's Git worktree. IDE opens in the system default browser. When available, Desktop opens in Wework's built-in browser.

## Expand the right workspace

With the right workspace open, select **Expand panel** in its title bar to let files, previews, or change reviews fill the main workspace. The task composer is hidden while a non-chat workspace is expanded; an expanded temporary chat keeps only its own composer. The expanded state is saved per conversation.

You can still collapse the left sidebar while the workspace is expanded, leaving only the right workspace visible. Select **Restore panel** in the upper-right corner, or **Latest turn** at the bottom when a conversation is available, to return to the side-by-side conversation and workspace layout. Closing the right workspace or its last tab also exits the expanded state.

## Navigate long conversations

When a conversation is taller than the current viewport, turn markers appear along the left side of the message area. The navigation stays centered in the conversation viewport instead of scrolling with message content. Select a marker to jump to that turn, or hover over it to preview the user request and assistant response summary.

## Switch conversations and restore position

When switching conversations, the desktop workbench saves runtime state, recent messages, right-workspace tabs, and panel state, so returning restores the workspace as it was left. Ordinary conversations do not retain a hidden full-page DOM, which bounds WebView memory growth from long conversations.

Conversation panes with a running Terminal or Wework built-in browser remain mounted. Terminal processes, tabs, and output buffers stay live, while built-in browser pages, addresses, and tab state are preserved. After those resources close, the pane can be released while its restorable panel state remains. Hidden conversations do not handle shortcuts or browser-open events intended for the active conversation.

A conversation opens at its latest message the first time. Conversations that were at the bottom remain at the bottom, while conversations viewed in the middle restore their distance from the bottom. Long conversations mount only messages near the viewport and reuse measured message heights to limit WebView memory growth while scrolling.

Message, scroll-position, and measured-height caches are bounded. Archiving a task evicts its cached state immediately. If an older entry has already been evicted, Wework reloads the complete transcript from the local runtime when it is opened again.

## Use selected response text

Select text in an assistant response to add it to the current conversation composer or ask a follow-up question in the sidebar. These actions remain available while the response is streaming; later content updates do not dismiss an action menu that is already open.

## Review and undo changes

Supported Git tasks show a per-turn change card with file and line counts. Select **Review** to inspect the full diff, filter files, change wrapping, or copy a `git apply` command. The original execution device must be online.

Select **Undo** to reverse only that turn. Wework checks the reverse patch first and will not overwrite conflicting later changes.

Before pushing, review every changed file, run relevant tests, check for temporary or sensitive files, and confirm the commit and target branch. Preserve uncommitted changes before archiving a worktree task.
