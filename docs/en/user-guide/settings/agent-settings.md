---
sidebar_position: 1
---

# Agent Settings Guide

This guide covers everything you need to configure AI agents in Wegent through the Web interface. An Agent combines Bots, collaboration modes, and AI models to accomplish tasks.

---

## 📋 Table of Contents

- [Overview](#-overview)
- [Accessing Agent Settings](#-accessing-agent-settings)
- [Creating an Agent](#-creating-an-agent)
- [Configuring Bots](#-configuring-bots)
- [Collaboration Modes](#-collaboration-modes)
- [Model Configuration](#-model-configuration)
- [MCP Tools & Skills](#-mcp-tools--skills)
- [Best Practices](#-best-practices)
- [FAQ](#-faq)

---

## 🎯 Overview

### What is an Agent?

An **Agent** is your AI assistant in Wegent. It can:
- Execute development tasks
- Answer questions
- Review code
- Generate documentation
- And much more...

### Architecture

```
Agent = Bot(s) + Collaboration Mode

Bot = Executor + Model + Prompt + Tools
```

| Component | Description | Example |
|-----------|-------------|---------|
| **Agent** | User-facing AI assistant | "Code Assistant" |
| **Bot** | Building block of an Agent | "Frontend Developer Bot" |
| **Executor** | Runtime environment | ClaudeCode, Agno, Chat |
| **Model** | AI brain | Claude Sonnet 4, GPT-4o |
| **Prompt** | Personality & expertise | System instructions |
| **Tools** | External capabilities | GitHub MCP, Skills |

---

## ⚙️ Accessing Agent Settings

### Via Web Interface

1. Log in to Wegent
2. Click **Settings** in the sidebar
3. You'll see these tabs:

| Tab | Description |
|-----|-------------|
| **Team** | Manage your agents |
| **Bot** | Manage individual bots |
| **Models** | Configure AI models |
| **Shells** | Custom executors |
| **Skills** | Claude Code skills |
| **Integrations** | Git tokens |

### Quick Access

- From the chat interface, click the **gear icon** next to the agent selector
- Or click **Manage** in the agent dropdown

---

## 🚀 Creating an Agent

### Step 1: Open Creation Dialog

1. Go to **Settings** → **Team** tab
2. Click **New Team** button

### Step 2: Basic Information

| Field | Required | Description |
|-------|----------|-------------|
| **Name** | Yes | Agent name (e.g., "Code Assistant") |
| **Description** | No | What this agent does |
| **Icon** | No | Visual identifier |
| **Bind Mode** | Yes | Where agent appears (Chat/Code) |
| **Requires Repository** | No | Need code repo to work? |

#### Bind Mode Options

| Mode | Description |
|------|-------------|
| **Chat** | Appears in Chat mode for conversations |
| **Code** | Appears in Code mode for development |
| **Both** | Available in both modes |

### Step 3: Select Collaboration Mode

Choose how your agent works:

| Mode | Bots | Best For |
|------|------|----------|
| **Solo** | 1 | Simple tasks, beginners |
| **Pipeline** | 2+ | Sequential workflows |
| **Route** | 2+ | Task classification |
| **Coordinate** | 2+ | Parallel analysis |
| **Collaborate** | 2+ | Free discussion |

**Recommendation**: Start with **Solo** mode for simplicity.

### Step 4: Configure Bot

For **Solo** mode, configure the bot directly:

1. **Name**: Bot identifier
2. **Executor**: Select runtime (ClaudeCode, Agno, Chat, Dify)
3. **Bind Model**: Select AI model
4. **Prompt**: Define personality and expertise
5. **MCP Config**: Add external tools (optional)
6. **Skills**: Add capabilities (optional)

For **other modes**, select existing bots or create new ones.

### Step 5: Save

Click **Save** to create your agent. It will appear in your agent list.

---

## 🤖 Configuring Bots

### Bot Components

| Component | Required | Description |
|-----------|----------|-------------|
| **Name** | Yes | Unique identifier |
| **Executor** | Yes | Runtime environment |
| **Model** | No | AI model (can inherit) |
| **Prompt** | No | System instructions |
| **MCP Config** | No | External tools |
| **Skills** | No | Claude Code skills |

### Executor Types

| Executor | Description | Use Case |
|----------|-------------|----------|
| **ClaudeCode** | Claude Code SDK in Docker | Code development |
| **Agno** | Agno framework in Docker | Multi-model tasks |
| **Chat** | Direct LLM API | Simple conversations |
| **Dify** | External Dify API | Dify workflows |

### Writing Effective Prompts

**Structure**:

```
You are a [role], skilled in [expertise].

Your responsibilities:
- [Task 1]
- [Task 2]

Working principles:
- [Guideline 1]
- [Guideline 2]
```

**Example**:

```
You are a senior frontend engineer, skilled in:
- React 18+ and TypeScript
- Tailwind CSS
- Performance optimization

Your responsibilities:
- Develop high-quality UI components
- Write clean, maintainable code
- Follow React best practices

Working principles:
- Use functional components and Hooks
- Write TypeScript types for all components
- Focus on user experience
```

### Managing Bots

1. Go to **Settings** → **Bot** tab
2. View all your bots
3. Click **Edit** to modify, **Delete** to remove
4. Click **New Bot** to create standalone bots

---

## 🤝 Collaboration Modes

### Solo Mode

Single bot handles everything.

```
User → Bot → Result
```

**Best for**: Simple tasks, getting started

### Pipeline Mode

Bots execute sequentially.

```
Bot A → Bot B → Bot C → Result
```

**Best for**: Development → Review → Testing workflows

**Configuration**:
1. Select **Leader** bot (first in pipeline)
2. Add **Member** bots in order
3. Optionally enable **Require Confirmation** between stages

### Route Mode

Leader routes tasks to specialists.

```
            → Frontend Bot
User → Leader
            → Backend Bot
```

**Best for**: Multi-domain support, task classification

### Coordinate Mode

Leader coordinates parallel work.

```
        → Bot A (parallel)
Leader → Bot B (parallel) → Aggregate
        → Bot C (parallel)
```

**Best for**: Multi-perspective analysis

### Collaborate Mode

All bots share context and discuss.

```
Bot A ↔ Bot B ↔ Bot C
```

**Best for**: Brainstorming, complex decisions

---

## 🧠 Model Configuration

### Binding Models to Bots

**Method 1: Dropdown Selection** (Recommended)

1. In Bot configuration, find **Bind Model**
2. Keep "Advanced Mode" OFF
3. Select from available models

**Method 2: Advanced Mode**

1. Toggle **Advanced Mode** ON
2. Select **Model Protocol** (OpenAI/Claude/Gemini)
3. Enter JSON configuration

### Creating Custom Models

1. Go to **Settings** → **Models** tab
2. Click **Create Model**
3. Configure:
   - Model Type (LLM/Embedding/Rerank)
   - Protocol (OpenAI/Anthropic/Gemini)
   - API Key
   - Model ID

See [Model Configuration Guide](./configuring-models.md) for details.

### Per-Task Model Override

When sending a task:
1. Click the **Model** selector in chat input
2. Choose a different model
3. Enable **Force Override** if needed

---

## 🔧 MCP Tools & Skills

### MCP (Model Context Protocol) Tools

MCP tools extend bot capabilities with external services.

**Adding MCP Tools**:

1. In Bot configuration, find **MCP Config**
2. Click **Import MCP**
3. Paste configuration JSON
4. Choose **Replace** or **Append**

**Example - GitHub MCP**:

```json
{
  "github": {
    "command": "docker",
    "args": [
      "run", "-i", "--rm",
      "-e", "GITHUB_PERSONAL_ACCESS_TOKEN",
      "ghcr.io/github/github-mcp-server"
    ],
    "env": {
      "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxx..."
    }
  }
}
```

### Skills

Skills are on-demand capabilities for Claude Code bots.

**Adding Skills**:

1. In Bot configuration, find **Skills** section
2. Select skills from dropdown
3. Click **Manage Skills** to upload new ones

**Managing Skills**:

1. Go to **Settings** → **Skills** tab
2. Upload ZIP packages containing `SKILL.md`
3. Or import from Git repositories

---

## ✨ Best Practices

### 1. Start Simple

- Begin with **Solo** mode
- Use one bot with clear responsibilities
- Add complexity as needed

### 2. Choose Right Executor

| Task | Executor |
|------|----------|
| Code development | ClaudeCode |
| Multi-model chat | Agno |
| Simple Q&A | Chat |
| Dify workflows | Dify |

### 3. Write Clear Prompts

- Be specific about the role
- List concrete responsibilities
- Include working guidelines

### 4. Optimize Costs

| Complexity | Model |
|------------|-------|
| Simple | Claude Haiku / GPT-3.5 |
| Medium | Claude Sonnet / GPT-4o |
| Complex | Claude Opus / GPT-4 |

### 5. Use Descriptive Names

```
✅ "Frontend React Developer"
✅ "Code Review Expert"
❌ "Bot 1"
❌ "Test"
```

---

## ❓ FAQ

### Q: What's the difference between Agent and Bot?

- **Agent**: User-facing AI assistant (what you interact with)
- **Bot**: Building block of an Agent

An Agent can have one Bot (Solo) or multiple Bots (other modes).

### Q: Which collaboration mode should I use?

| Scenario | Mode |
|----------|------|
| Simple tasks | Solo |
| Sequential workflow | Pipeline |
| Task routing | Route |
| Parallel analysis | Coordinate |
| Discussion | Collaborate |

### Q: Can I edit an Agent after creation?

Yes! Click **Edit** on any agent to modify it.

### Q: Why doesn't my Agent appear in Chat/Code?

Check **Bind Mode** setting - enable Chat and/or Code as needed.

### Q: How do I share an Agent?

1. Click **Share** on the agent
2. Copy the share link
3. Others can add it to their list

### Q: What's "Requires Repository"?

- **Enabled**: Must select a code repo before starting
- **Disabled**: Can work without a repo

Enable for development agents, disable for chat agents.

---

## 🔗 Related Resources

- [Model Configuration](./configuring-models.md) - Set up AI models
- [Managing Tasks](./managing-tasks.md) - Use agents to execute tasks
- [Shell Configuration](./configuring-shells.md) - Custom executors
- [Skill Management](./managing-skills.md) - Claude Code skills

---

<p align="center">Configure your AI agents and start automating! 🚀</p>
