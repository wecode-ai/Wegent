---
sidebar_position: 12
---

# Personal stand-in and scenario roles

When opening your stand-in, the page checks onboarding status and shows an inline loading message. Initial setup opens automatically only after the check confirms it is incomplete. Completed setup opens the stand-in directly. If the check fails, use the retry action in the error prompt.

Open **My stand-in**, marked **Beta**, in the Tasks sidebar to delegate work, ask follow-up questions, or draft a scenario role with AI. The header displays the primary identity and existing roles for switching. The primary identity conversation and individual work executions are stored separately. Returning from a role restores the primary conversation.

A **scenario role** continuously handles a particular information flow. Its default page is a work list. Select work for a preview, open the shared **Needs your input** tab for human decisions, or open the full conversation for context. Each role also has its own persistent identity conversation.

Click **Board** in the Tasks sidebar, or select **Board** from its task view menu, while viewing **My stand-in** to open your personal task board.

The **My stand-in** button in collaboration project headers also carries a **Beta** badge. Both entries are available without enabling experimental features.

## Manual and conversational configuration

Edit responsibilities and shared preferences in the primary profile, and role responsibilities and sources in the role profile. Preferences can be edited or deleted. Changes take effect only after saving.

You can also describe a role or configuration change in conversation. After AI creates a proposal, open **Pending settings** in the header to review the affected roles, source scopes, and handling policies. Explicitly confirm before applying. Closing the dialog only collapses the proposal; it neither accepts nor rejects it. Continue discussing to revise it, or dismiss it. A stale proposal cannot overwrite newer settings.

The main conversation keeps the transcript and composer in focus. **Work list** shows the number of items needing attention and opens their details. Connection problems and nonblocking background failures appear under **Needs attention**, with their original review and retry actions. Proactive background updates have their own marker rather than appearing as messages sent by you.

## Model selection

Stand-in profiles support cloud models and custom models configured on the execution device. Cloud models use that device's connected Wework cloud account; local custom models use its provider configuration and authentication. The primary conversation and the concrete work it creates both use the saved model selection. After switching execution devices, confirm that the selected device has the required model configuration and access.

## DingTalk and collaboration sources

Connections groups sources under **Configured** and **Available**. Each source appears once with its receive scope, status, and next action; other sources remain visible. A configured scope does not mean intake is active: projects retain their scope summary when **Receiving is off**. Calendar has a separate **Scheduled work** section.

Search by app name or configured scope name at the top, or select the configured count to show existing sources only. Select **All sources** to restore the full catalog. The count is per source, and filtering does not change the stand-in's configuration.

Open a source to install its plugin or sign in, then choose the receive scope and handling. Sources on remote execution devices require authorization on that device. Existing scopes remain visible and removable when a source is unavailable. Scope and handling changes take effect after saving stand-in settings; verifying a mailbox account also requires saving those settings before receiving new mail.

Select DingTalk in the profile's connection sources. By default, intake includes mentions from all groups and direct messages from all contacts accessible to the selected account, including future groups and contacts. Switch to filtered sources to search and select individual sources in a batch. Each source remains bound to the DingTalk account used when selecting it. Complete any required plugin installation or authentication before choosing sources.

You can manually mention yourself in a connected group to delegate work. Stand-in replies always retain DingTalk's AI-send marker. Intake uses the provider marker to exclude your own AI messages and prevent reply loops.

Choose manual delegation, approval before operations, or automatic handling independently for each source. New DingTalk sources default to approval before operations. The selected execution device uses its installed DingTalk plugin and account. Complete any requested authentication through the existing connector flow.

Collaboration, Calendar, and DingTalk share the **Process directly** option under **Processing**. When enabled, incoming matters create a conversation for processing. Otherwise, the background stand-in decides how to handle them. New role connections enable direct processing by default. Operations retain the connection's approval policy.

Collaboration sources retain project membership permissions. Project-scoped agents cannot broaden intake to other projects or DingTalk sources. When roles overlap, AI selects one handler to avoid duplicate execution.

Connected collaboration projects display their names, including accessible projects whose parent workspace you have not joined. Names remain visible and existing connections can be removed when switching the stand-in execution device. New local project connections can only be added when executing on the current device.

Remote execution devices can still use the all-project scope. It uses the selected Executor's own project catalog; unconnected local projects on the editing computer are not shown as remote connections.

## Work associations and approvals

Follow-up messages concerning the same concrete matter can join existing work. Uncertain associations wait for review. Expand related messages in the preview to split a message into separate work or move it to another item within the same role. Moving a completed message does not execute it again.

Operation approvals appear in **Needs your input** and link to the original conversation's approval card. Use its approval or rejection action; no typed “yes” is required. DingTalk reply approvals show the outgoing text bound to the original tool call. Approval-before-operations uses runtime enforcement for file writes, commands requiring elevated permissions, and MCP tools with write annotations. Approval applies to the individual operation, without persistent allow rules. This policy currently requires the Codex runtime.

## Shared human decisions

Structured questions from stand-ins and ordinary tasks share one pending request. While the app is in the foreground, a compact reminder appears in the upper right; expand it to answer simple questions. The title-bar bell's **Needs your input** entry opens the shared tab to view and handle the original task or Issue in its own interface. Work lists and notification entries no longer contain independent reply forms.

The detail header shows the selected notification’s original question and entity name, keeping the question readable when narrow windows hide the list. Needs your input hosts the original entity: tasks navigate to the selected question's original conversation turn and show its native input card. Issues use the native execution and message IDs to focus the AI message that raised the question and its context, rather than the thread's initial comment. Opening a notification preserves the reading position; clicking Reply focuses the composer. Context, questions, forms, approvals, and authorization use the original interface and handlers. The inbox does not extract or summarize conversation content or create another reply form.

The container header's **Open in original view** action opens the owning task or Issue and preserves the source comment target. Files, reviews, plans, and execution details that require the full workspace open in the original task. Child Issues open their own detail page rather than adding workspace sidebars inside the inbox.

Opening an original task restores its title, model, and workspace so you can continue the conversation, even when the task is absent from the sidebar. Opening it preserves the sidebar's existing visibility rules.

Background delivery follows the notification channel settings. Eligible simple asynchronous questions support text replies through system notifications. Manage channels in the title-bar bell's settings; the account area no longer has a separate global IM notification menu. System delivery also depends on operating-system permissions and notification settings.

Reading a notification, dismissing a reminder, or marking it read does not resolve a request. Accepted replies or an already resolved original question move it into history; failed sends retain the draft. Offline devices retain last-known questions and drafts, with replies enabled only after reconnecting and revalidating. Execution approvals, connector login, and complex forms remain in their original context; ordinary business answers never grant operation permissions. Issue answers persist in the owning comment thread before continuing its execution.

Disable **Receive new work** and save to pause new intake while retaining existing work. Source and startup failures remain visible for retry after fixing authentication, model selection, or connection settings. Message cursors, deduplication records, and associations persist across executor restarts.

## Issue assignment reception receipts

Collaboration notifications read Stand-in history from the local Executor and online execution devices that support remote queries. A lookup failure identifies the device and reason; it means history could not be loaded, rather than an Issue execution failure. For incompatible versions, update that device's Executor and refresh notifications. Other desktop App devices are excluded from remote queries; local history still uses the native Executor.

Inside the assignee dropdown control, an outlined person with a check marks **Read by recipient** and a filled person with a check marks **Received by stand-in**. Hover to view the status and timestamp. A successful detail open records the human receipt; a stand-in records reception once its task is accepted, before execution completes. Both receipts retain their own timestamps and do not complete the Issue. Notification previews, marking all notifications as read, and background reads do not record a human receipt.

Assigners and recipients can view the receipts, which refresh while details remain open. The latest active assignment in the activity timeline shows the same receipts and updates together with the assignee control, without polling historical entries separately. Reassignment moves the displayed receipts to the latest assignment activity; unassignment removes the former recipient's receipts. Reassignment starts a new receipt history. Older assignments without reliable evidence show “No receipt recorded.” Executors retain pending cloud receipts for up to 30 days, increasing failed retry intervals to at most one hour. Restarting preserves the retry delay. Local-project receipts stay on the owning Executor.

Stand-ins save the recipient-owned device task binding and reception receipt before starting execution. Background handling records reception when the assignment enters its pending queue. Reception does not imply successful execution, and a later launch failure does not revoke it. Cloud acknowledgements still validate the active assignment, owned device and task binding; rejection diagnostics do not relax these checks.

## Calendar arrangements and project leaders

Record a matter and its trigger time in **Settings → Connections → Calendar**, with one-time or recurring triggers. At that time, the owning stand-in receives the matter using its current responsibilities, device, model, and working directory. Processing is configured for the whole Calendar connection. Calendar entries save independently and protect unsaved edits when returning or closing. Open the corresponding work from its execution history.

**Scheduled** in the Tasks sidebar remains independent and retains its goal, target task, model, and execution environment settings without requiring experimental features. Scheduled tasks and Calendar connections manage separate lists, editors, and run histories. The stand-in work list contains concrete work.

The project conversation uses the existing collaboration group leader. Its header identifies the group and leader, and settings use the existing group configuration. Automatic project event handling enables that leader on the selected device. Each project/group has exactly one active member/device binding, with explicit takeover required for switching. Private chat and memory remain private until selected content is explicitly published to an Issue.

## Connect GitHub and GitLab

Roles can receive personal events or all subscribable repository events. The plugin provides capabilities; role instructions determine behavior. Cloud buffers repository Webhooks while the execution device is offline. External writes retain per-operation native approval. See [GitHub and GitLab connections](git-connections.md).

## Set up your stand-in

On first use, connect the apps you use, then confirm Get started. The connection step reuses the project, DingTalk, email, and other connections from stand-in settings, including their authorization and scope controls. Connecting an app is optional: Continue is available with no apps selected.

Review the selected connections before choosing Get started. This saves the connections and enables the primary stand-in. Without connections, you can still chat; there are simply no app updates to analyze yet. Add connections later in settings. Closing the introduction does not save connection drafts, and unsaved changes require a discard confirmation. Account authorization still uses the existing sign-in flow.

Setup creates no scheduled work. The question-mark entry keeps examples for daily briefings, meeting preparation, project follow-up, DingTalk replies, and weekly reviews. Choosing an example only inserts an editable conversation draft; confirm sources and schedules after sending it.

Request weekly reviews in chat or use the template under **Stand-in settings → Connections → Calendar**. The default is Monday at 09:00 Asia/Shanghai, reviewing the preceding seven days of work and conversations on this device. Edit, pause, or delete it at any time. Deleted arrangements are not restored automatically.
