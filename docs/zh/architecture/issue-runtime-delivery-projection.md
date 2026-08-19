---
sidebar_position: 23
---

# Issue Runtime 状态、交付与界面投影

范围：Runtime Task 终态进入 Issue workflow、Delivery fulfillment 进入阶段门禁，以及 Issue 详情对任务、阶段和交付状态的一致投影。

```mermaid
flowchart LR
    RUNTIME[Runtime Task 生命周期] --> STATUS_API[原子任务状态命令]
    STATUS_API --> TASK_TRUTH[(workflow.task_statuses)]
    BINDING[(LoopItemTaskBinding)] --> TASK_TRUTH
    TASK_TRUTH --> PROJECTOR[阶段状态投影器]

    AGENT[用户 / Agent] --> DELIVERY_API[Delivery finalize]
    DELIVERY_API --> DELIVERY[(不可变 Delivery + fulfillments)]
    DELIVERY_API --> NODE_DELIVERIES[(workflow.delivery_ids)]
    DELIVERY --> COVERAGE[交付覆盖计算]
    NODE_DELIVERIES --> COVERAGE

    PROJECTOR --> GATE[阶段门禁]
    COVERAGE --> GATE
    GATE --> ISSUE[(Issue workflow 快照)]

    STATUS_API --> EVENT[Issue changed 事件]
    DELIVERY_API --> EVENT
    EVENT --> DETAIL[Issue 详情重新读取]
    ISSUE --> DETAIL
    BINDING --> DETAIL
    DELIVERY --> DETAIL
    DETAIL --> VIEW[任务终态 / 阶段状态 / 交付 N/M]

    DELIVERY --> FILE_INDEX[项目交付文件索引 + Issue/任务祖先链]
    FILE_INDEX --> FILE_VIEW[文件管理器 Issue / 子任务目录]
```

```mermaid
sequenceDiagram
    participant R as Runtime
    participant W as Wework 生命周期桥
    participant O as Orchestration 服务
    participant D as Delivery 服务
    participant DB as Issue / Delivery 存储
    participant E as Issue changed 事件
    participant U as Issue 详情

    par Runtime 终态同步
        R-->>W: task succeeded / failed / cancelled
        W->>O: 按 device_id:task_id 写入终态
        O->>DB: 原子更新对应 task_statuses
        O->>O: 以最近绑定任务可信终态重算阶段
        O-->>E: 发布 Issue changed
    and Delivery 履约
        D->>D: 校验 requirement_id、类型和资产归属
        D->>DB: 同一事务固化 Delivery、fulfillments 和 delivery_id
        D-->>E: 发布 Issue changed
    end
    E-->>U: 失效当前 Issue 投影
    U->>O: 重新读取 Issue、TaskBinding 和 Delivery
    O-->>U: 返回一致的阶段状态和交付覆盖

    alt 状态写入失败
        O-->>W: 明确失败，可观测且有界重试
        Note over O,U: 未知状态不得投影为 queued
    else Delivery 提交成功但界面刷新失败
        U-->>U: 标记数据可能过期并允许重新读取
        Note over D,U: 已持久化 Delivery 不得被显示为“未提交”的权威结论
    end

    U->>DB: 读取项目 Delivery asset 与 LoopItem 父子链
    DB-->>U: 返回 asset_id + 从 Issue 到当前任务的完整路径
    U-->>U: 投影为只读文件夹，不复制或移动底层资产
```

| 边                                            | 代码归属                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------- |
| Runtime 生命周期 → Issue 状态同步             | Wework `deliveries` API、Backend `project_workflow_projection` 原子任务状态命令 |
| TaskBinding + task status → 阶段状态          | Wework `issueWorkflow`、Backend workflow projection                             |
| Delivery finalize → fulfillment 与节点绑定    | Backend Delivery service、`wework-space` MCP                                    |
| fulfillment → N/M 覆盖与审批门禁              | Backend deliverable projection、workflow decision service                       |
| Issue changed → 详情刷新                      | Backend `loop_item_events`、Wework `projectChatSocket` 与 `CloudTodoWorkspace`  |
| Issue、TaskBinding、Delivery → UI             | Wework `TodoEditor`、`IssueWorkflowDag`                                         |
| Delivery asset + LoopItem 父子链 → 文件管理器 | Backend `cloud_files` service 与 cloud-project API、Wework `CloudFilesView`     |

必要不变量：

- Runtime Task 状态以稳定的 `device_id:task_id` 为键，由后端原子更新；客户端不得读取并回写整个 workflow JSON 来修改一个任务状态。
- 人工任务只有 Runtime 明确报告 queued 时才能显示排队中。新绑定任务状态未知时必须保留后端阶段状态或显示“同步中”，不得推导 queued。
- 阶段状态由 TaskBinding 顺序和持久化终态确定：任一 running 优先，否则使用最近绑定任务的可信终态；人工阶段成功后进入 `awaiting_approval`。
- Delivery finalize 必须在同一事务内固化 Delivery、typed fulfillments 和节点 `delivery_id`；只有 `fulfillments[].requirement_id` 计入 N/M。
- Runtime 状态更新和 Delivery finalize 都必须使 Issue 详情投影失效。刷新后必须同时读取 Issue、TaskBinding 和 Delivery，禁止混合不同版本的缓存。
- 状态写入失败必须返回结构化错误并执行有界重试，不得形成无上限 PATCH 循环；失败不得改变 UI 语义。
- 人工审批必须使用服务端实时重算的阶段状态和交付覆盖，不得信任客户端缓存或可能滞后的节点快照。
- 项目交付文件索引必须返回从根 Issue 到交付所属任务的完整、持久化父子链；前端不得通过标题、编号或文件路径猜测任务层级。
- LoopItem 根节点的 `parent_id` 数据边界同时包含 `NULL` 与历史空字符串；两者都必须终止祖先遍历。
- 文件管理器目录是 Delivery 的只读投影。展开目录、预览或下载不得复制、移动或修改底层资产，文件身份始终是原始 `asset_id`。
