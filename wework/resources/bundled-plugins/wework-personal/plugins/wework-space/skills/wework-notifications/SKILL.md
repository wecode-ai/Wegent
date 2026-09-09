---
name: wework-notifications
description: Send Wework in-app notifications when a user requests an alert, greeting, or automation notification. Works in ordinary conversations without a project or board, with optional project links and delivery to connected IM sessions.
---

# Wework notifications

Use `wework_space.send_notification` to create a persistent user notification. It also attempts delivery to the recipient's connected IM sessions. An authenticated Backend connection is required; a project or board is not required to notify yourself.

- For an ordinary request such as “给我发个通知，说你好”, call `send_notification` with a concise title and `body: "你好"`. Do not require a project, create a board, or search for an Issue first.
- `space_id` and `item_id` are optional source context. Backend project conversations can use their bound context; ordinary and local-project conversations can send without it. Supply source IDs only when the notification relates to that accessible Backend project or Issue.
- For “notify me”, omit `recipient_user_id`; the tool uses the authenticated user. For another recipient, resolve their ID through `get_assignment_candidates` and use a member of the same project.
- Supply a concise `title` and `body` describing what happened and any requested action. Use optional `url` for the requested click destination independently of source context. For “给我发个你好的通知，然后点击打开看板页面”, send `title: "你好", body: "你好", url: "wework://boards"`. The page opens only when the notification is clicked; do not call `browser open` as a substitute. Other supported destinations are `wework://boards/{projectId}`, `wework://boards/{projectId}/issues/{encodedItemId}`, and `wework://tasks/{encodedDeviceId}/{encodedTaskId}`; use known identifiers and URL-encode each segment. Without `url`, a source link is generated if supplied; otherwise the notification has no click destination.
- An automation instruction such as “if the review fails, notify me in Wework” authorizes sending when that condition occurs. Do not send unrelated notifications.
- Assigning a board Issue to a different human automatically creates a notification by default. Do not send a second notification for the same assignment. Honor an explicit request not to notify.
- Report success only when the tool returns a saved notification. On an error, report it; do not substitute shell commands or external IM tools.
