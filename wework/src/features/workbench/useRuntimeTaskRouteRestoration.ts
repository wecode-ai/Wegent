import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { stripAppBasePath } from '@/config/runtime'
import { parseRuntimeTaskRoute } from '@/lib/navigation'
import { findRuntimeTask, isSameRuntimeTaskAddress } from './workbenchRuntimeHelpers'
import { useWorkbench } from './useWorkbench'

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
  const runtimeTaskLocation = useSyncExternalStore(
    enabled ? subscribeToNavigation : subscribeToNothing,
    enabled ? getNavigationSnapshot : getInactiveNavigationSnapshot,
    enabled ? getNavigationSnapshot : getInactiveNavigationSnapshot
  )

  const routeRuntimeTask = useMemo(() => {
    if (!enabled || state.isBootstrapping) return null

    const location = new URL(runtimeTaskLocation, window.location.origin)
    const route = parseRuntimeTaskRoute(stripAppBasePath(location.pathname), location.search)
    if (!route || isSameRuntimeTaskAddress(state.currentRuntimeTask, route)) return null

    const runtimeTask = findRuntimeTask(state.runtimeWork, route)
    return {
      ...route,
      ...(runtimeTask?.workspacePath ? { workspacePath: runtimeTask.workspacePath } : {}),
    }
  }, [
    enabled,
    runtimeTaskLocation,
    state.currentRuntimeTask,
    state.isBootstrapping,
    state.runtimeWork,
  ])

  useEffect(() => {
    if (!routeRuntimeTask) return
    void openRuntimeTask(routeRuntimeTask)
  }, [openRuntimeTask, routeRuntimeTask])

  return routeRuntimeTask
}
