---
sidebar_position: 1
---

# Runtime Task Logging Design

## Scope

This change improves observability for the runtime-task path used by Wework local work. It covers the main lifecycle from creating a runtime task, accepting execution on the local executor, running the background runtime agent, and receiving a terminal stream event.

The scope is limited to runtime-local work. It does not change the regular Task/Subtask execution path, Docker task dispatch behavior, user-facing API response schemas, or stream event payload contracts.

## Current Problem

Runtime-task creation and continuation return quickly after the executor accepts the request. The actual work then continues in background tasks on the local executor. Today the chain has sparse logs at several boundaries, so failures are hard to correlate across Backend RPC dispatch, executor RPC handling, background Codex or Claude Code execution, and terminal event forwarding.

## Recommended Approach

Add structured INFO logs at the runtime-task lifecycle boundaries without changing API contracts. Each log should use a stable prefix and include shared fields when available:

- `user_id`
- `device_id`
- `local_task_id`
- `runtime`
- `workspace_path`
- `method`
- `subtask_id`
- `duration_ms`
- `accepted`
- `success`
- `error_code`

Prompt text, attachment content, auth tokens, and full runtime handles must not be logged. For messages, log only `message_length` and attachment counts.

## Logging Boundaries

Backend service:

- Log before and after `runtime_rpc_service.call()` for `runtime.tasks.create` and `runtime.tasks.send`.
- Include target resolution metadata for create: runtime, device, workspace path, and project id if available.
- Include RPC duration, success flag, accepted flag, local task id, and error code from executor responses.

Backend runtime RPC transport:

- Log RPC send and receive in `RuntimeRpcService.call`.
- Include normalized timeout, socket availability, duration, and response success metadata.
- Log timeout, disconnect, namespace, and invalid response cases with method and device id.

Executor runtime RPC handler:

- Log RPC receive and completion in `RuntimeWorkRpcHandler.handle_runtime_rpc`.
- For create/send, log runtime, local task id, workspace path, accepted state, and duration.
- Log validation failures as warning-level bad request results and unexpected failures with exception stack.

Executor runtime execution:

- For `RuntimeAgentAdapter`, log create accepted, send accepted, background run start, initialize result, pre-execute result, execute result, and background run completion.
- For SDK Codex create/send, log local task id, thread id attachment, background stream start, stream completion, stream failure, and running-state cleanup.

Backend stream terminal handling:

- Log local-task terminal events in `LocalTaskResponsesHandler` when translating Responses API events to chat events.
- Include event type, device id, local task id, subtask id, runtime, terminal status, and error code when present.

## Error Handling

This work should not introduce new fallback behavior. Existing exceptions and RPC error responses remain unchanged. Logging must make existing failure points visible:

- Device offline or no socket.
- RPC timeout or disconnect.
- Executor unsupported runtime or bad request.
- Runtime task already running.
- Codex SDK create or send failure.
- Agent initialize, pre-execute, or execute failure.
- Terminal event forwarding failure.

## Testing

Add focused tests for the logging-safe behavior where practical:

- Backend RPC service returns invalid response errors with method and device context preserved.
- Runtime work service create/send still calls the same RPC methods and does not include prompt content in log metadata helpers.
- Executor runtime handler create/send responses remain unchanged after logging instrumentation.
- Runtime agent adapter still records transcript and terminal state while logging lifecycle boundaries.

Existing runtime work tests should continue to pass without changing public response shapes.
