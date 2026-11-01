---
sidebar_position: 12
---

# Personal stand-in and scenario roles

Open **My stand-in** in the collaboration sidebar to delegate work, ask follow-up questions, or draft a scenario role with AI. The primary identity conversation and individual work executions are stored separately. Returning from a role restores the primary conversation.

A **scenario role** continuously handles a particular information flow. Its default page is a work list. Select work for a preview, open the shared **Needs your input** tab for human decisions, or open the full conversation for context. Each role also has its own persistent identity conversation.

## Manual and conversational configuration

Edit responsibilities and shared preferences in the primary profile, and role responsibilities and sources in the role profile. Preferences can be edited or deleted. Changes take effect only after saving.

You can also describe a role or configuration change in conversation. AI creates a proposal showing the affected roles, source scopes, and handling policies. Review it and explicitly confirm before applying. Continue discussing to revise it, or dismiss it. A stale proposal cannot overwrite newer settings.

## DingTalk and collaboration sources

Search and manually select individual DingTalk groups or contacts in the profile's source section. Group sources receive relevant mentions from the selected group; contact sources receive direct messages from the selected contact. Each source remains bound to the DingTalk account used when selecting it.

You can manually mention yourself in a connected group to delegate work. Stand-in replies always retain DingTalk's AI-send marker. Intake uses the provider marker to exclude your own AI messages and prevent reply loops.

Choose manual delegation, approval before operations, or automatic handling independently for each source. New DingTalk sources default to approval before operations. The selected execution device uses its installed DingTalk plugin and account. Complete any requested authentication through the existing connector flow.

Collaboration sources retain project membership permissions. Project-scoped agents cannot broaden intake to other projects or DingTalk sources. When roles overlap, AI selects one handler to avoid duplicate execution.

Connected collaboration projects display their names, including accessible projects whose parent workspace you have not joined. Names remain visible and existing connections can be removed when switching the stand-in execution device. New local project connections can only be added when executing on the current device.

Remote execution devices can still use the all-project scope. It uses the selected Executor's own project catalog; unconnected local projects on the editing computer are not shown as remote connections.

## Work associations and approvals

Follow-up messages concerning the same concrete matter can join existing work. Uncertain associations wait for review. Expand related messages in the preview to split a message into separate work or move it to another item within the same role. Moving a completed message does not execute it again.

Operation approvals appear in **Needs your input** and link to the original conversation's approval card. Use its approval or rejection action; no typed “yes” is required. DingTalk reply approvals show the outgoing text bound to the original tool call. Approval-before-operations uses runtime enforcement for file writes, commands requiring elevated permissions, and MCP tools with write annotations. Approval applies to the individual operation, without persistent allow rules. This policy currently requires the Codex runtime.

## Shared human decisions

Structured questions from stand-ins and ordinary tasks share one pending request. While the app is in the foreground, a compact reminder appears in the upper right; expand it to answer simple questions. The title-bar bell's **Needs your input** entry opens the shared tab with the question, supporting context, and original conversation. Work lists and notification entries no longer contain independent reply forms.

Background delivery follows the notification channel settings. Eligible simple asynchronous questions support text replies through system notifications. Manage channels in the title-bar bell's settings; the account area no longer has a separate global IM notification menu. System delivery also depends on operating-system permissions and notification settings.

Reading a notification, dismissing a reminder, or marking it read does not resolve a request. Accepted replies or an already resolved original question move it into history; failed sends retain the draft. Offline devices retain last-known questions and drafts, with replies enabled only after reconnecting and revalidating. Execution approvals, connector login, and complex forms remain in their original context; ordinary business answers never grant operation permissions. Issue answers persist in the owning comment thread before continuing its execution.

Disable **Receive new work** and save to pause new intake while retaining existing work. Source and startup failures remain visible for retry after fixing authentication, model selection, or connection settings. Message cursors, deduplication records, and associations persist across executor restarts.

## Issue assignment reception receipts

Inside the assignee dropdown control, an outlined person with a check marks **Read by recipient** and a filled person with a check marks **Received by stand-in**. Hover to view the status and timestamp. A successful detail open records the human receipt; a stand-in records reception once its task is accepted, before execution completes. Both receipts retain their own timestamps and do not complete the Issue. Notification previews, marking all notifications as read, and background reads do not record a human receipt.

Assigners and recipients can view the receipts, which refresh while details remain open. The latest active assignment in the activity timeline shows the same receipts and updates together with the assignee control, without polling historical entries separately. Reassignment moves the displayed receipts to the latest assignment activity; unassignment removes the former recipient's receipts. Reassignment starts a new receipt history. Older assignments without reliable evidence show “No receipt recorded.” Executors retain pending cloud receipts for up to 30 days, increasing failed retry intervals to at most one hour. Restarting preserves the retry delay. Local-project receipts stay on the owning Executor.
