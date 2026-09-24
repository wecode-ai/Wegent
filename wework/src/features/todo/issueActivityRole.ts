import type { ProjectChatMessage } from '@/api/backend/projectChatSocket'

export function issueActivityRole(message: ProjectChatMessage) {
  if (message.sender.type !== 'agent') return undefined
  const role = message.metadata.dispatch_role ?? message.metadata.automation_role
  if (role === 'manager_review') return 'manager_review'
  if (
    role === 'manager' ||
    typeof message.metadata.manager_type === 'string' ||
    typeof message.metadata.workflow_plan_run_id === 'string' ||
    message.metadata.workflow_plan_submitted === true
  )
    return 'manager'
  return 'member'
}
