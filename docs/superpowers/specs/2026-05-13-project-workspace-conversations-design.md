---
sidebar_position: 1
---

# 项目工作区多轮对话设计

## 背景

Wegent 目前已经有 Project 基础能力，用于把历史 Task 分组展示在首页左侧。现有 Project 更接近“会话分组”，还没有承载固定执行环境、智能体、项目目录、Git 仓库和 executor 复用策略。

本设计将 Project 升级为“项目工作区配置”，Task 继续表示项目下的一次对话。一个 Project 可以包含多条 Task 对话，多次对话共享同一项目配置和工作区。

## 目标

- 在首页左侧“分组对话”下面展示“项目”区域。
- 用户可以创建和管理项目。
- 创建项目时可以选择环境：本地设备或云端设备。
- 创建项目时可以选择默认智能体。
- 项目地址支持两种来源：从 Git 拉取，或指定目录地址。
- 用户可以在同一个项目下发起多次对话。
- ClaudeCode executor 支持按项目复用目录，而不是每次对话按 task_id 新建目录。
- 云端 executor 支持按项目复用运行环境，避免同一项目的多次对话互相割裂。

## 非目标

- 不新增一套独立于 Task/Subtask 的消息模型。
- 不把 Project 做成新的 Task 类型。
- 不在第一阶段实现复杂项目成员权限；项目仍按当前用户所有权管理。
- 不允许云端模式使用任意宿主机绝对路径。

## 核心方案

采用 `Project = 固定工作区配置，Task = 项目下的一次对话`。

Project 保存环境、智能体、目录或 Git、默认分支等配置。用户在项目里新建对话时，后端使用 Project 配置创建新的 Task，并写入 `tasks.project_id`。现有 Task/Subtask、WebSocket、消息展示、重试、取消、分享、导出能力继续复用。

## Session 模型

不新增 `task_sessions` 表。项目下的多个 session 直接建模为多个 Task：

```text
Project
  ├── Task 1001 = session 1001
  ├── Task 1002 = session 1002
  └── Task 1003 = session 1003
```

在项目语境下，`task_id` 就是 session 的持久化标识。每次点击“项目新对话”都会在同一个 Project 下创建一条新的 Task；继续某个 session 时，前端传对应 `task_id`，后端和 executor 按现有 Task/Subtask 逻辑续写。

这样设计有三个约束：

- 一个 Task 只对应一个会话上下文，不在 Task 内再拆多个 session。
- 一个 Project 可以包含多个 Task，因此也就包含多个 session。
- session 的展示名称、状态、最近更新时间复用 Task 的 title/status/updated_at。

如果用户需要“从当前上下文开一个新分支”，产品上表现为在同一 Project 下创建新 Task，并可选择复制最近 N 条消息作为首条上下文。新 Task 仍有独立 `task_id`，不会和原 Task 共享 runtime session。

## 数据模型

扩展 `projects` 表时只增加少量稳定字段，把容易变化的执行配置收敛到一个 JSON 字段，避免表结构膨胀。

建议新增物理列：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `config` | JSON nullable | 项目的执行环境、智能体、地址、Git、Workspace 配置 |

`config` 使用明确 schema，而不是任意散装 JSON：

```json
{
  "mode": "workspace",
  "execution": {
    "targetType": "local",
    "deviceId": "device-xxx"
  },
  "team": {
    "id": 12,
    "name": "code-agent",
    "namespace": "default"
  },
  "workspace": {
    "source": "git",
    "localPath": null,
    "checkoutPath": null,
    "workspaceRef": {
      "name": "project-workspace-123",
      "namespace": "default"
    }
  },
  "git": {
    "url": "https://github.com/example/repo.git",
    "repo": "example/repo",
    "repoId": 123456,
    "domain": "github.com",
    "branch": "main"
  }
}
```

字段语义：

- `mode`: `workspace` 表示新项目工作区；为空或缺失表示旧的任务分组项目。
- `execution.targetType`: `local` 或 `cloud`。
- `execution.deviceId`: 本地设备 ID，云端为空。
- `team`: 项目默认智能体快照。
- `workspace.source`: `git` 或 `local_path`。
- `workspace.localPath`: 指定目录模式下的目录地址。
- `workspace.checkoutPath`: Git 模式下的目标目录；为空时使用系统默认目录。
- `workspace.workspaceRef`: 云端或 Git 模式对应的 Workspace CRD。
- `git`: Git 模式下的仓库信息；指定目录模式可为空。

保留现有 `tasks.project_id`，用于关联项目下的多次对话。

不新增 `last_task_id`。项目最近会话可以通过 `tasks.project_id` 按 `updated_at desc` 查询得到。这样避免维护冗余字段，也避免删除、移动、重命名 Task 后需要同步更新 Project。

## 旧项目分组和新项目工作区

现有 `projects` 表和 `/api/projects` 已经承担“把历史 Task 分组”的能力。新功能继续复用这张表，但通过 `config.mode` 区分语义：

- `config` 为空或 `config.mode` 为空：旧项目分组，只用于组织历史 Task。
- `config.mode = "workspace"`：新项目工作区，包含执行环境、默认智能体、项目地址和 Workspace 配置。

接口保持向后兼容：

- 旧的 `POST /projects` 仍可只传名称、描述、颜色，创建任务分组。
- 新的 `POST /projects` 传 `config.mode = "workspace"`，创建项目工作区。
- `POST /projects/{project_id}/tasks/{task_id}` 对两种项目都可用，表示把已有 Task 放进项目。
- `POST /projects/{project_id}/conversations` 只对 `workspace` 项目开放，用项目配置创建新 Task/session。

前端展示上也区分：

- “项目工作区”展示环境、智能体、项目地址和新对话入口。
- “历史分组”只展示分组下的历史会话，不展示执行配置。

Task 的 CRD metadata labels 增加：

```json
{
  "projectId": "123"
}
```

Task 的 `spec.workspaceRef` 指向项目 Workspace。对于本地指定目录，Workspace 的 repository 可以为空；项目路径信息以 Project `config.workspace` 为准，供 ExecutionRequest 构建。

## 项目地址规则

项目地址由 `config.workspace.source` 决定。

### Git 模式

用户填写 Git 信息，可以选择指定目标目录，也可以使用默认目录。

默认目录：

- 本地设备：`~/.wegent-executor/workspace/projects/{project_id}/{repo_name}`
- 云端设备：`/workspace/projects/{project_id}/{repo_name}`

如果用户指定目录：

- 本地设备：使用指定目录。目录不存在则创建；目录为空且有 Git 信息则 clone；目录非空时校验是否为 Git 仓库，不覆盖内容。
- 云端设备：只允许项目工作区下的相对路径或系统生成路径，不接受任意宿主机绝对路径。

### 指定目录模式

用户填写 `local_path`。

- 该模式只对本地设备开放。
- ClaudeCode executor 直接以 `local_path` 作为项目根目录。
- 如果目录不存在，ClaudeCode executor 创建目录。
- 如果目录存在，ClaudeCode executor 不修改或覆盖已有文件。
- 如果目录不是 Git 仓库，仍允许对话和文件操作，但 Git diff、提交等能力只在存在 `.git` 时启用。

## 后端 API

扩展现有 `/api/projects`：

- `POST /projects`：创建项目配置，必要时创建 Workspace。
- `PUT /projects/{project_id}`：更新项目配置。
- `GET /projects/{project_id}`：返回项目配置和项目下对话。
- `GET /projects`：返回项目列表，包含配置摘要和对话数量。
- `POST /projects/{project_id}/conversations`：在项目下创建一条新对话。
- `POST /projects/{project_id}/tasks/{task_id}`：把已有历史会话加入项目。
- `DELETE /projects/{project_id}/tasks/{task_id}`：把会话移出项目。

`POST /projects/{project_id}/conversations` 不要求前端重复传 Git、目录、device、team。后端从 Project 读取配置，创建 Task 和 Workspace 绑定，避免项目配置和会话配置漂移。

后端对 `config` 做 Pydantic schema 校验，不允许 API 写入未定义字段。服务层提供小型访问器，例如 `project_config.execution.target_type`、`project_config.workspace.source`，避免业务代码到处手写 JSON key。

## 前端交互

首页左侧结构：

1. 固定导航区。
2. 分组对话。
3. 项目。
4. 历史会话。

项目区行为：

- 项目 header 展示名称、环境图标、智能体摘要、对话数量。
- 点击项目：打开该项目下 `updated_at` 最近的 Task；如果没有对话，进入项目空状态。
- 项目右侧菜单：新对话、编辑项目、删除项目。
- 展开项目：展示项目下的多次对话，每条对话就是一个 session，对应一条 Task。
- 项目内对话点击后进入当前 Task 的聊天页。
- 历史会话可以拖入项目，只改变 `project_id`，不修改项目默认配置。

创建项目表单：

1. 项目名称。
2. 环境：本地设备或云端设备。
3. 本地设备选择，仅本地环境显示。
4. 智能体选择。
5. 项目地址来源：从 Git 拉取或指定目录。
6. Git 表单：Git URL、仓库、分支、目标目录可选。
7. 指定目录表单：目录地址。

移动端沿用组件分离原则，创建和编辑项目使用移动端友好的全屏 Dialog 或 Drawer，交互元素满足 44px 触控要求。

## ClaudeCode Executor 适配

项目工作区只适配 ClaudeCode。Agno 和 Dify 不纳入本设计。

当前 ClaudeCode executor 主要按 task_id 生成工作目录。项目模式下改为项目工作区优先：

1. ExecutionRequest 增加 `project_id`、`project_workspace_path`、`workspace_source`、`execution_target_type`。
2. ClaudeCode executor 收到任务后解析项目字段。
3. 如果 `workspace_source=local_path`，使用 `project_workspace_path` 作为 `project_path`。
4. 如果 `workspace_source=git`，使用 `checkout_path` 或默认项目目录。
5. 同一项目的多次对话复用同一 `project_path`。
6. 附件继续隔离存储，路径改为项目目录下的 `.wegent/attachments/{task_id}/{subtask_id}`。
7. Git diff、提交、工作区预览使用项目目录，而不是 task_id 目录。

runtime session 仍按 `task_id` 隔离：

- ClaudeCode 的 `.claude_session_id` 存储在项目目录下的 `.wegent/sessions/{task_id}/`。

这保证同一个 Project 共享代码目录，但不同 Task/session 不共享 ClaudeCode 运行上下文。

本地设备执行不自动覆盖用户已有目录。遇到非空目录和 Git URL 不一致时返回明确错误，提示用户编辑项目配置或选择其他目录。

## 本地和云端执行适配

本地设备和云端设备的运行方式保持一致：都运行 ClaudeCode executor。区别只是运行位置不同：

- 本地设备：运行在用户自己的电脑上。
- 云端设备：运行在云端托管的 executor 环境里。

因此项目模式不再拆成两套语义。调度层根据 `execution.targetType` 和 `deviceId` 选择目标设备，executor 侧拿到的 ExecutionRequest 结构一致。

executor_manager 现有 task 级绑定类似 `task_executor:{task_id}`。项目模式新增项目级绑定：

```text
project_executor:{project_id}
```

调度规则：

1. 有 `project_id` 时优先查项目级 executor。
2. 项目级 executor 健康则复用。
3. 不存在或不可用时创建新 executor，并保存项目级绑定。
4. 没有 `project_id` 的任务继续使用现有 task 级逻辑。

项目级 executor 清理策略：

- 默认不在单次对话完成后立即删除。
- 按项目最近活跃时间清理。
- 用户删除项目时清理项目级 executor 和 Workspace 绑定。

## ExecutionRequest 构建

`TaskRequestBuilder._build_workspace()` 需要从 Task 的 `project_id` 或 Task labels 中识别项目，读取 Project `config`，并把项目工作区信息合并到 `ExecutionRequest.workspace`。

新增字段建议放入 shared execution model：

```python
project_id: Optional[int]
workspace_source: Optional[str]
project_workspace_path: Optional[str]
execution_target_type: Optional[str]
```

不新增独立的 `task_session_id`。需要传递 runtime session 时直接使用现有 `task_id`。

未关联项目的任务继续使用现有 task 级工作区逻辑。

## 权限和校验

- Project 按 `user_id` 查询，避免跨用户读取。
- 本地指定目录只发送给对应用户自己的本地设备。
- 后端只保存路径字符串，不在服务端访问用户本机路径。
- 云端模式拒绝任意绝对路径。
- Git token 继续复用用户 Git 配置和现有加密机制。

## 测试计划

后端：

- 创建 Git 模式项目，校验默认目录和 Workspace 信息。
- 创建本地指定目录项目，校验 `local_path` 必填。
- 云端项目拒绝任意绝对路径。
- 项目下创建多条 Task，校验 `project_id` 和 `workspaceRef`。
- 项目最近会话通过 `tasks.project_id` + `updated_at desc` 查询得到。
- 项目下每条 Task 独立作为 session，校验消息续写按 `task_id` 隔离。
- `config` 为空的项目仍按旧历史分组行为工作。
- `config.mode = "workspace"` 的项目支持 conversations 创建入口。
- 移动历史 Task 到项目，不修改项目默认配置。

前端：

- 创建项目表单按环境切换字段。
- Git 模式和指定目录模式分别提交正确 payload。
- 项目列表展示项目和多次对话。
- 点击项目打开最近对话。
- 项目下新对话调用项目 conversations 创建入口。

ClaudeCode executor：

- Git 模式使用项目默认目录。
- 指定目录模式使用 `local_path`。
- 同一项目多次任务复用同一 `project_path`。
- 同一项目不同 Task 使用不同 runtime session 文件或 session key。
- 附件下载到项目隔离目录。
- 非 Git 目录不触发 Git diff 失败。

executor_manager：

- 有 `project_id` 时复用 `project_executor:{project_id}`。
- 无 `project_id` 时保持现有 task 级绑定。
- 项目级 executor 不在单次对话完成后被常规任务清理误删。

## 实施顺序

1. 扩展 Project schema、model、migration、service，只新增 `config` 字段。
2. 扩展项目创建/编辑 API 和前端类型。
3. 改造 ProjectSection 和创建项目 Dialog。
4. 增加项目下新建对话入口。
5. 扩展 Task 创建链路，支持 `project_id` 和项目配置注入。
6. 扩展 ExecutionRequest 和 TaskRequestBuilder。
7. 适配 ClaudeCode executor 项目工作区。
8. 适配 executor_manager 项目级绑定，统一本地和云端 ClaudeCode 调度语义。
9. 补齐单元测试和关键前端测试。
