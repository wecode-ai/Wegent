import type { ProjectChatMessage } from '@wegent/chat-core'

export interface GroupReplyTarget {
  scopeKey: string
  messageId: string
  senderName: string
  content: string
}

/** The host supplies the current account/group/Thread scope and readable messages. */
export function createGroupReplyTarget(
  scopeKey: string,
  message: ProjectChatMessage
): GroupReplyTarget | null {
  if (
    !message.messageId ||
    !message.content.trim() ||
    message.sender.type === 'system' ||
    message.type === 'system'
  )
    return null
  return {
    scopeKey,
    messageId: message.messageId,
    senderName: message.sender.name || message.sender.id,
    content: message.content,
  }
}
