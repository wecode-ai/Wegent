# 🎯 管理 Task (任务)

Task 是 Wegent 中的可执行工作单元,将用户需求分配给 Team 或 Bot 执行。本指南将教您如何创建、管理和监控任务。

---

## 📋 目录

- [什么是 Task](#-什么是-task)
- [核心概念](#-核心概念)
- [创建步骤](#-创建步骤)
- [配置详解](#-配置详解)
- [任务生命周期](#-任务生命周期)
- [实战示例](#-实战示例)
- [最佳实践](#-最佳实践)
- [常见问题](#-常见问题)
- [相关资源](#-相关资源)

---

## 🎯 什么是 Task

Task 是用户需求和 AI 智能体之间的桥梁,定义了"要做什么"以及"由谁来做"。

**类比**:
```
真实世界                →  Wegent
-------------------    →  -------------------
工作任务单             →  Task
分配给团队             →  teamRef
在项目中执行           →  workspaceRef
任务描述               →  prompt
```

### Task 的组成

```
Task = 任务描述 + 执行团队 + 工作空间 + 状态跟踪
```

---

## 🧩 核心概念

### Task 的四大要素

| 要素 | 说明 | 示例 |
|------|------|------|
| **Prompt** | 任务描述和需求 | "实现用户登录功能" |
| **Team** | 执行任务的团队 | fullstack-dev-team |
| **Workspace** | 工作环境和代码仓库 | project-workspace |
| **Status** | 任务执行状态 | PENDING → RUNNING → COMPLETED |

### Task vs Team

| 概念 | 说明 | 性质 |
|------|------|------|
| **Team** | 智能体团队定义 | 静态资源 |
| **Task** | 分配给 Team 的工作 | 动态执行单元 |

**关系**:
```
Team (定义) + Task (工作) = 实际执行
```

---

## 🚀 创建步骤

### 步骤 1: 准备前置资源

在创建 Task 之前,确保以下资源已准备:

**必需资源**:
- ✅ **Team**: 已创建并且状态为 Available
- ✅ **Workspace**: 已配置代码仓库信息

**检查清单**:
```bash
# 检查 Team 是否可用
kubectl get team <team-name> -n default

# 检查 Workspace 是否配置
kubectl get workspace <workspace-name> -n default
```

### 步骤 2: 明确任务需求

清晰定义任务的具体需求:

**好的任务描述**:
- ✅ 具体明确
- ✅ 包含验收标准
- ✅ 说明技术要求
- ✅ 提供必要的上下文

**示例**:
```
✅ 好: "使用 React 和 TypeScript 实现用户登录页面,
      包含邮箱和密码输入框,表单验证,以及登录 API 调用。
      需要编写单元测试,测试覆盖率 >80%。"

❌ 差: "做一个登录功能"
```

### 步骤 3: 选择合适的团队

根据任务类型选择对应的 Team:

| 任务类型 | 推荐 Team |
|----------|-----------|
| 全栈开发 | fullstack-dev-team |
| 前端开发 | frontend-team |
| 代码审查 | code-review-team |
| Bug 修复 | bugfix-team |
| 文档编写 | documentation-team |

### 步骤 4: 配置工作空间

选择或创建合适的 Workspace:

```yaml
# 确保 Workspace 指向正确的仓库和分支
apiVersion: agent.wecode.io/v1
kind: Workspace
metadata:
  name: my-project-workspace
spec:
  repository:
    gitUrl: "https://github.com/user/repo.git"
    gitRepo: "user/repo"
    branchName: "main"
    gitDomain: "github.com"
```

### 步骤 5: 创建 Task 配置

编写 Task 的 YAML 配置。

### 步骤 6: 提交和监控

提交 Task 并持续监控执行状态。

---

## 📝 配置详解

### 基本配置结构

```yaml
apiVersion: agent.wecode.io/v1
kind: Task
metadata:
  name: <task-name>
  namespace: default
spec:
  title: <task-title>
  prompt: <detailed-task-description>
  teamRef:
    name: <team-name>
    namespace: default
  workspaceRef:
    name: <workspace-name>
    namespace: default
status:
  state: "Available"
  status: "PENDING"
  progress: 0
  result: null
  errorMessage: null
```

### 字段说明

#### metadata 部分

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | Task 的唯一标识符 |
| `namespace` | string | 是 | 命名空间,通常为 `default` |

#### spec 部分

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `title` | string | 是 | 任务标题 (简短描述) |
| `prompt` | string | 是 | 详细的任务描述和需求 |
| `teamRef` | object | 是 | 执行任务的 Team 引用 |
| `workspaceRef` | object | 是 | 工作空间引用 |
| `model_id` | string | 否 | 覆盖 Bot 默认模型的模型名称 |
| `force_override_bot_model` | boolean | 否 | 强制使用指定模型，即使 Bot 已配置模型 |

### 单任务模型选择

通过 Web 界面创建任务时，您可以选择不同的模型:

1. **模型选择器**: 在聊天输入区域，使用模型下拉框从可用模型中选择
2. **强制覆盖**: 启用此选项以确保无论 Bot 配置如何都使用您选择的模型

**使用场景**:
- 在不修改 Bot 配置的情况下测试不同模型
- 对复杂的一次性任务使用更强大的模型
- 对简单查询使用更便宜/更快的模型

### 联网搜索与搜索引擎

当使用 Chat Shell 且系统启用了联网搜索功能时：

1. **联网搜索开关**: 点击地球图标开启或关闭联网搜索能力。
2. **搜索引擎选择**: 通过下拉菜单选择您偏好的搜索引擎（如 Google、Bing 等）。

#### status 部分

| 字段 | 类型 | 说明 |
|------|------|------|
| `state` | string | 资源状态: `Available`, `Unavailable` |
| `status` | string | 执行状态: `PENDING`, `RUNNING`, `COMPLETED`, `FAILED`, `CANCELLED` |
| `progress` | number | 进度百分比 (0-100) |
| `result` | string | 任务执行结果 |
| `errorMessage` | string | 错误信息 (如果失败) |

### 任务状态详解

| 状态 | 说明 | 下一步 |
|------|------|--------|
| `PENDING` | 等待执行 | 系统会自动开始执行 |
| `RUNNING` | 正在执行 | 监控进度和日志 |
| `COMPLETED` | 成功完成 | 查看结果,验收 |
| `FAILED` | 执行失败 | 检查错误,修复后重试 |
| `CANCELLED` | 已取消 | 如需要,重新创建 |

---

## 🔄 任务生命周期

### 标准流程

```
1. PENDING (创建)
   ↓
2. RUNNING (执行中)
   ↓
3. COMPLETED (成功)
   或
   FAILED (失败)
   或
   CANCELLED (取消)
```

### 详细阶段

#### 阶段 1: 创建 (PENDING)

```yaml
# 提交 Task
kubectl apply -f task.yaml

# 状态: PENDING
status:
  status: "PENDING"
  progress: 0
```

#### 阶段 2: 执行 (RUNNING)

```yaml
# 系统自动开始执行
status:
  status: "RUNNING"
  progress: 50  # 进度更新
```

**执行过程**:
1. Wegent 创建 Team 实例
2. 分配 Workspace
3. Team 成员开始协作
4. 持续更新进度

#### 阶段 3: 完成 (COMPLETED)

```yaml
# 任务成功完成
status:
  status: "COMPLETED"
  progress: 100
  result: |
    任务已完成!
    - 创建了新分支: feature/user-login
    - 提交了 5 个 commits
    - 创建了 Pull Request #123
```

#### 阶段 4: 失败 (FAILED)

```yaml
# 任务执行失败
status:
  status: "FAILED"
  progress: 60
  errorMessage: "编译错误: TypeScript 类型检查失败"
```

#### 阶段 5: 取消 (CANCELLED)

```yaml
# 用户主动取消
status:
  status: "CANCELLED"
  progress: 30
```

---

## 💡 实战示例

### 示例 1: 实现新功能

```yaml
apiVersion: agent.wecode.io/v1
kind: Task
metadata:
  name: implement-user-login
  namespace: default
spec:
  title: "实现用户登录功能"

  prompt: |
    请实现完整的用户登录功能,包括:

    ## 功能需求
    1. 用户登录页面 (React + TypeScript)
       - 邮箱输入框 (带验证)
       - 密码输入框 (隐藏显示)
       - 记住我选项
       - 登录按钮

    2. 前端逻辑
       - 表单验证 (邮箱格式、密码长度)
       - 调用登录 API
       - 处理成功/失败响应
       - 保存 Token 到 localStorage

    3. 后端 API (FastAPI)
       - POST /api/auth/login
       - 验证用户凭证
       - 生成 JWT Token
       - 返回用户信息

    4. 测试
       - 前端单元测试 (覆盖率 >80%)
       - API 集成测试
       - E2E 测试

    ## 技术要求
    - 前端: React 18, TypeScript, Tailwind CSS
    - 后端: FastAPI, SQLAlchemy, JWT
    - 遵循项目现有代码规范

    ## 验收标准
    - 所有测试通过
    - 代码审查通过
    - 在测试环境验证功能正常

  teamRef:
    name: fullstack-dev-team
    namespace: default

  workspaceRef:
    name: main-project-workspace
    namespace: default

status:
  state: "Available"
  status: "PENDING"
```

### 示例 2: Bug 修复

```yaml
apiVersion: agent.wecode.io/v1
kind: Task
metadata:
  name: fix-login-redirect-bug
  namespace: default
spec:
  title: "修复登录后重定向失败的 Bug"

  prompt: |
    ## Bug 描述
    用户登录成功后,应该重定向到仪表盘页面 (/dashboard),
    但实际停留在登录页面,没有发生跳转。

    ## 重现步骤
    1. 访问登录页面 /login
    2. 输入有效的邮箱和密码
    3. 点击登录按钮
    4. 登录成功,但页面未跳转

    ## 预期行为
    登录成功后应该自动跳转到 /dashboard 页面

    ## 环境信息
    - 浏览器: Chrome 120
    - 分支: main
    - 相关代码: src/pages/Login.tsx

    ## 调试建议
    1. 检查 React Router 配置
    2. 查看登录成功的回调函数
    3. 检查是否有错误日志
    4. 验证 Token 保存是否成功

    ## 验收标准
    - Bug 已修复
    - 添加相关测试防止回归
    - 在开发环境验证修复

  teamRef:
    name: bugfix-team
    namespace: default

  workspaceRef:
    name: main-project-workspace
    namespace: default
```

### 示例 3: 代码审查

```yaml
apiVersion: agent.wecode.io/v1
kind: Task
metadata:
  name: review-pr-123
  namespace: default
spec:
  title: "审查 Pull Request #123"

  prompt: |
    请审查 Pull Request #123: "Add user profile page"

    ## 审查重点
    1. 代码质量
       - 是否符合项目规范
       - 命名是否清晰合理
       - 是否有代码重复

    2. 功能实现
       - 是否满足需求
       - 边界情况处理
       - 错误处理是否完善

    3. 测试
       - 测试覆盖是否充分
       - 测试用例是否合理
       - 是否有集成测试

    4. 性能和安全
       - 是否有性能问题
       - 是否有安全隐患
       - API 调用是否优化

    5. 文档
       - 是否需要更新文档
       - 代码注释是否清晰
       - README 是否需要更新

    ## 输出格式
    请按以下格式提供审查意见:

    ### ✅ 优点
    - ...

    ### 🔴 严重问题 (必须修复)
    - ...

    ### 🟡 一般问题 (建议修复)
    - ...

    ### 💡 改进建议
    - ...

  teamRef:
    name: code-review-team
    namespace: default

  workspaceRef:
    name: main-project-workspace
    namespace: default
```

### 示例 4: 性能优化

```yaml
apiVersion: agent.wecode.io/v1
kind: Task
metadata:
  name: optimize-dashboard-performance
  namespace: default
spec:
  title: "优化仪表盘页面性能"

  prompt: |
    ## 背景
    仪表盘页面加载时间过长 (>5s),用户体验差,
    需要进行性能优化。

    ## 当前性能指标
    - 首次内容绘制 (FCP): 3.2s
    - 最大内容绘制 (LCP): 5.8s
    - 首次输入延迟 (FID): 280ms
    - 累积布局偏移 (CLS): 0.15

    ## 优化目标
    - FCP < 1.5s
    - LCP < 2.5s
    - FID < 100ms
    - CLS < 0.1

    ## 优化方向
    1. 代码层面
       - 使用 React.memo 减少不必要的重渲染
       - 实现虚拟滚动处理长列表
       - 懒加载非关键组件
       - 优化状态管理

    2. 资源层面
       - 图片优化和懒加载
       - 代码分割和按需加载
       - 压缩和缓存静态资源

    3. 数据层面
       - 优化 API 调用
       - 实现数据分页
       - 添加缓存策略

    ## 验收标准
    - 性能指标达到目标值
    - 在 Lighthouse 中评分 >90
    - 不影响现有功能
    - 添加性能监控

  teamRef:
    name: performance-optimization-team
    namespace: default

  workspaceRef:
    name: main-project-workspace
    namespace: default
```

### 示例 5: 文档编写

```yaml
apiVersion: agent.wecode.io/v1
kind: Task
metadata:
  name: write-api-documentation
  namespace: default
spec:
  title: "编写 API 文档"

  prompt: |
    请为项目的 REST API 编写完整的文档。

    ## 文档要求
    1. API 概览
       - 基础 URL
       - 认证方式
       - 通用请求/响应格式
       - 错误码说明

    2. 端点文档
       对每个 API 端点提供:
       - 端点路径和方法
       - 请求参数 (路径/查询/请求体)
       - 响应格式和示例
       - 可能的错误码
       - 代码示例 (curl, JavaScript)

    3. 认证和授权
       - 如何获取 Token
       - Token 使用方式
       - 权限说明

    4. 最佳实践
       - 请求限流说明
       - 缓存策略
       - 版本控制

    ## 格式要求
    - 使用 Markdown 格式
    - 清晰的目录结构
    - 包含实际可运行的示例
    - 添加 OpenAPI/Swagger 规范

    ## 输出位置
    - 主文档: docs/api/README.md
    - OpenAPI 规范: docs/api/openapi.yaml

  teamRef:
    name: documentation-team
    namespace: default

  workspaceRef:
    name: main-project-workspace
    namespace: default
```

### 示例 6: 重构代码

```yaml
apiVersion: agent.wecode.io/v1
kind: Task
metadata:
  name: refactor-auth-module
  namespace: default
spec:
  title: "重构认证模块"

  prompt: |
    ## 重构目标
    认证模块代码混乱,需要重构以提高可维护性。

    ## 当前问题
    1. 代码重复
       - 多处重复的验证逻辑
       - Token 处理逻辑分散

    2. 结构混乱
       - 业务逻辑和 UI 代码混在一起
       - 缺乏清晰的分层

    3. 难以测试
       - 过多的副作用
       - 依赖难以 mock

    ## 重构方案
    1. 提取公共逻辑
       - 创建 AuthService 类
       - 统一 Token 管理
       - 提取验证函数

    2. 分层架构
       - UI 层: 只负责展示
       - 逻辑层: 业务逻辑处理
       - 数据层: API 调用

    3. 提高可测试性
       - 使用依赖注入
       - 减少副作用
       - 添加单元测试

    ## 注意事项
    - 保持功能不变
    - 确保向后兼容
    - 分步骤提交
    - 每步都运行测试

    ## 验收标准
    - 所有测试通过
    - 代码覆盖率提升
    - 代码复杂度降低
    - 无功能回归

  teamRef:
    name: refactoring-team
    namespace: default

  workspaceRef:
    name: main-project-workspace
    namespace: default
```

---

## ✨ 最佳实践

### 1. 任务描述编写

#### ✅ 推荐: SMART 原则

- **S**pecific (具体): 明确说明要做什么
- **M**easurable (可衡量): 有明确的验收标准
- **A**chievable (可实现): 任务范围合理
- **R**elevant (相关): 与项目目标相关
- **T**ime-bound (有时限): 明确期望完成时间

**好的示例**:
```yaml
prompt: |
  实现用户注册 API:
  - POST /api/auth/register
  - 接受邮箱、密码、用户名
  - 验证邮箱格式和密码强度
  - 保存用户到数据库
  - 返回用户信息和 Token
  - 编写单元测试 (覆盖率 >80%)
  - 更新 API 文档
```

#### ❌ 避免: 模糊描述

```yaml
prompt: "做一个注册功能"  # 太简单
prompt: "优化系统"  # 太宽泛
```

### 2. 任务粒度

#### ✅ 推荐: 适中的任务粒度

```yaml
# 好 - 单个功能
title: "实现用户登录页面"

# 好 - 单个 Bug 修复
title: "修复登录重定向问题"

# 不好 - 太大
title: "开发整个用户管理系统"

# 不好 - 太小
title: "修改一个变量名"
```

**建议粒度**:
- 小任务: 1-2 小时
- 中等任务: 4-8 小时
- 大任务: 1-2 天

### 3. 上下文信息

#### ✅ 提供充足的上下文

```yaml
prompt: |
  ## 背景
  项目使用 FastAPI + React 技术栈...

  ## 现有实现
  当前登录使用基础认证,需要升级为 JWT...

  ## 相关代码
  - 后端: src/api/auth.py
  - 前端: src/pages/Login.tsx

  ## 依赖
  需要安装 python-jose 库...

  ## 参考
  类似实现见 /api/refresh-token
```

### 4. 验收标准

#### ✅ 明确的验收标准

```yaml
prompt: |
  ...

  ## 验收标准
  - [ ] 所有单元测试通过
  - [ ] 集成测试通过
  - [ ] 代码审查通过
  - [ ] 在测试环境部署验证
  - [ ] 性能测试达标
  - [ ] 文档已更新
```

### 5. 任务监控

#### ✅ 定期检查任务状态

```bash
# 查看任务状态
kubectl get task <task-name> -n default

# 查看详细信息
kubectl describe task <task-name> -n default

# 查看执行日志
kubectl logs <task-pod> -n default
```

### 6. 错误处理

#### 任务失败时的处理流程

```
1. 查看错误信息
   kubectl describe task <task-name>

2. 分析失败原因
   - 配置错误?
   - Team 不可用?
   - 任务描述不清?

3. 修复问题
   - 更新配置
   - 修复 Team
   - 优化 prompt

4. 重新创建任务
   kubectl delete task <task-name>
   kubectl apply -f task-fixed.yaml
```

### 7. 成本优化

#### 策略 1: 合理选择 Team

```yaml
# 简单任务 - 使用小团队
teamRef:
  name: solo-developer-team  # 只有 1 个 Bot

# 复杂任务 - 使用完整团队
teamRef:
  name: fullstack-dev-team  # 多个 Bot 协作
```

#### 策略 2: 任务拆分

```yaml
# 不好 - 一个大任务
title: "开发整个电商系统"

# 好 - 拆分成多个小任务
---
title: "实现商品列表页面"
---
title: "实现购物车功能"
---
title: "实现订单系统"
```

---

## 🔧 高级技巧

### 技巧 1: 任务模板

创建常用任务的模板:

```yaml
# templates/feature-task.yaml
apiVersion: agent.wecode.io/v1
kind: Task
metadata:
  name: ${TASK_NAME}
  namespace: default
spec:
  title: "${TASK_TITLE}"
  prompt: |
    ## 功能需求
    ${REQUIREMENTS}

    ## 技术要求
    ${TECH_STACK}

    ## 验收标准
    ${ACCEPTANCE_CRITERIA}

  teamRef:
    name: fullstack-dev-team
    namespace: default
  workspaceRef:
    name: ${WORKSPACE_NAME}
    namespace: default
```

### 技巧 2: 任务链

创建依赖的任务序列:

```yaml
# Task 1: 实现功能
---
apiVersion: agent.wecode.io/v1
kind: Task
metadata:
  name: implement-feature
spec:
  title: "实现功能"
  # ...

# Task 2: 代码审查 (依赖 Task 1)
---
apiVersion: agent.wecode.io/v1
kind: Task
metadata:
  name: review-feature
spec:
  title: "审查 Task 1 的代码"
  prompt: "审查 PR #${PR_NUMBER}..."
  # ...

# Task 3: 部署 (依赖 Task 2)
---
apiVersion: agent.wecode.io/v1
kind: Task
metadata:
  name: deploy-feature
spec:
  title: "部署到测试环境"
  # ...
```

### 技巧 3: 条件任务

根据条件创建不同的任务:

```yaml
# 如果是 Bug 修复
apiVersion: agent.wecode.io/v1
kind: Task
metadata:
  name: fix-bug
spec:
  teamRef:
    name: bugfix-team  # 使用 Bug 修复团队
  # ...

# 如果是新功能
---
apiVersion: agent.wecode.io/v1
kind: Task
metadata:
  name: new-feature
spec:
  teamRef:
    name: fullstack-dev-team  # 使用开发团队
  # ...
```

---

## ⚠️ 常见问题

### Q1: Task 一直处于 PENDING 状态?

**可能原因**:
1. Team 不可用
2. Workspace 配置错误
3. 系统资源不足

**解决方案**:
```bash
# 1. 检查 Team 状态
kubectl get team <team-name> -n default

# 2. 检查 Workspace 状态
kubectl get workspace <workspace-name> -n default

# 3. 查看 Task 详细信息
kubectl describe task <task-name> -n default

# 4. 查看系统日志
kubectl logs -n wegent-system <executor-pod>
```

### Q2: Task 执行失败怎么办?

**答**: 按以下步骤排查:

```
1. 查看错误信息
   status.errorMessage 字段

2. 检查任务描述
   是否清晰明确?

3. 验证 Team 能力
   Team 是否有能力完成任务?

4. 检查 Workspace
   代码仓库是否可访问?

5. 重试
   修复问题后重新创建 Task
```

### Q3: 如何取消正在执行的 Task?

**答**:
```bash
# 方式 1: 通过 kubectl
kubectl patch task <task-name> -n default \
  -p '{"status":{"status":"CANCELLED"}}'

# 方式 2: 通过 API
curl -X PATCH /api/tasks/<task-id> \
  -d '{"status":"CANCELLED"}'
```

### Q4: Task 可以暂停吗?

**答**: Wegent 目前不支持任务暂停,只能:
- 取消任务
- 完成后再创建新任务

### Q5: 如何查看 Task 的执行日志?

**答**:
```bash
# 方式 1: 查看 Task 详情
kubectl describe task <task-name> -n default

# 方式 2: 查看执行器日志
kubectl logs <executor-pod> -n wegent-system -f

# 方式 3: 通过 Web 界面
访问 Wegent UI 查看任务详情页
```

### Q6: Task 完成后如何验收?

**答**: 验收检查清单:

```
✅ 检查任务状态
   status.status == "COMPLETED"

✅ 查看执行结果
   status.result 包含完成信息

✅ 验证代码变更
   - 查看 Git 提交
   - 审查 Pull Request
   - 运行测试

✅ 功能验证
   - 在测试环境验证
   - 检查是否满足需求

✅ 质量检查
   - 代码质量
   - 测试覆盖率
   - 文档更新
```

### Q7: 如何估算 Task 的成本?

**答**: 成本取决于多个因素:

```
Task 成本 = Team 成员数 × 模型成本 × 执行时间

影响因素:
- Team 规模
- 使用的模型类型 (Haiku/Sonnet/Opus)
- 任务复杂度
- 执行时长

优化建议:
- 使用合适规模的 Team
- 简单任务使用 Haiku
- 优化任务描述减少执行时间
```

### Q8: 可以同时运行多个 Task 吗?

**答**: 可以!Wegent 支持并发执行多个 Task:

```yaml
# Task 1
---
apiVersion: agent.wecode.io/v1
kind: Task
metadata:
  name: task-1
spec:
  teamRef:
    name: team-a
  # ...

# Task 2 (并发执行)
---
apiVersion: agent.wecode.io/v1
kind: Task
metadata:
  name: task-2
spec:
  teamRef:
    name: team-b
  # ...
```

**注意**: 如果 Task 操作同一个代码仓库,可能会有冲突。

---

## 📊 完整示例: 从需求到交付

### 场景: 开发用户管理功能

#### 阶段 1: 需求分析

```yaml
apiVersion: agent.wecode.io/v1
kind: Task
metadata:
  name: analyze-user-management-requirements
  namespace: default
spec:
  title: "分析用户管理需求"
  prompt: |
    请分析用户管理功能的详细需求:

    ## 业务需求
    - 用户注册和登录
    - 用户信息管理
    - 权限管理
    - 用户列表和搜索

    ## 输出
    1. 详细的功能需求文档
    2. API 接口设计
    3. 数据库表设计
    4. 前端页面规划
    5. 开发任务拆分

  teamRef:
    name: architecture-team
    namespace: default
  workspaceRef:
    name: project-workspace
    namespace: default
```

#### 阶段 2: 后端开发

```yaml
apiVersion: agent.wecode.io/v1
kind: Task
metadata:
  name: develop-user-api
  namespace: default
spec:
  title: "开发用户管理 API"
  prompt: |
    基于需求分析文档,开发用户管理 API:

    ## API 端点
    1. POST /api/users - 创建用户
    2. GET /api/users/:id - 获取用户信息
    3. PUT /api/users/:id - 更新用户信息
    4. DELETE /api/users/:id - 删除用户
    5. GET /api/users - 用户列表 (支持分页和搜索)

    ## 技术要求
    - 使用 FastAPI
    - SQLAlchemy ORM
    - JWT 认证
    - 输入验证
    - 错误处理

    ## 测试要求
    - 单元测试覆盖率 >80%
    - 集成测试
    - API 文档 (OpenAPI)

  teamRef:
    name: backend-team
    namespace: default
  workspaceRef:
    name: project-workspace
    namespace: default
```

#### 阶段 3: 前端开发

```yaml
apiVersion: agent.wecode.io/v1
kind: Task
metadata:
  name: develop-user-ui
  namespace: default
spec:
  title: "开发用户管理界面"
  prompt: |
    开发用户管理前端界面:

    ## 页面
    1. 用户列表页面
       - 表格展示用户
       - 搜索和过滤
       - 分页
       - 操作按钮 (编辑/删除)

    2. 用户详情页面
       - 展示用户信息
       - 编辑功能

    3. 创建用户页面
       - 表单输入
       - 验证
       - 提交

    ## 技术要求
    - React 18 + TypeScript
    - Tailwind CSS
    - 表单验证
    - 错误处理
    - Loading 状态

    ## 测试
    - 组件测试
    - E2E 测试

  teamRef:
    name: frontend-team
    namespace: default
  workspaceRef:
    name: project-workspace
    namespace: default
```

#### 阶段 4: 集成测试

```yaml
apiVersion: agent.wecode.io/v1
kind: Task
metadata:
  name: integration-testing
  namespace: default
spec:
  title: "用户管理功能集成测试"
  prompt: |
    进行完整的集成测试:

    ## 测试场景
    1. 用户注册流程
    2. 用户登录流程
    3. 用户信息 CRUD
    4. 权限验证
    5. 错误处理

    ## 测试类型
    - API 集成测试
    - E2E 测试
    - 性能测试
    - 安全测试

    ## 输出
    - 测试报告
    - 发现的问题列表
    - 修复建议

  teamRef:
    name: qa-team
    namespace: default
  workspaceRef:
    name: project-workspace
    namespace: default
```

#### 阶段 5: 代码审查

```yaml
apiVersion: agent.wecode.io/v1
kind: Task
metadata:
  name: code-review
  namespace: default
spec:
  title: "用户管理功能代码审查"
  prompt: |
    审查用户管理功能的所有代码:

    ## 审查范围
    - 后端 API 代码
    - 前端 UI 代码
    - 测试代码
    - 文档

    ## 审查重点
    - 代码质量
    - 安全性
    - 性能
    - 可维护性
    - 测试覆盖

    ## 输出
    - 审查报告
    - 问题列表
    - 改进建议

  teamRef:
    name: code-review-team
    namespace: default
  workspaceRef:
    name: project-workspace
    namespace: default
```

#### 阶段 6: 部署

```yaml
apiVersion: agent.wecode.io/v1
kind: Task
metadata:
  name: deploy-to-staging
  namespace: default
spec:
  title: "部署到测试环境"
  prompt: |
    将用户管理功能部署到测试环境:

    ## 部署步骤
    1. 合并代码到 staging 分支
    2. 运行数据库迁移
    3. 部署后端服务
    4. 部署前端应用
    5. 配置环境变量
    6. 运行冒烟测试

    ## 验证
    - 服务健康检查
    - 功能验证
    - 性能监控

  teamRef:
    name: devops-team
    namespace: default
  workspaceRef:
    name: project-workspace
    namespace: default
```

---

## 🔗 相关资源

### 前置步骤
- [创建 Ghost](./creating-ghosts.md) - 定义智能体的能力
- [创建 Bot](./creating-bots.md) - 组装智能体实例
- [创建 Team](./creating-teams.md) - 构建协作团队

### 参考文档
- [核心概念 - Task](../../concepts/core-concepts.md#-task) - 理解 Task 的角色
- [YAML 规范 - Task](../../reference/yaml-specification.md#-task) - 完整配置格式

---

## 💬 获取帮助

遇到问题?

- 📖 查看 [FAQ](../../faq.md)
- 🐛 提交 [GitHub Issue](https://github.com/wecode-ai/wegent/issues)
- 💬 加入社区讨论

---

<p align="center">创建您的第一个 Task,让 AI 团队为您工作! 🚀</p>
