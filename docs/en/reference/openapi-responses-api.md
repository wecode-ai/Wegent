# OpenAPI v1/responses API

This document describes the OpenAPI v1/responses endpoint, which provides an OpenAI Responses API compatible interface for interacting with Wegent agents (Teams).

## Overview

The `/api/v1/responses` endpoint allows external applications to interact with Wegent agents using a format compatible with OpenAI's Responses API. This makes it easy to integrate Wegent into existing applications that already support the OpenAI API format.

## Authentication

All endpoints require authentication via one of the following methods:

- **Bearer Token**: `Authorization: Bearer <access_token>`
- **API Key**: `X-API-Key: <api_key>`

### Obtaining an API Key

1. Log in to the Wegent frontend
2. Click the **Settings** icon in the bottom left corner
3. Select the **AI Keys** menu
4. Click the **Create Personal Key** button
5. Copy the generated API Key for API calls

## Base URL

```
/api/v1/responses
```

## Endpoints

### Create Response

Creates a new response (executes a task).

```
POST /api/v1/responses
```

#### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `model` | string | Yes | Agent identifier. Format: `namespace#team_name` or `namespace#team_name#model_id` |
| `input` | string \| array | Yes | User input prompt or conversation history |
| `stream` | boolean | No | Enable streaming output (default: `false`) |
| `previous_response_id` | string | No | Previous response ID for follow-up conversations |
| `tools` | array | No | Wegent custom tools configuration |

#### Model Format

The `model` field specifies which agent (Team) to use:

- `namespace#team_name` - Use the default model configured in the Team's Bot
- `namespace#team_name#model_id` - Override with a specific model

Examples:
- `default#my-assistant`
- `my-group#coding-agent#gpt-4o`

#### Input Format

The `input` field supports two formats:

**Simple string:**
```json
{
  "input": "Hello, how are you?"
}
```

**Conversation history (for multi-turn):**
```json
{
  "input": [
    {"type": "message", "role": "user", "content": "What is 2+2?"},
    {"type": "message", "role": "assistant", "content": "2+2 equals 4."},
    {"type": "message", "role": "user", "content": "What about 3+3?"}
  ]
}
```

#### Tools Configuration

The `tools` array enables additional server-side capabilities:

```json
{
  "tools": [
    {"type": "wegent_chat_bot"}
  ]
}
```

| Tool Type | Description |
|-----------|-------------|
| `wegent_chat_bot` | Enable all server-side capabilities (deep thinking, web search, server MCP tools, message enhancement) |
| `mcp` | Add custom MCP servers |
| `skill` | Preload specific skills |

**MCP Server Configuration:**
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

**Skill Preloading:**
```json
{
  "tools": [
    {"type": "skill", "preload_skills": ["skill_a", "skill_b"]}
  ]
}
```

#### Response Behavior

The response behavior depends on the Team's Shell type:

| Shell Type | Streaming Support | Response Mode |
|------------|-------------------|---------------|
| Chat Shell | Yes | Synchronous or SSE streaming |
| Others (ClaudeCode, Agno, Dify) | No | Queued (poll for completion) |

**Chat Shell (stream=false):**
- Blocks until LLM completes
- Returns completed response directly

**Chat Shell (stream=true):**
- Returns SSE stream with OpenAI v1/responses compatible events

**Non-Chat Shell:**
- Returns immediately with status `queued`
- Use `GET /api/v1/responses/{response_id}` to poll for completion

#### Example Request

```bash
curl -X POST "https://your-domain/api/v1/responses" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "default#my-assistant",
    "input": "Tell me a joke",
    "stream": false
  }'
```

#### Example Response

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
      "content": [{"type": "output_text", "text": "Tell me a joke", "annotations": []}]
    },
    {
      "type": "message",
      "id": "msg_789",
      "status": "completed",
      "role": "assistant",
      "content": [{"type": "output_text", "text": "Why did the programmer quit? Because he didn't get arrays!", "annotations": []}]
    }
  ],
  "error": null,
  "previous_response_id": null
}
```

---

### Get Response

Retrieves a response by ID.

```
GET /api/v1/responses/{response_id}
```

#### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `response_id` | string | Response ID in format `resp_{task_id}` |

#### Example Request

```bash
curl "https://your-domain/api/v1/responses/resp_123" \
  -H "Authorization: Bearer <token>"
```

---

### Cancel Response

Cancels a running response.

```
POST /api/v1/responses/{response_id}/cancel
```

#### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `response_id` | string | Response ID in format `resp_{task_id}` |

#### Behavior

- **Chat Shell tasks**: Stops the model request and saves partial content
- **Executor-based tasks**: Calls executor_manager to cancel

#### Example Request

```bash
curl -X POST "https://your-domain/api/v1/responses/resp_123/cancel" \
  -H "Authorization: Bearer <token>"
```

---

### Delete Response

Deletes a response.

```
DELETE /api/v1/responses/{response_id}
```

#### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `response_id` | string | Response ID in format `resp_{task_id}` |

#### Example Request

```bash
curl -X DELETE "https://your-domain/api/v1/responses/resp_123" \
  -H "Authorization: Bearer <token>"
```

#### Example Response

```json
{
  "id": "resp_123",
  "object": "response",
  "deleted": true
}
```

---

## Streaming Events

When `stream=true` is set (Chat Shell type only), the API returns Server-Sent Events (SSE) in OpenAI v1/responses format.

### Event Types

| Event Type | Description |
|------------|-------------|
| `response.created` | Response has been created |
| `response.output_item.added` | New output item (message) added |
| `response.content_part.added` | New content part added to message |
| `response.output_text.delta` | Text chunk received |
| `response.output_text.done` | Text output completed |
| `response.content_part.done` | Content part completed |
| `response.output_item.done` | Output item completed |
| `response.completed` | Response fully completed |
| `response.failed` | Response failed with error |

### Example SSE Stream

```
event: response.created
data: {"type":"response.created","response":{"id":"resp_123","status":"in_progress",...}}

event: response.output_item.added
data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","role":"assistant"}}

event: response.content_part.added
data: {"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text","text":""}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"Hello"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":" world!"}

event: response.output_text.done
data: {"type":"response.output_text.done","output_index":0,"content_index":0,"text":"Hello world!"}

event: response.completed
data: {"type":"response.completed","response":{"id":"resp_123","status":"completed",...}}
```

---

## Response Status

| Status | Description |
|--------|-------------|
| `queued` | Task is queued for execution (non-Chat Shell) |
| `in_progress` | Task is currently running |
| `completed` | Task completed successfully |
| `failed` | Task failed with error |
| `cancelled` | Task was cancelled |
| `incomplete` | Task partially completed |

---

## Error Handling

### HTTP Status Codes

| Code | Description |
|------|-------------|
| 200 | Success |
| 400 | Bad request (invalid parameters) |
| 401 | Unauthorized (missing or invalid authentication) |
| 404 | Resource not found |
| 500 | Internal server error |

### Error Response Format

```json
{
  "detail": "Error message describing what went wrong"
}
```

### Response Object Error

When a task fails, the `error` field contains:

```json
{
  "id": "resp_123",
  "status": "failed",
  "error": {
    "code": "task_failed",
    "message": "Detailed error message"
  },
  ...
}
```

---

## Follow-up Conversations

To continue a conversation, use `previous_response_id`:

```json
{
  "model": "default#my-assistant",
  "input": "Tell me another one",
  "previous_response_id": "resp_123"
}
```

This appends to the same task, maintaining conversation context.

---

## Notes

- By default, API calls use "clean mode" without server-side enhancements
- Bot/Ghost MCP tools configured in the CRD are always available
- Use `wegent_chat_bot` tool to enable full server-side capabilities
- Streaming is only supported for Chat Shell type Teams
