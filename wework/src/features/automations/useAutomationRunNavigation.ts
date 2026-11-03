import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { buildRuntimeTaskRoute, navigateTo } from '@/lib/navigation'
import type { RuntimeTaskAddress } from '@/types/api'
import type { AutomationRun } from '@/types/automation'

export function useAutomationRunNavigation(options: {
  openRuntimeTask(address: RuntimeTaskAddress): Promise<unknown>
  requestLeave(action: () => void): void
  onNavigate?(action: () => void): void
  onError(message: string): void
}) {
  const latest = useRef(options)
  useLayoutEffect(() => {
    latest.current = options
  }, [options])
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  return useCallback((run: AutomationRun) => {
    if (!run.taskId || !run.deviceId) return
    const address: RuntimeTaskAddress = {
      taskId: run.taskId,
      deviceId: run.deviceId,
      runtime: 'codex',
      ...(run.workspacePath ? { workspacePath: run.workspacePath } : {}),
    }
    const guard = (action: () => void) =>
      latest.current.requestLeave(() => {
        if (latest.current.onNavigate) latest.current.onNavigate(action)
        else action()
      })
    guard(() => {
      void latest.current
        .openRuntimeTask(address)
        .then(() => {
          // Opening work may outlive this calendar or newly edited drafts.
          if (mounted.current) guard(() => navigateTo(buildRuntimeTaskRoute(address)))
        })
        .catch(cause => {
          if (mounted.current)
            latest.current.onError(cause instanceof Error ? cause.message : String(cause))
        })
    })
  }, [])
}
