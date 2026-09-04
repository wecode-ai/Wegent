import { useContext, useMemo, useState } from 'react'

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
  const preferences = useAppPreferencesState()
  const enabled = preferences?.preferences.changeRequestStatusEnabled ?? true
  const workbench = useContext(WorkbenchContext)
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
      await workbench.sendRuntimePaneMessage(
        {
          address: { deviceId: workspace.deviceId, taskId: task.taskId },
          message: prompt,
          source: { source: 'manual' },
        },
        { optimisticUserMessage: createRuntimeUserMessage(prompt) }
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
