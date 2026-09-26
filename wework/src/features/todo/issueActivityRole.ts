import type { ProjectChatMessage } from '@/api/backend/projectChatSocket'

export function issueActivityRole(message: ProjectChatMessage) {
  if (message.sender.type !== 'agent') return undefined
  if (message.metadata.dispatch_role === 'manager') return 'manager'
  return 'member'
}
