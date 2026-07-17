import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { RuntimeDeviceWorkspace, RuntimeWorkListResponse } from '@/types/api'

type ConfirmClose = () => boolean

export const CLOSE_TO_TRAY_HINT_REQUESTED_EVENT = 'wework-close-to-tray-hint-requested'

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
  onCloseToTrayHintRequest: () => void
): Promise<() => void> {
  const unlisten: UnlistenFn = await listen(CLOSE_TO_TRAY_HINT_REQUESTED_EVENT, () => {
    onCloseToTrayHintRequest()
  })

  return unlisten
}

export async function closeMainWindowToTray(): Promise<void> {
  await invoke('close_main_window_to_tray')
}
