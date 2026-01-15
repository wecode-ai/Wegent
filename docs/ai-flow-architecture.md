# AI Flow 智能流 - 架构设计文档

> 本文档描述 Wegent 项目中 AI Flow（智能流）功能的完整架构设计、流程图和 UML 图。

---

## 目录

1. [功能概述](#功能概述)
2. [目录结构](#目录结构)
3. [系统架构图](#系统架构图)
4. [数据流程图](#数据流程图)
5. [类图 (UML)](#类图-uml)
6. [时序图](#时序图)
7. [状态图](#状态图)
8. [API 端点](#api-端点)
9. [触发类型配置](#触发类型配置)
10. [模板变量](#模板变量)

---

## 功能概述

AI Flow 是一个自动化任务调度和执行系统，允许用户创建定时工作流来触发 AI Agent 任务。该功能以 Twitter/微博风格的社交媒体信息流展示 AI Agent 的活动，使 AI 自动化变得直观易用。

### 核心能力

- **多种触发方式**：支持 Cron 定时、间隔执行、一次性执行、Webhook/Git Push 事件触发
- **模板变量**：Prompt 模板支持动态变量替换（日期、时间、Webhook 数据等）
- **执行追踪**：完整的执行记录和状态追踪
- **分布式调度**：支持多实例部署的分布式锁机制

---

## 目录结构

```
Wegent/
├── frontend/
│   └── src/
│       ├── features/flows/
│       │   ├── components/
│       │   │   ├── FlowPage.tsx          # 主页面组件
│       │   │   ├── FlowList.tsx          # Flow 配置列表
│       │   │   ├── FlowTimeline.tsx      # Twitter 风格执行记录
│       │   │   ├── FlowForm.tsx          # 创建/编辑对话框
│       │   │   ├── CronSchedulePicker.tsx # Cron 表达式选择器
│       │   │   └── index.ts              # 组件导出
│       │   └── contexts/
│       │       └── flowContext.tsx        # React Context 状态管理
│       ├── apis/
│       │   └── flow.ts                    # API 客户端
│       ├── types/
│       │   └── flow.ts                    # TypeScript 类型定义
│       └── i18n/locales/
│           ├── en/flow.json               # 英文翻译
│           └── zh/flow.json               # 中文翻译
│
├── backend/
│   └── app/
│       ├── models/
│       │   └── flow.py                    # SQLAlchemy ORM 模型
│       ├── schemas/
│       │   └── flow.py                    # Pydantic Schemas (CRD 风格)
│       ├── services/
│       │   ├── flow.py                    # 核心 Flow 服务
│       │   ├── flow_scheduler.py          # 后台调度器
│       │   └── chat/trigger/
│       │       └── emitter.py             # 事件发射器
│       ├── api/endpoints/adapter/
│       │   └── flows.py                   # FastAPI REST 端点
│       └── tests/api/endpoints/
│           └── test_flows.py              # API 端点测试
│
└── backend/alembic/versions/
    └── q7r8s9t0u1v2_add_flow_tables.py    # 数据库迁移
```

---

## 系统架构图

```mermaid
flowchart TB
    subgraph Frontend["🖥️ 前端 Frontend"]
        direction TB
        FP["FlowPage.tsx<br/>主页面入口"]
        FT["FlowTimeline.tsx<br/>Twitter风格执行记录"]
        FL["FlowList.tsx<br/>Flow配置管理"]
        FF["FlowForm.tsx<br/>创建/编辑表单"]
        CP["CronSchedulePicker.tsx<br/>Cron表达式选择器"]
        FC["flowContext.tsx<br/>React Context状态管理"]
        FAPI["flow.ts<br/>API客户端"]
    end

    subgraph Backend["⚙️ 后端 Backend"]
        direction TB
        EP["flows.py<br/>REST API端点"]
        SVC["FlowService<br/>核心业务逻辑"]
        SCH["flow_scheduler_worker<br/>后台定时调度器"]
        EMT["FlowEventEmitter<br/>执行状态事件发射器"]
    end

    subgraph Database["💾 数据层 Database"]
        direction TB
        FR[("FlowResource<br/>flows表")]
        FE[("FlowExecution<br/>flow_executions表")]
    end

    subgraph External["🔗 外部集成"]
        WH["Webhook触发"]
        TS["Task System<br/>任务系统"]
        CS["Chat System<br/>聊天系统"]
        CACHE["Cache Manager<br/>分布式锁"]
    end

    FP --> FC
    FT --> FC
    FL --> FC
    FF --> FC
    FF --> CP
    FC --> FAPI

    FAPI -->|"HTTP REST"| EP
    EP --> SVC
    SVC --> FR
    SVC --> FE
    SCH -->|"定时查询到期Flow"| SVC
    SCH --> EMT
    SCH --> CACHE
    EMT -->|"更新执行状态"| FE

    SVC -->|"创建Task"| TS
    SVC -->|"触发AI响应"| CS
    WH -->|"POST /webhook/{token}"| EP
```

---

## 数据流程图

```mermaid
flowchart TD
    subgraph Create["📝 创建Flow"]
        U1["用户填写FlowForm"] --> V1["前端验证"]
        V1 --> API1["POST /api/flows"]
        API1 --> SVC1["FlowService.create_flow()"]
        SVC1 --> CRD["构建CRD JSON结构"]
        CRD --> CALC["计算next_execution_time"]
        CALC --> DB1[("保存FlowResource")]
    end

    subgraph Schedule["⏰ 定时调度"]
        SCH1["flow_scheduler_worker<br/>每分钟运行"] --> LOCK["获取分布式锁"]
        LOCK --> QUERY["查询到期的Flows<br/>next_execution_time <= now"]
        QUERY --> EXEC["execute_flow()"]
    end

    subgraph Execute["🚀 执行流程"]
        EXEC --> CREATE_EXE["创建FlowExecution记录<br/>状态: PENDING"]
        CREATE_EXE --> RESOLVE["解析Prompt模板<br/>替换变量 {{date}}, {{time}}"]
        RESOLVE --> TASK["创建Task"]
        TASK --> TYPE{"任务类型?"}
        TYPE -->|"Chat Shell"| CHAT["触发AI聊天响应"]
        TYPE -->|"Executor"| EXECUTOR["executor_manager执行"]
        CHAT --> STREAM["流式AI响应"]
        EXECUTOR --> SUBTASK["执行子任务"]
    end

    subgraph Complete["✅ 完成处理"]
        STREAM --> EMIT["FlowEventEmitter<br/>emit_chat_done()"]
        SUBTASK --> EMIT
        EMIT --> UPDATE["更新FlowExecution<br/>状态: COMPLETED/FAILED"]
        UPDATE --> NEXT["计算下次执行时间"]
        NEXT --> DB2[("更新FlowResource<br/>next_execution_time")]
    end

    subgraph Trigger["🔔 手动/Webhook触发"]
        MANUAL["用户点击 Run Now"] --> API2["POST /api/flows/{id}/trigger"]
        WEBHOOK["外部系统"] --> API3["POST /api/flows/webhook/{token}"]
        API2 --> TRIGGER["FlowService.trigger_flow_manually()"]
        API3 --> TRIGGER
        TRIGGER --> CREATE_EXE
    end

    DB1 -.-> SCH1
    DB2 -.-> SCH1
```

---

## 类图 (UML)

```mermaid
classDiagram
    direction TB

    class Flow {
        <<CRD Schema>>
        +String apiVersion
        +String kind
        +FlowMetadata metadata
        +FlowSpec spec
        +FlowStatus status
    }

    class FlowMetadata {
        +String name
        +String namespace
        +Dict labels
        +Dict annotations
    }

    class FlowSpec {
        +String task_type
        +String team_id
        +String prompt_template
        +FlowTriggerType trigger_type
        +Dict trigger_config
        +FlowRetryConfig retry_config
    }

    class FlowStatus {
        +Bool enabled
        +DateTime last_execution_time
        +DateTime next_execution_time
        +Int execution_count
        +Int success_count
        +Int failure_count
    }

    class FlowResource {
        <<SQLAlchemy Model>>
        +UUID id
        +UUID user_id
        +String kind
        +String name
        +String namespace
        +JSON json
        +Bool enabled
        +String trigger_type
        +UUID team_id
        +String webhook_token
        +DateTime next_execution_time
        +Int execution_count
    }

    class FlowExecution {
        <<SQLAlchemy Model>>
        +UUID id
        +UUID user_id
        +UUID flow_id
        +UUID task_id
        +String trigger_type
        +String trigger_reason
        +String prompt
        +FlowExecutionStatus status
        +String result_summary
        +String error_message
        +Int retry_attempt
        +DateTime started_at
        +DateTime completed_at
    }

    class FlowService {
        <<Service>>
        +create_flow(user_id, flow)
        +get_flow(flow_id)
        +list_flows(user_id, filters)
        +update_flow(flow_id, flow)
        +delete_flow(flow_id)
        +toggle_flow(flow_id, enabled)
        +trigger_flow_manually(flow_id)
        +trigger_flow_by_webhook(token, payload)
        +list_executions(filters)
        +update_execution_status(exec_id, status)
        -_resolve_prompt_template(template, variables)
        -_calculate_next_execution_time(trigger)
        -_create_execution(flow, trigger_reason)
    }

    class FlowSchedulerWorker {
        <<Background Worker>>
        +start()
        +stop()
        -_run_scheduler_loop()
        -_acquire_lock()
        -_get_due_flows()
        -_execute_flow(flow)
    }

    class FlowEventEmitter {
        <<Event Emitter>>
        +emit_chat_done(execution_id, result)
        +emit_chat_error(execution_id, error)
        +emit_status_update(execution_id, status)
    }

    class FlowTriggerType {
        <<Enumeration>>
        CRON
        INTERVAL
        ONE_TIME
        EVENT
    }

    class FlowExecutionStatus {
        <<Enumeration>>
        PENDING
        RUNNING
        COMPLETED
        FAILED
        RETRYING
        CANCELLED
    }

    Flow *-- FlowMetadata
    Flow *-- FlowSpec
    Flow *-- FlowStatus
    FlowSpec --> FlowTriggerType
    FlowResource ..> Flow : serializes
    FlowExecution --> FlowExecutionStatus
    FlowExecution --> FlowResource : belongs to
    FlowService --> FlowResource : manages
    FlowService --> FlowExecution : creates
    FlowSchedulerWorker --> FlowService : uses
    FlowSchedulerWorker --> FlowEventEmitter : uses
    FlowEventEmitter --> FlowExecution : updates
```

---

## 时序图

### 定时调度执行流程

```mermaid
sequenceDiagram
    autonumber
    participant SCH as FlowSchedulerWorker
    participant CACHE as CacheManager
    participant SVC as FlowService
    participant DB as Database
    participant TASK as TaskSystem
    participant CHAT as ChatSystem
    participant EMT as FlowEventEmitter

    loop 每60秒
        SCH->>CACHE: acquire_flow_scheduler_lock()
        alt 获取锁成功
            CACHE-->>SCH: lock acquired
            SCH->>SVC: get_due_flows()
            SVC->>DB: SELECT * FROM flows WHERE enabled=true AND next_execution_time <= now
            DB-->>SVC: due_flows[]

            loop 对每个到期的Flow
                SCH->>SVC: execute_flow(flow)
                SVC->>DB: INSERT FlowExecution (status=PENDING)
                DB-->>SVC: execution_id
                SVC->>SVC: _resolve_prompt_template()
                Note over SVC: 替换 {{date}}, {{time}}, {{flow_name}} 等变量

                SVC->>TASK: task_kinds_service.create_task_or_append()
                TASK-->>SVC: task_id
                SVC->>DB: UPDATE FlowExecution SET task_id, status=RUNNING

                alt Chat Shell 类型
                    SVC->>CHAT: _trigger_chat_shell_response()
                    CHAT->>CHAT: 流式AI响应生成
                    CHAT->>EMT: emit_chat_done(execution_id, result)
                else Executor 类型
                    SVC->>TASK: 等待executor_manager处理
                    TASK->>EMT: emit_status_update(execution_id)
                end

                EMT->>DB: UPDATE FlowExecution SET status=COMPLETED/FAILED
                SVC->>SVC: _calculate_next_execution_time()
                SVC->>DB: UPDATE FlowResource SET next_execution_time
            end

            SCH->>CACHE: release_lock()
        else 锁被占用
            CACHE-->>SCH: lock not acquired
            Note over SCH: 跳过本次调度周期
        end
    end
```

---

## 状态图

### FlowExecution 状态转换

```mermaid
stateDiagram-v2
    [*] --> PENDING: 创建执行记录

    PENDING --> RUNNING: 开始执行任务
    PENDING --> CANCELLED: 用户取消

    RUNNING --> COMPLETED: 执行成功
    RUNNING --> FAILED: 执行失败
    RUNNING --> CANCELLED: 用户取消

    FAILED --> RETRYING: 重试 (retry_attempt < max_retries)
    RETRYING --> RUNNING: 重新执行
    RETRYING --> FAILED: 重试次数耗尽

    COMPLETED --> [*]
    FAILED --> [*]
    CANCELLED --> [*]

    note right of PENDING
        初始状态
        等待调度器执行
    end note

    note right of RUNNING
        AI正在处理
        实时更新进度
    end note

    note right of COMPLETED
        执行成功
        记录result_summary
    end note

    note right of FAILED
        执行失败
        记录error_message
    end note
```

---

## API 端点

| 方法 | 端点 | 描述 |
|------|------|------|
| GET | `/api/flows` | 获取用户的 Flow 列表（分页） |
| POST | `/api/flows` | 创建新 Flow |
| GET | `/api/flows/{id}` | 获取指定 Flow 详情 |
| PUT | `/api/flows/{id}` | 更新 Flow |
| DELETE | `/api/flows/{id}` | 软删除 Flow |
| POST | `/api/flows/{id}/toggle` | 启用/禁用 Flow |
| POST | `/api/flows/{id}/trigger` | 手动触发执行 |
| GET | `/api/flows/executions` | 获取执行记录列表（时间线） |
| GET | `/api/flows/executions/{id}` | 获取执行记录详情 |
| POST | `/api/flows/webhook/{token}` | Webhook 触发（无需认证） |

---

## 触发类型配置

### Cron 触发

```json
{
  "trigger_type": "cron",
  "trigger_config": {
    "expression": "0 9 * * *",
    "timezone": "UTC"
  }
}
```

### 间隔触发

```json
{
  "trigger_type": "interval",
  "trigger_config": {
    "value": 2,
    "unit": "hours"
  }
}
```

支持的单位：`minutes` | `hours` | `days`

### 一次性触发

```json
{
  "trigger_type": "one_time",
  "trigger_config": {
    "execute_at": "2025-01-15T10:00:00Z"
  }
}
```

### 事件触发

```json
{
  "trigger_type": "event",
  "trigger_config": {
    "event_type": "webhook"
  }
}
```

支持的事件类型：`webhook` | `git_push`

---

## 模板变量

Prompt 模板支持以下变量替换：

| 变量 | 说明 | 示例值 |
|------|------|--------|
| `{{date}}` | 当前日期 | `2025-01-15` |
| `{{time}}` | 当前时间 | `10:30:00` |
| `{{datetime}}` | 当前日期时间 | `2025-01-15 10:30:00` |
| `{{timestamp}}` | Unix 时间戳 | `1736937000` |
| `{{flow_name}}` | Flow 显示名称 | `每日报告` |
| `{{webhook_data}}` | Webhook 载荷（JSON） | `{"event": "push"}` |

### 使用示例

```
请根据 {{date}} 的数据生成日报。
当前时间：{{datetime}}
Flow 名称：{{flow_name}}
```

---

## 关键技术点

1. **CRD 风格数据模型**：借鉴 Kubernetes CRD 设计，使用 `apiVersion`、`kind`、`metadata`、`spec`、`status` 结构

2. **分布式锁**：使用 CacheManager 实现分布式锁，确保多实例部署时只有一个调度器实例运行

3. **事件发射器**：FlowEventEmitter 继承 NoOpEventEmitter，在 AI 聊天完成/失败时更新执行状态

4. **模板解析**：支持动态变量替换，Webhook 触发时可注入外部数据

5. **增量调度**：使用 `next_execution_time` 字段进行高效查询，避免全表扫描

---

## 集成点

1. **API Router**：在 `/api/flows` 注册，位于 `backend/app/api/api.py`

2. **后台任务**：通过 `start_flow_scheduler()` 和 `stop_flow_scheduler()` 管理调度器生命周期

3. **任务系统**：通过 `task_kinds_service.create_task_or_append()` 创建 Task

4. **聊天系统**：Chat Shell 类型的 Team 通过聊天触发系统触发 AI 响应
