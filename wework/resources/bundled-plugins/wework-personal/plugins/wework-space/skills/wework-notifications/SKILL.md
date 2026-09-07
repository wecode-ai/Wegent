---
name: wework-notifications
description: Send Wework in-app notifications when a user requests a notification or a board automation condition requires one. Includes Issue links and delivery to connected IM sessions.
---

# Wework notifications

Use `wework_space.send_notification` to create a persistent notification. It automatically pushes to the recipient's connected IM sessions. This requires a connected Backend and project membership.

- Use the current project and Issue context. Call `get_current_context` when it is unclear. Pass `space_id` and `item_id` only when targeting another accessible Issue.
- For “notify me”, omit `recipient_user_id`; the tool uses the authenticated user. For another recipient, resolve their ID through `get_assignment_candidates` and use a member of the same project.
- Supply a concise `title` and `body` describing what happened and any requested action. The tool generates the `wework://boards/{projectId}/issues/{itemId}` link; do not invent identifiers or URLs.
- An automation instruction such as “if the review fails, notify me in Wework” authorizes sending when that condition occurs. Do not send unrelated notifications.
- Assigning a board Issue to a different human automatically creates a notification by default. Do not send a second notification for the same assignment. Honor an explicit request not to notify.
- Report success only when the tool returns a saved notification. On an error, report it; do not substitute shell commands or external IM tools.
