import type { ProjectChatMessage } from '@/api/backend/projectChatSocket'

export function assignmentReplyRootId(
  messages: ProjectChatMessage[],
  assignmentId?: string
): string | null {
  if (!assignmentId) return null
  const question = messages.find(message => {
    if (message.sender.type !== 'system' || message.sender.id !== 'issue_assignment') return false
    const assignment = message.metadata.issue_assignment
    return (
      assignment &&
      typeof assignment === 'object' &&
      'id' in assignment &&
      assignment.id === assignmentId &&
      'status' in assignment &&
      assignment.status === 'waiting_human'
    )
  })
  return question ? question.rootMessageId || question.messageId : null
}
