# 🔧 Shell (执行器) 配置指南

Shell 是 Wegent 中的运行时环境容器,为 Bot 提供代码执行、文件操作、工具调用等能力。本指南将帮助您理解并配置 Shell。

---

## 📋 目录

- [什么是 Shell](#-什么是-shell)
- [Shell 的作用](#-shell-的作用)
- [运行时选择指南](#-运行时选择指南)
- [系统预设 Shell](#-系统预设-shell)
- [配置步骤](#-配置步骤)
- [YAML 配置详解](#-yaml-配置详解)
- [配置示例](#-配置示例)
- [常见问题](#-常见问题)
- [相关资源](#-相关资源)

---

## 🎯 什么是 Shell

Shell 是 Bot 的"身体"或"执行环境",它决定了 Bot 能够使用哪些工具和运行时能力。

### Bot 架构中的位置

```
Bot = Ghost (灵魂) + Shell (身体) + Model (大脑)
```

**类比**:
- **Ghost**: 人的性格和专业知识
- **Shell**: 人的身体和手脚(执行动作的能力)
- **Model**: 人的大脑(思考能力)

### 与数据库的关系

Shell 资源存储在数据库的以下表中:
- `public_shells`: 存储系统提供的公共 Shell 配置 (所有用户共享)
- `kinds`: 存储用户定义的自定义 Shell 配置 (用户特有)

### Shell 查找顺序

当 Bot 引用 Shell 时,系统按照以下顺序查找:
1. **用户自定义 Shell**: 首先在 `kinds` 表中查找用户在指定命名空间下的 Shell
2. **公共 Shell**: 如果未找到,则回退到 `public_shells` 表中的系统公共 Shell

这允许用户:
- 直接使用预设的公共 Shell (如 `ClaudeCode`、`Agno`、`Dify`)
- 通过创建同名 Shell 覆盖公共 Shell
- 定义只有自己可以访问的私有 Shell

---

## 🔍 Shell 的作用

Shell 为 Bot 提供以下核心能力:

1. **代码执行环境**: 运行各种编程语言代码
2. **文件操作**: 读写文件、管理目录
3. **Git 集成**: 版本控制操作
4. **工具调用**: 调用 MCP (Model Context Protocol) 工具
5. **系统命令**: 执行 Bash 命令

---

## 📊 运行时选择指南

Wegent 目前支持三种主要运行时:

### ClaudeCode 运行时 (推荐)

**适用场景**:
- 代码开发和重构
- 文件操作和管理
- Git 分支管理和提交
- 需要工具调用的复杂任务

**特性**:
- ✅ 基于 Claude Agent SDK
- ✅ 支持 MCP 工具调用
- ✅ 完整的文件系统访问
- ✅ Git 集成
- ✅ 成熟稳定

**推荐用于**: 大多数开发任务

### Agno 运行时 (实验性)

**适用场景**:
- 对话交互
- 实验性功能测试
- 特殊的 AI 交互需求

**特性**:
- ⚡ 基于 Agno 框架
- ⚠️ 实验性,功能仍在完善
- 🔬 适合高级用户

**推荐用于**: 对话型任务或实验性场景

### Dify 运行时

**适用场景**:
- 与 Dify 平台应用集成
- 工作流自动化
- 与外部 AI 服务的多轮对话
- 智能体对话应用

**特性**:
- ✅ 支持多种 Dify 应用模式 (chat、chatflow、workflow、agent-chat)
- ✅ 会话管理支持多轮对话
- ✅ 支持任务取消
- ✅ 与 Dify 生态无缝集成

**环境变量**:
- `DIFY_API_KEY`: 您的 Dify API 密钥
- `DIFY_BASE_URL`: Dify 服务器 URL (默认: https://api.dify.ai/v1)
- `DIFY_APP_ID`: Dify 应用 ID
- `DIFY_PARAMS`: JSON 格式的额外参数

**推荐用于**: 使用 Dify 进行 AI 应用开发的团队

### 选择决策表

| 特性 | ClaudeCode | Agno | Dify |
|------|------------|------|------|
| **稳定性** | ⭐⭐⭐⭐⭐ 成熟 | ⭐⭐⭐ 实验性 | ⭐⭐⭐⭐ 稳定 |
| **代码开发** | ⭐⭐⭐⭐⭐ 优秀 | ⭐⭐ 基础 | ⭐⭐ 有限 |
| **工具调用** | ⭐⭐⭐⭐⭐ 完整 | ⭐⭐⭐ 部分 | ⭐⭐⭐ 通过 Dify |
| **Git 集成** | ⭐⭐⭐⭐⭐ 完整 | ⭐⭐ 有限 | ❌ 无 |
| **工作流支持** | ⭐⭐ 基础 | ⭐⭐ 基础 | ⭐⭐⭐⭐⭐ 优秀 |
| **学习曲线** | ⭐⭐⭐⭐ 简单 | ⭐⭐ 较复杂 | ⭐⭐⭐⭐ 简单 |
| **推荐程度** | ✅ 开发任务 | ⚠️ 高级用户 | ✅ 工作流 |

---

## 🎁 系统预设 Shell

Wegent 在初始化时已经预设了以下 Shell,可以直接使用:

### 1. ClaudeCode

**名称**: `ClaudeCode`
**运行时**: `ClaudeCode`
**状态**: ✅ 默认可用
**命名空间**: `default`

**推荐场景**:
- 日常代码开发
- 功能实现
- 代码重构
- 文档编写

### 2. Agno

**名称**: `Agno`
**运行时**: `Agno`
**状态**: ⚠️ 实验性
**命名空间**: `default`

**推荐场景**:
- 对话交互
- 实验性功能
- 特殊需求

### 3. Dify

**名称**: `Dify`
**运行时**: `Dify`
**状态**: ✅ 可用
**命名空间**: `default`

**推荐场景**:
- 与 Dify 平台集成
- 工作流自动化任务
- 多轮对话应用
- 智能体对话交互

---

## 🚀 配置步骤

### 方式 1: 使用预设 Shell (推荐新手)

系统已经预设了 `ClaudeCode` 和 `Agno` Shell,您可以直接在创建 Bot 时引用:

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
    name: ClaudeCode  # 直接使用预设 Shell
    namespace: default
  modelRef:
    name: my-model
    namespace: default
```

### 方式 2: 通过 Web 界面查看现有 Shell

1. 登录 Wegent Web 界面 (http://localhost:3000)
2. 进入 **资源管理** → **Shell 配置**
3. 查看系统中已有的 Shell 列表
4. 选择合适的 Shell 用于您的 Bot

<!-- TODO: 添加截图 - Shell 配置页面 -->

### 方式 3: 创建自定义 Shell

如果您需要自定义 Shell 配置:

#### 通过 Web 界面创建

1. 登录 Wegent Web 界面
2. 进入 **资源管理** → **Shell 配置**
3. 点击 **创建新 Shell** 按钮
4. 填写以下字段:
   - **名称**: Shell 的唯一标识符 (小写字母和中划线)
   - **命名空间**: 通常使用 `default`
   - **运行时类型**: 选择 `ClaudeCode` 或 `Agno`
   - **支持的模型类型**: (可选) 指定此 Shell 支持的模型类型
5. 点击 **提交** 创建

#### 通过 YAML 文件配置

1. 创建 YAML 配置文件 (如 `my-shell.yaml`)
2. 编写配置内容 (参考下方 YAML 配置详解)
3. 通过 Web 界面或 API 导入配置

---

## 📝 YAML 配置详解

### 完整配置结构

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

### 字段说明

#### metadata 部分

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | Shell 的唯一标识符,使用小写字母和中划线 |
| `namespace` | string | 是 | 命名空间,通常使用 `default` |

#### spec 部分

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `runtime` | string | 是 | 运行时类型,可选值: `ClaudeCode`, `Agno`, `Dify` |
| `supportModel` | array | 否 | 支持的模型类型列表,空数组表示支持所有模型 |

**supportModel 说明**:
- 空数组 `[]`: 支持所有模型类型
- 指定列表: 仅支持列表中的模型类型,例如 `["anthropic", "openai"]`

#### status 部分

| 字段 | 说明 |
|------|------|
| `state` | Shell 的状态: `Available` (可用), `Unavailable` (不可用) |

---

## 💡 配置示例

### 示例 1: ClaudeCode Shell (标准配置)

```yaml
apiVersion: agent.wecode.io/v1
kind: Shell
metadata:
  name: ClaudeCode
  namespace: default
spec:
  runtime: ClaudeCode
  supportModel: []  # 支持所有模型类型
status:
  state: "Available"
```

**说明**:
- 这是系统预设的 ClaudeCode Shell 配置
- 支持所有类型的 AI 模型
- 适合大多数开发任务

### 示例 2: Agno Shell (实验性)

```yaml
apiVersion: agent.wecode.io/v1
kind: Shell
metadata:
  name: Agno
  namespace: default
spec:
  runtime: Agno
  supportModel: []  # 支持所有模型类型
status:
  state: "Available"
```

**说明**:
- 系统预设的 Agno Shell 配置
- 实验性功能,适合高级用户
- 适合对话型交互任务

### 示例 3: Dify Shell

```yaml
apiVersion: agent.wecode.io/v1
kind: Shell
metadata:
  name: Dify
  namespace: default
spec:
  runtime: Dify
  supportModel: []  # 支持所有模型类型
status:
  state: "Available"
```

**说明**:
- 系统预设的 Dify Shell 配置
- 与 Dify 平台应用集成
- 支持 chat、chatflow、workflow、agent-chat 模式
- 适合工作流自动化和多轮对话

### 示例 4: 自定义 Shell (仅支持特定模型)

```yaml
apiVersion: agent.wecode.io/v1
kind: Shell
metadata:
  name: custom-claude-shell
  namespace: default
spec:
  runtime: ClaudeCode
  supportModel: ["anthropic"]  # 仅支持 Anthropic 模型
status:
  state: "Available"
```

**说明**:
- 自定义 Shell 配置
- 仅支持 Anthropic 模型 (Claude 系列)
- 适合有特定模型限制的场景

### 示例 5: 开发环境专用 Shell

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

**说明**:
- 开发环境专用 Shell
- 使用独立的命名空间 `development`
- 适合多环境管理

---

## 🔧 Shell 配置与 Bot 引用

### 在 Bot 中引用 Shell

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
    name: ClaudeCode  # 引用 Shell
    namespace: default
  modelRef:
    name: my-model
    namespace: default
```

### 跨命名空间引用

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
    namespace: default  # 引用 default 命名空间的 Shell
  modelRef:
    name: my-model
    namespace: team-a
```

---

## ⚠️ 常见问题

### Q1: 如何查看系统中有哪些可用的 Shell?

**答**: 通过以下方式查看:

**方式 1: Web 界面**
- 登录 Wegent Web 界面
- 进入 **资源管理** → **Shell 配置**
- 查看 Shell 列表

**方式 2: API 查询**
- 访问 http://localhost:8000/api/docs
- 使用 Shell 相关的 API 接口查询

### Q2: ClaudeCode、Agno 和 Dify 有什么区别?

**答**:

| 特性 | ClaudeCode | Agno | Dify |
|------|------------|------|------|
| **成熟度** | 成熟稳定 | 实验性 | 稳定 |
| **主要用途** | 代码开发 | 对话交互 | 工作流自动化 |
| **工具支持** | 完整 | 部分 | 通过 Dify 平台 |
| **推荐程度** | ✅ 推荐 | ⚠️ 高级用户 | ✅ 工作流 |

**建议**:
- 代码开发任务使用 ClaudeCode
- 工作流自动化和 Dify 集成使用 Dify
- 实验性功能使用 Agno

### Q3: Shell 状态检查方法

**答**:

通过 Web 界面查看 Shell 状态:
1. 进入 **资源管理** → **Shell 配置**
2. 查看每个 Shell 的状态列
3. `Available` 表示可用,`Unavailable` 表示不可用

### Q4: 配置错误如何排查?

**答**: 常见错误和解决方案:

**错误 1: Shell 状态为 Unavailable**
- 检查运行时类型是否正确 (`ClaudeCode`、`Agno` 或 `Dify`)
- 检查配置格式是否符合 YAML 规范
- 查看后端日志: `docker-compose logs backend`

**错误 2: Bot 无法使用 Shell**
- 检查 Bot 引用的 Shell 名称和命名空间是否正确
- 确认 Shell 状态为 `Available`
- 检查 supportModel 配置是否限制了模型类型

**错误 3: 跨命名空间引用失败**
- 确认 Shell 在目标命名空间中存在
- 检查命名空间名称拼写是否正确

### Q5: 如何选择 supportModel?

**答**:

**使用空数组 `[]` (推荐)**:
- 支持所有模型类型
- 最大灵活性
- 适合大多数场景

**指定模型类型列表**:
- 限制可用的模型类型
- 适合有严格模型要求的场景
- 例如: `["anthropic"]` 仅支持 Claude 模型

### Q6: 可以修改预设的 Shell 吗?

**答**:

系统预设的 `ClaudeCode` 和 `Agno` Shell 是推荐配置,建议不要修改。

如果需要自定义配置:
- 创建新的 Shell 资源
- 使用不同的名称
- 在 Bot 中引用新创建的 Shell

### Q7: 一个 Shell 可以被多个 Bot 使用吗?

**答**: 可以!这是推荐的做法。

```yaml
# 多个 Bot 共享同一个 Shell
---
kind: Bot
metadata:
  name: bot-1
spec:
  shellRef:
    name: ClaudeCode  # 共享
    namespace: default
---
kind: Bot
metadata:
  name: bot-2
spec:
  shellRef:
    name: ClaudeCode  # 共享
    namespace: default
```

---

## 🔗 相关资源

### 相关配置指南
- [Model (模型) 配置完整指南](./configuring-models.md) - 配置 AI 模型参数

### 下一步
- [创建 Bot](./creating-bots.md) - 使用 Shell 创建完整的 Bot 实例
- [创建 Ghost](./creating-ghosts.md) - 定义 Bot 的"灵魂"

### 参考文档
- [核心概念](../../concepts/core-concepts.md) - 理解 Shell 在架构中的角色
- [YAML 规范](../../reference/yaml-specification.md) - 完整的配置格式

---

## 💬 获取帮助

遇到问题?

- 📖 查看 [FAQ](../../faq.md)
- 🐛 提交 [GitHub Issue](https://github.com/wecode-ai/wegent/issues)
- 💬 加入社区讨论

---

<p align="center">配置好 Shell,为您的 Bot 赋予强大的执行能力! 🚀</p>
