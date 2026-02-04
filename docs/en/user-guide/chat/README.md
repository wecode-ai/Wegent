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

| Mode | Description | Use Case |
|------|-------------|----------|
| **Clarification** | AI asks questions to clarify requirements | Complex tasks with unclear requirements |
| **Correction** | AI suggests modifications | Code review, document optimization |
| **Direct Execution** | AI executes tasks immediately | Simple tasks with clear requirements |

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

---

## 📖 Documentation Navigation

| Document | Description |
|----------|-------------|
| [Managing Tasks](./managing-tasks.md) | Creating and managing chat tasks |
| [Clarification Mode](./clarification-mode-guide.md) | Using clarification mode to clarify requirements |
| [Correction Mode](./correction-mode-guide.md) | Using correction mode to optimize results |

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
