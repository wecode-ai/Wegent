---
sidebar_position: 10
---

# 看板自动化与 Wegent 执行

范围：人工、API 和自动化指派进入同一执行真值与 runtime 激活路径，并把可信终态投影回看板。

```mermaid
flowchart LR
    ENTRY[人工 / API / 自动化] --> ASSIGN[统一指派服务]
    ASSIGN --> ITEM[(loop_items 负责人真值)]
    ASSIGN --> EXEC[(loop_item_executions 执行真值)]
    EXEC --> ACTIVATE[统一 runtime 激活器]
    ACTIVATE -->|Wework local/cloud| DEVICE[设备 Runtime]
    ACTIVATE -->|Wegent| TASK[原生 Task/Subtask]
    TASK --> REQUEST[ExecutionRequest + 看板 MCP]
    REQUEST --> TEAM[Team Runtime]
    DEVICE --> EVENT[运行事件 / ACK]
    TEAM --> EVENT
    EVENT --> PROJECT[统一终态投影器]
    PROJECT --> EXEC
    EXEC --> VIEW[队列 / 卡片 / 活动流]
```

```mermaid
sequenceDiagram
    participant E as 指派入口
    participant A as 指派服务
    participant X as execution 真值
    participant R as runtime 激活器
    participant T as Runtime / Team
    participant P as 终态投影器

    E->>A: assign(agent, item)
    A->>X: 取消旧尝试并创建 queued execution
    A-->>E: 提交负责人和 execution
    E->>R: activate(execution_id)
    R->>X: 加锁并校验 queued/负责人/runtime
    R->>T: claim 或创建 Task/Subtask
    T->>X: accepted/running
    T-->>P: 完成、失败或取消 ACK
    P->>X: 校验关联 ID 后写终态
    X-->>E: UI 只读取 execution 真值
```

| 边                       | 代码归属                                                              |
| ------------------------ | --------------------------------------------------------------------- |
| 入口 → 指派              | `backend/app/services/loop_items/`、`project_automation_execution.py` |
| 指派 → execution 真值    | `backend/app/services/loop_item_executions/service.py`                |
| execution → runtime 激活 | `board_team_execution.py`、`robot_queue_tasks.py`、Wework puller      |
| Wegent 请求 → 看板 MCP   | `execution/request_builder.py`、`mcp_server/tools/wework_space.py`    |
| Runtime 事件 → 终态      | `board_team_completion.py`、Executor 状态更新                         |
| 评论 → 精确续聊          | `board_team_continuation.py`、`project_automation_tasks.py`           |

不变量：所有入口共用指派与激活器；激活只能发生在提交后；`loop_item_executions` 是看板执行唯一真值；Wegent 绑定使用精确 execution/task/subtask/team ID；取消先写意图，只有 Runtime ACK 写终态；消息和 UI 不能反向覆盖执行状态。

详细领域、API 与交付说明见 [云项目协作开发指南](../wegent/developer-guide/cloud-project-collaboration.md)。
