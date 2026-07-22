import type { WorkbenchMessage } from '@/types/workbench'

export function mergeRuntimeTranscriptMessages(
  transcriptMessages: WorkbenchMessage[],
  existingMessages: WorkbenchMessage[]
): WorkbenchMessage[] {
  const merged = [...transcriptMessages]
  const messageIds = new Set(merged.map(message => message.id))

  for (const message of existingMessages) {
    if (messageIds.has(message.id)) continue
    messageIds.add(message.id)
    merged.push(message)
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

export function getRuntimeMessageIndex(message: WorkbenchMessage): number | null {
  return typeof message.runtimeMessageIndex === 'number' &&
    Number.isFinite(message.runtimeMessageIndex)
    ? message.runtimeMessageIndex
    : null
}
