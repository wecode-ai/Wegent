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

1. Select **Assistant** on the left of Collaboration exp. Enter a question or goal at the bottom, select an available model and send. The first message enters the current account's private assistant conversation. Ordinary questions do not automatically create project tasks. Empty input does not create a conversation.
2. Unsent home input is saved for the current account, assistant identity and execution device. Return to that identity after switching to Tasks, changing tabs, refreshing or restarting to continue editing. Conversation input has its own draft and never populates another discussion.
3. **Needs your decision** shows pending questions and configuration proposals. Select a task to open its timeline and continue the question through its related private discussion. Select **Review the proposed changes**, inspect the changes, then choose **Confirm and apply** or **Dismiss**. Stale proposals need to be regenerated. Changes take effect after application.
4. Resume an existing conversation from **Recent discussions** or **Recent progress**. A discussion bound to a project task opens the same project, task and private conversation with its saved draft. An independent assistant discussion opens in the assistant conversation pane. Use **Retry** when the source or current account's access cannot be confirmed.

Select **Assistant team** at the top right to expand the roles. **Configure**, or a role's configure button, opens the existing My Stand-in configuration page; save identity, model and project-scope changes there. The default assistant stays available and cannot be deleted or paused. A specialist's delete button opens **Delete specialist assistant?**; select **Delete role** to save, or cancel to retain the configuration. Existing discussions and execution history remain after deletion. The default assistant continues within its configured project scope.

## Tasks, projects and timelines

Switch between **Assistant** and **Tasks** on the left. Filter related or all visible tasks by search, status and project. Clear filters to broaden the visible scope. Tasks keep their original project data and permissions.

Select a task to inspect its timeline. Select its project or a project navigation entry to open the overview, plan or settings. The tab address retains project scope, task and view across tab switches, refresh and restart. Project edits follow existing permissions and the corresponding form's save action.

The timeline shows original comments, executions, status changes and handoffs. A selected node's details and accessible private discussions keep the same task and node identity. Missing or inaccessible sources do not imply a new conversation. Wide windows support adjacent list, timeline and discussion panes with resizable separators. Narrow screens use successive views and Back controls.

## Private discussion

Select **Private discussion** in a task timeline to open the current user's existing conversation. A node's entry shows only its verified source turn and discussion continued from that pane. An unverified source displays an unavailable message. Opening or continuing private discussion does not automatically publish private content. Send, queue and stop use the existing conversation capabilities. Unsent input is saved per conversation and restored after refresh or restart.

To share a conclusion, manually enter or edit **Conclusion to share**, check the current task's title, then explicitly confirm with **Publish conclusion**. Only that text is published to the current task. Private history, unsent input and attachments stay private. The result appears in the original task timeline and remains readable in the existing Collaboration page. Publication rechecks current permissions and archive state. Permission changes, archiving or a failure retain the conclusion draft for a manual retry after recovery. Closing the pane or switching tasks never publishes its draft to another task.

## Notifications, deep links and retry

When the preview is enabled and its tab is already open, project task notifications and `wework://boards/...` links reuse that tab, update the target project and task, and retain list filters. With the preview disabled or no experiment tab open, they continue to the existing Collaboration page. The original Collaboration entry always opens the original page.

Experiment links use `wework://collaboration-exp?...`; the internal route is `/collaboration-exp`. Links retain project source, project, task, node and discussion parameters. Cloud projects still require sign-in and existing access permissions. A link grants no authorization.

If the module fails to load or render, only that tab shows its error state. Select **Retry** to reload it; other task and Collaboration tabs remain usable. For persistent problems, disable the preview and use **Report a problem** at the top right with the reproduction steps.
