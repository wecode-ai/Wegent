import { useMemo } from 'react'
import type { UnifiedModel } from '@/types/api'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { useTranslation } from '@/hooks/useTranslation'
import { listLocalHarnessModelOptions } from '@/features/local-harness/localHarnessModels'
import type { HarnessAppLaunchRequest } from './harnessAppLaunchActor'

export function useHarnessAppLaunchInput(
  request: HarnessAppLaunchRequest | undefined,
  models: UnifiedModel[],
  isModelCatalogReady: boolean,
  services: WorkbenchServices,
  t: ReturnType<typeof useTranslation>['t']
) {
  const modelOptions = useMemo(() => listLocalHarnessModelOptions('opencode', models), [models])
  return useMemo(
    () =>
      request
        ? { ...request, services, projectChat: { isModelCatalogReady }, modelOptions, t }
        : null,
    [request, services, isModelCatalogReady, modelOptions, t]
  )
}
