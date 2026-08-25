import { getDesktopWindowLabel } from '@/lib/runtime-environment'
import type { UnlistenFn } from './disposeDesktopListener'

export const RUNTIME_WORK_CHANGED_EVENT = 'wework-runtime-work-changed'

const MAIN_WINDOW_LABEL = 'main'

export interface RuntimeWorkChangedPayload {
  deviceId: string
  taskId: string
}

export async function notifyMainRuntimeWorkChanged(
  payload: RuntimeWorkChangedPayload
): Promise<void> {
  if (getDesktopWindowLabel() !== 'popout-window') return
  window.localStorage.setItem(RUNTIME_WORK_CHANGED_EVENT, JSON.stringify(payload))
}

export function installMainRuntimeWorkChangedListener(
  refreshRuntimeWork: () => Promise<void>
): Promise<UnlistenFn> | null {
  if (getDesktopWindowLabel() !== MAIN_WINDOW_LABEL) return null
  const onStorage = (event: StorageEvent) => {
    if (event.key !== RUNTIME_WORK_CHANGED_EVENT || !event.newValue) return
    const payload = JSON.parse(event.newValue) as RuntimeWorkChangedPayload
    void refreshRuntimeWork().catch(error => {
      console.warn('[Wework] Failed to refresh runtime work after cross-window change', {
        deviceId: payload.deviceId,
        taskId: payload.taskId,
        error,
      })
    })
  }
  window.addEventListener('storage', onStorage)
  return Promise.resolve(() => window.removeEventListener('storage', onStorage))
}
