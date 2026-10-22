import { useEffect, useMemo, useState } from 'react'
import {
  cloudRunnerModels,
  runnerModelKey,
  runnerModelToUnifiedModel,
  type RunnerModelIdentity,
  type WorkspaceProjectAgent,
  type WorkspaceStandInSettings,
  type AgentModelPolicy,
} from '@wegent/collaboration'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { UnifiedModel } from '@/types/api'

/** Model references remain device-scoped; credentials are resolved by the Executor. */
export function useStandInModels(
  services: WorkbenchServices | undefined,
  draft: WorkspaceStandInSettings,
  agent?: WorkspaceProjectAgent
) {
  const [catalog, setCatalog] = useState<{
    deviceId: string
    runtime: string
    models: UnifiedModel[]
    defaultIdentity: RunnerModelIdentity | null
    identities: Map<string, RunnerModelIdentity>
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
      const identities = new Map<string, RunnerModelIdentity>()
      const candidates = [
        ...(native.status === 'fulfilled' ? native.value.models : []),
        ...(cloud.status === 'fulfilled' ? cloudRunnerModels(cloud.value.data) : []),
      ].filter(model => model.runtime === runtime)
      const models = candidates.map(model => {
        const name = runnerModelKey(model)
        identities.set(name, {
          runtime: model.runtime,
          provider: model.provider,
          model_id: model.model_id,
          source: model.source,
          cloud_model: model.cloud_model,
        })
        return runnerModelToUnifiedModel(
          model,
          cloud.status === 'fulfilled' ? cloud.value.data : []
        )
      })
      const failure = native.status === 'rejected' ? native.reason : null
      const defaultModel = candidates.find(model => model.is_default) ?? candidates[0]
      setCatalog({
        deviceId,
        runtime,
        models,
        identities,
        defaultIdentity: defaultModel
          ? (identities.get(runnerModelKey(defaultModel)) ?? null)
          : null,
        error: failure ? String(failure) : null,
      })
    })
    return () => {
      active = false
    }
  }, [services, draft.executionDeviceId, runtime])
  const readyCatalog =
    catalog?.deviceId === draft.executionDeviceId && catalog.runtime === runtime ? catalog : null
  const identity = fixedModel ?? draft.model ?? readyCatalog?.defaultIdentity
  const selectedModel = useMemo(
    () =>
      identity
        ? (readyCatalog?.models.find(model => model.name === runnerModelKey(identity)) ?? {
            name: runnerModelKey(identity),
            type: 'runtime' as const,
            displayName: identity.model_id,
            modelId: identity.model_id,
          })
        : null,
    [identity, readyCatalog]
  )
  return {
    loading: Boolean(services?.standInApi && draft.executionDeviceId && !readyCatalog),
    models: readyCatalog?.models ?? [],
    selectedModel,
    fixed: Boolean(fixedModel),
    defaultIdentity: fixedModel ? null : readyCatalog?.defaultIdentity,
    error: readyCatalog?.error,
    unavailable: Boolean(
      identity && readyCatalog && !readyCatalog.identities.has(runnerModelKey(identity))
    ),
    resolve: (model: UnifiedModel | null) =>
      model ? (readyCatalog?.identities.get(model.name) ?? null) : null,
  }
}
