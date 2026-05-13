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
- executor local 支持按项目复用目录，而不是每次对话按 task_id 新建目录。
- 云端 executor 支持按项目复用运行环境，避免同一项目的多次对话互相割裂。

## 非目标

- 不新增一套独立于 Task/Subtask 的消息模型。
- 不把 Project 做成新的 Task 类型。
- 不在第一阶段实现复杂项目成员权限；项目仍按当前用户所有权管理。
- 不允许云端模式使用任意宿主机绝对路径。

## 核心方案

采用 `Project = 固定工作区配置，Task = 项目下的一次对话`。

Project 保存环境、智能体、目录或 Git、默认分支等配置。用户在项目里新建对话时，后端使用 Project 配置创建新的 Task，并写入 `tasks.project_id`。现有 Task/Subtask、WebSocket、消息展示、重试、取消、分享、导出能力继续复用。

## 数据模型

扩展 `projects` 表：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `execution_target_type` | string | `local` 或 `cloud` |
| `device_id` | string nullable | 本地设备 ID，云端为空 |
| `team_id` | int nullable | 项目默认智能体 ID |
| `team_name` | string nullable | 默认智能体名称快照 |
| `team_namespace` | string | 默认 `default` |
| `workspace_source` | string | `git` 或 `local_path` |
| `local_path` | string nullable | 指定目录模式下的目录地址 |
| `checkout_path` | string nullable | Git 模式下的目标目录；为空时使用系统默认目录 |
| `git_url` | string nullable | Git clone URL |
| `git_repo` | string nullable | 仓库名，例如 `owner/repo` |
| `git_repo_id` | int nullable | 外部 Git 仓库 ID |
| `git_domain` | string nullable | Git 域名 |
| `branch_name` | string nullable | 默认分支 |
| `workspace_ref_name` | string nullable | 云端 Workspace CRD 名称 |
| `workspace_ref_namespace` | string nullable | 云端 Workspace CRD namespace |
| `last_task_id` | int nullable | 项目最近一次对话 |
| `metadata` | JSON nullable | 预留扩展字段 |

保留现有 `tasks.project_id`，用于关联项目下的多次对话。

Task 的 CRD metadata labels 增加：

```json
{
  "projectId": "123"
}
```

Task 的 `spec.workspaceRef` 指向项目 Workspace。对于本地指定目录，Workspace 的 repository 可以为空，但 Workspace metadata 或 spec 需要保存项目路径信息，供 ExecutionRequest 构建。

## 项目地址规则

项目地址由 `workspace_source` 决定。

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
- executor local 直接以 `local_path` 作为项目根目录。
- 如果目录不存在，executor local 创建目录。
- 如果目录存在，executor local 不修改或覆盖已有文件。
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

## 前端交互

首页左侧结构：

1. 固定导航区。
2. 分组对话。
3. 项目。
4. 历史会话。

项目区行为：

- 项目 header 展示名称、环境图标、智能体摘要、对话数量。
- 点击项目：默认打开 `last_task_id`；如果没有对话，进入项目空状态。
- 项目右侧菜单：新对话、编辑项目、删除项目。
- 展开项目：展示项目下的多次对话。
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

## Executor Local 适配

当前 executor local 主要按 task_id 生成工作目录。项目模式下改为项目工作区优先：

1. ExecutionRequest 增加 `project_id`、`project_workspace_path`、`workspace_source`、`execution_target_type`。
2. executor local 收到任务后解析项目字段。
3. 如果 `workspace_source=local_path`，使用 `project_workspace_path` 作为 `project_path`。
4. 如果 `workspace_source=git`，使用 `checkout_path` 或默认项目目录。
5. 同一项目的多次对话复用同一 `project_path`。
6. 附件继续隔离存储，路径改为项目目录下的 `.wegent/attachments/{task_id}/{subtask_id}`。
7. Git diff、提交、工作区预览使用项目目录，而不是 task_id 目录。

本地设备执行不自动覆盖用户已有目录。遇到非空目录和 Git URL 不一致时返回明确错误，提示用户编辑项目配置或选择其他目录。

## 云端 Executor 适配

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

`TaskRequestBuilder._build_workspace()` 需要从 Task 的 `project_id` 或 Task labels 中识别项目，并把项目工作区信息合并到 `ExecutionRequest.workspace`。

新增字段建议放入 shared execution model：

```python
project_id: Optional[int]
workspace_source: Optional[str]
project_workspace_path: Optional[str]
execution_target_type: Optional[str]
```

旧任务没有这些字段时保持原逻辑。

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
- 项目下创建多条 Task，校验 `project_id`、`workspaceRef`、`last_task_id`。
- 移动历史 Task 到项目，不修改项目默认配置。

前端：

- 创建项目表单按环境切换字段。
- Git 模式和指定目录模式分别提交正确 payload。
- 项目列表展示项目和多次对话。
- 点击项目打开最近对话。
- 项目下新对话调用项目 conversations 创建入口。

executor local：

- Git 模式使用项目默认目录。
- 指定目录模式使用 `local_path`。
- 同一项目多次任务复用同一 `project_path`。
- 附件下载到项目隔离目录。
- 非 Git 目录不触发 Git diff 失败。

executor_manager：

- 有 `project_id` 时复用 `project_executor:{project_id}`。
- 无 `project_id` 时保持现有 task 级绑定。
- 项目级 executor 不在单次对话完成后被常规任务清理误删。

## 实施顺序

1. 扩展 Project schema、model、migration、service。
2. 扩展项目创建/编辑 API 和前端类型。
3. 改造 ProjectSection 和创建项目 Dialog。
4. 增加项目下新建对话入口。
5. 扩展 Task 创建链路，支持 `project_id` 和项目配置注入。
6. 扩展 ExecutionRequest 和 TaskRequestBuilder。
7. 适配 executor local 项目工作区。
8. 适配 executor_manager 项目级绑定。
9. 补齐单元测试和关键前端测试。
