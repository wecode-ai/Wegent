import { syncTrayMenuState } from '@/desktop/trayNavigation'
import { stripAppBasePath } from '@/config/runtime'
import { parseRuntimeTaskRoute } from '@/lib/navigation'
import { resolveWorkbenchDeviceId } from '@/lib/workbench-device'
import type { RuntimeTaskAddress } from '@/types/api'
import type { WorkbenchContextValue } from './workbenchContextTypes'
import { isSameRuntimeTaskAddress } from './workbenchRuntimeHelpers'
import type { useRuntimeTaskSummaryResolver } from './runtimeTaskLifecycle'

export interface RouteTrayInput {
  groups: Parameters<typeof syncTrayMenuState>[0]
  tooltip: string | null
}
export interface RouteInput {
  tray?: RouteTrayInput
  enabled: boolean
  state: Pick<WorkbenchContextValue['state'], 'currentRuntimeTask' | 'devices' | 'isBootstrapping'>
  resolveTask: ReturnType<typeof useRuntimeTaskSummaryResolver>
  isTaskAdmitted?: (address: RuntimeTaskAddress) => boolean
  openRuntimeTask: WorkbenchContextValue['openRuntimeTask']
}
const locationKey = () => `${window.location.pathname}${window.location.search}`
export function resolveRuntimeTaskRoute(input: RouteInput): RuntimeTaskAddress | null {
  if (!input.enabled || input.state.isBootstrapping) return null
  const { state } = input
  const location = new URL(locationKey(), window.location.origin)
  const parsed = parseRuntimeTaskRoute(stripAppBasePath(location.pathname), location.search)
  if (!parsed) return null
  const route = { ...parsed, deviceId: resolveWorkbenchDeviceId(state.devices, parsed.deviceId)! }
  const task = input.resolveTask(route)
  const current = state.currentRuntimeTask
  const currentAddress = current
    ? { ...current, deviceId: resolveWorkbenchDeviceId(state.devices, current.deviceId)! }
    : null
  const currentHasWorkspace = Boolean(current?.workspacePath || current?.workspaceKind === 'chat')
  // Local admission precedes persisted workspace metadata during task creation.
  if (
    (task || currentHasWorkspace || input.isTaskAdmitted?.(route)) &&
    isSameRuntimeTaskAddress(currentAddress, route)
  )
    return null
  return task?.workspacePath ? { ...route, workspacePath: task.workspacePath } : route
}
/** The committed Workbench owner drives native restoration and owns its navigation receipt. */
export function createRuntimeTaskRouteCoordinator(read: () => RouteInput) {
  let listening = false
  let scheduled = false
  let generation = 0
  let lastReceipt: string | undefined
  let settledLocation: string | undefined
  let lastTray: RouteTrayInput | undefined
  const synchronize = () => {
    const input = read()
    if (!input.enabled) return
    if (
      input.tray &&
      (!lastTray ||
        lastTray.groups !== input.tray.groups ||
        lastTray.tooltip !== input.tray.tooltip)
    ) {
      syncTrayMenuState(input.tray.groups, undefined, { title: null, tooltip: input.tray.tooltip })
      lastTray = input.tray
    }
    const location = locationKey()
    if (settledLocation === location) return
    settledLocation = undefined
    if (input.state.isBootstrapping) return
    const next = resolveRuntimeTaskRoute(input)
    if (!next) {
      // Discovery refreshes must not replay an already resolved URL through an older alias.
      settledLocation = location
      lastReceipt = undefined
      return
    }
    const receipt = JSON.stringify([location, next])
    if (receipt === lastReceipt || locationKey() !== location) return
    lastReceipt = receipt
    void input.openRuntimeTask(next)
  }
  const stop = () => {
    generation++
    scheduled = false
    if (listening) window.removeEventListener('popstate', synchronize)
    listening = false
    lastReceipt = undefined
    settledLocation = undefined
    lastTray = undefined
  }
  return {
    update() {
      if (!read().enabled) {
        stop()
        return
      }
      if (!listening) {
        listening = true
        window.addEventListener('popstate', synchronize)
      }
      if (scheduled) return
      scheduled = true
      const version = generation
      // Reducer and lifecycle publications belong to one navigation transaction.
      queueMicrotask(() => {
        if (version !== generation) return
        scheduled = false
        synchronize()
      })
    },
    stop,
  }
}
