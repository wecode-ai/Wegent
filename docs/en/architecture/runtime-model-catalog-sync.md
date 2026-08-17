---
sidebar_position: 40
---

# Runtime model catalog synchronization

Scope: Wework synchronizes locally configured models into the target device's Codex catalog and immediately creates a Runtime task after synchronization.

```mermaid
flowchart LR
    SEND[Workbench send] --> PREPARE[prepareRuntimeModel]
    PREPARE --> CONFIG[(local model configuration)]
    PREPARE --> CONFIRM[user confirmation]
    CONFIRM --> WRITE[runtime.codex.catalog.custom.write]
    WRITE --> RESTART[runtime.codex.app_server.restart]
    RESTART --> LIST[runtime.codex.models.list]
    LIST --> VERIFY[verify target model]
    VERIFY --> READY[markLocalModelCatalogReady]
    READY --> CREATE[build payload and create Runtime task]
```

```mermaid
sequenceDiagram
    participant W as Workbench
    participant L as Local runtime API
    participant D as Target device Executor
    participant C as Codex App Server
    participant S as Local model configuration

    W->>L: prepareRuntimeModel(deviceId, modelId)
    L->>W: request synchronization confirmation
    W->>L: confirm + sync
    L->>D: catalog.custom.write(full catalog)
    L->>D: app_server.restart(ifIdle)
    D->>C: restart and load catalog
    L->>D: models.list(includeHidden)
    D-->>L: loaded models
    L->>L: verify target model exists
    L->>S: mark the written snapshot ready
    L-->>W: prepared = true
    W->>L: createRuntimeTask
    L->>S: read ready model configuration
    L->>D: runtime.tasks.create
```

| Edge                                         | Code owner                                                      |
| -------------------------------------------- | --------------------------------------------------------------- |
| Model preparation before Workbench send      | `wework/src/features/workbench/useWorkbenchRuntimeMessaging.ts` |
| Catalog write, restart, verification, create | `wework/src/api/local/localServices.ts`                         |
| Model configuration versions and ready state | `wework/src/features/model-settings/localModelSettings.ts`      |
| Cloud-device Runtime RPC forwarding          | `backend/app/services/device/runtime_rpc_service.py`            |
| Real-desktop protocol-matrix regression      | `wework/e2e/desktop/modules/desktop-build-flows.mjs`            |

Invariants: catalog synchronization is serialized per device and deduplicated by catalog version; the written snapshot becomes ready only after the catalog write succeeds, Codex restarts successfully, and the target model is queryable; ready updates use `id + updatedAt` and must not overwrite configuration created during synchronization; task payloads may use only ready local models; synchronization failure or cancellation must not create a Runtime task.
