---
sidebar_position: 50
---

# IM 私聊续聊本地 Runtime 的流式回传

范围：IM 私聊消息进入本地 Runtime 任务后，模型输出如何回到 IM 卡片。不含 IM 绑定、`/switch` 选任务和云端 Shell 执行链路。

```mermaid
flowchart LR
    IM[IM 私聊消息] --> HANDLER[ChannelHandler 续聊本地任务]
    HANDLER --> EMITTER[创建流式 emitter]
    HANDLER --> REG[注册 callback:runtime:deviceId:localTaskId]
    HANDLER --> RPC[runtime.tasks.send 携带 source=im]
    RPC --> EXEC[本地 executor]
    EXEC --> ENV["runtime:event 信封（回显 source）"]
    ENV --> DEV[DeviceNamespace 中继]
    DEV --> WEWORK[Wework Runtime 命名空间]
    DEV --> BRIDGE[LocalTaskResponsesHandler 桥接]
    BRIDGE --> REG
    REG --> CARD[IM 卡片流式更新与终态]
```

```mermaid
sequenceDiagram
    participant U as IM 用户
    participant H as ChannelHandler
    participant C as Callback 注册表
    participant E as 本地 executor
    participant D as DeviceNamespace
    participant W as Wework

    U->>H: 私聊文本
    H->>C: 以 runtime:deviceId:localTaskId 注册 emitter
    H->>E: runtime.tasks.send(source=im)
    E-->>D: runtime:event(event_type, taskId, data, source)
    D->>W: 中继 runtime:event
    D->>C: source.source == im 时转发已解析事件
    C-->>U: 流式增量写入 IM 卡片
    E-->>D: runtime:event(response.completed, source)
    D->>W: 中继终态
    D->>C: handle_task_completed(COMPLETED)
    C-->>U: 写入最终回答并释放 emitter
```

| 边界                    | 代码归属                                                                     |
| ----------------------- | ---------------------------------------------------------------------------- |
| IM 续聊与 emitter 注册  | `backend/app/services/channels/handler.py`                                   |
| callback key 与转发     | `backend/app/services/channels/callback.py`                                  |
| `runtime:event` 信封    | `executor/src/runtime_work/events.rs`、`executor/src/local/backend.rs`        |
| 中继与 IM 桥接          | `backend/app/api/ws/device_namespace.py`                                     |
| 信封归一化与终态方言翻译 | `backend/app/api/ws/local_task_responses.py`                                 |

不变量：本地 Runtime 只通过 `runtime:event` 信封回传流式输出，扁平 `response.*` 设备事件不覆盖该场景，因此中继路径必须自行转发 IM callback；callback key 恒为 `runtime:<device_id>:<local_task_id>`，`device_id` 取设备会话身份，必须与 IM 侧注册时使用的 `address.device_id` 相同；信封使用 camelCase（`taskId`、`subtaskId`），桥接前必须归一化再交给事件解析器；本地 Runtime 的终态方言与 Responses API 不同——最终答案在 `data.value`，失败原因在 `data.error.message`，共享解析器读的是 `data.response.output[].content[].text` 且不识别 `response.failed`，因此终态必须先在桥接层翻译成 `ExecutionEvent`，否则卡片只会拿到空内容或永远停在处理中；缺少 `source` 或 `source.source != "im"` 的信封不得进入 IM 转发；Wework 中继先于 IM 转发执行，IM 通道失败只能按通道隔离，不得阻断中继或持久化；终态事件必须走 `handle_task_completed` 以写入最终内容并释放 emitter，不得只发增量。
