import type { CloudLoopItem } from '@/api/deliveries'
import type { ProjectChatMessage } from '@/api/backend/projectChatSocket'
import type { ProjectChatAgent } from '@/api/projectChatAgents'

/** Resolve the current run's creator without inferring ownership from a group. */
export function issueExecutionApprovalCreator(
  task: Pick<CloudLoopItem, 'id' | 'execution_id' | 'assignee_agent_id'>,
  messages: readonly ProjectChatMessage[],
  agents: readonly ProjectChatAgent[]
) {
  let agentId = task.assignee_agent_id
  if (task.execution_id != null) {
    if (!Number.isSafeInteger(task.execution_id) || task.execution_id <= 0) return null
    const ids = new Set(
      messages
        .filter(
          message =>
            message.taskId === task.id &&
            message.sender.type === 'agent' &&
            String(message.metadata.execution_id) === String(task.execution_id)
        )
        .map(message => message.sender.id)
    )
    if (ids.size !== 1) return null
    agentId = [...ids][0]
  }
  return (
    agents.find(agent => agent.id === agentId && agent.status === 'active')?.createdByUserId ?? null
  )
}
