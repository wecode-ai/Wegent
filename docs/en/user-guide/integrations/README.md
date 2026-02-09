---
sidebar_position: 1
---

# Overview

Integrations is Wegent's connection feature with external systems, allowing you to integrate AI capabilities into your existing workflows and tools.

---

## 📋 Core Concepts

### Integration Types

Wegent supports multiple integration methods:

| Type | Description | Usage |
|------|-------------|-------|
| **IM Channels** | Integration with instant messaging tools | Slack, Discord, WeChat Work, etc. |
| **Webhook** | Receive event notifications from external systems | CI/CD, monitoring systems |
| **API** | Programmatic access to Wegent features | Custom application integration |

### Integration Workflow

```
External System → Trigger Event → Wegent Processing → AI Execution → Return Results
```

---

## 🎯 Main Features

### 1. IM Channel Integration

Connect AI agents to instant messaging tools:

- Chat with AI in channels
- Receive proactive notifications from AI
- Support for group and private chat modes
- Command-based interactions

### 2. Webhook Integration

Receive events from external systems:

- Git repository events (Push, PR, Issue)
- CI/CD pipeline status
- Monitoring alerts
- Custom events

### 3. Bidirectional Communication

Support for bidirectional interaction with external systems:

- Receive external triggers
- Call external APIs
- Send notification messages
- Status synchronization

---

## 📖 Documentation Navigation

| Document | Description |
|----------|-------------|
| [IM Channel Integration](./im-channel-integration.md) | Configure integration with instant messaging tools |

---

## 🚀 Quick Start

### Configure IM Channel Integration

1. Navigate to the **Integrations** page
2. Select **IM Channels**
3. Choose the platform to integrate (e.g., Slack)
4. Follow the guide to complete authorization
5. Select the agent to connect
6. Start using

### Configure Webhook

1. Create a subscription in **Feed**
2. Select **Event Trigger** type
3. Get the Webhook URL
4. Configure Webhook in the external system
5. Test the trigger

---

## 💡 Use Cases

### Development Workflow

- **Code Review**: Git Push automatically triggers code review
- **Deployment Notifications**: CI/CD completion notifications
- **Issue Processing**: Automatically analyze and respond to issues

### Operations Monitoring

- **Alert Handling**: Receive monitoring alerts and auto-analyze
- **Status Reports**: Scheduled system status reports
- **Troubleshooting**: Assist in diagnosing system issues

### Team Collaboration

- **Daily Q&A**: Ask AI questions in IM
- **Knowledge Query**: Query documents and knowledge bases
- **Task Reminders**: Scheduled tasks and reminders

---

## 🔗 Related Resources

- [Feed Overview](../feed/README.md) - Configure automated tasks
- [Creating Subscriptions](../feed/creating-subscriptions.md) - Set up Webhook triggers
