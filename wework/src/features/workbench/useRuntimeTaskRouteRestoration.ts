import { useEffect, useMemo } from 'react'
import { stripAppBasePath } from '@/config/runtime'
import { parseRuntimeTaskRoute } from '@/lib/navigation'
import { findRuntimeTask } from './workbenchRuntimeHelpers'
import { useWorkbench } from './useWorkbench'

export function useRuntimeTaskRouteRestoration() {
  const { state, openRuntimeTask } = useWorkbench()
  const routeRuntimeTask = useMemo(() => {
    if (state.isBootstrapping || state.currentRuntimeTask) return null

    const route = parseRuntimeTaskRoute(
      stripAppBasePath(window.location.pathname),
      window.location.search
    )
    if (!route) return null

    const runtimeTask = findRuntimeTask(state.runtimeWork, route)
    return {
      ...route,
      ...(runtimeTask?.workspacePath ? { workspacePath: runtimeTask.workspacePath } : {}),
    }
  }, [state.currentRuntimeTask, state.isBootstrapping, state.runtimeWork])

  useEffect(() => {
    if (!routeRuntimeTask) return
    void openRuntimeTask(routeRuntimeTask)
  }, [openRuntimeTask, routeRuntimeTask])

  return routeRuntimeTask
}
