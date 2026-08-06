import type { RuntimePaneMessageAction } from './runtimePaneMessages'
import { getLatestThinkingContent, resolveStreamingThinkingContent } from '@wegent/chat-core'
import type {
  ProcessingBlock,
  RuntimeConversationItem,
  RuntimeConversationTurn,
  WorkbenchMessage,
} from '@/types/workbench'

export function mergeRuntimeConversationTurns(
  localTurns: RuntimeConversationTurn[],
  snapshotTurns: RuntimeConversationTurn[]
): RuntimeConversationTurn[] {
  if (snapshotTurns.length === 0) return localTurns
  const localIndexByTurnId = new Map(
    localTurns.flatMap((turn, index) => (turn.id === null ? [] : [[turn.id, index] as const]))
  )
  const localOptimisticIndexByClientUserMessageId = new Map(
    localTurns.flatMap((turn, index) =>
      turn.id === null && turn.clientUserMessageId
        ? [[turn.clientUserMessageId, index] as const]
        : []
    )
  )
  const emittedLocalIndexes = new Set<number>()
  const snapshotUserMessageIds = new Set(
    snapshotTurns.flatMap(turn =>
      turn.items.flatMap(item => (item.type === 'user_message' ? [item.id] : []))
    )
  )
  const merged = snapshotTurns.map(snapshotTurn => {
    const localIndex =
      (snapshotTurn.id === null ? undefined : localIndexByTurnId.get(snapshotTurn.id)) ??
      (snapshotTurn.clientUserMessageId
        ? localOptimisticIndexByClientUserMessageId.get(snapshotTurn.clientUserMessageId)
        : undefined)
    if (localIndex === undefined) return snapshotTurn
    emittedLocalIndexes.add(localIndex)
    return mergeRuntimeConversationTurn(localTurns[localIndex], snapshotTurn)
  })

  localTurns.forEach((turn, index) => {
    if (emittedLocalIndexes.has(index)) return
    if (
      turn.id === null &&
      turn.clientUserMessageId &&
      snapshotUserMessageIds.has(turn.clientUserMessageId)
    ) {
      return
    }
    if (turn.id === null || !snapshotTurns.some(snapshotTurn => snapshotTurn.id === turn.id)) {
      merged.push(turn)
    }
  })
  return orderRuntimeConversationTurns(merged)
}

export function reduceRuntimeConversationTurns(
  turns: RuntimeConversationTurn[],
  action: RuntimePaneMessageAction
): RuntimeConversationTurn[] {
  switch (action.type) {
    case 'reset':
      return seedRuntimeConversationTurns(action.messages, turns)
    case 'user_added':
      return appendOptimisticUser(turns, action.message)
    case 'assistant_started':
      return updateStartedTurn(turns, action)
    case 'assistant_chunk':
      return updateTurn(turns, action.subtaskId, turn => {
        let items = upsertReasoningChunk(turn.items, action.subtaskId, action.reasoningChunk)
        items = upsertBlocks(items, action.blocks)
        if (action.content) {
          if (action.itemId) {
            items = upsertAssistantText(
              items,
              action.itemId,
              action.content,
              action.contentMode,
              action.offset
            )
          } else {
            console.warn('[Wework] Dropped runtime assistant text without Codex item identity', {
              subtaskId: action.subtaskId,
            })
          }
        }
        return {
          ...turn,
          items,
          status: 'streaming',
          streamingThinkingContent: resolveRuntimeStreamingThinkingContent(turn, action, items),
        }
      })
    case 'assistant_cached':
      return updateTurn(turns, action.subtaskId, turn => ({
        ...turn,
        items: upsertBlocks(turn.items, action.blocks),
        status: 'streaming',
        streamingThinkingContent: undefined,
      }))
    case 'assistant_done':
      return updateTurn(turns, action.subtaskId, turn => {
        const items = applyCompletedAssistantContent(
          settleProcessingBlocks(upsertBlocks(turn.items, action.blocks)),
          turn.id,
          action.content
        )
        return {
          ...turn,
          items,
          status: 'done',
          streamingThinkingContent: undefined,
          completedAt: new Date().toISOString(),
          fileChanges: action.fileChanges ?? turn.fileChanges,
          error: undefined,
          errorType: undefined,
        }
      })
    case 'assistant_cancelled':
      return updateTurn(turns, action.subtaskId, turn => ({
        ...turn,
        status: 'cancelled',
        streamingThinkingContent: undefined,
        completedAt: new Date().toISOString(),
        stoppedNotice: true,
      }))
    case 'assistant_error':
      return updateTurn(turns, action.subtaskId, turn => ({
        ...turn,
        status: 'failed',
        streamingThinkingContent: undefined,
        completedAt: new Date().toISOString(),
        error: action.error,
        errorType: action.errorType,
      }))
    case 'file_changes_updated':
      return updateTurn(turns, action.subtaskId, turn => ({
        ...turn,
        fileChanges: action.fileChanges,
      }))
    case 'block_created':
      return updateTurn(turns, action.subtaskId, turn => {
        const items = replaceAssistantTextWithBlock(
          turn.items,
          action.replaceAssistantTextItemId,
          action.block
        )
        return {
          ...turn,
          items,
          streamingThinkingContent:
            action.block.type === 'thinking' || action.block.type === 'tool'
              ? getLatestThinkingContent(processingBlocks(items))
              : action.block.type === 'text' || action.block.type === 'plan'
                ? undefined
                : turn.streamingThinkingContent,
        }
      })
    case 'block_updated':
      return updateTurn(turns, action.subtaskId, turn => {
        const previousBlock = turn.items.find(
          item => item.type === 'block' && item.id === action.blockId
        )
        const items = turn.items.map(item =>
          item.type === 'block' && item.id === action.blockId
            ? {
                ...item,
                block: mergeProcessingBlockUpdate(item.block, action.updates),
              }
            : item
        )
        return {
          ...turn,
          items,
          streamingThinkingContent:
            previousBlock?.type === 'block' && previousBlock.block.type === 'thinking'
              ? getLatestThinkingContent(processingBlocks(items))
              : previousBlock?.type === 'block' &&
                  (previousBlock.block.type === 'text' || previousBlock.block.type === 'plan')
                ? undefined
                : turn.streamingThinkingContent,
        }
      })
  }
}

export function projectRuntimeConversationTurns(
  turns: RuntimeConversationTurn[]
): WorkbenchMessage[] {
  return turns.flatMap(projectRuntimeConversationTurn)
}

export function appendRuntimeConversationGuidance(
  turns: RuntimeConversationTurn[],
  turnId: string | undefined,
  guidance: WorkbenchMessage & { role: 'user'; runtimeGuidance: true }
): RuntimeConversationTurn[] {
  if (!turnId) return turns
  const withoutOptimisticDuplicate = turns
    .filter(
      turn =>
        !(
          turn.id === null &&
          turn.clientUserMessageId === guidance.id &&
          turn.items.every(item => item.type === 'user_message' && item.id === guidance.id)
        )
    )
    .map(turn =>
      turn.id !== turnId
        ? {
            ...turn,
            items: turn.items.filter(
              item => item.type !== 'user_message' || item.id !== guidance.id
            ),
          }
        : turn
    )
  return updateTurn(withoutOptimisticDuplicate, turnId, turn => {
    const existingIndex = turn.items.findIndex(
      item => item.type === 'user_message' && item.id === guidance.id
    )
    if (existingIndex >= 0) {
      return {
        ...turn,
        items: replaceAt(turn.items, existingIndex, {
          id: guidance.id,
          type: 'user_message',
          message: { ...guidance, subtaskId: turnId, turnId },
        }),
      }
    }
    const userItem: RuntimeConversationItem = {
      id: guidance.id,
      type: 'user_message',
      message: { ...guidance, subtaskId: turnId, turnId },
    }
    return {
      ...turn,
      items: [...turn.items, userItem],
    }
  })
}

function mergeRuntimeConversationTurn(
  local: RuntimeConversationTurn,
  snapshot: RuntimeConversationTurn
): RuntimeConversationTurn {
  const items = mergeRuntimeConversationItems(local.items, snapshot.items)
  const preserveLocalFailure = local.status === 'failed' && Boolean(local.error) && !snapshot.error
  const preserveStreamingThinking =
    snapshot.status === 'streaming' &&
    assistantTextContent(local.items) === assistantTextContent(snapshot.items)
  return {
    ...local,
    ...snapshot,
    clientUserMessageId: snapshot.clientUserMessageId ?? local.clientUserMessageId,
    runtimeMessageIndex: earliestRuntimeMessageIndex(local, snapshot),
    items,
    status: preserveLocalFailure ? local.status : snapshot.status,
    completedAt: preserveLocalFailure ? local.completedAt : snapshot.completedAt,
    error: preserveLocalFailure ? local.error : snapshot.error,
    errorType: preserveLocalFailure ? local.errorType : snapshot.errorType,
    streamingThinkingContent: preserveStreamingThinking
      ? getLatestThinkingContent(processingBlocks(items))
      : snapshot.streamingThinkingContent,
  }
}

function earliestRuntimeMessageIndex(
  local: RuntimeConversationTurn,
  snapshot: RuntimeConversationTurn
): number | undefined {
  const indexes = [local.runtimeMessageIndex, snapshot.runtimeMessageIndex].filter(
    (index): index is number => typeof index === 'number'
  )
  return indexes.length > 0 ? Math.min(...indexes) : undefined
}

function orderRuntimeConversationTurns(
  turns: RuntimeConversationTurn[]
): RuntimeConversationTurn[] {
  const indexedTurns = turns.map((turn, index) => ({
    turn,
    index,
    timestamp: runtimeConversationTurnTimestamp(turn),
  }))
  if (indexedTurns.every(({ turn }) => turn.runtimeMessageIndex !== undefined)) {
    return indexedTurns
      .sort(
        (left, right) =>
          left.turn.runtimeMessageIndex! - right.turn.runtimeMessageIndex! ||
          left.index - right.index
      )
      .map(({ turn }) => turn)
  }
  if (indexedTurns.every(({ timestamp }) => timestamp !== undefined)) {
    return indexedTurns
      .sort((left, right) => left.timestamp! - right.timestamp! || left.index - right.index)
      .map(({ turn }) => turn)
  }
  return turns
}

function runtimeConversationTurnTimestamp(turn: RuntimeConversationTurn): number | undefined {
  for (const item of turn.items) {
    const value =
      item.type === 'user_message'
        ? item.message.createdAt
        : item.type === 'assistant_text'
          ? item.createdAt
          : item.block.createdAt
    const timestamp = typeof value === 'number' ? value : Date.parse(value ?? '')
    if (Number.isFinite(timestamp)) return timestamp
  }
  return undefined
}

function mergeRuntimeConversationItems(
  localItems: RuntimeConversationItem[],
  snapshotItems: RuntimeConversationItem[]
): RuntimeConversationItem[] {
  const localById = new Map(localItems.map(item => [item.id, item]))
  const mergedSnapshotItems = snapshotItems.map(item =>
    mergeRuntimeConversationItem(localById.get(item.id), item)
  )
  if (localItems.length <= snapshotItems.length) return mergedSnapshotItems

  const snapshotById = new Map(mergedSnapshotItems.map(item => [item.id, item]))
  const mergedLocalItems = localItems.map(item => snapshotById.get(item.id) ?? item)
  for (let index = mergedSnapshotItems.length - 1; index >= 0; index -= 1) {
    const snapshotItem = mergedSnapshotItems[index]
    if (snapshotItem?.type !== 'assistant_text') continue
    const localMatch = mergedLocalItems.find(
      item =>
        item.type === 'assistant_text' &&
        (item.id === snapshotItem.id || item.content === snapshotItem.content)
    )
    if (!localMatch) return [...mergedLocalItems, snapshotItem]
    return mergedLocalItems.map(item =>
      item === localMatch ? { ...snapshotItem, id: localMatch.id } : item
    )
  }
  return mergedLocalItems
}

function mergeRuntimeConversationItem(
  local: RuntimeConversationItem | undefined,
  snapshot: RuntimeConversationItem
): RuntimeConversationItem {
  if (local?.type !== 'block' || snapshot.type !== 'block') return snapshot
  const localComplete = local.block.status === 'done' || local.block.status === 'error'
  const snapshotComplete = snapshot.block.status === 'done' || snapshot.block.status === 'error'
  if (!localComplete || !snapshotComplete || local.block.completedAt === undefined) {
    return snapshot
  }

  return {
    ...snapshot,
    block: preserveCompletedProcessingBlockTiming(local.block, snapshot.block),
  }
}

function seedRuntimeConversationTurns(
  messages: WorkbenchMessage[],
  currentTurns: RuntimeConversationTurn[]
): RuntimeConversationTurn[] {
  let turns = currentTurns
  for (const message of messages) {
    if (message.role !== 'user') continue
    const existing = turns.some(turn =>
      turn.items.some(item => item.type === 'user_message' && item.id === message.id)
    )
    if (!existing) {
      turns = appendOptimisticUser(turns, message)
    }
  }
  return turns
}

function appendOptimisticUser(
  turns: RuntimeConversationTurn[],
  message: WorkbenchMessage
): RuntimeConversationTurn[] {
  if (message.role !== 'user') return turns
  if (
    turns.some(turn =>
      turn.items.some(item => item.type === 'user_message' && item.id === message.id)
    )
  ) {
    return turns
  }
  return [
    ...turns,
    {
      id: null,
      clientUserMessageId: message.id,
      items: [{ id: message.id, type: 'user_message', message: { ...message, role: 'user' } }],
      status: 'pending',
    },
  ]
}

function updateStartedTurn(
  turns: RuntimeConversationTurn[],
  action: Extract<RuntimePaneMessageAction, { type: 'assistant_started' }>
): RuntimeConversationTurn[] {
  if (!action.subtaskId) return turns
  const existingIndex = turns.findIndex(turn => turn.id === action.subtaskId)
  if (existingIndex >= 0) {
    return replaceAt(turns, existingIndex, {
      ...turns[existingIndex],
      status: 'streaming',
      completedAt: undefined,
      error: undefined,
      errorType: undefined,
      stoppedNotice: undefined,
    })
  }
  const optimisticIndex = action.clientUserMessageId
    ? turns.findIndex(
        turn =>
          turn.clientUserMessageId === action.clientUserMessageId ||
          turn.items.some(
            item => item.type === 'user_message' && item.id === action.clientUserMessageId
          )
      )
    : turns.findLastIndex(
        turn => turn.id === null && (turn.status === 'pending' || turn.status === 'streaming')
      )
  if (optimisticIndex >= 0) {
    const optimistic = turns[optimisticIndex]
    return replaceAt(turns, optimisticIndex, {
      ...optimistic,
      id: action.subtaskId,
      status: 'streaming',
      completedAt: undefined,
      error: undefined,
      errorType: undefined,
      stoppedNotice: undefined,
      items: optimistic.items.map(item =>
        item.type === 'user_message'
          ? {
              ...item,
              message: {
                ...item.message,
                subtaskId: action.subtaskId,
                turnId: action.subtaskId,
              },
            }
          : item
      ),
    })
  }
  return [
    ...turns,
    {
      id: action.subtaskId,
      items: [],
      status: 'streaming',
    },
  ]
}

function updateTurn(
  turns: RuntimeConversationTurn[],
  turnId: string | undefined,
  update: (turn: RuntimeConversationTurn) => RuntimeConversationTurn
): RuntimeConversationTurn[] {
  if (!turnId) return turns
  const index = turns.findIndex(turn => turn.id === turnId)
  if (index < 0) return turns
  return replaceAt(turns, index, update(turns[index]))
}

function upsertAssistantText(
  items: RuntimeConversationItem[],
  itemId: string,
  content: string,
  contentMode: 'delta' | 'snapshot' | undefined,
  offset: number | undefined
): RuntimeConversationItem[] {
  const index = items.findIndex(item => item.type === 'assistant_text' && item.id === itemId)
  if (index < 0) {
    return [
      ...items,
      {
        id: itemId,
        type: 'assistant_text',
        content,
        streamTextOffset:
          contentMode === 'snapshot' || offset === undefined ? undefined : offset + content.length,
        createdAt: new Date().toISOString(),
      },
    ]
  }
  const current = items[index]
  if (current.type !== 'assistant_text') return items
  if (contentMode === 'snapshot') {
    return replaceAt(items, index, {
      ...current,
      content,
      streamTextOffset: undefined,
    })
  }
  const mergedContent =
    offset === undefined
      ? `${current.content}${content}`
      : `${current.content.slice(0, offset)}${content}${current.content.slice(
          offset + content.length
        )}`
  return replaceAt(items, index, {
    ...current,
    content: mergedContent,
    streamTextOffset: offset === undefined ? undefined : offset + content.length,
  })
}

function applyCompletedAssistantContent(
  items: RuntimeConversationItem[],
  turnId: string | null,
  content: string | undefined
): RuntimeConversationItem[] {
  if (!content) return items
  const lastUserIndex = items.findLastIndex(item => item.type === 'user_message')
  const hasStreamedAssistantText = items.some(
    (item, index) => index > lastUserIndex && item.type === 'assistant_text'
  )
  if (hasStreamedAssistantText) return items
  const matchingProcessTextIndex = items.findLastIndex(
    item => item.type === 'block' && item.block.type === 'text' && item.block.content === content
  )
  if (matchingProcessTextIndex >= 0) {
    return replaceAt(items, matchingProcessTextIndex, {
      id: `runtime-final:${turnId ?? 'pending'}`,
      type: 'assistant_text',
      content,
      createdAt: new Date().toISOString(),
    })
  }
  const retained = items.filter(
    (item, index) => index <= lastUserIndex || item.type !== 'assistant_text'
  )
  return [
    ...retained,
    {
      id: `runtime-final:${turnId ?? 'pending'}`,
      type: 'assistant_text',
      content,
      createdAt: new Date().toISOString(),
    },
  ]
}

function upsertReasoningChunk(
  items: RuntimeConversationItem[],
  subtaskId: string | undefined,
  reasoningChunk: string | undefined
): RuntimeConversationItem[] {
  if (!subtaskId || !reasoningChunk) return items
  const itemId = `runtime-reasoning:${subtaskId}`
  const index = items.findIndex(item => item.type === 'block' && item.id === itemId)
  if (index < 0) {
    return [
      ...items,
      {
        id: itemId,
        type: 'block',
        block: {
          id: itemId,
          subtaskId,
          type: 'thinking',
          content: reasoningChunk,
          status: 'streaming',
          createdAt: Date.now(),
        },
      },
    ]
  }
  const current = items[index]
  if (current.type !== 'block' || current.block.type !== 'thinking') return items
  return replaceAt(items, index, {
    ...current,
    block: {
      ...current.block,
      content: `${current.block.content}${reasoningChunk}`,
      status: 'streaming',
    },
  })
}

function upsertBlocks(
  items: RuntimeConversationItem[],
  blocks: ProcessingBlock[] | undefined
): RuntimeConversationItem[] {
  if (!blocks?.length) return items
  let next = items
  for (const block of blocks) {
    const index = next.findIndex(item => item.type === 'block' && item.id === block.id)
    const canonicalItem: RuntimeConversationItem = {
      id: block.id,
      type: 'block',
      block:
        index >= 0 && next[index]?.type === 'block'
          ? preserveCompletedProcessingBlockTiming(next[index].block, block)
          : block,
    }
    next = index < 0 ? [...next, canonicalItem] : replaceAt(next, index, canonicalItem)
  }
  return next
}

function replaceAssistantTextWithBlock(
  items: RuntimeConversationItem[],
  assistantTextItemId: string | undefined,
  block: ProcessingBlock
): RuntimeConversationItem[] {
  if (!assistantTextItemId) return upsertBlocks(items, [block])
  const index = items.findIndex(
    item => item.type === 'assistant_text' && item.id === assistantTextItemId
  )
  if (index < 0) return upsertBlocks(items, [block])
  return replaceAt(items, index, {
    id: block.id,
    type: 'block',
    block,
  })
}

function projectRuntimeConversationTurn(turn: RuntimeConversationTurn): WorkbenchMessage[] {
  const messages: WorkbenchMessage[] = []
  let assistantItems: RuntimeConversationItem[] = []
  let followsGuidance = false

  const flushAssistant = (isLast: boolean, splitBefore: boolean) => {
    if (assistantItems.length === 0 && !(isLast && turn.id !== null && turn.status !== 'done')) {
      return
    }
    const textItems = assistantItems.filter(item => item.type === 'assistant_text')
    const blocks = processingBlocks(assistantItems)
    const firstItem = assistantItems[0]
    const createdAt =
      textItems[0]?.createdAt ??
      (blocks[0] ? new Date(blocks[0].createdAt).toISOString() : new Date().toISOString())
    messages.push({
      id: `runtime-view:${turn.id ?? turn.clientUserMessageId ?? 'pending'}:${
        firstItem?.id ?? 'assistant'
      }`,
      role: 'assistant',
      content: textItems.map(item => item.content).join('\n\n'),
      status: isLast ? turnStatus(turn) : 'done',
      runtimeStatus: isLast ? turn.status : 'done',
      subtaskId: turn.id ?? undefined,
      turnId: turn.id ?? undefined,
      blocks: blocks.length > 0 ? blocks : undefined,
      fileChanges: isLast ? turn.fileChanges : undefined,
      error: isLast ? turn.error : undefined,
      errorType: isLast ? turn.errorType : undefined,
      completedAt: isLast ? turn.completedAt : undefined,
      stoppedNotice: isLast ? turn.stoppedNotice : undefined,
      streamingThinkingContent: isLast ? turn.streamingThinkingContent : undefined,
      references: isLast ? turn.references : undefined,
      memoryCitations: isLast ? turn.memoryCitations : undefined,
      runtimeGuidanceSplitBefore: splitBefore || undefined,
      runtimeGuidanceContinuation: followsGuidance || undefined,
      createdAt,
    })
    assistantItems = []
    followsGuidance = false
  }

  for (const item of turn.items) {
    if (item.type === 'user_message') {
      const hadAssistant = assistantItems.length > 0
      flushAssistant(false, hadAssistant)
      messages.push(item.message)
      followsGuidance = item.message.runtimeGuidance === true
      if (followsGuidance && turn.id !== null) {
        const block = projectedGuidanceBlock(item.message, turn.id)
        assistantItems.push({ id: block.id, type: 'block', block })
      }
      continue
    }
    assistantItems.push(item)
  }
  flushAssistant(true, false)
  return messages
}

function projectedGuidanceBlock(
  message: WorkbenchMessage & { role: 'user' },
  turnId: string
): ProcessingBlock {
  const createdAt = Date.parse(message.createdAt ?? '')
  return {
    id: `runtime-view-guidance:${message.id}`,
    subtaskId: turnId,
    type: 'tool',
    toolName: 'conversation_guidance',
    toolInput: { message: message.content },
    status: message.status === 'pending' ? 'streaming' : 'done',
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
  }
}

function turnStatus(turn: RuntimeConversationTurn): WorkbenchMessage['status'] {
  if (turn.status === 'cancelled') return 'done'
  return turn.status
}

function resolveRuntimeStreamingThinkingContent(
  turn: RuntimeConversationTurn,
  action: Extract<RuntimePaneMessageAction, { type: 'assistant_chunk' }>,
  items: RuntimeConversationItem[]
): string | undefined {
  return resolveStreamingThinkingContent({
    previousContent: turn.streamingThinkingContent,
    reasoningChunk: action.reasoningChunk,
    content: action.content,
    incomingBlocks: action.blocks,
    blocks: processingBlocks(items),
  })
}

function processingBlocks(items: RuntimeConversationItem[]): ProcessingBlock[] {
  return items.flatMap(item => (item.type === 'block' ? [item.block] : []))
}

function settleProcessingBlocks(items: RuntimeConversationItem[]): RuntimeConversationItem[] {
  const completedAt = Date.now()
  return items.map(item => {
    if (item.type !== 'block') return item
    if (item.block.status === 'done' || item.block.status === 'error') return item
    return {
      ...item,
      block: {
        ...item.block,
        status: 'done',
        completedAt: item.block.completedAt ?? completedAt,
      } as ProcessingBlock,
    }
  })
}

function assistantTextContent(items: RuntimeConversationItem[]): string {
  return items.flatMap(item => (item.type === 'assistant_text' ? [item.content] : [])).join('\n\n')
}

function mergeProcessingBlockUpdate(
  block: ProcessingBlock,
  updates: Extract<RuntimePaneMessageAction, { type: 'block_updated' }>['updates']
): ProcessingBlock {
  let merged = { ...block, ...updates } as ProcessingBlock
  if (merged.type === 'tool' && block.type === 'tool') {
    merged.toolInput = updates.toolInput ?? block.toolInput
  }
  const wasActive = block.status !== 'done' && block.status !== 'error'
  const isComplete = merged.status === 'done' || merged.status === 'error'
  if (wasActive && isComplete && merged.completedAt === undefined) {
    merged = { ...merged, completedAt: Date.now() } as ProcessingBlock
  }
  return merged
}

function preserveCompletedProcessingBlockTiming(
  previous: ProcessingBlock,
  next: ProcessingBlock
): ProcessingBlock {
  const previousComplete = previous.status === 'done' || previous.status === 'error'
  const nextComplete = next.status === 'done' || next.status === 'error'
  if (
    !previousComplete ||
    !nextComplete ||
    previous.completedAt === undefined ||
    next.completedAt !== undefined
  ) {
    return next
  }
  return {
    ...next,
    createdAt: previous.createdAt,
    completedAt: previous.completedAt,
  } as ProcessingBlock
}

function replaceAt<T>(items: T[], index: number, item: T): T[] {
  return [...items.slice(0, index), item, ...items.slice(index + 1)]
}
