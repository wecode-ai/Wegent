---
sidebar_position: 4
---

# 自定义 AI 调度员评论续聊

```mermaid
flowchart LR
    EXEC[(automation_manager execution)] --> BIND[持久化 execution_id + executor_type + manager_type]
    BIND --> ROOT[调度员活动评论]
    EXEC --> SESSION[绑定 Runtime 会话]
    USER[用户回复] --> QUEUE[按调度员评论会话排队]
    QUEUE --> ROUTE[按被回复评论解析执行身份]
    ROOT --> ROUTE
    ROUTE --> REPLY[新建调度员身份回复]
    ROUTE --> SESSION
    SESSION --> STREAM[回复内容流]
    STREAM --> REPLY
    REPLY -. conversation_only .-> TASK[任务执行状态保持不变]
```

```mermaid
sequenceDiagram
    participant U as 用户
    participant W as Wework 评论区
    participant C as ProjectChatService
    participant X as execution 真值
    participant R as Runtime 会话

    X->>C: 创建 automation_manager execution
    C->>C: 将 execution_id、executor_type、manager_type 写入活动评论
    C-->>W: 发布身份完整的调度员评论
    U->>W: 回复自定义 AI 调度员评论
    W->>W: 会话为 pending 或 streaming 时保存到该评论会话队列
    W->>W: 前一轮终态后按创建顺序取下一条
    W->>C: manager:continue(用户评论, 调度员评论)
    C->>X: 校验 execution_id、任务、项目和 Runtime 绑定
    C->>C: 创建新的调度员身份 streaming 回复
    C-->>W: 返回新回复
    W->>R: 向该调度员评论绑定的会话发送用户内容
    R-->>C: 流式更新并完成新回复
    C->>C: 仅更新评论状态，不改任务 AI 执行状态
```

| 边界                     | 代码归属                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| execution → 评论身份绑定 | `backend/app/services/project_automation_execution.py`                                          |
| 评论识别与路由           | `wework/src/features/todo/TaskActivityView.tsx`                                                 |
| Socket 合约              | `wework/src/api/backend/projectChatSocket.ts`、`backend/app/api/ws/wework_runtime_namespace.py` |
| execution 与评论校验     | `backend/app/services/project_chat/service.py`                                                  |
| Runtime 会话继续         | `wework/src/features/workbench/`                                                                |

不变量：调度员活动评论发布前必须持久化 `execution_id`、`executor_type=automation_manager` 和对应的 `manager_type`，UI 与续聊服务不得从任务当前负责人反推评论身份；续聊目标由被回复评论绑定的 execution 和 Runtime 会话决定；仅自定义 `automation_manager` execution 可以进入此路径；同一调度员评论会话处于 `pending` 或 `streaming` 状态时，追加回复必须保留在该会话队列中并按创建顺序发送；用户回复和调度员回答必须是两条新评论，既有评论作者身份不可修改；续聊复用原调度员会话；对话回复不得覆盖任务当前机器人的执行状态、负责人或看板状态。
