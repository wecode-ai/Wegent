import type { ProjectChatMessage } from '@/api/backend/projectChatSocket'

export function isPublicStandInMessage(message: ProjectChatMessage): boolean {
  return (
    message.sender.type === 'agent' &&
    message.metadata.execution_dispatch === 'comment_only' &&
    typeof message.metadata.stand_in === 'object' &&
    message.metadata.stand_in !== null
  )
}

export function issueActivityRole(message: ProjectChatMessage) {
  if (message.sender.type !== 'agent') return undefined
  if (message.metadata.dispatch_role === 'manager') return 'manager'
  return 'member'
}
