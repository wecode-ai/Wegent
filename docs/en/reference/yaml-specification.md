# YAML Configuration Formats

English | [简体中文](../zh/reference/yaml-specification.md)

This document provides detailed explanations of the YAML configuration formats for each core concept in the Wegent platform. Each definition follows Kubernetes-style declarative API design patterns.

## Table of Contents

- [👻 Ghost](#-ghost)
- [✨ Skill](#-skill)
- [🧠 Model](#-model)
- [🐚 Shell](#-shell)
- [🤖 Bot](#-bot)
- [👥 Team](#-team)
- [🤝 Collaboration](#-collaboration)
- [💼 Workspace](#-workspace)
- [🎯 Task](#-task)

---

## 👻 Ghost

Ghost defines the "soul" of an agent, including personality, capabilities, and behavior patterns.

### Complete Configuration Example

```yaml
apiVersion: agent.wecode.io/v1
kind: Ghost
metadata:
  name: developer-ghost
  namespace: default
spec:
  systemPrompt: |
    You are a senior software engineer, proficient in Git, GitHub MCP, branch management, and code submission workflows. You will use the specified programming language to generate executable code and complete the branch submission and MR (Merge Request) process.
  mcpServers:
    github:
      env:
        GITHUB_PERSONAL_ACCESS_TOKEN: ghp_xxxxx
      args:
        - run
        - -i
        - --rm
        - -e
        - GITHUB_PERSONAL_ACCESS_TOKEN
        - -e
        - GITHUB_TOOLSETS
        - -e
        - GITHUB_READ_ONLY
        - ghcr.io/github/github-mcp-server
      command: docker
```

### Field Description

| Field | Type | Required | Description |
|------|------|----------|-------------|
| `metadata.name` | string | Yes | Unique identifier for the Ghost |
| `metadata.namespace` | string | Yes | Namespace, typically `default` |
| `spec.systemPrompt` | string | Yes | System prompt defining agent personality and capabilities |
| `spec.mcpServers` | object | No | MCP server configuration defining agent's tool capabilities |
| `spec.skills` | array | No | List of Skill names to associate with this Ghost, e.g., `["skill-1", "skill-2"]` |

---

## ✨ Skill

Skill is a Claude Code capability extension package containing executable code and configuration. Skills are uploaded as ZIP packages and deployed to `~/.claude/skills/` when tasks start.

### Complete Configuration Example

```yaml
apiVersion: agent.wecode.io/v1
kind: Skill
metadata:
  name: python-debugger
  namespace: default
spec:
  description: "Python debugging tool with breakpoint and variable inspection support"
  version: "1.0.0"
  author: "WeCode Team"
  tags: ["python", "debugging", "development"]
status:
  state: "Available"
  fileSize: 2048576
  fileHash: "abc123def456..."
```

### Field Description

| Field | Type | Required | Description |
|------|------|----------|-------------|
| `metadata.name` | string | Yes | Unique identifier for the Skill (used in Ghost `spec.skills` field) |
| `metadata.namespace` | string | Yes | Namespace, typically `default` |
| `spec.description` | string | Yes | Skill功能描述 (extracted from SKILL.md frontmatter) |
| `spec.version` | string | No | Version number (semantic versioning recommended) |
| `spec.author` | string | No | Author name or organization |
| `spec.tags` | array | No | Tags for categorization, e.g., `["python", "debugging"]` |
| `status.state` | string | Yes | Skill status: `Available` or `Unavailable` |
| `status.fileSize` | integer | No | ZIP package size in bytes |
| `status.fileHash` | string | No | SHA256 hash of the ZIP package |

### ZIP Package Requirements

Skills must be uploaded as ZIP packages containing:
1. **SKILL.md** (required): Skill documentation with YAML frontmatter
2. Other files: Scripts, configurations, assets, etc.

**SKILL.md Format:**
```markdown
---
description: "Your skill description here"
version: "1.0.0"
author: "Your Name"
tags: ["tag1", "tag2"]
---

# Skill Documentation

Detailed description of what this skill does...
```

### Using Skills in Ghosts

Associate skills with a Ghost by adding them to the `spec.skills` array:

```yaml
apiVersion: agent.wecode.io/v1
kind: Ghost
metadata:
  name: developer-ghost
  namespace: default
spec:
  systemPrompt: "You are a senior developer..."
  mcpServers: {...}
  skills:
    - python-debugger
    - code-formatter
```

When a task starts with this Ghost, the Executor automatically downloads and deploys these skills to `~/.claude/skills/`.



## 🧠 Model

Model defines the AI model configuration, including environment variables and model parameters.

### Complete Configuration ClaudeCode Example

```yaml
apiVersion: agent.wecode.io/v1
kind: Model
metadata:
  name: ClaudeSonnet4
  namespace: default
spec:
  modelConfig:
    env:
      ANTHROPIC_MODEL: "openrouter,anthropic/claude-sonnet-4"
      ANTHROPIC_BASE_URL: "http://xxxxx"
      ANTHROPIC_AUTH_TOKEN: "sk-xxxxxx"
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "openrouter,anthropic/claude-haiku-4.5"
```

### Field Description

| Field | Type | Required | Description |
|------|------|----------|-------------|
| `metadata.name` | string | Yes | Unique identifier for the Model |
| `metadata.namespace` | string | Yes | Namespace, typically `default` |
| `spec.modelConfig` | object | Yes | Model configuration object |
| `spec.modelConfig.env` | object | Yes | Environment variables configuration |

### Common Environment Variables for ClaudeCode

| Variable Name | Description | Example Value |
|---------------|-------------|---------------|
| `ANTHROPIC_MODEL` | Main model configuration | `openrouter,anthropic/claude-sonnet-4` |
| `ANTHROPIC_BASE_URL` | API base URL | `http://xxxxx` |
| `ANTHROPIC_AUTH_TOKEN` | Authentication token | `sk-xxxxxx` |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | Fast model configuration | `openrouter,anthropic/claude-haiku-4.5` |

---

## 🐚 Shell

Shell defines the agent's runtime environment, specifying the runtime type, base image, and supported models.

### Complete Configuration Example

```yaml
apiVersion: agent.wecode.io/v1
kind: Shell
metadata:
  name: ClaudeCode
  namespace: default
  labels:
    type: local_engine
spec:
  shellType: ClaudeCode
  supportModel: []
  baseImage: ghcr.io/wecode-ai/wegent-base-python3.12:1.0.1
status:
  state: Available
```

### Field Description

| Field | Type | Required | Description |
|------|------|----------|-------------|
| `metadata.name` | string | Yes | Unique identifier for the Shell |
| `metadata.namespace` | string | Yes | Namespace, typically `default` |
| `metadata.labels` | object | No | Labels for categorization, e.g., `type: local_engine` or `type: external_api` |
| `spec.shellType` | string | Yes | Shell type, such as `ClaudeCode`, `Agno`, `Dify` |
| `spec.supportModel` | array | No | List of supported model types |
| `spec.baseImage` | string | No | Docker base image for local engine shells (required for `local_engine` type) |
| `status.state` | string | No | Shell status: `Available` or `Unavailable` |

### Shell Types

| Type | Label | Description |
|------|-------|-------------|
| `ClaudeCode` | `local_engine` | Claude Code runtime, requires `baseImage` |
| `Agno` | `local_engine` | Agno runtime, requires `baseImage` |
| `Dify` | `external_api` | Dify external API runtime, no `baseImage` needed |

### Labels

| Label | Values | Description |
|-------|--------|-------------|
| `type` | `local_engine`, `external_api` | Indicates whether the shell runs locally or connects to external API |

---

## 🤖 Bot

Bot is a complete agent instance that combines Ghost, Shell, and Model.

### Complete Configuration Example

```yaml
apiVersion: agent.wecode.io/v1
kind: Bot
metadata:
  name: developer-bot
  namespace: default
spec:
  ghostRef:
    name: developer-ghost
    namespace: default
  shellRef:
    name: ClaudeCode
    namespace: default
  modelRef:
    name: ClaudeSonnet4
    namespace: default
```

### Field Description

| Field | Type | Required | Description |
|------|------|----------|-------------|
| `metadata.name` | string | Yes | Unique identifier for the Bot |
| `metadata.namespace` | string | Yes | Namespace, typically `default` |
| `spec.ghostRef` | object | Yes | Ghost reference |
| `spec.shellRef` | object | Yes | Shell reference |
| `spec.modelRef` | object | Yes | Model reference |

### Reference Format

All references follow the same format:

```yaml
name: "resource-name"
namespace: "default"
```

---

## 👥 Team

Team defines a collaborative team of multiple Bots, specifying member roles and collaboration patterns.

### Complete Configuration Example for ClaudeCode Model

```yaml
apiVersion: agent.wecode.io/v1
kind: Team
metadata:
  name: dev-team
  namespace: default
spec:
  members:
    - role: "leader"
      botRef:
        name: developer-bot
        namespace: default
      prompt: ""
  collaborationModel: "pipeline"
```

### Field Description

| Field | Type | Required | Description |
|------|------|----------|-------------|
| `metadata.name` | string | Yes | Unique identifier for the Team |
| `metadata.namespace` | string | Yes | Namespace, typically `default` |
| `spec.members` | array | Yes | List of team members |
| `spec.collaborationModel` | string | Yes | Collaboration model |

### Member Configuration

| Field | Type | Required | Description |
|------|------|----------|-------------|
| `role` | string | No | Member role, such as `leader` |
| `botRef` | object | Yes | Bot reference |
| `prompt` | string | No | Member-specific prompt |

### Collaboration Models

| Model | Description |
|-------|-------------|
| `pipeline` | Pipeline mode, execute in sequence |
| `route` | Route mode, route based on conditions |
| `coordinate` | Coordinate mode, members coordinate |
| `collaborate` | Concurrent mode, members execute simultaneously |

---

## 🤝 Collaboration

Collaboration defines the interaction patterns and workflows between Bots in a Team.

### Complete Configuration Example for ClaudeCode

```yaml
apiVersion: agent.wecode.io/v1
kind: Collaboration
metadata:
  name: workflow-collaboration
  namespace: default
spec:
  type: "workflow"
  config:
    steps:
      - name: "planning"
        participants:
          - "planner-bot"
      - name: "development"
        participants:
          - "developer-bot"
      - name: "review"
        participants:
          - "reviewer-bot"
```

### Field Description

| Field | Type | Required | Description |
|------|------|----------|-------------|
| `metadata.name` | string | Yes | Unique identifier for the Collaboration |
| `metadata.namespace` | string | Yes | Namespace, typically `default` |
| `spec.type` | string | Yes | Collaboration type |
| `spec.config` | object | Yes | Collaboration configuration |

### Workflow Configuration

| Field | Type | Description |
|------|------|-------------|
| `steps` | array | List of workflow steps |
| `steps.name` | string | Step name |
| `steps.participants` | array | List of participants |

---

## 💼 Workspace

Workspace defines the team's working environment, including code repository and branch information.

### Complete Configuration Example

```yaml
apiVersion: agent.wecode.io/v1
kind: Workspace
metadata:
  name: project-workspace
  namespace: default
spec:
  repository:
    gitUrl: "https://github.com/user/repo.git"
    gitRepo: "{user}/{repo}"
    branchName: "main"
    gitDomain: "github.com"
```

### Field Description

| Field | Type | Required | Description |
|------|------|----------|-------------|
| `metadata.name` | string | Yes | Unique identifier for the Workspace |
| `metadata.namespace` | string | Yes | Namespace, typically `default` |
| `spec.repository` | object | Yes | Repository configuration |

### Repository Configuration

| Field | Type | Required | Description |
|------|------|----------|-------------|
| `gitUrl` | string | Yes | Git repository URL |
| `gitRepo` | string | Yes | Repository path format |
| `branchName` | string | Yes | Default branch name |
| `gitDomain` | string | Yes | Git domain |

---

## 🎯 Task

Task defines the task to be executed, associating Team and Workspace.

### Complete Configuration Example

```yaml
apiVersion: agent.wecode.io/v1
kind: Task
metadata:
  name: implement-feature
  namespace: default
spec:
  title: "Implement new feature"
  prompt: "Task description"
  teamRef:
    name: dev-team
    namespace: default
  workspaceRef:
    name: project-workspace
    namespace: default
```

### Field Description

| Field | Type | Required | Description |
|------|------|----------|-------------|
| `metadata.name` | string | Yes | Unique identifier for the Task |
| `metadata.namespace` | string | Yes | Namespace, typically `default` |
| `spec.title` | string | Yes | Task title |
| `spec.prompt` | string | Yes | Task description |
| `spec.teamRef` | object | Yes | Team reference |
| `spec.workspaceRef` | object | Yes | Workspace reference |

### Task Status

| Status | Description |
|--------|-------------|
| `PENDING` | Waiting for execution |
| `RUNNING` | Currently executing |
| `COMPLETED` | Execution completed |
| `FAILED` | Execution failed |
| `CANCELLED` | Execution cancelled |
| `DELETE` | Task deleted |

---

## Best Practices

### 1. Naming Conventions

- Use lowercase letters, numbers, and hyphens
- Avoid special characters and spaces
- Names should be descriptive

### 2. Namespaces

- Use `default` namespace by default
- Use different namespaces in multi-tenant environments

### 3. Reference Management

- Ensure referenced resources exist
- Use the same namespace
- Avoid circular references

### 4. Status Management

- Regularly check resource status
- Handle unavailable resources promptly
- Monitor task execution progress

### 5. Configuration Validation

- Use YAML syntax validation tools
- Check required fields
- Validate reference relationships

---

## Related Documentation

- [Quick Start Guide](../getting-started/quick-start.md)
- [Architecture Design](../concepts/architecture.md)
- [Development Guide](../guides/developer/setup.md)
- [Contribution Guide](../../../CONTRIBUTING.md)
