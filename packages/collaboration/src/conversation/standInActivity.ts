import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'

export function isStandInActivityMessage(
  message: Pick<WorkbenchMessage, 'role' | 'source'>
): boolean {
  return message.role === 'user' && message.source?.source === 'stand_in_activity'
}

export function isCompletedStandInActivityTrace(message: WorkbenchMessage): boolean {
  if (message.role !== 'assistant' || message.status !== 'done') return false
  if (message.runtimeStatus && message.runtimeStatus !== 'done') return false
  if (
    message.content.trim() ||
    message.contentLoadRef ||
    message.error ||
    message.stoppedNotice ||
    message.runtimeDisplayItems?.some(
      item => item.type === 'assistant_text' && item.content.trim()
    ) ||
    message.attachments?.length ||
    message.fileChanges ||
    message.references?.length ||
    message.memoryCitations?.length
  )
    return false

  return (message.blocks ?? []).every(block => {
    if (block.status !== 'done') return false
    if (block.type === 'thinking') return true
    if (block.type === 'tool') return !block.renderPayload
    return block.type === 'text' && !block.content.trim() && !block.contentLoadRef
  })
}
