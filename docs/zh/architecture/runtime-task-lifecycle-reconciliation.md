---
sidebar_position: 8
---

# Runtime 任务生命周期对账

## 范围

约束 Wework 如何消费 Runtime 任务事件、检测本地投影可能过期，并在不轮询 transcript 的前提下恢复权威任务状态。

## 连线图

```mermaid
flowchart LR
    EXEC[Executor 任务状态] --> STREAM[Runtime 事件流]
    STREAM --> STORE[Lifecycle Store]
    STORE --> UI[运行状态 UI 投影]
    STREAM --> SIGNAL[终态事件、掉队或 Transport 替换]
    SIGNAL --> LIST[runtime.tasks.list]
    LIST --> STORE
    TRANSCRIPT[runtime.tasks.transcript] -. 用户打开会话或消息同步 .-> UI
```

## 时序图

```mermaid
sequenceDiagram
    participant E as Executor
    participant S as Runtime 事件流
    participant C as Lifecycle Coordinator
    participant L as Lifecycle Store

    E-->>S: task/turn 事件
    S-->>L: 增量投影
    alt 没有终态或异常信号
        Note over C: 不发起状态轮询
    else 终态事件、executor.event_lagged 或 runtime transport replacement
        S-->>C: 投影可能过期
        C->>E: runtime.tasks.list
        E-->>C: 持久化任务快照
        C->>L: syncRuntimeWork
    end
```

## 代码归属

| 职责                             | 代码                                                                                           |
| -------------------------------- | ---------------------------------------------------------------------------------------------- |
| 本地 Executor 事件解析           | `wework/src/api/runtime/runtimeChatStream.ts`                                                  |
| Hybrid stream handler 路由       | `wework/src/api/hybrid/hybridServices.ts`                                                      |
| 事件驱动对账协调                 | `wework/src/features/workbench/runtimeTaskLifecycle/RuntimeTaskLifecycleStreamCoordinator.tsx` |
| 生命周期真值投影                 | `wework/src/features/workbench/runtimeTaskLifecycle/RuntimeTaskLifecycleStore.ts`              |
| Executor task list 与 transcript | `executor/src/runtime_work/handler/queries.rs`                                                 |

## 必要不变量

- 正常生命周期只消费事件流，不得按时间周期读取 task list 或 transcript。
- 任务面板正常消费终态事件并刷新任务快照；事件循环结束后若对应任务仍为 running，常驻协调器必须补充一次 `runtime.tasks.list` 对账，以覆盖面板订阅缺席或未匹配的情况。
- 明确表示本地投影可能过期的 `executor.event_lagged` 和 runtime transport replacement 同样触发对账。
- 并发终态或异常信号必须共享同一个在途对账请求；在途期间的新信号最多合并成一次串行尾随对账，不得形成并发请求突发或定时重试循环。
- 任务终态由 Executor 持久化状态字段投影，不得从 transcript、turn items 或 rollout JSONL 推导。
- Transcript 读取只服务于用户查看会话或明确的消息同步，不承担生命周期心跳职责。
