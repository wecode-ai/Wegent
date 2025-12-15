# 🔧 Shell (Executor) Configuration Guide

Shell is the runtime environment container in Wegent that provides Bots with capabilities such as code execution, file operations, and tool invocation. This guide will help you understand and configure Shells.

---

## 📋 Table of Contents

- [What is a Shell](#-what-is-a-shell)
- [Shell Functions](#-shell-functions)
- [Runtime Selection Guide](#-runtime-selection-guide)
- [Preset Shells](#-preset-shells)
- [Configuration Steps](#-configuration-steps)
- [YAML Configuration Reference](#-yaml-configuration-reference)
- [Configuration Examples](#-configuration-examples)
- [FAQ](#-faq)
- [Related Resources](#-related-resources)

---

## 🎯 What is a Shell

A Shell is the "body" or "execution environment" of a Bot, determining what tools and runtime capabilities the Bot can use.

### Position in Bot Architecture

```
Bot = Ghost (Soul) + Shell (Body) + Model (Brain)
```

**Analogy**:
- **Ghost**: A person's character and expertise
- **Shell**: A person's body and limbs (ability to perform actions)
- **Model**: A person's brain (thinking ability)

### Database Relationship

Shell resources are stored in the following database tables:
- `public_shells`: Stores system-provided public Shell configurations (shared across all users)
- `kinds`: Stores user-defined custom Shell configurations (user_id specific)

### Shell Resolution Order

When a Bot references a Shell, the system follows this lookup order:
1. **User-defined Shells**: First checks the `kinds` table for user-specific Shells in the specified namespace
2. **Public Shells**: If not found, falls back to system-provided public Shells in the `public_shells` table

This allows users to:
- Use preset public Shells (like `ClaudeCode`, `Agno`, `Dify`) without creating them
- Override public Shells by creating custom Shells with the same name
- Define private Shells that only they can access

---

## 🔍 Shell Functions

Shells provide Bots with the following core capabilities:

1. **Code Execution Environment**: Run code in various programming languages
2. **File Operations**: Read/write files, manage directories
3. **Git Integration**: Version control operations
4. **Tool Invocation**: Call MCP (Model Context Protocol) tools
5. **System Commands**: Execute Bash commands

---

## 📊 Runtime Selection Guide

Wegent currently supports three main runtimes:

### ClaudeCode Runtime (Recommended)

**Use Cases**:
- Code development and refactoring
- File operations and management
- Git branch management and commits
- Complex tasks requiring tool invocation

**Features**:
- ✅ Based on Claude Agent SDK
- ✅ Supports MCP tool invocation
- ✅ Full filesystem access
- ✅ Git integration
- ✅ Mature and stable

**Recommended for**: Most development tasks

### Agno Runtime (Experimental)

**Use Cases**:
- Conversational interactions
- Experimental feature testing
- Special AI interaction needs

**Features**:
- ⚡ Based on Agno framework
- ⚠️ Experimental, features still being refined
- 🔬 Suitable for advanced users

**Recommended for**: Conversational tasks or experimental scenarios

### Dify Runtime

**Use Cases**:
- Integration with Dify platform applications
- Workflow automation
- Multi-turn conversations with external AI services
- Agent-based chat applications

**Features**:
- ✅ Supports multiple Dify application modes (chat, chatflow, workflow, agent-chat)
- ✅ Session management for multi-turn conversations
- ✅ Task cancellation support
- ✅ Seamless integration with Dify ecosystem

**Environment Variables**:
- `DIFY_API_KEY`: Your Dify API key
- `DIFY_BASE_URL`: Dify server URL (default: https://api.dify.ai/v1)
- `DIFY_APP_ID`: Dify application ID
- `DIFY_PARAMS`: Additional parameters in JSON format

**Recommended for**: Teams using Dify for AI application development

### Decision Table

| Feature | ClaudeCode | Agno | Dify |
|---------|------------|------|------|
| **Stability** | ⭐⭐⭐⭐⭐ Mature | ⭐⭐⭐ Experimental | ⭐⭐⭐⭐ Stable |
| **Code Development** | ⭐⭐⭐⭐⭐ Excellent | ⭐⭐ Basic | ⭐⭐ Limited |
| **Tool Invocation** | ⭐⭐⭐⭐⭐ Complete | ⭐⭐⭐ Partial | ⭐⭐⭐ Via Dify |
| **Git Integration** | ⭐⭐⭐⭐⭐ Complete | ⭐⭐ Limited | ❌ None |
| **Workflow Support** | ⭐⭐ Basic | ⭐⭐ Basic | ⭐⭐⭐⭐⭐ Excellent |
| **Learning Curve** | ⭐⭐⭐⭐ Simple | ⭐⭐ Complex | ⭐⭐⭐⭐ Simple |
| **Recommendation** | ✅ Development | ⚠️ Advanced | ✅ Workflows |

---

## 🎁 Preset Shells

Wegent comes with the following preset Shells that can be used immediately:

### 1. ClaudeCode

**Name**: `ClaudeCode`
**Runtime**: `ClaudeCode`
**Status**: ✅ Available by default
**Namespace**: `default`

**Recommended Scenarios**:
- Daily code development
- Feature implementation
- Code refactoring
- Documentation writing

### 2. Agno

**Name**: `Agno`
**Runtime**: `Agno`
**Status**: ⚠️ Experimental
**Namespace**: `default`

**Recommended Scenarios**:
- Conversational interactions
- Experimental features
- Special requirements

### 3. Dify

**Name**: `Dify`
**Runtime**: `Dify`
**Status**: ✅ Available
**Namespace**: `default`

**Recommended Scenarios**:
- Integration with Dify platform
- Workflow automation tasks
- Multi-turn conversation applications
- Agent-chat interactions

---

## 🚀 Configuration Steps

### Method 1: Use Preset Shells (Recommended for Beginners)

The system already has `ClaudeCode` and `Agno` Shells preset. You can directly reference them when creating a Bot:

```yaml
apiVersion: agent.wecode.io/v1
kind: Bot
metadata:
  name: my-developer-bot
  namespace: default
spec:
  ghostRef:
    name: my-ghost
    namespace: default
  shellRef:
    name: ClaudeCode  # Use preset Shell directly
    namespace: default
  modelRef:
    name: my-model
    namespace: default
```

### Method 2: View Existing Shells via Web Interface

1. Log in to Wegent Web interface (http://localhost:3000)
2. Navigate to **Resource Management** → **Shell Configuration**
3. View the list of Shells in the system
4. Select an appropriate Shell for your Bot

<!-- TODO: Add screenshot - Shell configuration page -->

### Method 3: Create Custom Shell

If you need a custom Shell configuration:

#### Create via Web Interface

1. Log in to Wegent Web interface
2. Navigate to **Resource Management** → **Shell Configuration**
3. Click **Create New Shell** button
4. Fill in the following fields:
   - **Name**: Unique identifier for the Shell (lowercase letters and hyphens)
   - **Namespace**: Usually use `default`
   - **Runtime Type**: Select `ClaudeCode` or `Agno`
   - **Supported Model Types**: (Optional) Specify model types this Shell supports
5. Click **Submit** to create

#### Configure via YAML File

1. Create a YAML configuration file (e.g., `my-shell.yaml`)
2. Write the configuration content (refer to YAML Configuration Reference below)
3. Import the configuration via Web interface or API

---

## 📝 YAML Configuration Reference

### Complete Configuration Structure

```yaml
apiVersion: agent.wecode.io/v1
kind: Shell
metadata:
  name: <shell-name>
  namespace: default
spec:
  runtime: <runtime-type>
  supportModel: []
status:
  state: "Available"
```

### Field Descriptions

#### metadata Section

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Unique identifier for the Shell, use lowercase letters and hyphens |
| `namespace` | string | Yes | Namespace, usually use `default` |

#### spec Section

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `runtime` | string | Yes | Runtime type, options: `ClaudeCode`, `Agno`, `Dify` |
| `supportModel` | array | No | List of supported model types, empty array means all models supported |

**supportModel Explanation**:
- Empty array `[]`: Supports all model types
- Specified list: Only supports model types in the list, e.g., `["anthropic", "openai"]`

#### status Section

| Field | Description |
|-------|-------------|
| `state` | Shell status: `Available` (available), `Unavailable` (unavailable) |

---

## 💡 Configuration Examples

### Example 1: ClaudeCode Shell (Standard Configuration)

```yaml
apiVersion: agent.wecode.io/v1
kind: Shell
metadata:
  name: ClaudeCode
  namespace: default
spec:
  runtime: ClaudeCode
  supportModel: []  # Supports all model types
status:
  state: "Available"
```

**Description**:
- This is the preset ClaudeCode Shell configuration
- Supports all types of AI models
- Suitable for most development tasks

### Example 2: Agno Shell (Experimental)

```yaml
apiVersion: agent.wecode.io/v1
kind: Shell
metadata:
  name: Agno
  namespace: default
spec:
  runtime: Agno
  supportModel: []  # Supports all model types
status:
  state: "Available"
```

**Description**:
- Preset Agno Shell configuration
- Experimental feature, suitable for advanced users
- Suitable for conversational interaction tasks

### Example 3: Dify Shell

```yaml
apiVersion: agent.wecode.io/v1
kind: Shell
metadata:
  name: Dify
  namespace: default
spec:
  runtime: Dify
  supportModel: []  # Supports all model types
status:
  state: "Available"
```

**Description**:
- Preset Dify Shell configuration
- Integrates with Dify platform applications
- Supports chat, chatflow, workflow, and agent-chat modes
- Suitable for workflow automation and multi-turn conversations

### Example 4: Custom Shell (Supports Specific Models Only)

```yaml
apiVersion: agent.wecode.io/v1
kind: Shell
metadata:
  name: custom-claude-shell
  namespace: default
spec:
  runtime: ClaudeCode
  supportModel: ["anthropic"]  # Only supports Anthropic models
status:
  state: "Available"
```

**Description**:
- Custom Shell configuration
- Only supports Anthropic models (Claude series)
- Suitable for scenarios with specific model restrictions

### Example 5: Development Environment Shell

```yaml
apiVersion: agent.wecode.io/v1
kind: Shell
metadata:
  name: dev-environment-shell
  namespace: development
spec:
  runtime: ClaudeCode
  supportModel: []
status:
  state: "Available"
```

**Description**:
- Development environment dedicated Shell
- Uses separate namespace `development`
- Suitable for multi-environment management

---

## 🔧 Shell Configuration and Bot Reference

### Referencing Shell in Bot

```yaml
apiVersion: agent.wecode.io/v1
kind: Bot
metadata:
  name: my-bot
  namespace: default
spec:
  ghostRef:
    name: my-ghost
    namespace: default
  shellRef:
    name: ClaudeCode  # Reference Shell
    namespace: default
  modelRef:
    name: my-model
    namespace: default
```

### Cross-Namespace Reference

```yaml
apiVersion: agent.wecode.io/v1
kind: Bot
metadata:
  name: my-bot
  namespace: team-a
spec:
  ghostRef:
    name: my-ghost
    namespace: team-a
  shellRef:
    name: ClaudeCode
    namespace: default  # Reference Shell from default namespace
  modelRef:
    name: my-model
    namespace: team-a
```

---

## ⚠️ FAQ

### Q1: How to view available Shells in the system?

**Answer**: View via the following methods:

**Method 1: Web Interface**
- Log in to Wegent Web interface
- Navigate to **Resource Management** → **Shell Configuration**
- View the Shell list

**Method 2: API Query**
- Visit http://localhost:8000/api/docs
- Use Shell-related API endpoints to query

### Q2: What's the difference between ClaudeCode, Agno, and Dify?

**Answer**:

| Feature | ClaudeCode | Agno | Dify |
|---------|------------|------|------|
| **Maturity** | Mature and stable | Experimental | Stable |
| **Primary Use** | Code development | Conversational interaction | Workflow automation |
| **Tool Support** | Complete | Partial | Via Dify platform |
| **Recommendation** | ✅ Recommended | ⚠️ Advanced users | ✅ For workflows |

**Suggestion**:
- For code development tasks, use ClaudeCode
- For workflow automation and Dify integration, use Dify
- For experimental features, use Agno

### Q3: How to check Shell status?

**Answer**:

View Shell status via Web interface:
1. Navigate to **Resource Management** → **Shell Configuration**
2. Check the status column for each Shell
3. `Available` means usable, `Unavailable` means not usable

### Q4: How to troubleshoot configuration errors?

**Answer**: Common errors and solutions:

**Error 1: Shell status is Unavailable**
- Check if runtime type is correct (`ClaudeCode`, `Agno`, or `Dify`)
- Check if configuration format complies with YAML specification
- View backend logs: `docker-compose logs backend`

**Error 2: Bot cannot use Shell**
- Check if Bot's Shell reference name and namespace are correct
- Confirm Shell status is `Available`
- Check if supportModel configuration restricts model types

**Error 3: Cross-namespace reference fails**
- Confirm Shell exists in target namespace
- Check namespace name spelling is correct

### Q5: How to choose supportModel?

**Answer**:

**Use empty array `[]` (Recommended)**:
- Supports all model types
- Maximum flexibility
- Suitable for most scenarios

**Specify model type list**:
- Restricts available model types
- Suitable for scenarios with strict model requirements
- Example: `["anthropic"]` only supports Claude models

### Q6: Can I modify preset Shells?

**Answer**:

The preset `ClaudeCode` and `Agno` Shells are recommended configurations; it's best not to modify them.

If you need custom configuration:
- Create a new Shell resource
- Use a different name
- Reference the newly created Shell in your Bot

### Q7: Can one Shell be used by multiple Bots?

**Answer**: Yes! This is the recommended approach.

```yaml
# Multiple Bots sharing the same Shell
---
kind: Bot
metadata:
  name: bot-1
spec:
  shellRef:
    name: ClaudeCode  # Shared
    namespace: default
---
kind: Bot
metadata:
  name: bot-2
spec:
  shellRef:
    name: ClaudeCode  # Shared
    namespace: default
```

---

## 🔗 Related Resources

### Related Configuration Guides
- [Model Configuration Guide](./configuring-models.md) - Configure AI model parameters

### Next Steps
- [Creating Bots](./creating-bots.md) - Create complete Bot instances using Shells
- [Creating Ghosts](./creating-ghosts.md) - Define the "soul" of Bots

### Reference Documentation
- [Core Concepts](../../concepts/core-concepts.md) - Understand Shell's role in the architecture
- [YAML Specification](../../reference/yaml-specification.md) - Complete configuration format

---

## 💬 Get Help

Need assistance?

- 📖 Check [FAQ](../../faq.md)
- 🐛 Submit [GitHub Issue](https://github.com/wecode-ai/wegent/issues)
- 💬 Join community discussions

---

<p align="center">Configure your Shell and empower your Bots with powerful execution capabilities! 🚀</p>
