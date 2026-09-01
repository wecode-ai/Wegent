import type {
  ChatBlockStatus,
  ChatFileChangesSummary,
  ChatMessage,
  ChatProcessingBlock,
  ChatTextItem,
  RuntimeTranscriptMessage,
} from '@/types/runtime'

export interface RuntimeStreamEvent {
  name: string
  payload: Record<string, unknown>
}

export type ChatAction =
  | { type: 'replace'; messages: RuntimeTranscriptMessage[] }
  | { type: 'optimistic-user'; id: string; content: string; createdAt: number }
  | { type: 'stream'; event: RuntimeStreamEvent }
  | { type: 'fail'; id: string; error: string }

interface StreamIdentity {
  taskId?: string
  subtaskId: string
}

interface BlockUpdates {
  content?: string
  contentDelta?: string
  toolInput?: Record<string, unknown>
  toolOutput?: unknown
  toolOutputDelta?: string
  renderPayload?: unknown
  status?: ChatBlockStatus
  completedAt?: number
  durationMs?: number
}

export function chatReducer(state: ChatMessage[], action: ChatAction): ChatMessage[] {
  switch (action.type) {
    case 'replace':
      return uniqueMessages(
        action.messages
          .filter(message => ['user', 'assistant', 'system'].includes(message.role))
          .map(toChatMessage)
      )
    case 'optimistic-user':
      return upsertMessage(state, {
        id: action.id,
        role: 'user',
        content: action.content,
        status: 'completed',
        createdAt: action.createdAt,
      })
    case 'fail':
      return updateAssistantById(state, action.id, message => ({
        ...message,
        status: 'failed',
        streamingThinkingContent: undefined,
        error: action.error,
      }))
    case 'stream':
      return applyRuntimeEvent(state, action.event)
  }
}

function toChatMessage(message: RuntimeTranscriptMessage, index: number): ChatMessage {
  const role = message.role === 'user' ? 'user' : message.role === 'system' ? 'system' : 'assistant'
  const subtaskId = idValue(message.subtaskId)
  const createdAt = timestamp(message.createdAt ?? message.created_at)
  const blocks = subtaskId ? normalizeBlocks(subtaskId, message.blocks, createdAt) : undefined
  const turnId = message.turnId ?? message.turn_id
  const errorType = message.errorType ?? message.error_type
  const fileChanges = normalizeFileChanges(message.fileChanges ?? message.file_changes)
  return {
    id:
      role === 'user'
        ? (message.clientUserMessageId ?? message.client_user_message_id ?? message.id)
        : message.id || `history-${index}`,
    role,
    ...(subtaskId && { subtaskId }),
    ...(turnId && { turnId }),
    content: message.content ?? '',
    ...(blocks?.length && { blocks }),
    ...(fileChanges && { fileChanges }),
    status: terminalStatus(message.status),
    createdAt,
    ...((message.completedAt ?? message.completed_at) != null && {
      completedAt: timestamp(message.completedAt ?? message.completed_at),
    }),
    ...(message.error && { error: message.error }),
    ...(errorType && { errorType }),
  }
}

function applyRuntimeEvent(state: ChatMessage[], event: RuntimeStreamEvent): ChatMessage[] {
  const identity = streamIdentity(event.payload)
  if (!identity) return state
  const data = eventData(event.payload)

  if (event.name === 'response.created' || event.name === 'response.in_progress') {
    return updateAssistant(state, identity, message => ({
      ...clearError(message),
      status: 'streaming',
    }))
  }

  if (
    event.name === 'response.reasoning_summary_text.delta' ||
    event.name === 'response.reasoning_summary_part.added'
  ) {
    const chunk = reasoningContent(event.name, data)
    if (!chunk) return state
    return updateAssistant(state, identity, message =>
      appendReasoning(message, chunk, eventOffset(event.payload))
    )
  }

  if (event.name === 'response.output_text.delta' || event.name === 'response.refusal.delta') {
    const content = stringValue(data.delta)
    if (!content) return state
    const itemId = idValue(data.itemId) ?? idValue(data.item_id) ?? `text-${identity.subtaskId}`
    return updateAssistant(state, identity, message =>
      appendTextItem(message, itemId, content, eventOffset(event.payload), 'delta')
    )
  }

  if (event.name === 'response.output_text.done' || event.name === 'response.refusal.done') {
    const content =
      stringValue(data.text) ?? stringValue(data.value) ?? stringValue(data.output_text)
    const itemId = idValue(data.itemId) ?? idValue(data.item_id)
    if (!content || !itemId) return state
    return updateAssistant(state, identity, message =>
      appendTextItem(message, itemId, content, undefined, 'snapshot')
    )
  }

  if (event.name === 'response.block.created') {
    const block = normalizeBlock(identity.subtaskId, data.block, 0)
    return block ? updateAssistant(state, identity, message => createBlock(message, block)) : state
  }

  if (event.name === 'response.block.updated') {
    return applyResponseBlockUpdate(state, identity, data)
  }

  if (event.name === 'response.output_item.added') {
    const block = toolBlockFromItem(identity.subtaskId, data)
    return block ? updateAssistant(state, identity, message => createBlock(message, block)) : state
  }

  if (
    event.name === 'response.function_call_arguments.delta' ||
    event.name === 'response.mcp_call_arguments.delta' ||
    event.name === 'response.function_call_arguments.done' ||
    event.name === 'response.mcp_call_arguments.done'
  ) {
    const blockId = callIdFromData(data)
    if (!blockId) return state
    const toolInput = toolInputFrom(data, {})
    return updateAssistant(state, identity, message =>
      updateBlock(message, blockId, {
        ...(Object.keys(toolInput).length && { toolInput }),
        status: event.name.endsWith('.delta') ? 'generating_arguments' : 'pending',
      })
    )
  }

  if (
    event.name === 'response.output_item.done' ||
    event.name === 'response.mcp_call.completed' ||
    event.name === 'response.mcp_call.failed'
  ) {
    return applyToolDone(state, identity, data)
  }

  if (event.name === 'response.completed') {
    const authoritativeContent = completedText(data)
    const response = record(data.response)
    const rawBlocks = Array.isArray(response.blocks)
      ? response.blocks
      : Array.isArray(data.blocks)
        ? data.blocks
        : undefined
    const blocks = rawBlocks
      ? normalizeBlocks(identity.subtaskId, rawBlocks, Date.now())
      : undefined
    const fileChanges = normalizeFileChanges(
      response.file_changes ?? response.fileChanges ?? data.file_changes ?? data.fileChanges
    )
    return updateAssistant(state, identity, message => ({
      ...clearError(message),
      ...(authoritativeContent !== undefined && {
        content: authoritativeContent,
        textItems: undefined,
      }),
      ...(blocks && { blocks: finalizeBlocks(blocks, 'done') }),
      ...(!blocks && message.blocks && { blocks: finalizeBlocks(message.blocks, 'done') }),
      ...(fileChanges && { fileChanges }),
      status: 'completed',
      streamingThinkingContent: undefined,
      completedAt: Date.now(),
    }))
  }

  if (['response.failed', 'response.incomplete', 'error'].includes(event.name)) {
    return updateAssistant(state, identity, message => ({
      ...message,
      status: 'failed',
      streamingThinkingContent: undefined,
      blocks: finalizeBlocks(message.blocks, 'error'),
      error: streamError(event.payload, data),
      errorType: stringValue(event.payload.type) ?? event.name,
      completedAt: Date.now(),
    }))
  }

  return state
}

function appendReasoning(message: ChatMessage, chunk: string, offset?: number): ChatMessage {
  const blocks = [...(message.blocks ?? [])]
  const last = blocks.at(-1)
  if (last?.type === 'thinking' && last.status === 'streaming') {
    blocks[blocks.length - 1] = {
      ...last,
      content: appendDelta(last.content, chunk, offset),
    }
  } else {
    blocks.push({
      id: `thinking-${message.subtaskId}-${blocks.filter(block => block.type === 'thinking').length + 1}`,
      subtaskId: message.subtaskId ?? '',
      type: 'thinking',
      content: chunk,
      status: 'streaming',
      createdAt: Date.now(),
    })
  }
  return {
    ...clearError(message),
    blocks,
    streamingThinkingContent: latestThinking(blocks),
    status: 'streaming',
  }
}

function appendTextItem(
  message: ChatMessage,
  itemId: string,
  incoming: string,
  offset: number | undefined,
  mode: 'delta' | 'snapshot'
): ChatMessage {
  const items = [...(message.textItems ?? initialTextItems(message))]
  const index = items.findIndex(item => item.id === itemId)
  const current = index >= 0 ? items[index] : { id: itemId, content: '' }
  const content = mode === 'snapshot' ? incoming : appendDelta(current.content, incoming, offset)
  const next: ChatTextItem = {
    id: itemId,
    content,
    ...(mode === 'delta' && { streamOffset: codePointLength(content) }),
  }
  if (index >= 0) items[index] = next
  else items.push(next)
  return {
    ...clearError(message),
    textItems: items,
    content: items
      .map(item => item.content)
      .filter(Boolean)
      .join('\n\n'),
    streamingThinkingContent: undefined,
    status: 'streaming',
  }
}

function initialTextItems(message: ChatMessage): ChatTextItem[] {
  return message.content
    ? [{ id: `text-${message.subtaskId ?? message.id}`, content: message.content }]
    : []
}

function createBlock(message: ChatMessage, incoming: ChatProcessingBlock): ChatMessage {
  let blocks = finalizeNarrativeBlocks(message.blocks, incoming.createdAt)
  let content = message.content
  let textItems = message.textItems
  if (incoming.type !== 'text' && content.trim()) {
    blocks = mergeBlock(blocks, {
      id: `text-${message.subtaskId}-${blocks.filter(block => block.type === 'text').length + 1}`,
      subtaskId: message.subtaskId ?? incoming.subtaskId,
      type: 'text',
      content,
      status: 'done',
      createdAt: incoming.createdAt,
      completedAt: incoming.createdAt,
    })
    content = ''
    textItems = undefined
  }
  blocks = mergeBlock(blocks, incoming)
  return {
    ...clearError(message),
    content,
    textItems,
    blocks,
    status: isActiveStatus(incoming.status) ? 'streaming' : message.status,
    streamingThinkingContent:
      incoming.type === 'thinking' || incoming.type === 'tool'
        ? latestThinking(blocks)
        : incoming.type === 'text' || incoming.type === 'plan'
          ? undefined
          : message.streamingThinkingContent,
  }
}

function applyResponseBlockUpdate(
  state: ChatMessage[],
  identity: StreamIdentity,
  data: Record<string, unknown>
): ChatMessage[] {
  const inline = normalizeBlock(identity.subtaskId, data.block, 0)
  const blockId = idValue(data.blockId) ?? idValue(data.block_id) ?? inline?.id
  if (!blockId) return state
  const updates = blockUpdates(record(data.updates))
  return updateAssistant(state, identity, message => {
    const withBlock = inline ? createBlock(message, inline) : message
    return updateBlock(withBlock, blockId, updates)
  })
}

function blockUpdates(updates: Record<string, unknown>): BlockUpdates {
  const toolInput = parseRecord(updates.toolInput ?? updates.tool_input)
  const contentDelta = updates.contentDelta ?? updates.content_delta
  const toolOutputDelta = updates.toolOutputDelta ?? updates.tool_output_delta
  const completedAt = finiteNumber(updates.completedAt ?? updates.completed_at)
  const durationMs = finiteNumber(updates.durationMs ?? updates.duration_ms)
  return {
    ...(typeof updates.content === 'string' && { content: updates.content }),
    ...(typeof contentDelta === 'string' && { contentDelta }),
    ...(toolInput && { toolInput }),
    ...((updates.toolOutput ?? updates.tool_output) !== undefined && {
      toolOutput: updates.toolOutput ?? updates.tool_output,
    }),
    ...(typeof toolOutputDelta === 'string' && { toolOutputDelta }),
    ...((updates.renderPayload ?? updates.render_payload) !== undefined && {
      renderPayload: updates.renderPayload ?? updates.render_payload,
    }),
    ...(typeof updates.status === 'string' && {
      status: normalizeBlockStatus(updates.status),
    }),
    ...(completedAt !== undefined && { completedAt }),
    ...(durationMs !== undefined && { durationMs }),
  }
}

function updateBlock(message: ChatMessage, blockId: string, updates: BlockUpdates): ChatMessage {
  const current = message.blocks?.find(block => block.id === blockId)
  if (!current) return message
  const blocks = (message.blocks ?? []).map(block => {
    if (block.id !== blockId) return block
    const status = updates.status ?? block.status
    const timing = {
      ...(updates.durationMs !== undefined && { durationMs: Math.max(0, updates.durationMs) }),
      ...((updates.completedAt !== undefined || isTerminalBlockStatus(status)) && {
        completedAt:
          updates.completedAt ??
          (updates.durationMs !== undefined
            ? block.createdAt + Math.max(0, updates.durationMs)
            : (block.completedAt ?? Date.now())),
      }),
    }
    if (block.type === 'tool') {
      return {
        ...block,
        ...timing,
        status,
        ...(updates.toolInput && { toolInput: updates.toolInput }),
        ...(updates.toolOutput !== undefined && { toolOutput: updates.toolOutput }),
        ...(updates.toolOutputDelta !== undefined && {
          toolOutput: `${block.toolOutput ?? ''}${updates.toolOutputDelta}`,
        }),
        ...(updates.renderPayload !== undefined && { renderPayload: updates.renderPayload }),
      }
    }
    return {
      ...block,
      ...timing,
      status,
      ...(updates.content !== undefined && { content: updates.content }),
      ...(updates.contentDelta !== undefined && {
        content: `${block.content}${updates.contentDelta}`,
      }),
    }
  })
  return {
    ...clearError(message),
    blocks,
    status: updates.status && isActiveStatus(updates.status) ? 'streaming' : message.status,
    streamingThinkingContent:
      current.type === 'thinking'
        ? latestThinking(blocks)
        : current.type === 'text' || current.type === 'plan'
          ? undefined
          : message.streamingThinkingContent,
  }
}

function applyToolDone(
  state: ChatMessage[],
  identity: StreamIdentity,
  data: Record<string, unknown>
): ChatMessage[] {
  const item = record(data.item)
  const blockId = callIdFromItem(item) ?? callIdFromData(data)
  if (!blockId) return state
  const toolInput = toolInputFrom(data, item)
  const output = item.output ?? data.output ?? data.failure_reason
  const failed =
    data.failure_reason !== undefined || ['error', 'failed'].includes(String(item.status))
  return updateAssistant(state, identity, message =>
    updateBlock(message, blockId, {
      status: failed ? 'error' : 'done',
      ...(Object.keys(toolInput).length && { toolInput }),
      ...(output !== undefined && { toolOutput: output }),
      ...(item.renderPayload !== undefined && { renderPayload: item.renderPayload }),
    })
  )
}

function toolBlockFromItem(
  subtaskId: string,
  data: Record<string, unknown>
): ChatProcessingBlock | null {
  const item = record(data.item)
  const type = stringValue(item.type)
  if (
    !type ||
    !['function_call', 'mcp_call', 'shell_call', 'image_generation_call'].includes(type)
  ) {
    return null
  }
  const id = callIdFromItem(item)
  if (!id) return null
  return {
    id,
    subtaskId,
    type: 'tool',
    toolName: toolName(item),
    toolInput: toolInputFrom(data, item),
    ...(item.renderPayload !== undefined && { renderPayload: item.renderPayload }),
    status: data.argument_status === 'streaming' ? 'generating_arguments' : 'pending',
    createdAt: Date.now(),
  }
}

function normalizeBlocks(
  subtaskId: string,
  rawBlocks: unknown,
  fallbackTimestamp: number
): ChatProcessingBlock[] | undefined {
  if (!Array.isArray(rawBlocks)) return undefined
  const blocks = rawBlocks.flatMap((block, index) => {
    const normalized = normalizeBlock(subtaskId, block, fallbackTimestamp + index)
    return normalized ? [normalized] : []
  })
  return blocks.length ? blocks.sort((left, right) => left.createdAt - right.createdAt) : undefined
}

function normalizeBlock(
  subtaskId: string,
  value: unknown,
  fallbackTimestamp: number
): ChatProcessingBlock | null {
  const block = record(value)
  const type = stringValue(block.type)
  const id = idValue(block.id) ?? idValue(block.tool_use_id) ?? idValue(block.toolUseId)
  if (!type || !id) return null
  const createdAt = timestamp(
    (block.timestamp ?? block.created_at ?? block.createdAt) as string | number | null | undefined,
    fallbackTimestamp || Date.now()
  )
  const durationMs = finiteNumber(block.durationMs ?? block.duration_ms)
  const explicitCompletedAt = block.completedAt ?? block.completed_at
  const completedAt =
    durationMs !== undefined
      ? createdAt + Math.max(0, durationMs)
      : explicitCompletedAt != null
        ? timestamp(explicitCompletedAt as string | number)
        : undefined
  const status = normalizeBlockStatus(stringValue(block.status))
  const timing = {
    status,
    createdAt,
    ...(durationMs !== undefined && { durationMs: Math.max(0, durationMs) }),
    ...(completedAt !== undefined && { completedAt }),
  }
  if (type === 'tool') {
    const toolInput = parseRecord(block.toolInput ?? block.tool_input)
    return {
      id,
      subtaskId,
      type: 'tool',
      toolName: stringValue(block.toolName) ?? stringValue(block.tool_name) ?? 'unknown',
      ...(toolInput && { toolInput }),
      ...((block.toolOutput ?? block.tool_output) !== undefined && {
        toolOutput: block.toolOutput ?? block.tool_output,
      }),
      ...((block.renderPayload ?? block.render_payload) !== undefined && {
        renderPayload: block.renderPayload ?? block.render_payload,
      }),
      ...timing,
    }
  }
  if (type === 'image_generation_call') {
    return {
      id,
      subtaskId,
      type: 'tool',
      toolName: 'image_generation',
      renderPayload: {
        kind: 'image_generation',
        ...(typeof block.result === 'string' && { imageBase64: block.result }),
      },
      ...timing,
    }
  }
  if (['thinking', 'text', 'plan', 'error', 'guidance'].includes(type)) {
    return {
      id,
      subtaskId,
      type: type as 'thinking' | 'text' | 'plan' | 'error' | 'guidance',
      content: stringValue(block.content) ?? stringValue(block.text) ?? '',
      ...timing,
    }
  }
  return null
}

function updateAssistant(
  state: ChatMessage[],
  identity: StreamIdentity,
  update: (message: ChatMessage) => ChatMessage
): ChatMessage[] {
  const index = state.findIndex(
    message => message.role === 'assistant' && message.subtaskId === identity.subtaskId
  )
  if (index < 0) {
    return [
      ...state,
      update({
        id: `assistant-${identity.subtaskId}`,
        taskId: identity.taskId,
        subtaskId: identity.subtaskId,
        role: 'assistant',
        content: '',
        status: 'pending',
        createdAt: Date.now(),
      }),
    ]
  }
  return state.map((message, messageIndex) =>
    messageIndex === index
      ? update({ ...message, taskId: identity.taskId ?? message.taskId })
      : message
  )
}

function updateAssistantById(
  state: ChatMessage[],
  id: string,
  update: (message: ChatMessage) => ChatMessage
): ChatMessage[] {
  const index = state.findIndex(message => message.role === 'assistant' && message.id === id)
  if (index < 0) {
    return [
      ...state,
      update({
        id,
        role: 'assistant',
        content: '',
        status: 'pending',
        createdAt: Date.now(),
      }),
    ]
  }
  return state.map((message, messageIndex) => (messageIndex === index ? update(message) : message))
}

function streamIdentity(payload: Record<string, unknown>): StreamIdentity | null {
  const data = eventData(payload)
  const subtaskId = idValue(payload.subtaskId) ?? idValue(data.subtaskId)
  if (!subtaskId) return null
  return {
    subtaskId,
    taskId: idValue(payload.taskId) ?? idValue(data.taskId),
  }
}

function eventData(payload: Record<string, unknown>): Record<string, unknown> {
  return record(payload.data)
}

function eventOffset(payload: Record<string, unknown>): number | undefined {
  return finiteNumber(payload.offset) ?? finiteNumber(eventData(payload).offset)
}

function reasoningContent(name: string, data: Record<string, unknown>): string {
  if (name === 'response.reasoning_summary_text.delta') return stringValue(data.delta) ?? ''
  const part = record(data.part)
  return part.type === 'reasoning' ? (stringValue(part.text) ?? '') : ''
}

function completedText(data: Record<string, unknown>): string | undefined {
  const direct = stringValue(data.value) ?? stringValue(data.output_text)
  if (direct !== undefined) return direct
  const response = record(data.response)
  if (!Array.isArray(response.output)) return undefined
  return response.output
    .flatMap(item => {
      const content = record(item).content
      if (!Array.isArray(content)) return []
      return content.flatMap(part => {
        const value = record(part)
        return value.type === 'output_text' && typeof value.text === 'string' ? [value.text] : []
      })
    })
    .join('')
}

function streamError(payload: Record<string, unknown>, data: Record<string, unknown>): string {
  const error = data.error
  if (typeof error === 'string') return error
  return (
    stringValue(payload.error) ??
    stringValue(data.message) ??
    stringValue(record(error).message) ??
    stringValue(data.delta) ??
    'Response stream error'
  )
}

function toolInputFrom(
  data: Record<string, unknown>,
  item: Record<string, unknown>
): Record<string, unknown> {
  const input =
    parseRecord(data.arguments_summary) ??
    parseRecord(item.input) ??
    parseRecord(item.arguments) ??
    parseRecord(data.arguments) ??
    {}
  const normalized = { ...input }
  if ('cmd' in normalized && !('command' in normalized)) {
    normalized.command = normalized.cmd
    delete normalized.cmd
  }
  if ('workdir' in normalized && !('cwd' in normalized)) {
    normalized.cwd = normalized.workdir
    delete normalized.workdir
  }
  return normalized
}

function toolName(item: Record<string, unknown>): string {
  const type = stringValue(item.type)
  const name =
    stringValue(item.name) ??
    stringValue(item.server_label) ??
    (type === 'shell_call' ? 'bash' : type === 'mcp_call' ? 'mcp' : 'unknown')
  return name === 'exec_command' || name === 'exec' ? 'bash' : name
}

function callIdFromItem(item: Record<string, unknown>): string | undefined {
  return idValue(item.call_id) ?? idValue(item.callId) ?? idValue(item.id)
}

function callIdFromData(data: Record<string, unknown>): string | undefined {
  return idValue(data.call_id) ?? idValue(data.callId) ?? idValue(data.item_id)
}

function latestThinking(blocks: ChatProcessingBlock[] | undefined): string | undefined {
  if (!blocks) return undefined
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]
    if (block?.type === 'thinking' && block.content.trim()) return block.content
  }
  return undefined
}

function mergeBlock(
  blocks: ChatProcessingBlock[],
  incoming: ChatProcessingBlock
): ChatProcessingBlock[] {
  const index = blocks.findIndex(block => block.id === incoming.id)
  if (index < 0) return [...blocks, incoming]
  return blocks.map((block, blockIndex) => (blockIndex === index ? incoming : block))
}

function finalizeNarrativeBlocks(
  blocks: ChatProcessingBlock[] | undefined,
  nextCreatedAt: number
): ChatProcessingBlock[] {
  return (blocks ?? []).map(block => {
    if (
      block.type !== 'tool' &&
      ['thinking', 'text', 'plan'].includes(block.type) &&
      block.status === 'streaming'
    ) {
      return {
        ...block,
        status: 'done' as const,
        completedAt: block.completedAt ?? nextCreatedAt,
      }
    }
    return block
  })
}

function finalizeBlocks(
  blocks: ChatProcessingBlock[] | undefined,
  status: 'done' | 'error'
): ChatProcessingBlock[] | undefined {
  return blocks?.map(block =>
    isTerminalBlockStatus(block.status)
      ? block
      : { ...block, status, completedAt: block.completedAt ?? Date.now() }
  )
}

function normalizeBlockStatus(status?: string): ChatBlockStatus {
  const normalized = status
    ?.trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
  if (normalized === 'generating_arguments') return 'generating_arguments'
  if (normalized === 'streaming') return 'streaming'
  if (['done', 'completed', 'complete', 'success', 'succeeded'].includes(normalized ?? ''))
    return 'done'
  if (['error', 'failed', 'failure'].includes(normalized ?? '')) return 'error'
  return 'pending'
}

function isActiveStatus(status: ChatBlockStatus): boolean {
  return ['generating_arguments', 'pending', 'streaming'].includes(status)
}

function isTerminalBlockStatus(status: ChatBlockStatus): boolean {
  return status === 'done' || status === 'error'
}

function clearError(message: ChatMessage): ChatMessage {
  const { error: _error, errorType: _errorType, ...clear } = message
  return clear
}

function upsertMessage(state: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const index = state.findIndex(current => current.id === message.id)
  if (index < 0) return [...state, message]
  return state.map((current, currentIndex) => (currentIndex === index ? message : current))
}

function uniqueMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.reduce<ChatMessage[]>(upsertMessage, [])
}

export function appendDelta(current: string, delta: string, offset?: number): string {
  if (!delta) return current
  if (offset === undefined || offset < 0) return `${current}${delta}`
  const currentPoints = Array.from(current)
  const deltaPoints = Array.from(delta)
  if (offset < currentPoints.length) {
    if (currentPoints.slice(offset, offset + deltaPoints.length).join('') === delta) return current
    return `${currentPoints.slice(0, offset).join('')}${delta}`
  }
  return `${current}${delta}`
}

function codePointLength(value: string): number {
  return Array.from(value).length
}

function terminalStatus(status: string | null | undefined): ChatMessage['status'] {
  const normalized = status?.toLowerCase()
  if (normalized === 'failed' || normalized === 'error') return 'failed'
  if (
    ['pending', 'streaming', 'running', 'in_progress', 'inprogress', 'busy'].includes(
      normalized ?? ''
    )
  ) {
    return normalized === 'pending' ? 'pending' : 'streaming'
  }
  return 'completed'
}

function normalizeFileChanges(value: unknown): ChatFileChangesSummary | undefined {
  const summary = record(value)
  const rawFiles = Array.isArray(summary.files) ? summary.files : []
  const files = rawFiles.flatMap(rawFile => {
    const file = record(rawFile)
    const path = stringValue(file.path)
    if (!path) return []
    const rawType = stringValue(file.changeType) ?? stringValue(file.change_type)
    const changeType = ['created', 'modified', 'deleted', 'renamed'].includes(rawType ?? '')
      ? (rawType as 'created' | 'modified' | 'deleted' | 'renamed')
      : 'modified'
    return [
      {
        path,
        ...(stringValue(file.oldPath ?? file.old_path) && {
          oldPath: stringValue(file.oldPath ?? file.old_path),
        }),
        changeType,
        additions: finiteNumber(file.additions) ?? 0,
        deletions: finiteNumber(file.deletions) ?? 0,
        binary: file.binary === true,
      },
    ]
  })
  const fileCount = finiteNumber(summary.fileCount ?? summary.file_count) ?? files.length
  const additions = finiteNumber(summary.additions) ?? 0
  const deletions = finiteNumber(summary.deletions) ?? 0
  if (!fileCount && !additions && !deletions && !files.length) return undefined
  return { fileCount, additions, deletions, files }
}

function parseRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return value as Record<string, unknown>
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function idValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function timestamp(value: string | number | null | undefined, fallback = Date.now()): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback
  if (!value) return fallback
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? fallback : parsed
}
