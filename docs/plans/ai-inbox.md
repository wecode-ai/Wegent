---
sidebar_position: 1
---

# Inbox AI 化

## 概述

本文档定义 Inbox 的第一期 AI 化方案。

目标是让外部内容可以通过接口进入 Wegent Inbox，并在消息进入队列后，由队列绑定的订阅器自动触发对应智能体进行处理。第一期重点支持“自动知识库管理”，包括内容分类、摘要整理、URL 解析和知识库入库。

本方案遵循以下边界：

- `Inbox / WorkQueue` 负责接收内容、保存消息和展示处理状态
- `Subscription` 负责自动触发、重试和执行编排
- `Team` 负责具体 AI 处理能力
- `Knowledge Base` 是 Team 可调用的能力，不直接绑定在 Inbox 上

## 背景与问题

当前系统已经具备以下基础能力：

- Inbox 已支持 `WorkQueue` 和 `QueueMessage` 模型，可用于收件和手动处理
- `WorkQueue.spec.autoProcess` 已预留自动处理配置骨架
- Subscription 已支持定时和事件驱动执行，但事件类型目前仅覆盖 `webhook` 和 `git_push`
- Team 已具备执行 AI 任务的完整链路
- Knowledge Base 已具备文档创建、URL 抓取建文档和索引能力

当前缺失的关键能力有：

- 对外的标准 Inbox 写入接口
- QueueMessage 创建后自动触发 Subscription 的运行时闭环
- 适用于 Inbox 场景的 Subscription 事件模型
- Inbox 消息与后台执行结果之间的状态回写机制

## 设计目标

第一期设计目标如下：

- 提供标准接口将内容写入指定 Inbox 队列
- 支持队列绑定订阅器，而不是直接绑定 Team 或知识库
- 收到消息后立即自动处理
- 由 Subscription 内部引用的 Team 承担“自动知识库管理”能力
- Inbox UI 可展示处理状态、处理结果和失败信息
- 保证幂等、可重试和运行态可追踪

非目标如下：

- 不在第一期引入多个订阅器并行消费同一队列
- 不在 Inbox 内内置知识库分类规则
- 不引入新的通用工作流引擎
- 不在第一期支持复杂条件触发 UI

## 总体架构

第一期整体链路如下：

```text
External API / Internal Forwarding / Channel Message
  -> QueueMessage created
  -> WorkQueue.spec.autoProcess matched
  -> Subscription triggered by inbox message event
  -> Subscription executes Team
  -> Team processes content and writes KB artifacts
  -> Result written back to QueueMessage
```

系统职责拆分如下：

### Inbox / WorkQueue

负责：

- 创建和管理队列
- 存储收件消息
- 存储自动处理配置
- 展示消息处理状态和结果

不负责：

- 执行 AI 逻辑
- 决定知识库入库策略
- 直接调用 Team

### Subscription Runtime

负责：

- 监听 Inbox 消息创建事件
- 校验队列自动处理配置
- 查找并触发绑定的订阅器
- 管理执行生命周期、失败和重试

### Team Capability Layer

负责：

- 理解 Inbox 消息内容
- 提取主题、标签和摘要
- 识别 URL 并执行额外处理
- 将整理结果写入知识库
- 返回结构化处理结果

## 数据模型设计

### WorkQueue.spec.autoProcess

第一期继续使用 `WorkQueue.spec.autoProcess` 承载自动处理配置，不新增独立绑定模型。

建议结构如下：

```json
{
  "autoProcess": {
    "enabled": true,
    "subscriptionRef": {
      "namespace": "default",
      "name": "kb-ingest-subscription",
      "userId": 123
    },
    "triggerMode": "immediate"
  }
}
```

字段说明：

- `enabled`
  是否启用自动处理
- `subscriptionRef`
  订阅器引用，必须使用 `namespace + name + userId` 三元组
- `triggerMode`
  第一期固定支持 `immediate`

### 为什么 subscriptionRef 必须是三元组

本项目中 Kind 资源的唯一标识是：

- `namespace`
- `name`
- `user_id`

因此 `subscriptionRef` 必须与现有 CRD 唯一标识规则一致，否则在共享订阅器、同名订阅器或跨用户场景下会出现歧义。

后端查找订阅器时必须按以下条件检索：

- `Kind.kind == "Subscription"`
- `Kind.namespace == subscriptionRef.namespace`
- `Kind.name == subscriptionRef.name`
- `Kind.user_id == subscriptionRef.userId`

### QueueMessage 运行时字段

第一期建议在 `QueueMessage` 上补齐自动处理运行态字段。

已有或应扩展字段如下：

- `status`
  - `unread`
  - `processing`
  - `processed`
  - `failed`
  - `archived`
- `process_subscription_id`
  触发本次自动处理的订阅器 ID
- `process_task_id`
  本次自动处理关联的 Task ID
- `process_result`
  结构化执行结果
- `process_error`
  执行失败时的错误信息
- `processing_started_at`
  开始处理时间
- `processed_at`
  处理完成时间
- `retry_count`
  重试次数

其中 `process_result` 建议使用结构化 JSON，便于 UI 展示和后续分析。

## Subscription 模型扩展

当前 `SubscriptionEventType` 仅支持：

- `webhook`
- `git_push`

第一期需要扩展为支持：

- `inbox_message`

建议新增事件类型枚举值：

```python
class SubscriptionEventType(str, Enum):
    WEBHOOK = "webhook"
    GIT_PUSH = "git_push"
    INBOX_MESSAGE = "inbox_message"
```

对于 Inbox 自动处理订阅器：

- `trigger.type = event`
- `trigger.event.event_type = inbox_message`

这使得 Inbox 自动处理在模型层面是 Subscription 的正式事件触发类型，而不是隐藏逻辑。

## 事件与执行流程

### 1. 消息写入 Inbox

外部系统或内部模块调用标准 Inbox 写入接口，将消息写入指定队列。

创建 `QueueMessage` 后：

- 初始状态设置为 `unread`
- 发布内部事件 `queue_message.created`

### 2. Subscription 触发

Inbox 自动处理调度器收到 `queue_message.created` 后：

1. 根据 `queue_id` 查找所属 `WorkQueue`
2. 读取 `spec.autoProcess`
3. 校验以下条件：
   - `enabled == true`
   - 存在 `subscriptionRef`
   - `triggerMode == immediate`
4. 按三元组查找目标 `Subscription`
5. 校验订阅器：
   - 订阅器存在
   - 订阅器可访问
   - 订阅器已启用
   - 订阅器触发类型为 `event/inbox_message`
6. 将 `QueueMessage.status` 更新为 `processing`
7. 创建一次 Subscription 执行

### 3. Team 执行

Subscription 内部通过 `teamRef` 找到目标 Team，并使用统一执行链路创建 Task。

Team 获取标准化的 Inbox 输入后执行具体能力，包括：

- 文本理解
- 主题分类
- URL 提取和网页抓取
- 内容摘要
- 知识库入库

### 4. 结果回写

执行完成后回写 `QueueMessage`：

- 成功：
  - `status = processed`
  - 写入 `process_result`
  - 写入 `process_subscription_id`
  - 写入 `process_task_id`
  - 写入 `processed_at`
- 失败：
  - `status = failed`
  - 写入 `process_error`
  - 增加 `retry_count`

## Subscription 输入协议

为避免订阅器自行拼装上下文，Inbox 触发层应统一构造标准输入。

建议输入结构包含：

```json
{
  "trigger": {
    "source": "inbox",
    "event": "message.created"
  },
  "queue": {
    "id": 1,
    "name": "inbox",
    "displayName": "Inbox"
  },
  "message": {
    "id": 1001,
    "status": "processing",
    "priority": "normal",
    "note": "",
    "createdAt": "2026-04-09T10:00:00Z"
  },
  "sender": {
    "id": 123,
    "userName": "alice",
    "email": "alice@example.com"
  },
  "contentSnapshot": [],
  "attachments": [],
  "detectedUrls": [],
  "executionContext": {
    "triggeredBy": "auto_process",
    "retryCount": 0,
    "processSubscriptionRef": {
      "namespace": "default",
      "name": "kb-ingest-subscription",
      "userId": 123
    }
  }
}
```

设计原则：

- Inbox 只负责提供标准化上下文
- Subscription 负责把上下文交给 Team
- Team 决定业务动作，不要求 Inbox 理解业务细节

## 第一期开箱能力：自动知识库管理

第一期通过专门的 `Subscription + Team` 组合提供自动知识库管理能力。

该 Team 的职责包括：

- 判断消息是否适合入知识库
- 对消息进行分类和结构化整理
- 从正文中提取 URL
- 在需要时调用现有网页抓取能力
- 将处理后的内容写入目标知识库
- 返回结构化结果

### 知识库配置边界

知识库目标、允许写入的范围、是否抓取 URL 等配置均由订阅器或 Team 决定，不由 Inbox 承担。

这样可以保证：

- Inbox 模型保持稳定
- 后续扩展其他 AI 场景时无需修改 Inbox 结构
- 自动知识库管理只是 Team 能力的一种实现

### Team 输出契约

建议第一期 Team 返回统一结构：

```json
{
  "success": true,
  "summary": "Message categorized and stored in knowledge base",
  "actions": [
    "extract_urls",
    "scrape_web_pages",
    "create_documents"
  ],
  "knowledgeBaseIds": [11],
  "documentIds": [201, 202],
  "extractedUrls": ["https://example.com/article"],
  "skippedReason": null,
  "error": null
}
```

说明：

- `success`
  表示订阅执行是否成功
- `summary`
  面向 UI 的摘要
- `actions`
  实际执行的动作列表
- `knowledgeBaseIds`
  写入的知识库 ID 列表
- `documentIds`
  生成的文档 ID 列表
- `extractedUrls`
  从内容中提取出的 URL 列表
- `skippedReason`
  若主动跳过处理，记录原因
- `error`
  失败信息

## API 设计

### 1. Inbox 写入接口

第一期新增正式收件接口，不复用当前转发消息接口。

建议接口：

```text
POST /api/work-queues/{queue_id}/messages/ingest
```

建议请求体：

```json
{
  "content": "message content",
  "title": "optional title",
  "note": "optional note",
  "sender": {
    "externalId": "crm-123",
    "displayName": "CRM System"
  },
  "attachments": [],
  "source": {
    "type": "api",
    "name": "crm"
  },
  "idempotencyKey": "unique-key"
}
```

要求：

- 支持外部来源，不要求一定是 Wegent 用户
- 支持幂等键，避免重复入队
- 支持文本和附件

### 2. WorkQueue 配置接口

继续复用现有创建/更新接口，只扩展 `autoProcess` 结构：

- 创建队列：`POST /api/work-queues`
- 更新队列：`PUT /api/work-queues/{queue_id}`

### 3. QueueMessage 重试接口

建议新增手动重试接口：

```text
POST /api/queue-messages/{message_id}/retry
```

行为：

- 校验消息归属
- 校验队列已绑定可用订阅器
- 将消息重新投递到自动处理调度器

## 前端设计

### Inbox 队列配置

在 Inbox 队列编辑页中增加：

- 自动处理开关
- 订阅器选择器
- 触发模式选择器

第一期 UI 只开放：

- 启用/停用自动处理
- 选择一个订阅器
- `triggerMode = immediate`

### Inbox 消息列表与详情

需要展示：

- 消息处理状态
- 关联订阅器
- 处理摘要
- 关联 Task
- 失败原因
- 重试入口

### Subscription 创建与编辑

Subscription 配置页需要支持创建 `event/inbox_message` 类型订阅器。

## 可靠性设计

### 幂等

同一个 `idempotencyKey` 不能重复创建消息。

### 单消息单执行

同一条 `QueueMessage` 在同一时刻只能有一个自动处理执行在跑。

### 重复事件保护

重复投递的 `queue_message.created` 事件不能导致重复创建执行。

### 可重试

失败消息允许用户手动重试。

### 配置校验

保存配置和运行时触发时都需要校验：

- 订阅器是否存在
- 是否可访问
- 是否启用
- 是否为 `event/inbox_message`

## 错误处理

### 配置阶段错误

以下情况在保存队列配置时直接返回错误：

- `subscriptionRef` 缺少三元组字段
- 订阅器不存在
- 当前用户无权使用该订阅器
- 订阅器事件类型不是 `inbox_message`

### 运行阶段错误

以下情况写入 `QueueMessage.process_error`：

- 调度器触发失败
- Team 执行失败
- URL 抓取失败
- 知识库写入失败

失败后消息状态置为 `failed`，并保留重试入口。

## 测试方案

### 后端单元测试

- `autoProcess.subscriptionRef` 三元组校验
- `queue_message.created` 触发订阅执行
- 重复事件不重复执行
- 成功/失败回写 QueueMessage
- 非法订阅器配置校验

### 后端集成测试

- 调用 ingest 接口创建 Inbox 消息
- 自动触发 Subscription
- Subscription 通过 Team 执行
- 结果回写到 QueueMessage

### 前端测试

- 队列配置表单的自动处理选项
- 订阅器选择和保存
- 消息状态展示
- 失败重试入口

## 迁移与落地顺序

建议按以下顺序实施：

1. 扩展 Subscription 事件类型，增加 `inbox_message`
2. 扩展 `WorkQueue.spec.autoProcess` 的 `subscriptionRef`
3. 增加 Inbox 写入接口
4. 实现 `queue_message.created` -> Subscription 调度链路
5. 实现 QueueMessage 结果回写
6. 接入第一期自动知识库管理 Team
7. 补齐 Inbox UI 状态展示和重试入口

## 风险与取舍

### 为什么不单独建绑定表

独立绑定表长期更灵活，但第一期会增加数据模型和迁移复杂度。当前产品心智明确为“队列绑定订阅器”，因此第一期直接放入 `WorkQueue.spec.autoProcess` 更合适。

### 为什么不让 Inbox 直接绑定 Team

因为自动化运行态属于 Subscription 领域，触发、重试、执行记录和后续扩展都应统一落在 Subscription 体系中。

### 为什么知识库不放在 Inbox 配置中

因为知识库整理只是某一类 Team 能力。若将知识库字段固化到 Inbox 中，后续扩展其他 AI 处理能力时会污染 Inbox 模型。

## 结论

第一期 Inbox AI 化采用以下原则：

- 队列通过 `WorkQueue.spec.autoProcess` 绑定订阅器
- 订阅器引用必须使用 `namespace + name + userId` 三元组
- QueueMessage 创建后通过 `inbox_message` 事件触发 Subscription
- Subscription 通过 Team 完成具体 AI 能力
- 自动知识库管理作为第一期落地能力，由 Team 完成而非 Inbox 内置

该方案改动面可控，边界清晰，并与现有 Subscription、Team、Knowledge Base 体系保持一致。