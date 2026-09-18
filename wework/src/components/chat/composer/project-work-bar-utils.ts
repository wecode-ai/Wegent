import type {
  DeviceInfo,
  ProjectExecutionMode,
  ProjectWithTasks,
  RuntimeDeviceWorkspace,
} from '@/types/api'
import { isWeWorkExecutorVersionCompatible } from '@/lib/device-capabilities'
import type {
  ProjectWorktreeAvailability,
  ProjectWorktreeAvailabilityReason,
} from '@/lib/worktree-availability'

import { getProjectDeviceId } from '@wegent/collaboration/controls/project-work-bar-utils'
export * from '@wegent/collaboration/controls/project-work-bar-utils'
export function resolveComposerWorktreeAvailability({
  project,
  workspace,
  device,
  availability,
}: {
  project: ProjectWithTasks | null | undefined
  workspace: RuntimeDeviceWorkspace | null | undefined
  device: DeviceInfo | undefined
  availability?: ProjectWorktreeAvailability
}): ProjectWorktreeAvailability {
  if (availability) return availability
  const deviceId = workspace?.deviceId?.trim() || null
  const sourcePath = workspace?.workspacePath?.trim() || null
  if (!project) return { available: false, reason: 'no_project', deviceId, sourcePath }
  if (!workspace) {
    return {
      available: false,
      reason: 'no_workspace',
      deviceId: getProjectDeviceId(project) ?? null,
      sourcePath: null,
    }
  }

  const status = workspace.deviceStatus ?? device?.status
  if (!workspace.available) {
    return { available: false, reason: 'workspace_unavailable', deviceId, sourcePath }
  }
  if (status !== 'online' && status !== 'busy') {
    return { available: false, reason: 'device_offline', deviceId, sourcePath }
  }
  if (device && !isWeWorkExecutorVersionCompatible(device.executor_version)) {
    return { available: false, reason: 'executor_unsupported', deviceId, sourcePath }
  }

  return { available: false, reason: 'preflight_pending', deviceId, sourcePath }
}

export function getProjectWorktreeUnavailableMessageKey(
  reason: Exclude<ProjectWorktreeAvailabilityReason, 'available'>
): string {
  return `workbench.worktree_unavailable_${reason}`
}

export function resolveProjectExecutionUi({
  project,
  executionMode,
  executionModeLocked,
  worktreeAvailability,
}: {
  project: ProjectWithTasks | null | undefined
  executionMode: ProjectExecutionMode
  executionModeLocked: boolean
  worktreeAvailability: ProjectWorktreeAvailability
}) {
  const displayedMode: ProjectExecutionMode = project ? executionMode : 'current_workspace'

  return {
    displayedMode,
    supportsWorktree: worktreeAvailability.available,
    canShowModeControl: Boolean(project),
    canOpenModeMenu: Boolean(project) && !executionModeLocked,
  }
}
