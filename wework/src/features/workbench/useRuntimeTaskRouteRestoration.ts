import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { stripAppBasePath } from '@/config/runtime'
import { parseRuntimeTaskRoute } from '@/lib/navigation'
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
    return parseRuntimeTaskRoute(stripAppBasePath(location.pathname), location.search)
  }, [enabled, runtimeTaskLocation, state.isBootstrapping])
  const runtimeTask = resolveTask(route)
  const routeRuntimeTask = useMemo(() => {
    const currentHasWorkspace = Boolean(
      state.currentRuntimeTask?.workspacePath || state.currentRuntimeTask?.workspaceKind === 'chat'
    )
    if (
      !route ||
      ((runtimeTask || currentHasWorkspace) &&
        isSameRuntimeTaskAddress(state.currentRuntimeTask, route))
    )
      return null
    if (!runtimeTask) return route
    return {
      ...route,
      ...(runtimeTask?.workspacePath ? { workspacePath: runtimeTask.workspacePath } : {}),
    }
  }, [route, runtimeTask, state.currentRuntimeTask])

  useEffect(() => {
    if (!routeRuntimeTask || getNavigationSnapshot() !== runtimeTaskLocation) return
    void openRuntimeTask(routeRuntimeTask)
  }, [openRuntimeTask, routeRuntimeTask, runtimeTaskLocation])

  return routeRuntimeTask
}
