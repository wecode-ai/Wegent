import type { WorkbenchMessage } from '@/types/workbench'

export function mergeRuntimeTranscriptMessages(
  transcriptMessages: WorkbenchMessage[],
  liveMessages: WorkbenchMessage[]
): WorkbenchMessage[] {
  const merged = [...transcriptMessages]
  const indexesById = new Map(merged.map((message, index) => [message.id, index]))
  const assistantIndexesBySubtask = new Map<string, number>()

  merged.forEach((message, index) => {
    if (message.role === 'assistant' && message.subtaskId) {
      assistantIndexesBySubtask.set(message.subtaskId, index)
    }
  })

  for (const liveMessage of liveMessages) {
    if (indexesById.has(liveMessage.id)) continue

    const matchingSubtaskIndex =
      liveMessage.role === 'assistant' && liveMessage.subtaskId
        ? assistantIndexesBySubtask.get(liveMessage.subtaskId)
        : undefined
    if (matchingSubtaskIndex !== undefined) {
      merged[matchingSubtaskIndex] = mergeTranscriptAssistantMessage(
        merged[matchingSubtaskIndex],
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
    blocks:
      transcriptMessage.blocks && transcriptMessage.blocks.length > 0
        ? transcriptMessage.blocks
        : liveMessage.blocks,
    fileChanges: transcriptMessage.fileChanges ?? liveMessage.fileChanges,
    status: transcriptSettled ? transcriptMessage.status : liveMessage.status,
    runtimeStatus: transcriptSettled
      ? transcriptMessage.runtimeStatus
      : (liveMessage.runtimeStatus ?? transcriptMessage.runtimeStatus),
    completedAt: transcriptMessage.completedAt ?? liveMessage.completedAt,
  }
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
