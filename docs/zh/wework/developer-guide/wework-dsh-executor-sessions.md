---
sidebar_position: 35
---

# Executor 任务的 DSH Session 扩展

Wework Core DSH 将 Executor 管理的运行中任务投影为标准
`@deepseek-ai/dsh-session` Session。普通 DSH host 插件只需注入
`sessions` 并监听官方 `session/event`，不需要依赖 Wework 私有事件总线或直接连接
Executor。

## 事件投影

`@wegent/dsh-executor-runtime` 使用独立的 Executor 本地端点连接订阅事件流，并按最后
消费的 `sequence` 断线续传。每个 `(deviceId, taskId)` 映射为一个稳定、独立的
Session，因此并行任务不会合并到同一个事件流。

主要映射如下：

| Executor 事件                              | DSH Session 事件                            |
| ------------------------------------------ | ------------------------------------------- |
| `response.created`、`response.in_progress` | `turn/start`、`step/start`                  |
| `runtimeGeneratedUserMessage`              | `user/message`                              |
| reasoning delta                            | `assistant/chunk` reasoning block           |
| output text delta                          | `assistant/chunk` text block                |
| `thread/tokenUsage/updated`                | `assistant/chunk` usage                     |
| completed、incomplete、failed、error       | `assistant/message`、`step/end`、`turn/end` |

投影保留原始用户消息和模型输出。安装并信任插件意味着允许插件按标准 DSH
Session 契约读取这些内容；Wework 不再为同一数据维护一套匿名摘要扩展点。

Codex 的 `tokenUsage.last` 表示当前 turn 的累计用量，投影后的 usage chunk
也保持这一语义。需要实时 token 速度的插件应对同一 Session 的相邻
`outputTokens` 求差分，再除以采样间隔；不能把多个累计值直接相加。

```js
export const inject = ["sessions"];

export function apply(ctx) {
  ctx.on("session/event", (session, event) => {
    if (event.type === "assistant/chunk" && event.data.chunk.type === "usage") {
      observeUsage(session.id, event.data.chunk.usage);
    }
  });
}
```

## Backend 通用插件存储

需要跨客户端保存数据的 DSH 插件可以使用认证后的通用存储 API。数据复用现有
`Kind` 表，资源身份为：

- `kind`: `DshPluginData`
- `namespace`: npm package name
- `name`: storage unit name
- `user_id`: 当前认证用户

插件每次读写都提交 descriptor。Backend 会校验 `version`、表名列表和是否声明
global value，避免同一 storage unit 被不兼容版本静默解释。

```json
{
  "version": 1,
  "tables": ["scores"],
  "has_global": false
}
```

API 前缀为 `/api/v1/dsh-plugin-storage`：

| 方法与路径                                                            | 用途                              |
| --------------------------------------------------------------------- | --------------------------------- |
| `POST /units/{unit}/load?package={package}`                           | 读取当前用户的 unit               |
| `PUT /units/{unit}/tables/{table}/records/{key}?package={package}`    | 写入记录                          |
| `DELETE /units/{unit}/tables/{table}/records/{key}?package={package}` | 删除记录                          |
| `PUT /units/{unit}/global?package={package}`                          | 写入声明过的 global value         |
| `GET /units/{unit}/tables/{table}/shared?package={package}`           | 扫描 Backend 范围内显式共享的记录 |

记录写入体在 descriptor 之外包含 `value` 和 `shared`。只有
`shared: true` 的记录会出现在 shared scan 中；普通 load 始终只返回当前用户自己的
数据。插件应使用稳定 key 保存最佳记录，而不是每局追加一条无界记录。

Wework 本地优先模式的插件 client 应读取当前云端连接的 `apiBaseUrl` 和 token；
未连接 Backend 时，本地功能可以继续运行，但共享数据不可用。
