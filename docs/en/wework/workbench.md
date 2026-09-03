---
sidebar_position: 5
---

# Coding workbench

## Use top-level tabs

The Wework desktop app uses top-level tabs for tasks, project spaces, agents, and other product pages. Sidebar links navigate within the active tab. A new tab is created only when you select the top-bar **+** or another explicit new-tab action from a tab menu.

When experimental features are enabled, the first main window shows three default tabs: Task, Workspaces, and Agent. When experimental features are off, the Workspaces tab is hidden. Every tab is an independent work instance. Two Task tabs retain separate conversations and unsent drafts, two Workspace tabs retain separate projects and routes, and two Agent tabs retain separate page state. Switching tabs does not synchronize content from another tab.

Task and Workspace tabs retain their mounted interface while they are in the background instead of recreating it whenever the user returns. Unsent drafts, the selected project, board routes, and panel state therefore restore immediately, and background tabs do not restart the workbench runtime. The first Task workbench centrally prewarms the Codex app catalog needed by composers; mounting a composer or switching tabs does not request the catalog again. A Workspace board loads task-composer model and skill catalogs on demand only when the user creates a runtime task from an issue, avoiding the complete Task-workbench startup cost during ordinary board browsing.

When many tabs are open, the tab list scrolls horizontally while the **+** and the rightmost feedback button remain visible. A tab can also be moved to a separate window from its context menu. After the move succeeds, the source window removes the tab and the destination window contains only the moved tab and its state; it does not create the three default tabs again. If destination-window creation fails, the source tab remains unchanged.

The Task page and auxiliary product pages such as Plugins and Cloud Work share the same full-bleed desktop content container below the title bar. Switching pages within a tab therefore keeps the left sidebar's position and chrome stable instead of shifting with the page type. Pages may still render their own internal chrome inside this container.

## Manage issues and tasks in workspaces

The top-level **Workspace** tab is where users browse boards, issues, and their linked tasks. It remains independent from Task tabs, preserving its selected board, route, and interface state.

Selecting the fixed top-level **Workspace** tab from another page opens **My tasks**; selecting it again while it is active preserves the current board. Even when both local and cloud storage contain a system-generated `default-work-items` space, the sidebar presents a single logical **My tasks** entry instead of two identically named destinations.

Selecting **New Issue** in a workspace opens a lightweight composer instead of a task form. Choose the destination board and describe the outcome in natural language; the first non-empty line becomes the title and the remaining text becomes the description. The issue is created directly in the selected status column and opens immediately for follow-up details such as participants and execution steps. The board header and every status column expose the same creation flow.

Without any setup, new tasks select **My tasks** by default. Sending the first message creates a work item, links the runtime task, and keeps its execution status synchronized. Existing runtime tasks are also linked into **My tasks**, so this board is another view of the Task-page inventory rather than an independent task list.

Every runtime task has at least one system-managed **My tasks** issue. A user may additionally link the task to one issue in a local or cloud project space. Task context prefers the user-selected issue and falls back to the system issue when no user link exists. The system issue remains linked and receives runtime status, task-title, and archive-state updates even after the extra project-space link is removed, so unlinking another board never removes the task from **My tasks**. Issues may also exist without a runtime task, which is why an ordinary project-space board is not itself a task inventory.

Lanes follow actual execution state: a task that is explicitly queued but has not started appears in **To start**, and an active task appears in **In progress**. Successful, stopped, cancelled, and failed tasks all enter **To confirm**. A successful run means execution has ended; it does not automatically accept the work as completed. After confirming the result, the user can manually move the card to **Completed**. Confirmation cards show the linked task and the first three lines of the final AI response so users can decide whether more work is needed. Archived runtime tasks are excluded from the completed lane. The completed lane also provides batch archive, with an additional confirmation when a workspace still contains uncommitted changes.

Hover anywhere on a board card to open a task-progress panel. The panel directly reuses the task conversation component, shows the complete currently loaded conversation, and uses the same composer in its collapsed-by-default state. Message loading, live updates, continuation, and attachments therefore behave exactly as they do on the task page. In the normal preview state, the panel remains visible while the pointer stays over either the card or the panel; it closes after you leave both areas, scroll the surrounding board, or press `Esc`. Interacting with the composer pins the panel until you use its top-right close button or press `Esc`.

The work-item control above the composer shows the board name and work-item identifier. Its menu exposes the next step, linked-task count, and participants, and can open details in the unified right workspace. **Open in work-item board** focuses the linked work item while preserving the original Task tab. If a board tab for the same project is already open, Wework reuses it instead of loading a duplicate board; otherwise, it creates a board tab.

Local projects do not each create a separate board. Their tasks share **My tasks** and carry a project field, so project views can filter the same work-item data.

## Create issues from external systems

Maintainers of a cloud workspace can generate a hook address under **Manage > External task intake**. Configure this address in GitHub, GitLab, Sentry, Grafana, an alerting platform, or any system that supports HTTP callbacks. Each accepted external event is deterministically converted into an unassigned issue in the workspace inbox. Existing `task.created` automation rules continue to run after the issue is created.

The hook address contains its own credential. Treat it as a secret and do not store it in a public repository or log. Select **Rotate address** if it is exposed; the old address becomes invalid immediately. Disable the hook when intake must be paused. This capability currently supports cloud workspaces whose tasks are managed by Wework.

Built-in adapters recognize GitHub Issue `opened` and `reopened` events, GitLab Issue `open` and `reopen` events, and unresolved Sentry and Grafana alerts. Closed, resolved, or titleless events do not create issues, but their receipt is recorded. The same external event ID, delivery ID, or request body is processed only once.

Other systems do not need to implement a Wework-specific protocol. They can send JSON, form data, or plain text. Generic JSON must provide at least one of `title`, `subject`, `summary`, `name`, or `message`:

```bash
curl -X POST '<Hook address>' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: incident-2026-08-16-001' \
  -d '{
    "title": "Production payment failures",
    "description": "The error rate crossed its threshold. Investigate and restore service.",
    "url": "https://monitor.example.com/incidents/001"
  }'
```

For plain-text requests, the first line becomes the title and the complete body becomes the description. Request bodies are limited to 1 MiB. The service returns HTTP `202` with a `status` of `created`, `duplicate`, `ignored`, or `failed`; a `created` response also includes the new issue's `loop_item_id`.

## Move between issues and runtime tasks

The issue details' **Execution history** section lists linked Wework runtime tasks. Selecting a record opens the issue context and task conversation side by side in the unified workspace; select **Open full task** only when the complete execution interface is needed. Board and Task tabs retain their own routes and interface state.

Board cards continue to represent issues; Wework does not create separate PR or MR cards. When a linked task has a PR or MR, its task icon in the execution history is replaced by the change-request status icon. The project sidebar on the Task page reuses the same state and interaction. Running tasks are always shown. A stopped task remains visible only while its PR or MR is open; it is hidden after the request is merged or closed, or when no request was created.

Status lookup runs through the Executor on the device that owns the task. A local task uses the locally authenticated `gh` or `glab` CLI and does not require separate REST task authentication for the board. Wework batches branch lookups by repository and stores results in a local cache instead of querying once per task. Visible pages refresh periodically and check again when the app regains focus.

When checks fail, a merge conflict exists, or Merge Queue enters an abnormal state, the status menu provides **Continue with AI repair**. This action continues the original runtime-task conversation with the failure context instead of creating another task. Closed PRs and MRs do not expose the repair action.

## Use the project sidebar

Select a project name to expand or collapse its runtime tasks. Collapsed projects use a closed-folder icon; expanding a project changes the icon to an open folder so its state is easy to recognize.

New tasks appear immediately at the top of their project's task list. Tasks with a saved drag order continue to follow that manual order; after a new task receives its persisted order, it remains stable within the same project ordering.

## Use IM notifications

IM notifications are generally available and do not require **Experimental features**. Use the message-bubble entry in the sidebar account area to configure away-from-computer reminders. After opening a runtime task, select **Continue in private chat** in the title bar to bind that task to an available IM private chat.

The away-reminder panel shows the current delivery conversation. When cloud connectivity is available, **Change conversation** and the primary enable or disable action remain fully visible in the same action row, so either setting can be adjusted directly.

After binding succeeds, Wework's switch confirmation uses the current task title instead of an internal `runtime-xxx` task identifier. Later task replies continue to be delivered to the selected private chat.

## Split tasks by dragging

Drag a task from the sidebar to the top, bottom, left, or right target in the workbench to create a split in that direction. Dropping on the center target replaces the task in the current area. Once the pointer enters the workbench, sidebar sorting and automatic scrolling stop so they cannot take over the split operation. Move the pointer back into the sidebar to resume task reordering.

A split is saved as a conversation group. Tasks in the same group show the same **Split N** badge in the sidebar. Selecting any member restores the complete split group and focuses that task. Selecting a task outside the group switches to a single-task view without replacing a member of the saved split; selecting any member later returns to the group. Multiple split groups can be retained, but a task belongs to only one group at a time. A group dissolves automatically when closing panes leaves only one task.

When a split pane has limited height, an idle composer automatically collapses to a single text line and a smaller send button, hiding attachment, quick-phrase, model, and other feature controls. Selecting or focusing the composer animates it back to the complete input surface; selecting outside collapses it again. The composer remains expanded when attachments, code comments, mode settings, or other pending context must stay visible.

## Start a new task

The new-task page uses compact suggestion buttons to help choose a task direction. Selecting a direction reveals more specific prompts. Selecting a prompt writes it into the composer, where it can still be edited before sending.

Project selection, message input, quick phrases, and model selection share one composer surface. The composer shows a blue border while focused, and the simplified launcher preserves project, attachment, quick-phrase, and model controls.

## Use the Popout Window composer

When no task is running, the Wework Popout Window uses a compact composer with a fixed height. After the message exceeds three lines, the text scrolls inside the editor while attachment, model, and send controls remain visible.

## Files and terminals

The right workspace displays project files, previews, and change reviews. Multi-root projects show a folder selector in the Files tab. Switching folders changes only the file-tree and preview root; it does not change the execution directory used by the task, terminal, or conversation.

Local file and directory links in an AI response open in the Files tab. File links can jump to referenced lines, while directory links make that directory the file-tree root. In the macOS desktop app, the Files tab's **Open** and **Open location** actions support both files and directories.

Press `Command+J` to open or close the bottom workspace panel. Opening the panel does not create a new terminal automatically. Existing terminals are preserved per task and restored when you return to that task.

Select **+** in the bottom tab bar to choose **Terminal**, **IDE**, or **Desktop**, depending on the active device's capabilities. Terminal starts in the active project or the task's Git worktree. IDE opens in the system default browser. When available, Desktop opens in Wework's built-in browser.

When diagnosing a terminal that does not repaint after a task switch, frontend logs record the terminal type, task and session identifiers, activation phase, xterm row and column count, container dimensions, and hidden state. They never record terminal output, commands, or workspace paths.

To diagnose `[Terminal connection failed]`, correlate `Local terminal start`, `Local terminal connection`, ` Electron local terminal attach`, and `Local terminal close` logs by session identifier. The logs include the host process, child process, task, workspace path, connection stage, and close reason so output-listener, exit-listener, native-attach, missing-session, and intentional-close cases can be distinguished. They never include terminal input, output, executed commands, or environment-variable contents.

## Expand the right workspace

With the right workspace open, select **Expand panel** in its title bar to let files, previews, or change reviews fill the main workspace. The task composer is hidden while a non-chat workspace is expanded; an expanded temporary chat keeps only its own composer. The expanded state is saved per conversation.

You can still collapse the left sidebar while the workspace is expanded, leaving only the right workspace visible. Select **Restore panel** in the upper-right corner, or **Latest turn** at the bottom when a conversation is available, to return to the side-by-side conversation and workspace layout. Closing the right workspace or its last tab also exits the expanded state.

## Navigate long conversations

When a conversation is taller than the current viewport, turn markers appear along the left side of the message area. The navigation stays centered in the conversation viewport instead of scrolling with message content. Select a marker to jump to that turn, or hover over it to preview the user request and assistant response summary.

While an assistant response is still growing, navigation keeps the current turn active until the message area finishes its next layout measurement. This prevents bottom-follow scrolling from briefly clearing the marker or switching it to another turn.

## Switch conversations and restore position

When switching conversations, the desktop workbench saves runtime state, recent messages, right-workspace tabs, and panel state, so returning restores the workspace as it was left. The Files tab restores the selected file and its actual directory, including absolute paths opened from assistant messages outside the workspace root. The Review tab restores the selected review scope and loaded diff. Ordinary conversations do not retain a hidden full-page DOM, which bounds WebView memory growth from long conversations.

Conversation panes with a running Terminal or Wework built-in browser remain mounted. Terminal processes, tabs, and output buffers stay live, while built-in browser pages, addresses, and tab state are preserved. After those resources close, the pane can be released while its restorable panel state remains. Hidden conversations do not handle shortcuts or browser-open events intended for the active conversation.

A conversation opens at its latest message the first time. Conversations that were at the bottom remain at the bottom, while conversations viewed in the middle restore their distance from the bottom. Long conversations mount only messages near the viewport and reuse measured message heights to limit WebView memory growth while scrolling.

Message, scroll-position, and measured-height caches are bounded. Archiving a task evicts its cached state immediately. If an older entry has already been evicted, Wework reloads the complete transcript from the local runtime when it is opened again.

## Use selected response text

Select text in an assistant response to add it to the current conversation composer or ask a follow-up question in the sidebar. These actions remain available while the response is streaming; later content updates do not dismiss an action menu that is already open.

Process text shown above tool calls while a task is running is also selectable response content. Selecting it opens the same action menu and can add the text directly to the current task composer.

## Review and undo changes

Supported Git tasks show a per-turn change card with file and line counts. Select **Review** to inspect the full diff, filter files, change wrapping, or copy a `git apply` command. The original execution device must be online.

Select **Undo** to reverse only that turn. Wework checks the reverse patch first and will not overwrite conflicting later changes.

Before pushing, review every changed file, run relevant tests, check for temporary or sensitive files, and confirm the commit and target branch. Preserve uncommitted changes before archiving a worktree task.
