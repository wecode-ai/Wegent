---
sidebar_position: 4
---

# Activity Timeline

The activity timeline displays all subscription execution records in a social media-style feed, making it easy to track AI agent activities.

---

## 📱 Interface Overview

### Page Layout

The Feed page contains three main tabs:

| Tab | Description |
|-----|-------------|
| **All** | Display all subscription execution activities |
| **Discover** | Browse public subscriptions |
| **Market** | Browse and rent market subscriptions |

### Timeline Structure

Activities are grouped by time:

- **Today** - Today's execution records
- **Yesterday** - Yesterday's execution records
- **This Week** - Execution records from this week
- **Earlier** - Older execution records

---

## 📝 Execution Record Cards

Each execution record displays the following information:

### Header Information

| Element | Description |
|---------|-------------|
| **Avatar** | Agent icon with status ring |
| **Subscription Name** | Name of the subscription that executed |
| **Agent Name** | @agent_name |
| **Execution Time** | Relative time (e.g., "5 minutes ago") |

### Status Indicators

The status ring color around the avatar indicates execution status:

| Status | Color | Description |
|--------|-------|-------------|
| **Pending** | Gray | Task queued for execution |
| **Running** | Theme color (animated) | Currently executing |
| **Completed** | Green | Successfully completed |
| **Completed (Silent)** | Gray | Completed with no significant updates |
| **Failed** | Red | Execution failed |
| **Retrying** | Orange (animated) | Retrying execution |
| **Cancelled** | Gray | Cancelled by user |

### AI Summary Card

For collection-type tasks, an AI-generated summary is displayed:

- Shows first 6 lines by default
- Click **Expand** to view full content
- Supports Markdown format and images
- Click **View Conversation** to jump to full conversation

### Error Information

When execution fails, an error card is displayed:

- Red border indicator
- Shows error reason
- Can view detailed logs

---

## 🔧 Operations

### View Conversation

Click the **View Conversation** button to open the conversation detail dialog:

- View complete conversation history
- Includes user messages and AI replies
- Can continue interacting in the conversation

### Cancel Execution

For pending or running tasks:

1. Click the **Cancel Execution** button
2. Confirm the cancellation
3. Task status changes to "Cancelled"

### Delete Record

For completed, failed, or cancelled records:

1. Click the **Delete** button
2. Click **Delete** in the confirmation dialog
3. Record is removed from the timeline

> ⚠️ Only subscription owners can delete execution records

### Copy IDs

Click the copy button to copy relevant IDs:

- Execution ID
- Subscription ID
- Task ID (if available)

Useful for troubleshooting or API calls.

### Refresh Activities

- Click the **Refresh** button in the bottom right to manually refresh
- New execution records are automatically pushed (WebSocket)
- Loading indicator shown during refresh

---

## 🔇 Silent Executions

### What are Silent Executions

When AI determines there are no significant updates, the execution is marked as "silent":

- Status shows as "Completed (Silent)"
- Card displayed with lower opacity
- Suitable for monitoring tasks with no changes

### Show/Hide Silent Executions

In the "All" tab, there's a silent execution toggle in the top right:

- **Hide** (default): Don't show silent execution records
- **Show**: Display all execution records including silent ones

---

## 📊 Execution History

### View in Subscription List

1. Go to subscription management page
2. Click the **Execution Count** area of a subscription
3. Expands to show the last 5 execution records

### History Record Information

| Information | Description |
|-------------|-------------|
| **Status** | Execution status icon and text |
| **Time** | Execution time (relative) |
| **Trigger Reason** | Scheduled, manual, webhook, etc. |
| **Result Summary** | AI-generated brief summary |
| **Error Message** | Error reason if failed |

---

## 🔍 Filtering and Search

### Filter by Subscription

On the subscription management page, click a specific subscription to view only that subscription's execution history.

### Filter by Status

You can filter execution records by specific status:

- All statuses
- Successful only
- Failed only
- Running

### Filter by Time

You can specify a time range to view historical records.

---

## 💡 Usage Tips

### 1. Focus on Important Activities

- Hide silent executions to focus on valuable updates
- Regularly check failed execution records

### 2. Quick Problem Location

- Use copy ID function to get execution ID
- Check error messages to understand failure reasons
- Review conversation history for more context

### 3. Manage Execution Records

- Regularly clean up unnecessary execution records
- Keep important execution results for reference

### 4. Real-time Monitoring

- Keep the page open to receive real-time updates
- Running tasks automatically update status

---

## ⚠️ Common Issues

### Q1: Activities not auto-updating?

**Solutions**:
1. Check network connection
2. Refresh page to re-establish WebSocket connection
3. Click refresh button to manually update

### Q2: Can't find a specific execution record?

**Check**:
1. Verify silent execution toggle status
2. Check if time range is correct
3. Confirm subscription filter conditions

### Q3: Unable to delete execution record?

**Reasons**:
- Only subscription owners can delete
- Running tasks need to be cancelled first

---

## 🔗 Related Documentation

- [Creating Subscriptions](./creating-subscriptions.md) - Create new subscriptions
- [Discover & Market](./discover-and-market.md) - Discover and rent subscriptions
- [Creating Conversations](../chat/managing-tasks.md) - Manual conversations with agents
