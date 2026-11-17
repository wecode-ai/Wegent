import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { stripAppBasePath } from '@/config/runtime'
import { parseRuntimeTaskRoute } from '@/lib/navigation'
import { resolveWorkbenchDeviceId } from '@/lib/workbench-device'
import { isSameRuntimeTaskAddress } from './workbenchRuntimeHelpers'
import { useWorkbench } from './useWorkbench'
import { useRuntimeTaskSummaryResolver } from './runtimeTaskLifecycle'

function subscribeToNavigation(onStoreChange: () => void) {
  window.addEventListener('popstate', onStoreChange)
  return () => window.removeEventListener('popstate', onStoreChange)
}

function getNavigationSnapshot() {
  return `${window.location.pathname}${window.location.search}`
}

const subscribeToNothing = () => () => undefined
const getInactiveNavigationSnapshot = () => ''

export function useRuntimeTaskRouteRestoration(enabled = true) {
  const { state, openRuntimeTask } = useWorkbench()
  const resolveTask = useRuntimeTaskSummaryResolver(state.runtimeWork)
  const runtimeTaskLocation = useSyncExternalStore(
    enabled ? subscribeToNavigation : subscribeToNothing,
    enabled ? getNavigationSnapshot : getInactiveNavigationSnapshot,
    enabled ? getNavigationSnapshot : getInactiveNavigationSnapshot
  )

  const route = useMemo(() => {
    if (!enabled || state.isBootstrapping) return null
    const location = new URL(runtimeTaskLocation, window.location.origin)
    const parsed = parseRuntimeTaskRoute(stripAppBasePath(location.pathname), location.search)
    return parsed
      ? { ...parsed, deviceId: resolveWorkbenchDeviceId(state.devices, parsed.deviceId)! }
      : null
  }, [enabled, runtimeTaskLocation, state.isBootstrapping, state.devices])
  const runtimeTask = resolveTask(route)
  const routeRuntimeTask = useMemo(() => {
    const current = state.currentRuntimeTask
    const currentAddress = current
      ? { ...current, deviceId: resolveWorkbenchDeviceId(state.devices, current.deviceId)! }
      : null
    const currentHasWorkspace = Boolean(
      state.currentRuntimeTask?.workspacePath || state.currentRuntimeTask?.workspaceKind === 'chat'
    )
    if (
      !route ||
      ((runtimeTask || currentHasWorkspace) && isSameRuntimeTaskAddress(currentAddress, route))
    )
      return null
    if (!runtimeTask) return route
    return {
      ...route,
      ...(runtimeTask?.workspacePath ? { workspacePath: runtimeTask.workspacePath } : {}),
    }
  }, [route, runtimeTask, state.currentRuntimeTask, state.devices])

  useEffect(() => {
    if (!routeRuntimeTask || getNavigationSnapshot() !== runtimeTaskLocation) return
    void openRuntimeTask(routeRuntimeTask)
  }, [openRuntimeTask, routeRuntimeTask, runtimeTaskLocation])

  return routeRuntimeTask
}
