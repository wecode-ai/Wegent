---
sidebar_position: 20
---

# Issue、任务与工作流编排

范围：Issue 的任务组织方式、推进方式、项目阶段 DAG、Issue 阶段快照、具体任务与执行记录的引用、依赖就绪判断、工作空间继承、动态投影和 Issue 状态聚合。

```mermaid
flowchart LR
    TEMPLATE[(项目 Orchestration Definition)] --> SNAPSHOT[(Issue Orchestration Snapshot)]
    ISSUE[(LoopItem / Issue)] --> SNAPSHOT
    SNAPSHOT --> MODE{推进方式}
    MODE -->|用户管理| HUMAN[用户拆解与分配]
    MODE -->|AI 调度| AI[AI 读取 Issue、提示词与阶段定义]
    SNAPSHOT --> GRAPH{是否设置阶段 DAG}
    GRAPH -->|无阶段| FREE[自由任务集合]
    GRAPH -->|有阶段| STAGE[Stage / Node / Milestone]
    STAGE --> EDGE[依赖边 / Context Contract]
    EDGE --> STAGE
    HUMAN --> BINDING[(LoopItemTaskBinding)]
    AI --> BINDING
    FREE --> BINDING
    STAGE --> BINDING
    BINDING --> TASK[(Wework Runtime Task)]
    STAGE -->|阶段自动化规则| EXEC[(LoopItemExecution)]
    EXEC --> RUNTIME[现有 Runtime / Team / API 激活器]
    TASK --> WORKSPACE[现有 workspace / worktree / branch 真值]
    WORKSPACE -->|inherit| NEXT[后继具体任务]
    TASK --> AGGREGATE[Issue 状态聚合器]
    EXEC --> AGGREGATE
    STAGE --> AGGREGATE
    AGGREGATE --> ISSUE
    TASK --> ACTIVITY[Issue 动态]
    EXEC --> ACTIVITY
    ACTIVITY --> STREAM[流式执行卡片 / Final 摘要 / 附件事件]
```

```mermaid
sequenceDiagram
    participant U as 用户
    participant O as Orchestration 服务
    participant A as AI 调度员
    participant B as Task Binding
    participant E as Execution 服务
    participant R as Runtime scheduler
    participant D as Issue 动态
    participant I as Issue 投影

    U->>O: 创建 Issue
    O->>O: 固化推进方式、提示词和可选阶段 DAG
    O->>O: 校验 DAG、边级上下文契约并计算 ready 阶段
    alt 用户管理
        U->>B: 创建具体任务，可选归入 ready 阶段
    else AI 调度
        O->>A: 提供 Issue、提示词、阶段定义、边级上下文契约与当前执行真值
        A->>B: 拆解并分配具体任务
        Note over A,B: 有阶段时每个任务必须归入阶段；无阶段时可自由拆解
    end
    opt 阶段配置自动化动作
        O->>E: 创建 queued execution
        E->>R: 进入现有容量队列
    end
    B->>R: 具体任务进入现有容量队列
    R-->>D: 流式进度、终态与交付附件
    B-->>O: Runtime Task 状态变化
    E-->>O: execution 状态变化
    O->>O: 聚合阶段内任务并解锁后继阶段
    O->>I: 聚合全部必要阶段与自由任务状态
```

| 边                                  | 代码归属                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------ |
| 项目编排定义与 Issue 快照           | Backend workflow schema/service；Wework 自动化页 DAG UI                  |
| 依赖边 → 后继阶段上下文             | Workflow node dependency context；Composer / automation instruction      |
| 用户管理 / AI 调度 → 具体任务       | 标准 Wework Composer、AI manager、`LoopItemTaskBinding`                  |
| 阶段 → 自动化执行                   | `project_automation_execution.py`、`loop_item_executions/service.py`     |
| 工作空间与后继任务继承              | Runtime Task summary、Wework project work controls                       |
| DAG 就绪判断、阶段与 Issue 状态聚合 | Backend workflow service；本地 ProjectSpace 服务；Wework 实时投影         |
| 执行真值 → Issue 动态               | Project chat stream、Task activity cards、Delivery/attachment projection |

不变量：

- `LoopItem` 是 Issue 和业务聚合容器，不是一次执行。
- Stage / Node / Milestone 是任务的逻辑分类和依赖节点，不是一次执行，也不是执行者类型。
- Wework Runtime Task、Wegent Task 和 `LoopItemExecution` 继续分别承担具体任务与执行真值；阶段只引用它们，不复制状态、工作目录、worktree、分支或队列字段。
- 阶段 DAG 与推进方式正交。用户管理和 AI 调度都可在“无阶段”或“有阶段”下工作。
- 依赖边既表示就绪约束，也定义前序阶段向后继阶段传递的上下文。Issue 基础信息始终传递；边只配置是否附加前序任务最终结果、交付附件和执行过程。
- 边级上下文策略属于后继节点对某个前置节点的输入声明；删除依赖时必须同时删除对应策略，不能留下悬空配置。
- AI 调度必须通过创建、指派和启动具体任务推进 Issue。有阶段时每个 AI 创建的任务必须归入一个阶段，并遵守该阶段依赖；无阶段时 AI 可根据 Issue 和提示词自由拆解。
- 一个 Issue 可以绑定多个异构任务，一个阶段也可聚合多个具体任务。任务仍可在 Wework 任务列表中找到。
- 阶段自动化只决定何时、如何创建或启动具体执行，不是与“任务”并列的实体类型。
- `inherit` 只从明确的前驱 Runtime Task 读取已确认的 workspace/worktree/branch；没有可继承来源时必须回到标准 Composer 选择，不得猜测目录。
- queued、待审批或依赖未满足只投影为“待开始”；只有 Runtime 确认 running 才投影为“进行中”。
- 阶段完成由阶段内全部必要任务/执行的可信终态聚合得到；Issue 完成由全部必要阶段和自由任务聚合得到。任一单个任务完成不得直接完成仍有未完成工作的阶段或 Issue。
- DAG 必须无环；任务归入阶段前，该阶段必须存在；阶段开始前依赖必须全部满足；边级上下文只能引用直接前置阶段；UI 不得直接写 running。
- Issue“动态”是执行过程的统一投影。流式卡片只展示 Runtime 真值的紧凑摘要；完成后展示 final content 摘要；附件事件引用真实交付资产。
