---
sidebar_position: 1
slug: /wegent
---

# Wegent documentation

Wegent is an AI-native platform for defining, organizing, and running agent teams. These guides cover deployment, agent configuration, task management, knowledge, integrations, and platform development.

For the desktop AI workbench and local projects, open the [Wework documentation](/wework).

---

## 📖 Table of Contents

### 🚀 Getting Started

Your first steps with Wegent:

- [Quick Start](./getting-started/quick-start.md) - Get up and running in 5 minutes
- [Installation Guide](./getting-started/installation.md) - Complete installation and configuration

### 🧠 Core Concepts

Deep dive into Wegent's design:

- [Architecture Overview](./developer-guide/architecture.md) - Wegent's overall architecture and tech stack
- [Core Concepts](./concepts/core-concepts.md) - Detailed explanation of Ghost, Bot, Team, Workspace, and more
- [Collaboration Models](./concepts/collaboration-models.md) - Four collaboration patterns: Pipeline, Route, Coordinate, and Collaborate

### 📖 Guides

#### 👤 User Guides

Guides for Wegent platform users:

- [Agent Settings](./user-guide/settings/agent-settings.md) - Configure agents, bots, prompts, and collaboration modes
- [Managing Tasks](./user-guide/chat/managing-tasks.md) - Create and manage work tasks
- [Configuring Models](./user-guide/settings/configuring-models.md) - Set up AI models (LLM, Embedding, Rerank)
- [Configuring Shells](./user-guide/settings/configuring-shells.md) - Configure execution environments
- [Managing Skills](./user-guide/settings/managing-skills.md) - Upload and use Claude Code Skills
- [Spec Clarification Mode](./user-guide/chat/clarification-mode-guide.md) - Interactive requirement specification clarification guide
- [Knowledge Base Guide](./user-guide/knowledge/knowledge-base-guide.md) - RAG-based knowledge base system usage
- [IM Channel Integration](./user-guide/integrations/im-channel-integration.md) - Integrate DingTalk and other IM channels
- [Local Device Support](./user-guide/ai-devices/local-device-support.md) - Use personal computers as task executors

#### 💻 Developer Guides

Technical documentation for Wegent developers:

- [Development Setup](./developer-guide/setup.md) - Local development environment configuration
- [Testing](./developer-guide/testing.md) - Unit and integration testing
- [Database Migrations](./developer-guide/database-migrations.md) - Alembic database migration management

### 📋 Reference

Detailed technical references:

- [YAML Specification](./reference/yaml-specification.md) - Complete YAML configuration format

### 📝 Configuration Examples

- [Team Configuration Example](../examples/team-example.yaml) - Complete Team YAML configuration example

### 🤝 Contributing

- [Contribution Guide](../../../CONTRIBUTING.md) - How to participate in Wegent project contributions

### 🔧 Help & Support

- [FAQ](./faq.md) - Frequently asked questions
- [Troubleshooting](./troubleshooting.md) - Problem diagnosis and solutions

---

## 🌟 Key Features at a Glance

### 🎨 Configuration-Driven Agent Teams
Define and run personalized agent teams through YAML configuration with web UI - no secondary development required.

### ⚙️ Multi-Engine Architecture
Built on Chat, Claude Code, and Dify execution paths, supporting dialogue, coding, and workflow modes.

### 🔒 Isolated Sandbox Environments
Each agent team runs in an independent sandbox, enabling multiple teams to execute simultaneously.

### 🤝 Advanced Collaboration Modes
Agent teams support solo, pipeline, and coordination patterns for complex workflows.

### 💻 AI Coding Integration
Coding mode integrates with GitHub/GitLab and other code services to implement AI-driven development and code review workflows.

---

## 🔗 Related Links

- [中文文档](../zh/README.md) - Chinese Documentation
- [GitHub Repository](https://github.com/wecode-ai/wegent) - Source code repository
- [GitHub Issues](https://github.com/wecode-ai/wegent/issues) - Issue tracker

---

## 💡 Documentation Conventions

Icon meanings used throughout this documentation:

- 📘 Basic content
- 🔧 Practical operations
- ⚠️ Important notes
- 💡 Best practices
- 📝 Code examples
- 🚀 Advanced topics

---

<p align="center">Made with ❤️ by WeCode-AI Team</p>
