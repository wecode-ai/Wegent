---
sidebar_position: 1
---

# Wework AI 开发工作流完整改造计划

> 日期：2026-08-12
> 状态：待评审
> 目标：在 Wework 内原生完成从需求进入、AI 分析与开发、测试、代码审查、PR/CI、人工审批、合并到任务关闭的完整软件开发闭环。
> 适用范围：Wework 桌面端、本地项目空间、云项目空间、本地设备、App 设备、云设备、GitHub、GitLab。

## 1. 背景

Wework 当前已经具备项目空间、任务看板、项目机器人、任务执行队列、真实代码工作区、评论续接、附件、Git Commit/Push、自动化和 Delivery 等基础能力。

当前主链路可以完成：

```text
创建任务
  → 分配一个项目机器人
  → 自动执行或人工批准
  → 在绑定项目中修改代码
  → 运行测试
  → 在任务评论中回传结果
  → 用户继续追问
  → Commit / Push
  → 人工验收
```

但完整 AI 开发流程仍需人工拼接：

```text
需求分析 Agent
  → 开发 Agent
  → 测试 Agent
  → Review Agent
  → 创建 PR
  → CI
  → 人工审批
  → 合并
  → 自动关闭任务
```

主要原因不是编码运行时不足，而是以下能力尚未成为统一产品模型：

1. 项目机器人只有模型和提示词，没有 Skills、MCP、插件、权限、并发、工作区和 Git 策略。
2. 一个任务只有一个 AI assignee，没有多 Agent 参与、Squad 和阶段编排。
3. PR、CI、Review 和 Merge 状态不是任务的一等数据。
4. Git worktree、分支和 PR 生命周期没有由任务工作流统一管理。
5. 自动化和项目任务编排仍是两条独立路径。

本计划将这些能力收敛成一个领域专用的 AI 开发工作流，不建设通用 BPMN，不依赖提示词模拟状态机，也不保留两套并行主路径。

## 2. 产品目标

### 2.1 用户目标

用户可以只在 Wework 内完成以下工作：

1. 为项目配置代码仓库、执行设备和安全凭据。
2. 创建开发、测试、Review 等项目 AI 成员，或直接选择已有 Wegent 智能体，并为其配置完整能力。
3. 把多个 AI 成员组织成 Squad。
4. 创建或选择一套开发工作流。
5. 创建任务并分别选择 AI 执行者、执行环境和工作区模式。
6. 查看每个阶段的输入、执行记录、输出、失败原因和审批状态。
7. 在任务评论中 `@Agent` 或 `@Squad` 发起补充执行。
8. 查看任务关联的分支、Commit、PR、CI、Review 和合并状态。
9. 在关键节点批准、拒绝、重试、回退或人工接管。
10. 在 PR 合并后自动完成工作流并更新任务状态。
11. 使用定时任务或 Webhook 自动创建并执行同一套项目工作流。
12. 让同一个任务既可在指定 AI 设备上执行，也可在编码模式的托管容器中执行。

### 2.2 系统目标

系统必须保证：

- 工作流状态由平台状态机驱动，不由 Agent 自报决定。
- Agent 执行完成不等于任务完成。
- 每个阶段都有可验证的进入条件、退出条件和产物。
- 所有外部事件幂等处理。
- 本地和云项目空间具有相同的业务语义。
- 本地离线主路径不依赖 Backend。
- 任务、工作流、执行、PR 和 CI 状态可恢复、可审计。
- 不通过 fallback 掩盖主路径错误。
- 项目凭据不进入任务评论、日志或普通 Agent 上下文。

### 2.3 非目标

本期不建设：

- 任意表达式和任意脚本驱动的通用 BPMN 引擎。
- 面向非开发场景的通用企业流程平台。
- 自动替用户执行不可逆的生产发布。
- 未经用户授权自动合并受保护分支。
- 同时维护旧机器人分配模型和新工作流模型。

## 3. 核心产品流程

### 3.1 项目初始化

```text
创建项目空间
  → 绑定代码项目或代码仓库
  → 配置 GitHub / GitLab 连接
  → 配置默认执行环境
  → 创建项目 AI 成员或选择 Wegent 智能体
  → 创建 Squad
  → 创建开发工作流
  → 设置默认工作流
```

项目必须允许绑定多个仓库。每个仓库配置：

- 仓库提供方：GitHub / GitLab / Generic Git。
- 仓库地址和默认分支。
- 本地项目或远程设备工作目录。
- Provider 连接和 Webhook 状态。
- 默认工作区策略。
- 分支命名规则。
- PR 目标分支。
- 是否允许自动创建 PR。
- 是否允许自动合并。
- 合并策略。

### 3.2 任务进入

任务可从以下入口进入：

- 用户手工创建。
- 项目聊天创建。
- `wework_space.create_board_item` 创建。
- GitHub / GitLab Issue 同步。
- 定时自动化创建。
- Webhook 自动化创建。
- 外部系统连接器创建。

任务创建时可选择：

- 不启动 AI。
- 单个项目 Agent 执行。
- Wegent 智能体执行。
- Squad 执行。
- 工作流执行。
- 跟随项目默认工作流。

人类负责人和 AI 执行方式必须分离：

- `assignee_user_id` 表示业务负责人。
- AI 执行绑定表示由哪个项目 Agent、Wegent 智能体、Squad 或 Workflow 执行。
- 执行环境绑定独立表示在指定 AI 设备或编码模式托管容器中执行。
- 工作区模式独立表示复用当前工作区或创建隔离 Git worktree。
- Agent 不再占用人类负责人字段。

### 3.3 需求分析阶段

需求分析 Agent：

1. 读取任务、附件、评论、项目文件和仓库规则。
2. 判断信息是否充分。
3. 信息不足时发起结构化澄清。
4. 必要时创建子任务。
5. 输出实施计划和验收条件。
6. 把结构化阶段产物提交给工作流状态机。

需求分析完成条件由平台验证：

- 必需产物存在。
- 所有阻塞澄清已解决。
- 子任务创建成功或明确不需要拆分。
- 若配置人工计划审批，则进入人工门禁。

### 3.4 开发阶段

开发阶段开始前，平台完成：

1. 确定目标仓库。
2. 拉取默认分支最新代码。
3. 创建或恢复任务工作区。
4. 创建任务分支。
5. 把任务、计划、验收标准和前序产物注入运行时。
6. 解析 Agent 的 Skills、插件、MCP、连接器和权限。
7. 启动真实 Codex/OpenCode/Claude Code 会话。

开发 Agent：

- 修改代码。
- 运行聚焦测试。
- 更新实施进度。
- 提交结构化结果。
- 根据 Git 策略 Commit 和 Push。
- 创建或更新 PR。

开发阶段完成条件：

- 工作区没有未解释的脏文件。
- 至少有一个有效 Commit，或明确声明任务无需代码变更。
- 配置的必需命令已经执行。
- PR 已创建，或工作流明确允许无 PR 完成。
- 阶段输出包含变更摘要、测试结果、风险和未完成项。

### 3.5 测试阶段

测试阶段可以：

- 复用开发任务 worktree。
- 创建只读或独立验证 worktree。
- Checkout PR Head。
- 在多个测试 Agent 间并行执行。

测试 Agent 输出结构化测试报告：

- 执行命令。
- 通过数量。
- 失败数量。
- 跳过数量。
- 覆盖率。
- 失败日志位置。
- 是否阻塞合并。

平台只接受真实命令结果或外部 CI 结果，不允许仅凭自然语言“测试通过”放行。

测试阶段完成条件：

- 所有必需测试节点终态。
- 必需测试全部通过。
- 不存在未批准的跳过。
- 测试报告已关联到任务和 PR。

### 3.6 Review 阶段

Review Agent 读取：

- 需求和验收条件。
- 变更 Diff。
- Commit。
- PR 描述。
- 测试报告。
- 仓库规则。
- 现有 Review Thread。

Review 输出：

- 阻塞问题。
- 非阻塞建议。
- 安全风险。
- 测试缺口。
- 是否建议批准。

Review 评论应写入：

- Wework 任务活动。
- GitHub / GitLab PR Review。

平台必须跟踪 Review Thread 状态，不能把“评论已发出”等同于“问题已解决”。

### 3.7 人工审批

支持以下人工门禁：

- 计划审批。
- 开发完成审批。
- 测试豁免审批。
- Review 审批。
- Push 审批。
- PR 创建审批。
- 合并审批。

审批操作必须显示：

- 当前阶段。
- 变更摘要。
- 风险。
- 测试状态。
- PR 和 CI 状态。
- 审批后将执行的操作。

审批结果：

- 批准：进入下一节点。
- 拒绝并退回：选择目标阶段并填写原因。
- 终止：取消整个工作流。
- 人工接管：保留上下文，停止后续自动调度。

### 3.8 PR、CI 和合并

PR 创建后，任务开发区持续展示：

- 仓库。
- 分支。
- Commit。
- PR 编号和链接。
- Draft 状态。
- CI Checks。
- Review Decision。
- 冲突状态。
- 可合并状态。
- 合并 Commit。

GitHub / GitLab Webhook 更新状态机：

```text
PR opened
  → 等待 CI / Review

CI failed
  → 工作流回到开发修复节点

Review changes requested
  → 工作流回到开发修复节点

CI passed + Review approved
  → 等待合并审批或自动合并

PR merged
  → 工作流完成
  → 任务进入 completed
  → 清理临时 worktree
```

### 3.9 评论追问和 `@Agent`

任务评论支持：

- `@开发 Agent`
- `@测试 Agent`
- `@Review Agent`
- `@Squad`

评论触发不会隐式修改人类负责人，也不会覆盖工作流主执行绑定。

每个顶层评论拥有独立执行线程。回复评论优先续接该线程对应运行时会话。

用户选择 `@Squad` 时：

1. Squad Leader 读取评论。
2. Leader 选择一个或多个成员。
3. 平台为每个成员创建独立 Stage Run。
4. Leader 汇总结果。

所有路由选择必须落库，不能只存在模型上下文。

### 3.10 自动化

自动化增加 `project_workflow` 动作类型：

```text
触发器
  → 创建或匹配任务
  → 选择工作流
  → 绑定仓库和执行设备
  → 启动工作流
```

触发器：

- Cron。
- Interval。
- One-time。
- Webhook。
- GitHub / GitLab Event。
- 手工 Run now。

Webhook 自动化必须支持：

- HMAC 签名。
- 重放保护。
- 幂等键。
- Payload 映射。
- 失败重试。
- 死信状态。

## 4. 目标领域模型

### 4.1 项目 Agent 与 Wegent 智能体

扩展 `ProjectChatAgent` 为完整的项目 AI 成员：

```ts
interface ProjectAgentConfig {
  runtime: 'codex'
  harness: 'codex' | 'opencode' | 'claude_code'
  modelSelection: ModelSelectionConfig | null
  systemPrompt: string

  skillRefs: ResourceRef[]
  pluginRefs: ResourceRef[]
  mcpServerRefs: ResourceRef[]
  connectorRefs: ResourceRef[]
  secretRefs: SecretBindingRef[]

  execution: {
    localProjectId: number | null
    concurrency: number
    timeoutSeconds: number
  }

  workspacePolicy: WorkspacePolicy
  gitPolicy: GitPolicy
  permissionPolicy: AgentPermissionPolicy
  approvalPolicy: AgentApprovalPolicy
}
```

不保存明文 Secret。机器人只保存 Secret Reference，由运行时在授权边界内解析。

已有 Wegent 智能体不复制为项目 Agent，任务和工作流保存稳定资源引用：

```ts
interface WegentTeamExecutionRef {
  type: 'wegent_team'
  teamId: number
  namespace: string
  name: string
  userId: number
  version: number
}
```

Wegent 智能体必须按 `namespace + name + user_id` 查询 Team，并在运行启动时解析
`Team → Bot → Ghost → Shell / Model / Skills / MCP`。Workflow Run 和 Stage Run
保存解析快照，避免智能体在执行过程中被修改后改变在飞任务。

AI 执行者和执行环境是两个正交维度：

```ts
type AiExecutionActor =
  | { type: 'project_agent'; id: string }
  | { type: 'project_squad'; id: string }
  | WegentTeamExecutionRef

type AiExecutionTarget =
  | { type: 'registered_device'; deviceId: string }
  | { type: 'managed_container'; profileId?: string }

type WorkspaceMode = 'current_workspace' | 'git_worktree'
```

因此同一个项目 Agent、Squad 或 Wegent 智能体都可以在指定 AI 设备上执行，
也可以由 Executor Manager 创建编码模式托管容器执行。设备和容器路径必须复用
同一个执行请求、状态回调和产物验证协议。

### 4.2 Squad

```ts
interface ProjectAgentSquad {
  id: string
  projectId: string
  name: string
  leaderAgentId: string
  memberAgentIds: string[]
  routingInstructions: string
  maxParallelMembers: number
  status: 'active' | 'archived'
  version: number
}
```

Squad 不是一个提示词别名。每次路由结果必须产生独立成员运行记录。

### 4.3 Workflow Definition

不实现任意 DAG 表达式。工作流由有序 Stage Group 组成；Group 内可以并行，Group 间顺序执行。

```ts
interface ProjectWorkflowDefinition {
  id: string
  projectId: string
  name: string
  description: string
  triggerMode: 'manual' | 'automatic'
  repositoryBindingId: string | null
  stages: WorkflowStageGroup[]
  failurePolicy: 'pause' | 'stop' | 'return_to_stage'
  status: 'active' | 'archived'
  version: number
}

interface WorkflowStageGroup {
  key: string
  name: string
  execution: 'serial' | 'parallel'
  completion: 'all' | 'any'
  nodes: WorkflowNode[]
}

type WorkflowNode =
  | AgentWorkflowNode
  | HumanGateWorkflowNode
  | CiGateWorkflowNode
  | MergeWorkflowNode
  | CompleteWorkflowNode
```

Agent Node 配置：

- 项目 Agent、Squad 或 Wegent 智能体。
- Prompt 模板。
- 输入产物。
- 必需输出。
- 工作区策略。
- 最大重试。
- 超时。
- 失败目标。

平台节点使用固定条件，不允许任意代码表达式：

- `all_required_tests_passed`
- `pr_exists`
- `ci_passed`
- `review_approved`
- `no_merge_conflict`
- `human_approved`
- `pr_merged`

### 4.4 Task Execution Binding

删除 `LoopItem.assignee_agent_id` 作为主执行入口。

新增：

```text
task_execution_bindings
  id
  loop_item_id
  target_type        project_agent | project_squad | wegent_team | workflow
  target_id
  target_snapshot
  repository_binding_id
  execution_target_type  registered_device | managed_container
  execution_target_id
  workspace_mode         current_workspace | git_worktree
  created_by_user_id
  created_at
  updated_at
  version
```

迁移规则：

- 有 `assignee_agent_id` 的存量任务迁移为 `target_type=project_agent`。
- 保留 `assignee_user_id` 表示人类负责人。
- 回填完成后删除 `assignee_agent_id` 列、相关 API 字段和旧 UI。
- 不增加读取旧字段的兼容 fallback。

### 4.5 Workflow Run

```text
task_workflow_runs
  id
  loop_item_id
  workflow_definition_id
  workflow_definition_snapshot
  repository_binding_id
  execution_target_type
  execution_target_id
  execution_target_snapshot
  status
  current_group_key
  started_by_type
  started_by_id
  started_at
  completed_at
  cancelled_at
  failure_code
  failure_message
  version
```

`workflow_definition_snapshot` 保证工作流运行过程中修改模板不会改变在飞任务。

工作流状态：

```text
pending
waiting_approval
queued
running
blocked
failed
cancelled
completed
```

### 4.6 Stage Run

```text
task_stage_runs
  id
  workflow_run_id
  group_key
  node_key
  node_type
  target_type
  target_id
  target_snapshot
  execution_target_type
  execution_target_id
  status
  attempt
  loop_item_execution_id
  runtime_instance_id
  runtime_task_id
  workspace_id
  started_at
  completed_at
  input_snapshot
  output_json
  failure_code
  failure_message
  version
```

Stage Run 状态：

```text
pending
waiting_approval
queued
claimed
running
passed
failed
rejected
cancelled
skipped
```

### 4.7 Artifact

阶段间不通过自然语言约定传递结果，新增结构化产物：

```text
task_workflow_artifacts
  id
  workflow_run_id
  stage_run_id
  artifact_type
  schema_version
  content_json
  object_key
  sha256
  created_at
```

首期固定产物类型：

- `requirements_analysis`
- `implementation_plan`
- `code_change_summary`
- `test_report`
- `review_report`
- `pull_request`
- `ci_summary`
- `approval_decision`
- `delivery_summary`

### 4.8 Repository Binding

```text
project_repository_bindings
  id
  cloud_project_id
  provider
  repository_identity
  repository_url
  default_branch
  local_project_id
  execution_device_id
  credential_ref
  workspace_policy_json
  git_policy_json
  provider_settings_json
  status
  version
```

仓库身份必须使用 Provider 的稳定 ID；URL 只用于展示。

### 4.9 Task Development State

```text
task_development_links
  id
  loop_item_id
  repository_binding_id
  workspace_id
  branch_name
  base_branch
  head_commit
  provider
  pull_request_id
  pull_request_number
  pull_request_url
  pull_request_state
  draft
  mergeable_state
  review_decision
  ci_state
  merged_commit
  last_provider_event_at
  version
```

CI Check 明细使用子表：

```text
task_development_checks
  id
  development_link_id
  provider_check_id
  name
  status
  conclusion
  details_url
  started_at
  completed_at
  updated_at
```

### 4.10 Provider Event

```text
repository_provider_events
  id
  repository_binding_id
  provider_event_id
  event_type
  delivery_id
  payload_sha256
  received_at
  processed_at
  processing_status
  error_message
```

`provider + delivery_id` 唯一，保证 Webhook 幂等。

## 5. 状态机设计

### 5.1 状态所有权

| 状态 | 唯一所有者 |
| --- | --- |
| 任务业务状态 | Loop Item Service |
| 工作流状态 | Workflow Engine |
| 阶段状态 | Workflow Engine |
| Agent 执行状态 | Loop Item Execution Service |
| Runtime 会话状态 | Executor |
| PR / CI / Review | Repository Integration Service |
| 人工审批 | Workflow Approval Service |

禁止一个服务直接写另一个服务拥有的状态。

### 5.2 事件驱动

统一内部事件：

```text
workflow.started
workflow.cancelled
stage.ready
stage.approved
stage.rejected
stage.execution_started
stage.execution_completed
stage.execution_failed
artifact.created
pull_request.opened
pull_request.updated
pull_request.reviewed
pull_request.merged
ci.updated
workspace.failed
```

本地项目空间在 Executor SQLite 中使用同一事件名称和同一状态转换表。

Backend 和 Executor 必须共享状态机合同测试，确保本地与云语义一致。

### 5.3 状态转换不变量

- 一个 Workflow Run 同一时刻最多有一个运行中的串行 Group。
- 一个 Stage Run 只能绑定一个 `LoopItemExecution`。
- 同一 Stage Run 的同一 attempt 不能重复启动。
- 终态不能回到非终态；重试必须创建新 attempt。
- Workflow Definition 修改不影响已有 Run。
- CI、Review 和 Merge 状态只能由 Provider 同步或经过权限校验的人工刷新更新。
- Agent 输出不能直接把 Stage 标记为 passed；必须经过 Artifact 校验和 Node 退出条件验证。
- PR 合并前不能自动把任务置为 completed。
- 工作流取消必须尝试取消所有活跃 Runtime Task，并释放工作区租约。

## 6. Agent 能力包实现

### 6.1 后端

修改：

- `backend/app/schemas/project_chat.py`
- `backend/app/services/project_chat/service.py`
- `backend/app/api/endpoints/project_chat.py`
- `backend/app/models/delivery.py`

工作：

1. 扩展 Project Agent Schema。
2. 校验 Skills、插件、MCP、连接器和 Secret Reference 的项目可见性。
3. 校验执行设备与仓库绑定的兼容性。
4. 校验并发范围、超时范围和权限策略。
5. 返回解析前配置和可读摘要；不返回 Secret。

### 6.2 本地项目空间

修改：

- `executor/src/task_runtime/store.rs`
- `executor/src/task_runtime/router.rs`
- `executor/src/local/app_ipc.rs`
- `wework/src/api/local/localDelivery.ts`

本地存储增加 Agent 配置 JSON 和版本字段。旧本地 Agent 记录迁移为完整配置，缺失项使用明确默认值写入数据库，不在读取时 fallback。

### 6.3 运行时组装

删除当前机器人运行请求中的固定空值：

```python
"skill_names": [],
"mcp_servers": [],
```

统一复用普通编码会话的能力解析：

- 模型选择。
- Skills。
- 插件。
- MCP。
- Connector。
- 授权。
- 附加上下文。
- Workspace。

新增单一 `AgentExecutionSpecBuilder`，Backend 和 Wework 不再各自拼装不同的 `executionRequest`。

Executor 负责最终权限裁剪，Backend 负责项目级授权。

### 6.4 执行者与执行环境解析

新增单一 `ExecutionActorResolver`：

1. `project_agent` 读取项目 Agent 能力包。
2. `project_squad` 展开路由结果，为每个成员生成独立 Stage Run。
3. `wegent_team` 按 `namespace + name + user_id` 读取 Team，并复用现有
   Team、Bot、Ghost、Shell、Model、Skills 和 MCP 解析服务。
4. `workflow` 读取版本化工作流快照，并由每个 Agent Node 再解析具体执行者。

新增单一 `ExecutionTargetResolver`：

1. `device` 从 Wework 设备目录解析 `local | app | cloud | remote` 设备及可用路由。
2. `managed_container` 通过 Executor Manager Sandbox 创建或恢复编码模式容器。
3. 校验 Harness、Shell、仓库访问方式和目标环境能力是否兼容。
4. 把解析后的设备或容器身份写入 `runtime_instance_id`，把提交时配置写入
   `execution_target_snapshot`。

两种执行环境共享：

- `AgentExecutionSpecBuilder`。
- `LoopItemExecution` 队列。
- Workspace / worktree 创建协议。
- Runtime 状态和取消回调。
- Artifact、日志和审计协议。

不得为 Wegent 智能体、AI 设备或编码模式容器分别增加第二套任务状态机。

## 7. Squad 实现

### 7.1 API

```text
GET    /v1/cloud-projects/{project_id}/agent-squads
POST   /v1/cloud-projects/{project_id}/agent-squads
PATCH  /v1/cloud-projects/{project_id}/agent-squads/{squad_id}
DELETE /v1/cloud-projects/{project_id}/agent-squads/{squad_id}
POST   /v1/cloud-projects/{project_id}/agent-squads/{squad_id}/preview-route
```

本地项目空间暴露对应 IPC 方法。

### 7.2 Leader 路由

Leader 不直接通过自由文本调用成员。平台向 Leader 提供受限工具：

```text
list_squad_members
delegate_to_member
complete_routing
```

`delegate_to_member` 参数：

- memberAgentId
- instruction
- requiredArtifacts
- executionMode

平台校验成员属于 Squad、并发未超限，再创建 Stage Run。

### 7.3 汇总

所有成员结束后：

- `completion=all`：全部通过才进入 Leader 汇总。
- `completion=any`：任一通过即取消其余可取消运行。
- Leader 生成汇总 Artifact。
- 汇总失败不覆盖成员原始结果。

## 8. 工作流引擎实现

### 8.1 Backend 服务

新增：

```text
backend/app/models/project_workflow.py
backend/app/models/task_workflow_run.py
backend/app/models/task_stage_run.py
backend/app/models/task_workflow_artifact.py
backend/app/schemas/project_workflow.py
backend/app/api/endpoints/project_workflows.py
backend/app/api/endpoints/task_workflows.py
backend/app/services/project_workflows/
  definitions.py
  engine.py
  transitions.py
  validators.py
  artifacts.py
  approvals.py
  dispatcher.py
  recovery.py
```

工作流引擎只负责：

- 创建 Run。
- 冻结 Definition Snapshot。
- 计算 Ready Node。
- 创建 Stage Run。
- 请求 Loop Item Execution Service 执行 Agent Node。
- 验证 Artifact。
- 处理 Gate。
- 推进状态。
- 失败恢复。

工作流引擎不直接启动设备命令。

### 8.2 本地服务

新增：

```text
executor/src/project_workflows/
  mod.rs
  model.rs
  store.rs
  engine.rs
  transitions.rs
  artifacts.rs
  recovery.rs
```

本地工作流使用 Executor SQLite 和现有 Runtime Task 服务。

必须支持断网情况下：

- 创建本地工作流。
- 启动本地任务。
- 执行 Agent 阶段。
- 人工审批。
- Commit / Push（网络可用时）。
- 恢复崩溃运行。

Provider Webhook 只在 Backend 可用；本地离线时允许用户手工刷新 PR 状态。

### 8.3 Queue 集成

扩展 `LoopItemExecution`：

- `workflow_run_id`
- `stage_run_id`
- `attempt`

Agent 仍由现有 Queue 和 Lease 机制执行。

工作流不新建第二套 Agent Queue。

### 8.4 恢复

恢复扫描处理：

- Stage Run 为 running，但 Execution 已终态。
- Execution lease 过期。
- Runtime Task 已完成但 Artifact 未写回。
- Provider Event 已收但未处理。
- Workflow 长时间 blocked。
- 工作区创建后进程崩溃。

恢复必须幂等，并记录恢复原因。

## 9. 工作区和 Git 生命周期

### 9.1 Workspace Policy

```ts
type WorkspacePolicy =
  | { mode: 'current_workspace' }
  | { mode: 'new_worktree_per_task'; root?: string }
  | { mode: 'reuse_task_worktree' }
  | { mode: 'checkout_pull_request'; readOnly: boolean }
```

开发工作流默认使用 `new_worktree_per_task`。

### 9.2 Task Workspace

新增统一工作区记录：

```text
task_workspaces
  id
  loop_item_id
  repository_binding_id
  device_id
  source_workspace_path
  workspace_path
  workspace_kind
  branch_name
  base_branch
  head_commit
  status
  lease_owner
  lease_expires_at
  cleanup_policy
  created_at
  updated_at
```

Workspace Manager 负责：

- 拉取远程更新。
- 校验默认分支。
- 创建 worktree。
- 创建分支。
- 恢复已有工作区。
- 检查脏文件。
- 删除临时 worktree。

### 9.3 Git Policy

```ts
interface GitPolicy {
  baseBranch: string | null
  branchTemplate: string
  commitMode: 'agent' | 'human_approval'
  pushMode: 'agent' | 'human_approval'
  pullRequestMode: 'agent' | 'human_approval' | 'disabled'
  mergeMode: 'human_approval' | 'auto_when_green' | 'disabled'
  mergeStrategy: 'merge' | 'squash' | 'rebase'
  requireCleanWorkspace: boolean
}
```

分支模板支持受限变量：

```text
{project_key}
{task_id}
{task_slug}
{date}
```

禁止 Agent 自行生成不符合策略的分支名。

### 9.4 Push

Wework 当前 `git_push` 使用固定 120 秒超时。完整改造时：

- Push 由 Runtime Command Run 记录承载。
- UI 展示实时输出。
- 长时间 pre-push 测试不能被 UI 超时误判。
- 支持取消。
- 最终退出码必须写入 Stage Artifact。

## 10. GitHub / GitLab 集成

### 10.1 Provider 接口

新增统一接口：

```python
class DevelopmentProvider(Protocol):
    def create_pull_request(...)
    def get_pull_request(...)
    def list_checks(...)
    def list_reviews(...)
    def list_review_threads(...)
    def merge_pull_request(...)
    def parse_webhook(...)
```

首期实现：

- GitHub。
- GitLab。

Generic Git 仅支持 Branch、Commit、Push，不提供 PR/CI 自动状态。

### 10.2 认证

优先级：

1. GitHub App / GitLab OAuth App。
2. 项目 Provider Credential Reference。
3. 用户级连接器授权。

禁止在 Agent 配置中保存 PAT 明文。

### 10.3 Webhook

新增：

```text
POST /v1/repository-integrations/github/webhook
POST /v1/repository-integrations/gitlab/webhook
```

处理：

- PR/MR opened、updated、closed、merged。
- Review submitted。
- Review Thread resolved。
- Check Run / Workflow Run。
- Push。

Webhook 只写 Provider Event。异步处理器再更新 Development State 和触发 Workflow Event，避免请求内执行复杂状态转换。

### 10.4 PR 关联

关联优先级：

1. 创建 PR 时直接绑定 Task Development Link。
2. 分支名包含 task id。
3. PR Body 包含 Wework Task Reference。
4. Commit Message 包含 task id。

自动推断必须只产生“候选关联”；非唯一匹配时要求人工确认。

## 11. `wework_space` 工具扩展

新增工具：

```text
get_task_workflow
list_task_stage_runs
read_workflow_artifact
submit_workflow_artifact
request_stage_completion
list_project_agents
list_project_squads
delegate_squad_member
get_task_development
request_pull_request
refresh_pull_request
```

权限原则：

- Agent 只能读取当前项目允许的数据。
- Stage Agent 只能提交当前 Stage 允许的 Artifact 类型。
- `request_stage_completion` 只是请求，不能直接修改 Stage 状态。
- `request_pull_request` 经过 Git Policy 和审批策略。
- Merge 不作为通用 MCP 工具暴露；只能通过 Merge Node 或用户 UI 发起。

## 12. API 设计

### 12.1 Agent

```text
GET    /v1/cloud-projects/{project_id}/chat-agents
POST   /v1/cloud-projects/{project_id}/chat-agents
PATCH  /v1/cloud-projects/{project_id}/chat-agents/{agent_id}
POST   /v1/cloud-projects/{project_id}/chat-agents/{agent_id}/validate
```

### 12.2 Workflow Definition

```text
GET    /v1/cloud-projects/{project_id}/workflows
POST   /v1/cloud-projects/{project_id}/workflows
GET    /v1/cloud-projects/{project_id}/workflows/{workflow_id}
PATCH  /v1/cloud-projects/{project_id}/workflows/{workflow_id}
POST   /v1/cloud-projects/{project_id}/workflows/{workflow_id}/validate
POST   /v1/cloud-projects/{project_id}/workflows/{workflow_id}/clone
POST   /v1/cloud-projects/{project_id}/workflows/{workflow_id}/archive
```

### 12.3 Task Workflow

```text
GET    /v1/cloud-projects/{project_id}/loop-items/{item_id}/workflow
POST   /v1/cloud-projects/{project_id}/loop-items/{item_id}/workflow/start
POST   /v1/cloud-projects/{project_id}/loop-items/{item_id}/workflow/cancel
POST   /v1/cloud-projects/{project_id}/loop-items/{item_id}/workflow/retry
POST   /v1/cloud-projects/{project_id}/loop-items/{item_id}/workflow/take-over
POST   /v1/cloud-projects/{project_id}/loop-items/{item_id}/workflow/stages/{stage_run_id}/approve
POST   /v1/cloud-projects/{project_id}/loop-items/{item_id}/workflow/stages/{stage_run_id}/reject
```

所有写接口带 `version` 或 `Idempotency-Key`。

### 12.4 Repository

```text
GET    /v1/cloud-projects/{project_id}/repositories
POST   /v1/cloud-projects/{project_id}/repositories
PATCH  /v1/cloud-projects/{project_id}/repositories/{binding_id}
POST   /v1/cloud-projects/{project_id}/repositories/{binding_id}/validate
POST   /v1/cloud-projects/{project_id}/repositories/{binding_id}/webhook/rotate

GET    /v1/cloud-projects/{project_id}/loop-items/{item_id}/development
POST   /v1/cloud-projects/{project_id}/loop-items/{item_id}/development/pull-request
POST   /v1/cloud-projects/{project_id}/loop-items/{item_id}/development/refresh
POST   /v1/cloud-projects/{project_id}/loop-items/{item_id}/development/merge
```

## 13. Wework UI 信息架构

项目空间顶部视图调整为：

```text
看板 | 活动 | 自动化 | AI 团队 | 工作流 | 项目设置
```

其中：

- `AI 团队`：项目 Agent、Wegent 智能体和 Squad。
- `工作流`：工作流模板和运行统计。
- `自动化`：项目级触发器。
- `项目设置`：成员、看板、仓库、连接和安全。

## 14. AI 团队 UI

页面顶部提供：

```text
项目成员 | Wegent 智能体 | Squad
```

`Wegent 智能体` 页签读取当前用户可用 Team，显示 Team、Bot 数量、Shell、
模型和能力摘要；选择后保存资源引用，不复制 Team 配置。

### 14.1 Agent 列表

卡片显示：

- 名称和状态。
- Harness 和模型。
- 执行设备。
- 绑定仓库/项目。
- Skills、MCP 和插件数量。
- 并发数。
- 当前运行数。
- 最近失败。

操作：

- 新建。
- 编辑。
- 克隆。
- 归档。
- 验证配置。
- 查看运行记录。

`data-testid`：

```text
project-agent-list
project-agent-add
project-agent-card-{id}
project-agent-edit-{id}
project-agent-validate-{id}
project-agent-archive-{id}
```

### 14.2 Agent 编辑器

使用右侧设置面板或大尺寸 Dialog，分为：

1. 基本信息。
2. 模型与 Harness。
3. Skills 与插件。
4. MCP 与连接器。
5. 执行设备与仓库。
6. 工作区和 Git。
7. 权限与审批。
8. 并发和超时。

顶部持续显示配置完整性：

```text
模型 ✓
设备 ✓
仓库 ✓
权限 1 个问题
```

保存前调用 Validate API。错误必须定位到具体 Section 和字段。

关键测试标识：

```text
project-agent-editor
project-agent-name
project-agent-harness
project-agent-model
project-agent-skill-picker
project-agent-plugin-picker
project-agent-mcp-picker
project-agent-device
project-agent-repository
project-agent-workspace-policy
project-agent-concurrency
project-agent-save
```

### 14.3 Squad UI

Squad 编辑器显示：

```text
Squad 名称
Leader
Members
最大并行数
路由规则
```

支持“试运行路由”：

- 输入模拟任务。
- 查看 Leader 选择哪些成员。
- 不启动真实运行。

## 15. 工作流 UI

### 15.1 列表

显示：

- 名称。
- 是否默认。
- Stage 数量。
- 使用中的任务数。
- 成功率。
- 最近修改时间。

### 15.2 编辑器

不使用自由画布，使用稳定的垂直 Stage Builder：

```text
1. 需求分析
   └─ Agent：产品分析

2. 开发
   └─ Agent：开发工程师

3. 验证（并行）
   ├─ Agent：测试工程师
   └─ Agent：代码审查

4. CI 门禁

5. 人工合并审批

6. 合并并完成
```

交互：

- 添加 Stage。
- 添加并行 Node。
- 拖动排序。
- 展开编辑。
- 复制 Node。
- 删除 Node。
- Validate。
- 保存草稿。
- 设为默认。

编辑已有 Workflow 时保存只影响新 Run。UI 必须显示：

> 修改不会影响已经运行中的任务。

关键 `data-testid`：

```text
project-workflow-list
project-workflow-add
project-workflow-editor
project-workflow-stage-{key}
project-workflow-stage-add
project-workflow-node-add-{key}
project-workflow-node-agent-{key}
project-workflow-node-gate-{key}
project-workflow-validate
project-workflow-save
```

## 16. 任务创建和编辑 UI

任务表单将“负责人”和“AI 执行”拆开：

```text
负责人：用户
AI 执行：跟随项目默认 / 不执行 / 项目 Agent / Wegent 智能体 / Squad / Workflow
执行环境：跟随项目默认 / AI 设备 / 编码模式容器
AI 设备：本机 / App 设备 / 云设备 / 远程设备
工作区：当前工作区 / 隔离 Git worktree
目标仓库：默认仓库 / 其他仓库
启动方式：保存后启动 / 保存但不启动
```

选择“AI 设备”时必须选择在线且能力兼容的设备；选择“编码模式容器”时展示
容器规格和预计启动状态，不要求用户先绑定设备。选择 Wegent 智能体后仍可自由
切换这两类执行环境。

创建后如果需要执行前人工审批：

- 任务成功创建。
- 工作流显示“等待批准”。
- 不显示伪“执行中”状态。

关键 `data-testid`：

```text
task-assignee-user
task-ai-execution-target
task-ai-execution-agent
task-ai-execution-wegent-team
task-ai-execution-squad
task-ai-execution-workflow
task-ai-execution-environment
task-ai-execution-device
task-ai-execution-coding-container
task-workspace-mode
task-repository-binding
task-start-workflow-toggle
```

## 17. 任务详情 UI

任务详情增加四个区域：

```text
概览 | 工作流 | 开发 | 活动
```

窄屏使用 Tab；宽屏可以保持任务正文和活动主区，并在右栏显示工作流摘要。

### 17.1 工作流面板

每个 Stage 显示：

- 状态。
- Agent。
- 尝试次数。
- 开始和结束时间。
- 模型。
- 设备。
- 输出摘要。
- 测试和 Review 结果。
- 失败原因。

操作：

- 批准。
- 拒绝。
- 重试。
- 跳回指定阶段。
- 停止。
- 人工接管。
- 打开编码会话。

执行中的 Agent 展示流式摘要，不把完整终端日志塞进时间线。

关键标识：

```text
task-workflow-panel
task-workflow-status
task-workflow-stage-{stageRunId}
task-workflow-stage-approve-{stageRunId}
task-workflow-stage-reject-{stageRunId}
task-workflow-stage-retry-{stageRunId}
task-workflow-stage-open-session-{stageRunId}
task-workflow-cancel
task-workflow-take-over
```

### 17.2 开发面板

显示：

```text
仓库
工作区
分支
Commit
PR
CI
Review
冲突
合并
```

CI Check 使用列表：

```text
✓ unit-tests
✓ lint
× desktop-e2e
… security-scan
```

操作：

- 打开工作区。
- 查看 Diff。
- Commit。
- Push。
- 创建 PR。
- 打开 PR。
- 刷新状态。
- 合并。

合并按钮只有在策略和权限允许时可用；禁用时显示具体原因。

### 17.3 活动和 Mention

评论输入框支持 Agent/Squad Mention Suggestion。

输入 `@` 后分组显示：

```text
AI 成员
Squad
项目成员
```

选中 Agent 后显示可移除 Mention Chip。发送前明确展示：

> 发送后将启动 1 个 AI 执行。

如果 Mention 的 Agent 达到并发上限，评论仍发送，但执行进入队列并显示队列位置。

## 18. 通知

新增通知：

- 工作流等待我的审批。
- Stage 失败。
- CI 失败。
- Review 请求修改。
- PR 可合并。
- PR 已合并。
- 工作流完成。
- 工作流长时间阻塞。

通知点击进入任务对应 Tab 和 Stage。

## 19. 权限

项目角色能力：

| 操作 | Owner | Maintainer | Developer | Reporter |
| --- | ---: | ---: | ---: | ---: |
| 管理仓库连接 | ✓ | ✓ |  |  |
| 管理 Agent Secret | ✓ | ✓ |  |  |
| 创建 Agent | ✓ | ✓ | 可选 |  |
| 创建 Workflow | ✓ | ✓ | 可选 |  |
| 启动 Workflow | ✓ | ✓ | ✓ | 可选 |
| 批准 Agent 执行 | ✓ | ✓ | 按策略 |  |
| 合并 PR | ✓ | 按 Provider 权限 | 按 Provider 权限 |  |
| 查看 Secret | 不允许返回明文 | 不允许返回明文 |  |  |

Agent Permission Policy 至少支持：

- 文件读写。
- Shell 命令。
- Git Commit。
- Git Push。
- 创建 PR。
- 写 PR 评论。
- 更新任务。
- 创建子任务。
- 使用浏览器。
- 调用连接器。

高风险操作仍使用现有工具审批机制。

## 20. 安全

- Webhook 校验签名和时间窗口。
- Provider Event 防重放。
- Secret 通过引用和运行时注入，不进入普通 JSON 日志。
- Agent 不能读取其他项目 Secret。
- PR Merge 必须二次校验用户 Provider 权限。
- 工作区路径必须经过设备端允许根目录校验。
- Branch Template 变量经过 Git ref 校验。
- Artifact Markdown 作为不可信内容渲染。
- 外部 PR 评论和 Issue 内容作为 untrusted context 注入。
- 所有状态写接口使用乐观锁或幂等键。

## 21. 可观测性

Tracing：

```text
workflow.start
workflow.advance
stage.dispatch
stage.execute
stage.validate_artifact
provider.webhook.process
workspace.prepare
pull_request.create
pull_request.merge
```

Metrics：

- Workflow 启动数和完成率。
- 各 Stage 成功率。
- 各 Agent 队列等待和执行时长。
- 人工审批等待时长。
- PR 创建时长。
- CI 首次通过率。
- 自动修复轮数。
- 工作区创建失败率。
- Webhook 延迟和失败率。
- 恢复扫描处理数量。

日志字段：

- project_id
- item_id
- workflow_run_id
- stage_run_id
- execution_id
- runtime_task_id
- repository_binding_id
- pull_request_id

禁止记录 Token、Secret、完整认证 Header。

## 22. 数据迁移和旧路径删除

### 22.1 数据迁移

迁移顺序：

1. 创建新表。
2. 回填 Repository Binding。
3. 把 `assignee_agent_id` 回填到 Task Execution Binding。
4. 把项目机器人 metadata 归一化为完整 Agent Config。
5. 为已有项目生成一个“单 Agent 执行”工作流模板，但不自动设为项目默认。
6. 校验回填数量和外键。
7. 切换 API 和 UI 到新模型。
8. 删除旧字段和旧执行入口。

### 22.2 删除项

完成切换后删除：

- `LoopItem.assignee_agent_id`。
- `CloudLoopItem.assignee_agent_id`。
- 任务表单中 Agent 与用户互斥的旧负责人逻辑。
- “分配 Agent 直接创建执行”的隐式逻辑。
- Task Activity 中默认只 Mention 当前 assignee 的逻辑。
- Backend 和 Wework 各自拼装机器人 Runtime Payload 的重复代码。
- Agent Runtime Request 中固定空 Skills/MCP 的路径。
- 旧机器人队列 UI 中无法表示 Workflow Stage 的数据投影。

不保留读取旧字段的兼容分支。

## 23. 单次修改交付策略

本计划必须在一个功能分支、一次完整修改、一个 PR 中交付，不拆分成多个前后依赖 PR。

内部开发仍按依赖关系划分为 9 个实施批次，但这些批次只用于组织代码和验证，不形成可独立合并的中间交付。任何批次完成后都继续留在同一分支，直到完整功能、旧路径删除、数据迁移、文档和全部测试同时完成。

| 内部批次 | 内容 | 风险 | 批次完成时的聚焦验证 |
| --- | --- | --- | --- |
| 1 | 数据模型、迁移、共享状态合同 | 高 | Alembic upgrade/downgrade、Rust migration、合同测试 |
| 2 | 完整 Agent 能力包和运行时组装 | 高 | Backend/Executor 单测、真实 Agent 配置验证 |
| 3 | Squad 和多 Agent Mention | 中 | 路由、并发、评论续接 E2E |
| 4 | Workflow Definition、Engine、Artifact、Approval | 最高 | 状态机穷举、恢复、云/本地 E2E |
| 5 | Task Workspace 和 Git Policy | 高 | worktree、分支、Push、清理 E2E |
| 6 | GitHub/GitLab PR、CI、Review、Webhook | 高 | Provider contract、Webhook 幂等、PR 闭环 E2E |
| 7 | AI 团队、Workflow Builder、任务工作流和开发 UI | 高 | 响应式、交互、真实 Tauri E2E |
| 8 | 项目自动化和 Webhook Trigger | 中 | Cron/Webhook 创建并启动工作流 |
| 9 | 旧路径删除、全量 E2E、文档和发布门禁 | 高 | 全量测试、grep 残留、迁移演练 |

单 PR 约束：

- 不提交只包含数据库模型但没有消费路径的中间 PR。
- 不在主分支暂存新旧两套执行主路径。
- 不以 Feature Flag 长期保留未完成的新路径；仅允许在同一开发分支内用于临时联调，提交 PR 前删除。
- 每个内部批次完成时立即补齐聚焦测试，不能把测试集中留到最后。
- 打开 PR 前完成全部内部批次，并执行一次全链路集成验证。
- 提交 PR 前拉取最新主分支并一次性解决冲突，避免在开发期间频繁合并主分支触发无意义 CI。
- PR 必须作为一个不可拆分的原子功能审查：数据库、Backend、Executor、Wework UI、Provider Integration、迁移、旧路径删除和 E2E 缺一不可。
- 若任何 P0 主链路未完成，PR 保持 Draft，不允许把未完成部分转移到后续 PR。

## 24. 详细实现步骤

### 24.1 批次 1：模型和合同

后端：

- 新建 Workflow、Stage、Artifact、Repository、Development、Workspace 表。
- 扩展 Loop Item Execution。
- 新增 Execution Binding。
- 生成 Alembic Migration。
- 实现 Schema 和 Repository 层。

Executor：

- 新增对应 SQLite Migration。
- 新增本地 Store。
- 定义共享状态字符串和序列化格式。

测试：

- 所有状态枚举往返序列化。
- Backend 和 Executor 对同一事件序列得到相同终态。
- Migration upgrade/downgrade。
- 存量 Agent 绑定回填。
- 重复执行回填幂等。

### 24.2 批次 2：Agent 能力包

- 扩展 Agent 编辑 API。
- 实现资源引用校验。
- 抽取统一 Execution Spec Builder。
- 接入普通会话已有 Skills、插件、MCP 和 Connector 解析。
- 支持 Harness。
- 支持并发、超时和权限。
- 删除固定空能力配置。

### 24.3 批次 3：Squad 和 Mention

- 新增 Squad CRUD。
- 实现受限 Leader 路由工具。
- 评论输入增加 Agent/Squad Mention。
- 一个评论可启动多个 Agent。
- 每个 Agent 独立 Stage Run 和 Session。
- 实现汇总。

### 24.4 批次 4：工作流

- Workflow CRUD 和 Validate。
- 任务启动、取消、重试、接管。
- Stage Group 执行。
- Artifact Schema 验证。
- Human Gate。
- Queue 集成。
- 恢复扫描。
- 本地和云双路径。

### 24.5 批次 5：Workspace 和 Git

- Repository Binding。
- Task Workspace Manager。
- Worktree per task。
- Branch Template。
- Commit/Push Policy。
- 长命令 Run。
- 脏工作区保护。
- 清理策略。

### 24.6 批次 6：PR/CI

- Provider Protocol。
- GitHub。
- GitLab。
- Webhook。
- PR 创建。
- CI 和 Review 同步。
- Merge Gate。
- Task Development State。

### 24.7 批次 7：完整 UI

- AI Team。
- Squad。
- Workflow Builder。
- Task Execution Picker。
- Workflow Panel。
- Development Panel。
- Approval Dialog。
- Mention。
- Notification。
- 移动端和桌面端。

### 24.8 批次 8：自动化

- 增加 `project_workflow` Action。
- Webhook Trigger。
- Payload Mapping。
- 自动创建/匹配任务。
- Run History 关联 Workflow Run。

### 24.9 批次 9：切换和清理

- 切换全部 UI/API。
- 删除旧字段和旧逻辑。
- 数据校验脚本。
- 完成文档。
- 完整 E2E。
- 发布前迁移演练。

## 25. 测试策略

测试分为：

1. 纯状态机单元测试。
2. Backend Service/API 测试。
3. Executor Rust 测试。
4. Wework Vitest。
5. Provider Contract 测试。
6. Desktop E2E。
7. 真实 Tauri 验证。
8. Migration 演练。

## 26. 状态机单元测试

必须覆盖：

- 正常串行推进。
- 并行 Group 全部通过。
- 并行 Group 任一通过。
- Agent 执行失败和重试。
- 超过最大重试。
- Human Gate 批准。
- Human Gate 拒绝并回退。
- CI 失败回开发。
- Review Changes Requested 回开发。
- PR 合并完成。
- 工作流取消。
- 人工接管。
- 重复事件。
- 乱序事件。
- 终态事件再次到达。
- Workflow Definition 运行中修改。
- 崩溃恢复。

使用表驱动测试，同一事件表分别运行 Python 和 Rust 实现。

## 27. Backend 测试

使用 `uv run pytest`，重点覆盖：

- Agent 资源引用权限。
- Secret 不出现在响应。
- Squad 成员和 Leader 校验。
- Workflow Validate。
- Execution Binding 迁移。
- Artifact Schema。
- Approval 权限。
- Repository Binding 权限。
- Webhook 签名和幂等。
- Provider 事件乱序。
- PR/CI/Review 聚合。
- Merge 权限。
- Queue Capacity。
- Recovery Scan。

外部 GitHub/GitLab 使用协议级 Fake Server，不访问真实生产服务。

## 28. Executor 测试

覆盖：

- 本地 Workflow Store。
- SQLite Migration。
- Agent Capability 解析。
- Skills/MCP/插件注入。
- Secret Reference 只在运行时解析。
- Worktree 创建和恢复。
- Branch 校验。
- 长 Push 命令。
- Runtime 取消。
- Stage Artifact 写回。
- 本地恢复扫描。
- 本地项目空间离线执行。

## 29. Wework Vitest

组件测试：

- Agent Editor 所有 Section。
- 配置错误定位。
- Squad 编辑和 Preview Route。
- Workflow Builder 增删改排序。
- 并行 Stage。
- Workflow Validate 错误。
- 任务负责人和 AI 执行分离。
- Stage 状态显示。
- Approval Dialog。
- Development Panel。
- CI Check 列表。
- Merge 禁用原因。
- Mention Suggestion。
- 队列和并发状态。
- 移动端 Tab。
- 保存失败和乐观锁冲突。

保留现有 `data-testid`；新增交互元素使用本计划定义的标识。

## 30. Desktop E2E 总体设计

新增桌面主 Runner Checkpoint：

```text
ai-development-workflow
```

修改：

- `wework/e2e/desktop/checkpoints.mjs`
- `wework/e2e/desktop/run-checkpoints.mjs`
- `wework/e2e/desktop/modules/ai-development-workflow-flows.mjs`
- 对应 Scenario Server。
- `.github/workflows/wework-e2e.yml`

该 Checkpoint 必须被 CI 主套件调用，不能只提供本地命令。

Checkpoint 必须建立自己的最小前置：

- 独立临时 Git 仓库。
- 独立本地项目。
- 独立项目空间。
- 独立 Agent、Squad 和 Workflow。
- 独立 Fake GitHub/GitLab Provider。
- 独立分支和任务。

不得依赖前一个 Checkpoint 创建的项目、模型、任务或会话。

## 31. E2E 场景矩阵

### 31.1 E2E-01：创建完整 Agent

前置：

- 本地设备在线。
- 有临时 Git 仓库。
- 有测试 Skill、MCP 和插件 Fixture。

步骤：

1. 打开项目 `AI 团队`。
2. 新建开发 Agent。
3. 选择模型和 Harness。
4. 添加 Skill、MCP 和插件。
5. 绑定设备和仓库。
6. 选择 per-task worktree。
7. 设置并发 2。
8. 保存。
9. 重新打开。

预期：

- 所有配置持久化。
- Secret 只显示引用状态。
- Validate 成功。
- API 和运行时收到相同能力配置。

### 31.2 E2E-02：创建 Squad

步骤：

1. 创建 Leader、Developer、Tester、Reviewer。
2. 创建 Squad。
3. 选择 Leader 和成员。
4. 执行 Preview Route。

预期：

- 路由结果只包含 Squad 成员。
- Preview 不产生 Runtime Task。
- 配置保存后可恢复。

### 31.3 E2E-03：创建工作流

创建：

```text
需求分析
  → 计划审批
  → 开发
  → 测试 + Review 并行
  → CI
  → 合并审批
  → 合并完成
```

预期：

- Validate 成功。
- 并行 Group 正确显示。
- 保存后重新打开顺序和配置不变。
- 修改模板不影响已启动 Run。

### 31.4 E2E-04：完整成功路径

步骤：

1. 创建任务。
2. 选择完整工作流。
3. 启动。
4. 需求分析 Agent 输出计划。
5. 用户批准计划。
6. 开发 Agent 创建 worktree、修改代码、测试、Commit、Push、PR。
7. Tester 和 Reviewer 并行运行。
8. Fake Provider 发送 CI Success 和 Review Approved。
9. 用户批准合并。
10. Fake Provider 返回 PR Merged。

预期：

- Stage 顺序正确。
- 开发前没有提前启动测试。
- Tester 和 Reviewer 并行。
- PR/CI/Review 状态显示正确。
- Merge 前任务不是 completed。
- Merge 后 Workflow 和 Task 都完成。
- 临时 worktree 被清理。
- Delivery Summary 可读取。

### 31.5 E2E-05：计划拒绝

步骤：

1. 工作流到计划审批。
2. 用户拒绝并填写原因。
3. 选择退回需求分析。

预期：

- 原 Stage Run 保留 rejected。
- 新 attempt 创建。
- 拒绝原因进入新 Stage 输入。
- 不启动开发。

### 31.6 E2E-06：测试失败后自动修复

步骤：

1. 开发完成。
2. Tester 运行真实失败测试。
3. Workflow 返回开发修复节点。
4. Developer 修复并 Push 新 Commit。
5. Tester 再次运行并通过。

预期：

- 第一次 Test Artifact 保留。
- 新 attempt 使用同一任务 workspace。
- PR Head Commit 更新。
- 通过后进入下一阶段。

### 31.7 E2E-07：Review Changes Requested

步骤：

1. Fake Provider 发送 Changes Requested。
2. 工作流回开发。
3. Developer 修复。
4. Reviewer 重新 Review。

预期：

- Review Thread 可见。
- 未解决 Thread 阻止合并。
- Thread resolved + Approved 后放行。

### 31.8 E2E-08：CI 失败

步骤：

1. PR 创建。
2. Fake Provider 发送 CI Failure。
3. 查看任务通知。
4. 打开失败 Check。
5. 修复后发送 CI Success。

预期：

- CI Gate 不通过。
- 任务显示阻塞原因。
- 通知跳到 Development Tab。
- Success 后状态机只推进一次。

### 31.9 E2E-09：Webhook 幂等和乱序

发送：

- 相同 Delivery ID 两次。
- Merged 事件先于旧的 Opened 事件到达。

预期：

- 事件只处理一次。
- 旧事件不把 merged 状态倒退。
- Workflow 只完成一次。

### 31.10 E2E-10：`@Agent`

步骤：

1. 在任务评论 `@Tester`。
2. 发送附件和问题。
3. Tester 回复。
4. 继续回复同一评论线程。

预期：

- 不改变人类负责人。
- 不改变主工作流绑定。
- 启动 Tester 独立 Stage Run。
- 回复续接 Tester 原 Session。
- 附件在运行时可读取。

### 31.11 E2E-11：`@Squad`

步骤：

1. 评论 `@Engineering Squad`。
2. Leader 选择 Developer 和 Reviewer。
3. 两个成员并行。
4. Leader 汇总。

预期：

- 路由记录可审计。
- 成员运行独立。
- 汇总引用两个成员结果。

### 31.12 E2E-12：并发限制

步骤：

1. Agent 并发设置为 1。
2. 创建两个任务同时启动。

预期：

- 第一个 running。
- 第二个 queued。
- 第一项结束后第二项自动启动。
- 队列位置和等待状态可见。

### 31.13 E2E-13：工作区脏文件保护

步骤：

1. Agent 留下未提交改动并结束。
2. Stage 请求完成。

预期：

- Stage 不通过。
- 显示脏文件列表。
- 用户可打开工作区。
- 不自动删除 worktree。

### 31.14 E2E-14：设备离线和恢复

步骤：

1. Stage queued。
2. 设备离线。
3. 设备恢复。

预期：

- 运行不伪装失败。
- Infra Failure 不消耗业务重试。
- 恢复后继续执行。

### 31.15 E2E-15：Runtime 崩溃恢复

步骤：

1. Stage running。
2. 终止 Runtime。
3. 等待 Lease 过期和 Recovery Scan。

预期：

- 原 attempt 标记失败。
- 按策略创建新 attempt。
- 设备 Slot 释放。

### 31.16 E2E-16：人工接管

步骤：

1. 工作流运行中。
2. 用户选择人工接管。
3. 打开工作区手工修改。
4. Commit/Push。
5. 手工恢复工作流。

预期：

- 自动 Stage 被取消。
- 上下文和工作区保留。
- 恢复时从用户选择节点继续。

### 31.17 E2E-17：自动化创建工作流任务

步骤：

1. 创建 Webhook Automation。
2. 发送合法签名 Payload。
3. 自动创建任务并启动默认 Workflow。
4. 重复发送相同事件。

预期：

- 只创建一个任务。
- Workflow 正常运行。
- Run History 关联 Task 和 Workflow。

### 31.18 E2E-18：本地离线项目空间

步骤：

1. Backend 不可用。
2. 创建本地项目空间 Agent 和 Workflow。
3. 创建本地任务。
4. 执行开发和本地测试。
5. 完成人工审批。

预期：

- 主链路可用。
- 不错误调用 Backend 项目 API。
- 联网恢复后可 Push 和刷新 PR。

### 31.19 E2E-19：权限

覆盖：

- Reporter 不能改 Agent Secret。
- Developer 可以启动允许的 Workflow。
- 非审批人不能批准 Gate。
- 无 Provider Merge 权限不能合并。

### 31.20 E2E-20：迁移

前置：

- 创建使用旧 `assignee_agent_id` 的任务和 Agent。

执行升级后：

- Task Execution Binding 正确。
- 人类负责人未改变。
- 任务可以启动单 Agent Workflow。
- 旧字段和旧接口不可再使用。

## 32. E2E 失败证据

每个关键 E2E 失败必须保留：

- Scenario 输入。
- Backend 日志。
- Executor 日志。
- Tauri 日志。
- Workflow Run 和 Stage Run 快照。
- Runtime Task ID。
- Provider Event。
- Git status、branch 和 head commit。
- 必要的应用截图。

禁止因为 E2E 不稳定而增加静默跳过、宽泛重试或 `catch` 后继续。

只有完整日志证据证明 E2E 脚本逻辑错误时，才修改原有 E2E 行为。

## 33. 真实 Tauri 验证

每个影响 UI、Tauri、IPC、Executor 或本地 Runtime 的 PR，必须使用隔离真实 Tauri Session 验证。

最终完整 QA：

1. 启动隔离 Session。
2. 创建临时 Git 项目。
3. 创建 Agent。
4. 创建 Workflow。
5. 创建任务并完整执行。
6. 验证审批。
7. 验证 worktree。
8. 验证 Commit/Push。
9. 验证 PR/CI UI。
10. 验证失败恢复。
11. 捕获最终证据。
12. 停止隔离 Session。

浏览器 Mock 不能替代真实 Tauri 验证。

## 34. 验证命令

聚焦测试：

```bash
cd backend && uv run pytest tests/services/project_workflows tests/services/repository_integrations
cd executor && cargo test project_workflows
pnpm --filter wework test <changed-test-file>
pnpm --filter wework exec prettier --check <changed-files>
pnpm --filter wework exec eslint <changed-files>
```

广泛测试：

```bash
cd backend && uv run pytest
cd executor && cargo test
pnpm --filter wework test
pnpm --filter wework e2e:desktop --segment ai-development-workflow
```

真实 Tauri：

```bash
pnpm --filter wework ai:verify start
pnpm --filter wework ai:verify snapshot --session <session-path>
pnpm --filter wework ai:verify stop --session <session-path>
```

## 35. 发布和迁移演练

发布前必须在生产等价数据副本上演练：

1. 执行升级。
2. 校验旧 Agent 和任务回填数量。
3. 启动迁移后的单 Agent 任务。
4. 执行完整 Workflow。
5. 回滚数据库迁移。
6. 再次升级。
7. 校验幂等。

单 PR 集成和发布顺序：

1. 在同一功能分支完成 Backend 数据模型、Executor 合同、Wework UI、Provider Integration 和迁移。
2. 在同一分支完成新写路径切换与旧路径删除。
3. 执行本地和 CI 聚焦测试。
4. 执行数据回填演练和回滚演练。
5. 执行完整 Desktop E2E 和真实 Tauri 验证。
6. 拉取最新主分支并解决全部冲突。
7. 再次运行受影响的聚焦测试和迁移验证。
8. 创建一个包含全部改造的 Draft PR。
9. PR CI 全部通过且审查完成后一次性合并。
10. 部署时执行数据库迁移、应用发布和数据校验；不部署只能运行部分新模型的中间版本。

发布门禁：

- Migration 演练通过。
- Backend/Executor/Wework 全量测试通过。
- Desktop E2E 全部通过。
- 真实 Tauri 完整成功路径通过。
- GitHub 和 GitLab Provider Contract 通过。
- 无 Secret 日志。
- 无旧 `assignee_agent_id` 生产读路径。
- 单一 PR 同时包含新路径、数据迁移和旧路径删除。
- 不存在需要依赖后续 PR 才能工作的数据库字段、API、UI 或状态转换。

## 36. 验收标准

功能验收：

- 用户可创建带 Skills、MCP、插件、权限和 Git 策略的 Agent。
- 用户可创建 Squad。
- 用户可选择已有 Wegent 智能体执行项目任务，且运行时复用其 Team/Bot/Ghost 能力配置。
- 用户可创建包含串行、并行、人工、CI 和 Merge 节点的工作流。
- 任务可以绑定项目 Agent、Wegent 智能体、Squad 或 Workflow。
- 每种 AI 执行者均可在指定 AI 设备或编码模式托管容器中运行。
- 执行环境和当前工作区 / 隔离 Git worktree 可以独立选择并被完整审计。
- 用户可以在评论中自由 `@Agent` 和 `@Squad`。
- Agent 在独立任务 worktree 中执行。
- Wework 可创建和跟踪 PR。
- CI 和 Review 状态自动同步。
- 测试失败和 Review 请求修改会自动回到开发阶段。
- 人工审批后可合并。
- PR 合并后任务自动完成。
- 自动化可创建任务并启动相同工作流。
- 本地项目空间离线主路径可用。

质量验收：

- 所有核心流程有 CI 覆盖的 Desktop E2E。
- 本地和云状态机合同一致。
- Webhook 幂等。
- 崩溃可恢复。
- 不存在双重 Agent Queue。
- 不存在旧/新双主路径。
- 不记录 Secret。
- 不通过 Agent 自报决定测试、CI、Review 或 Merge 成功。

## 37. 最终完成形态

完成后，Wework 中的完整开发流程为：

```text
需求进入项目空间
  → 绑定默认开发工作流
  → 需求分析 Agent 澄清和拆分
  → 人工批准计划
  → 平台创建任务 worktree 和分支
  → 开发 Agent 修改、测试、Commit、Push
  → 平台创建 PR
  → 测试 Agent 与 Review Agent 并行
  → GitHub/GitLab 同步 CI 与 Review
  → 失败自动回开发修复
  → 通过后等待人工合并审批
  → 平台合并 PR
  → 自动完成工作流和任务
  → 清理临时 worktree
  → 生成可审计 Delivery
```

这一形态不再依赖用户手工在多个机器人之间改派任务，也不依赖提示词维持流程状态。Wework 项目空间负责需求和协作，工作流引擎负责确定性编排，Executor 负责真实代码执行，Provider Integration 负责 PR/CI 真值，人工审批负责关键风险门禁。
