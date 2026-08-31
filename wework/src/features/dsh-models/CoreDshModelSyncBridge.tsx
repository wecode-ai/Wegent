import { useEffect, useMemo } from 'react'
import { listLocalHarnessModelOptions } from '@/features/local-harness/localHarnessModels'
import type { UnifiedModel } from '@/types/api'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { requestCoreDsh, scheduleCoreDshModelSync } from '@/features/dsh-models/coreDshModelSync'

interface CoreDshModelSyncProps {
  enabled: boolean
  models: UnifiedModel[]
  services: WorkbenchServices
}

export function CoreDshModelSync({ enabled, models, services }: CoreDshModelSyncProps) {
  const options = useMemo(() => listLocalHarnessModelOptions('claude_code', models), [models])

  useEffect(() => {
    if (!enabled || !services.localHarnessModelApi) return
    void scheduleCoreDshModelSync(
      { options },
      {
        resolveLaunch: (option, scope) =>
          services.localHarnessModelApi?.resolveLaunch('claude_code', option, scope) ??
          Promise.resolve(null),
        unregisterProxy: token =>
          services.localHarnessModelApi?.unregisterProxy(token) ?? Promise.resolve(),
        request: requestCoreDsh,
      }
    ).catch(error => {
      console.error('[Wework] Failed to expose models to Core DSH:', error)
    })
  }, [enabled, options, services.localHarnessModelApi])

  return null
}
