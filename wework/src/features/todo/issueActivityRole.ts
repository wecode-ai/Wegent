import type { ProjectChatMessage } from '@/api/backend/projectChatSocket'
import type { CloudLoopItem } from '@/api/deliveries'

export function issueActivityRole(message: ProjectChatMessage, task: CloudLoopItem) {
  if (message.sender.type !== 'agent') return undefined
  const node = task.workflow?.nodes.find(node => node.id === message.metadata.workflow_node_id)
  const role =
    message.metadata.automation_role ??
    (node && 'automation_role' in node ? node.automation_role : undefined)
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
