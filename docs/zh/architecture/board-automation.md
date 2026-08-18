---
sidebar_position: 10
---

# 看板自动化与 Wegent 执行

范围：人工、API 和自动化指派进入同一执行真值与 runtime 激活路径，并把可信终态投影回看板。

```mermaid
flowchart LR
    ENTRY[人工 / API / 自动化] --> ASSIGN[统一指派服务]
    ASSIGN --> ITEM[(loop_items 负责人真值)]
    ITEM --> NORMALIZE[存储哨兵归一化]
    NORMALIZE --> API[API null 语义]
    ASSIGN --> EXEC[(loop_item_executions 执行真值)]
    EXEC --> ACTIVITY[execution 独占活动评论]
    EXEC --> ACTIVATE[统一 runtime 激活器]
    ACTIVATE -->|Wework local/cloud| DEVICE[设备 Runtime]
    ACTIVATE -->|Wegent| TASK[原生 Task/Subtask]
    TASK --> REQUEST[ExecutionRequest + 看板 MCP]
    REQUEST --> TEAM[Team Runtime]
    DEVICE --> EVENT[运行事件 / ACK]
    TEAM --> EVENT
    EVENT --> PROJECT[统一终态投影器]
    PROJECT --> EXEC
    ACTIVITY --> VIEW[队列 / 卡片 / 活动流]
    EXEC --> VIEW
```

```mermaid
sequenceDiagram
    participant E as 指派入口
    participant A as 指派服务
    participant I as loop_items
    participant X as execution 真值
    participant C as execution 活动评论
    participant R as runtime 激活器
    participant T as Runtime / Team
    participant P as 终态投影器

    E->>A: assign(agent, item)
    A->>I: 写负责人；MySQL 未分配 Team 写 0 哨兵
    I-->>A: 读取时将 0 归一化为领域 null
    A->>X: 取消旧尝试并创建 queued execution
    X->>C: 每个 execution 创建一条身份不可变的独立评论
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
| 负责人存储 → API 语义    | `backend/app/models/delivery.py`、`backend/app/schemas/delivery.py`   |
| 指派 → execution 真值    | `backend/app/services/loop_item_executions/service.py`                |
| execution → 独立评论     | `loop_item_executions/service.py`、`project_automation_execution.py`  |
| execution → runtime 激活 | `board_team_execution.py`、`robot_queue_tasks.py`、Wework puller      |
| Wegent 请求 → 看板 MCP   | `execution/request_builder.py`、`mcp_server/tools/wework_space.py`    |
| Runtime 事件 → 终态      | `board_team_completion.py`、Executor 状态更新                         |
| 评论 → 精确续聊          | `board_team_continuation.py`、`project_automation_tasks.py`           |

不变量：所有入口共用指派与激活器；机器人负责人变更必须在同一业务事务中创建对应的 queued execution，自动执行由该 execution 的既有队列消费链负责；激活只能发生在提交后；`loop_item_executions` 是看板执行唯一真值；任务包含多个评论，每条评论的作者身份创建后不可修改；人创建父评论且负责人是机器人时，机器人以新评论回复该父评论；机器人创建父评论后，人回复该评论时，负责人机器人以另一条新评论继续回复；评论之间只通过 `reply_to_message_id` 和 `thread_root_message_id` 建立线程关系，不得通过改写旧评论作者表达交接；AI 调度员评论与其选中的项目机器人评论必须始终分离；Wegent 绑定使用精确 execution/task/subtask/team ID；MySQL `loop_items.assignee_team_id=0` 只表示未分配，服务和 API 必须将其归一化为 `null`，不得把 `0` 当作 Team ID；`loop_item_executions` 的可选 Team/Task ID 使用独立但一致的 `0 ↔ null` 边界；取消先写意图，只有 Runtime ACK 写终态；消息和 UI 不能反向覆盖执行状态。

详细领域、API 与交付说明见 [云项目协作开发指南](../wegent/developer-guide/cloud-project-collaboration.md)。
