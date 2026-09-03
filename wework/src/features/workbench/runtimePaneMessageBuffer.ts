import type { RuntimePaneMessageAction } from './runtimePaneMessages'

export function appendBufferedRuntimePaneMessageAction(
  actions: RuntimePaneMessageAction[],
  action: RuntimePaneMessageAction
): void {
  const previous = actions.at(-1)
  const merged = previous ? mergeBufferedRuntimePaneMessageActions(previous, action) : null
  if (merged) {
    actions[actions.length - 1] = merged
    return
  }
  actions.push(action)
}

function mergeBufferedRuntimePaneMessageActions(
  previous: RuntimePaneMessageAction,
  next: RuntimePaneMessageAction
): RuntimePaneMessageAction | null {
  if (previous.type === 'assistant_chunk' && next.type === 'assistant_chunk') {
    return mergeAssistantChunks(previous, next)
  }
  if (previous.type === 'block_updated' && next.type === 'block_updated') {
    return mergeBlockUpdates(previous, next)
  }
  return null
}

function mergeAssistantChunks(
  previous: Extract<RuntimePaneMessageAction, { type: 'assistant_chunk' }>,
  next: Extract<RuntimePaneMessageAction, { type: 'assistant_chunk' }>
): RuntimePaneMessageAction | null {
  if (
    previous.messageId !== next.messageId ||
    previous.subtaskId !== next.subtaskId ||
    previous.itemId !== next.itemId ||
    previous.contentMode === 'snapshot' ||
    next.contentMode === 'snapshot' ||
    previous.blocks?.length ||
    next.blocks?.length
  ) {
    return null
  }
  if (previous.reasoningChunk && next.reasoningChunk && !previous.content && !next.content) {
    return {
      ...next,
      reasoningChunk: previous.reasoningChunk + next.reasoningChunk,
    }
  }
  if (previous.reasoningChunk || next.reasoningChunk || !previous.content || !next.content) {
    return null
  }
  if (
    previous.offset !== undefined &&
    next.offset !== undefined &&
    next.offset !== previous.offset + previous.content.length
  ) {
    return null
  }
  if ((previous.offset === undefined) !== (next.offset === undefined)) return null
  return {
    ...next,
    content: previous.content + next.content,
    offset: previous.offset,
  }
}

function mergeBlockUpdates(
  previous: Extract<RuntimePaneMessageAction, { type: 'block_updated' }>,
  next: Extract<RuntimePaneMessageAction, { type: 'block_updated' }>
): RuntimePaneMessageAction | null {
  const previousDelta = streamingBlockDelta(previous.updates)
  const nextDelta = streamingBlockDelta(next.updates)
  if (
    previous.messageId !== next.messageId ||
    previous.subtaskId !== next.subtaskId ||
    previous.blockId !== next.blockId ||
    !previousDelta ||
    !nextDelta ||
    previousDelta.kind !== nextDelta.kind
  ) {
    return null
  }
  if (previousDelta.kind === 'toolOutput' && nextDelta.kind === 'toolOutput') {
    return {
      ...next,
      updates: {
        ...next.updates,
        toolOutputDelta: previousDelta.value + nextDelta.value,
      },
    }
  }
  return {
    ...next,
    updates: {
      ...next.updates,
      contentDelta: previousDelta.value + nextDelta.value,
    },
  }
}

function streamingBlockDelta(
  updates: Extract<RuntimePaneMessageAction, { type: 'block_updated' }>['updates']
): { kind: 'content' | 'toolOutput'; value: string } | null {
  const keys = Object.keys(updates)
  if (
    typeof updates.contentDelta === 'string' &&
    (updates.status === undefined || updates.status === 'streaming') &&
    keys.every(key => key === 'contentDelta' || key === 'status')
  ) {
    return { kind: 'content', value: updates.contentDelta }
  }
  if (
    typeof updates.toolOutputDelta === 'string' &&
    (updates.status === undefined || updates.status === 'streaming') &&
    keys.every(key => key === 'toolOutputDelta' || key === 'status')
  ) {
    return { kind: 'toolOutput', value: updates.toolOutputDelta }
  }
  return null
}
