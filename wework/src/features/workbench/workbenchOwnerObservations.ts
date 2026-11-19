import { isMainWindowFocused, subscribeMainWindowFocus } from '@/desktop/windowFocus'
import { getChangeRequestMonitor } from './changeRequestMonitor'
import type { WorkbenchSessionState } from './workbenchSessionState'
import type { WorkbenchServices } from './workbenchServices'

let nextTraceId = 0

/** Window focus and resource observations follow the committed Workbench owner. */
export function createWorkbenchOwnerObservations(state: WorkbenchSessionState, tabId?: string) {
  const traceId = `workbench-${++nextTraceId}`
  let releaseFocus: (() => void) | undefined
  let previousApi: WorkbenchServices['deviceApi'] | undefined
  let previousWork:
    | ReturnType<WorkbenchSessionState['getSnapshot']>['state']['runtimeWork']
    | undefined
  let previousDevices:
    | ReturnType<WorkbenchSessionState['getSnapshot']>['state']['devices']
    | undefined
  let payload = ''
  function trace(event: string, details: object = {}) {
    if (import.meta.env.VITE_WEWORK_E2E === 'true')
      console.debug('[Wework] E2E lifecycle', {
        component: 'WorkbenchOwner',
        traceId,
        event,
        ...details,
      })
  }
  return {
    observe(services: WorkbenchServices, cloud: boolean) {
      if (!releaseFocus) {
        state.lifecycleStore.setWindowFocused(isMainWindowFocused())
        releaseFocus = subscribeMainWindowFocus(focused =>
          state.lifecycleStore.setWindowFocused(focused)
        )
        trace('mounted')
      }
      const current = state.getSnapshot().state
      if (
        services.deviceApi &&
        (previousApi !== services.deviceApi ||
          previousWork !== current.runtimeWork ||
          previousDevices !== current.devices)
      ) {
        previousApi = services.deviceApi
        previousWork = current.runtimeWork
        previousDevices = current.devices
        getChangeRequestMonitor(services.deviceApi).syncConnectionObservations(
          current.runtimeWork,
          current.devices
        )
      }
      if (import.meta.env.VITE_WEWORK_E2E === 'true') {
        const next = JSON.stringify({ workspaceTabId: tabId, userId: current.user?.id, cloud })
        if (next !== payload) {
          payload = next
          trace('state', { payload })
        }
      }
    },
    suspend() {
      if (releaseFocus) trace('unmounted')
      releaseFocus?.()
      releaseFocus = undefined
      previousApi = undefined
      previousWork = undefined
      previousDevices = undefined
      payload = ''
    },
  }
}
