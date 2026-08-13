import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { RuntimeTaskLifecycleStoreSnapshot } from '@/features/workbench/runtimeTaskLifecycle'

type ConfirmClose = () => boolean

export const CLOSE_TO_TRAY_HINT_REQUESTED_EVENT = 'wework-close-to-tray-hint-requested'

export function hasRunningRuntimeTasks(lifecycle: RuntimeTaskLifecycleStoreSnapshot): boolean {
  return lifecycle.runningTaskKeys.size > 0 || lifecycle.queuedTaskKeys.size > 0
}

export function shouldPreventRuntimeTaskClose(
  lifecycle: RuntimeTaskLifecycleStoreSnapshot,
  confirmClose: ConfirmClose
): boolean {
  if (!hasRunningRuntimeTasks(lifecycle)) return false

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
