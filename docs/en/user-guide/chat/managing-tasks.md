---
sidebar_position: 5
---

# Creating Conversations

This guide explains how to create conversation-type tasks in the Wegent frontend to interact with AI agents.

---

## 📋 Table of Contents

- [What is a Conversation](#-what-is-a-conversation)
- [Creating a Conversation](#-creating-a-conversation)
- [Conversation Interface](#-conversation-interface)
- [Advanced Features](#-advanced-features)
- [Managing Task Knowledge](#-managing-task-knowledge)
- [Best Practices](#-best-practices)
- [Common Issues](#-common-issues)
- [Related Resources](#-related-resources)

---

## 💬 What is a Conversation

In Wegent, a conversation is the primary way users interact with AI agents. Each conversation creates a Task that records the complete conversation history.

**Core Concept**:

```text
Conversation = User Message + Agent + Context + Status
```

### Conversation Components

| Component   | Description                           | Example                       |
| ----------- | ------------------------------------- | ----------------------------- |
| **Message** | User's question or instruction        | "Help me analyze this report" |
| **Agent**   | AI team executing the task            | Data Analysis Agent           |
| **Context** | Attached knowledge bases, files, etc. | Project docs, data files      |
| **Status**  | Conversation execution status         | PENDING → RUNNING → COMPLETED |

---

## 🚀 Creating a Conversation

### Step 1: Navigate to Chat Page

1. Click **"Chat"** in the left navigation bar
2. The system displays the conversation list and input area

### Step 2: Select an Agent

Above the input area, click the agent selector:

1. **Click the agent dropdown** - Shows available agents
2. **Select an appropriate agent**

### Step 3: Configure Conversation Options (Optional)

Configure the following options as needed:

#### Model Selection

Click the model selector to override the agent's default model:

- **Select model**: Choose from the dropdown list
- **Force override**: When enabled, uses your selected model even if the agent has a configured model

#### Code Repository (Code Type)

If you selected a Code type agent:

1. **Select repository**: Click the repository selector, choose the target repository
2. **Select branch**: Choose the branch to work on

#### Knowledge Base Context

Click the context button to add knowledge bases:

1. **Click the "#" button** - Opens the context selector
2. **Select knowledge bases** - Check the ones to add
3. **Confirm selection** - Knowledge bases appear as tags

#### File Attachments

Click the attachment button to upload files:

1. **Click the attachment icon** - Opens file selector
2. **Select files** - Supports images, documents, code files
3. **Wait for upload** - Files show previews after upload; images use a local preview first, so the sent message does not need to download the image again

Some system recommendation presets can add attachments automatically. Preset attachments are shown in the input attachment area and can be removed before sending. If you upload your own attachment, Wegent removes the attachments added by the current preset and sends only the files you uploaded.

#### Skill Selection

If the agent supports skills:

1. **Click the skill button** - Opens skill selector
2. **Select skills** - Check the needed skills
3. **Or use "/" command** - Type `/` in the input box to trigger skill selection

### Step 4: Enter Message and Send

1. **Type your message in the input box** - Describe your needs
2. **Press Enter to send** - Or click the send button
3. **Wait for response** - Agent starts processing and streams results

---

## 🖥️ Conversation Interface

### Input Area

The input area contains the following controls:

| Control                     | Function                      | Location                |
| --------------------------- | ----------------------------- | ----------------------- |
| **Agent Selector**          | Select the agent for the task | Above input box         |
| **Model Selector**          | Override default model        | Control bar             |
| **Context Button**          | Add knowledge bases           | Control bar             |
| **Attachment Button**       | Upload files                  | Control bar             |
| **Skill Button**            | Select skills                 | Control bar             |
| **Follow-up Button**        | Enable smart follow-up mode   | Control bar             |
| **Cross-Validation Button** | Enable AI cross-validation    | Control bar             |
| **Send Button**             | Send message                  | Right side of input box |

When a task is running and the composer is empty, the right-side control shows a stop icon that can stop the current response. As soon as you enter a new message, add an attachment, or add a code comment, it switches to a send icon so you can submit follow-up instructions. The message is queued or sent as guidance according to the task's current runtime state.

The composer accepts pasted multiline text and preserves clipboard line breaks. Windows-style line endings are normalized automatically.

### Message Area

The message area displays conversation history:

- **User Messages**: Your sent messages, displayed on the right
- **AI Responses**: Agent's replies, displayed on the left
  - Text content
  - Code blocks (with syntax highlighting)
  - Thinking process (if enabled)
  - Tool call indicators

### Sidebar

The left sidebar displays:

- **Conversation List**: All historical conversations
- **Search Box**: Search conversation content
- **New Chat Button**: Start a new conversation

---

## ⚡ Advanced Features

### Per-Conversation Model Selection

Select a different model for a single conversation without modifying agent configuration:

1. **Click the model selector** - In the input control bar
2. **Select a model** - From the available model list
3. **Enable force override** - Ensures the selected model is used

**Use Cases**:

- Use a more powerful model for complex tasks
- Use a faster/cheaper model for simple queries
- Test different models' effectiveness

### Smart Follow-up Mode

Enable smart follow-up mode for the agent to confirm requirements before execution:

1. **Click the follow-up icon** (💬) - In the input control bar
2. **Agent asks questions first** - Confirms your requirement details
3. **After answering questions** - Agent starts executing the task

> 📖 For detailed information, see [Smart Follow-up Mode Guide](./clarification-mode-guide.md)

### AI Cross-Validation

Enable AI cross-validation to have another AI model verify and improve responses:

1. **Click the cross-validation icon** (✓) - In the input control bar
2. **Select validation model** - Choose from the popup dialog
3. **View evaluation results** - Scores and improvement suggestions appear after agent responds
4. **Apply improvements** (optional) - Click "Apply" button to adopt the improved version

> 📖 For detailed information, see [AI Cross-Validation Guide](./correction-mode-guide.md)

### File Attachments

Upload files to provide context:

1. **Click the attachment button** (📎)
2. **Select files** - Supports multiple formats
3. **Supported formats**: Images, PDF, Word, code files
4. **Paste upload**: Directly paste images from clipboard; the sent message shows the image preview immediately

### Knowledge Base Context

Add knowledge bases to enhance agent capabilities:

1. **Click the context selector**
2. **Select knowledge bases** - Multiple selection supported
3. **Agent searches knowledge bases** - Provides more accurate answers

After you select knowledge bases and send a message, they become knowledge bindings on the current Task. Follow-up messages may continue to use those bindings even if you do not select them again. External knowledge sources, when enabled by your deployment, follow the same rule.

To stop future messages from using a knowledge base, open the task/group management panel from the top-right corner and remove the entry from the **Knowledge** tab. Removal only affects future messages. It does not delete context badges or citations already shown on historical messages.

### Skill Selection

Add additional capabilities to the agent:

1. **Click the skill button** - Opens skill selector
2. **Select skills** - Check the needed skills
3. **Or type "/" command** - Quick skill selection
4. **Skills load on-demand** - Dynamically loaded during execution

---

## 📚 Managing Task Knowledge

Regular conversations and group chats both use the top-right task/group management entry to manage knowledge bound to the current Task.

In the **Knowledge** tab:

- Built-in knowledge bases and external knowledge sources appear in one list.
- External knowledge sources show a short provider badge, such as `AP`.
- Click **Remove** to unbind a knowledge base or external knowledge source from the Task.
- Unbinding only affects future messages; historical message context remains unchanged.
- If external knowledge sources fail to load temporarily, built-in knowledge bases remain visible and removable.

The composer context selector adds knowledge to the current message. The task/group management panel is where you view and remove Task-level bindings that can be inherited by follow-up messages.

---

## ✨ Best Practices

### 1. Writing Effective Prompts

#### ✅ Be Specific and Clear

- Clearly describe your needs
- Provide necessary background information
- Specify expected output format
- Include acceptance criteria

#### ❌ Avoid Vague Requests

- Avoid overly brief descriptions
- Avoid requests lacking context
- Avoid asking too many things at once

### 2. Choosing the Right Agent

### 3. Task Granularity

**Recommended granularity**:

- Small task: Single clear objective
- Medium task: Contains a few related steps
- Large task: Split into multiple smaller tasks

### 4. Providing Sufficient Context

- Upload relevant files
- Add knowledge bases
- Reference previous conversation content
- Specify technical constraints or preferences

### 5. Leveraging Conversation History

- Continue conversations for iterative refinement
- Reference previous messages for context

---

## ⚠️ Common Issues

### Q1: Conversation stuck in PENDING status?

**Possible reasons**:

1. Agent is unavailable
2. System resources are limited
3. Repository configuration error

**Solutions**:

- Check agent status in Settings → Agents
- Verify repository access permissions
- Try selecting a different agent

### Q2: Agent response is incomplete?

**Solutions**:

- Click "Continue" to resume generation
- Select a model with larger context window
- Split complex tasks into smaller parts

### Q3: How to stop a running conversation?

**Method**:

1. Click the "Stop" button in the input area
2. Agent stops processing
3. You can continue the conversation or start a new task

### Q4: How to retry a failed conversation?

**Method**:

1. Click the "Retry" button on the failed message
2. Optionally modify the message before retrying
3. Agent will attempt the task again

### Q5: How to share a conversation?

**Method**:

1. Click the share button in the message area
2. Copy the generated link
3. Share with team members (requires access permissions)

### Q6: How to export conversation history?

**Method**:

1. Click the export button in the task menu
2. Choose export format (Markdown, JSON)
3. Download the conversation history

---

## 🔗 Related Resources

### Prerequisites

- [Agent Settings](../settings/agent-settings.md) - Configure agents and bots
- [Configuring Models](../settings/configuring-models.md) - Set up AI models
- [Configuring Shells](../settings/configuring-shells.md) - Configure execution environments

### Reference Documentation

- [Core Concepts](../../concepts/core-concepts.md) - Understand Wegent concepts
- [Collaboration Models](../../concepts/collaboration-models.md) - Multi-agent collaboration

### Detailed Feature Documentation

For more details on advanced features, see:

- [Smart Follow-up Mode Guide](./clarification-mode-guide.md) - Let agent confirm requirements before execution
- [AI Cross-Validation Guide](./correction-mode-guide.md) - Use another model to verify and improve responses
- [IM Channel Integration](./im-channel-integration.md) - Integrate enterprise IM

---

## 💬 Get Help

Need assistance?

- 📖 Check [FAQ](../../faq.md)
- 🐛 Submit [GitHub Issue](https://github.com/AntGroup/Wegent/issues)
- 💬 Join community discussions

---

<p align="center">Start your first conversation and let AI agents work for you! 🚀</p>
