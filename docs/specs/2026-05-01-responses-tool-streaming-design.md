---
sidebar_position: 1
---

# Wegent `v1/responses` Tool Streaming Spec

## Goal

Add tool-call streaming events to `wegent /api/v1/responses` so external clients do not experience long silent gaps while the AI is invoking tools, while keeping the protocol aligned with OpenAI Responses semantics.

## Scope

This version only changes `wegent`'s `v1/responses` streaming protocol layer.

It does not change:

- `abtest`
- `abtest-fe`
- Wegent frontend rendering behavior
- Wegent custom tool event families

The implementation should stay narrowly scoped to the openapi request schema, execution-to-openapi event mapping, and SSE formatting.

## Protocol Principles

- If the actual tool invocation is an MCP tool, expose it as native `mcp_call`.
- If the actual tool invocation is a non-MCP internal structured tool, expose it as native `function_call`.
- Preserve the concrete tool name. Do not collapse everything to a generic tool type.
- `skill`, `wegent_chat_bot`, and `knowledge_base` are configuration or assembly concepts, not execution event types.
- Standard tool events do not require a Wegent-private feature flag. If a streaming request actually invokes a tool, the corresponding standard events should be emitted.

## Request Contract

Keep the existing `POST /api/v1/responses` contract.

The only Wegent-specific extension in this version is:

```json
{
  "wegent_options": {
    "include_task_context": true
  }
}
```

Notes:

- `include_task_context` is optional and defaults to `false`.
- This version does not add a private switch such as `stream_tool_events`.

## Streaming Events

### Non-MCP Tools

For non-MCP internal tools, emit native `function_call` events.

Minimum event set for this version:

- `response.output_item.added`
- `response.function_call_arguments.done`
- `response.output_item.done`

### MCP Tools

For MCP tools, emit native `mcp_call` events.

Minimum event set for this version:

- `response.output_item.added`
- `response.mcp_call_arguments.done`
- `response.mcp_call.in_progress`
- `response.mcp_call.completed` or `response.mcp_call.failed`
- `response.output_item.done`

### Text and Reasoning

Existing text and reasoning behavior remains unchanged:

- `response.created`
- `response.in_progress`
- reasoning events
- `response.output_text.delta`
- `response.completed`
- error events

### Optional Wegent Extension

When `wegent_options.include_task_context = true`, emit:

```json
{
  "type": "response.task_context",
  "response_id": "resp_123",
  "task_id": 123,
  "task_path": "/chat?task_id=123"
}
```

This is a Wegent extension and not an OpenAI standard event.

## Field Requirements

### `function_call`

- preserve `name`
- preserve `arguments`
- preserve a stable call ID

### `mcp_call`

- preserve `name`
- preserve `server_label`
- preserve `arguments`
- preserve a stable item ID

This version does not add `display_name`.

## Parameter Delta Events

`response.function_call_arguments.delta` and `response.mcp_call_arguments.delta` are both native OpenAI Responses streaming events.

To keep the first implementation small, this version does not emit either delta event.

This version only emits:

- `response.function_call_arguments.done`
- `response.mcp_call_arguments.done`

Rationale:

- The main product problem is silent tool execution, not incremental argument display.
- The minimum useful event set is enough to remove the apparent freeze.
- Deferring delta events reduces the implementation fan-out across execution mapping and SSE formatting.

## Behavioral Constraints

- Do not treat "arguments finished" as "tool execution finished".
- `function_call_arguments.done` only means the model has finished producing tool arguments.
- `response.mcp_call.in_progress`, `response.mcp_call.completed`, and `response.mcp_call.failed` must only be emitted for real MCP execution state transitions.
- This version does not stream full tool outputs to external clients.

## Non-Goals

This version does not include:

- `display_name`
- custom `response.tool_call.*` events
- `response.function_call_arguments.delta`
- `response.mcp_call_arguments.delta`
- large tool output payload streaming
- frontend or proxy consumption changes

## Compatibility

- Existing text-only clients should continue to work without changes.
- The new tool events only improve observability and do not change the semantics of existing text output.

## Implementation Boundaries

Implementation should stay concentrated in:

- openapi request schema
- execution-to-openapi event mapping
- `v1/responses` raw stream assembly
- SSE event formatting

Avoid expanding this version into unrelated business logic or frontend work.
