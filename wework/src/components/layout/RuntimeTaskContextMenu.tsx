import { useContext, type RefObject } from 'react'
import { FolderInput } from 'lucide-react'
import { ActionMenu, type ActionMenuItem, type MenuPosition } from '@/components/common/ActionMenu'
import { executeDshCommand } from '@/features/dsh-runtime/dshExtensions'
import { useDshMenuCommands } from '@/features/dsh-runtime/useDshMenuCommands'
import { WorkbenchContext } from '@/features/workbench/workbenchContexts'
import { useTranslation } from '@/hooks/useTranslation'
import type { RuntimeDeviceWorkspace, RuntimeTaskAddress, RuntimeTaskSummary } from '@/types/api'
import { dshMenuItemIcon } from './desktopSidebarHelpers'

interface RuntimeTaskContextMenuProps {
  workspace: RuntimeDeviceWorkspace
  task: RuntimeTaskSummary
  address: RuntimeTaskAddress
  threadId: string | null
  stateDeviceId?: string | null
  position: MenuPosition
  onClose: () => void
  beforeProject: ActionMenuItem[]
  afterExtensions: ActionMenuItem[]
  movePending: boolean
  setMovePending: (pending: boolean) => void
  movePendingRef: RefObject<boolean>
}

export function RuntimeTaskContextMenu({
  workspace,
  task,
  address,
  threadId,
  stateDeviceId,
  position,
  onClose,
  beforeProject,
  afterExtensions,
  movePending,
  setMovePending,
  movePendingRef,
}: RuntimeTaskContextMenuProps) {
  const { t } = useTranslation('common')
  const workbench = useContext(WorkbenchContext)
  const extensions = useDshMenuCommands('conversation.context')
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

  const move: ActionMenuItem = {
    label: t('workbench.move_task_to_project'),
    icon: FolderInput,
    testId: `runtime-local-task-menu-move-${task.taskId}`,
    disabled:
      !workspace.available ||
      !hasSession ||
      !threadId ||
      !workbench ||
      movePending ||
      targets.length === 0,
    children: targets.map(({ project }) => ({
      label: project.name,
      testId: `runtime-local-task-move-${task.taskId}-${project.key}`,
      onSelect: async () => {
        if (
          !workbench ||
          !workspace.available ||
          !hasSession ||
          !threadId ||
          movePendingRef.current
        )
          return
        movePendingRef.current = true
        setMovePending(true)
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
          movePendingRef.current = false
          setMovePending(false)
        }
      },
    })),
  }
  return (
    <ActionMenu
      ariaLabel={t('workbench.task_actions')}
      testId={`runtime-local-task-menu-${task.taskId}`}
      contextMenuPosition={position}
      onContextMenuClose={onClose}
      hideTrigger
      items={[
        ...beforeProject,
        move,
        ...extensions.map(action => ({
          label: action.title,
          icon: dshMenuItemIcon(action.icon),
          testId: `runtime-local-task-menu-extension-${action.id}-${task.taskId}`,
          disabled: !workspace.available || !action.enabled,
          onSelect: async () => {
            await executeDshCommand(
              action.command,
              {
                deviceId: address.deviceId,
                taskId: address.taskId,
                workspacePath: address.workspacePath,
              },
              { menuId: action.id, menuLocation: 'conversation.context', source: 'menu' }
            )
          },
        })),
        ...afterExtensions,
      ]}
    />
  )
}
