---
sidebar_position: 18
---

# Collaboration experience preview

The independent **Collaboration exp** tab brings together Assistant, tasks, projects, task timelines and private discussions. Existing Collaboration and My Stand-in entries remain available.

## Enable or roll back

1. Open **bottom-left account menu → Settings → Personal → General**. Enable **Experimental features**, then **Collaboration experience preview**. Each switch saves immediately on this device.
2. Under **Fixed tabs → Add fixed tab**, select **Collaboration exp**, or choose **+ → Collaboration exp** in the top tab strip. Fixed tabs return at startup and can be selected as the startup tab.
3. To roll back, disable **Collaboration experience preview**. The tab and add options disappear and the experiment unmounts. Enabling it again restores the saved tab, project and task location.

The preview corresponds to `collab.experience.v1` and defaults to off. Experimental features alone does not enable it. Once enabled, its switch stays available for rollback even after Experimental features is disabled. Disabling the preview retains projects, tasks, private conversations and tab records. The existing Collaboration page can still read the same data.

## Assistant and assistant team

1. Select **Assistant** on the left of Collaboration exp to open **My assistants**. Enter a question or goal at the bottom, use **Automatic delegation** or choose a configured specialist, then send. Model selection remains available in the compact input menu, including during loading or a failure. The first message enters the current account's selected assistant's private conversation. Ordinary questions do not automatically create project tasks. Empty input does not create a conversation.
2. Unsent home input is saved for the current account, assistant identity and execution device. Return to that identity after switching to Tasks, changing tabs, refreshing or restarting to continue editing. Conversation input has its own draft and never populates another discussion.
3. **Needs your decision** shows pending questions and configuration proposals. Select a task to open its timeline and continue the question through its related private discussion. Select **Review the proposed changes**, inspect the changes, then choose **Confirm and apply** or **Dismiss**. Stale proposals need to be regenerated. Changes take effect after application.
4. Select **Recent discussions** in the header to expand existing private discussions, or resume work from **Recent progress** on the home page. A discussion bound to a project task opens the same project, task and private conversation with its saved draft. An independent assistant discussion opens in the assistant conversation pane. Use **Retry** when the source or current account's access cannot be confirmed.

**Team relay** shows each assistant as **Awaiting confirmation**, **In progress** or **Standing by**, using existing work and pending proposals. Until its sources are ready, it shows **Status not confirmed** and snapshot counts use “—”; missing data does not mean standing by or zero work. Failed reads offer Retry. In a wide pane, **Current work** summarizes assistant work awaiting a decision, in progress and completed. Select current work to continue its existing conversation or execution. Phones and narrow panes hide the detailed snapshot and prioritize the compact team, first decision and bottom input area.

Select **Manage assistants** in the header, or the team rail's management button or a member, to expand the roles. **Configure**, or a role's configure button, opens the existing My Stand-in configuration page; save identity, model and project-scope changes there. The default assistant stays available and cannot be deleted or paused. A specialist's delete button opens **Delete specialist assistant?**; select **Delete role** to save, or cancel to retain the configuration. Existing discussions and execution history remain after deletion. The default assistant continues within its configured project scope.

## Tasks, projects and timelines

Switch between **Assistant** and **Tasks** on the left. Selecting the current navigation entry returns to its home while retaining task filters and project scope. The list toolbar switches between **Tasks** and **By project**. Select the search icon to expand search, relevance, status and project filters. **Related to me** is the default scope; **All visible** broadens it. Status grouping remains separate from relevance, and clearing one filter retains the others. Tasks keep their original project data and permissions.

The toolbar **+** and home **Create task** open the task form. The default **No project yet** creates an independent task on this device. Alternatively, choose an existing local or cloud project to save the task in that project. Enter the delivery goal, adjust the assignee, due date and summary as needed, then select **Create and open task**. The assignee defaults to you and the due date defaults to tomorrow.

With no task selected in a wide window, the right home pane shows **Your turn**, **In progress** and **Finished** counts and current work for the visible list. Existing filters update these counts, which exclude inaccessible or unloaded tasks. Select current work or **The next decision for you** to open its task timeline while retaining filters and project scope. The compact **Team relay** below uses the same state rules as Assistant and does not change with task filters. Selecting a member opens its existing configuration without creating a discussion or task. On phones, the unselected view keeps the task list; selecting a task opens the next layer.

Select a task to inspect its timeline. Select its project, or choose **By project** in the list toolbar and select a project, to open the overview, plan or configuration. **By project → + Create project**, or **Create project** on the project home, opens the project form; choose an available local or cloud source and save to enter the new project. The project list and home summarize visible tasks and highlight projects awaiting a decision; summaries use real task states rather than inferred risk or goal completion. The tab address retains project scope, list mode, filters, task and view across tab switches, refresh and restart. Moving between list, project and task panes preserves the mounted panes' scroll positions. Project edits follow existing permissions and the corresponding form's save action.

The timeline shows original comments, executions, status changes and handoffs. A selected node's details and accessible private discussions keep the same task and node identity. Missing or inaccessible sources do not imply a new conversation. Wide windows support adjacent list, timeline and discussion panes with resizable separators. Narrow screens use successive views and Back controls.

The timeline header's paperclip toggles the **Files** filter, and its folder button opens the task's project. Select **… (Task details)** at the top right to open a task summary with its actual description, visibility, status and any explicit acceptance section in the description. The project button opens the associated project; **Associated project and more settings** opens the existing task editor. Edits use the existing permissions and field-save behavior. Select the description to edit it, then **Save** or **Cancel**. Close the summary or press Escape to return focus to its trigger. Close the editor, or use Back on a narrow screen, to return to the same task timeline.

When the system requests reduced motion, team entrance, pulse and activity-trail animations stop. Status text, icons and accessible names remain available; state changes do not rely on animation.

## Private discussion

Select **Private discussion** in a task timeline to open the current user's existing conversation. A node's entry shows its verified source turn in read-only mode, without an input or publication form. An unverified source displays an unavailable message. Select **Continue the current discussion** to return to the same conversation and its unsent draft without creating a conversation or task. Ordinary private discussion does not automatically publish content or change the shared task's status. Send, queue and stop use the existing conversation capabilities. While a shared execution is active, queue a private message or interrupt to start private discussion; it cannot directly guide that shared turn. Failed sends retain the draft. Unsent input is saved per conversation and restored after refresh or restart.

To share a conclusion, select **Review suggested conclusion** above the current discussion input to switch to **Confirm the conclusion to submit** within the same pane. Manually enter or edit **The following text will be visible to project members**, check the task title, then select **Confirm and submit conclusion**. Private history and files never automatically populate this text. Only the body you explicitly confirm is published to the current task. Select **Continue discussion** to return to the same conversation with both drafts retained. An empty conversation also provides this preview entry for manual editing.

The result appears in the original task timeline and remains readable in the existing Collaboration page. Private history, unsent input and attachments stay private. Publication rechecks current permissions and archive state. Permission changes, archiving or publication failures retain the preview and conclusion draft for a manual retry after recovery. Success returns to discussion; if the comment was accepted but the timeline refresh fails, the preview retains the error and the accepted body is not sent again. Returning to discussion or switching tasks cancels an outstanding publication permission check. Closing the pane never publishes its draft to another task.

## Notifications, deep links and retry

When the preview is enabled and its tab is already open, project task notifications and `wework://boards/...` links reuse that tab, update the target project and task, and retain list filters. With the preview disabled or no experiment tab open, they continue to the existing Collaboration page. The original Collaboration entry always opens the original page.

Experiment links use `wework://collaboration-exp?...`; the internal route is `/collaboration-exp`. Links retain project source, project, task, node and discussion parameters. Cloud projects still require sign-in and existing access permissions. A link grants no authorization.

If the module fails to load or render, only that tab shows its error state. Select **Retry** to reload it; other task and Collaboration tabs remain usable. For persistent problems, disable the preview and use **Report a problem** at the top right with the reproduction steps.
