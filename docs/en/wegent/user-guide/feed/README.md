---
sidebar_position: 1
---

# Overview

Feed is Wegent's automated task execution feature that allows AI agents to automatically execute tasks based on scheduled times or events, displaying results in a social media-like timeline format.

<img src="https://github.com/user-attachments/assets/6680c33a-f4ba-4ef2-aa8c-e7a53bd003dc" width="100%" alt="Feed Demo"/>

---

## 📋 Core Concepts

### What is a Subscription

A **Subscription** is the core of the Feed feature, defining:

- **What to execute**: The Prompt template to run
- **Who executes**: Which agent to use
- **When to execute**: Trigger conditions (scheduled, interval, event, etc.)
- **How to execute**: Timeout, retry, and other configurations

```
Subscription = Prompt Template + Agent + Trigger Condition + Execution Config
```

### Execution Records

Each time a subscription triggers, it creates an **Execution** record containing:

- Execution status (pending, running, completed, failed, etc.)
- AI-generated result summary
- Complete conversation history
- Execution time and duration

---

## 🎯 Main Features

### 1. Activity Timeline

Display all subscription executions in a social media-style feed:

- Grouped by time (today, yesterday, this week, earlier)
- Real-time status updates
- Expandable AI-generated summaries
- Quick navigation to full conversations

### 2. Subscription Management

Create and manage your own subscriptions:

- Multiple trigger types (cron, interval, one-time, webhook)
- Flexible Prompt templates (with variable support)
- Optional code repository configuration
- Model override options

### 3. Discover & Follow

Discover public subscriptions from other users:

- Browse public subscriptions
- Follow interesting subscriptions
- View followed subscription results in your timeline

### 4. Subscription Market

Rent subscriptions from the market:

- Browse market subscriptions
- Customize trigger configuration
- Use your own model for execution

---

## 📖 Documentation Navigation

| Document | Description |
|----------|-------------|
| [Creating Subscriptions](./creating-subscriptions.md) | How to create and configure subscriptions |
| [Trigger Types](./trigger-types.md) | Detailed explanation of trigger types |
| [Activity Timeline](./timeline.md) | Viewing and managing execution activities |
| [Discover & Market](./discover-and-market.md) | Discovering, following, and renting subscriptions |

---

## 🚀 Quick Start

### Create Your First Subscription

1. Navigate to the **Feed** page
2. Click **Create Subscription**
3. Fill in basic information:
   - Name: e.g., "Daily News Summary"
   - Select an agent
   - Set trigger type (e.g., daily at 9 AM)
   - Write Prompt template
4. Click Create

### View Execution Results

After creation, the subscription will automatically execute at scheduled times:

1. View the activity timeline in the **All** tab
2. Click on execution records to view AI summaries
3. Click "View Conversation" to see full content

---

## 💡 Use Cases

### Information Collection

- **Daily News Summary**: Aggregate industry news every morning
- **Competitor Monitoring**: Regularly analyze competitor activities
- **Data Reports**: Generate weekly data analysis reports

### Execution Tasks

- **Code Review**: Periodically check code quality
- **Documentation Updates**: Automatically update project documentation
- **Automated Testing**: Run tests regularly and report results

### Event-Driven

- **Webhook Integration**: Receive and process external system notifications
- **Git Push Trigger**: Automatically execute tasks after code commits

---

## 🔗 Related Resources

- [Agent Settings](../settings/agent-settings.md) - Configure agents for task execution
- [Configuring Models](../settings/configuring-models.md) - Set up AI models
- [Creating Conversations](../chat/managing-tasks.md) - Manual conversations with agents
