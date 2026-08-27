import { useEffect, useMemo } from 'react'
import {
  listLocalHarnessModelOptions,
  localHarnessModelOptionKey,
} from '@/features/local-harness/localHarnessModels'
import type { ModelOptions, UnifiedModel } from '@/types/api'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { requestCoreDsh, scheduleCoreDshModelSync } from '@/features/dsh-models/coreDshModelSync'

interface CoreDshModelSyncProps {
  enabled: boolean
  models: UnifiedModel[]
  selectedModel: UnifiedModel | null
  selectedModelOptions: ModelOptions
  services: WorkbenchServices
}

export function CoreDshModelSync({
  enabled,
  models,
  selectedModel,
  selectedModelOptions,
  services,
}: CoreDshModelSyncProps) {
  const options = useMemo(
    () => listLocalHarnessModelOptions('claude_code', models, selectedModel, selectedModelOptions),
    [models, selectedModel, selectedModelOptions]
  )
  const preferredModelKey = selectedModel ? localHarnessModelOptionKey(selectedModel) : null

  useEffect(() => {
    if (!enabled || !services.localHarnessModelApi) return
    void scheduleCoreDshModelSync(
      { options, preferredModelKey },
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
  }, [enabled, options, preferredModelKey, services.localHarnessModelApi])

  return null
}
