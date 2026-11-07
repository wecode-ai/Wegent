---
sidebar_position: 12
---

# Personal stand-in and scenario roles

<!-- ui-source: src/features/todo/StandInSettingsPage.tsx -->
<!-- ui-source: src/features/todo/StandInOverviewPage.tsx -->

## Individual role-profile operations

1. Open **My Stand-in** from the left sidebar, select the main stand-in or a scenario role, then open its profile/settings.
2. Edit responsibilities and preferences. Expand **More settings (device, model, workspace)** to view the bound device and choose an available model and working directory. To use another device, follow “Instance binding and stopping” below before checking its model and source accounts.
3. Install/authorize source apps, choose scope and handling mode, then save to enable changes. Calendar/scheduled delegation belongs to this role's connection page, not global cloud connection settings.
4. Use the work list for execution items, **Needs your input** for human decisions and **Needs checking** for errors; these are distinct lists.
5. To delete a scenario role, use its settings action and confirm the target. Deleting differs from pausing a source; adjust source reception if you want to keep the role but temporarily stop intake.

When opening your stand-in, the page checks onboarding status and shows an inline loading message. Initial setup opens automatically only after the check confirms it is incomplete. Completed setup opens the stand-in directly. If the check fails, use the retry action in the error prompt.

Initial binding discovery shows a loading state, never a premature account-mismatch error. Within the same app session, returning from tasks or boards preserves the loaded stand-in interface while refreshing configuration in the background. Work-list and configuration-proposal polling pause while the stand-in is hidden. Changing accounts or cloud services does not reuse the previous account's page data; an ownership warning appears only after the actual binding has been read.

Open **My stand-in**, marked **Beta**, in the Tasks sidebar to delegate work, ask follow-up questions, or draft a scenario role with AI. The header displays the primary identity and existing roles for switching. The primary identity conversation and individual work executions are stored separately. Returning from a role restores the primary conversation.

A **scenario role** continuously handles a particular information flow. Its default page is a work list. Select work for a preview, open the shared **Needs your input** tab for human decisions, or open the full conversation for context. Each role also has its own persistent identity conversation.

<a id="instance-binding-and-stopping"></a>

## Instance binding and stopping

Each Wework instance binds one local or cloud stand-in at a time. Scenario roles belong to that stand-in, rather than being separate instance bindings. The page and settings have no direct execution-device switch. Reopening the page, device inventory changes, or changing accounts never replaces an existing binding.

To rebind, select **Stop stand-in** in the header and confirm. This stops intake for the entire stand-in and cancels its primary and role conversations, running work, and queued delegated tasks. Other accounts' stand-ins and ordinary tasks are unaffected. Local and cloud binding choices appear only after stopping completes. Configuration, memories, and history remain; rebinding the original stand-in restores its previous intake switches.

An offline device, failed cancellation, or missing process-stop acknowledgement keeps the instance **Stopping**, with rebinding unavailable. Reconnect and use **Retry stopping**. Reopening the page does not unlock the binding. **Stop stand-in** differs from turning off **Receive new work**, which leaves existing work running.

After stopping, you may migrate instead: choose **Profile to migrate** (the primary identity or a scenario role), choose the target device, select **Migrate and bind**, and confirm. Retain old profiles, memories and conversation history while appending portable responsibilities, model settings, tags and visible memories without overwriting target settings. The imported role stays paused until its device directory, project/source grants and arrangements are configured. Only successful copying changes this instance's binding; copying failures support retry while the source stays stopped. If target startup acknowledgement fails after rebinding, retain the target binding for stopping and recovery without automatically restarting the source. A stopped target permits only these disabled, grant-free imports; migration cannot edit existing settings or restore enablement.

For an unbound instance, a project entry pointing to a specific device establishes that first binding. Such links never replace an existing binding.

Click **Board** in the Tasks sidebar, or select **Board** from its task view menu, while viewing **My stand-in** to open your personal task board.

The **My stand-in** button in collaboration project headers also carries a **Beta** badge. Both entries are available without enabling experimental features.

## Manual and conversational configuration

Edit responsibilities and shared preferences in the primary profile, and role responsibilities and sources in the role profile. Preferences can be edited or deleted. Changes take effect only after saving.

You can also describe a role or configuration change in conversation. After AI creates a proposal, open **Pending settings** in the header to review the affected roles, source scopes, and handling policies. Explicitly confirm before applying. Closing the dialog only collapses the proposal; it neither accepts nor rejects it. Continue discussing to revise it, or dismiss it. A stale proposal cannot overwrite newer settings.

The main conversation keeps the transcript and composer in focus. **Work list** shows the number of items needing attention and opens their details. Connection problems and nonblocking background failures appear under **Needs attention**, with their original review and retry actions. Proactive background updates have their own marker rather than appearing as messages sent by you.

## Inspect, edit and forget stand-in memories

<a id="stand-in-memory-controls"></a>

Open **left sidebar → My Stand-in → Memory** and check the selected execution device.

| Action          | Steps and limits                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Add             | Choose Add, enter content and scope, then Save. Blank content cannot be saved; each item allows at most 1,000 characters                                                       |
| Scope           | Personal, existing roles and connected sources depend on current configuration. Project-specific panels fix the project scope rather than allowing arbitrary cross-scope saves |
| Edit            | Choose Edit on the record, change it and Save; this does not edit a composer draft                                                                                             |
| Cancel or close | Confirm whether to discard unsaved changes; closing does not autosave                                                                                                          |
| Forget          | Choose Forget on the record and confirm; cancel preserves it. Forgetting is not conversation archival or deletion of source messages/projects                                  |
| Recover         | Inspect errors and retry. Restore a disconnected source/role or choose a valid scope; the panel does not silently save an invalid scope as personal memory                     |

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

### Project lead conversation and auto-handling

<a id="project-lead-controls"></a>

Enable **Settings → General → Experimental features**, then use **Talk to lead** in a collaboration project. This conditional entry uses an existing collaboration group's lead; it is not the retired separate Project AI manager page.

| Action                      | Steps and limits                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Group and device            | Open Talk to lead and choose the project's group and device; use Group and leader settings if no group exists                                                             |
| Conversation                | Discuss goals/progress privately with an agent lead; for a human lead, collaborate in the original Issue as prompted                                                      |
| Work list / settings        | Return to specific work with the header action or adjust group settings; executions remain tied to original Issues                                                        |
| Memory                      | Open it from the conversation header; its scope is fixed to the project and does not publish private memories                                                             |
| Publish to project          | Header action → permitted target Issue → enter the instruction/conclusion to share → publish; return to private chat after success                                        |
| Enable leader auto-handling | Enable for a supported agent lead/device; shared project events retain existing permissions and confirmations                                                             |
| Take over / Stop            | Review the old member/device and confirm takeover. Its previous binding stops future dispatch; existing work retains its execution lifecycle. Stop does not delete Issues |
| Check now                   | When handled by you, trigger a check and inspect status or respond in the linked Issue; a completed check does not mean all work is complete                              |

Publication shares only the content you enter, not private chat or memories. If no commentable Issue is available, create/select an accessible Issue in the project. Pending permission checks/submission may disable controls; changing devices cannot bypass permissions.

Record a matter and its trigger time in **My Stand-in → role profile → Connections → Calendar / scheduled delegation**, with one-time or recurring triggers. At that time, the owning stand-in receives the matter using its current responsibilities, device, model, and working directory. Processing is configured for the whole Calendar connection. Calendar entries save independently and protect unsaved edits when returning or closing. Open the corresponding work from its execution history.

**Scheduled** in the Tasks sidebar remains independent and retains its goal, target task, model, and execution environment settings without requiring experimental features. Scheduled tasks and Calendar connections manage separate lists, editors, and run histories. The stand-in work list contains concrete work.

The project conversation uses the existing collaboration group leader. Its header identifies the group and leader, and settings use the existing group configuration. Automatic project event handling enables that leader on the selected device. Each project/group has exactly one active member/device binding, with explicit takeover required for switching. Private chat and memory remain private until selected content is explicitly published to an Issue.

## Connect GitHub and GitLab

Roles can receive personal events or all subscribable repository events. The plugin provides capabilities; role instructions determine behavior. Cloud buffers repository Webhooks while the execution device is offline. External writes retain per-operation native approval. See [GitHub and GitLab connections](git-connections.md).

## Set up your stand-in

On first use, connect the apps you use, then confirm Get started. The connection step reuses the project, DingTalk, email, and other connections from stand-in settings, including their authorization and scope controls. Connecting an app is optional: Continue is available with no apps selected.

Review the selected connections before choosing Get started. This saves the connections and enables the primary stand-in. Without connections, you can still chat; there are simply no app updates to analyze yet. Add connections later in settings. Closing the introduction does not save connection drafts, and unsaved changes require a discard confirmation. Account authorization still uses the existing sign-in flow.

Setup creates no scheduled work. The question-mark entry keeps examples for daily briefings, meeting preparation, project follow-up, DingTalk replies, and weekly reviews. Choosing an example only inserts an editable conversation draft; confirm sources and schedules after sending it.

Request weekly reviews in chat or use the template under **Stand-in settings → Connections → Calendar**. The default is Monday at 09:00 Asia/Shanghai, reviewing the preceding seven days of work and conversations on this device. Edit, pause, or delete it at any time. Deleted arrangements are not restored automatically.
