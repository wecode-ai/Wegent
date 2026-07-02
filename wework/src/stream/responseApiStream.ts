import type { ChatBlock, RuntimeGoal } from '@/types/api'
import type { ChatStreamHandlers } from './chatStream'

export const RESPONSE_API_STREAM_EVENTS = [
  'response.created',
  'response.in_progress',
  'response.completed',
  'response.failed',
  'response.incomplete',
  'response.reasoning_summary_part.added',
  'response.reasoning_summary_text.delta',
  'response.output_item.added',
  'response.output_item.done',
  'response.content_part.added',
  'response.content_part.done',
  'response.output_text.delta',
  'response.output_text.annotation.added',
  'response.output_text.done',
  'response.refusal.delta',
  'response.refusal.done',
  'response.function_call_arguments.delta',
  'response.function_call_arguments.done',
  'response.file_search_call.in_progress',
  'response.file_search_call.searching',
  'response.file_search_call.completed',
  'response.web_search_call.in_progress',
  'response.web_search_call.searching',
  'response.web_search_call.completed',
  'response.mcp_list_tools.in_progress',
  'response.mcp_list_tools.completed',
  'response.mcp_list_tools.failed',
  'response.mcp_call.in_progress',
  'response.mcp_call_arguments.delta',
  'response.mcp_call_arguments.done',
  'response.mcp_call.completed',
  'response.mcp_call.failed',
  'image_generation.partial_image',
  'response.block.created',
  'response.block.updated',
  'response.subagent.activity',
  'runtime.goal.updated',
  'runtime.goal.cleared',
  'response.status.updated',
  'error',
] as const

export interface ResponseApiStreamState {
  toolContexts: Map<string, { name?: string; input?: Record<string, unknown> }>
}

export function createResponseApiStreamState(): ResponseApiStreamState {
  return { toolContexts: new Map() }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  return typeof value === 'number' ? value : 0
}

function optionalNumberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' ? value : undefined
}

function recordField(record: Record<string, unknown>, key: string): Record<string, unknown> {
  return asRecord(record[key])
}

function eventBase(payload: Record<string, unknown>) {
  return {
    task_id: numberField(payload, 'task_id'),
    subtask_id: numberField(payload, 'subtask_id'),
    message_id: optionalNumberField(payload, 'message_id'),
    device_id: stringField(payload, 'device_id'),
    local_task_id: stringField(payload, 'local_task_id'),
  }
}

function eventResult(payload: Record<string, unknown>): Record<string, unknown> {
  return asRecord(payload.data)
}

function parseRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value !== 'string' || !value.trim()) return undefined

  try {
    const parsed = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function eventContent(payload: Record<string, unknown>): string {
  const result = eventResult(payload)
  return (
    stringField(result, 'delta') ??
    stringField(result, 'value') ??
    stringField(result, 'output_text') ??
    ''
  )
}

function completedContent(data: Record<string, unknown>): string | undefined {
  const explicit = stringField(data, 'value') ?? stringField(data, 'output_text')
  if (explicit) return explicit

  const response = recordField(data, 'response')
  const output = response.output
  if (!Array.isArray(output)) return undefined

  const parts = output.flatMap(item => {
    const itemRecord = asRecord(item)
    const content = itemRecord.content
    if (!Array.isArray(content)) return []
    return content.flatMap(part => {
      const partRecord = asRecord(part)
      if (partRecord.type !== 'output_text') return []
      const text = stringField(partRecord, 'text')
      return text ? [text] : []
    })
  })

  return parts.join('')
}

function completedResult(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...data }
  const content = completedContent(data)
  if (content !== undefined) {
    result.value = content
  }

  const response = recordField(data, 'response')
  const fileChanges = response.file_changes ?? response.fileChanges ?? data.file_changes
  if (typeof fileChanges === 'object' && fileChanges !== null && !Array.isArray(fileChanges)) {
    result.file_changes = fileChanges
  }
  const blocks = response.blocks ?? data.blocks
  if (Array.isArray(blocks)) {
    result.blocks = blocks
  }

  return result
}

function reasoningContent(eventName: string, data: Record<string, unknown>): string {
  if (eventName === 'response.reasoning_summary_text.delta') {
    return stringField(data, 'delta') ?? ''
  }

  const part = recordField(data, 'part')
  return part.type === 'reasoning' ? (stringField(part, 'text') ?? '') : ''
}

function callIdFromItem(item: Record<string, unknown>): string | undefined {
  return stringField(item, 'call_id') ?? stringField(item, 'callId') ?? stringField(item, 'id')
}

function callIdFromData(data: Record<string, unknown>): string | undefined {
  return stringField(data, 'call_id') ?? stringField(data, 'callId') ?? stringField(data, 'item_id')
}

function normalizeToolName(item: Record<string, unknown>): string {
  const itemType = stringField(item, 'type')
  const rawName =
    stringField(item, 'name') ??
    stringField(item, 'server_label') ??
    (itemType === 'shell_call' ? 'bash' : undefined) ??
    (itemType === 'mcp_call' ? 'mcp' : 'unknown')
  if (rawName === 'exec_command') return 'bash'
  if (rawName === 'exec') return 'bash'
  return rawName
}

function normalizeToolInput(input: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!input) return {}
  const normalized = { ...input }
  if ('cmd' in normalized && !('command' in normalized)) {
    normalized.command = normalized.cmd
    delete normalized.cmd
  }
  if ('commandLine' in normalized && !('command' in normalized)) {
    normalized.command = normalized.commandLine
    delete normalized.commandLine
  }
  if ('workdir' in normalized && !('cwd' in normalized)) {
    normalized.cwd = normalized.workdir
    delete normalized.workdir
  }
  return normalized
}

function toolInputFrom(
  data: Record<string, unknown>,
  item: Record<string, unknown>
): Record<string, unknown> {
  const argumentsSummary = parseRecord(data.arguments_summary)
  if (argumentsSummary) return normalizeToolInput(argumentsSummary)

  const itemInput = parseRecord(item.input)
  if (itemInput) return normalizeToolInput(itemInput)

  const itemArguments = parseRecord(item.arguments)
  if (itemArguments) return normalizeToolInput(itemArguments)

  const dataArguments = parseRecord(data.arguments)
  if (dataArguments) return normalizeToolInput(dataArguments)

  const action = recordField(item, 'action')
  const commands = action.commands
  if (Array.isArray(commands)) {
    const command = commands
      .filter((value): value is string => typeof value === 'string')
      .join('\n')
    return command ? { command } : {}
  }

  return {}
}

function responseToolItem(data: Record<string, unknown>): Record<string, unknown> {
  return recordField(data, 'item')
}

function isToolItem(item: Record<string, unknown>): boolean {
  return ['function_call', 'mcp_call', 'shell_call'].includes(stringField(item, 'type') ?? '')
}

function toolStatusFromItem(
  item: Record<string, unknown>,
  fallback: ChatBlock['status']
): ChatBlock['status'] {
  const status = stringField(item, 'status')
  return status === 'error' || status === 'failed' ? 'error' : fallback
}

function emitBlockCreated(
  handlers: ChatStreamHandlers,
  base: ReturnType<typeof eventBase>,
  data: Record<string, unknown>,
  state: ResponseApiStreamState
): void {
  const item = responseToolItem(data)
  if (!isToolItem(item)) return

  const callId = callIdFromItem(item)
  if (!callId) return

  const toolInput = toolInputFrom(data, item)
  const toolName = normalizeToolName(item)
  state.toolContexts.set(callId, { name: toolName, input: toolInput })

  handlers.onBlockCreated?.({
    ...base,
    block: {
      id: callId,
      type: 'tool',
      tool_use_id: callId,
      tool_name: toolName,
      tool_input: toolInput,
      status: data.argument_status === 'streaming' ? 'generating_arguments' : 'pending',
      timestamp: Date.now(),
    },
  })
}

function emitBlockUpdated(
  handlers: ChatStreamHandlers,
  base: ReturnType<typeof eventBase>,
  blockId: string | undefined,
  updates: {
    status?: ChatBlock['status'] | 'running'
    tool_input?: Record<string, unknown>
    tool_output?: unknown
    content?: string
  }
): void {
  if (!blockId) return
  handlers.onBlockUpdated?.({
    ...base,
    block_id: blockId,
    ...updates,
  })
}

function emitToolArgumentsUpdate(
  handlers: ChatStreamHandlers,
  base: ReturnType<typeof eventBase>,
  data: Record<string, unknown>,
  state: ResponseApiStreamState,
  status: ChatBlock['status']
): void {
  const callId = callIdFromData(data)
  if (!callId) return

  const toolInput = toolInputFrom(data, {})
  const previous = state.toolContexts.get(callId) ?? {}
  const nextInput = Object.keys(toolInput).length > 0 ? toolInput : previous.input
  state.toolContexts.set(callId, { ...previous, input: nextInput })

  emitBlockUpdated(handlers, base, callId, {
    status,
    ...(nextInput && { tool_input: nextInput }),
  })
}

function emitToolDone(
  handlers: ChatStreamHandlers,
  base: ReturnType<typeof eventBase>,
  data: Record<string, unknown>,
  state: ResponseApiStreamState
): void {
  const item = responseToolItem(data)
  const callId = callIdFromItem(item) ?? callIdFromData(data)
  if (!callId) return

  const previous = state.toolContexts.get(callId)
  const toolInput = toolInputFrom(data, item)
  const nextInput = Object.keys(toolInput).length > 0 ? toolInput : previous?.input
  const toolOutput = item.output ?? data.output ?? data.failure_reason
  const status = toolStatusFromItem(item, data.failure_reason ? 'error' : 'done')

  emitBlockUpdated(handlers, base, callId, {
    status,
    ...(nextInput && { tool_input: nextInput }),
    ...(toolOutput !== undefined && { tool_output: toolOutput }),
  })

  state.toolContexts.delete(callId)
}

function emitResponseBlockCreated(
  handlers: ChatStreamHandlers,
  base: ReturnType<typeof eventBase>,
  data: Record<string, unknown>
): void {
  const block = data.block
  if (typeof block !== 'object' || block === null || Array.isArray(block)) return
  handlers.onBlockCreated?.({
    ...base,
    block: block as ChatBlock,
  })
}

function emitResponseBlockUpdated(
  handlers: ChatStreamHandlers,
  base: ReturnType<typeof eventBase>,
  data: Record<string, unknown>
): void {
  const updates = recordField(data, 'updates')
  const toolInput = parseRecord(updates.tool_input)
  emitBlockUpdated(handlers, base, stringField(data, 'block_id'), {
    ...(typeof updates.content === 'string' && { content: updates.content }),
    ...(typeof updates.tool_output !== 'undefined' && { tool_output: updates.tool_output }),
    ...(toolInput && { tool_input: toolInput }),
    ...(typeof updates.status === 'string' && {
      status: updates.status as ChatBlock['status'],
    }),
  })
}

function emitSubagentActivity(
  handlers: ChatStreamHandlers,
  base: ReturnType<typeof eventBase>,
  data: Record<string, unknown>
): void {
  const agentPath = stringField(data, 'agent_path') ?? stringField(data, 'agentPath')
  if (!agentPath) return

  handlers.onSubagentActivity?.({
    ...base,
    agent_path: agentPath,
    agent_name: stringField(data, 'agent_name') ?? stringField(data, 'agentName'),
    agent_thread_id: stringField(data, 'agent_thread_id') ?? stringField(data, 'agentThreadId'),
    kind: stringField(data, 'kind'),
    status: stringField(data, 'status'),
    occurred_at_ms:
      optionalNumberField(data, 'occurred_at_ms') ?? optionalNumberField(data, 'occurredAtMs'),
  })
}

function errorMessage(payload: Record<string, unknown>, data: Record<string, unknown>): string {
  const error = data.error
  if (typeof error === 'string') return error
  const errorRecord = asRecord(error)
  return (
    stringField(payload, 'error') ??
    stringField(data, 'message') ??
    stringField(errorRecord, 'message') ??
    eventContent(payload) ??
    'Response stream error'
  )
}

export function emitResponseApiEvent(
  handlers: ChatStreamHandlers,
  eventName: string,
  rawPayload: unknown,
  state: ResponseApiStreamState
): void {
  const payload = asRecord(rawPayload)
  const base = eventBase(payload)
  const data = eventResult(payload)

  if (eventName === 'response.created' || eventName === 'response.in_progress') {
    handlers.onChatStart?.({
      ...base,
      shell_type: stringField(payload, 'runtime'),
    })
    return
  }

  if (eventName === 'response.output_text.delta' || eventName === 'response.refusal.delta') {
    handlers.onChatChunk?.({
      ...base,
      content: eventContent(payload),
      offset: numberField(payload, 'offset'),
      result: eventResult(payload),
    })
    return
  }

  if (
    eventName === 'response.reasoning_summary_text.delta' ||
    eventName === 'response.reasoning_summary_part.added'
  ) {
    const content = reasoningContent(eventName, data)
    if (!content) return
    handlers.onChatChunk?.({
      ...base,
      content: '',
      offset: numberField(payload, 'offset'),
      result: { reasoning_chunk: content },
    })
    return
  }

  if (eventName === 'response.block.created') {
    emitResponseBlockCreated(handlers, base, data)
    return
  }

  if (eventName === 'response.block.updated') {
    emitResponseBlockUpdated(handlers, base, data)
    return
  }

  if (eventName === 'response.subagent.activity') {
    emitSubagentActivity(handlers, base, data)
    return
  }

  if (eventName === 'runtime.goal.updated') {
    handlers.onRuntimeGoalUpdated?.({
      ...base,
      thread_id: stringField(data, 'thread_id') ?? stringField(data, 'threadId'),
      goal: (data.goal ?? null) as RuntimeGoal | null,
    })
    return
  }

  if (eventName === 'runtime.goal.cleared') {
    handlers.onRuntimeGoalCleared?.({
      ...base,
      thread_id: stringField(data, 'thread_id') ?? stringField(data, 'threadId'),
      goal: null,
    })
    return
  }

  if (eventName === 'response.output_item.added') {
    emitBlockCreated(handlers, base, data, state)
    return
  }

  if (
    eventName === 'response.function_call_arguments.delta' ||
    eventName === 'response.mcp_call_arguments.delta'
  ) {
    emitToolArgumentsUpdate(handlers, base, data, state, 'generating_arguments')
    return
  }

  if (
    eventName === 'response.function_call_arguments.done' ||
    eventName === 'response.mcp_call_arguments.done'
  ) {
    emitToolArgumentsUpdate(handlers, base, data, state, 'pending')
    return
  }

  if (
    eventName === 'response.output_item.done' ||
    eventName === 'response.mcp_call.completed' ||
    eventName === 'response.mcp_call.failed'
  ) {
    emitToolDone(handlers, base, data, state)
    return
  }

  if (eventName === 'response.completed') {
    handlers.onChatDone?.({
      ...base,
      offset: numberField(payload, 'offset'),
      result: completedResult(data),
    })
    return
  }

  if (
    eventName === 'response.incomplete' ||
    eventName === 'response.failed' ||
    eventName === 'error'
  ) {
    handlers.onChatError?.({
      ...base,
      error: errorMessage(payload, data),
      type: stringField(payload, 'type') ?? eventName,
    })
  }
}
