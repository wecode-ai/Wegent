---
name: wework-project-space
description: Discover, read or update Wework project spaces, Issues, attachments, deliveries, members or board items, with or without a bound project or Issue.
---

# Wework project space

Use the `wework_space` MCP tools for project-space work. Discover deferred tools before reporting them unavailable; their schemas and business data are loaded when needed.

1. Call `get_current_context` before answering questions about the current Issue. If it returns `bound: false`, use `list_spaces` and explicit target IDs to discover accessible projects and Issues. A personal conversation does not require a preselected project or a cloud link in the prompt.
2. Call `get_board_item` with that context before interpreting the Issue description.
   Read `list_board_item_comments` as well for PR links, follow-up requirements and review feedback. It returns the latest 200 comments by default; use `limit` (up to 500) and `after_sequence` to page forward. Write with `add_board_item_comment` to the same visible Issue activity.
3. Use `list_item_attachments` and `read_item_attachment` to inspect Issue attachments.
4. Use the current context instead of asking the user to repeat a project or Issue identifier.
5. Do not probe MCP resources, use Shell or `curl`, scrape the browser, or parse `wegent://` attachment URLs.
6. Never substitute Git or provider APIs when `wework_space` reports an offline, authorization, or capability error.
7. Do not claim Issue content is unavailable until the matching `wework_space` call returns an error.

Human assignee changes notify the new owner by default. Do not send a duplicate notification. For user-requested alerts or automation conditions, use `send_notification`; omit `recipient_user_id` to notify the authenticated user.

To @ a member in a shared Backend project's comment, resolve the member with `get_assignment_candidates`, then pass `mentions=[{"type":"user","id":"52","label":"qindi"}]` together with the comment `body`, `space_id` and `item_id` to `add_board_item_comment`. Plain `@name` text does not notify. This uses the same member and Issue access checks as the page and creates one notification per recipient; do not also call `send_notification`. Pure local projects do not have a shared member inbox.
