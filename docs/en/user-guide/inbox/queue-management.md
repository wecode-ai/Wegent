---
sidebar_position: 2
---

# Queue Management

This document explains how to create and manage todo queues.

---

## 📋 Queue Overview

A todo queue is a container for receiving and managing forwarded messages. Each user can create multiple queues to categorize different types of messages.

### Queue Properties

| Property | Description |
|----------|-------------|
| **Name** | Unique identifier for the queue, cannot be changed after creation |
| **Display Name** | Display name of the queue, can be modified anytime |
| **Description** | Description of the queue's purpose |
| **Visibility** | Private or public |
| **Default Queue** | Whether this is the default receiving queue |

### Visibility Settings

| Visibility | Description |
|------------|-------------|
| **Private** | Only you can send messages to this queue |
| **Public** | Other users can search and send messages to this queue |

---

## 🎯 Creating a Queue

### Steps

1. Go to the **Todo** page
2. Click the **+** button at the top of the sidebar
3. Fill in queue information:
   - **Name**: Enter a unique identifier (only letters, numbers, underscores allowed)
   - **Display Name**: Enter the display name
   - **Description**: Enter a description of the queue's purpose (optional)
4. Select visibility:
   - **Private**: Only visible to yourself
   - **Public**: Other users can send messages to this queue
5. Click **Save** to complete creation

### Notes

- Queue name cannot be changed after creation
- Use meaningful names for easy identification and management
- The first queue created will automatically be set as the default queue

---

## ✏️ Editing a Queue

### Steps

1. Find the queue you want to edit in the queue list
2. Hover over the queue and click the **More** button (three dots icon) on the right
3. Select **Edit**
4. Modify queue information:
   - Display name
   - Description
   - Visibility
5. Click **Save** to complete the modification

### Editable Properties

- ✅ Display name
- ✅ Description
- ✅ Visibility
- ❌ Name (cannot be modified)

---

## ⭐ Setting Default Queue

The default queue is the preferred queue for receiving forwarded messages. When other users forward messages to you without specifying a queue, messages will be sent to your default queue.

### Steps

1. Find the queue you want to set as default in the queue list
2. Hover over the queue and click the **More** button on the right
3. Select **Set as Default Queue**

### Default Queue Indicator

- The default queue displays a ⭐ star icon in the list
- Each user can only have one default queue
- Setting a new default queue will automatically remove the default status from the previous one

---

## 🗑️ Deleting a Queue

### Steps

1. Find the queue you want to delete in the queue list
2. Hover over the queue and click the **More** button on the right
3. Select **Delete**
4. Click **Delete** in the confirmation dialog to confirm

### Notes

- ⚠️ Deleting a queue will also delete all messages in the queue
- ⚠️ Delete operation cannot be undone
- It's recommended to process or archive important messages before deleting

---

## 📊 Queue Statistics

### Unread Message Count

- Each queue displays the number of unread messages on the right
- The total unread count for all queues is displayed at the top of the sidebar
- The Todo entry in the navigation bar also shows an unread badge

### Message Status Statistics

You can view messages with different statuses using the filter in the message list:

| Status | Description |
|--------|-------------|
| **Unread** | Newly received messages |
| **Read** | Messages that have been viewed but not processed |
| **Processing** | Messages currently being processed |
| **Processed** | Messages that have been processed |
| **Archived** | Archived messages |

---

## 💡 Best Practices

### Queue Classification Suggestions

Create multiple queues for different purposes:

| Queue Type | Purpose | Recommended Visibility |
|------------|---------|------------------------|
| **Work Tasks** | Receive work-related task messages | Public |
| **Personal Notes** | Save personal notes and to-do items | Private |
| **Learning Materials** | Collect learning-related content | Private |
| **Team Collaboration** | Receive collaboration messages from team members | Public |

### Queue Naming Conventions

- Use concise and clear names
- Avoid special characters
- Use English or pinyin for queue names
- Display names can use any language

### Regular Maintenance

- Regularly process unread messages
- Archive completed messages
- Delete messages that are no longer needed
- Clean up unused queues

---

## 🔗 Related Documents

- [Message Forwarding](./message-forwarding.md) - Learn how to forward messages
- [Message Processing](./message-processing.md) - Learn how to process queue messages
