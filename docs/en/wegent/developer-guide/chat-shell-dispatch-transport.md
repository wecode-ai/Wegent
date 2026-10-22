---
sidebar_position: 23
---

# Chat Shell dispatch connections and diagnostics

In HTTP mode, the Backend calls Chat Shell's `/v1/responses` using the OpenAI
Responses SDK. `Connection error.` is a generic SDK message: it does not identify
whether the failure occurred between the Backend and Chat Shell or between Chat
Shell and the model service.

## Connection ownership

The Backend application lifespan owns `ChatShellClientPool`. SSE dispatches to the
same target on the application event loop share an SDK client and HTTP pool.
Clients close after application streams and background work drain. Temporary
event loops used by synchronous bridges and Celery own separate clients and close
them on success, failure, or cancellation, without sharing connections across loops.

The pool allows up to 1000 connections and retains up to 100 idle connections.
Timeouts and idle connection expiry are explicit:

| Phase | Timeout |
| --- | --- |
| Connect | 5 seconds |
| Read | 300 seconds |
| Write | 30 seconds |
| Pool acquisition | 5 seconds |
| Idle connection expiry | 2 seconds |

Idle connections are retired before Chat Shell's default Uvicorn keep-alive
timeout of five seconds, reducing races between server closure and client reuse.
When configuring the server or an intermediary proxy, keep its idle timeout above
the client's two-second expiry.

Cancelling a request closes its response stream while keeping the shared SDK
client available to other dispatches.
After a terminal event, the dispatcher spends at most one second consuming the
remaining HTTP framing so the connection can return to the pool. A timeout,
disconnect, or cancellation during cleanup closes that response and preserves
the delivered terminal state without emitting another error.

## Retry boundary

SDK automatic retries are disabled. The dispatch transport makes at most three
attempts only when an SDK `APIConnectionError` (including `APITimeoutError`) is
directly caused by an HTTPX `ConnectError` or `ConnectTimeout`. The two delays use
random jitter in the ranges 0–0.5 seconds and 0–1 second. Cancellation interrupts
the delay immediately.

Read, write, pool, protocol, and HTTP errors are not retried. Once response headers
arrive, the request is never replayed, even before the first SSE event. An absent
event does not prove the server has not processed the POST; replaying it could
duplicate generation or tool side effects.

SDK automatic retries are also disabled when submitting `background=true` tasks
to the Executor Manager. Its receiver directly enqueues requests without request
deduplication; replaying a failed POST could submit an already queued subtask again.

## Diagnostic logs

Filter `[ChatShellTransport]` logs by `task_id`, `subtask_id`, or `request_id`.
Each `connect_attempt` is paired with `stream_opened`, `connect_failed`, or
`connect_cancelled` and includes:

- `error_hop=backend_to_chat_shell`, caller Pod/process, and target URL;
- attempt number, elapsed time, retry decision, and delay;
- SDK → HTTPX → OS exception types and masked representations;
- `peer_address` when the established connection exposes it. Connection failures
  report `null`; a separate DNS lookup is never used to guess the attempted IP.

`dispatch_failed` records the stage and number of received events to distinguish
opening failures from stream processing failures. The same diagnostics are added
as span events to the existing tracing system. Logs omit request bodies, headers,
and authentication details; target URLs exclude user information and query strings.

Task results and client responses retain their existing error types, messages, and
terminal handling. This transport does not manage model-service retries. For
deployment probes and draining, see
[Chat Shell graceful shutdown](./chat-shell-graceful-shutdown.md).
