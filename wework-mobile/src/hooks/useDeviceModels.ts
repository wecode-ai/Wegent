import { useCallback, useLayoutEffect, useMemo, useReducer, useRef } from 'react'
import { runnerModelCatalog } from '../../../packages/collaboration/src/agent-form/runnerModelCatalog'
import { isSameModelSelection } from '../../../packages/collaboration/src/controls/model-ui'

import { defaultModel, defaultModelOptions } from '@/domain/modelSelection'
import type { RuntimeApi } from '@/services/runtimeApi'
import { isPhoneLocalDeviceId } from '@/services/localRuntime'
import type { DeviceInfo, ModelOptions, UnifiedModel } from '@/types/runtime'

interface DeviceCatalog {
  models: UnifiedModel[]
  defaultModel: UnifiedModel | null
  error: string | null
  phoneOwned: boolean
  pending?: Promise<void>
}

/** Catalogs and selection intent belong to the execution runtime, including this phone. */
export function useDeviceModels(
  api: RuntimeApi,
  device: DeviceInfo | undefined,
  cloudModels: UnifiedModel[],
  backendSession: string | null = null,
  localGeneration?: number
) {
  const [, render] = useReducer(value => value + 1, 0)
  const catalogs = useMemo(() => new Map<string, DeviceCatalog>(), [api])
  const selections = useMemo(
    () => new Map<string, { model: UnifiedModel; options: ModelOptions; phoneOwned: boolean }>(),
    [api]
  )
  const currentSession = useRef(backendSession)
  currentSession.current = backendSession
  const previousSession = useRef(backendSession)
  useLayoutEffect(() => {
    if (previousSession.current === backendSession) return
    previousSession.current = backendSession
    for (const [key, entry] of catalogs) if (!entry.phoneOwned) catalogs.delete(key)
    for (const [key, entry] of selections) if (!entry.phoneOwned) selections.delete(key)
    render()
  }, [backendSession, catalogs, selections])
  useLayoutEffect(() => {
    for (const [key, entry] of catalogs) if (entry.phoneOwned) catalogs.delete(key)
    render()
  }, [localGeneration, catalogs])
  const deviceKey = device ? `${device.device_type}:${device.device_id}` : ''
  const catalog = device ? catalogs.get(deviceKey) : undefined
  const models = [...(catalog?.models ?? []), ...cloudModels]
  const selection = device ? selections.get(deviceKey) : undefined
  const selectedModel = selection
    ? (models.find(model => isSameModelSelection(model, selection.model)) ?? null)
    : (catalog?.defaultModel ?? defaultModel(models))
  const selectedModelOptions =
    selection && isSameModelSelection(selection.model, selectedModel)
      ? selection.options
      : selectedModel
        ? defaultModelOptions(selectedModel)
        : {}

  const loadDeviceModels = useCallback(
    async (target: DeviceInfo | undefined | null, force = false): Promise<void> => {
      if (!target) return
      const key = `${target.device_type}:${target.device_id}`
      const phoneOwned = isPhoneLocalDeviceId(target.device_id)
      const session = currentSession.current
      const previous = catalogs.get(key)
      if (previous?.pending) {
        if (!force) return previous.pending
        await previous.pending
        if (!phoneOwned && session !== currentSession.current) return
      }
      if (previous && !force) return
      const entry: DeviceCatalog = {
        models: previous?.models ?? [],
        defaultModel: previous?.defaultModel ?? null,
        error: null,
        phoneOwned,
      }
      catalogs.set(key, entry)
      entry.pending = api
        .listNativeModels(target.id, target.device_id)
        .then(response => {
          if (catalogs.get(key) !== entry || (!phoneOwned && session !== currentSession.current))
            return
          const native = runnerModelCatalog(response.models, [], 'codex')
          entry.models = native.map(item => item.model)
          entry.defaultModel = native.find(item => item.isDefault)?.model ?? null
          entry.error = response.catalog_error || null
        })
        .catch(cause => {
          if (catalogs.get(key) !== entry || (!phoneOwned && session !== currentSession.current))
            return
          entry.error = cause instanceof Error ? cause.message : String(cause)
        })
        .finally(() => {
          entry.pending = undefined
          render()
        })
      render()
      await entry.pending
    },
    [api, catalogs]
  )
  const loadModels = useCallback(
    (force = false) => loadDeviceModels(device, force),
    [device, loadDeviceModels]
  )

  const selectModel = (model: UnifiedModel, options?: ModelOptions) => {
    if (!device || !models.some(candidate => isSameModelSelection(candidate, model))) return
    selections.set(deviceKey, {
      model,
      options: options ?? defaultModelOptions(model),
      phoneOwned: isPhoneLocalDeviceId(device.device_id),
    })
    render()
  }

  return {
    models,
    selectedModel,
    selectedModelOptions,
    selectModel,
    loadModels,
    loadDeviceModels,
    modelsLoading: Boolean(catalog?.pending),
    modelsError: catalog?.error ?? null,
  }
}
