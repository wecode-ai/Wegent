import { useContext, useRef, useState } from 'react'
import { FolderInput } from 'lucide-react'
import type { ActionMenuItem } from '@/components/common/ActionMenu'
import { WorkbenchContext } from '@/features/workbench/workbenchContexts'
import { useTranslation } from '@/hooks/useTranslation'
import type { RuntimeDeviceWorkspace, RuntimeTaskSummary } from '@/types/api'

export function useMoveRuntimeTaskMenu(
  workspace: RuntimeDeviceWorkspace,
  task: RuntimeTaskSummary,
  threadId: string | null,
  stateDeviceId?: string | null
): ActionMenuItem {
  const { t } = useTranslation('common')
  const workbench = useContext(WorkbenchContext)
  const pendingRef = useRef(false)
  const [pending, setPending] = useState(false)
  const deviceId = stateDeviceId || workspace.deviceId
  const hasSession = Boolean(
    task.threadId || task.runtimeHandle?.threadId || task.runtimeHandle?.thread_id
  )
  const targets = (workbench?.state?.runtimeWork?.projects ?? []).filter(
    ({ project, deviceWorkspaces }) =>
      Boolean(project.key) &&
      project.stateDeviceId === deviceId &&
      deviceWorkspaces.some(
        candidate =>
          candidate.available &&
          candidate.deviceId === workspace.deviceId &&
          (candidate.remoteHostId || null) === (workspace.remoteHostId || null)
      ) &&
      !deviceWorkspaces.some(
        candidate =>
          candidate.deviceId === workspace.deviceId &&
          candidate.tasks.some(item => item.taskId === task.taskId)
      )
  )

  return {
    label: t('workbench.move_task_to_project'),
    icon: FolderInput,
    testId: `runtime-local-task-menu-move-${task.taskId}`,
    disabled:
      !workspace.available ||
      !hasSession ||
      !threadId ||
      !workbench ||
      pending ||
      targets.length === 0,
    children: targets.map(({ project }) => ({
      label: project.name,
      testId: `runtime-local-task-move-${task.taskId}-${project.key}`,
      onSelect: async () => {
        if (!workbench || !workspace.available || !hasSession || !threadId || pendingRef.current)
          return
        pendingRef.current = true
        setPending(true)
        try {
          await workbench.reorderRuntimeProjectTasks({
            deviceId,
            projectKey: project.key,
            threadId,
            insertAtEnd: true,
          })
        } catch {
          workbench.setWorkbenchError(t('workbench.move_task_to_project_failed'))
        } finally {
          pendingRef.current = false
          setPending(false)
        }
      },
    })),
  }
}
