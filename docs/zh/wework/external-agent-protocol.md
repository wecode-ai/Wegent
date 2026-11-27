---
sidebar_position: 20
---

# 外部智能体接入协议

云端项目的外部智能体可通过 HTTP Hook 或 WebSocket Worker 接收事项调用。接入入口见[项目设置](./projects.md#external-agents)。

## HTTP Hook

部署管理员在 `WEWORK_EXTERNAL_HOOK_ORIGINS` 中配置允许的接收方 origin，用逗号分隔。回调地址以 `WEGENT_BACKEND_PUBLIC_URL` 为准。生产接入使用 HTTPS。

如果部署显式设置了 `WEGENT_RS_JOB_ALLOWLIST`，请在 Rust 调度器和 Worker 进程的列表中加入 `external_agent_delivery`。该作业负责 Hook 投递和过期处理。

项目管理员可选 POST、PUT 或 PATCH。模板使用 `{{input}}`、`{{invocationId}}`、`{{deliveryId}}`、`{{projectId}}`、`{{issueId}}`、`{{callbackUrl}}`、`{{callbackToken}}`。JSON 模板中的变量用作完整的值，周围无需双引号。表单和 XML 按各自编码规则处理。HTTP 2xx 表示服务已接收，外部服务通过回调提交处理状态。

向收到的回调地址发起 POST，在 `Authorization` 请求头中传入 `Bearer <callbackToken>`。请求体示例为：

```json
{
  "invocationId": "从 Hook 请求读取",
  "deliveryId": "从 Hook 请求读取",
  "seq": 1,
  "type": "append",
  "text": "正在核对部署记录。"
}
```

可用事件包括 `progress`、`append`、`succeeded` 和 `failed`。序号从 1 开始。同一次网络重试沿用原序号。成功事件省略 `text` 时保留已追加的正文，提供 `text` 时以它定稿。

## Worker SDK

SDK 源码在 `packages/wework-worker`。可从源码目录运行 `pnpm pack`，然后在外部 Worker 项目安装生成的包。使用 Node.js 22 或更新版本。

```js
import { createWorker } from '@wework/worker'

const worker = createWorker({
  endpoint: process.env.WEWORK_ENDPOINT,
  token: process.env.WEWORK_WORKER_TOKEN,
})

worker.onTask(async (task, reply) => {
  await reply.progress('正在收集结果')
  await reply.append(await generateReport(task.input, reply.signal))
})

await worker.start()
```

处理函数正常返回后，SDK 结束本次调用。返回字符串可直接定稿。Worker 通过 Socket.IO 的 WebSocket 传输连接 `/wework-worker`，用智能体凭据认证。它在同一连接上领取任务、续租和提交回复。短暂断线时，SDK 用原序号重发未确认的回复。进程退出后，租约过期的任务可由其他实例领取。对有副作用的操作，用稳定的 `task.invocationId` 做幂等处理。
