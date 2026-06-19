---
sidebar_position: 19
---

# Wework Direct Chat

Wework direct chat lets the desktop app receive streaming model output directly from the local Executor through Socket.IO. Backend no longer relays token or tool-block deltas during a turn. Backend remains responsible for authentication, task and message persistence, context preparation, attachment linking, and final turn-state persistence.

## Goals

- Keep streaming output off Backend to reduce latency and Backend load.
- Keep the Wework UI unchanged. The renderer continues to consume the existing `chat:start`, `chat:chunk`, `chat:block_created`, `chat:block_updated`, `chat:done`, and `chat:error` events.
- Let Executor report its direct chat endpoint and capability during device registration. Capabilities are treated as stable for the process lifetime.
- Preconnect Wework to the active Executor when the workbench loads or the active device changes, instead of opening a new transport for every turn.
- Keep attachment storage and context linking on the existing Backend path.

## Responsibilities

### Backend

Backend exposes two direct chat APIs:

- `POST /api/local-executor/devices/{device_id}/direct-chat/connections`
  - Verifies that the user owns the target device.
  - Reads the `directChat` capability reported during device registration.
  - Signs a short-lived direct chat ticket with the device's registered `directChatSecret`.
  - Returns the direct chat endpoint, `connection_id`, `token`, and expiration time to Wework.

- `POST /api/local-executor/direct-chat/turns/prepare`
  - Validates the device, Team, interactive form answer, deep research follow-up, and request shape.
  - Runs context processing and RAG.
  - Creates or updates Task/Subtask records and links attachments and contexts.
  - Builds and returns an `ExecutionRequest` for Executor.
  - Marks the task as streaming at turn start, without storing token-level checkpoints.

Backend participates only at turn start and turn end. Token deltas, reasoning deltas, and tool-block updates produced during the turn do not pass through Backend.

### Executor

Executor mounts a direct chat Socket.IO namespace on the local HTTP service:

- namespace: `/wework-chat`
- path: `/socket.io`
- transport: WebSocket first, using the Socket.IO protocol

Executor reports the direct chat capability during device registration:

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

Backend returns `direct_chat_secret` and `direct_chat_allowed_origins` in the device registration response. Executor keeps those values only in the local process and starts the direct Socket.IO server only after registration succeeds. Wework must provide both `connection_id` and the Backend-issued `token` when connecting to `/wework-chat`. Executor verifies the ticket signature, device ID, and expiration locally. Direct ticket issuance does not depend on Redis online state and does not pre-authorize over the Backend-to-Executor `/local-executor` Socket.IO channel.

Executor direct Socket.IO validates the request `Origin`. Allowed origins are configured on Backend through the comma-separated `WEWORK_DIRECT_CHAT_ALLOWED_ORIGINS` environment variable and sent to Executor in the successful device registration response. When it is not set, Backend uses local development origins by default: `http://127.0.0.1:1420`, `http://localhost:1420`, `tauri://127.0.0.1`, and `tauri://localhost`. Enterprise deployments should override the Backend environment variable with the actual Wework frontend origin.

The direct ticket TTL is configured on Backend through `WEWORK_DIRECT_CHAT_TICKET_TTL_SECONDS` and defaults to 12 hours. If it is configured below 300 seconds, Backend uses 300 seconds. The TTL only applies to the handshake ticket used when opening a new direct socket; established sockets are not disconnected when the TTL expires.

When Executor receives Wework's `chat:send`, it calls Backend to prepare the turn. After receiving the `ExecutionRequest`, it enqueues local execution directly. During execution, Executor emits the existing chat events directly to Wework's task room. When execution completes, is cancelled, or fails, Executor calls the Backend internal callback to persist the terminal state.
Executor also sends `device:upgrade_status` directly to Wework over the direct socket. The existing Backend report path remains available for global device management.

### Wework

The Wework page and message rendering layers stay unchanged. The stream layer adds direct socket routing:

1. When the workbench opens, Wework opens or maintains direct sockets for all direct-capable devices.
2. Wework connects to Executor's `/wework-chat` namespace with the returned endpoint.
3. `chat:send`, `chat:cancel`, `task:join`, and `task:leave` route to the direct socket for the target device.
4. Wework no longer opens the Backend `/chat` Socket.IO connection. Backend HTTP requests remain for authentication, device inventory, attachments, tasks, and direct ticket issuance.
5. Direct socket connect, disconnect, and probe results update local device status, so sending does not depend on Redis-backed device status.
6. Direct tickets are used only for establishing sockets. Wework caches `expires_at` and requests a new ticket from Backend only when a new socket is needed and the remaining TTL is below one minute.

## Protocol

direct chat uses Socket.IO over WebSocket:

- Local or intranet HTTP endpoints resolve to `ws://`.
- HTTPS endpoints resolve to `wss://`.
- Application messages remain Socket.IO events. The system does not expose a raw WebSocket frame protocol.

## State and Persistence

- Online status: Wework's send path trusts the direct socket connection and probe results. Backend global device status remains for device management and non-Wework flows.
- Mid-turn state: no low-frequency checkpoint is stored. Refresh recovery can only use Executor's current in-memory active stream; completed content comes from Backend's terminal callback.
- Attachments: Backend still owns upload, storage, linking, and context conversion. Executor reads the prepared context from `ExecutionRequest`.
- Terminal state: Executor calls Backend callback on completed, cancelled, or error, and Backend persists the Subtask result and clears streaming state.

## Boundaries

- direct chat does not support old Executor versions. Local Executors must be upgraded together.
- Wework does not change page rendering or introduce new message event names.
- Wework's existing Team field remains only a compatibility input for Backend execution-request construction. Team-level capabilities are not exposed in the Wework UI.
- Backend does not participate in token streaming and does not write token deltas to the database.
