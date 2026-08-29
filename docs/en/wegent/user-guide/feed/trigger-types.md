---
sidebar_position: 3
---

# Trigger Types

Subscriptions support multiple trigger types to meet different automation scenario requirements.

---

## 📅 Cron Schedule

Use Cron expressions to define complex execution schedules, suitable for tasks that need to run at specific times.

### Quick Presets

The system provides commonly used preset options:

| Preset               | Cron Expression | Description                 |
| -------------------- | --------------- | --------------------------- |
| Every hour           | `0 * * * *`     | At minute 0 of every hour   |
| Every 2 hours        | `0 */2 * * *`   | Every 2 hours               |
| Every 6 hours        | `0 */6 * * *`   | Every 6 hours               |
| Daily at 9 AM        | `0 9 * * *`     | Every day at 09:00          |
| Daily at noon        | `0 12 * * *`    | Every day at 12:00          |
| Daily at 6 PM        | `0 18 * * *`    | Every day at 18:00          |
| Weekdays at 9 AM     | `0 9 * * 1-5`   | Monday to Friday at 09:00   |
| Every Monday at 9 AM | `0 9 * * 1`     | Every Monday at 09:00       |
| 1st of month at 9 AM | `0 9 1 * *`     | 1st of every month at 09:00 |

### Custom Configuration

#### Execution Frequency

Select the basic frequency type:

| Frequency   | Description                            |
| ----------- | -------------------------------------- |
| **Hourly**  | Execute every N hours                  |
| **Daily**   | Execute at specified time each day     |
| **Weekly**  | Execute on specified days of the week  |
| **Monthly** | Execute on specified days of the month |

#### Hourly Configuration

- **Hour Interval**: 1-12 hours
- **At Minute**: 0-59 minutes

Example: Execute at minute 30 every 2 hours → `30 */2 * * *`

#### Daily Configuration

- **Execution Time**: Select hour and minute

Example: Execute daily at 09:30 → `30 9 * * *`

#### Weekly Configuration

- **Select Days**: Multi-select Monday through Sunday
- **Execution Time**: Select hour and minute

Example: Every Monday, Wednesday, Friday at 9 AM → `0 9 * * 1,3,5`

#### Monthly Configuration

- **Select Dates**: 1-31, or "Last day"
- **Execution Time**: Select hour and minute

Example: 1st and 15th of each month at 9 AM → `0 9 1,15 * *`

### Cron Expression Format

```
┌───────────── minute (0-59)
│ ┌───────────── hour (0-23)
│ │ ┌───────────── day of month (1-31)
│ │ │ ┌───────────── month (1-12)
│ │ │ │ ┌───────────── day of week (0-7, both 0 and 7 are Sunday)
│ │ │ │ │
* * * * *
```

#### Special Characters

| Character | Description | Example                         |
| --------- | ----------- | ------------------------------- |
| `*`       | Any value   | `* * * * *` every minute        |
| `,`       | List        | `0 9,18 * * *` at 9 AM and 6 PM |
| `-`       | Range       | `0 9 * * 1-5` Monday to Friday  |
| `/`       | Step        | `*/15 * * * *` every 15 minutes |

### Timezone Note

Cron expressions use your local timezone. The system displays the current timezone in the configuration interface.

---

## ⏱️ Fixed Interval

Execute repeatedly at fixed time intervals, suitable for tasks requiring regular checks or monitoring.

### Configuration Options

| Option             | Description   | Range                |
| ------------------ | ------------- | -------------------- |
| **Interval Value** | Numeric value | 1-999                |
| **Unit**           | Time unit     | Minutes, Hours, Days |

### Examples

| Configuration | Description              |
| ------------- | ------------------------ |
| 30 minutes    | Execute every 30 minutes |
| 2 hours       | Execute every 2 hours    |
| 1 day         | Execute once daily       |

### Difference from Cron

| Feature                  | Fixed Interval             | Cron                             |
| ------------------------ | -------------------------- | -------------------------------- |
| Configuration complexity | Simple                     | Flexible but complex             |
| Execution time           | Relative to last execution | Fixed time points                |
| Use cases                | Monitoring, polling        | Scheduled reports, planned tasks |

---

## 🕐 One-time Schedule

Execute once at a specified date and time, suitable for temporary tasks or one-time needs.

### Configuration Options

Use the date-time picker to select execution time:

1. Select date
2. Select time (hour and minute)

### Use Cases

- Scheduled report delivery
- Timed reminders
- Temporary data collection

### Notes

- Subscription won't trigger again after execution
- You can manually set a new execution time
- Recommended to check results after execution

---

## 🔔 Event Trigger

Trigger execution through external events, suitable for integration with other systems. In the automation configuration, the **trigger source** is split by platform into specific types instead of one generic “external event”:

- **Issue trigger**: an internal Issue is created or changes status within the workspace.
- **GitHub**: observe Change Request events on a repository.
- **GitLab**: observe Change Request events on a project.

### Show the subscription resource inline after selecting a source

After selecting a source such as GitHub or GitLab, the automation configuration directly shows the event subscription for that source:

- **Observed resource**: the repository/project name and address being observed.
- **Webhook URL**: the system-generated receiving endpoint for platform callbacks.
- **Status**: whether the subscription is currently enabled or disabled.

The subscription address is shown directly in the automation configuration, alongside the event type and execution target. To create a new subscription for the selected source, use **Add subscription** right inside the trigger settings; the new subscription is selected automatically and its Webhook URL is shown on the same page.

### Git Push Trigger

Trigger execution on code push (in development).

#### Configuration Options

| Option         | Description                                            |
| -------------- | ------------------------------------------------------ |
| **Repository** | Git repository address (owner/repo format)             |
| **Branch**     | Branch to monitor (optional, defaults to all branches) |

#### Use Cases

- Automatic code review after commits
- Automated test execution
- Documentation updates

---

## 💡 Selection Recommendations

### By Scenario

| Scenario             | Recommended Trigger |
| -------------------- | ------------------- |
| Daily reports        | Cron Schedule       |
| Real-time monitoring | Fixed Interval      |
| Temporary tasks      | One-time Schedule   |
| System integration   | Webhook             |
| CI/CD                | Git Push            |

### By Frequency

| Frequency      | Recommended Trigger    |
| -------------- | ---------------------- |
| Per minute     | Fixed Interval         |
| Per hour       | Fixed Interval or Cron |
| Per day        | Cron                   |
| Per week/month | Cron                   |
| On-demand      | Webhook                |

---

## ⚠️ Important Notes

### Execution Frequency Limits

- Minimum interval recommended is 1 minute
- High-frequency execution consumes more resources
- Consider task execution time to avoid overlap

### Timezone Issues

- Cron uses local timezone
- Be aware of time conversion for cross-timezone collaboration
- System displays next execution time for confirmation

### Webhook Security

- Recommended to use signature verification
- Keep signing secrets secure
- Rotate secrets periodically

---

## 🔗 Related Documentation

- [Creating Subscriptions](./creating-subscriptions.md) - Complete creation process
- [Activity Timeline](./timeline.md) - View execution results
