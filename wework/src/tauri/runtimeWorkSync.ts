import { emitTo, listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { isTauriRuntime } from '@/lib/runtime-environment'

export const RUNTIME_WORK_CHANGED_EVENT = 'wework-runtime-work-changed'

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
  if (!isTauriRuntime() || currentWindowLabel() !== 'popout-window') return
  await emitTo(MAIN_WINDOW_LABEL, RUNTIME_WORK_CHANGED_EVENT, payload)
}

export function installMainRuntimeWorkChangedListener(
  refreshRuntimeWork: () => Promise<void>
): Promise<UnlistenFn> | null {
  if (!isTauriRuntime() || currentWindowLabel() !== MAIN_WINDOW_LABEL) return null

  return listen<RuntimeWorkChangedPayload>(RUNTIME_WORK_CHANGED_EVENT, event => {
    void refreshRuntimeWork().catch(error => {
      console.warn('[Wework] Failed to refresh runtime work after cross-window change', {
        deviceId: event.payload.deviceId,
        taskId: event.payload.taskId,
        error,
      })
    })
  }).catch(error => {
    console.warn('[Wework] Failed to install cross-window runtime work listener', error)
    return () => {}
  })
}
