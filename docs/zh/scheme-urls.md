# Wegent Scheme URL 系统

## 概述

Wegent 实现了一个全面的 **Scheme URL 系统**,允许使用 `wegent://` URL 导航和与应用程序交互。这使得可以从外部来源深度链接、自动化脚本,并为常见操作提供声明式 API。

## 架构

系统遵循**三层架构**:

1. **解析层** (`parser.ts`): 解析和验证 `wegent://` URL
2. **注册表层** (`registry.ts`): 存储和匹配 URL 处理器
3. **处理层** (`handler.ts`): 为每个 URL 执行适当的操作

## URL 结构

```
wegent://{type}/{path}?{params}
```

- **type**: 操作类别 (`open`, `form`, `action`, `modal`)
- **path**: 类型内的特定目标
- **params**: 可选的查询参数

## 支持的 Scheme URL

### 页面导航 (`wegent://open/*`)

导航到应用程序中的不同页面。

| Scheme URL | 描述 | 示例 |
|------------|------|------|
| `wegent://open/chat` | 打开对话页面 | `wegent://open/chat`<br/>`wegent://open/chat?team=123` |
| `wegent://open/code` | 打开代码页面 | `wegent://open/code`<br/>`wegent://open/code?team=123` |
| `wegent://open/settings` | 打开设置页面 | `wegent://open/settings`<br/>`wegent://open/settings?tab=integrations` |
| `wegent://open/knowledge` | 打开知识库 | `wegent://open/knowledge`<br/>`wegent://open/knowledge/123` |
| `wegent://open/feed` | 打开动态流 | `wegent://open/feed` |
| `wegent://open/feedback` | 打开反馈对话框 | `wegent://open/feedback` |

### 表单 (`wegent://form/*`)

打开创建/编辑对话框。

| Scheme URL | 描述 | 需要认证 |
|------------|------|----------|
| `wegent://form/create-task` | 打开创建任务对话框 | ✅ |
| `wegent://form/create-team` | 打开创建智能体对话框 | ✅ |
| `wegent://form/create-bot` | 打开创建机器人对话框 | ✅ |
| `wegent://form/add-repository` | 打开添加代码仓库对话框 | ✅ |
| `wegent://form/create-subscription` | 打开创建订阅对话框 | ✅ |

**预填充表单数据:**

您可以通过传递包含 JSON 编码表单数据的 `data` 参数来预填充订阅表单:

```
wegent://form/create-subscription?data={"displayName":"每日新闻","description":"收集每日新闻","triggerType":"cron"}
```

**`data` 参数中支持的字段:**
- `displayName` (string): 订阅显示名称
- `description` (string): 订阅描述
- `taskType` (string): 任务类型 (`collection`, `analysis`, `notification`)
- `triggerType` (string): 触发类型 (`cron`, `interval`, `one_time`, `event`)
- `promptTemplate` (string): 订阅的提示词模板
- `retryCount` (number): 失败时重试次数
- `timeoutSeconds` (number): 超时时间(秒)
- `enabled` (boolean): 是否启用订阅
- `preserveHistory` (boolean): 是否保留执行历史
- `visibility` (string): 可见性 (`private`, `public`, `unlisted`)

### 操作 (`wegent://action/*`)

执行操作。

| Scheme URL | 描述 | 参数 | 需要认证 |
|------------|------|------|----------|
| `wegent://action/send-message` | 自动发送消息 | `text`, `team` (可选) | ✅ |
| `wegent://action/prefill-message` | 预填充消息输入 | `text`, `team` (可选) | ✅ |
| `wegent://action/share` | 生成并复制分享链接 | `type` (可选), `id` (可选) | ✅ |
| `wegent://action/export-chat` | 通过分享链接导出对话 | `taskId` (可选) | ✅ |
| `wegent://action/export-task` | 通过分享链接导出任务 | `taskId` (可选) | ✅ |
| `wegent://action/export-code` | 通过分享链接导出代码 | `taskId` (可选), `fileId` (可选) | ✅ |

**注意：** 如果不提供 `taskId` 或 `id` 参数，系统将自动使用当前打开的任务。


## 使用方法

### 在 React 组件中

```typescript
import { useSchemeURL } from '@/lib/scheme'

function MyComponent() {
  const { navigate } = useSchemeURL(user)

  return (
    <button onClick={() => navigate('wegent://open/chat?team=123')}>
      打开对话
    </button>
  )
}
```

### 在 HTML 链接中

```html
<a href="wegent://open/chat?team=123">打开对话</a>
```

### 从外部来源

```bash
# 从命令行打开 (macOS/Linux)
open "wegent://open/chat?team=123"

# Windows
start "wegent://open/chat?team=123"
```

## 事件系统

系统使用自定义 DOM 事件进行组件通信:

### 对话框事件

```typescript
// 监听对话框打开请求
window.addEventListener('wegent:open-dialog', (e) => {
  const { type, params } = e.detail
  // 打开适当的对话框
})
```

### 消息事件

```typescript
// 监听发送消息操作
window.addEventListener('wegent:send-message', (e) => {
  const { text, team } = e.detail
  // 发送消息
})

// 监听预填充消息操作
window.addEventListener('wegent:prefill-message', (e) => {
  const { text, team } = e.detail
  // 预填充输入框
})
```

### 导出事件

```typescript
// 监听导出操作
window.addEventListener('wegent:export', (e) => {
  const { type, taskId, fileId } = e.detail
  // 触发导出
})
```

## 添加新的 Scheme URL

### 1. 注册处理器

```typescript
import { registerScheme } from '@/lib/scheme'

registerScheme('my-custom-action', {
  pattern: 'wegent://action/my-action',
  handler: (context) => {
    const { params, router, user } = context
    // 实现你的逻辑
  },
  requireAuth: true,
  description: '我的自定义操作',
  examples: ['wegent://action/my-action?param=value'],
})
```

### 2. 更新类型定义

在 `types.ts` 中添加新 URL:

```typescript
export type ActionSchemeURL =
  | `wegent://action/my-action?${string}`
  | ... // 现有类型
```

### 3. 添加 i18n 翻译

在 `scheme.json` 文件中添加翻译:

```json
{
  "scheme_url": {
    "my_action": "我的操作"
  }
}
```

## 错误处理

系统遵循**静默失败**方法:

- 无效的 URL 记录到控制台但不会中断用户流程
- 缺失的处理器记录为警告
- 认证失败会静默取消操作
- 处理器执行期间的错误会被捕获和记录

这确保即使 Scheme URL 失败,也能提供流畅的用户体验。

## 开发工具

在开发模式下,通过以下方式访问调试工具:

```javascript
window.__wegentScheme__.debug()        // 列出所有 scheme
window.__wegentScheme__.generateDocs() // 生成 markdown 文档
window.__wegentScheme__.validate()     // 验证必需的 scheme
```

## 安全性

- 通过 `requireAuth` 标志检查身份验证
- 未经身份验证的受保护 URL 请求会被静默忽略
- 所有 URL 在执行前都会被验证
- URL 参数中不应传递敏感数据

## 浏览器支持

系统需要:
- ES6+ JavaScript 支持
- `CustomEvent` API
- `URLSearchParams` API
- `Next.js` 路由器

## 测试

参见 `frontend/src/__tests__/lib/scheme/` 中的测试文件示例。

## 未来增强

- 系统级 URL scheme 注册(桌面应用)
- URL scheme 版本控制
- 来自移动应用的深度链接
- Universal Links 支持 (iOS/Android)
