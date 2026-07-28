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

  const sortKeys = runtimeMessageSortKeys(merged, existingMessages)
  return merged
    .map((message, order) => ({ message, order, key: sortKeys.get(message.id) }))
    .sort((left, right) => {
      if (!left.key || !right.key) return left.order - right.order
      if (left.key.anchor !== right.key.anchor) return left.key.anchor - right.key.anchor
      if (left.key.position !== right.key.position) return left.key.position - right.key.position
      return left.key.order - right.key.order
    })
    .map(item => item.message)
}

interface RuntimeMessageSortKey {
  anchor: number
  position: -1 | 0 | 1
  order: number
}

function runtimeMessageSortKeys(
  mergedMessages: WorkbenchMessage[],
  existingMessages: WorkbenchMessage[]
): Map<string, RuntimeMessageSortKey> {
  const keys = new Map<string, RuntimeMessageSortKey>()
  for (const [order, message] of mergedMessages.entries()) {
    const index = getRuntimeMessageIndex(message)
    if (index !== null) keys.set(message.id, { anchor: index, position: 0, order })
  }

  for (const [order, message] of existingMessages.entries()) {
    if (keys.has(message.id)) continue
    const nextIndex = firstRuntimeMessageIndex(existingMessages.slice(order + 1))
    if (nextIndex !== null) {
      keys.set(message.id, { anchor: nextIndex, position: -1, order })
      continue
    }
    const previousIndex = firstRuntimeMessageIndex(existingMessages.slice(0, order).reverse())
    if (previousIndex !== null) {
      keys.set(message.id, { anchor: previousIndex, position: 1, order })
    }
  }

  for (const [order, message] of mergedMessages.entries()) {
    if (!keys.has(message.id)) {
      keys.set(message.id, { anchor: Number.POSITIVE_INFINITY, position: 0, order })
    }
  }

  return keys
}

function firstRuntimeMessageIndex(messages: WorkbenchMessage[]): number | null {
  for (const message of messages) {
    const index = getRuntimeMessageIndex(message)
    if (index !== null) return index
  }
  return null
}

export function getRuntimeMessageIndex(message: WorkbenchMessage): number | null {
  return typeof message.runtimeMessageIndex === 'number' &&
    Number.isFinite(message.runtimeMessageIndex)
    ? message.runtimeMessageIndex
    : null
}
