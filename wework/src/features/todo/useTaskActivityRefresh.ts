import { useEffect, useRef } from 'react'
import type { ProjectChatMessage } from '@/api/backend/projectChatSocket'
import type { CloudLoopItem } from '@/api/deliveries'
import { isExecutionTerminal } from './executionStatus'

export function useTaskActivityRefresh({
  task,
  messages,
  projectDeliveryApi,
  onTaskUpdated,
  onRefreshExecutionArtifacts,
  setError,
  t,
}: {
  task: CloudLoopItem
  messages: ProjectChatMessage[]
  projectDeliveryApi?: { getLoopItem(id: string): Promise<CloudLoopItem> }
  onTaskUpdated?(task: CloudLoopItem): void
  onRefreshExecutionArtifacts?(): void | Promise<void>
  setError(error: string): void
  t(key: string): string
}) {
  const refreshedRunIds = useRef(new Set<string>())
  const taskAiStatus = task.ai_state?.status
  const taskAiMessageId = task.ai_state?.project_chat_message_id
  const taskAiRuntimeDeviceId = task.ai_state?.runtime_device_id
  const taskAiRuntimeTaskId = task.ai_state?.runtime_task_id
  useEffect(() => {
    if (
      !projectDeliveryApi ||
      typeof projectDeliveryApi.getLoopItem !== 'function' ||
      task.status === 'completed'
    ) {
      return
    }
    const terminalResponse = messages.find(message => {
      if (message.taskId !== task.id || message.sender.type !== 'agent') return false
      if (!isExecutionTerminal(message.status)) return false
      return !refreshedRunIds.current.has(message.messageId)
    })
    if (!terminalResponse) {
      if (taskAiStatus === 'running') {
        console.info('[Wework] Task activity waiting for terminal AI message', {
          taskId: task.id,
          taskStatus: task.status,
          aiStatus: taskAiStatus,
          aiMessageId: taskAiMessageId,
          runtimeDeviceId: taskAiRuntimeDeviceId,
          runtimeTaskId: taskAiRuntimeTaskId,
          agentMessages: messages
            .filter(message => message.taskId === task.id && message.sender.type === 'agent')
            .map(message => ({
              messageId: message.messageId,
              status: message.status,
              runtimeTaskId: message.runtimeAddress?.taskId,
            })),
        })
      }
      return
    }
    refreshedRunIds.current.add(terminalResponse.messageId)
    console.info('[Wework] Task activity terminal AI message received; refreshing task', {
      taskId: task.id,
      messageId: terminalResponse.messageId,
      messageStatus: terminalResponse.status,
      runtimeDeviceId: terminalResponse.runtimeAddress?.deviceId,
      runtimeTaskId: terminalResponse.runtimeAddress?.taskId,
    })
    void Promise.all([
      projectDeliveryApi.getLoopItem(task.id).then(updated => {
        console.info('[Wework] Task activity refreshed task after terminal AI message', {
          taskId: updated.id,
          taskStatus: updated.status,
          aiStatus: updated.ai_state?.status,
          aiMessageId: updated.ai_state?.project_chat_message_id,
          runtimeTaskId: updated.ai_state?.runtime_task_id,
        })
        onTaskUpdated?.(updated)
      }),
      onRefreshExecutionArtifacts?.(),
    ]).catch(cause => {
      setError(cause instanceof Error ? cause.message : t('workbench.project_chat_load_failed'))
    })
  }, [
    messages,
    setError,
    onRefreshExecutionArtifacts,
    onTaskUpdated,
    projectDeliveryApi,
    t,
    task.id,
    task.status,
    taskAiMessageId,
    taskAiRuntimeDeviceId,
    taskAiRuntimeTaskId,
    taskAiStatus,
  ])
}
