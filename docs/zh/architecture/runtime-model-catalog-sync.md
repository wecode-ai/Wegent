---
sidebar_position: 40
---

# Runtime 模型目录同步

范围：Wework 将本地配置的模型同步到目标设备的 Codex 目录，并在同步完成后立即创建 Runtime 任务。

```mermaid
flowchart LR
    SEND[Workbench 发送] --> PREPARE[prepareRuntimeModel]
    PREPARE --> CONFIG[(本地模型配置)]
    PREPARE --> CONFIRM[用户确认]
    CONFIRM --> WRITE[runtime.codex.catalog.custom.write]
    WRITE --> RESTART[runtime.codex.app_server.restart]
    RESTART --> LIST[runtime.codex.models.list]
    LIST --> VERIFY[验证目标模型]
    VERIFY --> READY[markLocalModelCatalogReady]
    READY --> CREATE[构建 payload 并创建 Runtime 任务]
```

```mermaid
sequenceDiagram
    participant W as Workbench
    participant L as Local runtime API
    participant D as 目标设备 Executor
    participant C as Codex App Server
    participant S as 本地模型配置

    W->>L: prepareRuntimeModel(deviceId, modelId)
    L->>W: 请求同步确认
    W->>L: confirm + sync
    L->>D: catalog.custom.write(完整目录)
    L->>D: app_server.restart(ifIdle)
    D->>C: 重启并加载目录
    L->>D: models.list(includeHidden)
    D-->>L: 已加载模型
    L->>L: 验证目标模型存在
    L->>S: 标记本次写入快照 ready
    L-->>W: prepared = true
    W->>L: createRuntimeTask
    L->>S: 读取 ready 模型配置
    L->>D: runtime.tasks.create
```

| 边                             | 代码归属                                                        |
| ------------------------------ | --------------------------------------------------------------- |
| Workbench 发送前模型准备       | `wework/src/features/workbench/useWorkbenchRuntimeMessaging.ts` |
| 目录写入、重启、验证和任务创建 | `wework/src/api/local/localServices.ts`                         |
| 模型配置版本与 ready 状态      | `wework/src/features/model-settings/localModelSettings.ts`      |
| 云设备 Runtime RPC 转发        | `backend/app/services/device/runtime_rpc_service.py`            |
| 真实桌面协议矩阵回归           | `wework/e2e/desktop/modules/desktop-build-flows.mjs`            |

不变量：模型目录按设备串行同步并按目录版本去重；只有目录写入成功、Codex 重启成功且目标模型可查询后，当前写入快照才能标记为 ready；ready 更新必须使用 `id + updatedAt`，不得覆盖同步期间产生的新配置；任务 payload 只能读取已 ready 的本地模型；同步失败或取消时不得创建 Runtime 任务。
