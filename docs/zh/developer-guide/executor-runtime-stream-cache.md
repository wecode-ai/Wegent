---
sidebar_position: 22
---

# 执行器运行态流缓存

## 背景

任务执行过程中，浏览器刷新或重新加入 task room 时需要恢复仍在流式生成的内容。旧路径把增量文本、工具块和上下文指标写入 Redis，用于刷新恢复和终态结果组装。这个方式可靠，但高频流式事件会增加 Redis 写入压力。

执行器运行态流缓存把活跃任务的增量快照保存在 executor 本地内存中。Backend 仍使用 Redis 保存 task 级活跃状态和路由信息，恢复时再向对应 executor 拉取快照。

## 设计目标

- 降低流式增量内容对 Redis 的高频写入。
- 保留 Redis 作为活跃任务索引、TTL、跨进程协调和旧 executor 兼容路径。
- 不做双写灰度。支持 runtime cache 的 executor 走 executor 内存快照；未带能力标记的 executor 继续走 Redis 快照。
- 接受 executor 进程崩溃时丢失未定稿的中间快照。终态结果仍在完成事件处理中落库。

## 能力识别

当前实现不依赖 executor 启动或心跳上报全局 capability。executor 在每个 Responses API 流式事件 payload 中携带 `runtime_cache` marker：

```json
{
  "runtime_cache": {
    "enabled": true,
    "version": 1,
    "source": "executor",
    "active_idle_ttl_seconds": 3600,
    "terminal_ttl_seconds": 600
  }
}
```

Backend 收到事件后按事件级 marker 判断缓存归属：

- `runtime_cache.enabled == true`：Redis 只保存 `chat:task_streaming:{task_id}` 活跃状态，增量内容和 blocks 不写 Redis。
- 无 marker 或 `enabled != true`：保持旧路径，增量内容和 blocks 继续写 Redis。

这个判断是按任务流事件生效的，因此旧 executor 不需要升级协议即可继续工作。

## 快照语义

executor runtime snapshot 中的普通助手正文只写入 `content` 和 `offset`。`blocks` 只保存可独立展示的过程信息，例如 reasoning、tool 调用和显式 `response.block.*` 事件产生的 commentary/text block。

这避免刷新恢复时同一段普通正文同时出现在 `cached_content` 和 process `text` block 中，导致后续正文继续增长后 process block 停留在刷新点。

## 数据流

### 运行中

1. executor 发送 Responses API 流式事件。
2. executor transport 先把事件写入本地 `RuntimeStreamCache`。
3. executor 在事件 payload 中带上 `runtime_cache` marker。
4. Backend 的 WebSocket callback handler 读取 marker。
5. `StatusUpdatingEmitter` 更新 Redis task 级活跃状态，记录 executor 名称、namespace 和 runtime cache 元数据。
6. Backend 继续把事件广播给前端，但跳过 Redis 内容快照写入。

### 刷新恢复

1. 前端重新加入 task room 或触发 runtime check。
2. Backend 从 Redis 读取 `chat:task_streaming:{task_id}`，确认活跃 subtask 和对应 executor。
3. 如果状态里带 `cache_source=executor`，Backend 向 local executor 发送 `runtime_cache:get_snapshot`。
4. executor 返回内存快照，Backend 将快照转换为 join/resume 所需的 content、blocks、offset 和 context metrics。
5. 如果状态没有 runtime cache marker，Backend 使用 Redis 内容快照恢复。

### 任务完成

1. Backend 收到 terminal 事件后，先向 executor 拉取最终 runtime snapshot。
2. Backend 用最终快照补齐 completed result 中的 blocks 和上下文指标。
3. Backend 向 executor 发送 `runtime_cache:cleanup` 删除该 subtask 的内存快照。
4. Backend 清理 Redis 中的流式内容和 `chat:task_streaming:{task_id}` 活跃状态。

## Redis 保留职责

Redis 仍负责以下职责：

- `chat:task_streaming:{task_id}` 活跃任务索引。
- task 到 subtask、executor name、executor namespace 的路由信息。
- 活跃状态 TTL 和 last activity。
- 旧 executor 的内容快照、blocks 和上下文指标。
- terminal 后的通用清理入口。

因此 Redis 并未从任务流恢复链路中移除，只是不再承载支持 runtime cache 的 executor 的高频增量内容。

## 回收策略

executor 内存快照有两类回收：

- 主动回收：Backend 在 terminal 事件完成最终快照读取和结果组装后调用 `runtime_cache:cleanup`。
- 被动回收：executor 在访问缓存时清理过期条目。活跃快照默认 idle TTL 为 3600 秒；terminal 快照默认 TTL 为 600 秒。

如果 executor 崩溃或重启，内存快照会丢失。Backend 后续无法从 executor 拉到 snapshot 时，只能返回已有的持久化任务状态；这是当前设计接受的取舍。

## 排查方式

判断 runtime cache 是否生效时，不要只看 executor 注册或心跳 capability 日志。应检查 backend callback 日志：

- 事件或 Redis active status 中是否出现 `runtime_cache.enabled=true`。
- `chat:task_streaming:{task_id}` 中是否出现 `cache_source=executor`。
- 刷新或 join 时是否发送 `runtime_cache:get_snapshot`。
- 完成时是否发送 `runtime_cache:cleanup`，且返回 `removed=true`。
- Redis 内容快照读取是否为 key not found；这表示内容未走 Redis，而不是 Redis active status 未生效。
