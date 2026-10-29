import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { useEffect, useMemo, useState } from 'react'
import {
  runnerModelCatalog,
  runnerModelKey,
  type RunnerModelCatalogEntry,
  type RunnerModelIdentity,
  type WorkspaceProjectAgent,
  type WorkspaceStandInSettings,
  type AgentModelPolicy,
} from '@wegent/collaboration'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { UnifiedModel } from '@/types/api'
import { isSameModelSelection } from '@wegent/collaboration/controls/model-ui'

/** Model references remain device-scoped; credentials are resolved by the Executor. */
export function useStandInModels(
  services: WorkbenchServices | undefined,
  draft: WorkspaceStandInSettings,
  agent?: WorkspaceProjectAgent
) {
  const [catalog, setCatalog] = useState<{
    deviceId: string
    runtime: string
    entries: RunnerModelCatalogEntry[]
    defaultIdentity: RunnerModelIdentity | null
    error: string | null
  } | null>(null)
  const runtime = agent?.runtime === 'claude_code' ? 'claude_code' : 'codex'
  const fixedPolicy = agent?.modelPolicy as AgentModelPolicy | undefined
  const fixedModel = fixedPolicy?.mode === 'fixed' ? fixedPolicy.model : null
  useEffect(() => {
    if (!services?.standInApi || !draft.executionDeviceId) return
    let active = true
    const deviceId = draft.executionDeviceId
    void Promise.allSettled([
      services.standInApi.catalog(deviceId),
      services.modelApi.listModels(),
    ]).then(([native, cloud]) => {
      if (!active) return
      const entries = runnerModelCatalog(
        native.status === 'fulfilled' ? native.value.models : [],
        cloud.status === 'fulfilled' ? cloud.value.data : [],
        runtime
      )
      const failure = native.status === 'rejected' ? native.reason : null
      const defaultModel = entries.find(entry => entry.isDefault) ?? entries[0]
      setCatalog({
        deviceId,
        runtime,
        entries,
        defaultIdentity: defaultModel?.identity ?? null,
        error: failure ? getStandInErrorMessage(failure) : null,
      })
    })
    return () => {
      active = false
    }
  }, [services, draft.executionDeviceId, runtime])
  const readyCatalog =
    catalog?.deviceId === draft.executionDeviceId && catalog.runtime === runtime ? catalog : null
  const identity = fixedModel ?? draft.model ?? readyCatalog?.defaultIdentity
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
    loading: Boolean(services?.standInApi && draft.executionDeviceId && !readyCatalog),
    models,
    selectedModel,
    fixed: Boolean(fixedModel),
    fixedIdentity: fixedModel,
    defaultIdentity: fixedModel ? null : readyCatalog?.defaultIdentity,
    error: readyCatalog?.error,
    unavailable: Boolean(identity && readyCatalog && !selectedEntry),
    resolve,
    getModelOptionId: (model: UnifiedModel) => {
      const identity = resolve(model)
      return identity ? runnerModelKey(identity) : model.name
    },
  }
}
