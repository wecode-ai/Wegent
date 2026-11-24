import type { StandInTaskPermissions } from '@/api/personalStandIn'
import type { ProjectChatControls } from '@/components/chat/ChatInput'
import { getStandInErrorMessage, reportStandInError } from '@/lib/stand-in-error-message'
import type { RuntimeTaskAddress, RuntimeTaskSummary } from '@/types/api'
import { useRef, useState } from 'react'
import type { RefreshWorkLists } from './workbenchContextTypes'
import type { WorkbenchServices } from './workbenchServices'

type ComposerControls = Pick<ProjectChatControls, 'permissionControls' | 'permissionError'>
const NO_TASK_PERMISSIONS: ComposerControls = {}
const HIDDEN_TASK_PERMISSIONS: ComposerControls = { permissionControls: null }

interface PermissionMutation {
  scope: string
  pending?: boolean
  before?: StandInTaskPermissions
  saved?: StandInTaskPermissions
  error?: string
}

function samePermissions(left?: StandInTaskPermissions, right?: StandInTaskPermissions) {
  return (
    left?.permissionMode === right?.permissionMode &&
    (left?.commandApproval ?? 'manual') === (right?.commandApproval ?? 'manual')
  )
}

export function useRuntimeTaskPermissions(
  address: RuntimeTaskAddress | null | undefined,
  task: RuntimeTaskSummary | null | undefined,
  userId: number | undefined,
  api: WorkbenchServices['standInApi'],
  refreshWorkLists: RefreshWorkLists,
  active = true
): ComposerControls {
  const [mutation, setMutation] = useState<PermissionMutation | null>(null)
  const inFlight = useRef(new Set<string>())
  const handle = task?.runtimeHandle ?? address?.runtimeHandle
  const origin = handle?.origin as { type?: string; userId?: number } | undefined
  const stored = handle?.taskPermissions as StandInTaskPermissions | undefined
  const scope = JSON.stringify([userId, address?.deviceId, address?.taskId])
  const current = mutation?.scope === scope ? mutation : null
  if (current?.saved && !current.pending && !samePermissions(current.before, stored)) {
    setMutation(null)
  }
  if (
    !address ||
    !stored ||
    task?.status === 'archived' ||
    userId === undefined ||
    origin?.userId !== userId ||
    !api?.setTaskPermissions
  ) {
    return origin?.type === 'stand_in_task' ? HIDDEN_TASK_PERMISSIONS : NO_TASK_PERMISSIONS
  }
  const permissions =
    current?.saved && samePermissions(current.before, stored) ? current.saved : stored
  const save = async (next: StandInTaskPermissions) => {
    if (!active || inFlight.current.has(scope) || samePermissions(permissions, next)) return
    inFlight.current.add(scope)
    setMutation({ scope, pending: true, before: stored, saved: current?.saved })
    try {
      const result = await api.setTaskPermissions(userId, address.deviceId, address.taskId, next)
      setMutation(value =>
        value?.scope === scope ? { scope, before: stored, saved: result.taskPermissions } : value
      )
    } catch (cause) {
      reportStandInError('save_task_permissions', cause, address.deviceId)
      const error = getStandInErrorMessage(cause, 'task_permissions_save_failed')
      setMutation(value => (value?.scope === scope ? { ...value, pending: false, error } : value))
      // A disconnected caller can lose the receipt after the executor saves.
      void refreshWorkLists({ refreshDevices: false }).catch(cause =>
        reportStandInError('refresh_task_permissions', cause, address.deviceId)
      )
    } finally {
      inFlight.current.delete(scope)
    }
  }
  return {
    permissionControls: {
      value: permissions.permissionMode,
      commandApproval: permissions.commandApproval,
      disabled: !active || current?.pending === true,
      onChange: (permissionMode, commandApproval = permissions.commandApproval) => {
        void save({ permissionMode, commandApproval })
      },
      onCommandApprovalChange: commandApproval => {
        void save({ permissionMode: permissions.permissionMode, commandApproval })
      },
    },
    permissionError: current?.error
      ? {
          message: current.error,
          dismiss: () => {
            setMutation(value => (value?.scope === scope ? { ...value, error: undefined } : value))
          },
        }
      : undefined,
  }
}
