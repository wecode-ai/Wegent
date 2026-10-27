import type * as http from 'http'
import { writeAnthropicSseEvent } from './mock-anthropic'
import { resolveToolName } from './model-tool-discovery'

export interface ToolCallRule {
  toolName: string
  arguments: Record<string, unknown>
}

export interface ToolResponse {
  id: string
  nameIncludes: string
  input: Record<string, unknown>
  text?: string
}

function writeJson(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(value))
}

export function writeAnthropicStreamingToolCalls(
  res: http.ServerResponse,
  request: unknown,
  model: string,
  toolCalls: ToolCallRule[]
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  writeAnthropicSseEvent(res, 'message_start', {
    type: 'message_start',
    message: {
      id: `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      usage: { input_tokens: 100, output_tokens: 0 },
    },
  })
  toolCalls.forEach((toolCall, index) => {
    writeAnthropicSseEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index,
      content_block: {
        type: 'tool_use',
        id: `toolu_${Date.now()}_${index}`,
        name: resolveToolName(request, toolCall.toolName),
        input: {},
      },
    })
    writeAnthropicSseEvent(res, 'content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: {
        type: 'input_json_delta',
        partial_json: JSON.stringify(toolCall.arguments),
      },
    })
    writeAnthropicSseEvent(res, 'content_block_stop', {
      type: 'content_block_stop',
      index,
    })
  })
  writeAnthropicSseEvent(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use', stop_sequence: null },
    usage: { output_tokens: toolCalls.length * 10 },
  })
  writeAnthropicSseEvent(res, 'message_stop', { type: 'message_stop' })
  res.end()
}

export function writeAnthropicJsonToolCalls(
  res: http.ServerResponse,
  request: unknown,
  model: string,
  toolCalls: ToolCallRule[]
): void {
  writeJson(res, 200, {
    id: `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model,
    content: toolCalls.map((toolCall, index) => ({
      type: 'tool_use',
      id: `toolu_${Date.now()}_${index}`,
      name: resolveToolName(request, toolCall.toolName),
      input: toolCall.arguments,
    })),
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: toolCalls.length * 10 },
  })
}

function findToolName(request: unknown, nameIncludes: string): string | null {
  const body = request as { tools?: Array<{ name?: string }> } | null
  return (
    body?.tools?.find(tool => typeof tool.name === 'string' && tool.name.includes(nameIncludes))
      ?.name ?? null
  )
}

export function writeAnthropicToolUseResponse(
  res: http.ServerResponse,
  request: unknown,
  tool: ToolResponse,
  model: string
): void {
  const toolName = findToolName(request, tool.nameIncludes)
  if (!toolName) {
    writeJson(res, 400, {
      error: `Configured response tool was not offered: ${tool.nameIncludes}`,
    })
    return
  }
  const input = JSON.stringify(tool.input)

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  writeAnthropicSseEvent(res, 'message_start', {
    type: 'message_start',
    message: {
      id: `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 100,
        output_tokens: 0,
      },
    },
  })
  let toolBlockIndex = 0
  if (tool.text) {
    writeAnthropicSseEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'text',
        text: '',
      },
    })
    writeAnthropicSseEvent(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'text_delta',
        text: tool.text,
      },
    })
    writeAnthropicSseEvent(res, 'content_block_stop', {
      type: 'content_block_stop',
      index: 0,
    })
    toolBlockIndex = 1
  }
  writeAnthropicSseEvent(res, 'content_block_start', {
    type: 'content_block_start',
    index: toolBlockIndex,
    content_block: {
      type: 'tool_use',
      id: tool.id,
      name: toolName,
      input: {},
    },
  })
  writeAnthropicSseEvent(res, 'content_block_delta', {
    type: 'content_block_delta',
    index: toolBlockIndex,
    delta: {
      type: 'input_json_delta',
      partial_json: input,
    },
  })
  writeAnthropicSseEvent(res, 'content_block_stop', {
    type: 'content_block_stop',
    index: toolBlockIndex,
  })
  writeAnthropicSseEvent(res, 'message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: 'tool_use',
      stop_sequence: null,
    },
    usage: {
      output_tokens: 1,
    },
  })
  writeAnthropicSseEvent(res, 'message_stop', {
    type: 'message_stop',
  })
  res.end()
}
