---
sidebar_position: 28
---

# Wework 分身遥测

分身复用 Wework 统一遥测链路。`VITE_WEWORK_TELEMETRY_DISTRIBUTION=public` 使用 PostHog，`internal` 使用 DSH 注册的内部 sink，不初始化公开版 SDK。公开版沿用用户的遥测开关。

## 事件与统计口径

定义以 `wework/src/telemetry/registry/standInRegistry.json` 为准；运行 `pnpm --filter wework telemetry:catalog` 生成 TypeScript 白名单和公开事件目录。

| 事件 | 统计口径 |
| --- | --- |
| `stand_in_opened` | 打开总览、配置、记忆、对话或工作详情；同一可见界面的普通重渲染不重复计数 |
| `stand_in_configuration_succeeded/failed` | 实际保存配置的结果；成功事件按保存前后差异区分创建、更新、删除、启停和来源连接变化 |
| `stand_in_conversation_succeeded/failed` | 对话消息被 Runtime 接受或拒绝，包括身份会话中的后续消息 |
| `stand_in_proposal_succeeded/failed` | 接受或拒绝配置提案的实际结果；验证草稿时的保存点回滚不会产生配置成功事件 |
| `stand_in_work_action_succeeded/failed` | 确认、回复、重试、拆分、合并、移动、调整和撤销；整理操作通过受控操作枚举区分用户意图 |
| `stand_in_dispatch_succeeded/failed` | 每个匹配分身实际尝试派发的结果；复用已有任务和重复指派通知不构成新接单 |
| `stand_in_execution_started` | Executor 观察到实际运行开始，以任务和原生轮次在本地去重 |
| `stand_in_execution_waiting` | 进入等待用户回复或确认的状态；重复状态快照不重复计数 |
| `stand_in_execution_completed` | 实际执行终态；`result` 为 `success`、`failure` 或 `cancelled`，`duration_ms` 为该轮在 Executor 记录的起止时间差 |

派发成功不代表执行成功。配置一次保存可能产生多个不同动作的事件，例如创建连接并修改处理要求；配置动作次数不能直接解释为保存请求次数。执行完成也不代表业务目标通过人工验收。失败阶段来自明确的错误代码映射，不发送原始错误文本，不分析模型回复判断成功。

公共维度仅包括 `domain`、`identity`、`surface`、`source`、`trigger`、`action`、`failure_stage`、`executor_location`、`result` 和有界非负耗时。`identity` 区分主分身和角色分身，无法确定时为 `unknown`；`executor_location` 复用设备目录中的本机、云端、远端分类；来源区分本地项目、云端项目、钉钉、其他连接及身份对话。不会发送账号、设备、任务或分身 ID、名称、消息、提示词、代码、路径和凭据。传输层使用独立随机事件 UUID，不由业务标识派生。

## 离线保存与补报

Executor 在本地 SQLite 保存采集策略、待发送事实及轮次去重状态。事件产生于实际业务操作和 Runtime 状态转换，不依赖页面是否打开。默认不采集，升级不会回填既有任务。

主窗口每五秒使用现有设备路由连接本机及在线设备，通过以下 RPC 交接事件：

- `runtime.stand_in.telemetry.configure`：`userId`、`enabled`，公开版另带本次允许采集的 UTC 毫秒边界 `enabledSince`。
- `runtime.stand_in.telemetry.list`：按 `userId` 返回最多 100 条事实；事件包含随机 `id`、原始发生时间 `occurredAt`、事件名及白名单属性。
- `runtime.stand_in.telemetry.ack`：按账号确认最多 100 个事件 UUID；重复确认无副作用。

客户端按发行版、账号和设备保存持久队列，写入成功后才确认 Executor。PostHog 返回 HTTP 成功后移除客户端记录；失败保留，后续轮询重试。补报保留 UUID、发生时间和首次交接时的匿名安装身份。现有 SDK 的 `capture` 只确认内存入队，因此持久事件在同一个遥测客户端中使用 SDK 的请求路由及带回执传输；SDK 升级必须验证这个适配接口。内部 sink 收到相同稳定 `eventId`；已接受的 sink 不因其他 sink 失败而重复调用。

两端队列各按账号或账号设备范围保留最多 30 天、10,000 条，过期或超限淘汰最旧记录。Executor 仅记录淘汰数量，不记录事件正文。窗口关闭或断线期间，只要 Executor 仍运行并记录事实，恢复连接后即可补报；关闭窗口不会为了遥测改变 Executor 的生命周期。未被运行时确认的崩溃结果不会被猜测为成功或取消。

关闭遥测会清除公开版客户端队列；设备下一次连接时清除其队列并停采。重新开启会更新允许采集的时间边界，离线设备重连时删除边界之前的积压，防止补报关闭期间数据。跨设备按 UTC 发生时间执行边界过滤，设备时钟应保持同步。

这是持久交接与可重放投递，不能保证跨系统即时严格一次：PostHog 最终去重依赖 UUID、事件名、发生时间和匿名身份一致；内部异步 sink 的可靠性取决于其 `accept` 契约。多台客户端同时消费同一远端队列时，匿名安装身份不同的上报不能依赖 PostHog 合并。

## 验证

聚焦单测覆盖：同轮去重、等待和完成的先后顺序、重试与取消、无遥测同意、账号隔离、分页和幂等确认、配置差异与草稿回滚、进程内无页面订阅时的真实 Store 状态记录、持久存储失败、丢失 ACK、传输失败及内部 sink 分别重试。

桌面 `stand-in-telemetry` checkpoint 由现有 CI runner 和 core shard 执行：使用真实 Executor 与本地 PostHog 接收器，验证未被页面订阅的账号实际执行后，其完成事实跨窗口重载保留、重复读取与确认、实际分身对话的开始及完成事件，以及请求体不含合成私密提示词和业务 ID。仅模型响应被模拟。按仓库规则，只有明确要求时才在本地运行 E2E 或 `ai:verify`。
