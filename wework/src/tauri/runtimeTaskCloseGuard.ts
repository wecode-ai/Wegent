import { getCurrentWindow } from '@tauri-apps/api/window'
import type { RuntimeDeviceWorkspace, RuntimeWorkListResponse } from '@/types/api'

type ConfirmClose = () => boolean

function workspaceHasRunningTask(workspace: RuntimeDeviceWorkspace): boolean {
  return workspace.tasks.some(task => task.running === true)
}

export function hasRunningRuntimeTasks(
  runtimeWork: RuntimeWorkListResponse | null | undefined
): boolean {
  if (!runtimeWork) return false

  return (
    runtimeWork.projects.some(project => project.deviceWorkspaces.some(workspaceHasRunningTask)) ||
    runtimeWork.chats.some(workspaceHasRunningTask)
  )
}

export function shouldPreventRuntimeTaskClose(
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  confirmClose: ConfirmClose
): boolean {
  if (!hasRunningRuntimeTasks(runtimeWork)) return false

  return !confirmClose()
}

export async function installRuntimeTaskCloseGuard(
  getRuntimeWork: () => RuntimeWorkListResponse | null | undefined,
  onRunningTaskCloseRequest: () => void
): Promise<() => void> {
  const currentWindow = getCurrentWindow()

  return currentWindow.onCloseRequested(event => {
    if (!hasRunningRuntimeTasks(getRuntimeWork())) {
      return
    }

    event.preventDefault()
    onRunningTaskCloseRequest()
  })
}

export async function destroyCurrentWindow(): Promise<void> {
  await getCurrentWindow().destroy()
}
