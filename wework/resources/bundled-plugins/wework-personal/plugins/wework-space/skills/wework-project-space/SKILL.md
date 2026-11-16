---
name: wework-project-space
description: Discover, read or update Wework project spaces and Issues (事项, Issue, 看板事项), attachments, deliveries and members, with or without a bound project or Issue. Personal tasks (个人任务) and conversations (会话) use wework-runtime conversations instead.
---

# Wework project space

Use the `wework_space` MCP tools for project-space work. Discover deferred tools before reporting them unavailable; their schemas and business data are loaded when needed.

Project Issues (事项, Issue, 看板事项) are board items, distinct from personal tasks (个人任务) and conversations (会话). In a project context, “查一下事项” means list the current project's Issues with `list_board_items`; use `search_board_items` for requested filters. Explicit personal-task or conversation queries use `wework_control`, even in a project. A linked execution conversation is not the Issue itself. Identify the project and Issue in results; for empty results, state that no matching Issues were found in the queried project. Clarify only when the remaining intent or target is ambiguous.

1. Call `get_current_context` before answering questions about the current project or Issue. `bound: false` means there is no complete Issue binding; if `space_id` is present, reuse that project for Issue queries. Only when no project is bound, use `list_spaces` and explicit target IDs to discover accessible projects and Issues. A personal conversation does not require a preselected project or a cloud link in the prompt.
2. Call `get_board_item` with that context before interpreting the Issue description.
   Read `list_board_item_comments` as well for PR links, follow-up requirements and review feedback. It returns the latest 200 comments by default; use `limit` (up to 500) and `after_sequence` to page forward. Write with `add_board_item_comment` to the same visible Issue activity.
3. Use `list_item_attachments` and `read_item_attachment` to inspect Issue attachments.
4. Use the current context instead of asking the user to repeat a project or Issue identifier.
5. Do not probe MCP resources, use Shell or `curl`, scrape the browser, or parse `wegent://` attachment URLs.
6. Never substitute Git or provider APIs when `wework_space` reports an offline, authorization, or capability error.
7. Do not claim Issue content is unavailable until the matching `wework_space` call returns an error.

Human assignee changes notify the new owner by default. Do not send a duplicate notification. For user-requested alerts or automation conditions, use `send_notification`; omit `recipient_user_id` to notify the authenticated user.

To @ a member in a shared Backend project's comment, resolve the member with `get_assignment_candidates`, then pass `mentions=[{"type":"user","id":"52","label":"qindi"}]` together with the comment `body`, `space_id` and `item_id` to `add_board_item_comment`. Plain `@name` text does not notify. This uses the same member and Issue access checks as the page and creates one notification per recipient; do not also call `send_notification`. Pure local projects do not have a shared member inbox.
