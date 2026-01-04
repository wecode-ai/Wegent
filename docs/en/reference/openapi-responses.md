# OpenAPI Responses API Reference

This document describes the Wegent OpenAPI Responses API, which is compatible with the OpenAI Responses API format.

---

## Overview

The Responses API provides a standardized way to interact with Wegent Teams programmatically. It supports both Chat Shell type teams (direct LLM calls) and Executor-based teams (queued task execution).

**Base URL:** `/api/v1/responses`

**Authentication:** Bearer token (API key) or session cookie

---

## Endpoints

### Create Response

**POST** `/api/v1/responses`

Create a new response (execute a task).

#### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `model` | string | Yes | Team identifier in format `namespace#team_name` or `namespace#team_name#model_id` |
| `input` | string \| array | Yes | User input prompt or conversation history |
| `stream` | boolean | No | Enable streaming output (default: `false`) |
| `tools` | array | No | Wegent custom tools configuration |
| `previous_response_id` | string | No | Previous response ID for follow-up conversations |

#### Model String Format

The `model` field uses a special format to identify the target Team:

```
namespace#team_name           # Use Team's default model
namespace#team_name#model_id  # Override with specific model
```

**Examples:**
```
default#my-team              # Team "my-team" in default namespace
default#my-team#gpt-4        # Team "my-team" with model override
mygroup#coding-team          # Team "coding-team" in mygroup namespace
```

#### Input Format

The `input` field can be either a simple string or an array of messages:

**Simple string:**
```json
{
  "model": "default#my-team",
  "input": "Hello, how are you?"
}
```

**Conversation history:**
```json
{
  "model": "default#my-team",
  "input": [
    {
      "type": "message",
      "role": "user",
      "content": "What is 2+2?"
    },
    {
      "type": "message",
      "role": "assistant",
      "content": "2+2 equals 4."
    },
    {
      "type": "message",
      "role": "user",
      "content": "And what is 3+3?"
    }
  ]
}
```

#### Wegent Tools

The `tools` field allows you to configure special Wegent capabilities:

| Tool Type | Description |
|-----------|-------------|
| `wegent_deep_thinking` | Enable deep thinking mode with web search (requires `WEB_SEARCH_ENABLED=true` in system config) |
| `disable_wegent_tools` | Disable all wecode-added tools (MCP, WebSearch) |
| `disable_wegent_extend_message` | Disable all auto-injected content (datetime, prompts) |

**Example with tools:**
```json
{
  "model": "default#my-team",
  "input": "Research the latest AI trends",
  "tools": [
    {"type": "wegent_deep_thinking"}
  ]
}
```

**Example disabling wecode features:**
```json
{
  "model": "default#my-team",
  "input": "Hello",
  "tools": [
    {"type": "disable_wegent_tools"},
    {"type": "disable_wegent_extend_message"}
  ]
}
```

#### Response

For Chat Shell type teams with `stream=false`:
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
      "content": [{"type": "output_text", "text": "Hello", "annotations": []}]
    },
    {
      "type": "message",
      "id": "msg_457",
      "status": "completed",
      "role": "assistant",
      "content": [{"type": "output_text", "text": "Hello! How can I help you?", "annotations": []}]
    }
  ]
}
```

For Executor-based teams (non-Chat Shell):
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

### Streaming Response

When `stream=true` is set for Chat Shell type teams, the API returns Server-Sent Events (SSE):

```
data: {"type": "response.created", "response": {...}}

data: {"type": "response.output_item.added", "output_index": 0, "item": {...}}

data: {"type": "response.content_part.added", "output_index": 0, "content_index": 0, "part": {...}}

data: {"type": "response.output_text.delta", "output_index": 0, "content_index": 0, "delta": "Hello"}

data: {"type": "response.output_text.delta", "output_index": 0, "content_index": 0, "delta": "!"}

data: {"type": "response.output_text.done", "output_index": 0, "content_index": 0, "text": "Hello!"}

data: {"type": "response.content_part.done", "output_index": 0, "content_index": 0, "part": {...}}

data: {"type": "response.output_item.done", "output_index": 0, "item": {...}}

data: {"type": "response.completed", "response": {...}}

data: [DONE]
```

---

### Get Response

**GET** `/api/v1/responses/{response_id}`

Retrieve a response by ID.

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `response_id` | string | Response ID in format `resp_{task_id}` |

#### Response

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

### Cancel Response

**POST** `/api/v1/responses/{response_id}/cancel`

Cancel a running response.

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `response_id` | string | Response ID in format `resp_{task_id}` |

#### Response

Returns the response object with updated status.

---

### Delete Response

**DELETE** `/api/v1/responses/{response_id}`

Delete a response.

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `response_id` | string | Response ID in format `resp_{task_id}` |

#### Response

```json
{
  "id": "resp_123",
  "object": "response",
  "deleted": true
}
```

---

## Response Status

| Status | Description |
|--------|-------------|
| `queued` | Task is waiting to be executed (Executor-based teams) |
| `in_progress` | Task is currently running |
| `completed` | Task completed successfully |
| `failed` | Task failed with an error |
| `cancelled` | Task was cancelled |
| `incomplete` | Task was partially completed |

---

## System Configuration

The following environment variables affect the Responses API behavior:

| Variable | Default | Description |
|----------|---------|-------------|
| `WEB_SEARCH_ENABLED` | `false` | Enable web search capability |
| `WEB_SEARCH_DEFAULT_MAX_RESULTS` | `100` | Default max results for web search |
| `CHAT_MCP_ENABLED` | `false` | Enable MCP tools in Chat Shell mode |

---

## Usage Examples

### Python

```python
import requests

API_URL = "http://localhost:8000/api/v1/responses"
API_KEY = "your-api-key"

headers = {
    "Authorization": f"Bearer {API_KEY}",
    "Content-Type": "application/json"
}

# Simple request
response = requests.post(
    API_URL,
    headers=headers,
    json={
        "model": "default#my-team",
        "input": "Hello, world!"
    }
)
print(response.json())

# With deep thinking
response = requests.post(
    API_URL,
    headers=headers,
    json={
        "model": "default#my-team",
        "input": "Research quantum computing",
        "tools": [{"type": "wegent_deep_thinking"}]
    }
)
print(response.json())

# Disable wecode features for raw LLM access
response = requests.post(
    API_URL,
    headers=headers,
    json={
        "model": "default#my-team",
        "input": "Hello",
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
# Simple request
curl -X POST http://localhost:8000/api/v1/responses \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "default#my-team",
    "input": "Hello, world!"
  }'

# Streaming
curl -X POST http://localhost:8000/api/v1/responses \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "default#my-team",
    "input": "Tell me a story",
    "stream": true
  }'

# With tools disabled
curl -X POST http://localhost:8000/api/v1/responses \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "default#my-team",
    "input": "Hello",
    "tools": [
      {"type": "disable_wegent_tools"},
      {"type": "disable_wegent_extend_message"}
    ]
  }'
```

---

## Related Resources

- [Managing Tasks](../guides/user/managing-tasks.md) - Task management guide
- [Creating Teams](../guides/user/creating-teams.md) - Team creation guide
- [Configuring Shells](../guides/user/configuring-shells.md) - Shell type configuration
