---
sidebar_position: 33
---

# 云端协作领域模型

本文定义 Wework 与 Wegent 共用的云端协作概念。目标是让产品只暴露一套
Workspace、Project、Member、Agent、Issue 和 Run 模型，同时继续复用 Wegent
现有的 Team、Bot、Ghost、Shell、Model 和 Task 执行设施。

本文描述目标模型，不改变
[云项目协作架构](./cloud-project-collaboration.md) 中已经确定的数据事实来源和执行
连线。

## 核心术语

| 产品概念 | 中文名称 | 定义 |
| --- | --- | --- |
| `Workspace` | 协作空间 | 成员、权限、智能体、设备、集成和共享资源的长期租户边界 |
| `Project` | 协作项目 | 协作空间内围绕一个产品、业务目标或交付事项组织工作的容器 |
| `Member` | 协作成员 | 可以接收通知、参与协作或发起执行的人或智能体 |
| `Agent` | 智能体 | 可以接收 Issue 并产生 Run 的机器协作成员 |
| `Issue` | 任务 | 需要持续推进、讨论、审查和最终确认的一件工作 |
| `Run` | 执行 | Agent 对一个 Issue 的一次有始有终的执行尝试 |
| `Runtime` | 运行时 | 某个设备上可用于执行指定 Shell 和能力要求的环境 |
| `Deliverable` | 交付物 | 人或 Agent 为 Issue 提交的可验证结果 |
| `View` | 视图 | Project 中同一批 Issue 的看板、列表、表格等展示方式 |

产品主链固定为：

```text
Workspace
└── Project
    └── Issue
        ├── Assignments: Human | Agent
        └── Runs
            ├── Agent
            ├── Initiator
            ├── Runtime
            ├── Execution Workspace
            └── Deliverables
```

Workflow 和 Automation 只能创建、指派、组织或触发 Issue/Run，不能再形成独立的
任务与执行世界。

## Workspace 与 Project

`Workspace` 负责共享人和能力：

- 成员、角色和权限；
- Agent、Team 和能力配置；
- Device、Runtime 和调用权限；
- GitHub、GitLab、IM 等集成；
- 仓库注册表、工作流模板、自动化模板；
- 跨 Project 搜索、统计、配额和审计。

`Project` 负责组织一项具体工作：

- Issue、评论、附件和交付；
- Project 成员范围和 Agent 启用范围；
- 状态、字段和 View；
- 项目资源、Workflow 和 Automation；
- 项目级执行策略覆盖。

现有 `CloudProject` 直接承担 `Project`，不再被产品称为“协作空间”。系统需要在
它之上新增真正的 `Workspace`。当前看板只是 Project 的默认 `View`：

```text
Workspace
└── Project (CloudProject)
    ├── View: Board
    ├── View: List
    ├── View: Table
    └── Issues (LoopItem)
```

## Member、Assignment 与 Execution

`Member` 是协作主体的统一抽象：

```text
Member
├── Human
└── Agent
```

Issue、Workflow 节点和调度器统一使用 `MemberRef`：

```ts
type MemberRef =
  | { type: 'human'; id: string }
  | { type: 'agent'; id: string }
```

Assignment 只表示定向通知、关注和行动请求，不表示独占执行权，也不是开始执行的
必要条件：

```text
Issue
├── Assignments: 0..N MemberRef
└── Runs: 0..N
```

- 一个 Issue 可以同时分配给多个人或 Agent；
- 分配给 Human 时，Issue 进入其通知和待处理列表；
- 分配给 Agent 时，可以按 Project 策略自动触发 Run，也可以只通知等待显式启动；
- 未被分配但拥有 Project 执行权限的成员，仍可基于该 Issue 发起执行、评论或提交
  交付物；
- Assignment 不授予 Issue 访问权限，也不能阻止其他成员执行。

机器 Run 独立记录谁发起、由哪个 Agent 执行：

```text
Run
├── initiated_by: Human | Agent | Automation
├── agent_id
├── runtime_id
└── trigger: manual | assignment | mention | workflow | automation
```

Human 在 Wework 中打开有权访问的 Issue 后可以选择本地工作区，但启动 Codex Run
还必须拥有 Project 执行权限。仅能访问 Issue 不代表有权执行，而 Assignment 不是
启动前提。若 Human 完全手工处理而不调用 Agent，则只记录活动和 Deliverable，不
伪造机器 Run。

Device、Executor 和 Runtime 不是 Member。它们没有持续的协作身份，不能成为
Assignment 对象或 Agent。

## 统一 Agent 模型

Wework Agent 和 Wegent Agent 不建立两套定义。产品 `Agent` 统一使用 Wegent 的
Team、Bot、Ghost、Shell 和 Model 表达：

```text
Agent
└── Team
    └── Bot
        ├── Ghost
        │   ├── Prompt
        │   ├── Skills
        │   ├── MCP Servers
        │   └── Plugins
        ├── Shell
        └── Model
```

- 单智能体 Agent 是只包含一个 Bot 的 Team；
- 多智能体 Agent 是包含多个 Bot 和协作模式的 Team；
- 产品指派对象始终是 Agent，不直接让用户在 Bot 和 Team 之间选择；
- Wework 本地编码 Agent 是使用 Codex Shell、加载 Wework Plugin，并由 Wework
  Executor 执行的同一个 Agent，不是新的 Agent 类型。

现有 `ProjectChatAgent` 降级为 Project 对 Workspace Agent 的绑定：

```text
ProjectAgentBinding
├── project_id
├── agent_id / team_id
├── project_role
├── instruction_override
├── runtime_policy_override
└── enabled
```

Agent 的身份、Team、能力和默认执行策略属于 Workspace；Project 只保存是否启用
以及项目级差异。

旧模型中的授权字段不迁入 ProjectAgentBinding。迁移时，
`ProjectChatAgent.created_by_user_id` 转为 Workspace Agent 绑定的人类所有者和
添加者，即 `WorkspaceAgentBinding.owner_user_id` 与 `added_by_user_id`；已有
`LoopItemExecution.executor_owner_user_id` 继续保留在 Run 上，并复制到替代或
恢复创建的 Run。领取、心跳、事件上报和完成接口继续按该 Run 字段鉴权，因此将
ProjectChatAgent 收敛为 ProjectAgentBinding 不会放宽原有的创建者专属执行权限。

### Workspace Agent 与 Project 专属 Agent

Agent 的租户归属始终是 Workspace，但使用范围可以是 Workspace 共享或 Project
专属。两者使用同一个 Agent 实体和 Team/Bot/Ghost 模型：

```text
Agent
├── workspace_id
├── scope: workspace | project
└── home_project_id: null | project_id
```

- `scope = workspace`：可以绑定到 Workspace 内多个 Project；
- `scope = project`：只能绑定到 `home_project_id` 指定的 Project，默认只对该
  Project 成员可见；
- 在 Project 内创建智能体时，系统仍创建 Workspace Agent，但自动设置
  `scope = project` 并建立 ProjectAgentBinding；
- 将项目专属 Agent 提升为 Workspace 共享 Agent 时，只修改 scope，不复制 Team、
  Bot 或 Ghost；
- Project 归档时，仅当项目专属 Agent 没有活动 Run、Automation 或其他有效引用时
  才归档该 Agent，历史 Run 继续保留其不可变快照。

如果只是同一个 Agent 在不同 Project 使用不同仓库说明、附加指令或 Runtime
偏好，应使用 ProjectAgentBinding 覆盖，不应创建项目专属 Agent。只有角色、能力、
权限或生命周期确实只属于该 Project 时才使用 `scope = project`。

## Ghost Plugin

Ghost 增加 `plugins`，与 `skills`、`mcp_servers` 平级声明：

```yaml
spec:
  prompt: ...
  skills:
    - ref: skill/code-review
  mcp_servers:
    - ref: mcp/project-space
  plugins:
    - ref: plugin/wework-browser
      version: 1.2.0
      required: true
      config: {}
```

建议引用模型至少包含：

```ts
type GhostPluginRef = {
  ref: string
  version?: string
  required: boolean
  config?: NonSecretPluginConfig
  credential_refs?: PluginCredentialRef[]
  permissions?: string[]
}

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

type NonSecretPluginConfig = Record<string, JsonValue>

type PluginCredentialRef = {
  name: string
  ref: string
}
```

Plugin 是能力包，可以展开为 Skill、MCP、Hook、Tool 和 Runtime Requirement。
Ghost 编译为有效能力清单时必须去重并校验冲突。

`config` 是持久化的执行意图，必须符合 Plugin 声明的非秘密配置 schema。Token、
密码、私钥等凭据不得写入 `config`，只能通过 `credential_refs` 表达，并在物化时
由本地或云端 compiler 解析。

只有影响 Agent 执行能力的 Plugin 进入 Ghost。仅扩展 Wework 菜单、页面或组件的
UI Plugin 仍属于 Wework 宿主，不进入 Agent 能力模型。

## Shell、Runtime、Device 与 Executor

四者职责固定为：

| 概念 | 职责 |
| --- | --- |
| `Shell` | 定义如何运行，例如 Codex、ClaudeCode、Agno、Dify 或 Chat |
| `Runtime` | 表示某个 Device 上已经可用的 Shell 实例和能力集合 |
| `Device` | 提供机器、文件系统、网络和本地凭据 |
| `Executor` | 领取 Run、准备环境、启动 Shell、回传事件并处理取消恢复 |

关系为：

```text
Agent requires capabilities
    ↓ scheduler match
Runtime provides capabilities
├── Device
├── Executor
└── Shell
```

Agent 不拥有 Device，只保存默认 Runtime 策略和调用权限。Run 创建后记录实际选中
的 Runtime 和 Device。本地目录场景可以硬绑定设备；可 checkout 的 Git 仓库默认
允许从 Runtime 池动态选择。

## Issue 与 Run

`LoopItem` 继续作为 Issue 的云端事实来源。`loop_item_executions` 提升为产品层
唯一 Run 信封，统一承接 Wework 本地执行和 Wegent 执行：

```text
Run
├── workspace_id
├── project_id
├── issue_id
├── agent_id
├── trigger
├── backend_type
├── backend_execution_id
├── runtime_id
├── execution_workspace_id
├── status
└── result
```

底层映射为：

```text
Run backend = wework_local
└── LocalTask / Codex thread

Run backend = wegent
└── Task / Subtask / Team execution
```

LocalTask、Task 和 Subtask 是执行后端实体，不再作为与 Issue 并列的产品任务。
Run 的通用状态、日志、取消、恢复和交付接口必须与后端无关；后端专有状态只用于
诊断。

Run 正常完成只表示本次执行结束，不自动表示 Issue 已验收完成。

## 现有设施映射

| 目标概念 | 现有设施 | 演进方式 |
| --- | --- | --- |
| Workspace | 无完整对应物 | 新增租户聚合根 |
| Project | `CloudProject` | 直接复用并统一产品术语 |
| Issue | `LoopItem` | 直接复用 |
| Agent | `Kind(kind=Team)` | 作为唯一 Agent 定义 |
| Bot/Ghost/Shell/Model | Wegent CRD | 继续作为 Agent 内部定义 |
| Project Agent | `ProjectChatAgent` | 收敛为 ProjectAgentBinding |
| Run | `LoopItemExecution` | 提升为唯一产品执行记录 |
| Wegent backend | `Task` / `Subtask` | 作为 Run 的后端执行记录 |
| Wework backend | `LocalTask` / runtime RPC | 作为 Run 的本地执行后端 |
| Runtime | Device、Executor、Shell 能力 | 建立统一 Runtime 投影与调度接口 |
| View | 当前看板与筛选 | 看板降为默认 View，补充服务端保存视图 |
| Workflow | Issue Workflow | 只组织 Issue 和 Run |
| Automation | Project Automation、本地计划任务 | 合并定义和触发协议 |

## 必须保持的领域约束

1. Workspace 是成员、权限和共享能力的唯一租户边界。
2. Project 必须属于一个 Workspace。
3. Issue 必须属于一个 Project，并继承其 Workspace。
4. Member 只能是 Human 或 Agent，Device/Executor 不得成为 Assignment 对象。
5. Agent 的唯一云端定义是 Team；单 Bot 也通过单 Bot Team 暴露。
6. Project 专属 Agent 仍属于 Workspace，只通过 scope 和 Project Binding 限制使用。
7. Assignment 只产生通知和行动请求，不作为执行权限或排他锁。
8. Project 成员只要拥有执行权限，就能在未被分配时基于 Issue 发起 Run。
9. ProjectChatAgent 不再复制 Agent 的身份、能力和完整运行配置。
10. 每次机器执行必须先创建一个 Run，再创建后端执行记录。
11. 一个 Run 只能绑定一个实际执行后端，但可以包含多个后端 turn/subtask。
12. Run、Project 和 Issue 的 `workspace_id` 必须一致，并由数据库或服务层强校验。
13. Workflow Node 不得成为独立于 Issue/Run 的第三种任务。
14. Plugin 的权限、版本和配置必须进入不可变执行快照。
15. Executor 只能执行 Agent 声明与 Runtime 能力匹配的 Run。

## 演进顺序

1. 新增 Workspace，将现有 CloudProject 迁入默认 Workspace。
2. 将 CloudProject 的产品术语统一为 Project，将看板定义为默认 View。
3. 将 Workspace Member 扩展为 Human/Agent 统一可指派主体。
4. 使用 Team 作为唯一 Agent 定义，将 ProjectChatAgent 收敛为项目绑定。
5. 为 Ghost 增加 Plugin 引用和有效能力清单。
6. 将 LoopItemExecution 收敛为唯一 Run 信封。
7. 统一 Runtime 能力发现和执行后端协议。
8. 再迁移 Wework 本地 Codex 执行，避免在本地链路继续引入第二套 Agent/Run 模型。
