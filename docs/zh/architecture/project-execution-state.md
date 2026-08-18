---
sidebar_position: 30
---

# 项目执行状态与 Runtime 容量

范围：执行领取、事件顺序、取消、迟到事件、lease 对账、设备并发容量与 UI 投影。

```mermaid
flowchart LR
    INTENT[(持久执行意图)] --> CLAIM[Runtime 原子 claim]
    CLAIM --> ACTIVE[(活动 attempt + lease)]
    ACTIVE --> PROCESS[真实进程]
    PROCESS --> EVENT[带 attempt/sequence 的事件]
    EVENT --> FENCE[身份与顺序栅栏]
    FENCE --> TRUTH[(执行状态真值)]
    TRUTH --> NORMALIZE[执行 ID 哨兵归一化]
    NORMALIZE --> VIEW
    VIEW[UI 纯投影]
    SETTINGS[设备 slot_max] --> SCHEDULER[Runtime scheduler]
    SCHEDULER --> CLAIM
    SCHEDULER --> CAPACITY[slot_used / slot_max 投影]
```

```mermaid
sequenceDiagram
    participant Q as 执行队列
    participant R as Runtime scheduler
    participant P as 真实进程
    participant S as 状态服务
    participant U as UI

    Q->>Q: 未绑定 team/task 使用 0 哨兵持久化
    R->>Q: claim(execution_id, attempt_id)
    Q-->>R: accepted + lease
    R->>P: start
    P-->>S: sequenced running/output events
    S->>S: 校验 attempt、sequence、lease
    alt 正常终止
        P-->>S: terminal event
        S->>S: 原子写终态并释放 slot
    else 取消
        U->>S: cancel intent
        S->>R: cancel command
        R-->>S: stopped ACK
        S->>S: 写 cancelled 并释放 slot
    else lease 过期
        S->>R: reconcile
        S->>S: 按真实进程结果恢复或终结
    end
    S-->>U: 将 0 归一化为 null 后只读投影
```

| 边                         | 代码归属                                                        |
| -------------------------- | --------------------------------------------------------------- |
| claim、attempt 与状态转换  | `backend/app/services/loop_item_executions/service.py`          |
| 执行 ID 存储与归一化       | `backend/app/models/loop_item_execution.py`、execution API/schema |
| scheduler、slot 与真实进程 | `executor/src/runner/`、`executor/src/runtime_work/`            |
| 本地 IPC 和 Runtime RPC    | `executor/src/local/app_ipc.rs`、Backend device runtime service |
| UI 投影                    | Wework workbench stores 与 board queries                        |

不变量：attempt 身份和事件序列必须匹配；迟到事件不能覆盖新 attempt；终态与 slot 释放原子发生；取消发送不等于取消成功；`loop_item_executions.team_id/backend_task_id=0` 只表示未绑定，存在性判断必须使用正 ID 语义，API/UI 必须归一化为 `null`；容量属于各设备 Runtime scheduler，聚合容量不是执行真值；UI 不推导或回写运行状态。

详细状态矩阵与验收见 [项目执行状态真实性重构](../wework/developer-guide/wework-project-execution-state-truth-refactoring.md)。
