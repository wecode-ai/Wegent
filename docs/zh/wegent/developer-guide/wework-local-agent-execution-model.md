---
sidebar_position: 34
---

# Wework 本地智能体执行模型

本文在[云端协作领域模型](./cloud-collaboration-domain-model.md)基础上，定义本地
Wework、Codex、Plugin、Executor、LocalTask 与云端 Issue/Run 的关系。

目标不是让所有本地对话强制上云，而是让参与协作项目的本地执行使用与 Wegent
云端相同的 Agent 定义、Run 协议和能力快照。

## 当前执行链路

现有本地看板机器人执行大致为：

```text
ProjectChatAgent
→ WeworkExecutionProfile
→ RuntimeTaskCreateRequest V2
→ LoopItemExecution.execution_payload
→ Wework Executor claim
→ LocalTask
→ Codex app-server thread/turn
```

这条链路已经具备可复用基础：

- `LoopItemExecution` 已保存执行状态、设备、`runtime_instance_id`、本地
  `runtime_task_id` 和不可变执行 intent；
- `RuntimeTaskCreateRequest V2` 已携带模型、Plugin、Skill、工作区、附件和目标；
- Wework Executor 已支持本地任务领取、Codex app-server、Plugin 物化、Skill
  部署、事件回传和设备能力同步；
- `LocalTask` 已拥有稳定的 `deviceId + localTaskId` 身份；
- Codex transcript 已由 thread/turn/item API 作为事实来源。

当前主要断点是 `WeworkExecutionProfile` 从 `ProjectChatAgent` 配置临时拼接一个
`shell_type = Codex` 的 Bot，并单独读取项目 Plugin，而不是消费统一的
Team → Bot → Ghost → Shell 定义。结果是本地与 Wegent 执行拥有两套 Agent 配置
来源。

## 目标关系

```text
Workspace Agent
└── Team
    └── Bot
        ├── Ghost
        │   ├── Prompt
        │   ├── Skills
        │   ├── MCP Servers
        │   └── Plugins
        ├── Shell = Codex
        └── Model

Project
└── Issue
    └── Run
        ├── Agent Snapshot
        ├── Runtime Selection
        ├── Execution Workspace
        └── Backend Binding
            └── LocalTask
                └── Codex Thread
```

本地 Wework 和云端 Wegent 不再代表两类 Agent，只代表两种 Runtime/Executor：

```text
同一个 Agent
├── Wework Local Runtime
└── Wegent Cloud Runtime
```

## Agent 定义与执行快照

Run 入队前，Backend 必须解析 Team、Bot、Ghost、Shell、Model 和 Plugin，生成一份
不可变 `AgentExecutionSnapshot`：

```text
AgentExecutionSnapshot
├── agent_id / team_id
├── agent_revision
├── bots
│   ├── bot_id
│   ├── ghost_revision
│   ├── effective_prompt
│   ├── shell_type
│   ├── model_selection
│   └── effective_capabilities
│       ├── skills
│       ├── mcp_servers
│       └── plugins
└── collaboration_mode
```

该快照进入 `LoopItemExecution.execution_payload`。Run 开始后修改 Team、Ghost、
Plugin 或模型默认值，不得改变已经入队的执行。

现有 `WeworkExecutionProfile` 应逐步退化为执行快照编译器或删除：

- Bot 名称和 Shell 不再从 `ProjectChatAgent` 临时构造；
- 模型默认值来自 Bot/Model，Project 或 Workflow 只能显式覆盖；
- Plugin 默认值来自 Ghost，Project 和 Run 可以追加允许的覆盖；
- `ProjectChatAgent` 只提供 Project Agent Binding 和运行策略覆盖。

## Codex Shell

Codex 应成为正式 Shell 类型，而不是 Wework 专用分支中的硬编码字符串：

```text
Shell
├── Chat
├── ClaudeCode
├── Codex
├── Agno
├── Dify
└── ...
```

Codex Shell 定义协议和要求：

```text
Codex Shell
├── provider protocol: app-server
├── required capabilities
├── supported models
├── supported Plugin format
├── cancellation capability
├── continuation capability
└── transcript capability
```

Wework Executor 是 Codex Shell 的一个本地实现。未来云端 Executor 也可以实现同一
Shell；Agent 定义不因执行位置改变。

## Plugin 的解析与物化

Ghost 保存期望能力，设备安装状态保存实际能力：

```text
Ghost Plugin refs
→ AgentExecutionSnapshot
→ Runtime capability match
→ PluginDeviceInstallation
→ Executor materialization
→ Codex plugin cache
```

职责边界为：

| 层级 | 职责 |
| --- | --- |
| Ghost | 声明 Agent 需要哪些 Plugin 及版本、配置、权限 |
| Workspace/Account | 保存 Plugin 安装授权与共享策略 |
| Project | 选择允许使用的 Plugin，提供非敏感项目级覆盖 |
| Runtime | 上报可支持和已物化的 Plugin 能力 |
| Executor | 下载、校验、安装并为本次 Run 激活 Plugin |
| Codex Shell | 按 Codex Plugin 协议加载本次 Run 的 Plugin |

Plugin 包内发现的 Skill 和 MCP 必须进入统一有效能力清单。重复声明按稳定 identity
去重；版本或配置冲突在入队或 Runtime 匹配阶段明确失败，不能静默选择一份配置。

仅限设备的授权和 secret 不进入 Ghost，也不持久化到 Run。Run 只保存引用和权限
需求，由执行设备在启动时物化。

## Runtime 与设备选择

现有 `runtime_instance_id` 作为 Runtime 实例身份继续使用。Runtime 至少暴露：

```text
Runtime
├── runtime_instance_id
├── device_id
├── executor_kind
├── supported_shells
├── capabilities
├── online_status
├── capacity
├── owner
└── access_policy
```

调度输入分为要求和偏好：

```text
requirements
├── shell = Codex
├── required_plugins
├── required_skills
├── workspace_access
└── platform constraints

preferences
├── preferred_runtime_id
├── preferred_device_id
└── local | cloud preference
```

只有本地目录、私人凭据或设备专属能力构成硬绑定。普通 Git 仓库任务应允许调度器
从满足要求的 Runtime 中选择。

## Execution Workspace

协作 Project 的资源与一次 Run 使用的目录必须分开：

```text
Project Resource
├── Git Repository
└── Device Local Directory Binding

Run Execution Workspace
├── local_directory
├── git_checkout
├── git_worktree
└── standalone
```

- `local_directory`：固定到拥有该目录的 Device；
- `git_checkout`：Runtime 准备独立 checkout；
- `git_worktree`：Runtime 从指定仓库建立隔离 worktree；
- `standalone`：不属于协作 Project 的本地 Codex 对话目录。

现有本地 `Project` 展示分组不成为云端 Project 身份。它继续由
`deviceId + workspacePath` 推导，但产品术语应改为本地工作区，避免与协作 Project
混淆。

## Run、LocalTask 与 Codex Thread

三者不能合并为一个 ID：

| 实体 | 身份 | 事实来源 |
| --- | --- | --- |
| Run | `run_id` / `LoopItemExecution.id` | Backend |
| LocalTask | `deviceId + localTaskId` | Wework Executor |
| Codex Thread | opaque `threadId` | Codex app-server |
| Turn | provider turn ID / subtask ID | Codex 与 Executor |

关系为：

```text
Run 1 ── 1 BackendBinding
                 N ── 1 LocalTask ── 1 Codex Thread
                                         └── N Turns
```

重试默认创建新 Run。是否继续原 LocalTask/Codex Thread，由明确的恢复策略决定并
记录为 `resumed_from_run_id`，不能仅通过路径、标题或最近线程猜测。恢复创建的
Run 始终建立自己的 BackendBinding；该绑定可以指向之前的 LocalTask 和 Codex
Thread，因此一个 LocalTask 可以在不同时期对应多个 BackendBinding。恢复后的事件
归属新 Run 及其 BackendBinding，按该绑定的事件序号单调递增，并且只更新新 Run；
旧 Run、旧绑定及其事件保持为不可变历史。

## 两类本地工作

本地任务必须区分协作执行和个人对话。

### 协作执行

```text
Issue
→ 任意有执行权限的 Project Member 点击“在本地执行”
→ Run
→ Wework Runtime
→ LocalTask
→ Codex Thread
```

Backend Run 是生命周期事实来源；LocalTask 和 Codex Thread 提供设备侧执行细节。
状态、日志、取消、交付和恢复必须投影回 Run。

Issue 是否分配给当前用户不影响这个入口。Assignment 只决定通知和待处理列表，不
决定谁可以启动本地执行。创建 Run 时必须记录：

```text
initiated_by = 当前 Member
agent_id = 本次选择的 Codex Agent
trigger = manual
```

Project 可以提供默认 Agent、Runtime 和本地工作区绑定，但用户在有权限时可以显式
覆盖。若已有其他活跃 Run，Wework 应展示并发工作提示和已有执行入口，而不是因为
用户未被分配而禁止启动。

### 独立本地对话

```text
LocalTask
→ Codex Thread
```

独立对话可以只存在设备，不要求先创建 Workspace、Project、Issue 或 Run。当用户
选择“加入协作项目”或系统为其建立明确绑定后，才创建 Issue/Run 关系；不得把所有
历史本地对话静默上传到云端。

## 统一创建与执行协议

协作执行统一使用：

```text
Create Run
→ persist immutable intent
→ select Runtime
→ executor claim
→ materialize Agent snapshot
→ prepare Execution Workspace
→ create/link LocalTask
→ start/resume Codex Thread
→ stream normalized events
→ persist terminal state and Deliverables
```

现有 `RuntimeTaskCreateRequest V2` 可以演进为统一执行请求，但必须满足：

1. 以 `run_id` 作为协作执行的顶层关联身份；
2. Bot、Ghost、Shell、Model 和 Plugin 来自 Agent 快照；
3. secret 只在本地或云端 compiler 中物化；
4. Wework 与 Wegent Executor 消费相同的规范字段；
5. 后端专有字段放入显式扩展区，不改变公共状态和事件协议。

## 状态与事件

Run 使用统一状态：

```text
pending_approval
→ waiting_runtime
→ queued
→ claimed
→ running
→ completed | failed

claimed | running
→ cancel_requested
→ cancelled

pending_approval | waiting_runtime | queued
→ cancelled
```

LocalTask、Codex thread 和 turn 的状态通过投影器更新 Run，不能直接由前端推断。
每个事件至少携带：

```text
run_id
runtime_instance_id
device_id
local_task_id
provider_thread_id
turn_id
event_sequence
event_type
timestamp
```

Backend 只接受与当前 Run、Runtime 和 BackendBinding 一致且序号单调递增的事件。

## 本地执行需要删除的重复路径

收敛过程中应删除：

- `ProjectChatAgent` 中重复的 Agent Prompt、Model、Plugin 和完整执行身份；
- `WeworkExecutionProfile` 临时构造伪 Bot 的逻辑；
- 本地和 Wegent 分别解析 Skill、MCP、Plugin 的两套能力路径；
- 通过 `workspacePath`、标题或最近任务推断执行身份的路径；
- 前端根据 LocalTask 或 transcript 猜测协作 Run 终态的逻辑；
- 把 Executor 或安装了 Plugin 的 Device 暴露为协作 Member 的逻辑。

## 演进顺序

1. 在 Ghost 增加 Plugin 引用，并实现统一有效能力清单。
2. 增加正式 Codex Shell，并让现有本地 Codex 请求从 Shell 定义生成。
3. 从 Team/Bot/Ghost 编译不可变 `AgentExecutionSnapshot`。
4. 让 LoopItemExecution 保存 `run_id`、Agent 快照和统一 BackendBinding。
5. 修改 Wework Executor，使其直接消费统一快照和执行请求。
6. 将 ProjectChatAgent 收敛为 ProjectAgentBinding。
7. 统一本地和云端执行事件、取消、恢复与 Deliverable 协议。
8. 保留独立 LocalTask 模式，并提供显式“加入协作项目”入口。
