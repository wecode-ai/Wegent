# 👻 创建 Ghost (灵魂)

Ghost 是 Wegent 中智能体的"灵魂",定义了智能体的个性、专业领域和工具能力。本指南将帮助您创建功能强大的 Ghost 配置。

---

## 📋 目录

- [什么是 Ghost](#-什么是-ghost)
- [核心概念](#-核心概念)
- [创建步骤](#-创建步骤)
- [配置详解](#-配置详解)
- [实战示例](#-实战示例)
- [最佳实践](#-最佳实践)
- [常见问题](#-常见问题)
- [相关资源](#-相关资源)

---

## 🎯 什么是 Ghost

Ghost 是智能体的核心定义,类似于人的"个性"和"技能"。一个 Ghost 包含:

- **系统提示词 (System Prompt)**: 定义智能体的角色、专业领域和行为准则
- **MCP 服务器配置**: 赋予智能体使用外部工具的能力(如 GitHub、文件系统等)

**类比**: 如果 Bot 是一个人,Ghost 就是这个人的灵魂、性格和专业技能。

---

## 🧩 核心概念

### Ghost 的组成部分

```
Ghost = 系统提示词 + MCP 工具配置
```

- **系统提示词**: 告诉 AI "你是谁"、"你擅长什么"
- **MCP 服务器**: 提供实际的工具能力(API 调用、文件操作等)

### Ghost vs Bot

| 概念 | 说明 | 类比 |
|------|------|------|
| Ghost | 智能体的"灵魂" | 人的性格和技能 |
| Bot | 完整的智能体实例 | 完整的人 (灵魂 + 身体 + 大脑) |

---

## 🚀 创建步骤

### 步骤 1: 确定 Ghost 的用途

在创建 Ghost 之前,先明确以下问题:

- 这个智能体将承担什么角色?
- 需要什么专业知识?
- 需要使用哪些工具?

**示例**:
- 前端开发者 Ghost: 精通 React/TypeScript
- 代码审查者 Ghost: 关注代码质量和最佳实践
- 测试工程师 Ghost: 专注测试用例编写

### 步骤 2: 编写系统提示词

系统提示词应该包含:

1. **角色定义**: 明确说明智能体的身份
2. **专业领域**: 列出擅长的技术栈
3. **工作方式**: 说明如何完成任务
4. **注意事项**: 特别需要注意的点

**示例提示词结构**:
```
你是一个 [角色],擅长 [技能列表]。

你的职责是:
- [职责 1]
- [职责 2]
- [职责 3]

在工作时,你应该:
- [行为准则 1]
- [行为准则 2]
```

### 步骤 3: 配置 MCP 服务器

根据 Ghost 的需求,配置必要的 MCP 工具:

**常用 MCP 服务器**:
- **GitHub MCP**: 代码仓库操作
- **Filesystem MCP**: 文件读写
- **Database MCP**: 数据库访问
- **Custom MCP**: 自定义工具

### 步骤 4: 编写 YAML 配置

将上述内容组合成标准的 YAML 格式。

### 步骤 5: 部署和测试

通过 Wegent 平台部署 Ghost,并通过 Bot 进行测试。

---

## 📝 配置详解

### 基本配置结构

```yaml
apiVersion: agent.wecode.io/v1
kind: Ghost
metadata:
  name: <ghost-name>
  namespace: default
spec:
  systemPrompt: |
    <系统提示词>
  mcpServers:
    <服务器名称>:
      command: <命令>
      args:
        - <参数>
      env:
        <环境变量名>: <环境变量值>
```

### 字段说明

#### metadata 部分

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | Ghost 的唯一标识符,使用小写字母和中划线 |
| `namespace` | string | 是 | 命名空间,通常使用 `default` |

#### spec 部分

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `systemPrompt` | string | 是 | 系统提示词,定义智能体的个性和能力 |
| `mcpServers` | object | 否 | MCP 服务器配置对象 |

#### mcpServers 配置

每个 MCP 服务器包含:

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `command` | string | 是 | 启动命令(如 `docker`, `npx`) |
| `args` | array | 是 | 命令参数列表 |
| `env` | object | 否 | 环境变量配置 |

---

## 💡 实战示例

### 示例 1: 前端开发者 Ghost

```yaml
apiVersion: agent.wecode.io/v1
kind: Ghost
metadata:
  name: frontend-developer-ghost
  namespace: default
spec:
  systemPrompt: |
    你是一名资深前端开发工程师,精通以下技术栈:
    - React 18+ 和 TypeScript
    - Tailwind CSS 和现代 CSS
    - Vite 和现代构建工具
    - 前端性能优化和最佳实践

    你的职责:
    - 开发高质量的前端组件和页面
    - 编写清晰、可维护的代码
    - 遵循 React 和 TypeScript 最佳实践
    - 确保代码具有良好的类型安全性

    工作准则:
    - 优先使用函数式组件和 Hooks
    - 为所有组件编写 TypeScript 类型
    - 遵循组件化和模块化设计原则
    - 注重用户体验和界面美观性

  mcpServers:
    github:
      command: docker
      args:
        - run
        - -i
        - --rm
        - -e
        - GITHUB_PERSONAL_ACCESS_TOKEN
        - ghcr.io/github/github-mcp-server
      env:
        GITHUB_PERSONAL_ACCESS_TOKEN: ${GITHUB_TOKEN}
```

### 示例 2: 代码审查者 Ghost

```yaml
apiVersion: agent.wecode.io/v1
kind: Ghost
metadata:
  name: code-reviewer-ghost
  namespace: default
spec:
  systemPrompt: |
    你是一名经验丰富的代码审查专家,专注于代码质量和最佳实践。

    审查重点:
    - 代码可读性和可维护性
    - 潜在的 Bug 和安全问题
    - 性能优化机会
    - 是否遵循项目规范和最佳实践
    - 测试覆盖率和测试质量

    审查原则:
    - 提供建设性的反馈
    - 解释问题的原因和改进方案
    - 优先指出严重问题
    - 认可好的代码设计

    输出格式:
    - 使用清晰的分类(严重/一般/建议)
    - 提供具体的代码示例
    - 给出改进建议和最佳实践

  mcpServers:
    github:
      command: docker
      args:
        - run
        - -i
        - --rm
        - -e
        - GITHUB_PERSONAL_ACCESS_TOKEN
        - -e
        - GITHUB_READ_ONLY
        - ghcr.io/github/github-mcp-server
      env:
        GITHUB_PERSONAL_ACCESS_TOKEN: ${GITHUB_TOKEN}
        GITHUB_READ_ONLY: "true"
```

### 示例 3: 测试工程师 Ghost

```yaml
apiVersion: agent.wecode.io/v1
kind: Ghost
metadata:
  name: test-engineer-ghost
  namespace: default
spec:
  systemPrompt: |
    你是一名专业的测试工程师,精通自动化测试和质量保证。

    技术专长:
    - Jest/Vitest 单元测试框架
    - React Testing Library
    - Playwright/Cypress E2E 测试
    - 测试驱动开发 (TDD)

    工作职责:
    - 为新功能编写全面的测试用例
    - 确保测试覆盖率达标 (>80%)
    - 编写清晰的测试文档
    - 发现和报告潜在问题

    测试原则:
    - 测试应该简单、清晰、易于维护
    - 遵循 AAA 模式 (Arrange-Act-Assert)
    - 测试用例应该独立且可重复
    - 优先测试关键路径和边界情况

  mcpServers:
    github:
      command: docker
      args:
        - run
        - -i
        - --rm
        - -e
        - GITHUB_PERSONAL_ACCESS_TOKEN
        - ghcr.io/github/github-mcp-server
      env:
        GITHUB_PERSONAL_ACCESS_TOKEN: ${GITHUB_TOKEN}
```

### 示例 4: Python 后端开发者 Ghost

```yaml
apiVersion: agent.wecode.io/v1
kind: Ghost
metadata:
  name: python-backend-ghost
  namespace: default
spec:
  systemPrompt: |
    你是一名资深 Python 后端工程师,擅长构建高性能的后端服务。

    技术栈:
    - Python 3.10+ 和现代 Python 特性
    - FastAPI/Django 框架
    - SQLAlchemy ORM
    - PostgreSQL/MySQL 数据库
    - Redis 缓存
    - Docker 容器化

    职责:
    - 设计和实现 RESTful API
    - 编写高质量、类型安全的 Python 代码
    - 优化数据库查询和性能
    - 实现安全的认证和授权

    编码规范:
    - 遵循 PEP 8 代码规范
    - 使用 Type Hints 提高类型安全
    - 编写清晰的 Docstrings
    - 适当的错误处理和日志记录

  mcpServers:
    github:
      command: docker
      args:
        - run
        - -i
        - --rm
        - -e
        - GITHUB_PERSONAL_ACCESS_TOKEN
        - ghcr.io/github/github-mcp-server
      env:
        GITHUB_PERSONAL_ACCESS_TOKEN: ${GITHUB_TOKEN}
```

### 示例 5: 文档撰写者 Ghost

```yaml
apiVersion: agent.wecode.io/v1
kind: Ghost
metadata:
  name: documentation-writer-ghost
  namespace: default
spec:
  systemPrompt: |
    你是一名专业的技术文档撰写者,擅长编写清晰易懂的技术文档。

    专业领域:
    - API 文档编写
    - 用户指南和教程
    - 架构设计文档
    - README 和开发者文档

    写作原则:
    - 使用简洁明了的语言
    - 提供实用的代码示例
    - 结构化组织内容
    - 考虑不同技术背景的读者

    文档结构:
    - 清晰的标题层级
    - 目录导航
    - 代码示例和截图
    - 常见问题解答
    - 相关资源链接

    输出格式:
    - 使用 Markdown 格式
    - 适当使用表格和列表
    - 添加图标和视觉元素
    - 保持风格一致性

  mcpServers:
    github:
      command: docker
      args:
        - run
        - -i
        - --rm
        - -e
        - GITHUB_PERSONAL_ACCESS_TOKEN
        - ghcr.io/github/github-mcp-server
      env:
        GITHUB_PERSONAL_ACCESS_TOKEN: ${GITHUB_TOKEN}
```

---

## ✨ 最佳实践

### 1. 系统提示词设计

#### ✅ 推荐做法

- **明确且具体**: 清晰定义角色和职责
- **结构化**: 使用列表和分段组织内容
- **包含约束**: 说明应该做什么,不应该做什么
- **提供示例**: 在提示词中包含期望的输出格式

**好的示例**:
```yaml
systemPrompt: |
  你是一名 React 开发工程师,专注于:
  - 组件开发
  - 性能优化
  - 类型安全

  你应该:
  - 使用函数式组件
  - 编写 TypeScript 类型
  - 遵循 React 最佳实践
```

#### ❌ 避免的做法

- **过于宽泛**: "你是一个开发者" (太模糊)
- **缺乏重点**: 列出太多不相关的技能
- **没有指导**: 不说明如何完成任务
- **过于冗长**: 提示词超过 1000 字

### 2. MCP 服务器配置

#### ✅ 推荐做法

- **按需配置**: 只添加真正需要的 MCP 服务器
- **环境变量**: 使用环境变量管理敏感信息
- **权限最小化**: 只授予必要的权限 (如使用 `READ_ONLY` 模式)

**示例**:
```yaml
mcpServers:
  github:
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: ${GITHUB_TOKEN}
      GITHUB_READ_ONLY: "true"  # 只读模式,更安全
```

#### ❌ 避免的做法

- **配置过多工具**: 添加不必要的 MCP 服务器
- **硬编码凭证**: 直接在 YAML 中写入 Token
- **过度授权**: 给予超出需求的权限

### 3. 命名规范

#### ✅ 推荐做法

- 使用描述性名称: `frontend-developer-ghost`
- 小写字母和中划线: `code-reviewer-ghost`
- 包含角色信息: `python-backend-ghost`

#### ❌ 避免的做法

- 使用模糊名称: `ghost1`, `my-ghost`
- 使用特殊字符: `ghost_v2`, `ghost@dev`
- 使用大写字母: `FrontendGhost`

### 4. 复用和模块化

创建可复用的 Ghost:

```yaml
# 基础开发者 Ghost
apiVersion: agent.wecode.io/v1
kind: Ghost
metadata:
  name: base-developer-ghost
  namespace: default
spec:
  systemPrompt: |
    你是一名软件工程师,遵循以下通用原则:
    - 编写清晰、可维护的代码
    - 遵循项目规范
    - 注重代码质量
```

然后在 Bot 中通过额外提示词定制:

```yaml
# 在 Team 中为成员添加特定提示
members:
  - name: "frontend-dev"
    botRef:
      name: base-developer-bot  # 使用基础 Bot
    prompt: "专注于 React 前端开发"  # 添加特定职责
```

### 5. 版本管理

为不同版本的 Ghost 使用清晰的命名:

```yaml
# 开发版本
name: frontend-dev-ghost-v1

# 生产版本
name: frontend-prod-ghost-v1
```

---

## ⚠️ 常见问题

### Q1: Ghost 创建后如何测试?

**答**: 创建 Ghost 后,需要:

1. 创建对应的 Bot (关联 Ghost + Shell + Model)
2. 创建包含该 Bot 的 Team
3. 创建 Task 进行测试

**示例流程**:
```
Ghost → Bot → Team → Task (测试)
```

### Q2: 系统提示词可以有多长?

**答**: 建议控制在 500-1000 字以内。过长的提示词可能:
- 影响响应速度
- 分散 AI 注意力
- 增加 Token 消耗

### Q3: 可以同时配置多个 MCP 服务器吗?

**答**: 可以!一个 Ghost 可以配置多个 MCP 服务器:

```yaml
mcpServers:
  github:
    command: docker
    args: [...]
  filesystem:
    command: npx
    args: [...]
  database:
    command: docker
    args: [...]
```

### Q4: Ghost 修改后需要重启 Bot 吗?

**答**: 是的。Ghost 的修改不会自动应用到运行中的 Bot。需要:

1. 更新 Ghost 配置
2. 重启或重新创建使用该 Ghost 的 Bot
3. 重新部署相关的 Team

### Q5: 如何为 Ghost 添加自定义 MCP 服务器?

**答**: 可以配置自定义 MCP 服务器:

```yaml
mcpServers:
  custom-api:
    command: docker
    args:
      - run
      - -i
      - --rm
      - -e
      - API_KEY
      - your-custom-mcp-image:latest
    env:
      API_KEY: ${CUSTOM_API_KEY}
```

### Q6: Ghost 可以被多个 Bot 复用吗?

**答**: 可以!这是推荐的做法:

```yaml
# 一个 Ghost
apiVersion: agent.wecode.io/v1
kind: Ghost
metadata:
  name: developer-ghost
---
# 多个 Bot 可以引用同一个 Ghost
apiVersion: agent.wecode.io/v1
kind: Bot
metadata:
  name: bot-1
spec:
  ghostRef:
    name: developer-ghost  # 复用
---
apiVersion: agent.wecode.io/v1
kind: Bot
metadata:
  name: bot-2
spec:
  ghostRef:
    name: developer-ghost  # 复用
```

### Q7: 如何管理敏感信息(如 API Token)?

**答**: 使用环境变量而不是硬编码:

```yaml
# ❌ 不好的做法
env:
  GITHUB_PERSONAL_ACCESS_TOKEN: ghp_xxxxxxxxxxxx

# ✅ 好的做法
env:
  GITHUB_PERSONAL_ACCESS_TOKEN: ${GITHUB_TOKEN}
```

在部署时通过平台配置实际的环境变量值。

### Q8: Ghost 和 Model 有什么区别?

**答**:

| 概念 | 作用 | 类比 |
|------|------|------|
| Ghost | 定义智能体的个性和能力 | 人的性格和技能 |
| Model | 定义 AI 模型的配置 | 人的"大脑"配置 |

Ghost 定义"做什么",Model 定义"用什么大脑来做"。

---

## 🎓 进阶技巧

### 技巧 1: 使用上下文提示

在系统提示词中提供项目上下文:

```yaml
systemPrompt: |
  你是 Wegent 项目的前端开发者。

  项目上下文:
  - 技术栈: React 18 + TypeScript + Tailwind CSS
  - 代码规范: ESLint + Prettier
  - 组件库: Shadcn UI
  - 状态管理: Zustand

  你需要遵循项目的既有风格和规范。
```

### 技巧 2: 定义输出格式

明确指定期望的输出格式:

```yaml
systemPrompt: |
  你是代码审查专家。

  审查结果请按以下格式输出:

  ## 🔴 严重问题
  - [文件名:行号] 问题描述

  ## 🟡 一般问题
  - [文件名:行号] 问题描述

  ## 💡 建议
  - [文件名:行号] 改进建议
```

### 技巧 3: 设置角色限制

明确说明智能体不应该做的事:

```yaml
systemPrompt: |
  你是文档撰写者。

  你应该:
  - 编写清晰的文档
  - 提供代码示例

  你不应该:
  - 修改源代码
  - 执行代码
  - 访问敏感信息
```

### 技巧 4: 多语言支持

为国际化项目创建多语言 Ghost:

```yaml
# 中文文档 Ghost
apiVersion: agent.wecode.io/v1
kind: Ghost
metadata:
  name: doc-writer-zh-ghost
spec:
  systemPrompt: |
    你是中文技术文档撰写者...
---
# 英文文档 Ghost
apiVersion: agent.wecode.io/v1
kind: Ghost
metadata:
  name: doc-writer-en-ghost
spec:
  systemPrompt: |
    You are a technical documentation writer...
```

---

## 📊 完整示例:全栈开发团队的 Ghost 配置

### 1. 前端 Ghost

```yaml
apiVersion: agent.wecode.io/v1
kind: Ghost
metadata:
  name: fullstack-frontend-ghost
  namespace: default
spec:
  systemPrompt: |
    你是全栈开发团队的前端负责人。

    技术栈: React + TypeScript + Vite + Tailwind CSS

    职责:
    - 开发响应式 UI 组件
    - 实现前端路由和状态管理
    - 对接后端 API
    - 优化前端性能

    工作流程:
    1. 分析需求,设计组件结构
    2. 编写类型安全的代码
    3. 编写单元测试
    4. 提交代码并创建 PR

  mcpServers:
    github:
      command: docker
      args:
        - run
        - -i
        - --rm
        - -e
        - GITHUB_PERSONAL_ACCESS_TOKEN
        - ghcr.io/github/github-mcp-server
      env:
        GITHUB_PERSONAL_ACCESS_TOKEN: ${GITHUB_TOKEN}
```

### 2. 后端 Ghost

```yaml
apiVersion: agent.wecode.io/v1
kind: Ghost
metadata:
  name: fullstack-backend-ghost
  namespace: default
spec:
  systemPrompt: |
    你是全栈开发团队的后端负责人。

    技术栈: FastAPI + Python + PostgreSQL + Redis

    职责:
    - 设计和实现 RESTful API
    - 数据库设计和优化
    - 实现业务逻辑
    - 编写 API 文档

    工作流程:
    1. 设计 API 接口
    2. 实现数据模型和业务逻辑
    3. 编写 API 测试
    4. 更新 API 文档

  mcpServers:
    github:
      command: docker
      args:
        - run
        - -i
        - --rm
        - -e
        - GITHUB_PERSONAL_ACCESS_TOKEN
        - ghcr.io/github/github-mcp-server
      env:
        GITHUB_PERSONAL_ACCESS_TOKEN: ${GITHUB_TOKEN}
```

### 3. DevOps Ghost

```yaml
apiVersion: agent.wecode.io/v1
kind: Ghost
metadata:
  name: fullstack-devops-ghost
  namespace: default
spec:
  systemPrompt: |
    你是全栈开发团队的 DevOps 工程师。

    技术栈: Docker + Kubernetes + GitHub Actions + Terraform

    职责:
    - 配置 CI/CD 流水线
    - 管理容器化部署
    - 监控系统性能
    - 优化部署流程

    工作重点:
    - 自动化一切可自动化的流程
    - 确保部署的可靠性和安全性
    - 编写清晰的部署文档

  mcpServers:
    github:
      command: docker
      args:
        - run
        - -i
        - --rm
        - -e
        - GITHUB_PERSONAL_ACCESS_TOKEN
        - ghcr.io/github/github-mcp-server
      env:
        GITHUB_PERSONAL_ACCESS_TOKEN: ${GITHUB_TOKEN}
```

---

## 🔗 相关资源

### 核心文档
- [核心概念](../../concepts/core-concepts.md) - 理解 Ghost 在 Wegent 中的角色
- [YAML 配置规范](../../reference/yaml-specification.md) - 完整的 YAML 配置格式

### 下一步
- [创建 Bot](./creating-bots.md) - 将 Ghost 组装成完整的 Bot
- [创建 Team](./creating-teams.md) - 构建多 Bot 协作团队
- [管理 Task](./managing-tasks.md) - 分配任务给 Team

---

## 💬 获取帮助

遇到问题?

- 📖 查看 [FAQ](../../faq.md)
- 🐛 提交 [GitHub Issue](https://github.com/wecode-ai/wegent/issues)
- 💬 加入社区讨论

---

<p align="center">创建您的第一个 Ghost,开启 AI 智能体之旅! 🚀</p>
