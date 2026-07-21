---
sidebar_position: 1
---

# ⚙️ Settings

The Settings module provides configuration functionality for the Wegent system, including management of Agents, Models, Shells, and Skills.

---

## 📋 Documentation in This Module

| Document                                                | Description                                                    |
| ------------------------------------------------------- | -------------------------------------------------------------- |
| [Agent Settings](./agent-settings.md)                   | Configure Agents, Bots, prompts, and collaboration modes       |
| [Configuring Models](./configuring-models.md)           | Configure AI models (Anthropic Claude, OpenAI GPT, etc.)       |
| [Configuring Shells](./configuring-shells.md)           | Configure runtime environments (ClaudeCode, Dify, Chat)        |
| [Managing Skills](./managing-skills.md)                 | Upload, manage, and use Skill capability extension packages    |
| [Keyboard Shortcuts](./keyboard-shortcuts.md)           | Manage local shortcuts for the Wework desktop app              |
| [Desktop App Preferences](./desktop-app-preferences.md) | Configure Wework desktop launch, background, and tray behavior |
| [Browser settings](./browser-settings.md)               | Configure built-in browser links, privacy, and downloads       |

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

| Provider      | Supported Models                             |
| ------------- | -------------------------------------------- |
| **Anthropic** | Claude Haiku 4, Claude Sonnet 4, Claude Opus |
| **OpenAI**    | GPT-4, GPT-4 Turbo, GPT-3.5 Turbo            |

### Shell Configuration

Supports multiple runtime environments:

| Shell          | Description                                                  | Use Case                          |
| -------------- | ------------------------------------------------------------ | --------------------------------- |
| **ClaudeCode** | Claude Code SDK, supports code execution and file operations | Code development, file processing |
| **Dify**       | External Dify API proxy                                      | Dify workflow integration         |
| **Chat**       | Direct LLM API (no Docker)                                   | Lightweight conversations         |

### Skills Management

Skills are Claude Code capability extension packages:

- **Upload Skills**: Package as ZIP file and upload
- **Manage Skills**: View, download, update, delete
- **Use Skills**: Reference Skills in Bots

### Archived Chat Management

Desktop Wework settings can show archived Project and Conversation chats. Deleting one archived chat or using **Delete all** first opens a confirmation dialog; the app only permanently deletes the selected local runtime conversation records after confirmation. Bulk deletion applies only to the items currently listed as archived and does not affect non-archived chats.

### Desktop App Preferences

Desktop Wework's **General** settings control the interface language, whether the main window is shown after launch, and whether the app keeps running after the main window is closed. When background running is enabled, closing the main window releases the main WebView resources without stopping running tasks. Users can click the system tray icon to reopen the main window.

Desktop Wework's **Integrations → Appshots** settings show macOS Appshots status and sound preference. The default `⌘⇧2` shortcut captures the frontmost application window and adds the PNG snapshot to the current Wework composer.

### Wework Context Settings

In desktop Wework, the left settings menu groups **General**, **Cloud connection**, **Appearance**, **Context**, **Models**, **Proxy**, **Keyboard shortcuts**, and **About** under **Personal**. On mobile, the settings home keeps a **Personal** entry; opening it provides General, Appearance, Context, Models, and About.

Use **Settings → Personal → Context** to configure two local context behaviors:

- **Terminal context injection**: Controls whether new tasks automatically include the current terminal context.
- **Wework custom instructions**: Saves local Wework instruction text and affects newly started tasks. Saving an empty value removes the local instruction configuration.

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
