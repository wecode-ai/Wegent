---
sidebar_position: 23
---

# Chat Shell 派发连接与诊断

HTTP 模式下，Backend 通过 OpenAI Responses SDK 调用 Chat Shell 的
`/v1/responses`。`Connection error.` 是 SDK 的通用错误文案，单凭这段文案
无法区分 Backend 到 Chat Shell 的连接失败与 Chat Shell 到模型服务的连接失败。

## 连接生命周期

Backend 的应用生命周期持有 `ChatShellClientPool`。同一应用事件循环中，指向
同一目标地址的 SSE 派发复用 SDK 客户端和 HTTP 连接池；应用完成流和后台任务的
清理后统一关闭客户端。同步桥接和 Celery 的临时事件循环使用各自持有的客户端，
请求完成、失败或取消时都会关闭，避免跨事件循环共享连接。

连接池最多保留 100 个空闲连接，最多允许 1000 个连接。超时与空闲回收时间分别为：

| 阶段 | 超时 |
| --- | --- |
| 建连 | 5 秒 |
| 读取 | 300 秒 |
| 写入 | 30 秒 |
| 等待连接池 | 5 秒 |
| 空闲连接回收 | 2 秒 |

空闲连接在 Chat Shell 默认的 Uvicorn 5 秒空闲超时之前主动回收，降低服务端关闭
连接与客户端复用同时发生的概率。调整服务端或中间代理配置时，其空闲超时应大于
客户端的 2 秒回收时间。

取消请求只关闭对应响应流，不关闭应用共享的 SDK 客户端。
收到终态事件后，最多用 1 秒消费剩余的 HTTP 响应边界，使连接能够回到池中。
收尾超时、断开或被取消时关闭该响应，保留已经交付的终态，不重复生成错误事件。

## 重试边界

SDK 的自动重试关闭，由派发传输层统一控制重试。仅当 SDK 的
`APIConnectionError`（包括 `APITimeoutError`）直接由 HTTPX 的 `ConnectError`
或 `ConnectTimeout` 引起时，最多尝试三次。两次等待分别在 0–0.5 秒和
0–1 秒之间随机选择，等待期间可立即取消。

读取、写入、连接池等待、协议错误和 HTTP 错误均不重试；收到响应头后即使还没有
收到首个 SSE 事件，也不重新发起请求。没有收到事件不能证明服务端尚未执行这个
POST，重复请求可能导致重复生成或工具副作用。

向 Executor Manager 提交 `background=true` 的后台任务时也关闭 SDK 自动重试。
接收端直接把请求写入队列，没有请求去重；发生异常时不自动重放 POST，避免已经
入队的子任务被重复提交。

## 诊断日志

按 `[ChatShellTransport]` 和 `task_id`、`subtask_id` 或 `request_id` 过滤日志。
每次建流尝试产生 `connect_attempt`，随后对应 `stream_opened` 或
`connect_failed`；建流期间被取消时记录 `connect_cancelled`。日志包含：

- `error_hop=backend_to_chat_shell`、调用方 Pod/进程和目标 URL；
- 尝试次数、耗时、是否重试和等待时长；
- SDK → HTTPX → 操作系统的异常类型和经过脱敏的异常表示；
- 连接成功时传输层可提供的 `peer_address`。建连失败时该字段为 `null`，不会
  通过额外 DNS 查询猜测实际连接的 IP。

`dispatch_failed` 记录失败阶段与已接收的事件数，区分建流失败和流处理失败。
这些日志也作为 span event 写入现有追踪系统。日志不记录请求正文、请求头或
身份验证信息，目标 URL 会移除用户名、密码和查询参数。

任务和客户端继续使用原有的 `error_type`、错误文案及终态处理，便于兼容现有
调用方。此传输层不控制模型服务内部的重试。部署期间的探针、摘流与等待配置见
[Chat Shell 优雅退出](./chat-shell-graceful-shutdown.md)。
