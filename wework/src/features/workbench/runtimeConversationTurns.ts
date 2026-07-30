import type { RuntimePaneMessageAction } from './runtimePaneMessages'
import type { AppliedRuntimeGuidanceMessage } from './runtimeGuidanceMessages'
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
    if (turn.id === null || !snapshotTurns.some(snapshotTurn => snapshotTurn.id === turn.id)) {
      merged.push(turn)
    }
  })
  return merged
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
        let items = upsertBlocks(turn.items, action.blocks)
        if (action.content) {
          if (action.itemId) {
            items = upsertAssistantText(items, action.itemId, action.content, action.offset)
          } else {
            console.warn('[Wework] Dropped runtime assistant text without Codex item identity', {
              subtaskId: action.subtaskId,
            })
          }
        }
        return { ...turn, items, status: 'streaming' }
      })
    case 'assistant_cached':
      return updateTurn(turns, action.subtaskId, turn => ({
        ...turn,
        items: upsertBlocks(turn.items, action.blocks),
        status: 'streaming',
      }))
    case 'assistant_done':
      return updateTurn(turns, action.subtaskId, turn => ({
        ...turn,
        items: upsertBlocks(turn.items, action.blocks),
        status: 'done',
        completedAt: new Date().toISOString(),
        fileChanges: action.fileChanges ?? turn.fileChanges,
        error: undefined,
        errorType: undefined,
      }))
    case 'assistant_cancelled':
      return updateTurn(turns, action.subtaskId, turn => ({
        ...turn,
        status: 'cancelled',
        completedAt: new Date().toISOString(),
        stoppedNotice: true,
      }))
    case 'assistant_error':
      return updateTurn(turns, action.subtaskId, turn => ({
        ...turn,
        status: 'failed',
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
      return updateTurn(turns, action.subtaskId, turn => ({
        ...turn,
        items: upsertBlocks(turn.items, [action.block]),
      }))
    case 'block_updated':
      return updateTurn(turns, action.subtaskId, turn => ({
        ...turn,
        items: turn.items.map(item =>
          item.type === 'block' && item.id === action.blockId
            ? {
                ...item,
                block: mergeProcessingBlockUpdate(item.block, action.updates),
              }
            : item
        ),
      }))
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
  guidance: AppliedRuntimeGuidanceMessage
): RuntimeConversationTurn[] {
  if (!turnId) return turns
  return updateTurn(turns, turnId, turn => {
    if (turn.items.some(item => item.type === 'user_message' && item.id === guidance.id)) {
      return turn
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
  return {
    ...local,
    ...snapshot,
    clientUserMessageId: snapshot.clientUserMessageId ?? local.clientUserMessageId,
    items: mergeOrderedById(local.items, snapshot.items, (_local, item) => item),
  }
}

function mergeOrderedById<T extends { id: string }>(
  localItems: T[],
  snapshotItems: T[],
  mergeMatched: (local: T, snapshot: T) => T
): T[] {
  const snapshotById = new Map(snapshotItems.map(item => [item.id, item]))
  const localIndexById = new Map(localItems.map((item, index) => [item.id, index]))
  const emittedLocalIndexes = new Set<number>()
  const merged: T[] = []
  let localCursor = 0

  for (const snapshotItem of snapshotItems) {
    const matchedIndex = localIndexById.get(snapshotItem.id)
    if (matchedIndex !== undefined) {
      while (localCursor < matchedIndex) {
        const localItem = localItems[localCursor]
        if (localItem && !snapshotById.has(localItem.id)) {
          merged.push(localItem)
        }
        emittedLocalIndexes.add(localCursor)
        localCursor += 1
      }
      const localItem = localItems[matchedIndex]
      merged.push(localItem ? mergeMatched(localItem, snapshotItem) : snapshotItem)
      emittedLocalIndexes.add(matchedIndex)
      localCursor = Math.max(localCursor, matchedIndex + 1)
      continue
    }
    merged.push(snapshotItem)
  }

  localItems.forEach((item, index) => {
    if (!emittedLocalIndexes.has(index) && !snapshotById.has(item.id)) {
      merged.push(item)
    }
  })
  return merged
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
    })
  }
  const optimisticIndex = action.clientUserMessageId
    ? turns.findIndex(
        turn => turn.id === null && turn.clientUserMessageId === action.clientUserMessageId
      )
    : -1
  if (optimisticIndex >= 0) {
    const optimistic = turns[optimisticIndex]
    return replaceAt(turns, optimisticIndex, {
      ...optimistic,
      id: action.subtaskId,
      status: 'streaming',
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
  if (index < 0) {
    return updateStartedTurn(turns, {
      type: 'assistant_started',
      subtaskId: turnId,
    }).map(turn => (turn.id === turnId ? update(turn) : turn))
  }
  return replaceAt(turns, index, update(turns[index]))
}

function upsertAssistantText(
  items: RuntimeConversationItem[],
  itemId: string,
  delta: string,
  offset: number | undefined
): RuntimeConversationItem[] {
  const index = items.findIndex(item => item.type === 'assistant_text' && item.id === itemId)
  if (index < 0) {
    return [
      ...items,
      {
        id: itemId,
        type: 'assistant_text',
        content: delta,
        streamTextOffset: offset === undefined ? undefined : offset + [...delta].length,
        createdAt: new Date().toISOString(),
      },
    ]
  }
  const current = items[index]
  if (current.type !== 'assistant_text') return items
  const content =
    offset === undefined
      ? `${current.content}${delta}`
      : `${current.content.slice(0, offset)}${delta}${current.content.slice(
          offset + [...delta].length
        )}`
  return replaceAt(items, index, {
    ...current,
    content,
    streamTextOffset: offset === undefined ? undefined : offset + [...delta].length,
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
      block,
    }
    next = index < 0 ? [...next, canonicalItem] : replaceAt(next, index, canonicalItem)
  }
  return next
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
    const blocks = assistantItems.flatMap(item => (item.type === 'block' ? [item.block] : []))
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
      status: isLast && turn.status === 'failed' ? 'failed' : isLast ? turnStatus(turn) : 'done',
      runtimeStatus: isLast ? turn.status : 'done',
      subtaskId: turn.id ?? undefined,
      turnId: turn.id ?? undefined,
      blocks: blocks.length > 0 ? blocks : undefined,
      fileChanges: isLast ? turn.fileChanges : undefined,
      error: isLast ? turn.error : undefined,
      errorType: isLast ? turn.errorType : undefined,
      completedAt: isLast ? turn.completedAt : undefined,
      stoppedNotice: isLast ? turn.stoppedNotice : undefined,
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
    status: 'done',
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
  }
}

function turnStatus(turn: RuntimeConversationTurn): WorkbenchMessage['status'] {
  if (turn.status === 'cancelled') return 'done'
  return turn.status
}

function mergeProcessingBlockUpdate(
  block: ProcessingBlock,
  updates: Extract<RuntimePaneMessageAction, { type: 'block_updated' }>['updates']
): ProcessingBlock {
  const merged = { ...block, ...updates } as ProcessingBlock
  if (merged.type === 'tool' && block.type === 'tool') {
    merged.toolInput = updates.toolInput ?? block.toolInput
  }
  return merged
}

function replaceAt<T>(items: T[], index: number, item: T): T[] {
  return [...items.slice(0, index), item, ...items.slice(index + 1)]
}
