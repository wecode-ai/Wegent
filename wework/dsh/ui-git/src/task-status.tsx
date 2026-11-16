import { useContext, useMemo, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'

import { ChangeRequestStatusIcon } from '@/components/common/ChangeRequestStatusIcon'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
import {
  getChangeRequestMonitor,
  runtimeTaskChangeRequestTarget,
  useTaskChangeRequest,
} from '@/features/workbench/changeRequestMonitor'
import {
  autoRepairStatus,
  buildChangeRequestRepairPrompt,
} from '@/features/workbench/changeRequestStatus'
import { WorkbenchContext } from '@/features/workbench/workbenchContexts'
import { createRuntimeUserMessage } from '@/features/workbench/runtimeUserMessage'
import { appendOptimisticRuntimeConversationGuidance } from '@/features/workbench/runtimeConversationCache'
import { useRuntimeTaskLifecycleStore } from '@/features/workbench/runtimeTaskLifecycle'
import { isRuntimeTaskExecutionRunning } from '@/features/workbench/runtimeTaskLifecycle/projection'
import type { RuntimeDeviceWorkspace, RuntimeTaskSummary } from '@/types/api'

interface GitTaskStatusProps {
  priorityLayout?: boolean
  statusInIndent?: boolean
  task: RuntimeTaskSummary
  workspace: RuntimeDeviceWorkspace
}

export default function GitTaskStatus({
  priorityLayout = false,
  statusInIndent = false,
  task,
  workspace,
}: GitTaskStatusProps) {
  const { t } = useTranslation('common')
  const preferences = useAppPreferencesState()
  const enabled = preferences?.preferences.changeRequestStatusEnabled ?? true
  const workbench = useContext(WorkbenchContext)
  const lifecycleStore = useRuntimeTaskLifecycleStore()
  const [repairing, setRepairing] = useState(false)
  const target = useMemo(() => runtimeTaskChangeRequestTarget(workspace, task), [task, workspace])
  const monitor = useMemo(
    () =>
      enabled && workbench?.services?.deviceApi
        ? getChangeRequestMonitor(workbench.services.deviceApi)
        : null,
    [enabled, workbench]
  )
  const snapshot = useTaskChangeRequest(monitor, enabled ? target : null)

  const continueRepair = async () => {
    const changeRequest = snapshot?.changeRequest
    if (!workbench || !changeRequest || !autoRepairStatus(changeRequest)) return
    setRepairing(true)
    try {
      const prompt = buildChangeRequestRepairPrompt(changeRequest, task.title)
      const address = { deviceId: workspace.deviceId, taskId: task.taskId }
      const userMessage = createRuntimeUserMessage(prompt)
      const busy =
        lifecycleStore.getTask(address)?.derived.isBusy ?? isRuntimeTaskExecutionRunning(task)
      workbench.setWorkbenchError(null)
      if (busy) {
        const result = await workbench.sendRuntimePaneGuidance({
          address,
          message: prompt,
          clientGuidanceId: userMessage.id,
        })
        if (result.sent) {
          if (result.turnId) {
            appendOptimisticRuntimeConversationGuidance(address, result.turnId, {
              id: userMessage.id,
              content: prompt,
              createdAt: userMessage.createdAt!,
              status: 'sending',
              deliveryMode: 'guidance',
            })
          }
          return
        }
        // The turn can finish between reading its state and delivering guidance.
        if (result.code !== 'no_active_turn') {
          workbench.setWorkbenchError(
            result.error || t('workbench.change_request_continue_repair_failed')
          )
          return
        }
      }
      await workbench.sendRuntimePaneMessage(
        {
          address,
          message: prompt,
          source: { source: 'manual' },
        },
        { optimisticUserMessage: userMessage }
      )
    } catch (error) {
      workbench.setWorkbenchError(
        error instanceof Error
          ? error.message
          : t('workbench.change_request_continue_repair_failed')
      )
    } finally {
      setRepairing(false)
    }
  }

  return (
    <ChangeRequestStatusIcon
      snapshot={snapshot}
      testId={`runtime-local-task-change-request-${task.taskId}`}
      repairing={repairing}
      onContinueRepair={
        snapshot?.changeRequest && autoRepairStatus(snapshot.changeRequest)
          ? continueRepair
          : undefined
      }
      className={statusInIndent && !priorityLayout ? '-ml-7 mr-1' : 'mr-1'}
      popoverAlign="left"
    />
  )
}
