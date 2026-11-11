import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  runnerModelCatalog,
  runnerModelKey,
  type RunnerModelCatalogEntry,
  type RunnerModelIdentity,
  type WorkspaceStandInSettings,
} from '@wegent/collaboration'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { LOCAL_MODEL_SETTINGS_CHANGED_EVENT } from '@/features/model-settings/localModelSettings'
import type { UnifiedModel } from '@/types/api'
import { isSameModelSelection } from '@wegent/collaboration/controls/model-ui'

/** Model references remain device-scoped; credentials are resolved by the Executor. */
export function useStandInModels(
  services: WorkbenchServices | undefined,
  draft: WorkspaceStandInSettings,
  runtime: RunnerModelIdentity['runtime'] = draft.model?.runtime ?? 'codex'
) {
  const [catalog, setCatalog] = useState<{
    services: WorkbenchServices
    deviceId: string
    runtime: string
    entries: RunnerModelCatalogEntry[]
    defaultIdentity: RunnerModelIdentity | null
    error: string | null
  } | null>(null)
  const loadRevision = useRef(0)
  const loadCatalog = useCallback(async () => {
    if (!services?.standInApi || !draft.executionDeviceId) return
    const revision = ++loadRevision.current
    const deviceId = draft.executionDeviceId
    const [native, cloud] = await Promise.allSettled([
      services.standInApi.catalog(deviceId),
      services.modelApi.listModels(),
    ])
    if (revision !== loadRevision.current) return
    const entries = runnerModelCatalog(
      native.status === 'fulfilled' ? native.value.models : [],
      cloud.status === 'fulfilled' ? cloud.value.data : [],
      runtime
    )
    const failure = native.status === 'rejected' ? native.reason : null
    // Match the Executor's unique native default; cloud entries are never defaults.
    const defaults = entries.filter(entry => entry.isDefault)
    const defaultModel = defaults.length === 1 ? defaults[0] : null
    setCatalog({
      services,
      deviceId,
      runtime,
      entries,
      defaultIdentity: defaultModel?.identity ?? null,
      error: failure ? getStandInErrorMessage(failure) : null,
    })
  }, [services, draft.executionDeviceId, runtime])
  const refresh = useCallback(() => {
    services?.modelApi.refresh?.()
    void loadCatalog()
  }, [services, loadCatalog])
  useEffect(() => {
    if (!services?.standInApi || !draft.executionDeviceId) return
    const unsubscribe = services.modelApi.subscribe?.(loadCatalog)
    window.addEventListener(LOCAL_MODEL_SETTINGS_CHANGED_EVENT, loadCatalog)
    void loadCatalog()
    return () => {
      loadRevision.current += 1
      unsubscribe?.()
      window.removeEventListener(LOCAL_MODEL_SETTINGS_CHANGED_EVENT, loadCatalog)
    }
  }, [services, draft.executionDeviceId, loadCatalog])
  const readyCatalog =
    catalog?.services === services &&
    catalog?.deviceId === draft.executionDeviceId &&
    catalog.runtime === runtime
      ? catalog
      : null
  const identity = draft.model ?? readyCatalog?.defaultIdentity
  const selectedEntry = useMemo(
    () =>
      identity
        ? readyCatalog?.entries.find(
            entry => runnerModelKey(entry.identity) === runnerModelKey(identity)
          )
        : undefined,
    [identity, readyCatalog]
  )
  const models = useMemo(
    () => readyCatalog?.entries.map(entry => entry.model) ?? [],
    [readyCatalog]
  )
  const selectedModel = useMemo(
    () =>
      identity
        ? (selectedEntry?.model ?? {
            name: identity.model_id,
            type: 'runtime' as const,
            displayName: identity.model_id,
            modelId: identity.model_id,
            runtime: { family: identity.runtime },
          })
        : null,
    [identity, selectedEntry]
  )
  const resolve = (model: UnifiedModel | null) =>
    model
      ? (readyCatalog?.entries.find(entry => isSameModelSelection(entry.model, model))?.identity ??
        null)
      : null
  return {
    refresh,
    loading: Boolean(services?.standInApi && draft.executionDeviceId && !readyCatalog),
    models,
    selectedModel,
    defaultIdentity: readyCatalog?.defaultIdentity,
    error: readyCatalog?.error,
    unavailable: Boolean(identity && readyCatalog && !selectedEntry),
    resolve,
    getModelOptionId: (model: UnifiedModel) => {
      const identity = resolve(model)
      return identity ? runnerModelKey(identity) : model.name
    },
  }
}
