---
name: wework-project-space
description: Read or update the Wework project space, current Issue, attachments, deliveries, members, or board items when a Wework project or Issue context is active.
---

# Wework project space

Use the `wework_space` MCP tools for project-space work.

1. Call `get_current_context` before answering questions about the current Issue.
2. Use `list_item_attachments` and `read_item_attachment` to inspect Issue attachments.
3. Use the current context instead of asking the user to repeat a project or Issue identifier.
4. Never substitute Git, browser scraping, or provider APIs when `wework_space` reports an offline, authorization, or capability error.
5. Do not claim Issue content is unavailable until the matching `wework_space` call returns an error.
