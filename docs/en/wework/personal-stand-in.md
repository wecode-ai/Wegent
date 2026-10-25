---
sidebar_position: 12
---

# Personal stand-in and scenario roles

Open **My stand-in** in the collaboration sidebar to delegate work, ask follow-up questions, or draft a scenario role with AI. The primary identity conversation and individual work executions are stored separately. Returning from a role restores the primary conversation.

A **scenario role** continuously handles a particular information flow. Its default page is a work list. Select work for an inline preview and answer pending approvals there. Open the full conversation when you need more context or discussion. Each role also has its own persistent identity conversation.

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

Answer operation approvals directly in the work-list preview. The same approval appears in the conversation input area with clickable actions; no typed “yes” is required. DingTalk reply approvals show the outgoing text bound to the original tool call. Approval-before-operations uses runtime enforcement for file writes, commands requiring elevated permissions, and MCP tools with write annotations. Approval applies to the individual operation, without persistent allow rules. This policy currently requires the Codex runtime.

Disable **Receive new work** and save to pause new intake while retaining existing work. Source and startup failures remain visible for retry after fixing authentication, model selection, or connection settings. Message cursors, deduplication records, and associations persist across executor restarts.
