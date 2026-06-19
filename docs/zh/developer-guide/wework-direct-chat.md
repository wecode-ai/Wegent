---
sidebar_position: 19
---

# Wework 直连会话

Wework 直连会话让桌面端在会话过程中直接通过本机 Executor 的 Socket.IO 通道接收模型输出，Backend 不再转发 token 和工具块增量。Backend 仍负责鉴权、任务与消息落库、上下文准备、附件关联，以及 turn 结束后的最终状态写入。

## 目标

- 会话流式输出不经过 Backend，降低链路延迟和 Backend 压力。
- Wework 页面展示保持不变，继续消费现有 `chat:start`、`chat:chunk`、`chat:block_created`、`chat:block_updated`、`chat:done`、`chat:error` 等事件。
- Executor 注册时上报 direct chat 端点和能力，运行时能力不再动态探测。
- Wework 打开或切换活跃设备时预连接 Executor，不需要每个 turn 都重新创建底层连接。
- 附件仍沿用现有 Backend 存储和上下文关联逻辑。

## 组件职责

### Backend

Backend 提供两个 direct chat API：

- `POST /api/local-executor/devices/{device_id}/direct-chat/connections`
  - 校验用户是否拥有设备。
  - 读取设备注册时上报的 `directChat` 能力。
  - 使用设备注册时生成的 `directChatSecret` 签发短期 direct chat ticket。
  - 返回 Wework 可连接的 direct chat endpoint、`connection_id`、`token` 和过期时间。

- `POST /api/local-executor/direct-chat/turns/prepare`
  - 校验设备、Team、交互表单、deep research followup 等请求条件。
  - 执行上下文处理和 RAG。
  - 创建或更新 Task/Subtask，并关联附件与上下文。
  - 构造 `ExecutionRequest` 返回给 Executor。
  - 在 turn 开始时设置任务流式状态，但不保存 token 级 checkpoint。

Backend 只在 turn 开始和 turn 结束参与。turn 过程中生成的 token、reasoning、工具块更新都不经过 Backend。

### Executor

Executor 在本地 HTTP 服务上挂载 direct chat Socket.IO namespace：

- namespace: `/wework-chat`
- path: `/socket.io`
- transport: WebSocket first, Socket.IO 协议

Executor 注册设备时上报：

```json
{
  "direct_chat": {
    "enabled": true,
    "transport": "socket.io",
    "base_url": "http://127.0.0.1:xxxxx",
    "socket_path": "/socket.io",
    "namespace": "/wework-chat",
    "version": 1
  }
}
```

Backend 在设备注册响应中返回 `direct_chat_secret` 和 `direct_chat_allowed_origins`，Executor 只在本进程内保存这些值，并在注册成功后再启动 direct Socket.IO server。Wework 连接 `/wework-chat` 时必须携带 `connection_id` 和 Backend 签发的 `token`。Executor 本地校验 ticket 签名、设备 ID 和过期时间，过期或不匹配时拒绝连接。签发 direct ticket 不依赖 Redis 在线状态，也不通过 Backend 与 Executor 的 `/local-executor` Socket.IO 通道预授权。

Executor direct Socket.IO 会校验请求 `Origin`。允许的 Origin 由 Backend 的 `WEWORK_DIRECT_CHAT_ALLOWED_ORIGINS` 环境变量配置，并在设备注册成功响应中下发给 Executor。未配置时 Backend 默认使用本地开发 Origin：`http://127.0.0.1:1420`、`http://localhost:1420`、`tauri://127.0.0.1`、`tauri://localhost`。企业部署应在 Backend 环境变量中覆盖为实际 Wework 前端 Origin。

direct ticket TTL 由 Backend 的 `WEWORK_DIRECT_CHAT_TICKET_TTL_SECONDS` 环境变量配置，默认 12 小时；如果配置低于 300 秒，Backend 会按 300 秒生效。TTL 只约束新建 direct socket 时的握手 ticket；已经建立的 socket 不因 TTL 到期而主动断开。

Executor 接收 Wework 的 `chat:send` 后调用 Backend 准备 turn，拿到 `ExecutionRequest` 后直接进入本地执行队列。执行过程中，Executor 直接向 Wework 的 task room 推送现有 chat 事件；执行完成、取消或错误时，Executor 再调用 Backend 内部 callback 写入最终状态。
Executor 的 `device:upgrade_status` 也会直接通过 direct socket 推给 Wework；原有上报 Backend 的路径保留给全局设备管理。

### Wework

Wework 的页面和消息渲染逻辑不变，流层增加 direct socket 路由：

1. 打开工作台时，对所有支持 direct chat 的设备建立或维护 direct socket。
2. 使用返回的 endpoint 连接 Executor `/wework-chat`。
3. `chat:send`、`chat:cancel`、`task:join`、`task:leave` 路由到对应设备的 direct socket。
4. 不再建立 Backend `/chat` Socket.IO 连接；Backend HTTP 请求仍用于鉴权、设备列表、附件、任务和 direct ticket 签发。
5. direct socket 连接、断开和 probe 结果更新本地设备在线状态，发送前不依赖 Redis 设备在线结果。
6. direct ticket 只在建连时使用；Wework 缓存 `expires_at`，新建 socket 时如果剩余 TTL 小于 1 分钟才重新向 Backend 申请。

## 协议选择

direct chat 使用 Socket.IO over WebSocket：

- 本地或内网 HTTP endpoint 对应 `ws://`。
- HTTPS endpoint 对应 `wss://`。
- 应用层仍通过 Socket.IO 事件交互，不直接暴露裸 WebSocket 帧协议。

## 状态与持久化

- 在线状态：Wework 会话发送路径以 direct socket 连接和 probe 为准；Backend 全局设备状态仍保留给设备管理和非 Wework 场景。
- turn 中间状态：不做低频 checkpoint。刷新时只能恢复 Executor 当前内存中的活动流，已完成内容以 Backend 最终 callback 为准。
- 附件：仍由 Backend 负责上传、存储、关联和上下文转换，Executor 从 `ExecutionRequest` 中读取处理后的上下文。
- 最终状态：Executor 在 completed、cancelled、error 时调用 Backend callback，Backend 写入 Subtask 结果并清理流式状态。

## 边界

- direct chat 不考虑旧版 Executor 兼容，所有本地 Executor 需要统一升级。
- Wework 不改页面展示层，不引入新的消息事件名。
- Wework 现有 Team 字段仅作为 Backend 构造执行请求的兼容输入，页面不展示 Team 维度能力。
- Backend 不参与 token 输出过程，不在中间 token 上写库。
