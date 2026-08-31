---
name: wework-project-space
description: Read or update the Wework project space, current Issue, attachments, deliveries, members, or board items when a Wework project or Issue context is active.
---

# Wework project space

Use the `wework_space` MCP tools for project-space work.

1. Call `get_current_context` before answering questions about the current Issue.
2. Call `get_board_item` with that context before interpreting the Issue description.
3. Use `list_item_attachments` and `read_item_attachment` to inspect Issue attachments.
4. Use the current context instead of asking the user to repeat a project or Issue identifier.
5. Do not probe MCP resources, use Shell or `curl`, scrape the browser, or parse `wegent://` attachment URLs.
6. Never substitute Git or provider APIs when `wework_space` reports an offline, authorization, or capability error.
7. Do not claim Issue content is unavailable until the matching `wework_space` call returns an error.
