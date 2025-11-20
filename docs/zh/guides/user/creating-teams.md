# 👥 创建 Team (协作团队)

Team 是 Wegent 中多个 Bot 的协作组合,通过不同的协作模式实现复杂任务的分工协作。本指南将教您如何创建高效的智能体团队。

---

## 📋 目录

- [什么是 Team](#-什么是-team)
- [核心概念](#-核心概念)
- [协作模式](#-协作模式)
- [创建步骤](#-创建步骤)
- [配置详解](#-配置详解)
- [实战示例](#-实战示例)
- [最佳实践](#-最佳实践)
- [常见问题](#-常见问题)
- [相关资源](#-相关资源)

---

## 🎯 什么是 Team

Team 是由多个 Bot 组成的协作团队,就像一个真实的软件开发团队,每个成员都有自己的专长和职责。

**类比**:
```
真实团队                  →  AI Team
------------------------  →  ------------------------
项目经理                  →  Leader Bot
前端开发工程师            →  Frontend Bot
后端开发工程师            →  Backend Bot
测试工程师                →  Tester Bot
```

### Team 的组成

```
Team = 多个 Bot + 协作模式 + 成员角色
```

---

## 🧩 核心概念

### Team 的三大要素

| 要素 | 说明 | 示例 |
|------|------|------|
| **成员 (Members)** | 参与协作的 Bot 列表 | Frontend Bot, Backend Bot |
| **角色 (Roles)** | 成员在团队中的角色 | Leader, Member |
| **协作模式** | Bot 之间的交互方式 | Pipeline, Route, Coordinate |

### 角色类型

| 角色 | 说明 | 职责 |
|------|------|------|
| **Leader** | 团队领导者 | 协调、分配任务、整合结果 |
| **Member** | 普通成员 | 执行具体任务 |

---

## 🤝 协作模式

Wegent 支持四种协作模式,每种模式适用于不同的场景。

### 1. Pipeline (流水线模式)

**特点**: 顺序执行,前一个 Bot 的输出作为下一个 Bot 的输入

**流程**:
```
Bot A → Bot B → Bot C → 结果
```

**适用场景**:
- 代码开发 → 代码审查 → 测试 → 部署
- 数据收集 → 数据处理 → 数据分析

**示例配置**:
```yaml
spec:
  collaborationModel: "pipeline"
  members:
    - name: "developer"
      role: "member"
    - name: "reviewer"
      role: "member"
    - name: "tester"
      role: "member"
```

### 2. Route (路由模式)

**特点**: Leader 根据任务类型路由给合适的 Bot

**流程**:
```
                → Frontend Bot (前端任务)
User Task → Leader
                → Backend Bot (后端任务)
```

**适用场景**:
- 根据问题类型分配给不同专家
- 多领域支持系统

**示例配置**:
```yaml
spec:
  collaborationModel: "route"
  members:
    - name: "coordinator"
      role: "leader"  # Leader 负责路由
    - name: "frontend-expert"
      role: "member"
    - name: "backend-expert"
      role: "member"
```

### 3. Coordinate (协调模式)

**特点**: Leader 协调多个 Bot 并行工作,最后汇总结果

**流程**:
```
          → Bot A (并行)
Leader → → Bot B (并行) → Leader (汇总)
          → Bot C (并行)
```

**适用场景**:
- 多角度分析
- 并行任务处理

**示例配置**:
```yaml
spec:
  collaborationModel: "coordinate"
  members:
    - name: "coordinator"
      role: "leader"
    - name: "analyzer-1"
      role: "member"
    - name: "analyzer-2"
      role: "member"
```

### 4. Collaborate (协作模式)

**特点**: 所有 Bot 共享上下文,自由讨论和协作

**流程**:
```
Bot A ↔ Bot B ↔ Bot C (共享上下文,自由交互)
```

**适用场景**:
- 头脑风暴
- 复杂问题讨论
- 需要多方意见的决策

**示例配置**:
```yaml
spec:
  collaborationModel: "collaborate"
  members:
    - name: "expert-1"
      role: "member"
    - name: "expert-2"
      role: "member"
    - name: "expert-3"
      role: "member"
```

---

## 🚀 创建步骤

### 步骤 1: 确定团队目标

明确团队要完成什么类型的任务:

- 全栈开发?
- 代码审查和质量保证?
- 数据分析?
- 文档生成?

### 步骤 2: 选择协作模式

根据任务特点选择合适的协作模式:

| 任务类型 | 推荐模式 |
|----------|----------|
| 顺序工作流 | Pipeline |
| 分类处理 | Route |
| 并行分析 | Coordinate |
| 讨论决策 | Collaborate |

### 步骤 3: 确定团队成员

根据任务需求确定需要哪些专业的 Bot:

**示例 - 全栈开发团队**:
- Frontend Developer Bot
- Backend Developer Bot
- Tester Bot
- Reviewer Bot

### 步骤 4: 分配角色和职责

为每个成员分配角色,并编写成员提示词:

```yaml
members:
  - name: "developer"
    role: "leader"
    prompt: "你负责整体开发和协调..."
  - name: "tester"
    role: "member"
    prompt: "你负责编写测试用例..."
```

### 步骤 5: 编写 YAML 配置

将所有信息组合成 Team 配置文件。

### 步骤 6: 部署和测试

通过 Task 测试 Team 的协作效果。

---

## 📝 配置详解

### 基本配置结构

```yaml
apiVersion: agent.wecode.io/v1
kind: Team
metadata:
  name: <team-name>
  namespace: default
spec:
  members:
    - name: <member-name>
      role: <member-role>
      botRef:
        name: <bot-name>
        namespace: default
      prompt: <member-specific-prompt>
  collaborationModel: <collaboration-mode>
status:
  state: "Available"
```

### 字段说明

#### metadata 部分

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | Team 的唯一标识符 |
| `namespace` | string | 是 | 命名空间,通常为 `default` |

#### spec 部分

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `members` | array | 是 | 团队成员列表 |
| `collaborationModel` | string | 是 | 协作模式 |

#### members 配置

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 成员名称 (团队内唯一) |
| `role` | string | 否 | 角色: `leader` 或 `member` |
| `botRef` | object | 是 | Bot 引用 |
| `prompt` | string | 否 | 成员特定的提示词 |

#### collaborationModel 选项

| 值 | 说明 |
|-----|------|
| `pipeline` | 流水线模式 |
| `route` | 路由模式 |
| `coordinate` | 协调模式 |
| `collaborate` | 协作模式 |

---

## 💡 实战示例

### 示例 1: 全栈开发团队 (Pipeline 模式)

**场景**: 完整的软件开发流程

```yaml
apiVersion: agent.wecode.io/v1
kind: Team
metadata:
  name: fullstack-dev-team
  namespace: default
spec:
  # Pipeline 模式: 开发 → 审查 → 测试
  collaborationModel: "pipeline"

  members:
    # 1. 开发者 - 负责编写代码
    - name: "developer"
      role: "member"
      botRef:
        name: fullstack-developer-bot
        namespace: default
      prompt: |
        你是团队的开发者,负责:
        - 分析需求并设计方案
        - 实现前后端功能
        - 编写清晰的代码注释
        - 提交代码到 Git 仓库

    # 2. 审查者 - 负责代码审查
    - name: "reviewer"
      role: "member"
      botRef:
        name: code-reviewer-bot
        namespace: default
      prompt: |
        你是团队的代码审查者,负责:
        - 审查代码质量和规范
        - 检查潜在的 Bug 和安全问题
        - 提供改进建议
        - 确保代码符合最佳实践

    # 3. 测试者 - 负责测试
    - name: "tester"
      role: "member"
      botRef:
        name: test-engineer-bot
        namespace: default
      prompt: |
        你是团队的测试工程师,负责:
        - 编写单元测试和集成测试
        - 确保测试覆盖率达标
        - 运行测试并报告结果
        - 验证代码质量

status:
  state: "Available"
```

**工作流程**:
```
1. Developer: 实现功能代码
2. Reviewer: 审查代码质量
3. Tester: 编写和运行测试
4. 完成
```

### 示例 2: 技术支持团队 (Route 模式)

**场景**: 根据问题类型分配给不同专家

```yaml
apiVersion: agent.wecode.io/v1
kind: Team
metadata:
  name: tech-support-team
  namespace: default
spec:
  # Route 模式: 根据问题类型路由
  collaborationModel: "route"

  members:
    # Leader - 负责问题分类和路由
    - name: "support-coordinator"
      role: "leader"
      botRef:
        name: coordinator-bot
        namespace: default
      prompt: |
        你是技术支持协调者,负责:
        - 分析用户问题的类型
        - 将前端问题路由给前端专家
        - 将后端问题路由给后端专家
        - 将数据库问题路由给数据库专家
        - 汇总专家的解决方案

    # 前端专家
    - name: "frontend-expert"
      role: "member"
      botRef:
        name: frontend-expert-bot
        namespace: default
      prompt: |
        你是前端技术专家,负责解决:
        - React/Vue 相关问题
        - CSS 样式问题
        - 前端性能问题
        - 浏览器兼容性问题

    # 后端专家
    - name: "backend-expert"
      role: "member"
      botRef:
        name: backend-expert-bot
        namespace: default
      prompt: |
        你是后端技术专家,负责解决:
        - API 设计和实现问题
        - 服务器性能问题
        - 业务逻辑问题

    # 数据库专家
    - name: "database-expert"
      role: "member"
      botRef:
        name: database-expert-bot
        namespace: default
      prompt: |
        你是数据库专家,负责解决:
        - SQL 查询优化
        - 数据库设计问题
        - 数据迁移问题

status:
  state: "Available"
```

### 示例 3: 代码分析团队 (Coordinate 模式)

**场景**: 多角度并行分析代码

```yaml
apiVersion: agent.wecode.io/v1
kind: Team
metadata:
  name: code-analysis-team
  namespace: default
spec:
  # Coordinate 模式: 并行分析后汇总
  collaborationModel: "coordinate"

  members:
    # Coordinator - 协调和汇总
    - name: "analysis-coordinator"
      role: "leader"
      botRef:
        name: coordinator-bot
        namespace: default
      prompt: |
        你是代码分析协调者,负责:
        - 分配代码给不同的分析器
        - 收集各个分析器的结果
        - 汇总生成综合分析报告
        - 按优先级排列问题

    # 安全分析器
    - name: "security-analyzer"
      role: "member"
      botRef:
        name: security-bot
        namespace: default
      prompt: |
        从安全角度分析代码:
        - 查找安全漏洞
        - 检查认证授权问题
        - 识别敏感信息泄露
        - 提供安全加固建议

    # 性能分析器
    - name: "performance-analyzer"
      role: "member"
      botRef:
        name: performance-bot
        namespace: default
      prompt: |
        从性能角度分析代码:
        - 识别性能瓶颈
        - 检查算法复杂度
        - 分析数据库查询效率
        - 提供优化建议

    # 质量分析器
    - name: "quality-analyzer"
      role: "member"
      botRef:
        name: quality-bot
        namespace: default
      prompt: |
        从质量角度分析代码:
        - 检查代码规范
        - 评估可维护性
        - 检查测试覆盖率
        - 识别代码异味

status:
  state: "Available"
```

### 示例 4: 设计讨论团队 (Collaborate 模式)

**场景**: 架构设计讨论和决策

```yaml
apiVersion: agent.wecode.io/v1
kind: Team
metadata:
  name: architecture-design-team
  namespace: default
spec:
  # Collaborate 模式: 自由讨论和协作
  collaborationModel: "collaborate"

  members:
    # 架构师
    - name: "architect"
      role: "member"
      botRef:
        name: architect-bot
        namespace: default
      prompt: |
        你是系统架构师,从架构角度参与讨论:
        - 提出架构设计方案
        - 评估技术选型
        - 考虑系统可扩展性
        - 关注长期演进

    # 后端专家
    - name: "backend-lead"
      role: "member"
      botRef:
        name: backend-lead-bot
        namespace: default
      prompt: |
        你是后端技术负责人,从后端角度参与讨论:
        - 评估后端实现可行性
        - 提出 API 设计建议
        - 考虑数据存储方案
        - 关注性能和安全

    # 前端专家
    - name: "frontend-lead"
      role: "member"
      botRef:
        name: frontend-lead-bot
        namespace: default
      prompt: |
        你是前端技术负责人,从前端角度参与讨论:
        - 评估前端实现可行性
        - 提出用户体验建议
        - 考虑前端架构方案
        - 关注性能和可访问性

    # DevOps 专家
    - name: "devops-lead"
      role: "member"
      botRef:
        name: devops-bot
        namespace: default
      prompt: |
        你是 DevOps 负责人,从运维角度参与讨论:
        - 评估部署和运维难度
        - 提出自动化方案
        - 考虑监控和告警
        - 关注可靠性和成本

status:
  state: "Available"
```

### 示例 5: 简单开发团队 (单个 Leader)

**场景**: 小型项目,一个 Bot 完成所有工作

```yaml
apiVersion: agent.wecode.io/v1
kind: Team
metadata:
  name: solo-developer-team
  namespace: default
spec:
  collaborationModel: "pipeline"

  members:
    - name: "solo-developer"
      role: "leader"
      botRef:
        name: fullstack-developer-bot
        namespace: default
      prompt: |
        你是项目的唯一开发者,负责:
        - 分析需求
        - 设计和实现功能
        - 编写测试
        - 提交代码
        - 创建 Pull Request

status:
  state: "Available"
```

---

## ✨ 最佳实践

### 1. 团队规模

#### ✅ 推荐

**小团队 (2-3 个成员)**:
- 启动快,协调简单
- 适合简单任务
- 成本较低

**中等团队 (4-6 个成员)**:
- 分工明确
- 适合复杂任务
- 平衡效率和成本

**大团队 (7+ 个成员)**:
- 高度专业化
- 适合超大型项目
- 需要精心协调

#### ❌ 避免

- 团队过大 (超过 10 个成员) - 协调成本高
- 团队过小 (只有 1 个成员) - 失去协作优势

### 2. 角色分配

#### ✅ 推荐

```yaml
# Pipeline 模式: 不需要 Leader
members:
  - name: "dev"
    role: "member"  # 所有成员都是 member
  - name: "test"
    role: "member"

# Route/Coordinate 模式: 需要 Leader
members:
  - name: "coordinator"
    role: "leader"  # 一个 Leader
  - name: "worker1"
    role: "member"
  - name: "worker2"
    role: "member"
```

#### ❌ 避免

```yaml
# 错误: Pipeline 模式不需要 Leader
collaborationModel: "pipeline"
members:
  - role: "leader"  # 不必要

# 错误: Route 模式缺少 Leader
collaborationModel: "route"
members:
  - role: "member"  # 谁来路由?
  - role: "member"
```

### 3. 成员提示词设计

#### ✅ 推荐

**清晰的职责定义**:
```yaml
prompt: |
  你是团队的前端开发者,负责:
  - React 组件开发
  - UI/UX 实现
  - 前端性能优化

  工作准则:
  - 遵循团队代码规范
  - 编写类型安全的代码
  - 与后端开发者协作
```

**包含协作指导**:
```yaml
prompt: |
  你负责代码审查。

  在审查时:
  - 与开发者友好沟通
  - 提供建设性意见
  - 认可好的设计

  审查完成后:
  - 将结果传递给测试工程师
```

#### ❌ 避免

**过于简单**:
```yaml
prompt: "你是开发者"  # 太简单,缺乏指导
```

**缺乏协作上下文**:
```yaml
prompt: |
  你负责前端开发。
  # 缺少: 如何与其他成员协作?
```

### 4. 协作模式选择

#### 决策树

```
任务需要顺序执行?
├─ 是 → Pipeline
└─ 否
    └─ 任务需要分类处理?
        ├─ 是 → Route
        └─ 否
            └─ 任务可以并行?
                ├─ 是 → Coordinate
                └─ 否 → Collaborate
```

### 5. 成本优化

#### 策略 1: 混合使用不同模型

```yaml
members:
  # 核心成员使用强大模型
  - name: "lead-developer"
    botRef:
      name: developer-bot-sonnet  # Sonnet

  # 辅助成员使用经济模型
  - name: "doc-writer"
    botRef:
      name: doc-bot-haiku  # Haiku
```

#### 策略 2: 按需调整团队规模

```yaml
# 简单任务 - 小团队
apiVersion: agent.wecode.io/v1
kind: Team
metadata:
  name: simple-task-team
spec:
  members:  # 只有 2 个成员
    - name: "developer"
    - name: "reviewer"

# 复杂任务 - 大团队
apiVersion: agent.wecode.io/v1
kind: Team
metadata:
  name: complex-task-team
spec:
  members:  # 5 个成员
    - name: "architect"
    - name: "frontend-dev"
    - name: "backend-dev"
    - name: "tester"
    - name: "reviewer"
```

### 6. 命名规范

#### ✅ 推荐

```yaml
# Team 名称
name: fullstack-dev-team
name: code-review-team
name: data-analysis-team

# 成员名称
members:
  - name: "frontend-developer"
  - name: "backend-developer"
  - name: "code-reviewer"
```

#### ❌ 避免

```yaml
# 不好的 Team 名称
name: team1
name: my-team
name: test

# 不好的成员名称
members:
  - name: "bot1"
  - name: "member"
```

---

## 🔧 高级技巧

### 技巧 1: 动态角色分配

通过成员提示词实现动态角色:

```yaml
members:
  - name: "adaptive-bot"
    prompt: |
      根据任务类型调整你的角色:
      - 如果是前端任务,作为前端开发者
      - 如果是后端任务,作为后端开发者
      - 如果是测试任务,作为测试工程师
```

### 技巧 2: 层级团队

创建多层级的团队结构:

```yaml
# 高层团队 - 架构设计
apiVersion: agent.wecode.io/v1
kind: Team
metadata:
  name: architecture-team
spec:
  members:
    - name: "chief-architect"
    - name: "tech-lead"
---
# 执行团队 - 具体开发
apiVersion: agent.wecode.io/v1
kind: Team
metadata:
  name: implementation-team
spec:
  members:
    - name: "frontend-dev"
    - name: "backend-dev"
    - name: "tester"
```

### 技巧 3: 专业化子团队

为不同的技术栈创建专门的团队:

```yaml
# React 前端团队
---
apiVersion: agent.wecode.io/v1
kind: Team
metadata:
  name: react-frontend-team
spec:
  members:
    - name: "react-developer"
    - name: "ui-designer"
    - name: "frontend-tester"
---
# Python 后端团队
apiVersion: agent.wecode.io/v1
kind: Team
metadata:
  name: python-backend-team
spec:
  members:
    - name: "python-developer"
    - name: "api-designer"
    - name: "backend-tester"
```

---

## ⚠️ 常见问题

### Q1: Team 创建后如何使用?

**答**: 通过 Task 来使用 Team:

```yaml
apiVersion: agent.wecode.io/v1
kind: Task
metadata:
  name: implement-feature
spec:
  teamRef:
    name: fullstack-dev-team  # 引用 Team
    namespace: default
  prompt: "实现用户登录功能"
```

### Q2: 可以修改正在运行的 Team 吗?

**答**: 不建议。如果需要修改:

1. 取消或完成当前任务
2. 更新 Team 配置
3. 创建新任务

### Q3: 一个 Bot 可以属于多个 Team 吗?

**答**: 可以!一个 Bot 可以被多个 Team 引用:

```yaml
# Team 1
---
apiVersion: agent.wecode.io/v1
kind: Team
metadata:
  name: team-1
spec:
  members:
    - botRef:
        name: shared-bot  # 共享 Bot
---
# Team 2
apiVersion: agent.wecode.io/v1
kind: Team
metadata:
  name: team-2
spec:
  members:
    - botRef:
        name: shared-bot  # 同一个 Bot
```

### Q4: 如何调试 Team 的协作问题?

**答**:

1. **查看 Task 日志**: 了解每个 Bot 的输出
2. **简化团队**: 减少成员,隔离问题
3. **检查提示词**: 确保成员提示词清晰
4. **验证 Bot**: 单独测试每个 Bot

### Q5: 哪种协作模式最好?

**答**: 没有"最好"的模式,取决于任务:

| 任务类型 | 推荐模式 | 原因 |
|----------|----------|------|
| 开发流程 | Pipeline | 顺序执行效率高 |
| 问题分类 | Route | 针对性强 |
| 多角度分析 | Coordinate | 并行快速 |
| 头脑风暴 | Collaborate | 充分讨论 |

### Q6: Team 的成本如何计算?

**答**:

```
Team 成本 = Σ(每个 Bot 的成本)

优化建议:
- 使用必要的成员数量
- 混合使用不同级别的模型
- 选择高效的协作模式
```

### Q7: 如何处理 Team 执行失败?

**答**:

1. **检查 Bot 状态**: 确保所有 Bot 可用
2. **检查引用**: 验证所有 botRef 正确
3. **简化任务**: 将复杂任务拆分
4. **查看日志**: 分析失败原因

### Q8: Leader 和 Member 有什么区别?

**答**:

| 角色 | 职责 | 适用场景 |
|------|------|----------|
| Leader | 协调、路由、汇总 | Route, Coordinate 模式 |
| Member | 执行具体任务 | 所有模式 |

**注意**: Pipeline 模式通常不需要 Leader。

---

## 📊 完整示例: 企业级开发团队

### 场景描述

创建一个完整的企业级开发团队,包含:
- 架构设计阶段 (Collaborate)
- 开发实现阶段 (Pipeline)
- 质量保证阶段 (Coordinate)

### 完整配置

```yaml
# ==========================================
# 阶段 1: 架构设计团队
# ==========================================
apiVersion: agent.wecode.io/v1
kind: Team
metadata:
  name: architecture-design-team
  namespace: enterprise
spec:
  collaborationModel: "collaborate"
  members:
    - name: "chief-architect"
      role: "member"
      botRef:
        name: chief-architect-bot
        namespace: enterprise
      prompt: |
        你是首席架构师,负责:
        - 设计系统整体架构
        - 评估技术选型
        - 制定技术标准
        - 确保架构可扩展性和可维护性

    - name: "backend-architect"
      role: "member"
      botRef:
        name: backend-architect-bot
        namespace: enterprise
      prompt: |
        你是后端架构师,负责:
        - 设计后端服务架构
        - 设计数据库模型
        - 规划 API 接口
        - 考虑后端性能和安全

    - name: "frontend-architect"
      role: "member"
      botRef:
        name: frontend-architect-bot
        namespace: enterprise
      prompt: |
        你是前端架构师,负责:
        - 设计前端应用架构
        - 规划组件结构
        - 选择前端技术栈
        - 考虑用户体验和性能

---
# ==========================================
# 阶段 2: 开发实现团队
# ==========================================
apiVersion: agent.wecode.io/v1
kind: Team
metadata:
  name: implementation-team
  namespace: enterprise
spec:
  collaborationModel: "pipeline"
  members:
    - name: "frontend-developer"
      role: "member"
      botRef:
        name: frontend-developer-bot
        namespace: enterprise
      prompt: |
        你是前端开发工程师,负责:
        - 实现 UI 组件和页面
        - 对接后端 API
        - 优化前端性能
        - 确保代码质量

    - name: "backend-developer"
      role: "member"
      botRef:
        name: backend-developer-bot
        namespace: enterprise
      prompt: |
        你是后端开发工程师,负责:
        - 实现业务逻辑
        - 开发 RESTful API
        - 设计和优化数据库
        - 编写后端测试

    - name: "code-reviewer"
      role: "member"
      botRef:
        name: senior-reviewer-bot
        namespace: enterprise
      prompt: |
        你是资深代码审查者,负责:
        - 审查代码质量
        - 检查安全问题
        - 确保符合规范
        - 提供改进建议

---
# ==========================================
# 阶段 3: 质量保证团队
# ==========================================
apiVersion: agent.wecode.io/v1
kind: Team
metadata:
  name: quality-assurance-team
  namespace: enterprise
spec:
  collaborationModel: "coordinate"
  members:
    - name: "qa-coordinator"
      role: "leader"
      botRef:
        name: qa-coordinator-bot
        namespace: enterprise
      prompt: |
        你是 QA 协调者,负责:
        - 协调各类测试活动
        - 收集测试结果
        - 生成质量报告
        - 决定是否可以发布

    - name: "unit-tester"
      role: "member"
      botRef:
        name: unit-test-bot
        namespace: enterprise
      prompt: |
        你负责单元测试:
        - 编写单元测试用例
        - 确保测试覆盖率 >80%
        - 运行测试并报告结果

    - name: "integration-tester"
      role: "member"
      botRef:
        name: integration-test-bot
        namespace: enterprise
      prompt: |
        你负责集成测试:
        - 编写集成测试用例
        - 测试 API 接口
        - 测试服务间交互
        - 验证数据流

    - name: "security-tester"
      role: "member"
      botRef:
        name: security-test-bot
        namespace: enterprise
      prompt: |
        你负责安全测试:
        - 检查安全漏洞
        - 测试认证授权
        - 检查数据加密
        - 进行渗透测试

    - name: "performance-tester"
      role: "member"
      botRef:
        name: performance-test-bot
        namespace: enterprise
      prompt: |
        你负责性能测试:
        - 进行负载测试
        - 分析性能瓶颈
        - 测试并发能力
        - 提供优化建议
```

---

## 🔗 相关资源

### 前置步骤
- [创建 Ghost](./creating-ghosts.md) - 定义团队成员的"灵魂"
- [创建 Bot](./creating-bots.md) - 组装完整的团队成员

### 下一步
- [管理 Task](./managing-tasks.md) - 将任务分配给 Team

### 参考文档
- [核心概念 - 协作模式](../../concepts/core-concepts.md#-collaboration) - 深入理解协作模式
- [YAML 规范 - Team](../../reference/yaml-specification.md#-team) - 完整配置格式

---

## 💬 获取帮助

遇到问题?

- 📖 查看 [FAQ](../../faq.md)
- 🐛 提交 [GitHub Issue](https://github.com/wecode-ai/wegent/issues)
- 💬 加入社区讨论

---

<p align="center">组建您的第一个 AI 团队,体验协作的力量! 🚀</p>
