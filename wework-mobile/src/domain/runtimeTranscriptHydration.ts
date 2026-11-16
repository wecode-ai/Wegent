import { chatReducer, type ChatAction } from './chatReducer'
import type { ChatMessage, RuntimeTranscriptResponse } from '@/types/runtime'

export function hydrateRuntimeTranscript(
  previous: ChatMessage[],
  transcript: RuntimeTranscriptResponse,
  buffered: ChatAction[],
  loaded: boolean
): { messages: ChatMessage[]; resetPagination: boolean } {
  const snapshot = chatReducer([], { type: 'replace', messages: transcript.messages })
  const snapshotIds = new Set(snapshot.map(message => message.id))
  // Disjoint pages cannot validate cached history or its pagination cursor.
  const resetPagination = loaded && !previous.some(message => snapshotIds.has(message.id))
  let messages = chatReducer(resetPagination ? [] : previous, {
    type: 'merge-latest',
    messages: transcript.messages,
  })
  const settled = new Set(
    snapshot
      .filter(
        message => message.role === 'assistant' && ['completed', 'failed'].includes(message.status)
      )
      .map(message => message.subtaskId)
      .filter(Boolean)
  )
  for (const action of buffered) {
    if (action.type === 'stream') {
      const data = action.event.payload.data as Record<string, unknown> | undefined
      const subtaskId = action.event.payload.subtaskId ?? data?.subtaskId
      if (subtaskId != null && settled.has(String(subtaskId))) continue
    }
    messages = chatReducer(messages, action)
  }
  return { messages, resetPagination }
}
