---
sidebar_position: 12
---

# Personal stand-in and scenario roles

In the Chinese interface, the **My stand-in** entry is labeled **我的助理**.

## Ongoing Issue collaboration

Assigning an Issue or mentioning a member wakes their enabled, project-connected stand-ins that match its tags and allow automatic handling.
You can mention yourself: eligible stand-ins receive the event without a human self-reminder.
The same stand-in reuses its conversation for the same Issue. Reassignment retains history but still requires fresh authorization.
Reassignment, unassignment, deletion of the original mention or pausing automatic intake still allows continuing and retrying the conversation, including synchronizing public replies.
Manually starting a stand-in does not require assigning the Issue to yourself and never changes its assignee. Automatic intake settings select new work without restricting explicit user actions. Current project and Issue access and execution permissions still apply.
Acknowledgment and result appear as separate comments. You can keep writing and sending while subagents work; follow-up wakeups are handled in order.
Reply directly to a stand-in comment without another mention to continue with that role. Private chats, reasoning and tool activity are not published.

Stand-in replies on an Issue show the owning user followed by the role in parentheses, for example “Alex (Assistant)”, so participants can distinguish different users' stand-ins. A user ID appears while the member name is unavailable and updates to the name when member information loads.

<!-- ui-source: src/features/todo/StandInSettingsPage.tsx -->
<!-- ui-source: src/features/todo/StandInOverviewPage.tsx -->

<a id="stand-in-chat-and-desktop-notifications"></a>

## Stand-in chat and desktop notifications

From **Collaboration → My work**, the right-hand **Stand-in** tab lists work by role. Select work to continue its original task conversation inline. The home only lists Issue-related work and exposes **Assistant settings**; general chat remains in **My assistant**. Board connection guidance remains until an enabled identity connects an accessible board. The home keeps the assistant tab and one Issue detail tab; opening another Issue replaces the current detail, while reopening preserves drafts and private chat is not automatically published to Issues.

Keep sending requests when the previous reply ends or a background result starts another reply. Messages are delivered into the original conversation according to the current turn state.

This presentation applies to primary and role conversations on the **My Stand-in** page and the embedded primary conversation on the collaboration home. Each native AI message has its own bubble; acknowledgements before background execution and results afterward are not merged. Internal guidance blocks and execution timers are hidden here. Ordinary task and coding conversations retain their execution presentation.

Only stand-in identity conversations enable native subagent v2 for mailbox waits that wake on new user input. Ordinary tasks retain their default configuration, and explicit single collaboration mode still disables subagents, including when resuming an existing v2 conversation. Native permission, source-scope and approval constraints remain unchanged.

Open **Left sidebar → My Stand-in**, then select the primary identity or a scenario role. AI replies use left-aligned bubbles and your messages appear on the right. While native subagents work in the background, send another message in the same main conversation without cancelling the children or waiting in the ordinary task queue. Failed sends retain their content and attachments. Resolve pending questions and permission requests through their original cards; chat messages never substitute for authorization. Independently tracked tasks are reserved for work that actually needs a separate conversation, workspace or lifecycle, not merely to keep chat available.

The desktop prompt above the composer offers **Notification settings**, **Don't show again**, and **Dismiss for now**. Notification settings opens the OS notification settings on macOS and Windows and the bell's unified Wework settings. Allow OS notifications and check the system channel under **Stand-in alerts**. On Linux, enable notifications manually in your desktop environment. Opening settings does not establish that permission was granted. Temporary dismissal lasts for the app session; permanent dismissal is account-scoped on this device and hides only the prompt, without disabling notifications. You can always use **Top-right bell → Notification settings → Stand-in alerts**.

The number beside **My Stand-in** counts unread AI messages in primary and role conversations, not internal subagents or task completions. Counts above 99 display **99+**. Viewing a foreground conversation acknowledges its messages; hidden or background windows do not. Each new message triggers at most one desktop notification. Clicking opens the corresponding device, account and identity conversation. Accounts do not share counts. Messages remain in the conversation and notification center even when OS delivery is blocked.

<a id="role-execution-device"></a>

## Individual role-profile operations

1. Open **My Stand-in** from the left sidebar, select the primary identity or a scenario role, click **Stand-in details** at the top right, then **Manage stand-in** at the bottom of the popover.
2. Edit responsibilities and preferences. Select **Execution device** directly in the scenario role settings, then expand **More settings (device, model, workspace)** to choose that device's model and working directory. Different roles can use different devices without changing the primary identity's binding.
3. Install/authorize source apps, choose scope and handling mode, then save to enable changes. Calendar/scheduled delegation belongs to this role's connection page, not global cloud connection settings.
4. **Recent activity** mixes work threads and schedules. Work opens as a read-only preview inside the same popover; Back restores the list position. Use **Open conversation in workspace** to reply, approve or use the full workspace. Human questions remain in **Needs your input** and the original work.
5. To delete a scenario role, use its settings action and confirm the target. Deleting differs from pausing a source; adjust source reception if you want to keep the role but temporarily stop intake.

When opening your stand-in, the page checks onboarding status and shows an inline loading message. Initial setup opens automatically only after the check confirms it is incomplete. Completed setup opens the stand-in directly. If the check fails, use the retry action in the error prompt.

Initial binding discovery shows a loading state, never a premature account-mismatch error. Within the same app session, returning from tasks or boards preserves the loaded stand-in interface while refreshing configuration in the background. Work-list and configuration-proposal polling pause while the stand-in is hidden. Changing accounts or cloud services does not reuse the previous account's page data; an ownership warning appears only after the actual binding has been read.

Open **My stand-in**, marked **Beta**, in the Tasks sidebar to delegate work, ask follow-up questions, or draft a scenario role with AI. The header displays the primary identity and existing roles for switching. The primary identity conversation and individual work executions are stored separately. Returning from a role restores the primary conversation.

A **scenario role** continuously handles a particular information flow. Both primary and role identities open their persistent conversation. The **＋ (Create role)** beside the role switcher creates a role. The details popover shows name, status, device and recent activity, without an avatar or outputs section. Recent activity mixes work threads and the current role’s schedules by recency, initially showing four entries; **Show more** adds four at a time. Work opens as a read-only preview with **Open conversation in workspace** at the bottom; schedules and monitors open the existing editor in a centered dialog, retaining the profile behind it and restoring focus on close.

<a id="instance-binding-and-stopping"></a>

Saving a new role enables it. Explicitly adding or enabling a source starts intake for the primary identity or role on Save, without a second intake switch. Renaming or editing duties alone does not resume a paused identity. Stopping the entire stand-in still requires native confirmation; source grants and operation approvals are unchanged.

## Instance binding and stopping

If **My stand-in** encounters incompatible versions, it first shows an error with upgrade guidance without automatically navigating away. Select **View device status** beside the error to open **Cloud work**, inspect device status and versions, and follow the upgrade procedure supported by that device. For local issues, the desktop device section offers **View local version**, which opens About to check for updates even when there are no cloud devices. This action does not install or restart anything automatically. After resolving the issue, return to the stand-in page and select **Reload**. Other loading errors retain reload without this device guidance action.

The primary stand-in retains one local or cloud instance binding. Scenario roles choose their execution device independently. Select **Execution device** in a role profile and save: new tasks use the selected device, while existing tasks, queued work and existing conversations for the same Issue remain on their original device. Changing a role does not rebind the primary identity. The role list follows saved device locations, and historical work opens at its original task address.

Reselect the model and working directory after changing a role's device, and check source accounts and projects on the target. Credentials, existing tasks and conversations are not moved. Offline devices cannot be newly selected. A failed target save preserves the draft. When target activation cannot be confirmed, refresh the target role; the original device is not simultaneously restored as a receiver for new tasks. Role device changes do not require the primary instance's stop-and-rebind flow below.

To rebind the primary identity, select it and open **Stand-in details → Manage stand-in**, then select **Stop stand-in** at the bottom left of settings and confirm. This stops intake and cancels primary and role conversations, running work and queued delegated tasks on the currently bound device. Roles on other devices, other accounts' stand-ins and ordinary tasks are unaffected. Local and cloud binding choices appear only after stopping completes. Configuration, memories and history remain; rebinding the original profile restores its previous intake switches.

An offline device, failed cancellation, or missing process-stop acknowledgement keeps the instance **Stopping**, with rebinding unavailable. Reconnect and use **Retry stopping**. Reopening the page does not unlock the binding. Settings on the currently bound device retain **Stop stand-in** at the bottom left; role settings on other devices do not show this entry. There is no duplicate intake switch.

After stopping, you may migrate instead: choose **Profile to migrate** (the primary identity or a scenario role), choose the target device, select **Migrate and bind**, and confirm. Retain old profiles, memories and conversation history while appending portable responsibilities, model settings, tags and visible memories without overwriting target settings. The imported role stays paused until its device directory, project/source grants and arrangements are configured. Only successful copying changes this instance's binding; copying failures support retry while the source stays stopped. If target startup acknowledgement fails after rebinding, retain the target binding for stopping and recovery without automatically restarting the source. A stopped target permits only these disabled, grant-free imports; migration cannot edit existing settings or restore enablement.

For an unbound instance, a project entry pointing to a specific device establishes that first binding. Such links never replace an existing binding.

If concurrent initialization causes a first-binding version conflict, the page reads the saved authoritative binding without rebinding, restarting the stand-in, or replacing another account's binding.

Click **Board** in the Tasks sidebar, or select **Board** from its task view menu, while viewing **My stand-in** to open your personal task board.

The **My stand-in** button in collaboration project headers also carries a **Beta** badge. Both entries are available without enabling experimental features.

<a id="im-conversations"></a>

## Connect IM conversations

Open **My stand-in** in the sidebar, select the primary identity or a scenario role, then click **Stand-in details** at the top right. Click **DingTalk, Telegram, Discord, or Weibo** directly in the details popover to open that channel’s connection dialog. It names the destination stand-in and execution device and lists only private conversations from that channel. When there are multiple conversations, select one, then choose **Connect to “stand-in name”**. After success, choose **Done** to return to the original popover. Connections take effect immediately without opening Manage stand-in or saving profile settings. Cloud sign-in is required to connect.

If that channel has no registered private conversations, the dialog explains how to send **`/bind`** to your configured bot, then select **Refresh conversations**. This does not install a bot or authorize a platform account. Refresh to retry a failed list request, or use the connect action to retry a failed save. A failed refresh preserves conversations already loaded. An offline execution device has a separate notice; Connected means the routing configuration has been saved.

Private IM conversations default to the existing **Wegent chat mode**, retaining its Agent, model, device and new-conversation commands. Send **`/standin`** (or **`/mode standin`**) to enter **Wework stand-in mode**; send **`/chat`** (or **`/mode chat`**) to return to Wegent. **`/mode`** shows the current mode. Without an explicit identity binding, stand-in mode uses the primary stand-in on your account’s default execution device. If no default is configured, the device is offline, or the selected role has been deleted, IM explains how to check the connection in the details popover. It never chooses another device or role automatically. To rebind a conversation, switch to the destination role, open the same channel in its details popover, select the private conversation, and confirm the connection.

New messages enter the selected stand-in’s existing persistent conversation. Old task mode migrates to stand-in mode. Its task bindings are removed while tasks and their history are preserved; task titlebars no longer offer Continue in private chat. In stand-in mode, quoted task notifications and task-card follow-ups provide context to the current stand-in without changing its binding or model. Task notification subscriptions and notification channels remain separate settings.

<a id="conversational-configuration"></a>

## Manual and conversational configuration

Edit responsibilities and shared preferences in the primary profile, and role responsibilities and sources in the role profile. Preferences can be edited or deleted. Changes take effect only after saving.

You can also describe a role or configuration change in conversation. The confirmation card appears directly in that conversation with the affected roles, source scopes, and handling policies. Choose **Confirm and apply** to save and activate the changes. After success, the conversation shows **Settings applied** and the actual changes; failure retains the card and an error. A group's addition to a role updates that role's connections, not the primary identity's source scope; switch to that role's settings to inspect it. **Stand-in details → Pending settings** opens the same proposal. Closing that dialog neither accepts nor rejects it, and the conversation card remains available. Continue discussing to revise it, or choose **Dismiss**. A stale proposal cannot overwrite newer settings.

The main surface keeps the conversation, composer, identity switcher and adjacent **＋**, with **Stand-in details** at the top right. Connection or processing issues appear as one compact status entry; open **Connection and processing status** for complete records and retry. The question-mark icon at the top right of the details popover opens **Usage examples**; the arrow beside Recent activity opens all activity. Settings show **Memory** directly, without those extra entries. Stopping is separate at the bottom left of the settings panel. Settings, Connections and source details have explicit entry and parent-return controls; clickable **Settings navigation** paths return to Settings or Connections without bypassing unsaved-change confirmation. Proactive background updates retain their own marker.

## Proactive background notifications

All connected sources share the same notification policy: surface important information relevant to you, urgent matters, or evidence-backed possible progress anomalies, even when no user action is required. Explain what happened, why it matters now, its source and timing, distinguishing facts, inference and uncertainty. A possible anomaly need not be confirmed, but must have a concrete signal relative to known expectations. Missing updates, unknown current status of an old problem, or urgent wording alone do not justify a notification. Never resurface resolved or superseded problems as active risks; important new milestones or outcomes can still merit a finding.

Assess related events together and consult recent notifications across batches; notify again only when new evidence changes significance, urgency, the progress assessment or the required response. Routine updates and redeliveries remain quiet; never broaden access or create verification tasks merely to manufacture a notification. Preserve account/source identity and source-provided topic identifiers for correlation; never invent missing identifiers, and use available evidence for semantic assessment. This is a model-driven policy, not an independent guarantee of live state verification. Explicitly requested reports, reminders, scheduled arrangements and authorized work execution retain their existing flows.

## Inspect, edit and forget stand-in memories

<a id="stand-in-memory-controls"></a>

The primary stand-in memory panel also lists unreferenced **Legacy forgetting fingerprints** under **Forgetting rules**, with their time and short identifier. Older versions retained neither fact text nor scope, so these show **Unknown scope** without reconstructing content. They are never supplied to models or shown in project-specific panels. Choose **Delete rule** and confirm to remove only that fingerprint; one old memory may have multiple fingerprints, and other restrictions remain. Fingerprints referenced by current rules cannot be removed separately. Concurrent changes require reloading before deletion.

You do not need to say “remember this” every time. The stand-in can extract lasting information from currently authorized ordinary conversations, such as stable preferences, recurring constraints, long-term goals and reusable decisions. Quotes, hypothetical examples, assistant suggestions and other people's facts must not automatically become facts about you. Source content never grants new permissions.

Conversation review reads visible user and assistant text, not raw tool outputs, execution traces or hidden reasoning. This automatic review covers authorized conversation text only. Information present only in tool output without another verifiable source is not yet fully covered; finishing conversation text does not mean all tool results were consolidated.

Memory search uses response-size-bounded pages. Oversized records are read in chunks rather than skipped or allowed to block later memories. Changes to records or their visibility invalidate continuation and require a fresh search; old and new pages must not be combined as one piece of evidence.

Pausing new-work intake for the stand-in or a role does not revoke saved source grants; those sources remain available for memory. Pause the memory consolidation arrangement to stop consolidation, or remove a source grant to revoke access. Automatic consolidation exposes only source- and run-validated memory reads, saves and progress tools, never Shell or external writes.

Memory consolidation tasks are hidden from the left task sidebar, including running and finished records. Open **My stand-in → Settings → Connections → Calendar → 分身记忆整理** to view run history and open the original task. Hiding these tasks does not affect background consolidation or saved history.

After the primary stand-in is enabled, its execution device provisions a **分身记忆整理** (memory consolidation) arrangement once, checking every six hours by default. Open **My stand-in → Settings → Connections → Calendar → 分身记忆整理** to inspect its schedule and run history, pause, edit or delete it. Background provisioning does not recreate a paused or deleted arrangement. Consolidation uses an independent conversation, leaving the current chat free; the execution device and model must be available. Open the original task from its run history to inspect the result. Consolidation does not automatically start a primary conversation with ordinary tool permissions just to report completion.

Background consolidation preserves evidence and scope, following conversation pages and long-message continuations. Incomplete reads or failed saves must not advance a conversation's completion watermark. After correction or forgetting, consolidation does not reconstruct that memory from the same old evidence. Forgetting does not delete the original conversation. As selected by the user, minimal forgetting rules also retain the compact excluded fact and its scope, not original conversations, files or evidence excerpts. Rules are not active memories: stand-ins read them to avoid relearning the same meaning without excluding new facts about the same topic. Exact fingerprints are enforced by code; semantic comparison across paraphrases is model-mediated and does not guarantee recognition of every equivalent statement. Expand **Forgetting rules** below the memory list to inspect compact facts and scopes. Choose **Delete rule** and confirm to allow future learning; cancel makes no change. Deletion neither restores an active memory immediately nor changes other rules. Failed reads or deletion preserve existing data with a separate reload action. Native semantic behavior across paraphrases still requires verification.

Records with a saved excerpt show **View source evidence**. Expand it to inspect the excerpt, source identifier and whether it is a user statement, assistant statement or source record. An assistant statement is not a user fact. Records without saved evidence do not show this control. Expanding it neither rereads the source nor changes the memory.

Editing a memory's content or scope in the panel clears its old evidence association; background consolidation can attach matching evidence later. Opening a record or saving it without changing its content or scope preserves its evidence.

Open **left sidebar → My Stand-in → Stand-in details → Manage stand-in → Memory** and check the selected execution device.

| Action          | Steps and limits                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Add             | Choose Add, enter content and scope, then Save. Blank content cannot be saved; each item allows at most 1,000 characters                                                       |
| Scope           | Personal, existing roles and connected sources depend on current configuration. Project-specific panels fix the project scope rather than allowing arbitrary cross-scope saves |
| Edit            | Choose Edit on the record, change it and Save; this does not edit a composer draft                                                                                             |
| Cancel or close | Confirm whether to discard unsaved changes; closing does not autosave                                                                                                          |
| Forget          | Choose Forget on the record and confirm; cancel preserves it. Forgetting is not conversation archival or deletion of source messages/projects                                  |
| Recover         | Inspect errors and retry. Restore a disconnected source/role or choose a valid scope; the panel does not silently save an invalid scope as personal memory                     |

## Model selection

Stand-in profiles support cloud models and custom models configured on the execution device. Cloud models use that device's connected Wework cloud account; local custom models use its provider configuration and authentication. Concrete work created by a stand-in uses the saved model selection. After switching execution devices, confirm that the selected device has the required model configuration and access.

Stand-in chats inherit the profile's saved model and reasoning effort by default, with temporary choices available inside each chat. When a later save actually changes the model or effort, existing chats inherit the new settings from the next message; the current turn is not restarted. Profile changes do not alter existing work tasks' working directories or sessions.

To switch models temporarily, use the model selector in the primary or role chat composer. Before the first message, the selection applies directly. Execution devices that support thread-based routing can switch providers in the original session, preserving its identity, history and draft. On older devices, switching providers requires confirmation; the next message starts a new session in that stand-in chat, while earlier messages and the draft remain available. Finish active work before sending across providers. Temporary selections do not change the saved profile or ordinary chats.

Stand-in chats currently require the Codex runtime for operation approvals; the Claude Code runtime is not yet supported. Saved Claude Code models are retained without automatic replacement. To continue chatting, manually select an available Codex model using the chat composer's model selector. Claude Code behavior in ordinary work tasks remains unchanged.

<a id="stand-in-source-session-policy"></a>

## DingTalk and collaboration sources

Connections groups sources under **Configured** and **Available**. Each source appears once with its receive scope, status, and next action; other sources remain visible. A configured scope does not mean intake is active: projects retain their scope summary when **Receiving is off**. Calendar has a separate **Scheduled work** section.

Search by app name or configured scope name at the top, or select the configured count to show existing sources only. Select **All sources** to restore the full catalog. The count is per source, and filtering does not change the stand-in's configuration.

Open a source to install its plugin or sign in, then choose the receive scope and handling. Sources on remote execution devices require authorization on that device. Existing scopes remain visible and removable when a source is unavailable. Scope and handling changes take effect after saving stand-in settings; verifying a mailbox account also requires saving those settings before receiving new mail.

Select DingTalk in the profile's connection sources. By default, intake includes mentions from all groups and direct messages from all contacts accessible to the selected account, including future groups and contacts. Switch to filtered sources to search and select individual sources in a batch. Each source remains bound to the DingTalk account used when selecting it. Complete any required plugin installation or authentication before choosing sources.

<a id="dingtalk-group-message-scope"></a>

Open **Sidebar → My stand-in → select primary or role → Stand-in details → Manage stand-in → Connections → DingTalk**. After adding an individual group under filtered sources, use **Receive** beside that group to choose **Mentions only** (the default) or **All messages**. Existing individual groups can also be edited. The all-groups subscription still receives mentions only; direct messages do not have this option. Click **Save** in settings to apply the change; cancel discards it. A scope change starts intake at its save boundary without importing earlier history. Receiving all messages does not mean replying to every message: responsibilities, handling settings and sending approvals still determine the response.

You can manually mention yourself in a connected group to delegate work. You can also select yourself explicitly as a direct-message contact under filtered sources and save, then manually send instructions in your self-chat. The source's handling and approval policies still apply. Selecting all contacts alone does not enable this entry, and your outgoing messages to other contacts are not treated as instructions. Stand-in replies always retain DingTalk's AI-send marker.

DingTalk source intake ignores messages explicitly identified as robot-sent or carrying an AI-send marker, regardless of sender. This prevents task notifications from the Wegent chat bot from triggering the stand-in again and creating a loop. Business messages from other bots do not trigger automatic handling either. Human-forwarded notifications and human questions quoting notifications remain actionable; conversation history reads still retain these notifications for context.

Choose manual delegation, approval before operations, or automatic handling independently for each source. New DingTalk sources default to approval before operations. The selected execution device uses its installed DingTalk plugin and account. Complete any requested authentication through the existing connector flow.

Screenshots in a connected conversation are downloaded through its read-only source query into host-generated temporary files, without another operation approval for viewing images. Missing account authentication or revoked source access still requires restoring that connection. To mention a colleague in a group, the stand-in must obtain their real person ID and pass the reply tool's mention parameter; typing “@Name” in the body produces text only. Reply sending still follows the source's confirmation settings, and message acceptance does not prove that the recipient received a mention notification.

Open **My stand-in → Stand-in details → Manage stand-in → Connections → source details → Processing**. Processing is collapsed by default. Expand it to access three matching switches, then save the stand-in settings to apply changes:

- **Handle new items immediately**: when enabled, handling starts when an event arrives; when disabled, new events are collected before the stand-in decides how to handle them. New role connections default to enabled; new primary connections default to disabled. Timing neither determines conversation ownership nor bypasses approvals.
- **Start a new conversation each time**: off by default, continuing the same conversation for this source. Turn it on to give each new event its own conversation. Reuse remains restricted to the same role, account and concrete source. Different groups, contacts and sources stay separate, including concrete sources inside an all-resources scope. Explicit replies return to their original work while it remains unarchived; redelivery never creates another conversation.

All four combinations are supported, including immediate separate conversations and delayed reused conversations. Settings changes do not reorganize existing work or messages. Events remain pending while a reused conversation awaits user input or approval. After a source conversation is archived, new messages (including replies quoting old messages) start a new conversation, which subsequent messages reuse. Old tasks and messages stay archived; redelivered old messages do not create conversations or execute again. To view or restore an old task, use **the arrow beside Recent activity → All activity → the work → Unarchive**; restoration itself does not start a turn. Automatic dispatch includes only the selected messages, not previously ignored or deferred input. Project Issues keep independent conversations; scheduled work retains each arrangement's existing conversation mode.

Direct handling does not require responsibilities or preferences to be filled in. When exactly one role is eligible, an earlier background-coordinator failure or pending question does not block direct dispatch. Existing questions and failures remain visible; this does not automatically answer approvals or replay commands with uncertain outcomes. Coordinator retries recover from actual native sessions and execution receipts, not merely the existence of a task record.

Collaboration sources retain project membership permissions. Project-scoped agents cannot broaden intake to other projects or DingTalk sources. When roles overlap, AI selects one handler to avoid duplicate execution.

Connected collaboration projects display their names, including accessible projects whose parent workspace you have not joined. Names remain visible and existing connections can be removed when switching the stand-in execution device. New local project connections can only be added when executing on the current device.

Remote execution devices can still use the all-project scope. It uses the selected Executor's own project catalog; unconnected local projects on the editing computer are not shown as remote connections.

## Work associations and approvals

Choose execution by task needs: simple or tightly coupled work can run directly in the primary stand-in; internal decomposition can use permitted native subagents; separate work threads are for independent conversations, workspaces or durable tracking. Future-condition requests such as notifying the user about a new release use native schedules/monitors, not one-time threads or permanently running subagents. An arrangement takes effect only after its existing confirmation and a successful save. Execution choice does not change source grants, authentication or operation confirmations.

New events follow the source's conversation strategy; models no longer merge them automatically based on text similarity. Explicit replies retain their original conversation. Expand related messages in the preview to split a message into separate work or move it to another item within the same role. Moving a completed message does not execute it again.

Operation approvals appear in **Needs your input** and link to the original conversation's approval card. Use its approval or rejection action; no typed “yes” is required. DingTalk reply approvals show the outgoing text bound to the original tool call. Approval-before-operations uses runtime enforcement for file writes, commands requiring elevated permissions, and MCP tools with write annotations. Approval applies to the individual operation, without persistent allow rules. This policy currently requires the Codex runtime.

## Shared human decisions

Structured questions from stand-ins and ordinary tasks share one pending request. While the app is in the foreground, a compact reminder appears in the upper right; expand it to answer simple questions. The title-bar bell's **Needs your input** entry opens the shared tab to view and handle the original task or Issue in its own interface. Work lists and notification entries no longer contain independent reply forms.

The detail header shows the selected notification’s original question and entity name, keeping the question readable when narrow windows hide the list. Needs your input hosts the original entity: tasks navigate to the selected question's original conversation turn and show its native input card. Issues use the native execution and message IDs to focus the AI message that raised the question and its context, rather than the thread's initial comment. Opening a notification preserves the reading position; clicking Reply focuses the composer. Context, questions, forms, approvals, and authorization use the original interface and handlers. The inbox does not extract or summarize conversation content or create another reply form.

The container header's **Open in original view** action opens the owning task or Issue and preserves the source comment target. Files, reviews, plans, and execution details that require the full workspace open in the original task. Child Issues open their own detail page rather than adding workspace sidebars inside the inbox.

Opening an original task restores its title, model, and workspace so you can continue the conversation, even when the task is absent from the sidebar. Opening it preserves the sidebar's existing visibility rules.

Background delivery follows the notification channel settings. Eligible simple asynchronous questions support text replies through system notifications. Manage channels in the title-bar bell's settings; the account area no longer has a separate global IM notification menu. System delivery also depends on operating-system permissions and notification settings.

Reading a notification, dismissing a reminder, or marking it read does not resolve a request. Accepted replies or an already resolved original question move it into history; failed sends retain the draft. Offline devices retain last-known questions and drafts, with replies enabled only after reconnecting and revalidating. Execution approvals, connector login, and complex forms remain in their original context; ordinary business answers never grant operation permissions. Issue answers persist in the owning comment thread before continuing its execution.

Use **Stop stand-in** at the bottom left of settings and confirm to stop. Source and startup failures remain visible for retry after fixing authentication, model selection, or connection settings. Message cursors, deduplication records, and associations persist across executor restarts.

Executor read timeouts during source collection retry automatically with backoff, without saving the connection again. Sources previously stopped by this timeout also resume from their original cursor. Automatic recovery applies only to reads, never replaying sends or other actions. Expired authentication, permission denials, and invalid responses still require correction before retrying.

## Issue human handoffs

Issue cards right-align an icon and the actor's name in the existing reference/status row above the title, without adding a row. Icons distinguish agent handling, stand-in handling and waiting for a person. Waiting uses a person with a small clock and a “Waiting for [person]” tooltip; only the name is visible as text. Confirmed running executions show the agent or stand-in, while outstanding questions prioritize their recipients. Otherwise the assigned person handles the Issue; when no person is assigned, its creator takes responsibility. There is no third handling state such as awaiting assignment. Business states remain independent, and execution details retain queued, failed and offline progress.

A structured asynchronous question raised in an Issue-bound execution is persisted on the Issue with its original thread, execution identity and handling record. The responsible participant or collaboration-group leader assigns a specific person. Until a recipient is selected, the responsible person handles the question, with the Issue creator taking responsibility when no person is assigned. There is no broadcast or default coordinator. AI reads `list_human_requests`; the reporting execution can explicitly flag dependent steps through `set_human_request_blocking`. This operation never transfers the question, resets its waiting time or grants assignment permission. The responsible participant uses `assign_human_request` to select the recipient.

Recipients answer through the shared **Needs your input** surface and the original Issue's question card. Targeted notifications reuse collaboration channel preferences. Answers persist in the owning comment thread and continue the original execution without granting access to another person's private Runtime or credentials. Reading does not resolve a request. Queued answers remain awaiting acceptance; only the owning execution's acceptance clears that question. Questions settle independently, and any unresolved question keeps the Issue on the human side. AI waits only for dependent steps while continuing independent work.

Cloud question reports and source blocking updates require a verifiable original execution record matching the project, Issue, Runtime task, device and execution owner. Manual task bindings alone, or group activities without matching canonical evidence, return a conflict (409). A same-named device or inferred owner cannot substitute for that proof; restore the original execution's trusted record first. Local projects retain their owning Executor's native source checks.

Saved board views support **Only issues needing my input**, evaluated for the current viewer rather than the view's author. Offline questions and drafts remain visible but require reconnection and authorization checks before replying. Native execution approvals and connector authentication remain separate from business answers.

The project toolbar also offers a one-click **Needs my action** filter without rewriting saved views. The global pending-work page includes native project work currently assigned to the viewer and explicit project questions, without duplicating the same question as ordinary work. Selecting project work opens the real Issue in the existing split view, without fabricating a Runtime task.

<a id="waiting-time-and-workflow-analysis"></a>

### Waiting time and workflow analysis

**With you for** starts at the current handoff and resets when another person takes over. Editing a question or blocking note, reading a notification, or saving an answer does not reset it. Ordinary work uses a reliable human assignment, initial creator handoff, or the current AI execution's completion. Historical records without current-turn evidence say **Handoff time not recorded**; update timestamps are not substituted. Timestamps are UTC and durations are elapsed wall time, not business hours.

Questions retain business events for requests, assignments, answers, delivery rejection and execution acceptance, including time, authenticated principal, recipient changes and original message identity, without copying answer bodies. These can support later analysis of waiting distributions, handoffs and successful continuation. A principal does not prove the physical operator was a human; waiting time, forwarding counts and reply length alone do not establish individual performance. Analysis must preserve project permissions and distinguish approval responsibilities, external dependencies, AI execution, non-working time and missing evidence. These are traceable business records, not a tamper-proof HR audit system. This feature does not automatically label people as bottlenecks or unproductive.

## Issue assignment reception receipts

Collaboration notifications read Stand-in history from the local Executor and online execution devices that support remote queries. A lookup failure identifies the device and reason; it means history could not be loaded, rather than an Issue execution failure. For incompatible versions, update that device's Executor and refresh notifications. Other desktop App devices are excluded from remote queries; local history still uses the native Executor.

Next to the assignee dropdown control, an outlined person with a check marks **Read by recipient** and a filled person with a check marks **Received by stand-in**. Hover to view the status and timestamp. While details refresh for the same Issue and assignee, the header retains displayed receipts without interrupting their hover tooltip. Changing the Issue or assignee hides receipts from the previous scope. A successful detail open records the human receipt; a stand-in records reception once its task is accepted, before execution completes. Both receipts retain their own timestamps and do not complete the Issue. Notification previews, marking all notifications as read, and background reads do not record a human receipt.

Assigners and recipients can view the receipts, which refresh while details remain open. The latest active assignment in the activity timeline shows the same receipts and updates together with the assignee control, without polling historical entries separately. Reassignment moves the displayed receipts to the latest assignment activity; unassignment removes the former recipient's receipts. Reassignment starts a new receipt history. Older assignments without reliable evidence show “No receipt recorded.” Executors retain pending cloud receipts for up to 30 days, increasing failed retry intervals to at most one hour. Restarting preserves the retry delay. Local-project receipts stay on the owning Executor.

Refreshing an Issue's status or other properties preserves receipt icons and pending hover tooltips for the same assignment. Reassignment, including assigning the same person again, immediately hides old receipts until the new assignment's results arrive.

Stand-ins save the recipient-owned device task binding and reception receipt before starting execution. Background handling records reception when the assignment enters its pending queue. Reception does not imply successful execution, and a later launch failure does not revoke it. Cloud acknowledgements still validate the active assignment, owned device and task binding; rejection diagnostics do not relax these checks.

Cloud assignment dispatch intents persist on their owning Executor. Transient cloud request failures recover with backoff, including after restart. A binding without a local task resumes the same task without depending on a successful binding deletion. Recovery revalidates the backend, account, current assignment, role and device; reassigned or disconnected project work is not replayed. Locally accepted tasks are not executed again by startup reconciliation. Model failures still use the original task's retry action, and configuration errors require human correction.

The desktop retries failed notification delivery with backoff until the Executor accepts it. When a restarted Executor reports missing cloud configuration, the desktop reapplies the current signed-in connection and connector authorization. Ordinary network disconnects remain owned by the Executor's existing reconnect loop.

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

New recurring arrangements use the current device's time zone; existing arrangements retain their saved zone. To specify another zone, open **the gear beside Frequency (Frequency settings) → Time zone** in the editor, enter an IANA name such as `America/New_York`, and save. The task sidebar's **Scheduled → the task** uses the same control. **One time** execution times continue to use the current device's local time.

For future execution requested in chat, the stand-in should inspect existing work evidence or immediately delegate a read-only investigation to verify the actual workflow, workspace, and required inputs. It should read available instructions and configuration instead of repeatedly asking you for those facts. Missing business choices require a question card; automatic execution must not be scheduled while they remain unresolved. Asking to use an existing automatic workflow does not prove that the workflow has been inspected, and postponing that investigation until the trigger time does not make the work ready.

“Read-only investigation” describes the preparation task's required behavior, not a new sandbox or tool-permission mode. It does not guarantee that preparation tasks are technically unable to write. Preparation retains the existing permission contract, network access, and tool approval rules; this change constrains scheduling decisions without expanding or restricting existing permissions.

The scheduled instructions should preserve your requested outcome and include the verified execution plan, without silently changing execution into a reminder. An explicit reminder needs its content and time, not an investigation of the underlying execution workflow. Successful creation means the arrangement was saved; it does not guarantee completion by the requested time or pre-approve external actions such as publishing. Execution still follows native permissions, approvals, and prerequisite checks.

**Scheduled** in the Tasks sidebar remains independent and retains its goal, target task, model, and execution environment settings without requiring experimental features. Scheduled tasks and Calendar connections manage separate lists, editors, and run histories. The stand-in work list contains concrete work.

The project conversation uses the existing collaboration group leader. Its header identifies the group and leader, and settings use the existing group configuration. Automatic project event handling enables that leader on the selected device. Each project/group has exactly one active member/device binding, with explicit takeover required for switching. Private chat and memory remain private until selected content is explicitly published to an Issue.

## Connect GitHub and GitLab

Roles can receive personal events or all subscribable repository events. The plugin provides capabilities; role instructions determine behavior. Cloud buffers repository Webhooks while the execution device is offline. External writes retain per-operation native approval. See [GitHub and GitLab connections](git-connections.md).

## Set up your stand-in

On first use, connect the apps you use, then confirm Get started. The connection step reuses the project, DingTalk, email, and other connections from stand-in settings, including their authorization and scope controls. Connecting an app is optional: Continue is available with no apps selected.

Review the selected connections before choosing Get started. This saves the connections and enables the primary stand-in. Without connections, you can still chat; there are simply no app updates to analyze yet. Add connections later in settings. Closing the introduction does not save connection drafts, and unsaved changes require a discard confirmation. Account authorization still uses the existing sign-in flow.

Setup creates no scheduled work. The question-mark entry keeps examples for daily briefings, meeting preparation, project follow-up, DingTalk replies, and weekly reviews. Choosing an example only inserts an editable conversation draft; confirm sources and schedules after sending it.

Request weekly reviews in chat or use the template under **Stand-in settings → Connections → Calendar**. The default is Monday at 09:00 Asia/Shanghai, reviewing the preceding seven days of work and conversations on this device. Edit, pause, or delete it at any time. Deleted arrangements are not restored automatically.
