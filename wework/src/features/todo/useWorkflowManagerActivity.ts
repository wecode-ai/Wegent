import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react'
import type { ProjectChatMessage } from '@/api/backend/projectChatSocket'
import type { CloudLoopItem } from '@/api/deliveries'
import type { RuntimeTaskAddress } from '@/types/api'
import { openExternalUrl } from '@/lib/external-links'
import { resolveMessageRunStatus, backendTaskExecution } from './taskActivityMessageUtils'

export interface ActivityExecutionDetail {
  address: RuntimeTaskAddress
  messageId?: string
  senderName: string
  runId: string | null
  modelName: string | null
  runStatus: string | null
}

export function useWorkflowManagerActivity({
  task,
  messages,
  workflowManagerRunId,
  listRef,
  setExecutionDetail,
  onWorkflowManagerExecutionChange,
  onWorkflowManagerFinished,
}: {
  task: CloudLoopItem
  messages: ProjectChatMessage[]
  workflowManagerRunId: string | null
  listRef: RefObject<HTMLDivElement | null>
  setExecutionDetail(detail: ActivityExecutionDetail): void
  onWorkflowManagerExecutionChange?(action: (() => void) | null): void
  onWorkflowManagerFinished?(): void
}) {
  const refreshedWorkflowManagerMessageIds = useRef(new Set<string>())
  const workflowManagerMessage = useMemo(
    () =>
      workflowManagerRunId
        ? messages
            .filter(
              message => String(message.metadata.automation_run_id ?? '') === workflowManagerRunId
            )
            .at(-1)
        : undefined,
    [messages, workflowManagerRunId]
  )
  const workflowManagerRuntimeAddress = useMemo(() => {
    const address = workflowManagerMessage?.runtimeAddress
    if (!address?.deviceId || !address.taskId) return null
    return address
  }, [workflowManagerMessage])
  const workflowManagerBackendExecution = useMemo(
    () => (workflowManagerMessage ? backendTaskExecution(workflowManagerMessage) : null),
    [workflowManagerMessage]
  )
  const openWorkflowManagerExecution = useCallback(() => {
    if (!workflowManagerMessage) return
    if (workflowManagerRuntimeAddress) {
      setExecutionDetail({
        address: workflowManagerRuntimeAddress,
        messageId: workflowManagerMessage.messageId,
        senderName: workflowManagerMessage.sender.name,
        runId:
          typeof workflowManagerMessage.metadata.run_id === 'string'
            ? workflowManagerMessage.metadata.run_id
            : null,
        modelName:
          typeof workflowManagerMessage.metadata.model === 'string'
            ? workflowManagerMessage.metadata.model
            : null,
        runStatus: resolveMessageRunStatus(task.ai_state, workflowManagerMessage),
      })
      return
    }
    if (workflowManagerBackendExecution) {
      void openExternalUrl(workflowManagerBackendExecution.executionUrl)
      return
    }
    const card = listRef.current?.querySelector<HTMLElement>(
      `[data-testid="cloud-task-activity-card-${workflowManagerMessage.messageId}"]`
    )
    card?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [
    task.ai_state,
    listRef,
    setExecutionDetail,
    workflowManagerBackendExecution,
    workflowManagerMessage,
    workflowManagerRuntimeAddress,
  ])

  useEffect(() => {
    if (!onWorkflowManagerExecutionChange) return
    onWorkflowManagerExecutionChange(workflowManagerMessage ? openWorkflowManagerExecution : null)
    return () => onWorkflowManagerExecutionChange(null)
  }, [onWorkflowManagerExecutionChange, openWorkflowManagerExecution, workflowManagerMessage])

  useEffect(() => {
    if (!workflowManagerMessage || !onWorkflowManagerFinished) return
    if (!['completed', 'failed', 'cancelled', 'canceled'].includes(workflowManagerMessage.status)) {
      return
    }
    if (refreshedWorkflowManagerMessageIds.current.has(workflowManagerMessage.messageId)) return
    refreshedWorkflowManagerMessageIds.current.add(workflowManagerMessage.messageId)
    onWorkflowManagerFinished()
  }, [onWorkflowManagerFinished, workflowManagerMessage])
}
