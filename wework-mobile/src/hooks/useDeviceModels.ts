import { useCallback, useMemo, useReducer } from 'react'
import { runnerModelCatalog } from '../../../packages/collaboration/src/agent-form/runnerModelCatalog'
import { isSameModelSelection } from '../../../packages/collaboration/src/controls/model-ui'

import { defaultModel, defaultModelOptions } from '@/domain/modelSelection'
import type { RuntimeApi } from '@/services/runtimeApi'
import type { DeviceInfo, ModelOptions, UnifiedModel } from '@/types/runtime'

interface DeviceCatalog {
  models: UnifiedModel[]
  defaultModel: UnifiedModel | null
  error: string | null
  pending?: Promise<void>
}

/** Catalogs and selection intent belong to the execution device, never to the phone. */
export function useDeviceModels(
  api: RuntimeApi,
  device: DeviceInfo | undefined,
  cloudModels: UnifiedModel[]
) {
  const [, render] = useReducer(value => value + 1, 0)
  const catalogs = useMemo(() => new Map<number, DeviceCatalog>(), [api])
  const selections = useMemo(
    () => new Map<number, { model: UnifiedModel; options: ModelOptions }>(),
    [api]
  )
  const catalog = device ? catalogs.get(device.id) : undefined
  const models = [...(catalog?.models ?? []), ...cloudModels]
  const selection = device ? selections.get(device.id) : undefined
  const selectedModel =
    models.find(model => isSameModelSelection(model, selection?.model ?? null)) ??
    catalog?.defaultModel ??
    defaultModel(models)
  const selectedModelOptions =
    selection && isSameModelSelection(selection.model, selectedModel)
      ? selection.options
      : selectedModel
        ? defaultModelOptions(selectedModel)
        : {}

  const loadModels = useCallback(
    async (force = false): Promise<void> => {
      if (!device) return
      const previous = catalogs.get(device.id)
      if (previous?.pending) return previous.pending
      if (previous && !force) return
      const entry: DeviceCatalog = {
        models: previous?.models ?? [],
        defaultModel: previous?.defaultModel ?? null,
        error: null,
      }
      catalogs.set(device.id, entry)
      entry.pending = api
        .listNativeModels(device.id)
        .then(response => {
          const native = runnerModelCatalog(response.models, [], 'codex')
          entry.models = native.map(item => item.model)
          entry.defaultModel = native.find(item => item.isDefault)?.model ?? null
          entry.error = response.catalog_error || null
        })
        .catch(cause => {
          entry.error = cause instanceof Error ? cause.message : String(cause)
        })
        .finally(() => {
          entry.pending = undefined
          render()
        })
      render()
      await entry.pending
    },
    [api, catalogs, device]
  )

  const selectModel = (model: UnifiedModel, options?: ModelOptions) => {
    if (!device || !models.some(candidate => isSameModelSelection(candidate, model))) return
    selections.set(device.id, { model, options: options ?? defaultModelOptions(model) })
    render()
  }

  return {
    models,
    selectedModel,
    selectedModelOptions,
    selectModel,
    loadModels,
    modelsLoading: Boolean(catalog?.pending),
    modelsError: catalog?.error ?? null,
  }
}
