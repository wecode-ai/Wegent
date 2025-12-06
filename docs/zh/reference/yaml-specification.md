# YAML 定义格式

[English](../en/reference/yaml-specification.md) | 简体中文

本文档详细说明了 Wegent 平台中各个核心概念的 YAML 配置格式。每个定义都遵循 Kubernetes 风格的声明式 API 设计。

## 目录

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

Ghost 定义了智能体的"灵魂"，包括个性、能力和行为模式。

### 完整配置示例

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

### 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `metadata.name` | string | 是 | Ghost 的唯一标识符 |
| `metadata.namespace` | string | 是 | 命名空间，通常为 `default` |
| `spec.systemPrompt` | string | 是 | 定义智能体个性和能力的系统提示词 |
| `spec.mcpServers` | object | 否 | MCP 服务器配置,定义智能体的工具能力 |
| `spec.skills` | array | 否 | 关联的 Skill 名称列表,例如 `["skill-1", "skill-2"]` |

---

## ✨ Skill

Skill 是 Claude Code 的能力扩展包,包含可执行代码和配置。Skills 以 ZIP 包形式上传,任务启动时自动部署到 `~/.claude/skills/` 目录。

### 完整配置示例

```yaml
apiVersion: agent.wecode.io/v1
kind: Skill
metadata:
  name: python-debugger
  namespace: default
spec:
  description: "Python 调试工具,支持断点和变量检查"
  version: "1.0.0"
  author: "WeCode Team"
  tags: ["python", "debugging", "development"]
status:
  state: "Available"
  fileSize: 2048576
  fileHash: "abc123def456..."
```

### 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `metadata.name` | string | 是 | Skill 的唯一标识符(用于 Ghost 的 `spec.skills` 字段) |
| `metadata.namespace` | string | 是 | 命名空间,通常为 `default` |
| `spec.description` | string | 是 | Skill 功能描述(从 SKILL.md frontmatter 提取) |
| `spec.version` | string | 否 | 版本号(建议使用语义化版本) |
| `spec.author` | string | 否 | 作者名称或组织 |
| `spec.tags` | array | 否 | 分类标签,例如 `["python", "debugging"]` |
| `status.state` | string | 是 | Skill 状态: `Available` 或 `Unavailable` |
| `status.fileSize` | integer | 否 | ZIP 包大小(字节) |
| `status.fileHash` | string | 否 | ZIP 包的 SHA256 哈希值 |

### ZIP 包要求

Skills 必须以 ZIP 包形式上传,包含:
1. **SKILL.md**(必需): Skill 文档,包含 YAML frontmatter
2. 其他文件: 脚本、配置、资源等

**SKILL.md 格式:**
```markdown
---
description: "您的 Skill 描述"
version: "1.0.0"
author: "您的名字"
tags: ["标签1", "标签2"]
---

# Skill 文档

详细说明这个 Skill 的功能...
```

### 在 Ghost 中使用 Skills

通过在 `spec.skills` 数组中添加 Skill 名称来关联:

```yaml
apiVersion: agent.wecode.io/v1
kind: Ghost
metadata:
  name: developer-ghost
  namespace: default
spec:
  systemPrompt: "你是一位资深开发工程师..."
  mcpServers: {...}
  skills:
    - python-debugger
    - code-formatter
```

当使用此 Ghost 启动任务时,Executor 会自动下载并部署这些 Skills 到 `~/.claude/skills/` 目录。



## 🧠 Model

Model 定义了 AI 模型的配置，包括环境变量和模型参数。

### 定义 ClaudeCode Model 完整配置示例

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

### 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `metadata.name` | string | 是 | Model 的唯一标识符 |
| `metadata.namespace` | string | 是 | 命名空间，通常为 `default` |
| `spec.modelConfig` | object | 是 | 模型配置对象 |
| `spec.modelConfig.env` | object | 是 | 环境变量配置 |

### ClaudeCode常用环境变量

| 变量名 | 说明 | 示例值 |
|--------|------|--------|
| `ANTHROPIC_MODEL` | 主要模型配置 | `openrouter,anthropic/claude-sonnet-4` |
| `ANTHROPIC_BASE_URL` | API 基础 URL | `http://xxxxx` |
| `ANTHROPIC_AUTH_TOKEN` | 认证令牌 | `sk-xxxxxx` |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | 快速模型配置 | `openrouter,anthropic/claude-haiku-4.5` |

---

## 🐚 Shell

Shell 定义了智能体的运行环境，指定了运行时类型、基础镜像和支持的模型。

### 完整配置示例

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
  baseImage: ghcr.io/wecode-ai/wegent-base-python3.12:1.0.0
status:
  state: Available
```

### 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `metadata.name` | string | 是 | Shell 的唯一标识符 |
| `metadata.namespace` | string | 是 | 命名空间，通常为 `default` |
| `metadata.labels` | object | 否 | 分类标签，如 `type: local_engine` 或 `type: external_api` |
| `spec.shellType` | string | 是 | Shell 类型，如 `ClaudeCode`、`Agno`、`Dify` |
| `spec.supportModel` | array | 否 | 支持的模型类型列表 |
| `spec.baseImage` | string | 否 | 本地引擎 Shell 的 Docker 基础镜像（`local_engine` 类型必填） |
| `status.state` | string | 否 | Shell 状态：`Available` 或 `Unavailable` |

### Shell 类型

| 类型 | 标签 | 说明 |
|------|------|------|
| `ClaudeCode` | `local_engine` | Claude Code 运行时，需要 `baseImage` |
| `Agno` | `local_engine` | Agno 运行时，需要 `baseImage` |
| `Dify` | `external_api` | Dify 外部 API 运行时，不需要 `baseImage` |

### 标签说明

| 标签 | 可选值 | 说明 |
|------|--------|------|
| `type` | `local_engine`, `external_api` | 表示 Shell 是本地运行还是连接外部 API |

---

## 🤖 Bot

Bot 是完整的智能体实例，结合了 Ghost、Shell 和 Model。

### 完整配置示例

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

### 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `metadata.name` | string | 是 | Bot 的唯一标识符 |
| `metadata.namespace` | string | 是 | 命名空间，通常为 `default` |
| `spec.ghostRef` | object | 是 | Ghost 引用 |
| `spec.shellRef` | object | 是 | Shell 引用 |
| `spec.modelRef` | object | 是 | Model 引用 |

### 引用格式

所有引用都遵循相同的格式：

```yaml
name: "resource-name"
namespace: "default"
```

---

## 👥 Team

Team 定义了多个 Bot 的协作团队，指定了成员角色和协作模式。

### 完整配置示例

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

### 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `metadata.name` | string | 是 | Team 的唯一标识符 |
| `metadata.namespace` | string | 是 | 命名空间，通常为 `default` |
| `spec.members` | array | 是 | 团队成员列表 |
| `spec.collaborationModel` | string | 是 | 协作模式 |

### 成员配置

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `role` | string | 否 | 成员角色，如 `leader` |
| `botRef` | object | 是 | Bot 引用 |
| `prompt` | string | 否 | 成员特定的提示词 |

### 协作模式

| 模式 | 说明 |
|------|------|
| `pipeline` | 流水线模式，按顺序执行 |
| `route` | 路由模式，根据条件路由 |
| `coordinate` | 协调模式，Leader-Worker 分布式执行 |
| `collaborate` | 并发模式，成员间同时执行 |

#### Coordinate 模式详解

`coordinate` 协作模式支持 ClaudeCode Shell 的分布式 Leader-Worker 执行：

- **Leader Bot**：分析任务并调度给合适的 Worker Bot
- **Worker Bot**：执行具体任务并向 Leader 汇报
- **用户交互**：Worker 可通过 `[INTERACTION_REQUIRED]` 标记请求用户输入

**Coordinate 模式输出标记：**

| 标记 | 用途 | 说明 |
|------|------|------|
| `[DISPATCH]{"target":"bot","context":"..."}` | Leader 输出 | 调度任务给 Worker |
| `[INTERACTION_REQUIRED]` | Worker 输出 | 请求用户输入 |
| `[TASK_COMPLETED]` | Worker 输出 | 任务完成 |
| `[WORKFLOW_DONE]` | Leader 输出 | 工作流结束 |

**Coordinate Team 示例：**

```yaml
apiVersion: agent.wecode.io/v1
kind: Team
metadata:
  name: intelligent-coordinate-team
  namespace: default
spec:
  collaborationModel: "coordinate"
  members:
    - role: "leader"
      botRef:
        name: coordinator-leader-bot
        namespace: default
    - role: "member"
      botRef:
        name: developer-bot
        namespace: default
    - role: "member"
      botRef:
        name: tester-bot
        namespace: default
```

---

## 🤝 Collaboration

Collaboration 定义了团队中 Bot 之间的交互模式和工作流程。

### 完整配置示例

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

### 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `metadata.name` | string | 是 | Collaboration 的唯一标识符 |
| `metadata.namespace` | string | 是 | 命名空间，通常为 `default` |
| `spec.type` | string | 是 | 协作类型 |
| `spec.config` | object | 是 | 协作配置 |

### 工作流程配置

| 字段 | 类型 | 说明 |
|------|------|------|
| `steps` | array | 工作步骤列表 |
| `steps.name` | string | 步骤名称 |
| `steps.participants` | array | 参与者列表 |

---

## 💼 Workspace

Workspace 定义了团队的工作环境，包括代码仓库和分支信息。

### 完整配置示例

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

### 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `metadata.name` | string | 是 | Workspace 的唯一标识符 |
| `metadata.namespace` | string | 是 | 命名空间，通常为 `default` |
| `spec.repository` | object | 是 | 仓库配置 |

### 仓库配置

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `gitUrl` | string | 是 | Git 仓库 URL |
| `gitRepo` | string | 是 | 仓库路径格式 |
| `branchName` | string | 是 | 默认分支名 |
| `gitDomain` | string | 是 | Git 域名 |

---

## 🎯 Task

Task 定义了要执行的任务，关联了 Team 和 Workspace。

### 完整配置示例

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

### 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `metadata.name` | string | 是 | Task 的唯一标识符 |
| `metadata.namespace` | string | 是 | 命名空间，通常为 `default` |
| `spec.title` | string | 是 | 任务标题 |
| `spec.prompt` | string | 是 | 任务描述 |
| `spec.teamRef` | object | 是 | Team 引用 |
| `spec.workspaceRef` | object | 是 | Workspace 引用 |

### 任务状态

| 状态 | 说明 |
|------|------|
| `PENDING` | 等待执行 |
| `RUNNING` | 正在执行 |
| `WAITING_INPUT` | 等待用户输入（协调模式） |
| `COMPLETED` | 已完成 |
| `FAILED` | 执行失败 |
| `CANCELLED` | 已取消 |
| `DELETE` | 已删除 |

### Subtask 状态

Subtask（任务内的独立执行单元）可以有以下状态：

| 状态 | 说明 |
|------|------|
| `PENDING` | 等待执行 |
| `RUNNING` | 正在执行 |
| `WAITING_INPUT` | 等待用户输入（用于协调模式中 Bot 需要用户交互时） |
| `COMPLETED` | 已完成 |
| `FAILED` | 执行失败 |
| `CANCELLED` | 已取消 |
| `DELETE` | 已删除 |

---

## 最佳实践

### 1. 命名规范

- 使用小写字母、数字和中划线
- 避免特殊字符和空格
- 名称应具有描述性

### 2. 命名空间

- 默认使用 `default` 命名空间
- 在多租户环境中使用不同的命名空间

### 3. 引用管理

- 确保被引用的资源已存在
- 使用相同的命名空间
- 避免循环引用

### 4. 状态管理

- 定期检查资源状态
- 及时处理不可用的资源
- 监控任务执行进度

### 5. 配置校验

- 使用 YAML 语法校验工具
- 检查必填字段
- 校验引用关系

---

## 相关文档

- [快速开始指南](../getting-started/quick-start.md)
- [架构设计](../concepts/architecture.md)
- [开发指南](../guides/developer/setup.md)
- [贡献指南](../../../CONTRIBUTING.md)
