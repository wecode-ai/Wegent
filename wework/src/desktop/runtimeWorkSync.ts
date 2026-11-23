import { getDesktopWindowLabel } from '@/lib/runtime-environment'
import type { UnlistenFn } from './disposeDesktopListener'

export const RUNTIME_WORK_CHANGED_EVENT = 'wework-runtime-work-changed'

const MAIN_WINDOW_LABEL = 'main'

export interface RuntimeWorkChangedPayload {
  deviceId: string
  taskId: string
}

export async function notifyMainRuntimeWorkChanged(
  payload: RuntimeWorkChangedPayload,
  sourceTabId?: string
): Promise<void> {
  const label = getDesktopWindowLabel()
  if (label === 'popout-window') {
    window.localStorage.setItem(RUNTIME_WORK_CHANGED_EVENT, JSON.stringify(payload))
  } else if (label === MAIN_WINDOW_LABEL && sourceTabId) {
    window.dispatchEvent(
      new CustomEvent<string>(RUNTIME_WORK_CHANGED_EVENT, { detail: sourceTabId })
    )
  }
}

export function installMainRuntimeWorkChangedListener(
  refreshRuntimeWork: () => Promise<void>,
  tabId?: string
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
  const onTabChange = (event: Event) => {
    if (!tabId || (event as CustomEvent<string>).detail === tabId) return
    void refreshRuntimeWork().catch(error => {
      console.warn(
        '[Wework] Failed to refresh runtime work after a task changed in another tab',
        error
      )
    })
  }
  window.addEventListener('storage', onStorage)
  window.addEventListener(RUNTIME_WORK_CHANGED_EVENT, onTabChange)
  return Promise.resolve(() => {
    window.removeEventListener('storage', onStorage)
    window.removeEventListener(RUNTIME_WORK_CHANGED_EVENT, onTabChange)
  })
}
