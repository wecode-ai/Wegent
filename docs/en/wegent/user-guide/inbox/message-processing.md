---
sidebar_position: 4
---

# Message Processing

This document explains how to view and process messages in your todo queue.

---

## 📋 Message List

### Page Layout

The Todo page is divided into two areas:

- **Left Sidebar**: Queue list, showing all todo queues and unread message counts
- **Right Main Area**: Message list, showing messages in the currently selected queue

### Message Card

Each message is displayed as a card containing the following information:

| Element | Description |
|---------|-------------|
| **Status Indicator** | Shows message status (unread displays a blue dot) |
| **Sender** | Username of the person who forwarded the message |
| **Time** | Message received time |
| **Priority** | High priority shows red icon, low priority shows blue icon |
| **Note** | Note added by the sender |
| **Content Preview** | First two lines of message content preview |
| **Message Count** | Number of forwarded messages |

---

## 🔍 Filtering and Sorting

### Status Filter

Click the status filter dropdown to filter by message status:

| Status | Description |
|--------|-------------|
| **All** | Show all messages |
| **Unread** | Show only unread messages |
| **Read** | Show only read messages |
| **Processing** | Show only messages being processed |
| **Processed** | Show only processed messages |
| **Archived** | Show only archived messages |

### Sort Order

Click the sort dropdown to select sort order:

| Sort | Description |
|------|-------------|
| **Newest First** | Sort by time descending, newest messages first |
| **Oldest First** | Sort by time ascending, oldest messages first |

---

## 📖 Viewing Message Details

### Opening Details

Click a message card to open the message detail dialog.

### Detail Content

The message detail dialog displays:

- **Sender Information**: Username and email
- **Received Time**: When the message was received
- **Status Label**: Current message status
- **Priority Label**: Message priority (shown for non-normal priority)
- **Note**: Note added by the sender
- **Message Content**: Complete conversation content, including user messages and AI replies

### Message Content Display

- User messages and AI messages have different background colors
- Shows sender and time for each message
- Supports scrolling for long conversations
- Displays message attachment information (if any)

### Auto Mark as Read

- When opening message details, unread messages are automatically marked as read
- Unread count updates in real-time

---

## ⚡ Processing Messages

### Process Button

Click the **Process** button in the message detail dialog or the message card's more menu to start processing a message.

### Processing Flow

1. Click the **Process** button
2. System navigates to the chat page
3. Message content is passed as context
4. You can select an agent to continue processing

### Use Cases

- Need to perform further operations based on message content
- Need to use an AI agent to process the message
- Need follow-up conversation related to message content

---

## 📝 Message Operations

### Single Message Operations

Click the more button (three dots icon) on the right side of a message card for the following operations:

| Operation | Description |
|-----------|-------------|
| **Process** | Start processing the message, navigate to chat page |
| **Mark as Read** | Mark unread message as read |
| **Mark as Unread** | Mark read message as unread |
| **Archive** | Archive the message |
| **Set Priority** | Change message priority |
| **Delete** | Delete the message |

### Batch Operations

#### Entering Batch Selection Mode

1. Click the **Select** button at the top of the message list
2. Enter batch selection mode
3. Check the messages you want to operate on

#### Batch Operation Options

| Operation | Description |
|-----------|-------------|
| **Mark as Read** | Batch mark selected messages as read |
| **Mark as Unread** | Batch mark selected messages as unread |
| **Archive** | Batch archive selected messages |
| **Process** | Batch process selected messages |
| **Delete** | Batch delete selected messages |

#### Select All and Deselect

- Click the checkbox at the top to select/deselect all messages on the current page
- Shows the number of currently selected messages

#### Exiting Batch Mode

Click the **X** button in the top right corner to exit batch selection mode.

---

## 🏷️ Message Status

### Status Description

| Status | Icon | Description |
|--------|------|-------------|
| **Unread** | 🔵 Blue filled circle | Newly received message, not yet viewed |
| **Read** | ⚪ Empty circle | Viewed but not processed |
| **Processing** | 🔄 Spinning icon | Currently being processed |
| **Processed** | ✅ Green checkmark | Processing completed |
| **Archived** | 📦 Archive icon | Archived message |

### Status Flow

```
Unread → Read → Processing → Processed
          ↓
       Archived
```

---

## ⚠️ Deleting Messages

### Single Delete

1. Click the more button on the right side of the message card
2. Select **Delete**
3. Click **Delete** in the confirmation dialog to confirm

### Batch Delete

1. Enter batch selection mode
2. Check the messages you want to delete
3. Click the **Delete** button
4. Click **Delete** in the confirmation dialog to confirm

### Notes

- ⚠️ Delete operation cannot be undone
- ⚠️ Deleted messages are permanently removed
- It's recommended to archive important messages rather than delete them

---

## 💡 Best Practices

### Efficient Processing

- Regularly check unread messages
- Prioritize high-priority messages
- Use filters to quickly locate messages
- Update status promptly after processing

### Message Organization

- Regularly archive processed messages
- Delete messages that are no longer needed
- Keep queues clean and organized

### Team Collaboration

- Promptly process received forwarded messages
- Reply to senders after processing is complete
- Establish team message processing guidelines

---

## 🔗 Related Documents

- [Queue Management](./queue-management.md) - Learn how to manage todo queues
- [Message Forwarding](./message-forwarding.md) - Learn how to forward messages
