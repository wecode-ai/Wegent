# 聊天模式下的需求澄清功能

## 概述

需求澄清功能（PM Battle）现已在**聊天模式**和**代码模式**下完全可用。用户可以在两种模式下与 AI 进行需求澄清对话。

## 功能说明

### 聊天模式（Chat Mode）

- **路径**: `/chat`
- **特点**:
  - 无需选择代码仓库和分支
  - 专注于需求讨论和澄清
  - 支持完整的 clarificationForm 渲染和交互
  - 答案提交时不需要 repo/branch 信息

### 代码模式（Code Mode）

- **路径**: `/code`
- **特点**:
  - 需要选择代码仓库和分支
  - 包含工作台面板用于代码预览
  - 同样支持 clarificationForm 功能
  - 答案提交时包含 repo/branch 上下文

## 技术实现

### 组件架构

```
ChatArea (共用于 chat 和 code 模式)
└── MessagesArea
    ├── ClarificationForm (需求澄清表单)
    ├── ClarificationQuestion (单个问题渲染)
    └── ClarificationAnswerSummary (答案摘要展示)
```

### 数据流

1. **AI 返回澄清问题**
   - 支持 Markdown 格式
   - 支持 JSON 格式（向后兼容）

2. **用户填写并提交答案**
   - 表单验证
   - Markdown 格式化答案
   - 发送到后端

3. **答案展示**
   - 显示用户已提交的答案
   - 等待 AI 响应

### 关键代码位置

- **MessagesArea.tsx**: 主要渲染逻辑（line 687-709）
- **ClarificationForm.tsx**: 表单组件，支持两种模式（line 238-259）
- **messageService.ts**: 消息发送服务，聊天模式不要求 repo（line 34-36）

## 使用示例

### 在聊天模式下

1. 选择支持 PM Battle 的团队（如 `pm-battle-team`）
2. 输入需求描述
3. AI 返回澄清问题表单
4. 填写并提交答案
5. 继续对话

### 在代码模式下

1. 选择团队、仓库和分支
2. 输入需求描述
3. AI 返回澄清问题表单（包含代码上下文）
4. 填写并提交答案
5. AI 生成代码实现

## 兼容性说明

- ✅ 完全支持聊天模式
- ✅ 完全支持代码模式
- ✅ 支持 Markdown 和 JSON 两种格式
- ✅ 自动提取 repo/branch 信息（从 taskDetail）
- ✅ 表单验证和错误提示

## 注意事项

1. **聊天模式下的 repo/branch**
   - 表单提交时 repo 和 branch 参数可以为 `null`
   - 从 `selectedTaskDetail` 中提取（如果有）
   - 不影响功能正常使用

2. **后端配置**
   - 确保团队配置了支持 PM Battle 的 bot
   - 参考 `pm-battle-team` 配置

## 相关文档

- [PM Battle 用户指南](../guides/user/pm-battle-guide.md)
- [PM Battle 开发指南](../guides/developer/pm-battle-development.md)
