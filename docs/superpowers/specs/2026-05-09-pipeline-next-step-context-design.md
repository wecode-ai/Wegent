---
sidebar_position: 2
---

# Pipeline 下一步上下文选择设计

## 背景

当前 Pipeline 模式已经支持阶段确认：当某个阶段完成且该阶段配置了
`requireConfirmation` 时，任务状态会进入 `PENDING_CONFIRMATION`，用户可以在
`FinalPromptMessage` 中点击确认，将当前阶段产出的提示词继续发送给下一阶段。

这条链路能工作，但它有两个明显限制：

- 推进入口依赖澄清表单或最终提示词卡片，用户不一定能在 pipeline 进度区域发现“可以进入下一步”
- 继续到下一阶段时，用户无法明确选择要带入哪些上下文，只能沿用当前确认按钮的固定行为

用户希望在进入 `PENDING_CONFIRMATION` 后，除了澄清表单以外，还能通过 Pipeline 指示器跳转到下一个任务，并且可以选择要带哪些上下文继续。

## 当前状态

现有相关链路如下：

- `PipelineStageIndicator` 展示 pipeline 进度和阶段状态
- `pipeline_stage_info.is_pending_confirmation` 是前端判断当前阶段是否等待确认的单一状态来源
- `FinalPromptMessage` 在 `isPendingConfirmation` 为 true 时展示确认按钮
- 确认按钮调用 `sendMessage`，并带上 `action: 'pipeline:confirm'`
- 后端 WebSocket 收到 `pipeline:confirm` 后调用 `pipeline_stage_service.pipeline_confirm`
- `pipeline_confirm` 推进 `task.spec.currentStage`，后续仍走正常 `chat:send` 创建下一阶段子任务
- 当前消息上下文已经支持附件、知识库和表格，并通过 `attachment_ids` 与 `contexts` 发送到后端

因此本轮设计不需要新建后端确认接口，也不需要改变 pipeline 阶段推进语义。

## 问题

### 1. Pipeline 指示器没有推进动作

用户看到 pipeline 进度时，只能理解当前处在哪个阶段，无法直接从进度条进入下一步。

### 2. 继续下一阶段的入口依赖特殊消息卡片

如果当前阶段没有输出可解析的 `final_prompt`，或者用户没有注意到最终提示词卡片，就缺少明显的继续入口。

### 3. 上下文携带不可控

当前确认链路主要传递最终提示词内容，没有让用户明确选择本阶段用户消息、AI 回复、附件、知识库、表格等上下文是否带入下一阶段。

## 目标

- 仅当任务进入 `PENDING_CONFIRMATION` 时，在 Pipeline 指示器中显示“下一步”入口
- 点击“下一步”后打开上下文选择弹窗
- 用户可以补充发送给下一阶段的额外说明
- 用户可以选择要带入下一阶段的上下文
- 有 `final_prompt` 时默认勾选该 `final_prompt` 作为 AI 上下文
- 没有 `final_prompt` 时默认勾选最后一条已完成 AI 回复全文
- 默认勾选推荐上下文，让用户可以直接确认继续
- 继续复用现有 `sendMessage` 和 `action: 'pipeline:confirm'` 链路

## 非目标

- 本轮不修改 Pipeline 阶段配置方式
- 本轮不新增后端 API
- 本轮不改变 `requireConfirmation` 的后端语义
- 本轮不支持在非 `PENDING_CONFIRMATION` 状态强制跳阶段
- 本轮不重新设计澄清表单
- 本轮不移除 `FinalPromptMessage` 现有确认能力

## 方案对比

### 方案 1：指示器按钮 + 上下文选择弹窗

做法：

- `PENDING_CONFIRMATION` 时在 Pipeline 指示器右侧显示“下一步”按钮
- 点击后打开弹窗
- 弹窗内编辑下一阶段消息，并勾选上下文
- 确认后复用 `pipeline:confirm` 发送

优点：

- 入口明显
- 不挤压 pipeline 进度条布局
- 选择内容可以完整展示
- 适合移动端和长上下文列表
- 可以单独测试弹窗默认值和发送参数

缺点：

- 比直接按钮多一次确认

### 方案 2：在指示器内展开选择区域

做法：

- 点击“下一步”后，在指示器下方直接展开上下文勾选区域

优点：

- 不需要弹窗

缺点：

- 指示器会承担表单职责
- 长上下文列表容易破坏聊天页布局
- 移动端空间紧张

### 方案 3：快速下一步 + 二级选择入口

做法：

- 指示器直接提供“下一步”
- 旁边提供“选择上下文”
- 默认推荐上下文直接发送

优点：

- 最快

缺点：

- 用户可能没有意识到系统默认带入了哪些上下文
- 与“让用户选”的需求不完全一致

## 选型

采用方案 1：指示器按钮 + 上下文选择弹窗。

原因：

- 用户已确认该方案
- 该方案最符合“进入下一步前选择上下文”的心智
- Pipeline 指示器保持轻量，只负责状态和入口
- 弹窗负责上下文选择、默认值和发送确认，职责更清晰

## 总体设计

### Pipeline 指示器入口

文件：`frontend/src/features/tasks/components/chat/PipelineStageIndicator.tsx`

当满足以下条件时，显示“下一步”按钮：

- 当前任务是 pipeline 模式
- `stageInfo.is_pending_confirmation === true`
- 当前阶段不是最后一个阶段

按钮点击后不直接发送消息，而是调用父组件传入的回调，例如
`onNextStepClick(stageInfo)`。

如果当前阶段没有可发送内容，按钮保持禁用，并通过 tooltip 或短提示说明暂无可继续内容。

### ChatArea 作为编排层

文件：`frontend/src/features/tasks/components/chat/ChatArea.tsx`

`ChatArea` 负责：

- 接收 `PipelineStageIndicator` 的下一步点击
- 持有 `PipelineNextStepDialog` 的打开状态
- 将当前统一消息列表传给弹窗
- 接收弹窗确认结果
- 调用现有发送能力继续到下一阶段

`ChatArea` 继续把 `pipeline_stage_info.is_pending_confirmation` 当作是否等待确认的单一状态来源。

### 新增 PipelineNextStepDialog

建议新增文件：

- `frontend/src/features/tasks/components/chat/PipelineNextStepDialog.tsx`

弹窗职责：

- 根据当前消息生成默认下一阶段消息
- 展示可编辑 textarea
- 展示上下文候选项
- 管理上下文勾选状态
- 在确认时输出结构化选择结果

弹窗不直接依赖后端 API。它只调用父组件提供的 `onConfirm`。

## 默认值规则

### 默认消息内容

弹窗 textarea 默认留空。它只表示用户要额外补充给下一阶段的说明，而不是上一阶段的主要交付内容。

默认带入下一阶段的 AI 上下文按以下优先级生成：

1. 从最后一条已完成 AI 回复中解析 `final_prompt`
2. 如果没有 `final_prompt`，使用最后一条已完成 AI 回复全文
3. 如果没有可用 AI 回复，则不允许确认发送

用户可以在弹窗 textarea 中补充说明；即使 textarea 为空，只要默认 AI 上下文仍被选中，也可以确认继续。

### 默认勾选上下文

默认勾选推荐带入项：

- 当前阶段默认消息内容对应的 AI 输出项
- 当前阶段消息上的附件
- 当前阶段消息上的知识库
- 当前阶段消息上的表格

默认不勾选当前阶段相关用户消息，也不勾选更早历史消息。这些文本只作为可选历史上下文展示，用户需要时手动勾选。

### 有 final_prompt 和无 final_prompt 的差异

有 `final_prompt` 时：

- 默认勾选 `final_prompt` 对应输出项
- 完整 AI 回复可选，但不默认勾选
- textarea 默认留空

没有 `final_prompt` 时：

- 默认勾选该 AI 回复全文
- textarea 默认留空

## 上下文候选项

弹窗中的候选项分为两类。

### 文本上下文

文本上下文用于拼接下一阶段消息内容：

- 当前阶段用户消息
- 默认 AI 输出内容
- 更早历史消息

textarea 中的内容是用户新增说明。勾选文本上下文时，系统会追加带角色标记的历史内容。推荐规则是：

- textarea 内容放在发送消息最前方
- 勾选的文本上下文追加在 `Previous pipeline context:` 下方
- 用户消息使用 `[User]` 标记，AI 回复使用 `[AI]` 标记
- 默认 AI 输出内容不会写入 textarea，而是作为默认选中的 AI 上下文发送

### 结构化上下文

结构化上下文复用现有发送协议：

- 附件转换为 `attachment_ids`
- 知识库转换为 `contexts: [{ type: 'knowledge_base', data: ... }]`
- 表格转换为 `contexts: [{ type: 'table', data: ... }]`

这些结构化上下文也会作为 pending contexts 传给前端状态机，用于立即展示在用户消息气泡上。

## 发送设计

确认后，前端调用现有 `sendMessage`，核心参数为：

```ts
{
  task_id: taskId,
  team_id: selectedTeam.id,
  message: selectedMessage,
  action: 'pipeline:confirm',
  attachment_ids: selectedAttachmentIds,
  contexts: selectedStructuredContexts,
}
```

发送成功后：

- 关闭弹窗
- 标记确认中，避免重复提交
- 让现有 WebSocket 状态事件触发任务状态刷新
- `PipelineStageIndicator` 重新拉取 stage info 并进入下一阶段显示

发送失败时：

- 保留弹窗内容和勾选状态
- toast 提示确认失败
- 用户可以调整后重试

## 与 FinalPromptMessage 的关系

`FinalPromptMessage` 现有确认按钮保留。

短期内两个入口都调用同一条 `pipeline:confirm` 链路：

- `FinalPromptMessage` 适合用户在最终提示词卡片里直接确认
- `PipelineStageIndicator` 适合用户从 pipeline 进度区域确认并选择上下文

后续如果产品希望减少重复入口，可以再评估是否隐藏 `FinalPromptMessage` 中的确认按钮，但本轮不做。

## 错误处理

- 非 `PENDING_CONFIRMATION` 状态不显示“下一步”按钮
- `PENDING_CONFIRMATION` 但没有可发送 AI 内容时，按钮禁用
- textarea 为空且没有任何结构化上下文时，确认按钮禁用
- textarea 有内容但没有勾选结构化上下文时，允许继续
- 发送中禁用确认按钮，避免重复提交
- 发送失败后不清空弹窗状态
- 任务切换或退出 pipeline 状态时自动关闭弹窗

## 测试设计

### PipelineStageIndicator

- `is_pending_confirmation` 为 true 时显示“下一步”按钮
- `is_pending_confirmation` 为 false 时不显示“下一步”按钮
- 当前阶段是最后阶段时不显示“下一步”按钮
- 点击“下一步”会调用父组件回调，不直接发送消息

### PipelineNextStepDialog

- 有 `final_prompt` 时，默认勾选 `final_prompt` 对应的 AI 上下文
- 没有 `final_prompt` 时，默认勾选最后一条已完成 AI 回复全文
- textarea 默认留空，仅用于补充说明
- 没有可用 AI 回复时，确认按钮禁用
- 默认勾选 AI 输出项和结构化上下文，不默认勾选当前阶段相关用户消息
- 文本上下文发送时保留 `[User]` / `[AI]` 角色标记
- 用户取消勾选后，确认结果不包含对应上下文
- textarea 为空且无上下文时不能确认

### ChatArea 发送编排

- 弹窗确认后发送 `action: 'pipeline:confirm'`
- 发送参数包含用户选择后的 `attachment_ids`
- 发送参数包含用户选择后的 `contexts`
- 发送失败时弹窗保持打开
- 发送成功后弹窗关闭

## 实施顺序

1. 为 `PipelineStageIndicator` 补充入口显示测试
2. 新增 `PipelineNextStepDialog` 的默认值和勾选测试
3. 实现 `PipelineNextStepDialog`
4. 将 `PipelineStageIndicator` 下一步入口接入 `ChatArea`
5. 在 `ChatArea` 中完成确认发送参数组装
6. 补充中英文 i18n 文案
7. 运行前端单元测试和 lint

## 自检结论

- 设计只在 `PENDING_CONFIRMATION` 状态启用，不改变 pipeline 自动执行语义
- 设计复用现有 WebSocket 发送和后端确认链路，不引入新的后端接口
- 默认值覆盖有 `final_prompt` 和无 `final_prompt` 两种情况
- 上下文选择区分文本上下文和结构化上下文，默认携带 AI 输出，不默认携带上一轮用户消息
- 文本上下文发送时带角色标记，避免把用户和 AI 内容混成一段裸文本
- 本轮范围集中在前端入口、弹窗和发送编排，不包含无关重构
