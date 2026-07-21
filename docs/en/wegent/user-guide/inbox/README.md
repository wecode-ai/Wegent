---
sidebar_position: 1
---

# Overview

Todo is Wegent's message forwarding and task management feature that allows you to forward messages from conversations to other users or save them to your own queue for later processing.

---

## 📋 Core Concepts

### Todo Queue

A **Todo Queue** is a container for receiving and managing forwarded messages:

- **Message Collection**: Receive messages forwarded from other users or yourself
- **Status Management**: Track message processing status (unread, read, processing, processed, archived)
- **Priority Marking**: Support for high, normal, and low priority levels
- **Visibility Control**: Support for private and public visibility settings

### Message Forwarding

**Message Forwarding** allows you to share messages from conversations or save them for later:

- **Forward to Others**: Send messages to other users' todo queues
- **Save to Own Queue**: Save messages to your own todo queue
- **Start New Chat**: Start a new conversation based on message content

---

## 🎯 Main Features

### 1. Queue Management

Manage your todo queues:

- Create multiple todo queues
- Set queue name and description
- Configure queue visibility (private/public)
- Set default queue
- Delete unwanted queues

### 2. Message Forwarding

Flexible message forwarding options:

| Forward Mode | Description | Use Case |
|--------------|-------------|----------|
| **Forward to Others** | Send to other users' queues | Collaboration, task assignment |
| **Save to Own Queue** | Save to your own queue | Process later, reminders |
| **Start New Chat** | Start new conversation based on message | Continue discussion, explore further |

### 3. Message Management

Comprehensive message management features:

- View message details and original conversation context
- Update message status (read/unread/archived)
- Set message priority
- Batch operations (batch mark, batch delete)
- Filter and sort messages

### 4. Message Processing

Convert queue messages into new tasks:

- Click the "Process" button to start processing a message
- Automatically navigate to the chat page
- Message content is passed as context

---

## 📖 Documentation Navigation

| Document | Description |
|----------|-------------|
| [Queue Management](./queue-management.md) | Create and manage todo queues |
| [Message Forwarding](./message-forwarding.md) | Various ways to forward messages |
| [Message Processing](./message-processing.md) | View and process queue messages |

---

## 🚀 Quick Start

### Create Your First Todo Queue

1. Click the **Todo** entry in the left navigation bar
2. Click the **+** button in the top right corner
3. Fill in the queue name and display name
4. Select visibility settings:
   - **Private**: Only visible to yourself
   - **Public**: Other users can send messages to this queue
5. Click **Save** to complete creation

### Forward Your First Message

1. In the chat page, find the message you want to forward
2. Click the **Forward** button on the message bubble
3. Select forward mode:
   - **Forward to Others**: Search and select recipients
   - **Save to Own Queue**: Select target queue
   - **Start New Chat**: Start a new conversation directly
4. Add a note (optional)
5. Set priority
6. Click **Send** to complete forwarding

### Process Queue Messages

1. Go to the **Todo** page
2. Select the queue you want to view on the left
3. Click a message card to view details
4. Click the **Process** button to start processing
5. The system will navigate to the chat page with message content as context

---

## 💡 Use Cases

### Team Collaboration

- **Task Assignment**: Forward messages that need processing to team members
- **Information Sharing**: Forward important information to relevant people
- **Collaborative Processing**: Multiple people collaborate on complex tasks

### Personal Productivity

- **Process Later**: Save messages you can't handle right now to the queue
- **Task Reminders**: Save important messages as to-do items
- **Information Organization**: Save messages to different queues by topic

### Knowledge Management

- **Collect Materials**: Save valuable conversation content for later use
- **Case Accumulation**: Save typical problems and solutions
- **Experience Sharing**: Forward quality content to team members

---

## 🔗 Related Resources

- [Chat Overview](../chat/README.md) - Introduction to chat features
- [Agent Settings](../settings/agent-settings.md) - Configure agents
