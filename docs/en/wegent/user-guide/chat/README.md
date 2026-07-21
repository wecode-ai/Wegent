---
sidebar_position: 1
---

# Overview

Chat is Wegent's core interaction feature that allows you to have real-time conversations with AI agents to complete various tasks.

<img src="https://github.com/user-attachments/assets/677abce3-bd3f-4064-bdab-e247b142c22f" width="100%" alt="Chat Mode Demo"/>

---

## 📋 Core Concepts

### Chat Tasks

A **Chat Task** is the basic unit of the Chat feature. Every interaction with AI creates a task:

- **Single-turn**: Simple one-time Q&A
- **Multi-turn**: Continuous contextual conversation
- **Code Task**: Programming tasks related to code repositories

### Chat Modes

Wegent provides multiple conversation modes for different scenarios:

| Mode                    | Description                               | Use Case                                |
| ----------------------- | ----------------------------------------- | --------------------------------------- |
| **Smart Follow-up**     | AI asks questions to clarify requirements | Complex tasks with unclear requirements |
| **AI Cross-Validation** | AI suggests modifications                 | Code review, document optimization      |
| **Direct Execution**    | AI executes tasks immediately             | Simple tasks with clear requirements    |

---

## 🎯 Main Features

### 1. Task Management

Centralized management of all chat tasks:

- View conversation history list
- Filter by status (in progress, completed, failed)
- Search and archive tasks
- Export conversation records

### 2. Multi-Agent Collaboration

Support for various collaboration methods:

- **Single Agent**: One-on-one conversation with one agent
- **Group Chat**: Multiple agents participating in discussions
- **Team Mode**: Agents collaborate with assigned roles

### 3. Code Tasks

Enhanced features designed for programming:

- Automatic code repository cloning
- Agents read and analyze code
- Execute code modifications and commits
- Real-time execution monitoring

### 4. Conversation Control

Flexible conversation control options:

- Pause/resume conversation
- Regenerate responses
- Modify context
- Switch agents

### 5. Runtime Model Switching

After a task has started, you can adjust the model used for later responses in the current task. The change only affects the current task. It does not modify the agent, bot, or model defaults, and it does not affect other tasks or newly created conversations.

To keep the runtime protocol consistent, WeWork limits model switching for already running tasks to the same runtime model family in the model selector. Wegent derives the API response field `runtime.family` from the combination of the model CRD's `modelConfig.env.model` and `spec.protocol` values:

- The current task model and the target model must have the same `runtime.family` value
- For example, Claude, Kimi, or DeepSeek-compatible models whose `runtime.family` is `claude.claude` can be switched between each other
- Models with the same `env.model` but different `spec.protocol` values are treated as different runtime families
- Models without `runtime.family` stay visible for an already running task, but are disabled

Models with a different `runtime.family` value remain visible, but are disabled in the selector.

---

## 📖 Documentation Navigation

| Document                                              | Description                                        |
| ----------------------------------------------------- | -------------------------------------------------- |
| [Managing Tasks](./managing-tasks.md)                 | Creating and managing chat tasks                   |
| [Smart Follow-up Mode](./clarification-mode-guide.md) | Using smart follow-up mode to clarify requirements |
| [AI Cross-Validation](./correction-mode-guide.md)     | Using AI cross-validation to optimize results      |

---

## 🚀 Quick Start

### Create Your First Conversation

1. Navigate to the **Chat** page
2. Click **New Conversation**
3. Select an agent or agent team
4. Enter your question or task description
5. Wait for AI response

### Create a Code Task

1. Click **New Task**
2. Select a programming-type agent
3. Select a code repository
4. Describe the task to complete
5. AI will automatically clone the repository and start working

---

## 💡 Use Cases

### Programming Assistance

- **Code Review**: Have AI check code quality and potential issues
- **Bug Fixing**: Describe the problem, let AI locate and fix it
- **Feature Development**: Describe requirements, let AI implement new features
- **Code Explanation**: Have AI explain complex code logic

### Content Creation

- **Documentation Writing**: Have AI help write technical documents
- **Content Polishing**: Optimize existing content expression
- **Translation Services**: Multi-language content translation

### Knowledge Q&A

- **Technical Consulting**: Ask technical questions and best practices
- **Concept Explanation**: Understand complex technical concepts
- **Solution Design**: Discuss system architecture and design solutions

---

## 🔗 Related Resources

- [Agent Settings](../settings/agent-settings.md) - Configure agents
- [Configuring Models](../settings/configuring-models.md) - Set up AI models
- [Feed Overview](../feed/README.md) - Automated task execution
