import type { WorkbenchMessage } from '@/types/workbench'

export function mergeRuntimeTranscriptMessages(
  transcriptMessages: WorkbenchMessage[],
  liveMessages: WorkbenchMessage[]
): WorkbenchMessage[] {
  const merged = [...transcriptMessages]
  const indexesById = new Map(merged.map((message, index) => [message.id, index]))
  const assistantIndexesBySubtask = new Map<string, number>()
  const assistantIndexesByTurn = new Map<number, number>()
  const transcriptUserTurns = new Map<string, number[]>()
  let transcriptTurn = -1

  merged.forEach((message, index) => {
    if (message.role === 'user') {
      transcriptTurn += 1
      rememberTranscriptUserTurn(transcriptUserTurns, message, transcriptTurn)
    }
    if (message.role === 'assistant' && message.subtaskId) {
      assistantIndexesBySubtask.set(message.subtaskId, index)
    }
    if (message.role === 'assistant') {
      assistantIndexesByTurn.set(transcriptTurn, index)
    }
  })

  let liveTurn: number | null = null
  let minimumTranscriptTurn = 0
  for (const liveMessage of liveMessages) {
    if (liveMessage.role === 'user') {
      const matchedTurn = findTranscriptUserTurn(
        transcriptUserTurns,
        liveMessage,
        minimumTranscriptTurn
      )
      if (matchedTurn !== null) {
        liveTurn = matchedTurn
        minimumTranscriptTurn = matchedTurn + 1
      } else {
        liveTurn = null
      }
    }

    if (indexesById.has(liveMessage.id)) continue

    const matchingSubtaskIndex =
      liveMessage.role === 'assistant' && liveMessage.subtaskId
        ? assistantIndexesBySubtask.get(liveMessage.subtaskId)
        : undefined
    const matchingTurnIndex =
      liveMessage.role === 'assistant' && liveTurn !== null
        ? assistantIndexesByTurn.get(liveTurn)
        : undefined
    const matchingAssistantIndex = matchingSubtaskIndex ?? matchingTurnIndex
    if (matchingAssistantIndex !== undefined) {
      merged[matchingAssistantIndex] = mergeTranscriptAssistantMessage(
        merged[matchingAssistantIndex],
        liveMessage
      )
      continue
    }

    indexesById.set(liveMessage.id, merged.length)
    if (liveMessage.role === 'assistant' && liveMessage.subtaskId) {
      assistantIndexesBySubtask.set(liveMessage.subtaskId, merged.length)
    }
    merged.push(liveMessage)
  }

  if (!merged.some(message => getRuntimeMessageIndex(message) !== null)) return merged

  return merged
    .map((message, order) => ({ message, order }))
    .sort((left, right) => {
      const leftIndex = getRuntimeMessageIndex(left.message)
      const rightIndex = getRuntimeMessageIndex(right.message)
      if (leftIndex !== null && rightIndex !== null && leftIndex !== rightIndex) {
        return leftIndex - rightIndex
      }
      if (leftIndex !== null && rightIndex === null) return -1
      if (leftIndex === null && rightIndex !== null) return 1
      return left.order - right.order
    })
    .map(item => item.message)
}

function rememberTranscriptUserTurn(
  turns: Map<string, number[]>,
  message: WorkbenchMessage,
  turn: number
): void {
  for (const key of userMessageKeys(message)) {
    const existing = turns.get(key) ?? []
    existing.push(turn)
    turns.set(key, existing)
  }
}

function findTranscriptUserTurn(
  turns: Map<string, number[]>,
  message: WorkbenchMessage,
  minimumTurn: number
): number | null {
  for (const key of userMessageKeys(message)) {
    const turn = turns.get(key)?.find(candidate => candidate >= minimumTurn)
    if (turn !== undefined) return turn
  }
  return null
}

function userMessageKeys(message: WorkbenchMessage): string[] {
  return [`id:${message.id}`, `content:${message.content}`]
}

function mergeTranscriptAssistantMessage(
  transcriptMessage: WorkbenchMessage,
  liveMessage: WorkbenchMessage
): WorkbenchMessage {
  const transcriptSettled =
    transcriptMessage.status === 'done' || transcriptMessage.status === 'failed'
  return {
    ...liveMessage,
    ...transcriptMessage,
    id: transcriptMessage.id,
    content: preferCompleteContent(transcriptMessage.content, liveMessage.content),
    blocks: mergeMessageBlocks(transcriptMessage.blocks, liveMessage.blocks),
    fileChanges: transcriptMessage.fileChanges ?? liveMessage.fileChanges,
    status: transcriptSettled ? transcriptMessage.status : liveMessage.status,
    runtimeStatus: transcriptSettled
      ? transcriptMessage.runtimeStatus
      : (liveMessage.runtimeStatus ?? transcriptMessage.runtimeStatus),
    completedAt: transcriptMessage.completedAt ?? liveMessage.completedAt,
  }
}

function mergeMessageBlocks(
  transcriptBlocks: WorkbenchMessage['blocks'],
  liveBlocks: WorkbenchMessage['blocks']
): WorkbenchMessage['blocks'] {
  if (!transcriptBlocks?.length) return liveBlocks
  if (!liveBlocks?.length) return transcriptBlocks

  const merged = [...transcriptBlocks]
  const blockIds = new Set(merged.map(block => block.id))
  for (const block of liveBlocks) {
    if (!blockIds.has(block.id)) {
      merged.push(block)
      blockIds.add(block.id)
    }
  }
  return merged
}

function preferCompleteContent(transcriptContent: string, liveContent: string): string {
  if (!transcriptContent) return liveContent
  if (!liveContent) return transcriptContent
  if (transcriptContent.startsWith(liveContent)) return transcriptContent
  if (liveContent.startsWith(transcriptContent)) return liveContent
  return transcriptContent
}

export function getRuntimeMessageIndex(message: WorkbenchMessage): number | null {
  return typeof message.runtimeMessageIndex === 'number' &&
    Number.isFinite(message.runtimeMessageIndex)
    ? message.runtimeMessageIndex
    : null
}
