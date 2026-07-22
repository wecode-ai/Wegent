---
sidebar_position: 1
---

# YAML 定义格式

[English](../en/reference/yaml-specification.md) | 简体中文

本文档详细说明了 Wegent 平台中各个核心概念的 YAML 配置格式。每个定义都遵循 Kubernetes 风格的声明式 API 设计。

## 目录

- [👻 Ghost](#-ghost)
- [✨ Skill](#-skill)
- [🧠 Model](#-model)
- [🐚 Shell](#-shell)
- [🖥 Device](#-device)
- [🤖 Bot](#-bot)
- [👥 Team](#-team)
- [🤝 Collaboration](#-collaboration)
- [💼 Workspace](#-workspace)
- [🎯 Task](#-task)
- [📚 KnowledgeBase](#-knowledgebase)
- [🔌 ConnectorApp](#-connectorapp)

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

| 字段                 | 类型   | 必填 | 说明                                                |
| -------------------- | ------ | ---- | --------------------------------------------------- |
| `metadata.name`      | string | 是   | Ghost 的唯一标识符                                  |
| `metadata.namespace` | string | 是   | 命名空间，通常为 `default`                          |
| `spec.systemPrompt`  | string | 是   | 定义智能体个性和能力的系统提示词                    |
| `spec.mcpServers`    | object | 否   | MCP 服务器配置,定义智能体的工具能力                 |
| `spec.skills`        | array  | 否   | 关联的 Skill 名称列表,例如 `["skill-1", "skill-2"]` |

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

| 字段                 | 类型    | 必填 | 说明                                                 |
| -------------------- | ------- | ---- | ---------------------------------------------------- |
| `metadata.name`      | string  | 是   | Skill 的唯一标识符(用于 Ghost 的 `spec.skills` 字段) |
| `metadata.namespace` | string  | 是   | 命名空间,通常为 `default`                            |
| `spec.description`   | string  | 是   | Skill 功能描述(从 SKILL.md frontmatter 提取)         |
| `spec.version`       | string  | 否   | 版本号(建议使用语义化版本)                           |
| `spec.author`        | string  | 否   | 作者名称或组织                                       |
| `spec.tags`          | array   | 否   | 分类标签,例如 `["python", "debugging"]`              |
| `status.state`       | string  | 是   | Skill 状态: `Available` 或 `Unavailable`             |
| `status.fileSize`    | integer | 否   | ZIP 包大小(字节)                                     |
| `status.fileHash`    | string  | 否   | ZIP 包的 SHA256 哈希值                               |

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
  mcpServers: { ... }
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
  modelGroup: "主分组"
  modelSubGroup: "快速"
  modelConfig:
    env:
      ANTHROPIC_MODEL: "openrouter,anthropic/claude-sonnet-4"
      ANTHROPIC_BASE_URL: "http://xxxxx"
      ANTHROPIC_AUTH_TOKEN: "sk-xxxxxx"
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "openrouter,anthropic/claude-haiku-4.5"
```

### 字段说明

| 字段                   | 类型   | 必填 | 说明                               |
| ---------------------- | ------ | ---- | ---------------------------------- |
| `metadata.name`        | string | 是   | Model 的唯一标识符                 |
| `metadata.namespace`   | string | 是   | 命名空间，通常为 `default`         |
| `spec.modelGroup`      | string | 否   | 模型选择器使用的一级展示分组       |
| `spec.modelSubGroup`   | string | 否   | `spec.modelGroup` 下的二级展示分组 |
| `spec.modelConfig`     | object | 是   | 模型配置对象                       |
| `spec.modelConfig.env` | object | 是   | 环境变量配置                       |

### 模型选择器分组

模型选择器会按 `modelGroup` → `modelSubGroup` → 模型进行展示。这两个字段保存在 `spec` 中，而不是 `metadata.labels`，因此分组属于 Model 资源定义的一部分。未设置分组字段的模型会展示在默认的未分组/未分类分组中。分组只影响展示与搜索，不改变模型协议、凭据、权限或运行时选择逻辑。

### ClaudeCode常用环境变量

| 变量名                          | 说明         | 示例值                                  |
| ------------------------------- | ------------ | --------------------------------------- |
| `ANTHROPIC_MODEL`               | 主要模型配置 | `openrouter,anthropic/claude-sonnet-4`  |
| `ANTHROPIC_BASE_URL`            | API 基础 URL | `http://xxxxx`                          |
| `ANTHROPIC_AUTH_TOKEN`          | 认证令牌     | `sk-xxxxxx`                             |
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
  baseImage: ghcr.io/wecode-ai/wegent-base-python3.12:1.0.1
status:
  state: Available
```

### 字段说明

| 字段                 | 类型   | 必填 | 说明                                                         |
| -------------------- | ------ | ---- | ------------------------------------------------------------ |
| `metadata.name`      | string | 是   | Shell 的唯一标识符                                           |
| `metadata.namespace` | string | 是   | 命名空间，通常为 `default`                                   |
| `metadata.labels`    | object | 否   | 分类标签，如 `type: local_engine` 或 `type: external_api`    |
| `spec.shellType`     | string | 是   | Shell 类型，如 `ClaudeCode`、`Agno`、`Dify`                  |
| `spec.supportModel`  | array  | 否   | 支持的模型类型列表                                           |
| `spec.baseImage`     | string | 否   | 本地引擎 Shell 的 Docker 基础镜像（`local_engine` 类型必填） |
| `status.state`       | string | 否   | Shell 状态：`Available` 或 `Unavailable`                     |

### Shell 类型

| 类型         | 标签           | 说明                                     |
| ------------ | -------------- | ---------------------------------------- |
| `ClaudeCode` | `local_engine` | Claude Code 运行时，需要 `baseImage`     |
| `Agno`       | `local_engine` | Agno 运行时，需要 `baseImage`            |
| `Dify`       | `external_api` | Dify 外部 API 运行时，不需要 `baseImage` |

### 标签说明

| 标签   | 可选值                         | 说明                                  |
| ------ | ------------------------------ | ------------------------------------- |
| `type` | `local_engine`, `external_api` | 表示 Shell 是本地运行还是连接外部 API |

---

## 🖥 Device

Device 定义可执行任务的设备。设备记录通常由本地 executor、云设备服务或远程 Docker 设备入口自动创建，不建议用户手写创建。

### 远程 Docker 设备示例

```yaml
apiVersion: agent.wecode.io/v1
kind: Device
metadata:
  name: 7b7c9d64-xxxx-xxxx-xxxx-3f70c6f4a931
  namespace: default
  displayName: alice-remote-a931
spec:
  deviceId: 7b7c9d64-xxxx-xxxx-xxxx-3f70c6f4a931
  displayName: alice-remote-a931
  deviceType: remote
  connectionMode: websocket
  bindShell: claudecode
  isDefault: false
  capabilities: null
  remoteConfig:
    provider: docker
    image: ghcr.io/wecode-ai/wegent-device:latest
    deviceId: 7b7c9d64-xxxx-xxxx-xxxx-3f70c6f4a931
    deviceName: alice-remote-a931
    backendUrl: https://backend.example.com
    publicBaseUrl: http://localhost:17888
    createdAt: "2026-06-17T10:00:00"
status:
  state: Available
```

### 字段说明

| 字段                  | 类型                       | 必填 | 说明                                                  |
| --------------------- | -------------------------- | ---- | ----------------------------------------------------- |
| `metadata.name`       | string                     | 是   | Device 资源名，通常与 `spec.deviceId` 一致            |
| `metadata.namespace`  | string                     | 是   | 命名空间，通常为 `default`                            |
| `spec.deviceId`       | string                     | 是   | Executor 注册和心跳使用的设备 ID                      |
| `spec.displayName`    | string                     | 否   | 前端展示名称                                          |
| `spec.deviceType`     | `local`, `cloud`, `remote` | 是   | 设备类型；`remote` 表示用户自管 Docker 容器或远端主机 |
| `spec.connectionMode` | `websocket`                | 是   | 设备连接后端的方式                                    |
| `spec.bindShell`      | `claudecode`, `openclaw`   | 否   | 设备绑定的 shell runtime                              |
| `spec.isDefault`      | boolean                    | 否   | 是否为同类型默认设备                                  |
| `spec.capabilities`   | array 或 null              | 否   | 设备能力标签                                          |
| `spec.cloudConfig`    | object                     | 否   | 云设备元数据，仅云设备使用                            |
| `spec.remoteConfig`   | object                     | 否   | 远程设备元数据，仅远程设备使用                        |

`remoteConfig` 只保存非敏感元数据。远程 Docker 启动命令中的 `WEGENT_AUTH_TOKEN` 是新建的 remote device API Key，不会写入 Device CRD。`backendUrl` 是容器访问 Backend 的地址，由后端当前环境生成；`publicBaseUrl` 是浏览器访问设备 session gateway 的地址。

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

| 字段                 | 类型   | 必填 | 说明                       |
| -------------------- | ------ | ---- | -------------------------- |
| `metadata.name`      | string | 是   | Bot 的唯一标识符           |
| `metadata.namespace` | string | 是   | 命名空间，通常为 `default` |
| `spec.ghostRef`      | object | 是   | Ghost 引用                 |
| `spec.shellRef`      | object | 是   | Shell 引用                 |
| `spec.modelRef`      | object | 是   | Model 引用                 |

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
      contextPassing: "previous_bot"
  collaborationModel: "pipeline"
```

### 字段说明

| 字段                      | 类型   | 必填 | 说明                       |
| ------------------------- | ------ | ---- | -------------------------- |
| `metadata.name`           | string | 是   | Team 的唯一标识符          |
| `metadata.namespace`      | string | 是   | 命名空间，通常为 `default` |
| `spec.members`            | array  | 是   | 团队成员列表               |
| `spec.collaborationModel` | string | 是   | 协作模式                   |

### 成员配置

| 字段             | 类型   | 必填 | 说明                                                                                                    |
| ---------------- | ------ | ---- | ------------------------------------------------------------------------------------------------------- |
| `role`           | string | 否   | 成员角色，如 `leader`                                                                                   |
| `botRef`         | object | 是   | Bot 引用                                                                                                |
| `prompt`         | string | 否   | 成员特定的提示词                                                                                        |
| `contextPassing` | string | 否   | Pipeline 阶段完成后传给下一阶段的消息：`none`、`original_user`、`previous_bot`、`original_and_previous` |

### 协作模式

| 模式          | 说明                     |
| ------------- | ------------------------ |
| `pipeline`    | 流水线模式，按顺序执行   |
| `route`       | 路由模式，根据条件路由   |
| `coordinate`  | 协调模式，成员间协调     |
| `collaborate` | 并发模式，成员间同时执行 |

---

## 📚 KnowledgeBase

KnowledgeBase 用于管理文档知识库、检索配置和摘要能力。

### 检索配置

| 字段                                                    | 类型    | 必填 | 说明                                              |
| ------------------------------------------------------- | ------- | ---- | ------------------------------------------------- |
| `spec.retrievalConfig`                                  | object  | 否   | RAG 检索配置。缺失或为 `null` 时表示无 RAG 知识库 |
| `spec.retrievalConfig.retriever_name`                   | string  | 是\* | 检索器名称                                        |
| `spec.retrievalConfig.retriever_namespace`              | string  | 否   | 检索器所在 namespace，默认 `default`              |
| `spec.retrievalConfig.embedding_config.model_name`      | string  | 是\* | Embedding 模型名称                                |
| `spec.retrievalConfig.embedding_config.model_namespace` | string  | 否   | Embedding 模型所在 namespace，默认 `default`      |
| `spec.retrievalConfig.retrieval_mode`                   | string  | 否   | 检索模式：`vector`、`keyword` 或 `hybrid`         |
| `spec.retrievalConfig.top_k`                            | integer | 否   | 返回结果数量                                      |
| `spec.retrievalConfig.score_threshold`                  | number  | 否   | 最低相关性阈值                                    |
| `spec.retrievalConfig.hybrid_weights`                   | object  | 否   | 混合检索权重                                      |

`retriever_name` 和 `embedding_config.model_name` 只有在 `spec.retrievalConfig` 存在时必填。创建知识库默认会自动补齐缺失的检索器和 Embedding 模型；如果创建请求明确使用无 RAG 模式，或无法找到可用默认配置，则不会写入 `retrievalConfig`。创建请求中的 `rag_config_mode` 只表达创建意图，不作为 KnowledgeBase YAML 字段持久化。持久化后的稳定状态只有两种：完整的 `retrievalConfig`，或无 `retrievalConfig`。

### 摘要相关配置

| 字段                             | 类型    | 必填 | 说明                                    |
| -------------------------------- | ------- | ---- | --------------------------------------- |
| `spec.summaryEnabled`            | boolean | 否   | 是否启用自动摘要生成                    |
| `spec.summaryModelRef.name`      | string  | 否   | 用于生成摘要的模型名称                  |
| `spec.summaryModelRef.namespace` | string  | 否   | 摘要模型所在 namespace                  |
| `spec.summaryModelRef.type`      | string  | 否   | 摘要模型类型：`public`、`user`、`group` |

### 运行时摘要字段

`spec.summary` 由系统在运行时维护，不建议手工直接写入 YAML。常见字段包括：

| 字段                  | 说明                                                     |
| --------------------- | -------------------------------------------------------- |
| `short_summary`       | AI 生成的短摘要                                          |
| `long_summary`        | AI 生成的长摘要                                          |
| `manual_long_summary` | 手动编辑的知识库长摘要，展示和上下文注入时优先使用       |
| `topics`              | AI 生成的主题标签                                        |
| `status`              | 摘要状态：`pending`、`generating`、`completed`、`failed` |
| `manual_updated_at`   | 手动摘要最近更新时间                                     |
| `manual_updated_by`   | 手动摘要最近编辑人                                       |

**说明：**

- 手动摘要不会阻止 AI 自动摘要继续更新
- 当 `manual_long_summary` 存在时，系统优先使用它做页面展示和聊天上下文注入
- 点击“恢复 AI 摘要”后，系统会回退到最新的 `long_summary`

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

| 字段                 | 类型   | 必填 | 说明                       |
| -------------------- | ------ | ---- | -------------------------- |
| `metadata.name`      | string | 是   | Collaboration 的唯一标识符 |
| `metadata.namespace` | string | 是   | 命名空间，通常为 `default` |
| `spec.type`          | string | 是   | 协作类型                   |
| `spec.config`        | object | 是   | 协作配置                   |

### 工作流程配置

| 字段                 | 类型   | 说明         |
| -------------------- | ------ | ------------ |
| `steps`              | array  | 工作步骤列表 |
| `steps.name`         | string | 步骤名称     |
| `steps.participants` | array  | 参与者列表   |

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

| 字段                 | 类型   | 必填 | 说明                       |
| -------------------- | ------ | ---- | -------------------------- |
| `metadata.name`      | string | 是   | Workspace 的唯一标识符     |
| `metadata.namespace` | string | 是   | 命名空间，通常为 `default` |
| `spec.repository`    | object | 是   | 仓库配置                   |

### 仓库配置

| 字段         | 类型   | 必填 | 说明         |
| ------------ | ------ | ---- | ------------ |
| `gitUrl`     | string | 是   | Git 仓库 URL |
| `gitRepo`    | string | 是   | 仓库路径格式 |
| `branchName` | string | 是   | 默认分支名   |
| `gitDomain`  | string | 是   | Git 域名     |

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
  knowledgeBaseScopes:
    - id: 101
      namespace: default
      name: Product Docs
      scopeRestricted: true
      folderIds: [12]
      explicitDocumentIds: null
      includeSubfolders: true
  externalKnowledgeRefs:
    - provider: ap
      mode: explicit
      id: kb-1
      name: External Product Docs
      scope: organization
      target_type: document
      node_id: document:node-1
      document_id: node-1
      target_name: api-reference.md
```

### 字段说明

| 字段                         | 类型   | 必填 | 说明                                                                         |
| ---------------------------- | ------ | ---- | ---------------------------------------------------------------------------- |
| `metadata.name`              | string | 是   | Task 的唯一标识符                                                            |
| `metadata.namespace`         | string | 是   | 命名空间，通常为 `default`                                                   |
| `spec.title`                 | string | 是   | 任务标题                                                                     |
| `spec.prompt`                | string | 是   | 任务描述                                                                     |
| `spec.teamRef`               | object | 是   | Team 引用                                                                    |
| `spec.workspaceRef`          | object | 是   | Workspace 引用                                                               |
| `spec.knowledgeBaseScopes`   | array  | 否   | `/api/v1/responses` 绑定的知识库访问范围，用于后续对话继承目录或文档级 scope |
| `spec.externalKnowledgeRefs` | array  | 否   | Task 级外部知识源绑定，由聊天上下文选择和任务知识库管理入口自动维护          |

### 知识库范围

`spec.knowledgeBaseScopes` 由 OpenAPI Responses 知识库工具自动维护。启用目录或文档范围后，后续带 `previous_response_id` 的请求会继承该范围，并在当前轮次重新解析目录内文档。

| 字段                  | 类型    | 必填 | 说明                                      |
| --------------------- | ------- | ---- | ----------------------------------------- |
| `id`                  | integer | 否   | 知识库 ID，存在时优先用于解析             |
| `namespace`           | string  | 否   | 知识库命名空间，默认 `default`            |
| `name`                | string  | 是   | 知识库名称                                |
| `scopeRestricted`     | boolean | 否   | 是否限制到指定目录或文档                  |
| `folderIds`           | array   | 否   | 允许访问的目录 ID，`0` 表示根目录直接文档 |
| `explicitDocumentIds` | array   | 否   | 显式允许访问的文档 ID                     |
| `includeSubfolders`   | boolean | 否   | 目录范围是否包含子目录，默认 `true`       |

### 外部知识源绑定

`spec.externalKnowledgeRefs` 是运行时字段，描述当前 Task 已绑定的外部知识源。它由聊天发送和任务知识库管理接口维护，不用于 Ghost、Bot 或 Team 默认配置。

| 字段          | 类型   | 必填     | 说明                                                     |
| ------------- | ------ | -------- | -------------------------------------------------------- |
| `provider`    | string | 是       | 外部知识 provider id                                     |
| `mode`        | string | 否       | 绑定模式，默认 `explicit`；`explicit` 需要提供 `id`      |
| `id`          | string | 条件必填 | provider 内稳定的知识源 ID                               |
| `name`        | string | 否       | 知识源展示名                                             |
| `scope`       | string | 否       | provider 可解释的范围                                    |
| `target_type` | string | 否       | `knowledge_base`、`folder` 或 `document`，缺省按整库处理 |
| `node_id`     | string | 否       | provider-neutral 节点 ID                                 |
| `document_id` | string | 否       | provider-neutral 文档 ID                                 |
| `parent_id`   | string | 否       | provider-neutral 父节点 ID                               |
| `target_name` | string | 否       | 文件夹或文档目标展示名                                   |

### 任务状态

| 状态        | 说明     |
| ----------- | -------- |
| `PENDING`   | 等待执行 |
| `RUNNING`   | 正在执行 |
| `COMPLETED` | 已完成   |
| `FAILED`    | 执行失败 |
| `CANCELLED` | 已取消   |
| `DELETE`    | 已删除   |

---

## 🔌 ConnectorApp

ConnectorApp 定义管理员发布给 Wework/Codex 使用的外部应用连接。资源存储在 `kinds` 表中，`metadata.name` 对应应用 `slug`，当前使用系统命名空间 `system`。通常应通过 Wegent Web 的“系统管理 → 应用连接”维护，而不是手写 YAML。

### 完整配置示例

```yaml
apiVersion: agent.wecode.io/v1
kind: ConnectorApp
metadata:
  name: ticket-api
  namespace: system
  displayName: Ticket API
spec:
  name: Ticket API
  description: Search and read internal tickets
  iconUrl: https://example.com/ticket-icon.png
  enabled: true
  visibility: roles
  allowedRoles:
    - admin
  authType: none
  transport: http
  mcpUrl: https://tickets.example.com/api
  providerHeadersEncrypted: "base64-encrypted-json"
  toolAllowlist:
    - get_ticket
  httpTools:
    - name: get_ticket
      description: Get one ticket
      method: GET
      path: /tickets/{id}
      input_schema:
        type: object
        properties:
          id:
            type: string
        required:
          - id
      argument_locations:
        id: path
      timeout_seconds: 30
```

### 字段说明

| 字段                         | 类型    | 必填 | 说明                                                             |
| ---------------------------- | ------- | ---- | ---------------------------------------------------------------- |
| `metadata.name`              | string  | 是   | Connector App 的唯一 slug，工具名前缀使用该值                    |
| `metadata.namespace`         | string  | 是   | 当前使用 `system`                                                |
| `spec.name`                  | string  | 是   | 展示名称                                                         |
| `spec.description`           | string  | 否   | 应用描述                                                         |
| `spec.iconUrl`               | string  | 否   | 图标 URL                                                         |
| `spec.enabled`               | boolean | 是   | 是否启用，停用后不会出现在用户目录和 Runtime 中                  |
| `spec.visibility`            | string  | 是   | `all` 或 `roles`                                                 |
| `spec.allowedRoles`          | array   | 否   | `visibility: roles` 时允许访问的用户角色                         |
| `spec.authType`              | string  | 是   | 当前仅支持 `none`                                                |
| `spec.transport`             | string  | 是   | `streamable-http`、`sse` 或 `http`                               |
| `spec.mcpUrl`                | string  | 是   | MCP endpoint 或 HTTP API 基础地址                                |
| `spec.providerHeadersEncrypted` | string | 否   | 使用项目敏感数据加密工具加密后的固定请求头 JSON                  |
| `spec.toolAllowlist`         | array   | 否   | 允许暴露和调用的上游工具名                                       |
| `spec.httpTools`             | array   | 条件 | `transport: http` 时必填，定义普通 HTTP API 暴露成 MCP 工具的方式 |

`providerHeadersEncrypted` 必须是加密后的 JSON 字符串。管理 API 接收明文 `provider_headers` 后会负责加密；手写 YAML 时不要提交明文 API Key、服务令牌或请求头。

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
- [架构设计](../developer-guide/architecture.md)
- [开发指南](../developer-guide/setup.md)
- [贡献指南](../../../CONTRIBUTING.md)
