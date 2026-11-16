import { normalizeRuntimeWorkspacePath } from '@/lib/runtime-project'
import type { WorkspaceFileOpenOptions } from '@/types/workspace-files'

export interface WorkbenchWorkspaceLaunchOptions {
  taskId?: string
  openFile?: { path: string; options?: WorkspaceFileOpenOptions }
  initialInput?: string
  rightSidebarTab?: {
    type: string
  }
}

interface PendingWorkbenchWorkspaceLaunch {
  deviceId: string
  workspacePath: string
  options: WorkbenchWorkspaceLaunchOptions
}

let pendingLaunch: PendingWorkbenchWorkspaceLaunch | null = null
const listeners = new Set<() => void>()

export function subscribeWorkbenchWorkspaceLaunch(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getWorkbenchWorkspaceLaunch() {
  return pendingLaunch
}

function notifyLaunchChanged() {
  for (const listener of listeners) listener()
}

export function queueWorkbenchWorkspaceLaunch(
  deviceId: string,
  workspacePath: string,
  options: WorkbenchWorkspaceLaunchOptions
) {
  pendingLaunch = {
    deviceId: deviceId.trim(),
    workspacePath: normalizeRuntimeWorkspacePath(workspacePath),
    options,
  }
  notifyLaunchChanged()
}

export function consumeWorkbenchWorkspaceLaunch(
  deviceId: string,
  workspacePath: string,
  taskId?: string
): WorkbenchWorkspaceLaunchOptions | null {
  if (
    !pendingLaunch ||
    pendingLaunch.deviceId !== deviceId.trim() ||
    pendingLaunch.workspacePath !== normalizeRuntimeWorkspacePath(workspacePath) ||
    (pendingLaunch.options.taskId !== undefined && pendingLaunch.options.taskId !== taskId)
  ) {
    return null
  }

  const { options } = pendingLaunch
  pendingLaunch = null
  notifyLaunchChanged()
  return options
}

export function clearWorkbenchWorkspaceLaunch() {
  pendingLaunch = null
  notifyLaunchChanged()
}
