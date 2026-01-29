# OpenAPI v1/responses API

本文档描述 OpenAPI v1/responses 端点，该端点提供与 OpenAI Responses API 兼容的接口，用于与 Wegent 智能体（Team）进行交互。

## 概述

`/api/v1/responses` 端点允许外部应用程序使用与 OpenAI Responses API 兼容的格式与 Wegent 智能体进行交互。这使得将 Wegent 集成到已支持 OpenAI API 格式的现有应用程序中变得简单。

## 认证

所有端点都需要通过以下方式之一进行认证：

- **Bearer Token**: `Authorization: Bearer <access_token>`
- **API Key**: `X-API-Key: <api_key>`

### 获取 API Key

1. 登录 Wegent 前端界面
2. 点击左下角 **设置** 图标
3. 选择 **AI 密钥** 菜单
4. 点击 **创建个人密钥** 按钮
5. 复制生成的 API Key 用于 API 调用

## 基础 URL

```
/api/v1/responses
```

## 端点

### 创建响应

创建新的响应（执行任务）。

```
POST /api/v1/responses
```

#### 请求体

| 字段 | 类型 | 必填 | 描述 |
|------|------|------|------|
| `model` | string | 是 | 智能体标识符。格式：`namespace#team_name` 或 `namespace#team_name#model_id` |
| `input` | string \| array | 是 | 用户输入提示或对话历史 |
| `stream` | boolean | 否 | 启用流式输出（默认：`false`） |
| `previous_response_id` | string | 否 | 用于后续对话的前一个响应 ID |
| `tools` | array | 否 | Wegent 自定义工具配置 |

#### Model 格式

`model` 字段指定要使用的智能体（Team）：

- `namespace#team_name` - 使用 Team 的 Bot 中配置的默认模型
- `namespace#team_name#model_id` - 使用指定的模型覆盖

示例：
- `default#my-assistant`
- `my-group#coding-agent#gpt-4o`

#### Input 格式

`input` 字段支持两种格式：

**简单字符串：**
```json
{
  "input": "你好，最近怎么样？"
}
```

**对话历史（用于多轮对话）：**
```json
{
  "input": [
    {"type": "message", "role": "user", "content": "2+2 等于多少？"},
    {"type": "message", "role": "assistant", "content": "2+2 等于 4。"},
    {"type": "message", "role": "user", "content": "那 3+3 呢？"}
  ]
}
```

#### 工具配置

`tools` 数组用于启用额外的服务端能力：

```json
{
  "tools": [
    {"type": "wegent_chat_bot"}
  ]
}
```

| 工具类型 | 描述 |
|----------|------|
| `wegent_chat_bot` | 启用所有服务端能力（深度思考、网络搜索、服务端 MCP 工具、消息增强） |
| `wegent_code_bot` | 启用代码任务并指定 Git 仓库（用于 Executor 类型的 Team） |
| `mcp` | 添加自定义 MCP 服务器 |
| `skill` | 预加载特定技能 |

**代码任务配置：**
```json
{
  "tools": [
    {
      "type": "wegent_code_bot",
      "workspace": {
        "git_url": "https://github.com/user/repo.git",
        "branch": "main",
        "git_repo": "user/repo"
      }
    }
  ]
}
```

| 字段 | 类型 | 必填 | 描述 |
|------|------|------|------|
| `workspace.git_url` | string | 是 | Git 仓库 URL |
| `workspace.branch` | string | 是 | Git 分支名 |
| `workspace.git_repo` | string | 否 | 仓库名称（如 `user/repo`）。如未提供将从 `git_url` 自动提取 |

**MCP 服务器配置：**
```json
{
  "tools": [
    {
      "type": "mcp",
      "mcp_servers": [
        {
          "my-server": {"url": "http://...", "type": "http"},
          "another": {"url": "http://...", "type": "sse"}
        }
      ]
    }
  ]
}
```

**技能预加载：**
```json
{
  "tools": [
    {"type": "skill", "preload_skills": ["skill_a", "skill_b"]}
  ]
}
```

#### 响应行为

响应行为取决于 Team 的 Shell 类型：

| Shell 类型 | 流式支持 | 响应模式 |
|------------|----------|----------|
| Chat Shell | 是 | 同步或 SSE 流式 |
| 其他（ClaudeCode、Agno、Dify） | 否 | 排队（轮询获取完成状态） |

**Chat Shell（stream=false）：**
- 阻塞直到 LLM 完成
- 直接返回已完成的响应

**Chat Shell（stream=true）：**
- 返回与 OpenAI v1/responses 兼容的 SSE 事件流

**非 Chat Shell：**
- 立即返回状态为 `queued` 的响应
- 使用 `GET /api/v1/responses/{response_id}` 轮询获取完成状态

#### 请求示例

```bash
curl -X POST "https://your-domain/api/v1/responses" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "default#my-assistant",
    "input": "讲个笑话",
    "stream": false
  }'
```

#### 响应示例

```json
{
  "id": "resp_123",
  "object": "response",
  "created_at": 1704067200,
  "status": "completed",
  "model": "default#my-assistant",
  "output": [
    {
      "type": "message",
      "id": "msg_456",
      "status": "completed",
      "role": "user",
      "content": [{"type": "output_text", "text": "讲个笑话", "annotations": []}]
    },
    {
      "type": "message",
      "id": "msg_789",
      "status": "completed",
      "role": "assistant",
      "content": [{"type": "output_text", "text": "程序员为什么不喜欢户外？因为有太多 bug！", "annotations": []}]
    }
  ],
  "error": null,
  "previous_response_id": null
}
```

---

### 获取响应

根据 ID 获取响应。

```
GET /api/v1/responses/{response_id}
```

#### 路径参数

| 参数 | 类型 | 描述 |
|------|------|------|
| `response_id` | string | 响应 ID，格式为 `resp_{task_id}` |

#### 请求示例

```bash
curl "https://your-domain/api/v1/responses/resp_123" \
  -H "Authorization: Bearer <token>"
```

---

### 取消响应

取消正在运行的响应。

```
POST /api/v1/responses/{response_id}/cancel
```

#### 路径参数

| 参数 | 类型 | 描述 |
|------|------|------|
| `response_id` | string | 响应 ID，格式为 `resp_{task_id}` |

#### 行为

- **Chat Shell 任务**：停止模型请求并保存部分内容
- **Executor 任务**：调用 executor_manager 进行取消

#### 请求示例

```bash
curl -X POST "https://your-domain/api/v1/responses/resp_123/cancel" \
  -H "Authorization: Bearer <token>"
```

---

### 删除响应

删除响应。

```
DELETE /api/v1/responses/{response_id}
```

#### 路径参数

| 参数 | 类型 | 描述 |
|------|------|------|
| `response_id` | string | 响应 ID，格式为 `resp_{task_id}` |

#### 请求示例

```bash
curl -X DELETE "https://your-domain/api/v1/responses/resp_123" \
  -H "Authorization: Bearer <token>"
```

#### 响应示例

```json
{
  "id": "resp_123",
  "object": "response",
  "deleted": true
}
```

---

## 流式事件

当设置 `stream=true` 时（仅 Chat Shell 类型），API 返回 OpenAI v1/responses 格式的服务器推送事件（SSE）。

### 事件类型

| 事件类型 | 描述 |
|----------|------|
| `response.created` | 响应已创建 |
| `response.output_item.added` | 添加了新的输出项（消息） |
| `response.content_part.added` | 向消息添加了新的内容部分 |
| `response.output_text.delta` | 收到文本块 |
| `response.output_text.done` | 文本输出完成 |
| `response.content_part.done` | 内容部分完成 |
| `response.output_item.done` | 输出项完成 |
| `response.completed` | 响应完全完成 |
| `response.failed` | 响应失败并带有错误 |

### SSE 流示例

```
event: response.created
data: {"type":"response.created","response":{"id":"resp_123","status":"in_progress",...}}

event: response.output_item.added
data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","role":"assistant"}}

event: response.content_part.added
data: {"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text","text":""}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"你好"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"世界！"}

event: response.output_text.done
data: {"type":"response.output_text.done","output_index":0,"content_index":0,"text":"你好世界！"}

event: response.completed
data: {"type":"response.completed","response":{"id":"resp_123","status":"completed",...}}
```

---

## 响应状态

| 状态 | 描述 |
|------|------|
| `queued` | 任务已排队等待执行（非 Chat Shell） |
| `in_progress` | 任务正在运行 |
| `completed` | 任务成功完成 |
| `failed` | 任务失败并带有错误 |
| `cancelled` | 任务已取消 |
| `incomplete` | 任务部分完成 |

---

## 错误处理

### HTTP 状态码

| 状态码 | 描述 |
|--------|------|
| 200 | 成功 |
| 400 | 请求错误（参数无效） |
| 401 | 未授权（缺少或无效的认证） |
| 404 | 资源未找到 |
| 500 | 内部服务器错误 |

### 错误响应格式

```json
{
  "detail": "描述错误的消息"
}
```

### 响应对象错误

当任务失败时，`error` 字段包含：

```json
{
  "id": "resp_123",
  "status": "failed",
  "error": {
    "code": "task_failed",
    "message": "详细错误消息"
  },
  ...
}
```

---

## 后续对话

要继续对话，请使用 `previous_response_id`：

```json
{
  "model": "default#my-assistant",
  "input": "再讲一个",
  "previous_response_id": "resp_123"
}
```

这会追加到同一个任务，保持对话上下文。

---

## 注意事项

- 默认情况下，API 调用使用"干净模式"，不启用服务端增强功能
- CRD 中配置的 Bot/Ghost MCP 工具始终可用
- 使用 `wegent_chat_bot` 工具启用完整的服务端能力
- 流式输出仅支持 Chat Shell 类型的 Team
