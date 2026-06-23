---
sidebar_position: 1
---

# IM 续接 Wework 开发任务设计

## 背景

Wegent 已经支持多种 IM channel，例如 DingTalk 和 Telegram。现有 IM 通道可以进行普通 AI 对话，也支持 `/use device`、`/devices`、`/use cloud`、`/agents` 等命令，把消息路由到设备或云端执行。

Wework 侧是独立的客户端入口，任务和会话列表以 `client_origin=wework` 过滤。用户在 wework 里开发到一半后，如果离开电脑，希望能在 IM 私聊里继续同一个开发任务。现有 IM 执行链没有明确的“绑定到已有 wework task”模型，也没有 provider 无关的 IM 私聊 session 状态管理，因此容易出现任务执行了但不属于 wework，或 IM 消息进入普通聊天而不是继续当前开发任务。

## 目标

1. 用户可以把一个个人 wework task 切换到一个或多个已绑定 IM 私聊中继续。
2. 用户在 IM 的 Task 模式下可以继续已有 wework task，也可以引导式新建 wework task。
3. Task 模式追加消息时沿用原 task 的项目、工作区、分支、agent、model、device 等配置。
4. Wework 消息流能标注 IM 来源，例如“来自钉钉”。
5. 多 IM provider 共用同一套 session、命令、状态和权限逻辑。
6. v1 只支持个人任务和私聊，不支持群聊和协作任务。

## 非目标

1. 不支持 IM 群聊续接任务。
2. 不支持协作任务或多人权限绑定。
3. 不做自动绑定最近任务，避免消息进入错误任务。
4. 不做通知偏好设置、解绑 UI、复杂任务订阅管理。
5. 不把 wework 用户消息完整镜像到 IM。

## 核心概念

### Chat 模式

IM 作为普通 AI 聊天入口。用户发消息后走现有 IM chat 流程，不影响 wework 任务。

### Task 模式

IM 作为 wework 开发任务入口。普通消息会追加到当前 active task。如果没有 active task，系统进入新建或切换引导。

### IM Private Session

IM private session 表示一个 Wegent 用户在某个 IM 平台、某个 channel 配置下的一段私聊会话。session 是 provider 无关的，DingTalk、Telegram、Feishu 等通道都只负责解析平台消息和发送平台回复。

建议新增持久化模型 `IMPrivateSession`：

| 字段 | 说明 |
| --- | --- |
| `id` | session ID |
| `user_id` | Wegent 用户 ID |
| `channel_type` | `dingtalk`、`telegram` 等 |
| `channel_id` | 后端 IM channel 配置 ID |
| `conversation_id` | 平台私聊会话 ID |
| `sender_id` | 平台用户 ID，用于排查和展示 |
| `display_name` | 平台展示名 |
| `mode` | `chat` 或 `task` |
| `state` | `idle`、`pending_task_switch`、`pending_task_creation` |
| `active_task_id` | Task 模式下当前绑定的 wework task |
| `pending_payload` | 引导状态数据，例如候选任务、候选项目、first message |
| `state_expires_at` | pending 状态过期时间 |
| `last_seen_at` | 最近收到 IM 消息时间 |
| `created_at` / `updated_at` | 审计时间 |

唯一约束建议使用 `(channel_type, channel_id, conversation_id, user_id)`。同一个 IM session 同一时间只能有一个 active task。一个 task 可以同时被多个 IM session 绑定。

## 状态模型

Session 使用两个维度表达当前行为：

```text
mode: chat | task
state: idle | pending_task_switch | pending_task_creation
```

派生状态：

- `chat + idle`: 普通 IM 聊天。
- `task + idle + active_task_id`: Task 模式，绑定已有 task。
- `task + idle + no active_task_id`: Task 模式空闲，等待选择或新建 task。
- `task + pending_task_switch`: 正在选择已有 task。
- `task + pending_task_creation`: 正在选择项目或 standalone task 以新建 task。

Pending 状态只接受数字序号、`new` 和 `/cancel`。其他输入只返回提示，不执行。

## IM 命令

v1 命令保持短：

| 命令 | 行为 |
| --- | --- |
| `/bind` | 建立或刷新当前 IM 私聊 session |
| `/mode` | 查看当前模式 |
| `/chat` | 切到普通 Chat 模式 |
| `/task` | 切到 Task 模式；无 active task 时进入选择引导 |
| `/new` | 当前模式下新建。Chat 模式开始新 chat session，Task 模式进入新建 task 引导 |
| `/switch` | Task 模式下选择已有个人 wework task |
| `/cancel` | 取消当前 pending 引导 |
| `/status` | 显示当前模式、active task、执行目标、模型和 agent |

现有 `/devices`、`/models`、`/agents`、`/use` 继续保留，但 Task 模式追加到已有 task 时默认沿用 task 自身配置。只有用户显式切换时才改变后续执行目标或模型。

## 交互流程

### Wework 切换到 IM 继续

1. 用户在 wework 个人任务页点击“在 IM 继续”。
2. Wework 调用 `GET /im/private-sessions` 获取当前用户已绑定的 IM 私聊列表。
3. 用户多选目标 IM session。
4. Wework 调用 `POST /tasks/{task_id}/im-sessions`。
5. 后端校验 task 是当前用户拥有的个人 `client_origin=wework` task。
6. 后端把所选 session 切到 `task + idle`，设置 `active_task_id=task_id`。
7. 每个 IM 私聊收到确认消息：`已切换到任务：<title>。你可以在这里继续。`

如果没有任何 IM 私聊 session，wework 弹窗提示用户先在对应 IM 私聊机器人发送 `/bind` 或任意消息。

### IM 选择已有任务

1. 用户发送 `/task` 或 `/switch`。
2. 系统进入 `pending_task_switch`。
3. 系统列出最近个人 wework task，并提供 `new`。
4. 用户回复序号。
5. 系统校验任务权限，绑定 session，回复切换成功。

示例：

```text
请选择要继续的任务，或回复 new 创建新任务：
1. 修复登录回调
2. 调整 wework 项目选择
3. 实现 IM 续接任务

回复序号切换，回复 new 新建，回复 /cancel 取消。
```

### IM 新建任务

新建可以由两种方式触发：

- Task 模式下发送 `/new`。
- Task 模式未绑定 task 时直接发送普通需求文本。

如果用户发送普通需求文本，系统把该文本保存为 `pending_payload.first_message`，然后进入 `pending_task_creation`。用户选完项目后，系统自动用 first message 创建并执行 task。

示例：

```text
请选择要在哪个项目中创建任务：
1. Wegent
2. Mobile App
3. 不使用项目，创建独立任务

回复序号创建，回复 /cancel 取消。
```

如果没有 first message，创建成功后提示用户发送任务需求。

### 普通消息追加到 active task

Task 模式绑定 active task 后，用户在 IM 私聊发送普通消息：

1. 后端加载 session 和 active task。
2. 校验 task 仍然存在、未归档、属于当前用户、`client_origin=wework`。
3. 调用与 wework `chat:send` 等价的统一 task append 逻辑。
4. 消息进入原 task，并保留 IM source metadata。
5. 如果 task 正在执行，复用现有 guidance 或 queued message 规则。
6. 发起本轮消息的 IM session 接收流式内容。

## API 设计

### `GET /im/private-sessions`

返回当前用户已绑定的 IM 私聊 session。

响应字段包括：

- `id`
- `channel_type`
- `channel_label`
- `display_name`
- `mode`
- `active_task_id`
- `last_seen_at`

### `POST /tasks/{task_id}/im-sessions`

把当前用户的一个个人 wework task 绑定到多个 IM 私聊 session。

请求：

```json
{
  "session_ids": [1, 2]
}
```

行为：

- 校验 task 属于当前用户。
- 校验 task 是 `client_origin=wework`。
- 校验 task 是个人任务，不是群聊或协作任务。
- 校验 session 都属于当前用户。
- 把 session 设置为 `mode=task`、`state=idle`、`active_task_id=task_id`。
- 向 IM 私聊发送切换成功通知。

### 后续可选接口

v1 不要求 UI 使用，但后端可以保留清晰边界：

- `GET /tasks/{task_id}/im-sessions`: 查看当前绑定到 task 的 IM session。
- `DELETE /tasks/{task_id}/im-sessions/{session_id}`: 解绑一个 IM session。

## 后端组件

### `IMSessionService`

职责：

- 创建和刷新 IM private session。
- 读写 mode、state、active task 和 pending payload。
- 查询当前用户可用于 wework 绑定的 IM 私聊。
- 处理 pending 超时清理。

### `IMTaskContinuationService`

职责：

- 校验个人 wework task 权限。
- 将多个 IM session 绑定到同一个 task。
- 追加 IM 消息到 existing task。
- 根据项目选择创建新的 `client_origin=wework` task。
- 写入 IM source metadata。

### `IMCommandRouter`

职责：

- 处理 `/bind`、`/mode`、`/chat`、`/task`、`/new`、`/switch`、`/cancel`。
- 驱动 pending 引导。
- 生成 provider 无关的回复文本。
- 不直接依赖 DingTalk 或 Telegram SDK。

### `IMNotificationDispatcher`

职责：

- 根据 `active_task_id` 查询绑定到 task 的 IM sessions。
- 向发起 session 推送流式内容。
- 向所有绑定 session 推送关键状态。
- 复用各 provider 现有 sender 或 callback service。

## 任务追加实现原则

Task 模式追加到 existing task 时，必须复用现有任务创建和追加逻辑，不能复制一条 IM-only 执行链。

具体原则：

- 创建新 wework task 时显式设置 `client_origin=wework`。
- 追加 existing task 时保留原 task 的 `client_origin`、项目、工作区、分支、team、model、device。
- 运行态校验、queued message、guidance、device routing、task status 更新都沿用现有规则。
- 如果 active task 已删除、归档或不再可访问，session 回到 `task_idle` 并提示用户重新选择。

## 来源标注

IM 发来的用户消息需要在消息或 subtask metadata 中保存来源：

```json
{
  "source": "im",
  "channel_type": "dingtalk",
  "channel_label": "钉钉",
  "session_id": 123
}
```

Wework 消息流显示“来自钉钉”或对应 IM 名称。导出和历史记录也保留该来源。

## 通知规则

1. IM 发起的一轮消息，发起 session 接收流式内容。
2. 同 task 绑定的其他 IM session 只接收关键状态，不接收完整流式内容。
3. Wework 发起的一轮消息，绑定 IM session 接收关键状态，不接收完整流式内容。
4. 关键状态包括任务开始、完成、失败、需要确认或用户输入。
5. Wework 用户消息不镜像到 IM。
6. IM 用户消息进入 wework 消息流。

## 权限和边界

v1 只支持个人任务：

- 当前登录用户必须是 task owner。
- IM session 解析出的 Wegent 用户必须是同一个用户。
- task 必须是 `client_origin=wework`。
- task 不能是群聊或协作任务。
- 不支持从 IM 绑定其他用户 task。

错误处理：

- Session 未绑定：提示先发送 `/bind`。
- Pending 输入无效：提示回复序号、`new` 或 `/cancel`。
- Task 不可用：解除 active task，回到 Task 模式空闲状态。
- 设备离线：沿用当前设备模式提示。
- IM 发送失败：记录日志，不回滚 task 消息追加。

## Wework UI

v1 最小 UI：

- 个人 task 页面增加“在 IM 继续”按钮。
- 弹窗展示当前用户已绑定的 IM 私聊，支持多选。
- 无 IM session 时展示绑定引导。
- 绑定成功后 toast。
- 消息流展示 IM 来源标签。

暂不做：

- 解绑 UI。
- 通知偏好设置。
- 群聊入口。
- 协作任务入口。
- 任务页持续展示所有绑定 IM sessions。

## 测试计划

后端单测：

- `IMSessionService` session 创建、刷新、mode/state 转换。
- `/task`、`/new`、`/switch`、`/cancel` 的 pending 引导。
- Pending 状态下普通文本不会执行。
- First message 在新建 task 后自动作为首条需求执行。
- 绑定接口拒绝非 owner、非 wework、群聊或协作 task。
- IM 追加消息使用 existing task，不创建 `client_origin=frontend` task。
- Task 删除或归档后 session 回到 `task_idle`。

API 测试：

- `GET /im/private-sessions` 只返回当前用户 session。
- `POST /tasks/{task_id}/im-sessions` 支持多 session 绑定。
- 绑定接口验证 task 和 session 用户一致。

前端测试：

- 无 IM session 时展示绑定引导。
- 多选 IM session 后调用绑定接口。
- 绑定成功 toast。
- 消息来源标签展示。

Provider 外壳测试：

- DingTalk 和 Telegram 私聊消息能创建或刷新 session。
- Sender 被调用发送切换成功和关键状态通知。

## 分阶段交付

### 第一阶段

- 持久化 IM private session。
- Provider 无关命令 router。
- Wework task 绑定 API。
- IM Task 模式切换、追加 existing task、新建 standalone 或项目 task。
- Wework 绑定弹窗和来源标签。

### 第二阶段

- 关键状态通知分发。
- 需要确认或用户输入的 IM 交互适配。
- Pending 超时体验完善。

### 后续阶段

- 解绑 UI。
- 通知偏好。
- 群聊支持。
- 协作任务支持。
- 更细粒度的多设备和执行目标切换。
