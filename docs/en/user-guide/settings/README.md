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
| [Configuring Shells](./configuring-shells.md) | Configure runtime environments (ClaudeCode, Dify, Chat) |
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
- **Coordinate**: Leader coordinates parallel execution and aggregates results

The web UI currently offers Solo, Pipeline, and Coordinate for new or edited agents.

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
| **Dify** | External Dify API proxy | Dify workflow integration |
| **Chat** | Direct LLM API (no Docker) | Lightweight conversations |

### Skills Management

Skills are Claude Code capability extension packages:

- **Upload Skills**: Package as ZIP file and upload
- **Manage Skills**: View, download, update, delete
- **Use Skills**: Reference Skills in Bots

### Weibo Account Binding

In intranet deployments, users can bind the current Wegent account to a Weibo uid. When users visit `https://wegent.intra.weibo.com` and are already logged in to `weibo.com`, the browser carries the Weibo login cookie (`SUB`). From **Settings** → **General**, the Weibo account binding action sends the request to the backend, which reads `SUB` and calls the internal resolver service to obtain the Weibo uid, nickname, and avatar.

The frontend first shows the resolved Weibo account profile and reminds users that they can switch accounts at `weibo.com`. Binding is written only after the user confirms. During confirmation, the backend resolves the current `SUB` again; if the uid changed, the user must confirm again. After binding succeeds, the page shows the bound Weibo uid, nickname, avatar, and binding time. Users can rebind to refresh the uid or unbind the account. Binding data is stored in the current user's preferences and does not require a separate database table. Unbinding only removes the Weibo binding data and keeps other preferences unchanged.

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
