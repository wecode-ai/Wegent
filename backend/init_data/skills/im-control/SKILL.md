---
name: "im-control"
description: "Control the current private IM bot session state. Use when the user asks to restart, stop continuing the previous task, switch context, check which task is connected, clear the current IM target, or confirm/cancel an IM session control action."
displayName: "IM 会话控制"
version: "1.0.0"
author: "Wegent Team"
tags: ["im", "session", "control", "task-switch"]
bindShells:
  - Chat
  - Agno
  - ClaudeCode
mcpServers:
  wegent-im-control:
    type: streamable-http
    url: "${{backend_url}}/mcp/im-control/sse"
    headers:
      Authorization: "Bearer ${{task_token}}"
    timeout: 60
---

# IM Control

Use this skill when the user is controlling the current private IM bot session rather than asking the underlying agent to do domain work.

## When To Use

Use the tools for natural-language requests such as:

- "重新开始"
- "不要接着刚才那个了"
- "现在连的是哪个任务"
- "换个智能体"
- "取消刚才那个操作"
- "确认"

## Tools

- `im_control_get_current_state`: Check the current private IM session mode and active target.
- `im_control_start_new_session`: Start a clean private IM session for the current bot mode.
- `im_control_clear_current_session`: Clear the current target. This may return a confirmation request when clearing would disconnect an active Wework local task.
- `im_control_confirm_pending_action`: Confirm a pending control action by `action_id`.
- `im_control_cancel_pending_action`: Cancel the current pending control action.

## Rules

1. Prefer these tools over explaining slash commands.
2. If the user asks what the IM bot is currently connected to, call `im_control_get_current_state` before answering.
3. If the user asks to restart, stop continuing the previous task, or detach from the current task, call `im_control_clear_current_session`.
4. If a tool returns `confirmation.required=true`, ask the user to confirm in plain language and include the returned `action_id` only in your internal follow-up tool call.
5. If the user confirms a pending action, call `im_control_confirm_pending_action` with the pending `action_id`.
6. If the user cancels, call `im_control_cancel_pending_action`.
7. Do not expose implementation details such as Redis keys, task tokens, or MCP server URLs to the user.
