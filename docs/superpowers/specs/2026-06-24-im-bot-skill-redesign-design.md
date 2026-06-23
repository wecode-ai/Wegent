---
sidebar_position: 1
---

# IM 机器人与自然语言控制 Skill 重设计

## 背景

现有 IM 私聊交互把普通 Wegent 对话、Wework 本地任务续接、任务选择、模式切换和状态查询都压在同一个机器人里。用户需要理解 `/new`、`/chat`、`/task`、`/switch`、`/bind`、`/status`、`/cancel` 等命令，才能知道当前消息会进入普通对话、已有任务还是本地任务。

这个模型的问题不在于平台数量，而在于用户被迫理解一套内部状态机。后台 IM channel 表单也把平台凭证、默认智能体、用户映射、Wework 续接能力和启停状态平铺在一个表单里，管理员很难判断“这个机器人到底给谁用、用来做什么”。

新设计把产品心智改为两个明确的 IM 机器人：

1. Wegent IM Bot：普通 Wegent 对话入口。
2. Wework IM Bot：Wework 本地对话和本地任务入口。

用户不再直接输入命令切换模式。需要查看或改变当前 IM 状态时，用户使用自然语言表达意图；Agent 通过系统内置 `im-control` Skill 调用 backend MCP 工具完成状态操作。

## 目标

1. 后台 IM channel 以“创建一个 IM 机器人”为核心模型，而不是让一个机器人承担多种模式。
2. 每个 IM channel 明确配置机器人类型：`wegent_chat` 或 `wework_local`。
3. 两类机器人共用同一套 `im-control` Skill 和 backend MCP 工具，工具根据当前 IM channel 的机器人类型解释目标。
4. 用户可以用自然语言完成新建、继续、查看状态、切换目标、清除当前上下文等操作。
5. 旧 slash command 保留兼容，但不再作为主交互或帮助文案中心。
6. Wework “继续到私聊”只展示 Wework IM Bot 的私聊会话。
7. 后端状态变更必须由结构化工具执行，不能依赖模型直接输出字符串命令或自行声称状态已改变。

## 非目标

1. 不在 IM 里重新实现完整网页配置中心。
2. 不允许用户在一个 IM Bot 内自由切换成另一种机器人类型。
3. 不让模型直接改 Redis 或数据库状态。
4. 不把自然语言控制做成硬编码规则引擎。
5. 不在 v1 支持群聊中的复杂多人绑定和协作任务权限。
6. 不要求不同平台的 IM provider 各自实现状态控制逻辑。

## 核心概念

### IM Bot 类型

`Messager.spec` 增加机器人类型字段：

```json
{
  "spec": {
    "channelType": "weibo",
    "botPurpose": "wework_local",
    "isEnabled": true,
    "config": {},
    "defaultTeamId": 10,
    "defaultModelName": ""
  }
}
```

字段建议：

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `botPurpose` | `wegent_chat` | 普通 Wegent 对话机器人 |
| `botPurpose` | `wework_local` | Wework 本地对话和本地任务机器人 |

缺省值使用 `wegent_chat`，用于兼容现有 channel。

### Wegent IM Bot

Wegent IM Bot 是普通 Wegent 网页对话在 IM 里的入口。

默认行为：

- 用户第一条普通消息直接创建或继续普通 Wegent 对话。
- 默认智能体、默认模型、用户映射来自后台 IM channel 配置。
- 用户说“重新开始”“换成某个智能体”“现在是什么状态”等自然语言时，Agent 使用 `im-control` Skill 调用 MCP 工具。
- 工具失败时只给明确的人话错误，并提示去网页端配置。

### Wework IM Bot

Wework IM Bot 是 Wework 本地工作在 IM 里的入口。

默认行为：

- 如果当前 IM 私聊已绑定 Wework 本地任务，普通消息继续该任务。
- 如果没有当前任务，第一条普通消息按网页/Wework 默认配置新建一个本地对话任务。
- 从 Wework UI 点击“继续到私聊”时，把当前 IM 私聊切到指定 Wework 本地任务。
- 用户说“重新开始”“不要接着刚才那个了”“当前连的是哪个任务”等自然语言时，Agent 使用同一套 `im-control` Skill 工具。

### `im-control` Skill

新增系统内置 Skill：`im-control`。

这个 Skill 的职责是让 Agent 在 IM 私聊中把自然语言状态操作映射到 backend MCP 工具。它不负责普通业务回答，也不直接保存状态。

Skill 元数据建议：

```yaml
---
name: "im-control"
description: "Use when the user wants to inspect or change the current IM bot state, such as starting over, checking the current target, switching target, or clearing the current context."
displayName: "IM Bot Control"
version: "1.0.0"
author: "Wegent Team"
tags: ["im", "messager", "state-control"]
bindShells:
  - Chat
mcpServers:
  wegent-im-control:
    type: streamable-http
    url: "${{backend_url}}/mcp/im-control/sse"
    headers:
      Authorization: "Bearer ${{task_token}}"
    timeout: 60
---
```

两类 IM Bot 都预加载该 Skill。预加载可以减少状态控制场景下的漏判，因为 IM 私聊天然需要会话状态管理。

## MCP 工具设计

两类 IM Bot 使用同一套 MCP 工具。工具不接受任意 `user_id` 或 `session_key`，而是从请求上下文解析当前 IM session、当前用户、当前 channel 和 `botPurpose`。

### 工具列表

| 工具 | 说明 |
| --- | --- |
| `get_current_state()` | 查看当前 IM Bot 类型、当前目标、可用动作和最近状态 |
| `start_new_session()` | 新建当前机器人类型对应的 session |
| `continue_current_session(message?: string)` | 继续当前 session；普通消息通常走主消息链，不一定显式调用 |
| `clear_current_session()` | 清除当前会话或当前任务绑定；必要时返回确认请求 |
| `list_available_targets(target_type?: string)` | 列出可切换目标，例如智能体、模型、本地任务 |
| `switch_target(target_query: string)` | 按自然语言目标描述切换当前目标 |
| `set_default_target(target_id: string)` | 把明确目标设为当前默认目标 |
| `confirm_pending_action(action_id: string)` | 确认上一次工具返回的待确认动作 |
| `cancel_pending_action(action_id?: string)` | 取消待确认动作 |

### 统一返回结构

所有工具返回统一结构，便于 Skill prompt 约束 Agent 回复：

```json
{
  "status": "success",
  "message": "已开始新对话。",
  "state": {
    "bot_purpose": "wegent_chat",
    "current_target_label": "默认智能体 / Kimi",
    "available_actions": ["start_new_session", "get_current_state"]
  },
  "confirmation": null
}
```

需要用户确认时：

```json
{
  "status": "needs_confirmation",
  "message": "这会清除当前任务并新建本地对话。",
  "state": {
    "bot_purpose": "wework_local",
    "current_target_label": "修复登录回调"
  },
  "confirmation": {
    "action_id": "im_action_abc123",
    "summary": "清除当前任务并新建 Wework 本地对话"
  }
}
```

错误时：

```json
{
  "status": "error",
  "message": "当前没有可用的 Wework 本地设备，请先打开 Wework。",
  "state": {
    "bot_purpose": "wework_local",
    "current_target_label": ""
  },
  "confirmation": null
}
```

### 权限和上下文

MCP server 需要新增 IM 请求上下文。上下文至少包括：

| 字段 | 说明 |
| --- | --- |
| `user_id` | 当前 Wegent 用户 |
| `im_session_key` | 当前 IM 私聊 session |
| `channel_id` | 当前 Messager channel |
| `channel_type` | 平台类型 |
| `bot_purpose` | 当前机器人类型 |
| `conversation_id` | 平台会话 ID |

工具必须校验：

- session 属于当前用户。
- channel 仍然启用。
- session 的 channel 与 token 上下文一致。
- `botPurpose` 限制工具行为，不能由模型传参覆盖。
- 对 Wework 本地任务的绑定和继续必须校验任务所有权、设备可用性和任务来源。

## 消息处理流

### 普通消息

```text
IM provider
-> MessageContext
-> 解析用户和 IMPrivateSession
-> 读取 channel.botPurpose
-> 进入对应机器人 Agent
-> Agent 正常回答或执行当前目标
```

普通业务消息不需要调用 `im-control` 工具。后端根据 `botPurpose` 和当前 session 自动决定目标：

- `wegent_chat`: 创建或继续普通 Wegent 对话。
- `wework_local`: 创建或继续 Wework 本地对话任务。

### 状态控制消息

```text
用户自然语言
-> Agent 判断这是状态控制意图
-> 加载 im-control Skill
-> 调用 /mcp/im-control/sse 工具
-> 后端更新 IM session 或返回确认请求
-> Agent 用工具 message 给用户自然语言确认
```

示例：

| 用户说法 | 工具 |
| --- | --- |
| “重新开始” | `start_new_session()` |
| “不要接着刚才那个了” | `clear_current_session()`，必要时确认 |
| “现在连的是哪个任务” | `get_current_state()` |
| “换成代码助手” | `switch_target("代码助手")` |
| “取消刚才那个操作” | `cancel_pending_action()` |

### 确认动作

高风险动作不能直接执行，例如清除当前 Wework 任务绑定、切换到模糊目标、覆盖默认目标。工具返回 `needs_confirmation` 和 `action_id`。用户确认后，Agent 调用 `confirm_pending_action(action_id)`。

Pending action 存储在 Redis，使用短 TTL，例如 10 分钟。action payload 只能由后端生成，不能由模型拼接。

### 旧命令兼容

旧命令继续支持：

- `/new` -> `start_new_session()`
- `/status` -> `get_current_state()`
- `/cancel` -> `cancel_pending_action()`
- `/switch <target>` -> `switch_target(target)`
- `/chat`、`/task` 不再作为主要模型；对于旧用户可以返回当前机器人类型说明，并建议直接与对应 Bot 对话。

旧命令内部应迁移到同一套 `IMControlService`，避免继续维护一套平行状态机。

帮助文案不再展示命令列表，而展示自然语言例子：

```text
你可以直接发送问题，也可以说：
- 重新开始
- 看看当前状态
- 换成代码助手
- 不要接着刚才那个了
```

## 后台表单设计

后台 `IMChannelList` 需要从“IM 渠道管理”改成“IM 机器人管理”。

### 创建流程

表单第一项是机器人类型：

1. Wegent 对话机器人
2. Wework 本地机器人

选定后展示对应说明。编辑已有 channel 时不允许切换机器人类型，避免已有私聊 session 语义变化。

### 表单分组

| 分组 | 字段 |
| --- | --- |
| 机器人身份 | 机器人名称、机器人类型、启用状态 |
| 平台连接 | 平台类型、App ID/Secret、Bot Token、WebSocket 或 token endpoint |
| 默认入口 | Wegent Bot 显示默认智能体、默认模型、用户映射；Wework Bot 显示“使用 Wework 默认本地入口”说明 |
| 内置能力 | 展示已启用自然语言状态控制，即 `im-control` Skill，不允许在此表单编辑工具列表 |

### 列表展示

列表卡片应优先展示：

- 机器人名称
- 机器人类型
- 平台
- 连接状态
- 默认入口摘要

默认入口摘要示例：

- Wegent Bot：`默认智能体：客服助手 / 模型：Kimi`
- Wework Bot：`本地入口：使用 Wework 默认配置`

### Wework “继续到私聊”

Wework 弹窗只展示 `botPurpose = wework_local` 的私聊 session。

空状态文案改为：

```text
暂无可用的 Wework 私聊。请先给 Wework IM 机器人发送任意消息，系统会自动识别这个私聊。
```

不再提示用户发送 `/bind`。

## 数据和服务变化

### `Messager` CRD

增加 `spec.botPurpose`。现有 channel 迁移时默认 `wegent_chat`。

### `IMPrivateSession`

保留 provider 无关 session 模型，但需要把路由语义从 `mode=chat/task` 逐步迁移到当前 channel 的 `botPurpose` 和当前目标。

建议新增字段：

| 字段 | 说明 |
| --- | --- |
| `current_target_type` | `conversation`、`wework_runtime_task`、`wework_local_conversation` 等 |
| `current_target` | 后端生成的目标摘要，不存敏感信息 |
| `pending_action_id` | 当前待确认动作 |

为了降低迁移风险，v1 可以继续保留 `mode`、`active_task_id`、`active_runtime_task`，但新逻辑只通过 `IMControlService` 更新它们。旧字段作为兼容存储，不再暴露为用户心智。

### `IMControlService`

新增 provider 无关服务，作为 MCP 工具和旧命令兼容路径的共同执行层。

职责：

- 读取当前 IM 状态。
- 根据 `botPurpose` 新建 session。
- 清除当前目标或生成确认动作。
- 列出可切换目标。
- 切换当前目标。
- 执行确认或取消 pending action。

### `im-control` MCP server

新增 backend MCP server：

```text
/mcp/im-control
/mcp/im-control/sse
/mcp/im-control/health
```

工具实现位于：

```text
backend/app/mcp_server/tools/im_control.py
```

server 注册方式沿用现有 `subscription`、`prompt_optimization` MCP server 模式。

## Skill prompt 约束

`im-control` Skill 需要明确告诉 Agent：

1. 只有用户想查看或改变 IM 机器人状态时才调用工具。
2. 普通业务问题不要调用状态工具。
3. 调用工具后，以工具返回的 `message` 为准回复用户。
4. 不能编造状态变更结果。
5. 工具返回 `needs_confirmation` 时必须先询问用户确认。
6. 不要教用户 slash command。
7. 不要让用户提供内部 ID，除非工具返回的选项要求用户选择。

## 迁移策略

1. `Messager.spec.botPurpose` 缺省为 `wegent_chat`，现有 channel 行为保持普通对话入口。
2. 管理后台编辑旧 channel 时显示机器人类型为 Wegent 对话机器人。
3. 新建 Wework IM Bot 时，管理员需要创建一个独立平台机器人账号或应用，并在后台选择 Wework 本地机器人。
4. 旧 `/task`、`/switch` 路径保留一段时间，但帮助和文档不再主推。
5. Wework “继续到私聊”过滤 Wework Bot session。若用户只有旧 Wegent Bot session，弹窗提示创建或使用 Wework IM Bot。

## 测试计划

### 后端单元测试

- `botPurpose` 缺省为 `wegent_chat`。
- 创建和更新 IM channel 时保存 `botPurpose`。
- `IMControlService.get_current_state()` 根据当前 channel 返回正确机器人类型。
- `start_new_session()` 在 Wegent Bot 下创建普通对话，在 Wework Bot 下创建本地对话任务。
- `clear_current_session()` 对高风险动作返回 `needs_confirmation`。
- `confirm_pending_action()` 只能执行后端生成且属于当前 session 的 action。
- MCP 工具不能接受伪造 `user_id` 或跨 session 操作。
- 旧 `/new`、`/status`、`/cancel` 调用同一服务层。

### 前端单元测试

- `IMChannelList` 创建表单先选择机器人类型。
- Wegent Bot 表单展示默认智能体、默认模型、用户映射。
- Wework Bot 表单隐藏默认智能体/模型选择，并显示使用 Wework 默认入口说明。
- 编辑已有 channel 时机器人类型不可切换。
- 列表卡片展示机器人类型和默认入口摘要。
- Wework `ContinueInImDialog` 只展示 Wework Bot session，空状态不再包含 `/bind`。

### 集成测试

- 用户给 Wegent Bot 发送“重新开始”，Agent 调用 `start_new_session()`，后端创建新普通对话。
- 用户给 Wework Bot 第一条普通消息，后端自动创建本地对话任务。
- 用户从 Wework UI 绑定任务到 Wework Bot session 后，后续 IM 消息继续同一任务。
- 用户给 Wework Bot 说“现在连的是哪个任务”，Agent 调用 `get_current_state()` 并返回自然语言状态。

## 文档更新

需要更新：

- `docs/zh/user-guide/integrations/im-channel-integration.md`
- `docs/en/user-guide/integrations/im-channel-integration.md`
- `docs/zh/user-guide/ai-coding/local-codex-thread-binding.md` 如涉及 Wework 私聊入口说明
- `docs/en/user-guide/ai-coding/local-codex-thread-binding.md`

文档应删除“必须记住命令”的叙述，改为：

- 管理员创建两个不同用途的 IM 机器人。
- 用户直接给对应机器人发消息。
- 自然语言可以控制当前状态。
- slash command 仅为兼容高级入口。

## v1 决策

1. Wework Bot 自动新建本地对话任务时，使用现有 Wework runtime 默认策略，不在 IM 表单重复配置设备或工作入口。
2. `switch_target` 的目标范围在 v1 限制为智能体、模型和当前用户最近目标，避免目标搜索过宽。
3. 后台 UI 不直接暴露 `im-control` Skill 名称，只展示“支持自然语言控制当前会话”。
4. 两个 IM Bot 是两个独立平台机器人账号或应用；Wegent 不支持在一个 IM Bot 内切换 `botPurpose`。
