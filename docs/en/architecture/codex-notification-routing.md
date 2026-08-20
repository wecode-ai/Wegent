---
sidebar_position: 7
---

# Codex notification isolation

## Scope

Governs how JSON-RPC notifications are projected to the global background router and individual active threads when the local Executor reuses one Codex app-server.

## Connection graph

```mermaid
flowchart LR
    A[Codex app-server stdout] --> B[CodexNotificationHub]
    B --> C[Global notification stream]
    B --> D1[Thread A stream]
    B --> D2[Thread B stream]
    C --> E[Runtime background router]
    D1 --> F1[Thread A turn identity correction]
    D2 --> F2[Thread B turn identity correction]
    F1 --> G1[Thread A turn state]
    F2 --> G2[Thread B turn state]
```

## Sequence

```mermaid
sequenceDiagram
    participant C as Codex app-server
    participant H as NotificationHub
    participant A as Thread A
    participant B as Thread B
    C->>H: Thread B outputDelta burst
    H->>B: Deliver only to thread B
    H->>H: Also deliver to global stream
    Note over A: Thread A queue is unaffected
    C->>H: Thread A thread/goal/updated
    H->>A: Correct provisional turn/start result with first trusted protocol turnId
    C->>H: Thread A item/started(userMessage)
    H->>A: Confirm the same active turn
    C->>H: Thread A turn/completed
    H->>A: Deliver completion
    A->>A: Produce one terminal outcome
```

## Code ownership

| Responsibility | Code |
| --- | --- |
| App-server process and notification hub | `executor/src/agents/codex.rs` |
| Active turn identity correction | `executor/src/agents/codex.rs` |
| Active turn state machine | `executor/src/agents/codex/run_state.rs` |
| Runtime background projection | `executor/src/runtime_work/handler/notifications.rs` |
| Shared app-server contract tests | `executor/tests/codex_app_server_contract.rs` |

## Essential invariants

- A burst from one thread must not consume or overwrite another thread's bounded queue.
- Notifications with a `threadId` enter only the matching turn stream; the global stream still receives every notification.
- Process-exit notifications without a `threadId` reach every active thread.
- A thread subscription exists before any request that may start its turn.
- A turn ID returned by `turn/start` is provisional until the first trusted protocol event confirms it; `turn/started`, a root user message's `item/started`, and an earlier `thread/goal/updated` or `thread/goal/cleared` during that provisional turn correct the active turn with their protocol `turnId`.
- Goal state notifications enter the same turn state machine even when they precede the root user message, and later notifications from that turn are not discarded as stale.
- When both the request and root user item carry a client user message ID, they must match; assistant and other non-root-user items cannot replace the active turn.
- Lag in the global background router must not fail unrelated active turns.
