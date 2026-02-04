---
sidebar_position: 1
---

# Overview

Welcome to the AI Coding guide! This section covers how to use Wegent's AI-powered coding features to automate software development tasks.

---

## Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [Getting Started](#getting-started)
- [Documentation](#documentation)
- [Best Practices](#best-practices)

---

## Overview

AI Coding is Wegent's core feature that enables AI agents to write, modify, and manage code in your Git repositories. Unlike simple chat interactions, AI Coding tasks connect to your code repositories and can make real changes through commits and pull requests.

**Core Concept**:
```
Code Task = User Prompt + Code Agent + Git Repository + Workbench
```

### How It Works

1. **Select a Code Agent**: Choose an agent configured with a Code-type Shell (e.g., ClaudeCode)
2. **Connect Repository**: Link your GitHub or GitLab repository
3. **Describe Your Task**: Provide a clear description of what you want to accomplish
4. **AI Executes**: The agent clones your repo, makes changes, and commits them
5. **Review Results**: Use the Workbench to review changes, diffs, and create PRs

---

## Key Features

### Git Integration
- **GitHub & GitLab Support**: Connect to your repositories with OAuth or personal access tokens
- **Branch Management**: AI creates feature branches for each task
- **Commit History**: Track all changes made by the AI with detailed commit messages
- **Pull Request Creation**: Easily create PRs from completed tasks

### Workbench Panel
The Workbench is a dedicated panel that provides real-time visibility into your coding task:

| Tab | Description |
|-----|-------------|
| **Overview** | Task status, repository info, execution timeline, and summary |
| **Files Changed** | View all modified files with syntax-highlighted diffs |
| **Preview** | Live preview for web applications (when available) |

### Execution Timeline
Watch the AI's thought process in real-time:
- **Tool Usage**: See which tools the AI is using (Read, Edit, Write, Bash, etc.)
- **Progress Tracking**: Monitor task progress with visual indicators
- **Thinking Process**: Understand the AI's decision-making

### Code Review Features
- **Diff Viewer**: Side-by-side or unified diff view for all changes
- **File Statistics**: Lines added/removed per file
- **Commit Details**: View individual commits with author and timestamp

---

## Getting Started

### Prerequisites

Before using AI Coding, ensure you have:

1. **Git Token Configured**: Set up your GitHub or GitLab access token in Settings
2. **Code Agent Available**: Have at least one agent with a Code-type Shell
3. **Repository Access**: Ensure your token has access to the target repository

### Quick Start

1. **Navigate to Code Page**: Click "Code" in the left navigation
2. **Select an Agent**: Choose a code-capable agent from the dropdown
3. **Select Repository**: Pick your target repository and branch
4. **Enter Your Task**: Describe what you want the AI to do
5. **Send and Monitor**: Submit the task and watch progress in the Workbench

### Example Tasks

Here are some example prompts to get you started:

```
Add a user authentication feature with JWT tokens
```

```
Refactor the database module to use connection pooling
```

```
Fix the bug in the payment processing where duplicate charges occur
```

```
Add unit tests for the UserService class with at least 80% coverage
```

---

## Documentation

| Document | Description |
|----------|-------------|
| [Managing Code Tasks](./managing-code-tasks.md) | Create, execute, and manage coding tasks |
| [Spec Clarification](./spec-clarification-guide.md) | Refine vague requirements into clear tasks |

---

## Best Practices

### 1. Write Clear Prompts

**✅ Good Prompt**:
```
Add a REST API endpoint POST /api/users that:
- Accepts JSON body with name, email, and password
- Validates email format and password strength
- Returns 201 with user ID on success
- Returns 400 with validation errors on failure
```

**❌ Vague Prompt**:
```
Add user creation
```

### 2. Use Spec Clarification for Complex Tasks

For complex or ambiguous requirements, use the [Spec Clarification](./spec-clarification-guide.md) feature to refine your requirements through interactive Q&A before starting the coding task.

### 3. Review Changes Before Merging

Always review the AI's changes in the Workbench:
- Check the diff for each modified file
- Verify the commit messages are accurate
- Test the changes locally if needed
- Create a PR for team review

### 4. Break Down Large Tasks

Instead of one massive task, break it into smaller, focused tasks:

**Instead of**:
```
Build a complete e-commerce system
```

**Do this**:
```
Task 1: Create product catalog API endpoints
Task 2: Implement shopping cart functionality
Task 3: Add checkout and payment processing
Task 4: Build order management system
```

### 5. Provide Context

Include relevant context in your prompts:
- Reference existing code patterns
- Mention specific files or modules
- Specify coding standards or conventions
- Include acceptance criteria

---

## Related Resources

- [Agent Settings](../settings/agent-settings.md) - Configure code agents
- [Configuring Models](../settings/configuring-models.md) - Set up AI models
- [Configuring Shells](../settings/configuring-shells.md) - Configure execution environments
- [Core Concepts](../../concepts/core-concepts.md) - Understand Wegent architecture

---

## Get Help

Need assistance?

- 📖 Check [FAQ](../../faq.md)
- 🐛 Submit [GitHub Issue](https://github.com/AntGroup/Wegent/issues)
- 💬 Join community discussions

---

<p align="center">Start coding with AI and boost your productivity! 🚀</p>
