import type {
  RuntimeDeviceWorkspace,
  RuntimeTaskAddress,
  RuntimeTaskSummary,
  RuntimeWorkListResponse,
} from '@/types/runtime'
import { allWorkspaces } from './work'

export interface MobileWorkspaceFileTarget {
  deviceId: string
  path: string
  taskId?: string
  workspaceSource?: string | null
}

/** Follow the PC cloud-device file ownership rules in wework/src/lib/workspace-target.ts. */
export function resolveMobileWorkspaceFileTarget(
  address: RuntimeTaskAddress | null,
  work: RuntimeWorkListResponse,
  selectedWorkspace: RuntimeDeviceWorkspace | null = null
): MobileWorkspaceFileTarget | null {
  if (!address) {
    return selectedWorkspace?.workspacePath.trim()
      ? workspaceTarget(selectedWorkspace, selectedWorkspace.workspacePath.trim())
      : null
  }
  for (const workspace of allWorkspaces(work)) {
    const task = workspace.tasks.find(candidate => taskMatches(address, workspace, candidate))
    if (task) return taskTarget(workspace, task)
  }
  const path = address.workspacePath?.trim()
  if (!path || address.workspaceKind === 'worktree' || address.worktreeId) return null
  return { deviceId: address.deviceId, path, taskId: address.taskId }
}

function workspaceTarget(
  workspace: RuntimeDeviceWorkspace,
  path: string
): MobileWorkspaceFileTarget {
  const remoteHostId = workspace.remoteHostId?.trim()
  return {
    deviceId:
      workspace.workspaceSource === 'remote' && remoteHostId ? remoteHostId : workspace.deviceId,
    path,
    ...(workspace.workspaceSource !== undefined && { workspaceSource: workspace.workspaceSource }),
  }
}

function taskMatches(
  address: RuntimeTaskAddress,
  workspace: RuntimeDeviceWorkspace,
  task: RuntimeTaskSummary
): boolean {
  if (workspace.deviceId !== address.deviceId || task.taskId !== address.taskId) return false
  const path = address.workspacePath?.trim()
  return (
    !path ||
    path === (task.workspacePath || workspace.workspacePath) ||
    path === workspace.workspacePath
  )
}

function taskTarget(
  workspace: RuntimeDeviceWorkspace,
  task: RuntimeTaskSummary
): MobileWorkspaceFileTarget | null {
  const taskPath = task.workspacePath.trim()
  const groupPath = workspace.workspacePath.trim()
  const queuedIndependentWorkspace =
    task.status === 'queued' &&
    (task.workspaceKind === 'worktree' ||
      workspace.workspaceKind === 'worktree' ||
      Boolean(task.worktreeId) ||
      Boolean(workspace.worktreeId) ||
      (Boolean(taskPath) && Boolean(groupPath) && taskPath !== groupPath))
  if (queuedIndependentWorkspace) return null
  const path =
    workspace.workspaceKind === 'worktree' || workspace.worktreeId
      ? workspace.workspacePath
      : task.workspacePath || workspace.workspacePath
  return { ...workspaceTarget(workspace, path), taskId: task.taskId }
}
