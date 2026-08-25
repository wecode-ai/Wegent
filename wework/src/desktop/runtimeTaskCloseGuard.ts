import { invokeDesktopHost } from '@/api/dsh/desktopHost'
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
  let cancelled = false
  let revision = 0
  let timer: number | undefined
  const poll = async () => {
    try {
      const state = await invokeDesktopHost<{ requested: boolean; revision: number }>(
        'window.closeRequestState',
        { after: revision }
      )
      revision = state.revision
      if (!cancelled && state.requested) onCloseToTrayHintRequest()
    } catch (error) {
      if (!cancelled) console.debug('[Wework] Failed to poll Electron close requests', error)
    } finally {
      if (!cancelled) timer = window.setTimeout(poll, 100)
    }
  }
  void poll()
  return () => {
    cancelled = true
    if (timer !== undefined) window.clearTimeout(timer)
  }
}

export async function closeMainWindowToTray(): Promise<void> {
  await invokeDesktopHost<void>('window.closeToTray')
}

export async function cancelMainWindowClose(): Promise<void> {
  await invokeDesktopHost<void>('window.cancelCloseToTray')
}
