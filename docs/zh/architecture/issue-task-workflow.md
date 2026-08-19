---
sidebar_position: 20
---

# Issue、任务与工作流编排

范围：Issue 的任务组织方式、推进方式、项目阶段 DAG、Issue 阶段快照、具体任务与执行记录的引用、依赖就绪判断、工作空间继承、动态投影和 Issue 状态聚合。

```mermaid
flowchart LR
    COMPOSER[Issue Composer<br/>紧凑输入 / 应用内全屏编辑] --> ISSUE
    COMPOSER --> ATTACHMENT[标题 / 正文 / 待上传附件]
    ATTACHMENT --> ISSUE
    EDITOR[阶段 DAG 编辑器] -->|新增 / 插入阶段| TEMPLATE[(项目 Orchestration Definition)]
    EDITOR -->|显式保存| PROJECT_API[ProjectSpace update API]
    PROJECT_API --> TEMPLATE
    TEMPLATE -->|重新进入时回填| EDITOR
    TEMPLATE --> SNAPSHOT[(Issue Orchestration Snapshot)]
    ISSUE[(LoopItem / Issue)] --> SNAPSHOT
    SNAPSHOT --> MODE{推进方式}
    MODE -->|用户管理| HUMAN[用户拆解与分配]
    MODE -->|AI 调度| AI[AI 读取 Issue、提示词与阶段定义]
    ISSUE --> ENTRY{收集箱拖到待开始}
    ENTRY -->|无阶段 + 手动推进| TASK_COMPOSER
    ENTRY -->|预置流程| START_READY[启动 ready 自动化阶段]
    ENTRY -->|AI 推进| AI
    START_READY --> STAGE
    SNAPSHOT --> GRAPH{是否设置阶段 DAG}
    GRAPH -->|无阶段| FREE[自由任务集合]
    GRAPH -->|有阶段| STAGE[Stage / Node / Milestone]
    STAGE --> EDGE[依赖边 / Context Contract]
    EDGE --> STAGE
    STAGE --> REQUIREMENT[必要交付物契约]
    HUMAN --> BINDING[(LoopItemTaskBinding)]
    AI --> BINDING
    FREE --> BINDING
    STAGE --> BINDING
    BINDING --> TASK_STATUS[按任务保存 Runtime 状态]
    TASK_STATUS --> STAGE
    ISSUE --> TASK_COMPOSER[右侧空白任务会话]
    TASK_COMPOSER -->|首条消息| BINDING
    BINDING -->|打开已有任务| SIDEBAR[右侧任务会话]
    BINDING --> TASK[(Wework Runtime Task)]
    TASK_COMPOSER --> CONTEXT[结构化 Issue 来源<br/>space_id + item_id]
    SIDEBAR --> CONTEXT
    CONTEXT --> TASK
    TASK --> GRANT[Session ContextGrant]
    GRANT --> SPACE_MCP[稳定 wework-space capability]
    SPACE_MCP --> ISSUE
    SPACE_MCP --> ATTACHMENT
    SPACE_MCP --> DELIVERY
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
    TASK --> DELIVERY[阶段交付物]
    REQUIREMENT --> DELIVERY
    DELIVERY --> REVIEW{人工验收}
    REVIEW -->|批准| AGGREGATE
    REVIEW -->|驳回| TASK
    REVIEW -->|强制推进 + 原因| AGGREGATE
    ACTIVITY --> STREAM[流式执行卡片 / Final 摘要 / 附件事件]
```

```mermaid
sequenceDiagram
    participant U as 用户
    participant C as Issue Composer
    participant G as 阶段 DAG 编辑器
    participant O as Orchestration 服务
    participant A as AI 调度员
    participant B as Task Binding
    participant E as Execution 服务
    participant R as Runtime scheduler
    participant M as project-space capability
    participant V as Delivery 服务
    participant H as 人工验收服务
    participant D as Issue 动态
    participant I as Issue 投影

    U->>C: 输入正文和附件
    opt 需要长内容编辑
        U->>C: 展开为应用内全屏编辑器
    end
    C->>O: 创建 Issue，并在创建后上传附件
    opt 在选中阶段前后快速插入阶段
        U->>G: 点击阶段连接点上的加号
        G->>G: 重连直接依赖并迁移对应边级上下文
    end
    U->>G: 点击保存编排
    G->>O: 更新项目 Orchestration Definition
    O-->>G: 返回已持久化定义与新项目版本
    opt 离开后重新进入自动化页
        G->>O: 从项目快照读取 Orchestration Definition
        O-->>G: 回填已保存推进方式、提示词和阶段 DAG
    end
    O->>O: 固化推进方式、提示词和可选阶段 DAG
    O->>O: 校验 DAG、边级上下文契约并计算 ready 阶段
    U->>O: 将 Issue 从收集箱拖到待开始
    alt 无阶段且手动推进
        O-->>U: 暂缓状态移动并打开新建任务 Composer
    else 预置流程或 AI 推进
        O->>O: 写入待开始并直接进入已配置编排
        O->>E: 预置流程启动全部 ready 自动化阶段
        O->>A: AI 推进启动已配置调度员
        Note over O,U: 不创建空白 Runtime Task，不打开新建任务 Composer
    end
    alt 用户管理
        U->>O: 在 Issue 详情点击新建任务
        O-->>U: 在右侧栏显示空白任务会话
        U->>B: 发送首条消息后创建具体任务，可选归入 ready 阶段
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
    B->>R: 每轮携带结构化 space_id 与 item_id
    R->>M: 以 ContextGrant 启用稳定 capability
    M-->>R: 返回 Issue 描述、附件与其他当前上下文
    R-->>D: 流式进度、终态与交付附件
    B-->>O: Runtime Task 状态变化
    E-->>O: execution 状态变化
    opt 人工阶段声明必要交付物
        U->>V: 按节点要求上传并提交交付物
        V->>O: 将 delivered Delivery 绑定到 workflow node
    end
    O->>O: 保存每个任务状态；运行优先，否则以最近任务终态聚合阶段
    alt 人工阶段满足验收前置条件
        O-->>U: 节点进入待批准
        U->>H: 批准 / 驳回 / 强制推进
        H->>O: 记录操作者、时间、原因和决定
    end
    O->>O: 仅批准、强制推进或自动阶段可信完成后解锁后继阶段
    O->>I: 聚合全部必要阶段与自由任务状态
```

| 边                                   | 代码归属                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------- |
| Issue Composer → Issue、草稿与附件   | Wework `IssueComposer`、ProjectSpace API；同一草稿在紧凑与全屏视图间共享  |
| 阶段 DAG 编辑与前后插入              | Wework `ProjectWorkflowEditor`                                            |
| 编排显式保存与重新进入回填           | Wework `ProjectAutomationView`、`ProjectWorkflowEditor`、ProjectSpace API |
| 项目编排定义与 Issue 快照            | Backend workflow schema/service；Wework 自动化页 DAG UI                   |
| 依赖边 → 后继阶段上下文              | Workflow node dependency context；Composer / automation instruction       |
| 用户管理 / AI 调度 → 具体任务        | 标准 Wework Composer、AI manager、`LoopItemTaskBinding`                   |
| Issue 新建任务 / 已有任务 → 右侧会话 | `CloudTodoWorkspace`、`TodoEditor`、`AiChatModal`                         |
| Runtime Task 绑定 → 阶段状态同步     | `projectSpaceSelection`、`WorkbenchProvider`、ProjectSpace API            |
| 阶段任务状态历史与最近终态聚合       | Wework `issueWorkflow`、`IssueWorkflowDag`、Issue workflow snapshot       |
| 节点交付物 → 人工验收与推进          | Delivery API、workflow decision service、`IssueWorkflowDag`               |
| Issue 看板入口 → 手动任务或编排      | `CloudTodoWorkspace`、`workItemTaskInput`、Issue workflow snapshot        |
| Issue 会话 → 项目空间当前上下文      | Runtime metadata、ContextGrant、内置 `wework-space` Plugin、Local Gateway |
| 阶段 → 自动化执行                    | `project_automation_execution.py`、`loop_item_executions/service.py`      |
| 工作空间与后继任务继承               | Runtime Task summary、Wework project work controls                        |
| DAG 就绪判断、阶段与 Issue 状态聚合  | Backend workflow service；本地 ProjectSpace 服务；Wework 实时投影         |
| 执行真值 → Issue 动态                | Project chat stream、Task activity cards、Delivery/attachment projection  |

不变量：

- `LoopItem` 是 Issue 和业务聚合容器，不是一次执行。
- Issue 创建的紧凑视图和应用内全屏视图必须编辑同一份正文和待上传附件；切换视图不得重建草稿、重复上传或改变“创建 Issue / 创建任务”语义。
- 应用内全屏编辑器必须覆盖当前看板工作区的左侧项目列表和右侧任务区域，同时保留顶层 38px Tab/标题栏，并在其余三边及标题栏下方使用标准内容边距。
- 应用内全屏编辑器的收起与关闭操作必须在标题栏右侧成组排列；正文与附件区域必须使用可用宽度，仅保留标准页面内边距，不得用固定窄宽度制造大面积无效留白。
- Issue 文本草稿按目标项目空间和创建模式持久化，待上传 `File` 只保存在当前应用进程内；普通关闭必须保留草稿，仅创建成功或用户显式清除时删除。
- Issue 创建不提供独立标题字段，紧凑视图与应用内全屏视图都必须通过既有默认规则从正文生成标题。附件继续通过既有 ProjectSpace 附件 API 在 Issue 创建后上传。
- Stage / Node / Milestone 是任务的逻辑分类和依赖节点，不是一次执行，也不是执行者类型。
- Wework Runtime Task、Wegent Task 和 `LoopItemExecution` 继续分别承担具体任务与执行真值；阶段只引用它们，不复制状态、工作目录、worktree、分支或队列字段。
- 阶段 DAG 与推进方式正交。用户管理和 AI 调度都可在“无阶段”或“有阶段”下工作。
- 依赖边既表示就绪约束，也定义前序阶段向后继阶段传递的上下文。Issue 基础信息始终传递；边只配置是否附加前序任务最终结果、交付附件和执行过程。
- 边级上下文策略属于后继节点对某个前置节点的输入声明；删除依赖时必须同时删除对应策略，不能留下悬空配置。
- 在阶段前后插入新阶段必须重连该方向上的全部直接依赖，并把被替换边的上下文策略迁移到语义等价的新边；不得丢失分支、产生悬空上下文或引入环。
- 编排编辑是本地草稿，只有用户触发清晰可见的“保存编排”主操作后才写入项目；保存成功必须使用服务端返回的定义与项目版本更新页面真值，离开后重新进入必须从项目持久化定义完整回填。
- AI 调度必须通过创建、指派和启动具体任务推进 Issue。有阶段时每个 AI 创建的任务必须归入一个阶段，并遵守该阶段依赖；无阶段时 AI 可根据 Issue 和提示词自由拆解。
- Issue 从“收集箱”拖到“待开始”时，任务入口必须读取该 Issue 的编排快照。仅“无阶段 + 手动推进”属于自己管理任务，需暂缓移动并打开新建任务 Composer；预置流程必须直接写入“待开始”并启动全部 ready 的自动化阶段，AI 推进必须启动快照绑定的调度员。两者都不得打开新建任务 Composer，也不得为绕过弹窗而创建空白 Runtime Task；重复进入不得为同一阶段或 AI 调度员创建重复运行。
- 预置流程中的人工阶段由用户显式开始。Issue 详情必须在缩放流程图之外展示所有 ready 人工阶段的主操作，明确标注“人工执行”并提供“开始处理”；流程图只承担结构与进度展示，不能把唯一入口藏在会缩放的节点内部。点击“开始处理”只打开绑定该阶段的任务 Composer，首条消息发送前仍不得创建空白 Runtime Task。
- 人工阶段的 Runtime Task 创建后，只先写入 `LoopItemTaskBinding`。Runtime Task 云上下文必须返回该绑定的 `workflow_node_id`，绑定完成必须触发已知 Runtime 生命周期重放；不得把人工任务写成 `LoopItemExecution` 的 queued 状态，也不得在 Runtime 尚未确认 running 时由 UI 伪造“排队中”或“进行中”。
- 人工阶段状态机是 `blocked → ready → running → awaiting_approval → completed`。`awaiting_approval` 只阻止进入后续阶段，不得阻止当前阶段继续创建人工任务以修正结果或补交交付物；驳回进入 `changes_requested`，并允许继续原任务或创建新任务。强制推进进入 `forced_completed`。`queued` 仅用于已经创建真实自动化执行且等待 Runtime 容量的自动阶段，不得用于未执行的人工阶段。
- 节点可声明零个或多个带稳定 ID 和值类型的必要交付物。任务 Composer 和 Issue 详情必须明示这些要求及履约方法；提交的 Delivery 必须通过来源 TaskBinding 归属到唯一 `workflow_node_id`，并逐项绑定 `requirement_id`。未满足必要交付物时不得批准，但允许具有权限的用户填写原因后强制推进；完整生命周期见 [工作流阶段交付与依赖上下文](workflow-stage-deliverables.md)。
- 绑定 Issue 阶段的 Agent 必须能通过统一 `wework-space` MCP 完成与用户相同的 Delivery 创建、附件上传与下载、读取、提交和草稿丢弃；写操作必须从 ContextGrant 的 Runtime 地址解析来源 TaskBinding，不得接受模型指定的阶段归属。
- 每个阶段任务的 Runtime 状态必须按稳定的 `device_id:task_id` 写入 `task_statuses`，Issue 详情必须逐条展示，不得只展示阶段汇总状态。
- 阶段存在任一运行中任务时状态为 `running`；否则由最近绑定任务的可信终态决定当前阶段结果。后续成功必须覆盖旧失败对阶段汇总状态的影响，但旧任务失败状态仍保留在任务历史中。Issue 详情展示和人工决策校验必须从任务真值重算阶段，不得信任可能滞后的阶段快照。人工阶段成功后只能进入 `awaiting_approval`，不能自动完成。
- 只有用户批准或带原因强制推进后，后继节点才可解锁；驳回必须保留任务、交付物和历史决定，不得回滚或覆盖审计记录。
- 节点决定必须记录 action、actor user id、reason 和 timestamp。强制推进必须填写非空原因；普通批准可选备注；驳回必须填写原因。
- Issue 详情必须同时提供已有任务重入、交付物上传、批准、驳回和强制推进入口。节点内任务行是稳定重入入口，关闭右侧会话后仍可再次打开。
- Issue 详情中的“新建任务”只打开与已有任务会话同位置的右侧空白 Composer；首条消息发送前不得创建 Runtime Task 或 `LoopItemTaskBinding`。
- 从 Issue 发起或继续的每一轮 Runtime 对话都必须携带结构化 `space_id` 与 `item_id`，并转换为会话隔离的 ContextGrant。不得按任务动态注入完整 MCP Server 配置，也不得只依赖自然语言提示词或 `cloud://` 文本探测；具体能力生命周期见 [项目空间 Agent 能力](project-space-agent-capability.md)。
- 一个 Issue 可以绑定多个异构任务，一个阶段也可聚合多个具体任务。任务仍可在 Wework 任务列表中找到。
- 阶段自动化只决定何时、如何创建或启动具体执行，不是与“任务”并列的实体类型。
- `inherit` 只从明确的前驱 Runtime Task 读取已确认的 workspace/worktree/branch；没有可继承来源时必须回到标准 Composer 选择，不得猜测目录。
- queued、待审批或依赖未满足只投影为“待开始”；只有 Runtime 确认 running 才投影为“进行中”。
- 自动阶段完成由阶段内执行的可信终态聚合得到；人工阶段完成还必须经过批准或强制推进。Issue 完成由全部必要阶段和自由任务聚合得到。任一单个任务或交付物完成不得直接完成仍有未验收工作的阶段或 Issue。
- DAG 必须无环；任务归入阶段前，该阶段必须存在；阶段开始前依赖必须全部满足；边级上下文只能引用直接前置阶段；UI 不得直接写 running。
- Issue“动态”是执行过程的统一投影。流式卡片只展示 Runtime 真值的紧凑摘要；完成后展示 final content 摘要；附件事件引用真实交付资产。
