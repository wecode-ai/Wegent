# OpenAPI Responses API 参考

本文档描述 Wegent OpenAPI Responses API，该 API 与 OpenAI Responses API 格式兼容。

---

## 概述

Responses API 提供了一种标准化的方式来与 Wegent Teams 进行程序化交互。它支持 Chat Shell 类型团队（直接 LLM 调用）和基于 Executor 的团队（队列化任务执行）。

**基础 URL：** `/api/v1/responses`

**认证：** Bearer token（API 密钥）或会话 cookie

---

## 接口

### 创建响应

**POST** `/api/v1/responses`

创建新的响应（执行任务）。

#### 请求体

| 字段 | 类型 | 必需 | 描述 |
|------|------|------|------|
| `model` | string | 是 | 团队标识符，格式为 `namespace#team_name` 或 `namespace#team_name#model_id` |
| `input` | string \| array | 是 | 用户输入提示或对话历史 |
| `stream` | boolean | 否 | 启用流式输出（默认：`false`） |
| `tools` | array | 否 | Wegent 自定义工具配置 |
| `previous_response_id` | string | 否 | 上一个响应 ID，用于后续对话 |

#### Model 字符串格式

`model` 字段使用特殊格式来标识目标 Team：

```
namespace#team_name           # 使用 Team 的默认模型
namespace#team_name#model_id  # 使用指定模型覆盖
```

**示例：**
```
default#my-team              # default 命名空间中的 "my-team" 团队
default#my-team#gpt-4        # 使用模型覆盖的 "my-team" 团队
mygroup#coding-team          # mygroup 命名空间中的 "coding-team" 团队
```

#### Input 格式

`input` 字段可以是简单字符串或消息数组：

**简单字符串：**
```json
{
  "model": "default#my-team",
  "input": "你好，你好吗？"
}
```

**对话历史：**
```json
{
  "model": "default#my-team",
  "input": [
    {
      "type": "message",
      "role": "user",
      "content": "2+2 等于多少？"
    },
    {
      "type": "message",
      "role": "assistant",
      "content": "2+2 等于 4。"
    },
    {
      "type": "message",
      "role": "user",
      "content": "那 3+3 呢？"
    }
  ]
}
```

#### Wegent 工具

`tools` 字段允许配置特殊的 Wegent 功能：

| 工具类型 | 描述 |
|---------|------|
| `wegent_deep_thinking` | 启用深度思考模式和网络搜索（需要系统配置 `WEB_SEARCH_ENABLED=true`） |
| `disable_wegent_tools` | 禁用所有 wecode 添加的工具（MCP、WebSearch） |
| `disable_wegent_extend_message` | 禁用所有自动注入的内容（日期时间、提示词） |

**使用工具的示例：**
```json
{
  "model": "default#my-team",
  "input": "研究最新的 AI 趋势",
  "tools": [
    {"type": "wegent_deep_thinking"}
  ]
}
```

**禁用 wecode 功能的示例：**
```json
{
  "model": "default#my-team",
  "input": "你好",
  "tools": [
    {"type": "disable_wegent_tools"},
    {"type": "disable_wegent_extend_message"}
  ]
}
```

#### 响应

对于 Chat Shell 类型团队且 `stream=false`：
```json
{
  "id": "resp_123",
  "object": "response",
  "created_at": 1704067200,
  "status": "completed",
  "model": "default#my-team",
  "output": [
    {
      "type": "message",
      "id": "msg_456",
      "status": "completed",
      "role": "user",
      "content": [{"type": "output_text", "text": "你好", "annotations": []}]
    },
    {
      "type": "message",
      "id": "msg_457",
      "status": "completed",
      "role": "assistant",
      "content": [{"type": "output_text", "text": "你好！有什么可以帮你的？", "annotations": []}]
    }
  ]
}
```

对于基于 Executor 的团队（非 Chat Shell）：
```json
{
  "id": "resp_123",
  "object": "response",
  "created_at": 1704067200,
  "status": "queued",
  "model": "default#my-team",
  "output": []
}
```

---

### 流式响应

当为 Chat Shell 类型团队设置 `stream=true` 时，API 返回 Server-Sent Events (SSE)：

```
data: {"type": "response.created", "response": {...}}

data: {"type": "response.output_item.added", "output_index": 0, "item": {...}}

data: {"type": "response.content_part.added", "output_index": 0, "content_index": 0, "part": {...}}

data: {"type": "response.output_text.delta", "output_index": 0, "content_index": 0, "delta": "你"}

data: {"type": "response.output_text.delta", "output_index": 0, "content_index": 0, "delta": "好"}

data: {"type": "response.output_text.done", "output_index": 0, "content_index": 0, "text": "你好！"}

data: {"type": "response.content_part.done", "output_index": 0, "content_index": 0, "part": {...}}

data: {"type": "response.output_item.done", "output_index": 0, "item": {...}}

data: {"type": "response.completed", "response": {...}}

data: [DONE]
```

---

### 获取响应

**GET** `/api/v1/responses/{response_id}`

根据 ID 获取响应。

#### 参数

| 参数 | 类型 | 描述 |
|------|------|------|
| `response_id` | string | 响应 ID，格式为 `resp_{task_id}` |

#### 响应

```json
{
  "id": "resp_123",
  "object": "response",
  "created_at": 1704067200,
  "status": "completed",
  "model": "default#my-team",
  "output": [...]
}
```

---

### 取消响应

**POST** `/api/v1/responses/{response_id}/cancel`

取消正在运行的响应。

#### 参数

| 参数 | 类型 | 描述 |
|------|------|------|
| `response_id` | string | 响应 ID，格式为 `resp_{task_id}` |

#### 响应

返回更新状态后的响应对象。

---

### 删除响应

**DELETE** `/api/v1/responses/{response_id}`

删除响应。

#### 参数

| 参数 | 类型 | 描述 |
|------|------|------|
| `response_id` | string | 响应 ID，格式为 `resp_{task_id}` |

#### 响应

```json
{
  "id": "resp_123",
  "object": "response",
  "deleted": true
}
```

---

## 响应状态

| 状态 | 描述 |
|------|------|
| `queued` | 任务等待执行（基于 Executor 的团队） |
| `in_progress` | 任务正在运行 |
| `completed` | 任务成功完成 |
| `failed` | 任务失败并出错 |
| `cancelled` | 任务已取消 |
| `incomplete` | 任务部分完成 |

---

## 系统配置

以下环境变量会影响 Responses API 的行为：

| 变量 | 默认值 | 描述 |
|------|--------|------|
| `WEB_SEARCH_ENABLED` | `false` | 启用网络搜索功能 |
| `WEB_SEARCH_DEFAULT_MAX_RESULTS` | `100` | 网络搜索的默认最大结果数 |
| `CHAT_MCP_ENABLED` | `false` | 在 Chat Shell 模式下启用 MCP 工具 |

---

## 使用示例

### Python

```python
import requests

API_URL = "http://localhost:8000/api/v1/responses"
API_KEY = "your-api-key"

headers = {
    "Authorization": f"Bearer {API_KEY}",
    "Content-Type": "application/json"
}

# 简单请求
response = requests.post(
    API_URL,
    headers=headers,
    json={
        "model": "default#my-team",
        "input": "你好，世界！"
    }
)
print(response.json())

# 使用深度思考
response = requests.post(
    API_URL,
    headers=headers,
    json={
        "model": "default#my-team",
        "input": "研究量子计算",
        "tools": [{"type": "wegent_deep_thinking"}]
    }
)
print(response.json())

# 禁用 wecode 功能以获得原始 LLM 访问
response = requests.post(
    API_URL,
    headers=headers,
    json={
        "model": "default#my-team",
        "input": "你好",
        "tools": [
            {"type": "disable_wegent_tools"},
            {"type": "disable_wegent_extend_message"}
        ]
    }
)
print(response.json())
```

### cURL

```bash
# 简单请求
curl -X POST http://localhost:8000/api/v1/responses \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "default#my-team",
    "input": "你好，世界！"
  }'

# 流式输出
curl -X POST http://localhost:8000/api/v1/responses \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "default#my-team",
    "input": "给我讲个故事",
    "stream": true
  }'

# 禁用工具
curl -X POST http://localhost:8000/api/v1/responses \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "default#my-team",
    "input": "你好",
    "tools": [
      {"type": "disable_wegent_tools"},
      {"type": "disable_wegent_extend_message"}
    ]
  }'
```

---

## 相关资源

- [管理任务](../guides/user/managing-tasks.md) - 任务管理指南
- [创建团队](../guides/user/creating-teams.md) - 团队创建指南
- [配置 Shells](../guides/user/configuring-shells.md) - Shell 类型配置
