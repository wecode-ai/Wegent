import type { ProjectChatMessage } from '@/api/backend/projectChatSocket'
import type { CloudLoopItem } from '@/api/deliveries'
import { isHttpUrl } from '@/lib/external-links'

export function resolveMessageRunStatus(
  taskAiState: CloudLoopItem['ai_state'] | undefined,
  message: ProjectChatMessage
): string {
  const messageStatus = message.status.toLowerCase()
  if (['completed', 'failed', 'cancelled', 'canceled'].includes(messageStatus)) {
    return messageStatus
  }
  const metadataStatus = message.metadata.run_status
  if (typeof metadataStatus === 'string' && metadataStatus) {
    return metadataStatus
  }
  if (taskAiState?.project_chat_message_id === message.messageId && taskAiState.status) {
    return taskAiState.status
  }
  return messageStatus
}

export function backendTaskExecution(message: ProjectChatMessage): {
  taskId: string
  executionUrl: string
} | null {
  const rawTaskId = message.metadata.backend_task_id
  const taskId =
    typeof rawTaskId === 'number' && Number.isFinite(rawTaskId) && rawTaskId > 0
      ? String(rawTaskId)
      : typeof rawTaskId === 'string' && rawTaskId.trim()
        ? rawTaskId.trim()
        : null
  const executionUrl = message.metadata.execution_url
  return taskId && typeof executionUrl === 'string' && isHttpUrl(executionUrl)
    ? { taskId, executionUrl }
    : null
}
