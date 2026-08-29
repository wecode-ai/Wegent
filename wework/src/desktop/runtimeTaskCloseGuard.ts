import { invokeDesktopHost, subscribeDesktopHostEvents } from '@/api/dsh/desktopHost'
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
  return subscribeDesktopHostEvents(event => {
    if (event.type === 'window.close-to-tray-requested') onCloseToTrayHintRequest()
  })
}

export async function closeMainWindowToTray(): Promise<void> {
  await invokeDesktopHost<void>('window.closeToTray')
}

export async function cancelMainWindowClose(): Promise<void> {
  await invokeDesktopHost<void>('window.cancelCloseToTray')
}
