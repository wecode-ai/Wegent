---
name: "subscription-manager"
description: "Create and manage scheduled subscription tasks. Use when the user wants to set up recurring reminders, periodic reports, scheduled checks, or any automated tasks that run on a schedule. Supports cron expressions, fixed intervals, and one-time executions."
displayName: "订阅任务管理"
version: "1.0.0"
author: "Wegent Team"
tags: ["subscription", "scheduler", "automation", "cron", "periodic"]
bindShells:
  - Chat
  - Agno
  - ClaudeCode
mcpServers:
  wegent-subscription:
    type: streamable-http
    url: "${{backend_url}}/mcp/subscription/sse"
    headers:
      Authorization: "Bearer ${{task_token}}"
    timeout: 60
---

# Subscription Task Manager

You now have access to subscription management tools. Use them to create scheduled, recurring, or periodic tasks for the user.

## When to Use

1. **Recurring reminders** - "remind me every morning", "notify me weekly"
2. **Periodic reports** - "send me a daily summary", "generate weekly analytics"
3. **Scheduled checks** - "check status every hour", "monitor every 30 minutes"
4. **One-time future tasks** - "remind me tomorrow at 3pm", "check this next Friday"
5. **Any automated recurring task** - anything that needs to run on a schedule

## Available Tools

### preview_subscription

**ALWAYS call this** when the user mentions scheduling intent.

Generates a preview of the subscription configuration **without creating it**. The preview is displayed as an interactive block card in the UI with "Confirm" and "Cancel" buttons.

**Key Parameters:**
- `display_name` (string): Human-readable task name
- `trigger_type` (string): `"cron"`, `"interval"`, or `"one_time"`
- `prompt_template` (string): The prompt to execute on each run
- `cron_expression` (string): For cron type, e.g., `"0 9 * * *"` (daily at 9am)
- `interval_value` + `interval_unit`: For interval type, e.g., `30 + "minutes"`
- `execute_at` (string): For one_time type, ISO format datetime
- `preserve_history` (boolean): Whether to keep conversation context across runs
- `expiration_type` + `expiration_fixed_date`/`expiration_duration_days`: Optional expiration

**Workflow:**
1. User: "remind me every morning to drink water"
2. You: Call `preview_subscription` with appropriate parameters
3. System: Displays an interactive preview block card in the chat with Confirm/Cancel buttons
4. User action (either one):
   - **Clicks "Confirm" button**: Frontend handles creation automatically - you do NOT need to do anything
   - **Sends "确认" message**: You must call `create_subscription` with the same parameters to create the subscription
5. System: Subscription created

**IMPORTANT:**
- The tool returns immediately with a silent exit marker
- The preview block is rendered by the frontend, NOT by you
- **DO NOT** display any markdown table or text preview yourself
- **DO NOT** ask user to reply "执行" or "确认"
- After calling preview_subscription, output this exact message: "点击确认按钮或发送\"确认\"消息，来创建订阅任务"
- If user sends "确认" or similar confirmation message, call `create_subscription` with the same parameters

## Important Rules

1. **🚫 NEVER auto-create subscription** - After calling `preview_subscription`, you must wait for user to click the "Confirm" button in the preview card or explicitly send a confirmation message. Do NOT auto-create the subscription after preview.
2. **ONLY call `create_subscription` when user explicitly confirms via message** - If user sends "确认" or "创建" after preview, then call `create_subscription` with the same parameters to actually create the subscription. If user clicks the Confirm button in UI, frontend handles creation automatically - you do NOT need to call `create_subscription`.
3. **When time is vague** (e.g., "every morning"), offer 2-3 specific time options
4. **Use `preserve_history: true`** for tasks needing context continuity (daily reports, monitoring)
5. **Use `preserve_history: false`** for independent tasks (reminders, checks)
6. **Name generation**: Create concise, readable names based on task content
7. **After calling preview_subscription**: Output the message "点击确认按钮或发送\"确认\"消息，来创建订阅任务" then stop and wait for user confirmation

## Examples

### Daily morning reminder

```
preview_subscription(
  display_name="Daily Morning Water Reminder",
  trigger_type="cron",
  cron_expression="0 9 * * *",
  prompt_template="Remind me to drink a glass of water to start the day healthy!",
  preserve_history=false
)
```

### Weekly report (preserves history for context)

```
preview_subscription(
  display_name="Weekly Project Summary",
  trigger_type="cron",
  cron_expression="0 18 * * 5",
  prompt_template="Generate a weekly summary of project progress, blockers, and next week's priorities.",
  preserve_history=true,
  history_message_count=20
)
```

### Every 30 minutes monitoring

```
preview_subscription(
  display_name="Server Status Monitor",
  trigger_type="interval",
  interval_value=30,
  interval_unit="minutes",
  prompt_template="Check server CPU and memory usage. Alert if CPU > 80% or memory > 90%.",
  preserve_history=false
)
```

### One-time future task

```
preview_subscription(
  display_name="Deployment Reminder",
  trigger_type="one_time",
  execute_at="2025-04-15T14:00:00",
  prompt_template="Remind me to deploy the new feature to production.",
  preserve_history=false
)
```

### With expiration (30 days)

```
preview_subscription(
  display_name="Trial Monitoring",
  trigger_type="interval",
  interval_value=1,
  interval_unit="days",
  prompt_template="Check trial account status and send daily summary.",
  expiration_type="duration_days",
  expiration_duration_days=30
)
```

## Response Format

**preview_subscription returns:**
```json
{
  "__silent_exit__": true,
  "reason": "subscription_preview block displayed; waiting for user confirmation",
  "preview_id": "preview_abc123",
  "execution_id": "exec_xyz789"
}
```

The frontend will display an interactive preview block card with Confirm/Cancel buttons.

**User confirmation handling:**
- If user clicks "Confirm" button in the UI: Frontend automatically creates the subscription - you do NOT need to call any other tool
- If user sends confirmation message (e.g., "确认", "创建"): You must call `create_subscription` with the same parameters to create the subscription
