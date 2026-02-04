# 🎯 Managing Tasks

Task is an executable work unit in Wegent that assigns user requirements to Agents for execution. This guide will teach you how to create, manage, and monitor tasks through the web interface.

---

## 📋 Table of Contents

- [What is a Task](#-what-is-a-task)
- [Core Concepts](#-core-concepts)
- [Creating Tasks](#-creating-tasks)
- [Task Interface](#-task-interface)
- [Task Lifecycle](#-task-lifecycle)
- [Advanced Features](#-advanced-features)
- [Best Practices](#-best-practices)
- [Common Issues](#-common-issues)
- [Related Resources](#-related-resources)

---

## 🎯 What is a Task

Task is the bridge between user requirements and AI agents, defining "what to do" and "who does it".

**Analogy**:
```
Real World                →  Wegent
-------------------      →  -------------------
Work order               →  Task
Assign to team           →  Agent selection
Execute in project       →  Workspace (repository)
Task description         →  Your message/prompt
```

### Task Composition

```
Task = Your Message + Agent + Workspace (optional) + Conversation History
```

---

## 🧩 Core Concepts

### Four Elements of Task

| Element | Description | Example |
|---------|-------------|---------|
| **Message** | Task description and requirements | "Implement user login feature" |
| **Agent** | AI agent executing the task | fullstack-dev-agent |
| **Workspace** | Working environment and code repository | github.com/user/repo |
| **Status** | Task execution status | PENDING → RUNNING → COMPLETED |

### Task Types

Wegent supports different task types based on your needs:

| Type | Description | Use Case |
|------|-------------|----------|
| **Chat** | General conversation | Q&A, brainstorming, writing |
| **Code** | Code-related tasks | Development, debugging, code review |
| **Knowledge** | Knowledge base queries | Document search, RAG-based Q&A |

---

## 🚀 Creating Tasks

### Method 1: Start a New Chat

The simplest way to create a task is through the chat interface:

1. **Navigate to Chat Page**
   - Click "Chat" in the left sidebar
   - Or use keyboard shortcut to start new chat

2. **Select an Agent**
   - Click the agent selector dropdown
   - Choose an appropriate agent for your task
   - Agents are filtered by task type (Chat/Code/Knowledge)

3. **Type Your Message**
   - Enter your task description in the input box
   - Be specific about what you want to accomplish
   - Include relevant context and requirements

4. **Send Message**
   - Press Enter or click the send button
   - The task will be created and execution begins

### Method 2: Code Mode

For development tasks:

1. **Navigate to Code Page**
   - Click "Code" in the left sidebar

2. **Select Repository** (if required)
   - Choose the target repository from the dropdown
   - Select the branch to work on

3. **Select Agent**
   - Choose a code-capable agent
   - Agents with `ClaudeCode` or `Agno` executor are recommended

4. **Describe Your Task**
   - Explain the feature, bug fix, or refactoring needed
   - Reference specific files or functions if applicable

### Method 3: Knowledge Mode

For knowledge base queries:

1. **Navigate to Knowledge Page**
   - Click "Knowledge" in the left sidebar

2. **Select Knowledge Base**
   - Choose the knowledge base to query
   - Optionally select specific documents

3. **Ask Your Question**
   - Type your question about the documents
   - The agent will search and synthesize answers

---

## 🖥️ Task Interface

### Chat Input Area

The chat input area provides several controls:

| Control | Description |
|---------|-------------|
| **Agent Selector** | Choose which agent handles the task |
| **Model Selector** | Override the default model (optional) |
| **Repository Selector** | Select workspace for code tasks |
| **Deep Thinking Toggle** | Enable extended reasoning mode |
| **Attachment Button** | Upload files or images |
| **Context Selector** | Add knowledge bases or tables |

### Message Area

The message area displays:

- **Your Messages**: Your input and requests
- **Agent Responses**: AI-generated responses with:
  - Text content
  - Code blocks with syntax highlighting
  - Thinking process (if enabled)
  - Tool usage indicators
  - File changes (for code tasks)

### Task Sidebar

The left sidebar shows:

- **Task List**: All your conversations/tasks
- **Search**: Find tasks by content
- **Filters**: Filter by status, date, or agent
- **New Chat Button**: Start a new task

---

## 🔄 Task Lifecycle

### Status Flow

```
1. PENDING (created, waiting to start)
   ↓
2. RUNNING (agent is working)
   ↓
3. COMPLETED (success)
   or
   FAILED (error occurred)
   or
   CANCELLED (user cancelled)
```

### Status Indicators

| Status | Icon | Description |
|--------|------|-------------|
| PENDING | ⏳ | Task queued, waiting for resources |
| RUNNING | 🔄 | Agent is actively working |
| COMPLETED | ✅ | Task finished successfully |
| FAILED | ❌ | Task encountered an error |
| CANCELLED | 🚫 | Task was cancelled by user |

### Real-time Updates

- **Streaming Responses**: See agent output in real-time
- **Progress Indicators**: Track multi-step task progress
- **Pipeline Stages**: View current stage in pipeline mode

---

## ⚡ Advanced Features

### Per-Task Model Selection

Override the agent's default model for specific tasks:

1. Click the model selector in the input area
2. Choose a different model from the dropdown
3. Enable "Force Override" if the agent has a predefined model

**Use Cases**:
- Use a more powerful model for complex tasks
- Use a faster/cheaper model for simple queries
- Test different models without changing agent config

### Deep Thinking Mode

Enable extended reasoning for complex problems:

1. Click the brain icon (🧠) in the input controls
2. The agent will show its thinking process
3. Useful for debugging, analysis, and complex reasoning

### Attachments

Upload files to provide context:

1. Click the attachment button (📎)
2. Select files from your computer
3. Supported formats: images, documents, code files
4. Files are processed and included in the context

### Context Injection

Add knowledge bases or data tables:

1. Click the context selector
2. Choose knowledge bases or tables
3. The agent will use this information when responding

### Web Search

Enable web search for up-to-date information:

1. Click the globe icon (🌐)
2. Select your preferred search engine
3. The agent can search the web during task execution

### Skill Selection

Add additional capabilities to the agent:

1. Click the skills button
2. Select from available skills
3. Skills are loaded on-demand during execution

---

## ✨ Best Practices

### 1. Writing Effective Prompts

#### ✅ Be Specific and Clear

**Good example**:
```
Implement user registration API:
- POST /api/auth/register
- Accept email, password, username
- Validate email format and password strength
- Save user to database
- Return user info and Token
- Write unit tests (coverage >80%)
- Update API documentation
```

**Bad example**:
```
Make a registration feature
```

### 2. Choosing the Right Agent

| Task Type | Recommended Agent |
|-----------|-------------------|
| Full-stack development | Agent with ClaudeCode executor |
| Simple Q&A | Agent with Chat executor |
| Code review | Agent with code analysis skills |
| Documentation | Agent with writing capabilities |

### 3. Task Granularity

**Recommended granularity**:
- Small task: 1-2 hours of work
- Medium task: 4-8 hours of work
- Large task: Split into multiple smaller tasks

**Good**:
- "Implement user login page"
- "Fix login redirect issue"

**Too large**:
- "Develop entire user management system"

### 4. Providing Context

Include relevant information:
- Background and requirements
- Related code files or documentation
- Technical constraints
- Acceptance criteria

### 5. Using Conversation History

- Continue conversations for iterative refinement
- Reference previous messages for context
- Use "regenerate" to get alternative responses

---

## ⚠️ Common Issues

### Q1: Task stuck in PENDING status?

**Possible reasons**:
1. Agent is unavailable
2. System resources are limited
3. Workspace configuration error

**Solutions**:
- Check agent status in Settings → Agents
- Verify workspace/repository access
- Try selecting a different agent

### Q2: Agent response is incomplete?

**Solutions**:
- Click "Continue" to resume generation
- Increase context window by selecting a larger model
- Split complex tasks into smaller parts

### Q3: How to cancel a running task?

**Method**:
1. Click the "Stop" button in the input area
2. The agent will stop processing
3. You can continue the conversation or start a new task

### Q4: How to retry a failed task?

**Method**:
1. Click the "Retry" button on the failed message
2. Optionally modify your message before retrying
3. The agent will attempt the task again

### Q5: How to share a task/conversation?

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
- [Agent Settings](./agent-settings.md) - Configure agents and bots
- [Configuring Models](./configuring-models.md) - Set up AI models
- [Configuring Shells](./configuring-shells.md) - Configure execution environments

### Reference Documentation
- [Core Concepts](../../concepts/core-concepts.md) - Understand Wegent concepts
- [Collaboration Models](../../concepts/collaboration-models.md) - Multi-agent collaboration

---

## 💬 Get Help

Need assistance?

- 📖 Check [FAQ](../../faq.md)
- 🐛 Submit [GitHub Issue](https://github.com/AntGroup/Wegent/issues)
- 💬 Join community discussions

---

<p align="center">Start your first task and let AI agents work for you! 🚀</p>
