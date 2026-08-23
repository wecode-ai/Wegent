import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import type { RuntimeTaskLifecycleStoreSnapshot } from '@/features/workbench/runtimeTaskLifecycle'
import { isElectronRuntime } from '@/lib/runtime-environment'

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
  if (isElectronRuntime()) {
    let cancelled = false
    let revision = 0
    let timer: number | undefined

    const poll = async () => {
      try {
        const state = await invokeDesktopHost<{
          requested: boolean
          revision: number
        }>('window.closeRequestState', { after: revision })
        revision = state.revision
        if (!cancelled && state.requested) onCloseToTrayHintRequest()
      } catch (error) {
        if (!cancelled) {
          console.debug('[Wework] Failed to poll Electron close requests', error)
        }
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

  const unlisten: UnlistenFn = await listen(CLOSE_TO_TRAY_HINT_REQUESTED_EVENT, () => {
    onCloseToTrayHintRequest()
  })

  return unlisten
}

export async function closeMainWindowToTray(): Promise<void> {
  if (isElectronRuntime()) {
    await invokeDesktopHost<void>('window.closeToTray')
    return
  }
  await invoke('close_main_window_to_tray')
}
