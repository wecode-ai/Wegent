# 🤖 Creating Bots

Bot is a complete agent instance in Wegent, combining Ghost (soul), Shell (runtime environment), and Model (AI model configuration). This guide will teach you how to create and configure powerful Bots.

---

## 📋 Table of Contents

- [What is a Bot](#-what-is-a-bot)
- [Core Concepts](#-core-concepts)
- [Creation Steps](#-creation-steps)
- [Configuration Details](#-configuration-details)
- [Practical Examples](#-practical-examples)
- [Best Practices](#-best-practices)
- [Common Issues](#-common-issues)
- [Related Resources](#-related-resources)

---

## 🎯 What is a Bot

Bot is a complete, executable agent instance composed of three core components:

```
Bot = Ghost (soul) + Shell (container) + Model (AI model)
```

**Analogy**: If an agent is like a person:
- **Ghost**: Person's personality, skills, and expertise
- **Shell**: Person's body (execution environment)
- **Model**: Person's brain (thinking capability)
- **Bot**: Complete person

---

## 🧩 Core Concepts

### Three Components of Bot

| Component | Description | Example |
|-----------|-------------|---------|
| **Ghost** | Defines agent's personality and capabilities | "Frontend development expert" |
| **Shell** | Runtime environment | ClaudeCode, Agno, Dify |
| **Model** | AI model configuration | Claude Sonnet 4, GPT-4 |

### Bot vs Ghost

```yaml
# Ghost - Only defines "soul"
kind: Ghost
spec:
  systemPrompt: "You are a frontend developer..."

# Bot - Complete instance
kind: Bot
spec:
  ghostRef: frontend-ghost      # Reference Ghost
  shellRef: claude-shell         # Specify runtime environment
  modelRef: claude-sonnet-4      # Specify AI model
```

### Reference Mechanism

Bot uses `Ref` (references) to combine resources instead of directly including configurations. Benefits of this design:

- **Reusability**: Multiple Bots can share the same Ghost/Shell/Model
- **Flexibility**: Quickly switch between different combinations
- **Maintainability**: Modifying Ghost affects all Bots using it

---

## 🚀 Creation Steps

### Step 1: Prepare Prerequisites

Before creating a Bot, ensure these resources exist:

1. **Ghost**: Already created with agent personality defined → [Detailed Creation Guide](./creating-ghosts.md)
2. **Shell**: Runtime environment configured (ClaudeCode and Agno are preset) → [Detailed Configuration Guide](./configuring-shells.md)
3. **Model**: AI model parameters configured → [Detailed Configuration Guide](./configuring-models.md)

**Checklist**:
```bash
✅ Ghost created (e.g., developer-ghost)
✅ Shell configured (e.g., ClaudeCode)
✅ Model configured (e.g., ClaudeSonnet4)
```

### Step 2: Determine Bot's Purpose

Clarify what this Bot will be used for:

- Standalone use? Or as a Team member?
- What level of AI capability needed?
- Any special tool requirements?

### Step 3: Choose Appropriate Components

**Choosing Ghost**:
- Select based on task type (development/review/testing/documentation)
- Ensure Ghost's expertise matches requirements

**Choosing Shell**:
- ClaudeCode: Suitable for code development tasks
- Agno: Suitable for dialogue and interaction tasks
- Dify: Suitable for external API integration with Dify platform (supports chat, workflow, chatflow, agent-chat modes)

**Choosing Model**:
- Sonnet: Balance performance and cost
- Haiku: Fast response, suitable for simple tasks
- Opus: Strongest capability, suitable for complex tasks

### Step 4: Write YAML Configuration

Create standard Bot YAML configuration file.

### Step 5: Deploy and Verify

Deploy Bot through Wegent platform and perform testing.

---

## 📝 Configuration Details

### Basic Configuration Structure

```yaml
apiVersion: agent.wecode.io/v1
kind: Bot
metadata:
  name: <bot-name>
  namespace: default
spec:
  ghostRef:
    name: <ghost-name>
    namespace: default
  shellRef:
    name: <shell-name>
    namespace: default
  modelRef:
    name: <model-name>
    namespace: default
status:
  state: "Available"
```

### Field Descriptions

#### metadata Section

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Bot's unique identifier, use lowercase and hyphens |
| `namespace` | string | Yes | Namespace, typically `default` |

#### spec Section

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `ghostRef` | object | Yes | Ghost resource reference |
| `shellRef` | object | Yes | Shell resource reference |
| `modelRef` | object | No | Model resource reference (optional, can use bind_model instead) |

#### Model Binding Methods

There are two ways to bind a model to a Bot:

**Method 1: Using modelRef (Legacy)**
```yaml
spec:
  modelRef:
    name: <model-name>
    namespace: default
```

**Method 2: Using bind_model in agent_config (Recommended)**
```yaml
spec:
  agent_config:
    bind_model: "my-custom-model"
    bind_model_type: "user"  # Optional: 'public' or 'user'
```

The `bind_model` approach offers more flexibility:
- Reference models by name without full YAML structure
- Optionally specify model type to avoid naming conflicts
- System auto-detects model type if not specified (user models first, then public)

#### Reference Object Format

Each Ref object contains:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Name of referenced resource |
| `namespace` | string | Yes | Namespace of referenced resource |

#### status Section

| Field | Description |
|-------|-------------|
| `state` | Bot's state: `Available`, `Unavailable`, `Error` |

---

## 💡 Practical Examples

### Example 1: Frontend Developer Bot

```yaml
apiVersion: agent.wecode.io/v1
kind: Bot
metadata:
  name: frontend-developer-bot
  namespace: default
spec:
  # Reference frontend developer Ghost
  ghostRef:
    name: frontend-developer-ghost
    namespace: default

  # Use ClaudeCode Shell
  shellRef:
    name: ClaudeCode
    namespace: default

  # Use Claude Sonnet 4 model
  modelRef:
    name: ClaudeSonnet4
    namespace: default

status:
  state: "Available"
```

**Use cases**:
- React/Vue component development
- Frontend page implementation
- UI/UX optimization

### Example 2: Code Reviewer Bot

```yaml
apiVersion: agent.wecode.io/v1
kind: Bot
metadata:
  name: code-reviewer-bot
  namespace: default
spec:
  # Reference code review expert Ghost
  ghostRef:
    name: code-reviewer-ghost
    namespace: default

  # Use ClaudeCode Shell
  shellRef:
    name: ClaudeCode
    namespace: default

  # Use Claude Sonnet 4 model (needs strong analytical capability)
  modelRef:
    name: ClaudeSonnet4
    namespace: default

status:
  state: "Available"
```

**Use cases**:
- Pull Request reviews
- Code quality checks
- Best practice recommendations

### Example 3: Test Engineer Bot

```yaml
apiVersion: agent.wecode.io/v1
kind: Bot
metadata:
  name: test-engineer-bot
  namespace: default
spec:
  ghostRef:
    name: test-engineer-ghost
    namespace: default

  shellRef:
    name: ClaudeCode
    namespace: default

  modelRef:
    name: ClaudeSonnet4
    namespace: default

status:
  state: "Available"
```

**Use cases**:
- Unit test writing
- Integration test design
- Test coverage improvement

### Example 4: Python Backend Developer Bot

```yaml
apiVersion: agent.wecode.io/v1
kind: Bot
metadata:
  name: python-backend-bot
  namespace: default
spec:
  ghostRef:
    name: python-backend-ghost
    namespace: default

  shellRef:
    name: ClaudeCode
    namespace: default

  modelRef:
    name: ClaudeSonnet4
    namespace: default

status:
  state: "Available"
```

**Use cases**:
- FastAPI/Django backend development
- RESTful API implementation
- Database design and optimization

### Example 5: Documentation Writer Bot

```yaml
apiVersion: agent.wecode.io/v1
kind: Bot
metadata:
  name: documentation-writer-bot
  namespace: default
spec:
  ghostRef:
    name: documentation-writer-ghost
    namespace: default

  shellRef:
    name: ClaudeCode
    namespace: default

  # Documentation writing can use more economical model
  modelRef:
    name: ClaudeHaiku4
    namespace: default

status:
  state: "Available"
```

**Use cases**:
- API documentation generation
- User manual writing
- README file updates

### Example 6: Quick Helper Bot (Using Haiku)

```yaml
apiVersion: agent.wecode.io/v1
kind: Bot
metadata:
  name: quick-helper-bot
  namespace: default
spec:
  ghostRef:
    name: general-helper-ghost
    namespace: default

  shellRef:
    name: ClaudeCode
    namespace: default

  # Use Haiku model for faster response
  modelRef:
    name: ClaudeHaiku4
    namespace: default

status:
  state: "Available"
```

**Use cases**:
- Quick question answering
- Simple code modifications
- Formatting and cleanup

---

## ✨ Best Practices

### 1. Naming Conventions

#### ✅ Recommended Approach

**Descriptive naming**:
```yaml
# Good - Clearly indicates Bot's purpose
name: frontend-react-developer-bot
name: senior-code-reviewer-bot
name: python-api-developer-bot

# Bad - Vague or meaningless
name: bot1
name: my-bot
name: test
```

**Naming pattern**:
```
<role>-<specialty>-<type>-bot

Examples:
- frontend-react-developer-bot
- backend-python-api-bot
- senior-fullstack-bot
```

### 2. Resource Combination Strategy

#### Choose Model Based on Task Complexity

```yaml
# Simple tasks - Use Haiku (fast, economical)
Simple code modifications, formatting, documentation
→ modelRef: ClaudeHaiku4

# Medium tasks - Use Sonnet (balanced)
Regular development, code review, test writing
→ modelRef: ClaudeSonnet4

# Complex tasks - Use Opus (powerful)
Architecture design, complex algorithms, system optimization
→ modelRef: ClaudeOpus (if available)
```

#### Choose Shell Based on Runtime

```yaml
# Code development tasks
shellRef: ClaudeCode

# Dialogue interaction tasks
shellRef: Agno

# External API integration with Dify
shellRef: Dify
```

### 3. Reuse Strategy

#### ✅ Recommended: Reuse Ghost and Model

```yaml
# Same Ghost, different Models
---
apiVersion: agent.wecode.io/v1
kind: Bot
metadata:
  name: developer-bot-fast
spec:
  ghostRef:
    name: developer-ghost  # Reuse
  shellRef:
    name: ClaudeCode
  modelRef:
    name: ClaudeHaiku4     # Fast version
---
apiVersion: agent.wecode.io/v1
kind: Bot
metadata:
  name: developer-bot-powerful
spec:
  ghostRef:
    name: developer-ghost  # Reuse same Ghost
  shellRef:
    name: ClaudeCode
  modelRef:
    name: ClaudeSonnet4    # Powerful version
```

### 4. Cost Optimization

#### Strategy 1: Task Tiering

```yaml
# Initial analysis - Use Haiku
Bot: quick-analyzer-bot (Haiku)

# Deep development - Use Sonnet
Bot: main-developer-bot (Sonnet)

# Final review - Use Sonnet
Bot: final-reviewer-bot (Sonnet)
```

#### Strategy 2: Smart Fallback

```yaml
# Try with fast model first
1. Use Haiku Bot for processing
2. If fails or results unsatisfactory
3. Upgrade to Sonnet Bot and reprocess
```

### 5. Environment Isolation

#### Development, Testing, Production Environments

```yaml
# Development environment
---
apiVersion: agent.wecode.io/v1
kind: Bot
metadata:
  name: dev-frontend-bot
  namespace: development
spec:
  ghostRef:
    name: frontend-ghost
    namespace: development
  modelRef:
    name: ClaudeHaiku4  # Use cheaper model
---
# Production environment
apiVersion: agent.wecode.io/v1
kind: Bot
metadata:
  name: prod-frontend-bot
  namespace: production
spec:
  ghostRef:
    name: frontend-ghost
    namespace: production
  modelRef:
    name: ClaudeSonnet4  # Use more powerful model
```

---

## ⚠️ Common Issues

### Q1: Bot unusable after creation?

**Reasons**:
1. Referenced resources don't exist
2. Namespace mismatch
3. Resource state is `Unavailable`

**Solutions**:
```bash
# Check if all referenced resources exist
kubectl get ghost <ghost-name> -n <namespace>
kubectl get shell <shell-name> -n <namespace>
kubectl get model <model-name> -n <namespace>

# Check Bot status
kubectl describe bot <bot-name> -n <namespace>
```

### Q2: How to update Bot configuration?

**Answer**: Bot only contains references. Two ways to update:

**Method 1: Update referenced resources**
```yaml
# Update Ghost (affects all Bots using this Ghost)
kubectl edit ghost frontend-ghost
```

**Method 2: Switch references**
```yaml
# Modify Bot to reference different resources
spec:
  modelRef:
    name: ClaudeHaiku4  # Change from Sonnet to Haiku
```

### Q3: Can one Ghost be used by multiple Bots?

**Answer**: Yes! This is the recommended approach:

```yaml
# One Ghost
kind: Ghost
metadata:
  name: developer-ghost
---
# Multiple Bots reference same Ghost
kind: Bot
metadata:
  name: bot-1
spec:
  ghostRef:
    name: developer-ghost  # Shared
  modelRef:
    name: ClaudeHaiku4
---
kind: Bot
metadata:
  name: bot-2
spec:
  ghostRef:
    name: developer-ghost  # Shared
  modelRef:
    name: ClaudeSonnet4
```

### Q4: What's the relationship between Bot and Team?

**Answer**:

```
Bot: Single agent instance
Team: Collaboration combination of multiple Bots

Relationship:
Bot can be used independently
Bot can also be a Team member
One Bot can belong to multiple Teams
```

### Q5: How to choose the right Model?

**Answer**: Choose based on these factors:

| Factor | Haiku | Sonnet | Opus |
|--------|-------|--------|------|
| **Cost** | 💰 Low | 💰💰 Medium | 💰💰💰 High |
| **Speed** | ⚡⚡⚡ Fast | ⚡⚡ Medium | ⚡ Slow |
| **Capability** | ⭐⭐ Basic | ⭐⭐⭐ Strong | ⭐⭐⭐⭐ Strongest |
| **Use cases** | Simple tasks | Regular dev | Complex tasks |

### Q6: What are Bot's states?

**Answer**:

| State | Description |
|-------|-------------|
| `Available` | Available, can be used normally |
| `Unavailable` | Unavailable, may have issues with referenced resources |
| `Error` | Error state, need to check configuration |

### Q7: How to delete Bot?

**Answer**:
```bash
# Method 1: Via kubectl
kubectl delete bot <bot-name> -n <namespace>

# Method 2: Via YAML
kubectl delete -f bot.yaml
```

**Note**: Deleting Bot doesn't delete its referenced Ghost/Shell/Model.

### Q8: Can Bot reference resources across namespaces?

**Answer**: Yes! Just specify the correct namespace in the reference:

```yaml
apiVersion: agent.wecode.io/v1
kind: Bot
metadata:
  name: my-bot
  namespace: team-a
spec:
  ghostRef:
    name: shared-ghost
    namespace: shared-resources  # Different namespace
  shellRef:
    name: ClaudeCode
    namespace: default
  modelRef:
    name: ClaudeSonnet4
    namespace: default
```

---

## 🔗 Related Resources

### Prerequisites
- [Creating Ghosts](./creating-ghosts.md) - Define Bot's "soul"

### Next Steps
- [Creating Teams](./creating-teams.md) - Build multi-Bot collaboration teams
- [Managing Tasks](./managing-tasks.md) - Assign tasks to Bots or Teams

### Reference Documentation
- [Core Concepts](../../concepts/core-concepts.md) - Understand Bot's role
- [YAML Specification](../../reference/yaml-specification.md) - Complete configuration format

---

## 💬 Get Help

Need assistance?

- 📖 Check [FAQ](../../faq.md)
- 🐛 Submit [GitHub Issue](https://github.com/wecode-ai/wegent/issues)
- 💬 Join community discussions

---

<p align="center">Create your first Bot and let AI agents work for you! 🚀</p>
