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
- Avoid dual-write rollout. Executors that send the runtime cache marker use executor-local snapshots; executors that do not send it continue using Redis snapshots.
- Accept losing unfinished intermediate snapshots if the executor process crashes. Terminal results are still persisted by the completion handler.

## Capability Detection

The current implementation does not depend on a global executor capability reported during registration or heartbeat. Instead, the executor attaches a `runtime_cache` marker to each Responses API streaming event payload:

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

Backend decides cache ownership from this event-level marker:

- `runtime_cache.enabled == true`: Redis only stores the `chat:task_streaming:{task_id}` active status. Incremental content and blocks are not written to Redis.
- Missing marker or `enabled != true`: Backend keeps the legacy path and writes incremental content and blocks to Redis.

Because this is decided per task stream event, older executors remain compatible without a protocol upgrade.

## Data Flow

### Running

1. The executor emits Responses API streaming events.
2. The executor transport records each event in the local `RuntimeStreamCache`.
3. The executor includes the `runtime_cache` marker in the event payload.
4. Backend's WebSocket callback handler reads the marker.
5. `StatusUpdatingEmitter` updates the Redis task-level active status with executor name, namespace, and runtime cache metadata.
6. Backend still broadcasts events to the frontend, but skips Redis content snapshot writes.

### Refresh Recovery

1. The frontend rejoins the task room or triggers a runtime check.
2. Backend reads `chat:task_streaming:{task_id}` from Redis to find the active subtask and executor route.
3. If the status has `cache_source=executor`, Backend sends `runtime_cache:get_snapshot` to the local executor.
4. The executor returns the in-memory snapshot, and Backend converts it into content, blocks, offset, and context metrics for join/resume.
5. If there is no runtime cache marker, Backend falls back to the Redis content snapshot.

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

- Whether event payloads or Redis active status contain `runtime_cache.enabled=true`.
- Whether `chat:task_streaming:{task_id}` contains `cache_source=executor`.
- Whether refresh or join sends `runtime_cache:get_snapshot`.
- Whether completion sends `runtime_cache:cleanup` and receives `removed=true`.
- Whether Redis content snapshot reads return key not found; that means content did not go through Redis, not that Redis active status failed.
