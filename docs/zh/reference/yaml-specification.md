# YAML 定义格式

[English](../en/reference/yaml-specification.md) | 简体中文

本文档详细说明了 Wegent 平台中各个核心概念的 YAML 配置格式。每个定义都遵循 Kubernetes 风格的声明式 API 设计。

## 目录

- [👻 Ghost](#-ghost)
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
| `spec.mcpServers` | object | 否 | MCP 服务器配置，定义智能体的工具能力 |

---

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

Shell 定义了智能体的运行环境，指定了运行时类型和支持的模型。

### 完整配置示例

```yaml
apiVersion: agent.wecode.io/v1
kind: Shell
metadata:
  name: ClaudeCode
  namespace: default
spec:
  runtime: "ClaudeCode"
```

### 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `metadata.name` | string | 是 | Shell 的唯一标识符 |
| `metadata.namespace` | string | 是 | 命名空间，通常为 `default` |
| `spec.runtime` | string | 是 | 运行时类型，如 `ClaudeCode`、`Agno` |
| `spec.supportModel` | array | 否 | 支持的模型类型列表 |

### 支持的运行时

| 运行时 | 说明 |
|--------|------|
| `ClaudeCode` | Claude Code 运行时 |
| `Agno` | Agno 运行时 |
| `Dify` | Dify 运行时（计划中） |

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
| `coordinate` | 协调模式，成员间协调 |
| `collaborate` | 并发模式，成员间同时执行 |

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
