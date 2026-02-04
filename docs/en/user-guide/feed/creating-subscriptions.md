---
sidebar_position: 2
---

# Creating Subscriptions

This guide explains how to create and configure subscriptions for automated AI task execution.

---

## 📋 Creation Process

### Step 1: Access the Creation Page

1. Click **Feed** in the left navigation
2. Click the **Create Subscription** button

### Step 2: Fill in Basic Information

| Field | Required | Description |
|-------|----------|-------------|
| **Name** | ✅ | Display name for the subscription, e.g., "Daily Report" |
| **Description** | ❌ | Brief description of the subscription's purpose |
| **Task Type** | ✅ | Collection or Execution type |
| **Agent** | ✅ | Select the agent to execute tasks |

#### Task Type Explanation

| Type | Description | Use Cases |
|------|-------------|-----------|
| **Collection** | Collect and summarize information | News summaries, data reports, monitoring analysis |
| **Execution** | Execute tasks and operations | Code review, documentation updates, automated testing |

### Step 3: Configure Trigger Type

Select how the subscription should be triggered:

| Trigger Type | Description | Example |
|--------------|-------------|---------|
| **Cron Schedule** | Use Cron expressions | Daily at 9 AM |
| **Fixed Interval** | Execute at fixed intervals | Every 2 hours |
| **One-time** | Execute once at specified time | Tomorrow at 3 PM |
| **Event Trigger** | Webhook or Git Push | When webhook request received |

> 📖 See [Trigger Types](./trigger-types.md) for detailed information

### Step 4: Write Prompt Template

Describe the task to execute in the Prompt template:

```
Please summarize today's ({{date}}) tech news, including:
1. Important developments in AI
2. Major tech company updates
3. Notable startups to watch

Please present in concise bullet points.
```

#### Supported Variables

| Variable | Description | Example Value |
|----------|-------------|---------------|
| `{{date}}` | Current date | 2024-01-15 |
| `{{time}}` | Current time | 09:00:00 |
| `{{datetime}}` | Date and time | 2024-01-15 09:00:00 |
| `{{subscription_name}}` | Subscription name | Daily News Summary |
| `{{webhook_data}}` | Webhook request data | `{"event": "push"}` |

### Step 5: Advanced Configuration (Optional)

#### Code Repository Settings

If you selected a coding-type agent, configure the code repository:

1. **Select Repository**: Choose from connected repositories
2. **Select Branch**: Specify the branch to operate on

#### Model Settings

You can override the agent's default model:

1. Click the model selector
2. Select the model to use
3. If the agent has no model configured, this is required

#### Execution Configuration

| Setting | Description | Default |
|---------|-------------|---------|
| **Retry Count** | Number of retries on failure | 0 (no retry) |
| **Timeout** | Maximum time for AI to complete task | 10 minutes |
| **Preserve History** | AI can see previous execution records | Off |

#### Visibility Settings

| Visibility | Description |
|------------|-------------|
| **Private** | Only visible to you |
| **Public** | Other users can discover and follow |
| **Market** | Other users can rent |

### Step 6: Save the Subscription

1. Ensure the **Enable Subscription** toggle is on
2. Click the **Create** button
3. The subscription will automatically execute based on trigger conditions

---

## ✏️ Editing Subscriptions

### Modify Configuration

1. Find the target subscription in the subscription list
2. Click the **Edit** button (pencil icon)
3. Modify the desired settings
4. Click **Save**

### Enable/Disable

Use the toggle switch on the right side of the subscription:

- **Enabled**: Subscription will execute based on trigger conditions
- **Disabled**: Subscription pauses execution but retains configuration

### Execute Immediately

Click the **Execute Now** button (play icon) to manually trigger an execution without affecting the regular schedule.

---

## 🗑️ Deleting Subscriptions

1. Click the subscription's **Delete** button (trash icon)
2. Click **Delete** in the confirmation dialog

> ⚠️ Deletion cannot be undone, and execution history will also be deleted

---

## 💡 Best Practices

### 1. Clear Naming

Use descriptive names for easy identification:

- ✅ "Daily Tech News Summary"
- ✅ "Monday Code Quality Check"
- ❌ "Subscription1"

### 2. Detailed Prompts

Provide sufficient context and clear requirements:

```
# Good Prompt
Please analyze user feedback data from the past week, focusing on:
1. User satisfaction trends
2. Common issue categories
3. Improvement suggestions

Output format: Markdown table + brief summary

# Poor Prompt
Analyze user feedback
```

### 3. Appropriate Trigger Frequency

Choose suitable frequency based on task nature:

| Task Type | Recommended Frequency |
|-----------|----------------------|
| News summary | 1-2 times daily |
| Data monitoring | Hourly or every 2 hours |
| Weekly report | Once per week |
| Urgent alerts | Use Webhook for real-time |

### 4. Use Conversation History

For tasks that need to track changes, enable "Preserve History":

- AI can compare with previous execution results
- Identify data change trends
- Avoid reporting the same content repeatedly

---

## ⚠️ Common Issues

### Q1: Subscription not executing after creation?

**Check**:
1. Confirm the subscription is enabled (toggle is on)
2. Check if trigger time has arrived
3. Verify agent configuration is correct

### Q2: What to do when execution fails?

**Solutions**:
1. Check error message in execution record
2. Verify Prompt is clear
3. Confirm agent and model configuration is correct
4. Increase timeout if needed

### Q3: How to duplicate a subscription?

Currently not supported directly. You can:
1. Note the existing subscription's configuration
2. Create a new subscription with the same settings

---

## 🔗 Related Documentation

- [Trigger Types](./trigger-types.md) - Detailed trigger configuration
- [Activity Timeline](./timeline.md) - View execution results
- [Agent Settings](../settings/agent-settings.md) - Configure agents
