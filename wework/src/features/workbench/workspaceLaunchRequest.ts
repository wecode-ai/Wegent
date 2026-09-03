import { normalizeRuntimeWorkspacePath } from '@/lib/runtime-project'

export interface WorkbenchWorkspaceLaunchOptions {
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
}

export function consumeWorkbenchWorkspaceLaunch(
  deviceId: string,
  workspacePath: string
): WorkbenchWorkspaceLaunchOptions | null {
  if (
    !pendingLaunch ||
    pendingLaunch.deviceId !== deviceId.trim() ||
    pendingLaunch.workspacePath !== normalizeRuntimeWorkspacePath(workspacePath)
  ) {
    return null
  }

  const { options } = pendingLaunch
  pendingLaunch = null
  return options
}

export function clearWorkbenchWorkspaceLaunch() {
  pendingLaunch = null
}
