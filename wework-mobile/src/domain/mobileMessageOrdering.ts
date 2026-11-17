import { runtimeAssistantViewId } from '../../../packages/chat-core/src/runtime-turn-projection'
import type { ChatMessage } from '@/types/runtime'
import { insertMissingOrderedEntries } from '../../../packages/chat-core/src/ordered-conversation-entries'

export function bindStreamUser(
  state: ChatMessage[],
  identity: { subtaskId: string; clientUserMessageId?: string }
): ChatMessage[] {
  if (!identity.clientUserMessageId) return state
  const userIndex = state.findIndex(
    message => message.role === 'user' && message.id === identity.clientUserMessageId
  )
  if (userIndex < 0) return state
  const user = { ...state[userIndex], subtaskId: identity.subtaskId, turnId: identity.subtaskId }
  const assistantIndex = state.findIndex(
    message => message.role === 'assistant' && message.subtaskId === identity.subtaskId
  )
  const hasEarlierUser =
    assistantIndex >= 0 &&
    state
      .slice(0, assistantIndex)
      .some(message => message.role === 'user' && message.subtaskId === identity.subtaskId)
  const target =
    assistantIndex < 0 || hasEarlierUser ? userIndex : Math.min(userIndex, assistantIndex)
  if (
    target === userIndex &&
    state[userIndex].subtaskId === identity.subtaskId &&
    state[userIndex].turnId === identity.subtaskId
  )
    return state
  const otherMessages = state.filter((_, index) => index !== userIndex)
  return [...otherMessages.slice(0, target), user, ...otherMessages.slice(target)]
}

export function uniqueMessages(messages: ChatMessage[]): ChatMessage[] {
  const unique = new Map<string, ChatMessage>()
  for (const message of messages) {
    const attachments = message.attachments ?? unique.get(message.id)?.attachments
    unique.set(message.id, attachments ? { ...message, attachments } : message)
  }
  return [...unique.values()]
}

export function mergeLatestMessages(state: ChatMessage[], snapshot: ChatMessage[]): ChatMessage[] {
  const canonical = uniqueMessages(snapshot)
  const merged = new Map(
    uniqueMessages([...state, ...canonical]).map(message => [message.id, message])
  )
  const canonicalIds = new Set(canonical.map(message => message.id))
  const ordered = insertMissingOrderedEntries(state, canonical)
  let canonicalIndex = 0
  // Keep cached neighbors in place, then correct the snapshot-owned slots to native order.
  return ordered.map(message => {
    const id = canonicalIds.has(message.id) ? canonical[canonicalIndex++].id : message.id
    return merged.get(id)!
  })
}

export interface StreamIdentity {
  taskId?: string
  subtaskId: string
  clientUserMessageId?: string
  itemId?: string
}

export function updateStreamAssistant(
  state: ChatMessage[],
  identity: StreamIdentity,
  update: (message: ChatMessage) => ChatMessage
): ChatMessage[] {
  const ownsTurn = (message: ChatMessage) =>
    message.role === 'assistant' && message.subtaskId === identity.subtaskId
  const owner = identity.itemId
    ? state.findIndex(
        message =>
          ownsTurn(message) &&
          (message.textItems?.some(item => item.id === identity.itemId) ||
            message.blocks?.some(block => block.id === identity.itemId))
      )
    : -1
  const boundary = state.findLastIndex(
    message => message.role === 'user' && message.subtaskId === identity.subtaskId
  )
  const index =
    owner >= 0
      ? owner
      : state.findLastIndex((message, index) => ownsTurn(message) && index > boundary)
  if (index < 0) {
    const afterUser = boundary >= 0 && state.slice(0, boundary).some(ownsTurn)
    const message = update({
      id: runtimeAssistantViewId(
        identity.subtaskId,
        afterUser ? `after:${state[boundary].runtimeItemId ?? state[boundary].id}` : 'assistant'
      ),
      taskId: identity.taskId,
      subtaskId: identity.subtaskId,
      role: 'assistant',
      content: '',
      status: 'pending',
      createdAt: Date.now(),
    })
    const position = boundary < 0 ? state.length : boundary + 1
    return [...state.slice(0, position), message, ...state.slice(position)]
  }

  return state.map((message, messageIndex) =>
    messageIndex === index
      ? update({ ...message, taskId: identity.taskId ?? message.taskId })
      : message
  )
}
