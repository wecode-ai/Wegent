import { emitTo, listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { isTauriRuntime } from '@/lib/runtime-environment'

export const RUNTIME_WORK_CHANGED_EVENT = 'wework-runtime-work-changed'
const RUNTIME_WORK_CHANGED_BROWSER_EVENT = 'wework:runtime-work-changed'

const MAIN_WINDOW_LABEL = 'main'

export interface RuntimeWorkChangedPayload {
  deviceId: string
  taskId: string
}

function currentWindowLabel(): string | null {
  try {
    return getCurrentWindow().label
  } catch {
    return null
  }
}

export async function notifyMainRuntimeWorkChanged(
  payload: RuntimeWorkChangedPayload
): Promise<void> {
  window.dispatchEvent(
    new CustomEvent<RuntimeWorkChangedPayload>(RUNTIME_WORK_CHANGED_BROWSER_EVENT, {
      detail: payload,
    })
  )
  if (!isTauriRuntime() || currentWindowLabel() !== 'popout-window') return
  await emitTo(MAIN_WINDOW_LABEL, RUNTIME_WORK_CHANGED_EVENT, payload)
}

export function installMainRuntimeWorkChangedListener(
  refreshRuntimeWork: () => Promise<void>
): Promise<UnlistenFn> {
  const refreshAfterChange = (payload: RuntimeWorkChangedPayload) => {
    void refreshRuntimeWork().catch(error => {
      console.warn('[Wework] Failed to refresh runtime work after shared-state change', {
        deviceId: payload.deviceId,
        taskId: payload.taskId,
        error,
      })
    })
  }
  const handleBrowserChange = (event: Event) => {
    refreshAfterChange((event as CustomEvent<RuntimeWorkChangedPayload>).detail)
  }
  window.addEventListener(RUNTIME_WORK_CHANGED_BROWSER_EVENT, handleBrowserChange)
  const unlistenBrowser = () =>
    window.removeEventListener(RUNTIME_WORK_CHANGED_BROWSER_EVENT, handleBrowserChange)

  if (!isTauriRuntime() || currentWindowLabel() !== MAIN_WINDOW_LABEL) {
    return Promise.resolve(unlistenBrowser)
  }

  return listen<RuntimeWorkChangedPayload>(RUNTIME_WORK_CHANGED_EVENT, event =>
    refreshAfterChange(event.payload)
  )
    .then(unlistenTauri => () => {
      unlistenBrowser()
      unlistenTauri()
    })
    .catch(error => {
      console.warn('[Wework] Failed to install cross-window runtime work listener', error)
      return unlistenBrowser
    })
}
