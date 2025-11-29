# 🤖 创建 Bot (智能体实例)

Bot 是 Wegent 中完整的智能体实例,结合了 Ghost (灵魂)、Shell (运行环境) 和 Model (AI 模型配置)。本指南将教您如何创建和配置功能强大的 Bot。

---

## 📋 目录

- [什么是 Bot](#-什么是-bot)
- [核心概念](#-核心概念)
- [创建步骤](#-创建步骤)
- [配置详解](#-配置详解)
- [实战示例](#-实战示例)
- [最佳实践](#-最佳实践)
- [常见问题](#-常见问题)
- [相关资源](#-相关资源)

---

## 🎯 什么是 Bot

Bot 是一个完整的、可执行的智能体实例,由三个核心组件组成:

```
Bot = Ghost (灵魂) + Shell (容器) + Model (AI 模型)
```

**类比**: 如果把智能体比作一个人:
- **Ghost**: 人的性格、技能和专业知识
- **Shell**: 人的身体(执行环境)
- **Model**: 人的大脑(思考能力)
- **Bot**: 完整的人

---

## 🧩 核心概念

### Bot 的三大组件

| 组件 | 说明 | 示例 |
|------|------|------|
| **Ghost** | 定义智能体的个性和能力 | "前端开发专家" |
| **Shell** | 运行时环境 | ClaudeCode, Agno, Dify |
| **Model** | AI 模型配置 | Claude Sonnet 4, GPT-4 |

### Bot vs Ghost

```yaml
# Ghost - 只定义"灵魂"
kind: Ghost
spec:
  systemPrompt: "你是一个前端开发者..."

# Bot - 完整的实例
kind: Bot
spec:
  ghostRef: frontend-ghost      # 引用 Ghost
  shellRef: claude-shell         # 指定运行环境
  modelRef: claude-sonnet-4      # 指定 AI 模型
```

### 引用机制

Bot 通过 `Ref` (引用) 来组合资源,而不是直接包含配置。这样设计的好处:

- **复用性**: 多个 Bot 可以共享同一个 Ghost/Shell/Model
- **灵活性**: 可以快速切换不同的组合
- **可维护性**: 修改 Ghost 会影响所有使用它的 Bot

---

## 🚀 创建步骤

### 步骤 1: 准备前置资源

在创建 Bot 之前,确保以下资源已存在:

1. **Ghost**: 已创建并定义好智能体的个性 → [详细创建指南](./creating-ghosts.md)
2. **Shell**: 已配置运行时环境(系统预设有 ClaudeCode 和 Agno) → [详细配置指南](./configuring-shells.md)
3. **Model**: 已配置 AI 模型参数 → [详细配置指南](./configuring-models.md)

**检查清单**:
```bash
✅ Ghost 已创建 (如: developer-ghost)
✅ Shell 已配置 (如: ClaudeCode)
✅ Model 已配置 (如: ClaudeSonnet4)
```

### 步骤 2: 确定 Bot 的用途

明确这个 Bot 将用于什么场景:

- 独立使用?还是作为 Team 成员?
- 需要什么级别的 AI 能力?
- 有什么特殊的工具需求?

### 步骤 3: 选择合适的组件

**选择 Ghost**:
- 根据任务类型选择 (开发/审查/测试/文档)
- 确保 Ghost 的专业领域匹配需求

**选择 Shell**:
- ClaudeCode: 适合代码开发任务
- Agno: 适合对话和交互任务
- Dify: 适合与 Dify 平台的外部 API 集成（支持 chat、workflow、chatflow、agent-chat 模式）

**选择 Model**:
- Sonnet: 平衡性能和成本
- Haiku: 快速响应,适合简单任务
- Opus: 最强能力,适合复杂任务

### 步骤 4: 编写 YAML 配置

创建标准的 Bot YAML 配置文件。

### 步骤 5: 部署和验证

通过 Wegent 平台部署 Bot 并进行测试验证。

---

## 📝 配置详解

### 基本配置结构

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

### 字段说明

#### metadata 部分

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | Bot 的唯一标识符,使用小写字母和中划线 |
| `namespace` | string | 是 | 命名空间,通常使用 `default` |

#### spec 部分

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `ghostRef` | object | 是 | Ghost 资源引用 |
| `shellRef` | object | 是 | Shell 资源引用 |
| `modelRef` | object | 否 | Model 资源引用 (可选，也可使用 bind_model) |

#### 模型绑定方式

有两种方式将模型绑定到 Bot:

**方式 1: 使用 modelRef (旧版)**
```yaml
spec:
  modelRef:
    name: <model-name>
    namespace: default
```

**方式 2: 在 agent_config 中使用 bind_model (推荐)**
```yaml
spec:
  agent_config:
    bind_model: "my-custom-model"
    bind_model_type: "user"  # 可选: 'public' 或 'user'
```

`bind_model` 方式提供更多灵活性:
- 通过名称引用模型，无需完整的 YAML 结构
- 可选指定模型类型以避免命名冲突
- 如果未指定，系统会自动检测模型类型 (优先用户模型，然后公共模型)

#### 引用对象格式

每个 Ref 对象包含:

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 被引用资源的名称 |
| `namespace` | string | 是 | 被引用资源的命名空间 |

#### status 部分

| 字段 | 说明 |
|------|------|
| `state` | Bot 的状态: `Available`, `Unavailable`, `Error` |

---

## 💡 实战示例

### 示例 1: 前端开发 Bot

```yaml
apiVersion: agent.wecode.io/v1
kind: Bot
metadata:
  name: frontend-developer-bot
  namespace: default
spec:
  # 引用前端开发者 Ghost
  ghostRef:
    name: frontend-developer-ghost
    namespace: default

  # 使用 ClaudeCode Shell
  shellRef:
    name: ClaudeCode
    namespace: default

  # 使用 Claude Sonnet 4 模型
  modelRef:
    name: ClaudeSonnet4
    namespace: default

status:
  state: "Available"
```

**使用场景**:
- React/Vue 组件开发
- 前端页面实现
- UI/UX 优化

### 示例 2: 代码审查 Bot

```yaml
apiVersion: agent.wecode.io/v1
kind: Bot
metadata:
  name: code-reviewer-bot
  namespace: default
spec:
  # 引用代码审查专家 Ghost
  ghostRef:
    name: code-reviewer-ghost
    namespace: default

  # 使用 ClaudeCode Shell
  shellRef:
    name: ClaudeCode
    namespace: default

  # 使用 Claude Sonnet 4 模型(需要较强的分析能力)
  modelRef:
    name: ClaudeSonnet4
    namespace: default

status:
  state: "Available"
```

**使用场景**:
- Pull Request 审查
- 代码质量检查
- 最佳实践建议

### 示例 3: 测试工程师 Bot

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

**使用场景**:
- 单元测试编写
- 集成测试设计
- 测试覆盖率提升

### 示例 4: Python 后端开发 Bot

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

**使用场景**:
- FastAPI/Django 后端开发
- RESTful API 实现
- 数据库设计和优化

### 示例 5: 文档撰写 Bot

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

  # 文档编写可以使用更经济的模型
  modelRef:
    name: ClaudeHaiku4
    namespace: default

status:
  state: "Available"
```

**使用场景**:
- API 文档生成
- 用户手册编写
- README 文件更新

### 示例 6: 快速助手 Bot (使用 Haiku)

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

  # 使用 Haiku 模型,响应更快
  modelRef:
    name: ClaudeHaiku4
    namespace: default

status:
  state: "Available"
```

**使用场景**:
- 快速问题解答
- 简单代码修改
- 格式化和清理

---

## ✨ 最佳实践

### 1. 命名规范

#### ✅ 推荐做法

**描述性命名**:
```yaml
# 好 - 清晰表明 Bot 的用途
name: frontend-react-developer-bot
name: senior-code-reviewer-bot
name: python-api-developer-bot

# 不好 - 模糊或无意义
name: bot1
name: my-bot
name: test
```

**命名模式**:
```
<角色>-<专长>-<类型>-bot

示例:
- frontend-react-developer-bot
- backend-python-api-bot
- senior-fullstack-bot
```

### 2. 资源组合策略

#### 根据任务复杂度选择 Model

```yaml
# 简单任务 - 使用 Haiku (快速、经济)
简单代码修改、格式化、文档编写
→ modelRef: ClaudeHaiku4

# 中等任务 - 使用 Sonnet (平衡)
常规开发、代码审查、测试编写
→ modelRef: ClaudeSonnet4

# 复杂任务 - 使用 Opus (强大)
架构设计、复杂算法、系统优化
→ modelRef: ClaudeOpus (如果可用)
```

#### 根据运行时选择 Shell

```yaml
# 代码开发任务
shellRef: ClaudeCode

# 对话交互任务
shellRef: Agno

# 与 Dify 外部 API 集成
shellRef: Dify
```

### 3. 复用策略

#### ✅ 推荐: 复用 Ghost 和 Model

```yaml
# 同一个 Ghost,不同的 Model
---
apiVersion: agent.wecode.io/v1
kind: Bot
metadata:
  name: developer-bot-fast
spec:
  ghostRef:
    name: developer-ghost  # 复用
  shellRef:
    name: ClaudeCode
  modelRef:
    name: ClaudeHaiku4     # 快速版本
---
apiVersion: agent.wecode.io/v1
kind: Bot
metadata:
  name: developer-bot-powerful
spec:
  ghostRef:
    name: developer-ghost  # 复用同一个 Ghost
  shellRef:
    name: ClaudeCode
  modelRef:
    name: ClaudeSonnet4    # 强大版本
```

### 4. 成本优化

#### 策略 1: 任务分层

```yaml
# 初步分析 - 使用 Haiku
Bot: quick-analyzer-bot (Haiku)

# 深度开发 - 使用 Sonnet
Bot: main-developer-bot (Sonnet)

# 最终审查 - 使用 Sonnet
Bot: final-reviewer-bot (Sonnet)
```

#### 策略 2: 智能降级

```yaml
# 尝试用快速模型
1. 使用 Haiku Bot 处理
2. 如果失败或结果不理想
3. 升级到 Sonnet Bot 重新处理
```

### 5. 环境隔离

#### 开发、测试、生产环境

```yaml
# 开发环境
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
    name: ClaudeHaiku4  # 使用便宜的模型
---
# 生产环境
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
    name: ClaudeSonnet4  # 使用更强大的模型
```

### 6. 验证和测试

#### 创建后立即验证

```yaml
# 1. 检查 Bot 状态
kubectl get bot frontend-developer-bot -n default

# 2. 查看详细信息
kubectl describe bot frontend-developer-bot -n default

# 3. 验证引用资源
kubectl get ghost frontend-developer-ghost -n default
kubectl get shell ClaudeCode -n default
kubectl get model ClaudeSonnet4 -n default
```

---

## 🔧 高级配置

### 场景 1: 多语言支持团队

```yaml
# 英文开发 Bot
---
apiVersion: agent.wecode.io/v1
kind: Bot
metadata:
  name: developer-bot-en
  namespace: default
spec:
  ghostRef:
    name: developer-ghost-en
    namespace: default
  shellRef:
    name: ClaudeCode
    namespace: default
  modelRef:
    name: ClaudeSonnet4
    namespace: default
---
# 中文开发 Bot
apiVersion: agent.wecode.io/v1
kind: Bot
metadata:
  name: developer-bot-zh
  namespace: default
spec:
  ghostRef:
    name: developer-ghost-zh
    namespace: default
  shellRef:
    name: ClaudeCode
    namespace: default
  modelRef:
    name: ClaudeSonnet4
    namespace: default
```

### 场景 2: 专业化团队

```yaml
# 前端专家
---
apiVersion: agent.wecode.io/v1
kind: Bot
metadata:
  name: frontend-expert-bot
spec:
  ghostRef:
    name: frontend-expert-ghost
  shellRef:
    name: ClaudeCode
  modelRef:
    name: ClaudeSonnet4
---
# 后端专家
apiVersion: agent.wecode.io/v1
kind: Bot
metadata:
  name: backend-expert-bot
spec:
  ghostRef:
    name: backend-expert-ghost
  shellRef:
    name: ClaudeCode
  modelRef:
    name: ClaudeSonnet4
---
# 全栈开发者
apiVersion: agent.wecode.io/v1
kind: Bot
metadata:
  name: fullstack-developer-bot
spec:
  ghostRef:
    name: fullstack-ghost
  shellRef:
    name: ClaudeCode
  modelRef:
    name: ClaudeSonnet4
```

---

## ⚠️ 常见问题

### Q1: Bot 创建后无法使用?

**原因**:
1. 引用的资源不存在
2. 命名空间不匹配
3. 资源状态为 `Unavailable`

**解决方案**:
```yaml
# 检查所有引用的资源是否存在
kubectl get ghost <ghost-name> -n <namespace>
kubectl get shell <shell-name> -n <namespace>
kubectl get model <model-name> -n <namespace>

# 检查 Bot 状态
kubectl describe bot <bot-name> -n <namespace>
```

### Q2: 如何更新 Bot 的配置?

**答**: Bot 本身只包含引用,要更新配置有两种方式:

**方式 1: 更新引用的资源**
```yaml
# 更新 Ghost (所有使用此 Ghost 的 Bot 都会受影响)
kubectl edit ghost frontend-ghost
```

**方式 2: 切换引用**
```yaml
# 修改 Bot,引用不同的资源
spec:
  modelRef:
    name: ClaudeHaiku4  # 从 Sonnet 改为 Haiku
```

### Q3: 一个 Ghost 可以被多个 Bot 使用吗?

**答**: 可以!这是推荐的做法:

```yaml
# 一个 Ghost
kind: Ghost
metadata:
  name: developer-ghost
---
# 多个 Bot 引用同一个 Ghost
kind: Bot
metadata:
  name: bot-1
spec:
  ghostRef:
    name: developer-ghost  # 共享
  modelRef:
    name: ClaudeHaiku4
---
kind: Bot
metadata:
  name: bot-2
spec:
  ghostRef:
    name: developer-ghost  # 共享
  modelRef:
    name: ClaudeSonnet4
```

### Q4: Bot 和 Team 有什么关系?

**答**:

```
Bot: 单个智能体实例
Team: 多个 Bot 的协作组合

关系:
Bot 可以独立使用
Bot 也可以作为 Team 的成员
一个 Bot 可以属于多个 Team
```

### Q5: 如何选择合适的 Model?

**答**: 根据以下因素选择:

| 因素 | Haiku | Sonnet | Opus |
|------|-------|--------|------|
| **成本** | 💰 低 | 💰💰 中 | 💰💰💰 高 |
| **速度** | ⚡⚡⚡ 快 | ⚡⚡ 中 | ⚡ 慢 |
| **能力** | ⭐⭐ 基础 | ⭐⭐⭐ 强 | ⭐⭐⭐⭐ 最强 |
| **适用场景** | 简单任务 | 常规开发 | 复杂任务 |

### Q6: Bot 的状态有哪些?

**答**:

| 状态 | 说明 |
|------|------|
| `Available` | 可用,可以正常使用 |
| `Unavailable` | 不可用,可能引用的资源有问题 |
| `Error` | 错误状态,需要检查配置 |

### Q7: 如何删除 Bot?

**答**:
```yaml
# 方式 1: 通过 kubectl
kubectl delete bot <bot-name> -n <namespace>

# 方式 2: 通过 YAML
kubectl delete -f bot.yaml
```

**注意**: 删除 Bot 不会删除它引用的 Ghost/Shell/Model。

### Q8: Bot 可以跨命名空间引用资源吗?

**答**: 可以!只要在引用时指定正确的命名空间:

```yaml
apiVersion: agent.wecode.io/v1
kind: Bot
metadata:
  name: my-bot
  namespace: team-a
spec:
  ghostRef:
    name: shared-ghost
    namespace: shared-resources  # 不同的命名空间
  shellRef:
    name: ClaudeCode
    namespace: default
  modelRef:
    name: ClaudeSonnet4
    namespace: default
```

---

## 📊 完整示例: 软件开发团队的 Bot 配置

### 场景描述

创建一个完整的软件开发团队,包含:
- 1 个前端开发 Bot
- 1 个后端开发 Bot
- 1 个代码审查 Bot
- 1 个测试 Bot
- 1 个文档 Bot

### 完整配置

```yaml
# ==========================================
# 前端开发 Bot
# ==========================================
apiVersion: agent.wecode.io/v1
kind: Bot
metadata:
  name: team-frontend-bot
  namespace: dev-team
spec:
  ghostRef:
    name: frontend-developer-ghost
    namespace: dev-team
  shellRef:
    name: ClaudeCode
    namespace: default
  modelRef:
    name: ClaudeSonnet4
    namespace: default
status:
  state: "Available"

---
# ==========================================
# 后端开发 Bot
# ==========================================
apiVersion: agent.wecode.io/v1
kind: Bot
metadata:
  name: team-backend-bot
  namespace: dev-team
spec:
  ghostRef:
    name: backend-developer-ghost
    namespace: dev-team
  shellRef:
    name: ClaudeCode
    namespace: default
  modelRef:
    name: ClaudeSonnet4
    namespace: default
status:
  state: "Available"

---
# ==========================================
# 代码审查 Bot
# ==========================================
apiVersion: agent.wecode.io/v1
kind: Bot
metadata:
  name: team-reviewer-bot
  namespace: dev-team
spec:
  ghostRef:
    name: code-reviewer-ghost
    namespace: dev-team
  shellRef:
    name: ClaudeCode
    namespace: default
  modelRef:
    name: ClaudeSonnet4
    namespace: default
status:
  state: "Available"

---
# ==========================================
# 测试工程师 Bot
# ==========================================
apiVersion: agent.wecode.io/v1
kind: Bot
metadata:
  name: team-tester-bot
  namespace: dev-team
spec:
  ghostRef:
    name: test-engineer-ghost
    namespace: dev-team
  shellRef:
    name: ClaudeCode
    namespace: default
  modelRef:
    name: ClaudeSonnet4
    namespace: default
status:
  state: "Available"

---
# ==========================================
# 文档撰写 Bot (使用 Haiku 节省成本)
# ==========================================
apiVersion: agent.wecode.io/v1
kind: Bot
metadata:
  name: team-doc-writer-bot
  namespace: dev-team
spec:
  ghostRef:
    name: documentation-writer-ghost
    namespace: dev-team
  shellRef:
    name: ClaudeCode
    namespace: default
  modelRef:
    name: ClaudeHaiku4  # 文档任务使用更经济的模型
    namespace: default
status:
  state: "Available"
```

---

## 🔗 相关资源

### 前置步骤
- [创建 Ghost](./creating-ghosts.md) - 定义 Bot 的"灵魂"

### 下一步
- [创建 Team](./creating-teams.md) - 组建多 Bot 协作团队
- [管理 Task](./managing-tasks.md) - 分配任务给 Bot 或 Team

### 参考文档
- [核心概念](../../concepts/core-concepts.md) - 理解 Bot 的角色
- [YAML 规范](../../reference/yaml-specification.md) - 完整的配置格式

---

## 💬 获取帮助

遇到问题?

- 📖 查看 [FAQ](../../faq.md)
- 🐛 提交 [GitHub Issue](https://github.com/wecode-ai/wegent/issues)
- 💬 加入社区讨论

---

<p align="center">创建您的第一个 Bot,让 AI 智能体为您工作! 🚀</p>
