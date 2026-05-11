---
sidebar_position: 15
---

# Local Device Architecture

This document describes the technical architecture of local device support, including communication protocols, heartbeat mechanisms, and security design.

---

## 🏗 Architecture Overview

### System Components

```mermaid
flowchart LR
    subgraph "User's Computer"
        EX[Wegent Executor]
        CC[Claude Code SDK]
        FS[Local Files]
    end

    subgraph "Wegent Cloud"
        BE[Backend Service]
        FE[Frontend UI]
    end

    EX <-->|WebSocket| BE
    FE <-->|HTTP/WS| BE
    EX --> CC
    CC --> FS

    style EX fill:#14B8A6,color:#fff
    style BE fill:#14B8A6,color:#fff
```

### Communication Architecture

The following diagram shows how local devices communicate with the Wegent system:

```mermaid
sequenceDiagram
    participant FE as Frontend
    participant BE as Wegent Backend
    participant RD as Redis
    participant EX as Local Device

    Note over EX: Device starts
    EX->>BE: WebSocket connection (JWT auth)
    BE->>BE: Validate Token
    EX->>BE: device:register
    BE->>RD: Store online status (TTL: 90s)

    loop Every 30 seconds
        EX->>BE: device:heartbeat
        BE->>RD: Refresh TTL
    end

    Note over FE: User sends task
    FE->>BE: chat:send {device_id}
    BE->>BE: Create subtask
    BE->>EX: task:execute

    loop Task execution
        EX->>BE: task:progress
        BE->>FE: chat:chunk
    end

    EX->>BE: task:complete
    BE->>FE: chat:done
```

---

## 📡 WebSocket Protocol

### Event Types

| Event | Direction | Description |
|-------|-----------|-------------|
| `device:register` | Device → Backend | Device registration |
| `device:heartbeat` | Device → Backend | Heartbeat keepalive |
| `task:execute` | Backend → Device | Task dispatch |
| `task:progress` | Device → Backend | Task progress |
| `task:complete` | Device → Backend | Task completion |

### Message Format

```json
// device:register
{
  "event": "device:register",
  "data": {
    "device_id": "uuid-xxx",
    "name": "Darwin - MacBook-Pro.local",
    "max_slots": 5
  }
}

// device:heartbeat
{
  "event": "device:heartbeat",
  "data": {
    "device_id": "uuid-xxx",
    "running_task_ids": ["task-1", "task-2"]
  }
}

// task:execute
{
  "event": "task:execute",
  "data": {
    "subtask_id": "subtask-xxx",
    "prompt": "User message",
    "context": {}
  }
}
```

---

## 💓 Heartbeat Mechanism

### Sequence Diagram

```mermaid
sequenceDiagram
    participant EX as Local Device
    participant BE as Backend
    participant RD as Redis

    loop Every 30 seconds
        EX->>BE: device:heartbeat {device_id, running_task_ids}
        BE->>RD: SET device:{id}:online TTL=90s
        BE->>BE: Update running tasks
    end

    Note over BE: Monitor checks every 60 seconds
    alt No heartbeat for 90 seconds
        BE->>RD: Mark device as offline
        BE->>BE: Mark orphaned tasks as failed
    end
```

### Timing Parameters

| Parameter | Value | Description |
|-----------|-------|-------------|
| **Heartbeat Interval** | 30 seconds | Device sends heartbeat |
| **Online TTL** | 90 seconds | Redis key expiration |
| **Monitor Interval** | 60 seconds | Backend checks expired devices |
| **Offline Threshold** | 3 missed heartbeats | Device marked as offline |

### Running Task Tracking

Each heartbeat contains currently running task IDs, used for:

- Real-time slot usage tracking
- Orphaned task detection
- Automatic cleanup on disconnection

---

## 🔄 Task Execution Flow

```mermaid
flowchart TB
    subgraph "Frontend"
        UI[Chat Interface]
        DS[Device Selector]
    end

    subgraph "Backend Services"
        DR[Device Router]
        TS[Task Service]
        WS[WebSocket Handler]
    end

    subgraph "Local Device"
        EX[Executor Client]
        SDK[Claude Code SDK]
    end

    UI --> DS
    DS -->|Select device| UI
    UI -->|chat:send| WS
    WS --> DR
    DR -->|Verify online| TS
    TS -->|Create subtask| DR
    DR -->|task:execute| EX
    EX --> SDK
    SDK -->|Execute| EX
    EX -->|task:progress| WS
    WS -->|chat:chunk| UI

    style DR fill:#14B8A6,color:#fff
    style EX fill:#14B8A6,color:#fff
```

### Task State Transitions

```mermaid
stateDiagram-v2
    [*] --> Pending: Create task
    Pending --> Running: Device receives
    Running --> Completed: Execution success
    Running --> Failed: Execution failure
    Running --> Failed: Device offline
    Pending --> Failed: Device unavailable
```

---

## 🔐 Security Mechanisms

### Authentication Flow

```mermaid
flowchart LR
    subgraph "Authentication Flow"
        T[JWT Token] --> V[Token Validation]
        V --> U[User Context]
        U --> D[Device Session]
    end

    style T fill:#14B8A6,color:#fff
```

### Security Features

| Feature | Description |
|---------|-------------|
| **JWT Authentication** | WebSocket connections require valid token |
| **Token Expiration** | 7-day expiry, requires periodic refresh |
| **User Isolation** | Devices can only execute tasks from their owner |
| **Hardware Binding** | Device ID generated from hardware identifiers |

### Cloud Device Bootstrap Identity Variables

Cloud devices use a user data startup script to install and run the executor automatically. The startup script injects these identity-related environment variables:

| Variable | Source | Purpose |
|----------|--------|---------|
| `WEGENT_AUTH_TOKEN` | API key generated by the backend for the cloud device | Allows the executor to connect to the backend and register the device |
| `WEGENT_USER_JWT_TOKEN` | Current user's Bearer JWT from the cloud device creation request | Allows scripts or integrations on the cloud device to access backend capabilities as the current user |
| `WEGENT_USER_NAME` | Current login username | Allows scripts or integrations on the cloud device to identify the current user |

`WEGENT_AUTH_TOKEN` and `WEGENT_USER_JWT_TOKEN` must not be used interchangeably: the former represents the device authentication identity, while the latter represents the user identity at cloud device creation time.

### User Isolation

Each device session is bound to a user:

- Devices can only receive tasks from their registered owner
- Prevents cross-user task execution
- Subtasks validated against user namespace

### Data Privacy

When using local devices:

- **Code stays local**: Source code is never uploaded to cloud
- **Local execution**: All processing happens on user's machine
- **Result streaming**: Only output text is transmitted
- **No persistent storage**: Cloud doesn't store local files

---

## 🔧 Device ID Generation

The Executor automatically generates a stable device ID based on the following priority:

1. **Cached ID**: Stored in `~/.wegent-executor/device_id` (if exists)
2. **Hardware UUID**:
   - macOS: System hardware UUID
   - Linux: `/etc/machine-id`
   - Windows: `MachineGuid` from registry
3. **Fallback**: MAC address or random UUID

This ensures devices maintain consistent identity across restarts.

---

## 📊 Concurrency Control

### Slot Management

Each device supports up to **5 concurrent tasks**:

- Slot usage tracked in real-time via heartbeats
- Device shows "busy" when all slots are occupied
- Tasks queue if busy device is selected

### Load Balancing

```mermaid
flowchart TB
    T[New Task] --> C{Check device status}
    C -->|Online with free slots| D[Dispatch to device]
    C -->|Busy| Q[Add to queue]
    C -->|Offline| F[Return error]
    Q --> W[Wait for slot release]
    W --> D
```

---

## 🔗 Related Documentation

- [Local Device User Guide](../user-guide/ai-devices/local-device-support.md) - User operation guide
- [System Architecture](./architecture.md) - Overall architecture design
- [OpenAPI Responses API](../reference/openapi-responses-api.md) - API reference

---

## 💬 Get Help

Need help?

- 📖 Check the [FAQ](../faq.md)
- 🐛 Submit a [GitHub Issue](https://github.com/wecode-ai/wegent/issues)
- 💬 Join community discussions
