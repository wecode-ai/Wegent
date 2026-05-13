---
sidebar_position: 3
---

# 前端消息队列设计

## 背景

当前聊天页在模型输出过程中会把输入发送能力锁住。用户必须等当前回答结束，才能输入并发送下一个问题。

用户希望前端支持消息队列：模型输出时仍然可以输入下一个问题，点击发送后进入前端队列，并在当前回答结束后自动发送。

## 当前状态

现有前端消息链路集中在以下模块：

- `ChatArea` 编排聊天页输入区、消息区和任务状态
- `useChatStreamHandlers` 负责构建发送参数、调用 `ChatStreamContext.sendMessage`、维护 pending 和 streaming 状态
- `ChatStreamContext.sendMessage` 负责写入本地用户消息、调用 WebSocket `chat:send`、迁移临时任务 ID
- `TaskStateMachine` 是消息展示的单一状态来源
- `ChatInputControls` 和 `MobileChatInputControls` 根据 `isStreaming` 把发送按钮切换为停止按钮或禁用发送

现有阻塞点主要有两个：

- `canSubmit` 在 `streamHandlers.isStreaming` 为 true 时变为 false
- 发送按钮在 streaming 期间优先展示停止动作，无法把新输入加入队列

## 目标

- 模型输出过程中，输入框仍可编辑
- 用户在 streaming 期间点击发送时，消息进入前端队列
- 当前 AI 回复结束后，队列按 FIFO 自动发送下一条
- 入队时清空输入框，避免用户误以为没有响应
- 队列消息在发送框上方展示，不进入聊天消息流
- 队列展示至少能区分 queued、sending、failed
- 支持取消排队消息，取消后内容回到输入框继续编辑
- 用户在已有排队消息时继续输入并发送，合并到现有排队消息中，一次发送
- 保留停止当前生成的能力
- 保持现有 WebSocket 协议和后端发送接口不变

## 非目标

- 本轮不做后端消息队列
- 本轮不允许同一任务并发发送多个子任务
- 本轮不改变 `TaskStateMachine` 作为消息展示单一来源的原则
- 本轮不修改 group chat 的后端协作语义
- 本轮不重做聊天页整体视觉设计
- 本轮不支持跨页面持久化未发送队列

## 方案对比

### 方案 1：ChatArea 层顺序队列

做法：

- 在 `ChatArea/useChatStreamHandlers` 附近维护当前任务的待发送队列
- streaming 时发送动作只入队
- 当前流结束后自动取队首并调用现有发送逻辑

优点：

- 改动集中在前端发送编排层
- 可以复用现有参数构建、附件、上下文、技能、模型选择逻辑
- 不改变后端协议
- 更容易用组件和 hook 测试覆盖

缺点：

- 队列只在当前页面生命周期内存在
- 多页面打开同一任务时，队列不会同步

### 方案 2：ChatStreamContext 全局队列

做法：

- 把队列放进 `ChatStreamContext`
- 所有页面通过统一 context 入队和自动发送

优点：

- 能覆盖更多入口
- 更接近全局消息调度

缺点：

- 会和临时 task ID、真实 task ID 迁移、不同页面状态同步耦合
- 更容易让 context 承担业务参数快照职责
- 首版风险更高

### 方案 3：后端顺序队列

做法：

- 前端 streaming 时仍直接发送请求
- 后端按任务维度排队执行

优点：

- 队列语义最完整
- 多端一致性最好

缺点：

- 需要调整后端任务执行语义
- 超出本轮“前端支持”的范围
- 需要更多执行器和任务状态回归验证

## 选型

采用方案 1：ChatArea 层顺序队列。

原因：

- 用户确认需要前端消息队列和自动发送
- 现有后端同一任务串行上下文更适合 FIFO 顺序发送
- 第一版应该避免引入后端执行语义变化
- `useChatStreamHandlers` 已经掌握发送所需的完整上下文，适合做参数快照

## 总体设计

### 队列数据模型

新增一个前端队列项类型，放在聊天发送相关模块附近，例如 `useMessageSendQueue`：

```ts
type QueuedMessageStatus = "queued" | "sending" | "failed";

interface QueuedMessage {
  id: string;
  taskId: number;
  content: string;
  createdAt: number;
  status: QueuedMessageStatus;
  error?: string;
  requestSnapshot: SendMessageSnapshot;
}
```

`SendMessageSnapshot` 记录入队当刻需要发送的所有可变输入：

- message
- attachments
- selected contexts
- selected model
- force override 配置
- selected skills
- repository 和 branch
- generation params
- toggles such as deep thinking and clarification

入队后即使用户继续修改输入框或切换模型，队列项也按入队时的快照发送，避免排队内容漂移。

### 入队行为

当满足以下条件时，点击发送执行入队：

- 当前任务已有真实 `taskId`
- 当前任务正在 streaming，或正在等待响应开始
- 输入内容非空
- 附件已经上传完成
- 当前必要选择项满足要求，例如 code 任务已选择仓库

入队成功后：

- 清空输入框
- 清空当前附件和上下文选择
- 在发送框上方展示队列预览，状态显示为 queued
- 保持输入框可继续编辑

如果当前任务已有未发送的 queued 项，新的输入不会创建第二条可见队列项，而是合并到现有 queued 项中。合并后的队列项保留所有发送快照信息，并在当前 AI 回复结束后作为一次请求发送。

新任务第一条消息仍按现有流程发送。原因是第一条消息发送前没有真实任务 ID，继续入队会让后续队列难以稳定绑定任务。

### 自动发送行为

队列调度器监听当前任务 streaming 状态：

- `isStreaming` 从 true 变为 false 后触发
- `selectedTaskDetail.status` 不再是 `RUNNING` 后触发
- 当前没有正在发送的队列项时触发
- 队列非空时取队首发送

自动发送复用现有发送函数，但使用队列项保存的快照，而不是读取当前输入区状态。

发送成功后：

- 从队列移除该项
- 通过现有发送链路创建正常的本地用户消息和后续 AI 回复
- 如果发送后又进入 streaming，等待下一轮完成后再发下一条

发送失败后：

- 将该队列项标记为 failed
- 显示 toast
- 暂停后续队列自动发送
- 保留失败项，后续可通过重试能力继续发送

### 队列展示

队列预览属于输入区状态，不属于聊天消息流：

- 队列预览显示在发送框上方，而不是发送框内部
- 每个队列项展示状态标签和最多两行消息内容
- queued 和 failed 项显示取消按钮
- sending 项不显示取消按钮，避免移除已经开始发送的请求
- 点击取消按钮会从队列移除该项，并把消息内容恢复到输入框

这样可以避免把尚未发送的内容混入 `TaskStateMachine` 消息列表，也能让用户清楚地区分“已发送消息”和“等待发送的输入”。

### 输入区行为

Desktop 和 mobile 保持一致：

- streaming 时输入框不禁用
- streaming 且输入为空时，保留停止当前生成的入口
- streaming 且输入非空时，显示入队发送入口，同时仍保留停止入口
- 队列预览显示在输入卡片外侧上方
- 非 streaming 时维持现有发送行为

为了控制改动范围，第一版只增加输入区上方的队列预览和发送按钮状态区分，不重做聊天页整体布局。

### 停止当前生成

停止动作只作用于当前正在生成的 AI 回复，不会清空队列。

停止成功后：

- 当前流结束
- 队列调度器按正常规则发送下一条

如果用户希望停止后不继续发送队列，后续可以增加“清空队列”或“暂停队列”操作，本轮不包含。

### 任务切换

队列按任务 ID 分组。

- 切换到其他任务时，只显示该任务自己的队列状态
- 自动发送只处理当前选中任务的队列
- 新建任务第一条消息完成并获得真实 task ID 后，才允许后续入队

本轮不做跨任务后台自动发送。这样能避免用户离开任务后仍有不可见消息被自动发出。

## 错误处理

### 入队前校验失败

沿用现有 toast：

- 附件未上传完成
- code 任务未选择仓库
- 模型选择缺失
- 输入为空

这些场景不创建队列项。

### 自动发送失败

自动发送失败时：

- 队列项标记为 failed
- 队列预览展示错误状态
- toast 展示错误原因
- 后续队列暂停

失败项需要用户显式重试或取消。重试优先复用 toast 中的 retry 入口；取消会把该队列项内容恢复到输入框。

### 当前流异常结束

当当前流进入 error 或 cancelled 状态时，也视为“当前流结束”。如果队列非空，调度器继续发送下一条。

## 测试计划

### Hook 和发送状态测试

- streaming 时 `canSubmit` 不再因为 streaming 变 false
- streaming 时输入非空点击发送会创建队列项，不会立即调用 WebSocket send
- 当前流结束后自动发送队首
- 已有 queued 项时再次发送会合并为一次 queued 请求
- 取消 queued 项会从队列移除，并把内容恢复到输入框
- 自动发送失败时暂停后续队列

### Desktop 控件测试

- streaming 且输入为空时仍可停止生成
- streaming 且输入非空时可以加入队列
- 队列预览显示在发送框上方，而不是聊天消息区或发送框内部
- queued 和 failed 项可以取消，sending 项不能取消
- 非 streaming 时发送按钮保持现有行为

### Mobile 控件测试

- mobile 控件与 desktop 发送状态一致
- streaming 时更多菜单中会被安全禁用的动作仍保持现有约束

### 集成回归测试

- 新任务第一条消息发送流程不变
- 已有任务 follow-up 发送流程不变
- 附件、知识库、表格上下文入队后按快照发送
- code 任务仓库和分支快照正确发送
- group chat 不回归已有发送和已读标记逻辑
- 取消排队后恢复的内容可继续编辑并重新发送

## 实施顺序

1. 为队列状态和调度器写失败测试
2. 提取发送请求快照构建逻辑，保证普通发送和队列发送复用
3. 新增 per-task 消息队列 hook
4. 调整 `ChatInputControls` 和 `MobileChatInputControls` 的 streaming 发送状态
5. 在发送框上方接入 queued 消息预览、合并和取消恢复输入
6. 补齐失败、重试和任务切换测试

## 风险

- 发送参数快照如果遗漏字段，队列消息可能和用户入队时看到的配置不一致
- 现有 `TaskStateMachine` 的 pending 消息去重和后端恢复逻辑需要避免把 queued 消息误删
- 停止当前生成后自动发送下一条可能不符合部分用户预期，但它符合本轮已确认的“队列自动发送”语义
- 多页面打开同一任务时，前端本地队列不会同步；这是首版明确接受的限制
