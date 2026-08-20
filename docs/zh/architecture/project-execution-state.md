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
    RESTART[Backend 重启] --> RECONNECT[设备重连]
    RECONNECT --> SNAPSHOT[Runtime 任务快照对账]
    SNAPSHOT --> FENCE
    CANCEL_FENCE[Runtime 取消出口栅栏] --> EVENT
    PROCESS --> CANCEL_FENCE
    EVENT --> FENCE[身份与顺序栅栏]
    FENCE --> TRUTH[(执行状态真值)]
    TRUTH --> NORMALIZE[执行 ID 哨兵归一化]
    NORMALIZE --> VIEW
    VIEW[UI 纯投影]
    SETTINGS[设备 slot_max] --> SCHEDULER[Runtime scheduler]
    RUN_NOW[用户立即执行] --> SCHEDULER
    SCHEDULER --> CLAIM
    SCHEDULER --> CAPACITY[slot_used / slot_max 投影]
    PROCESS --> TRANSCRIPT[Runtime transcript]
    TRANSCRIPT --> DETAIL[执行详情]
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
    opt 用户对排队任务选择立即执行
        U->>R: force_start(execution_id)
        R->>R: 临时允许 slot_used > slot_max
    end
    R->>P: start
    alt 启动确认到达
        P-->>S: sequenced running/output events
        S->>S: 校验 attempt、sequence、lease
    else 启动请求结果未知
        S->>R: 查询 Runtime 任务列表
        alt 精确 runtime_task_id 存在
            R-->>S: queued/running/terminal 快照
            S->>S: 按 Runtime 真值继续或终结
        else 精确 runtime_task_id 不存在
            R-->>S: missing
            S->>S: 清除启动栅栏并重新排队
        end
    end
    alt 正常终止
        P-->>S: terminal event
        S->>S: 原子写终态并释放 slot
    else 取消
        U->>S: cancel intent
        S->>R: cancel command
        R->>R: 先关闭该 attempt 的事件出口
        R->>P: abort
        alt 收到直接停止 ACK
            R-->>S: stopped ACK
        else ACK 响应丢失
            S->>R: 查询 Runtime 任务列表
            R-->>S: 精确 runtime_task_id 已不存在
        end
        S->>S: 写 cancelled 并释放 slot
    else lease 过期
        S->>R: reconcile
        S->>S: 按真实进程结果恢复或终结
    end
    opt Backend 重启后设备重连
        R-->>S: 当前 Runtime 任务快照
        S->>S: 先补建缺失的活动投影，再对账所有绑定到该设备的活动执行
        S->>S: 提交状态与活动投影
        S-->>U: 提交后推送活动更新
    end
    S-->>U: 将 0 归一化为 null 后只读投影
    U->>R: 加载执行 transcript
    alt 任务仍在运行
        R-->>U: 立即返回 Runtime 实时缓存并继续推送事件
    else 历史 transcript 可用
        R-->>U: 会话内容
    else transcript 超时或暂不可用
        U->>U: 停止加载并提供重试，不改变执行状态
    end
```

| 边                                      | 代码归属                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------- |
| claim、attempt 与状态转换               | `backend/app/services/loop_item_executions/service.py`                                      |
| 执行 ID 存储与归一化                    | `backend/app/models/loop_item_execution.py`、execution API/schema                           |
| scheduler、slot、真实进程与取消事件栅栏 | `executor/src/runner/`、`executor/src/runtime_work/`、`executor/src/local/backend/tasks.rs` |
| 本地 IPC 和 Runtime RPC                 | `executor/src/local/app_ipc.rs`、Backend device runtime service                             |
| transcript 加载与 UI 投影               | Wework runtime IPC、pane session 与执行详情组件                                             |

不变量：attempt 身份和事件序列必须匹配；迟到事件不能覆盖新 attempt；终态与 slot 释放原子发生；取消发送不等于取消成功。Runtime 必须先原子关闭该 attempt 的事件出口，再中止任务并发送唯一取消终态，已分离的流式回调不得在取消开始后继续投影内容，作用域退出必须保证停止 ACK。启动请求已发出但确认丢失时不得盲目重发；只有 Runtime 权威任务列表确认精确 `runtime_task_id` 不存在，才能清除启动栅栏并把同一执行意图重新排队。只有停止 ACK，或在 `cancel_requested` 后由 Runtime 权威任务列表确认精确 `runtime_task_id` 已不存在，才能写 cancelled 并释放 slot；Backend 重启后，设备首次重连必须主动查询 Runtime 任务快照并对账该设备的活动执行，不能只等待旧 lease 过期；重连对账必须先补建缺失的活动投影，再应用 running/terminal 快照，并在事务提交后推送活动，Runtime RPC 与活动推送期间不得持有 SQL 事务；`loop_item_executions.team_id/backend_task_id=0` 只表示未绑定，存在性判断必须使用正 ID 语义，API/UI 必须归一化为 `null`；容量属于各设备 Runtime scheduler，聚合容量不是执行真值；队列持久化和排队任务 ID 必须来自同一个 scheduler 快照；“立即执行”允许指定排队任务临时突破 `slot_max`，此时 `slot_used` 必须由活动任务 ID 精确投影，且在活动数重新低于上限前不得自动启动其他排队任务；运行中的 transcript 必须优先返回 Runtime 实时缓存，不得等待可能被活动回合占用的 Provider 历史接口；transcript 可用性不是执行状态真值，详情读取超时必须结束加载、保留已有内容并提供重试，不得把执行改为失败或停止；UI 不推导或回写运行状态。

详细状态矩阵与验收见 [项目执行状态真实性重构](../wework/developer-guide/wework-project-execution-state-truth-refactoring.md)。
