import { isPerformanceDiagnosticsEnabled } from '@/lib/performanceDiagnostics'

export type PluginSyncOwner =
  | 'unspecified'
  | 'policy'
  | 'auto-update'
  | 'status-report'
  | 'auto-sync'
  | 'reconcile'

export function logPluginRefreshPhase(
  phase: string,
  facts: {
    request?: number
    owner?: PluginSyncOwner
    lease?: number
    elapsedMs?: number
    busy?: boolean
    current?: boolean
    outcome?: 'completed' | 'failed'
  }
) {
  if (
    typeof window === 'undefined' ||
    (!window.__WEWORK_E2E__ && !isPerformanceDiagnosticsEnabled())
  )
    return
  const { request, owner, lease, elapsedMs, busy, current, outcome } = facts
  console.info(
    '[plugin-refresh-phase]',
    JSON.stringify({
      at: new Date().toISOString(),
      phase,
      request,
      owner,
      lease,
      elapsedMs,
      busy,
      current,
      outcome,
    })
  )
}
