import type { UnifiedModel } from '@/types/api'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { listLocalHarnessModelOptions } from '@/features/local-harness/localHarnessModels'
import { requestCoreDsh, scheduleCoreDshModelSync } from './coreDshModelSync'

/** The observed Workbench session publishes its executable catalog through the existing DSH queue. */
export function createCoreDshModelPublisher() {
  let previousModels: UnifiedModel[] | null | undefined
  let previousApi: WorkbenchServices['localHarnessModelApi']
  return {
    update(models: UnifiedModel[] | null, api: WorkbenchServices['localHarnessModelApi']) {
      if (models === previousModels && api === previousApi) return
      previousModels = models
      previousApi = api
      if (!models || !api) return
      const options = listLocalHarnessModelOptions('claude_code', models)
      void scheduleCoreDshModelSync(
        { options },
        {
          resolveLaunch: (option, scope) => api.resolveLaunch('claude_code', option, scope),
          unregisterProxy: token => api.unregisterProxy(token),
          request: requestCoreDsh,
        }
      ).catch(error => {
        console.error('[Wework] Failed to expose models to Core DSH:', error)
      })
    },
    suspend() {
      previousModels = undefined
      previousApi = undefined
    },
  }
}
