import type { ProjectChatMessage } from '@wegent/chat-core'
import type { ExecutionTaskSummary } from './IssueChatMessage'

export function issueTaskSummaryForMessage<
  Binding extends {
    device_id: string
    task_id: string
    task_title?: string | null
    workflow_node_id?: string | null
  },
>(
  message: ProjectChatMessage,
  bindings: Binding[],
  issueTitle: string,
  stages: Array<{ id: string; name: string }> | undefined,
  onOpen?: (binding: Binding) => void
): ExecutionTaskSummary | undefined {
  const address = message.runtimeAddress
  if (
    message.sender.type !== 'agent' ||
    message.metadata.executor_type === 'automation_manager' ||
    message.metadata.conversation_only === true ||
    !address?.deviceId ||
    !address.taskId
  )
    return
  const binding = bindings.find(
    candidate => candidate.device_id === address.deviceId && candidate.task_id === address.taskId
  )
  if (!binding) return
  const stage = stages?.find(candidate => candidate.id === binding.workflow_node_id)
  return {
    title: binding.task_title || stage?.name || issueTitle,
    stageName: stage?.name ?? null,
    onOpen: onOpen ? () => onOpen(binding) : undefined,
  }
}
