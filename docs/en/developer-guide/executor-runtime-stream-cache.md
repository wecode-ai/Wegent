---
sidebar_position: 22
---

# Executor Runtime Stream Cache

## Background

While a task is running, the browser may refresh or rejoin the task room and needs to recover in-progress streamed content. The legacy path wrote incremental text, tool blocks, and context metrics to Redis for refresh recovery and terminal result assembly. That path is reliable, but high-frequency streaming events create heavy Redis write traffic.

Executor runtime stream cache keeps active task snapshots in executor-local memory. Backend still uses Redis for task-level active state and routing metadata, then asks the owning executor for the snapshot during recovery.

## Goals

- Reduce high-frequency Redis writes for streamed incremental content.
- Keep Redis for active task indexing, TTL, cross-process coordination, and compatibility with older executors.
- Avoid dual-write rollout. Devices that report the runtime cache capability use executor-local snapshots; devices that do not report it continue using Redis snapshots.
- Accept losing unfinished intermediate snapshots if the executor process crashes. Terminal results are still persisted by the completion handler.

## Capability Detection

The executor reports a device-level `runtime_cache` capability during device registration and heartbeat:

```json
{
  "runtime_cache": {
    "enabled": true
  }
}
```

Backend decides cache ownership from the capability stored in the device online state:

- `runtime_cache.enabled == true`: Redis only stores the `chat:task_streaming:{task_id}` active status. Incremental content and blocks are not written to Redis.
- Missing device capability or `enabled != true`: Backend keeps the legacy path and writes incremental content and blocks to Redis.

Because this is decided per device, streams sent to a runtime-cache-capable device always use executor-local snapshots.

## Snapshot Semantics

Plain assistant output in executor runtime snapshots is stored only in `content` and `offset`. `blocks` only stores independently rendered process information, such as reasoning, tool calls, and explicit commentary/text blocks produced by `response.block.*` events.

This prevents refresh recovery from exposing the same plain output through both `cached_content` and a process `text` block, which would otherwise leave the process block stuck at the refresh point while the main answer keeps streaming.

## Data Flow

### Running

1. The executor emits Responses API streaming events.
2. The executor transport records each event in the local `RuntimeStreamCache`.
3. Backend's WebSocket callback handler decides snapshot ownership from `runtime_cache.enabled` in the device online state.
4. When runtime cache is supported, `StatusUpdatingEmitter` skips Redis content snapshot writes.
5. `StatusUpdatingEmitter` updates the Redis task-level active status with only active subtask, executor name, namespace, and other routing fields.
6. Backend still broadcasts events to the frontend.

### Refresh Recovery

1. The frontend rejoins the task room or triggers a runtime check.
2. Backend reads `chat:task_streaming:{task_id}` from Redis to find the active subtask and executor route.
3. If the route points to an online device with `runtime_cache.enabled=true`, Backend sends `runtime_cache:get_snapshot` to the local executor.
4. The executor returns the in-memory snapshot, and Backend converts it into content, blocks, offset, and context metrics for join/resume.
5. If the route has no matching runtime-cache-capable device, Backend falls back to the Redis content snapshot.

### Completion

1. After Backend receives a terminal event, it first fetches the final runtime snapshot from the executor.
2. Backend uses the final snapshot to complete the persisted result blocks and context metrics.
3. Backend sends `runtime_cache:cleanup` to the executor to delete the subtask snapshot.
4. Backend clears Redis streaming content and the `chat:task_streaming:{task_id}` active status.

## Redis Responsibilities

Redis still owns:

- The `chat:task_streaming:{task_id}` active task index.
- Routing metadata from task to subtask, executor name, and executor namespace.
- Active status TTL and last activity.
- Content snapshots, blocks, and context metrics for older executors.
- The common cleanup entry point after terminal events.

Redis is still part of stream recovery. It simply no longer stores high-frequency incremental content for executors that support runtime cache.

## Cleanup

Executor memory snapshots are reclaimed in two ways:

- Active cleanup: after Backend reads the final snapshot and assembles the terminal result, it calls `runtime_cache:cleanup`.
- Passive cleanup: the executor evicts expired entries when the cache is accessed. Active snapshots default to a 3600-second idle TTL; terminal snapshots default to a 600-second TTL.

If the executor crashes or restarts, in-memory snapshots are lost. Backend can no longer recover those unfinished snapshots and can only return already persisted task state. This is an accepted tradeoff in the current design.

## Troubleshooting

Do not rely only on executor registration or heartbeat capability logs when checking whether runtime cache is active. Inspect backend callback logs instead:

- Whether device registration, heartbeat, or device online state contains `runtime_cache.enabled=true`.
- Whether refresh or join sends `runtime_cache:get_snapshot`.
- Whether completion sends `runtime_cache:cleanup` and receives `removed=true`.
- Whether Redis content snapshot reads return key not found; that means content did not go through Redis, not that Redis active status failed.
