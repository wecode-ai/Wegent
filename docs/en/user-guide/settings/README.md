---
sidebar_position: 1
---

# ⚙️ Settings

The Settings module provides configuration functionality for the Wegent system, including management of Agents, Models, Shells, and Skills.

---

## 📋 Documentation in This Module

| Document | Description |
|----------|-------------|
| [Agent Settings](./agent-settings.md) | Configure Agents, Bots, prompts, and collaboration modes |
| [Configuring Models](./configuring-models.md) | Configure AI models (Anthropic Claude, OpenAI GPT, etc.) |
| [Configuring Shells](./configuring-shells.md) | Configure runtime environments (ClaudeCode, Agno, Dify) |
| [Managing Skills](./managing-skills.md) | Upload, manage, and use Skill capability extension packages |

---

## 🎯 Core Configuration

### Agent Settings

Configure the core components of AI Agents:

```
Agent (Team) = Bot(s) + Collaboration Mode
Bot = Shell + Model + Prompt + MCP Tools + Skills
```

**Collaboration Modes**:
- **Solo**: Single bot working independently
- **Pipeline**: Sequential execution, forming a processing pipeline
- **Route**: Leader routes content to appropriate experts
- **Coordinate**: Leader coordinates parallel execution and aggregates results
- **Collaborate**: All members freely discuss and share context

### Model Configuration

Supports multiple AI model providers:

| Provider | Supported Models |
|----------|-----------------|
| **Anthropic** | Claude Haiku 4, Claude Sonnet 4, Claude Opus |
| **OpenAI** | GPT-4, GPT-4 Turbo, GPT-3.5 Turbo |

### Shell Configuration

Supports multiple runtime environments:

| Shell | Description | Use Case |
|-------|-------------|----------|
| **ClaudeCode** | Claude Code SDK, supports code execution and file operations | Code development, file processing |
| **Agno** | Agno framework, supports multiple collaboration modes | Conversations, multi-agent collaboration |
| **Dify** | External Dify API proxy | Dify workflow integration |
| **Chat** | Direct LLM API (no Docker) | Lightweight conversations |

### Skills Management

Skills are Claude Code capability extension packages:

- **Upload Skills**: Package as ZIP file and upload
- **Manage Skills**: View, download, update, delete
- **Use Skills**: Reference Skills in Bots

---

## 🚀 Configuration Workflow

Recommended configuration order:

1. **Configure Models** → Set up AI models and API keys
2. **Configure Shells** → Select runtime environment
3. **Upload Skills** → Add capability extensions (optional)
4. **Create Bots** → Combine models, shells, and prompts
5. **Create Agents** → Combine bots and collaboration modes

---

## 🔗 Related Resources

- [Chat](../chat/README.md) - Use configured agents for conversations
- [Knowledge Base](../knowledge/README.md) - Configure knowledge base retrieval
- [Core Concepts](../../concepts/core-concepts.md) - Understand Wegent architecture
- [YAML Specification](../../reference/yaml-specification.md) - Complete configuration format
