import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  policyEnvironments,
  policyModels,
  runnerModelKey,
  cloudRunnerModels,
  type AgentExecutionPolicy,
  type AgentModelPolicy,
  type RunnerEnvironment,
  type RunnerModelIdentity,
} from '@wegent/collaboration'
import type { UnifiedModel } from '@/types/api'

export interface RunnerCatalogApi {
  listRunnerEnvironments(projectId?: string): Promise<RunnerEnvironment[]>
  listModels(): Promise<UnifiedModel[]>
}

export function useAgentRouting(
  api: RunnerCatalogApi,
  runtime: RunnerModelIdentity['runtime'],
  projectId?: string,
  cloudOnly = false
) {
  const [catalog, setCatalog] = useState<{
    api: RunnerCatalogApi
    projectId?: string
    environments: RunnerEnvironment[]
    error: string | null
  } | null>(null)
  const [cloudCatalog, setCloudCatalog] = useState<{
    api: RunnerCatalogApi
    models: UnifiedModel[]
    error: string | null
  } | null>(null)
  const environmentLoading =
    catalog === null || catalog.api !== api || catalog.projectId !== projectId
  const cloudLoading = cloudCatalog === null || cloudCatalog.api !== api
  const environments = useMemo(
    () => (environmentLoading ? [] : catalog.environments),
    [environmentLoading, catalog]
  )
  const error =
    [environmentLoading ? null : catalog.error, cloudLoading ? null : cloudCatalog.error]
      .filter(Boolean)
      .join(' · ') || null
  const cloudModels = useMemo(
    () => cloudRunnerModels(cloudLoading ? [] : cloudCatalog.models),
    [cloudLoading, cloudCatalog]
  )
  const [executionPolicy, setExecutionPolicy] = useState<AgentExecutionPolicy | null>(null)
  const [modelMode, setModelMode] = useState<'fixed' | 'user_select'>('fixed')
  const [model, setModel] = useState<RunnerModelIdentity | null>(null)

  useEffect(() => {
    let active = true
    void api
      .listRunnerEnvironments(projectId)
      .then(environments => {
        if (active) setCatalog({ api, projectId, environments, error: null })
      })
      .catch(cause => {
        if (active)
          setCatalog({
            api,
            projectId,
            environments: [],
            error: cause instanceof Error ? cause.message : String(cause),
          })
      })

    return () => {
      active = false
    }
  }, [api, projectId])

  useEffect(() => {
    let active = true
    void api
      .listModels()
      .then(models => {
        if (active) setCloudCatalog({ api, models, error: null })
      })
      .catch(cause => {
        if (active)
          setCloudCatalog({
            api,
            models: [],
            error: cause instanceof Error ? cause.message : String(cause),
          })
      })
    return () => {
      active = false
    }
  }, [api])

  const loading = cloudLoading || (executionPolicy?.mode === 'fixed' && environmentLoading)

  const candidates = useMemo(
    () => policyEnvironments(environments, executionPolicy, Boolean(projectId)),
    [environments, executionPolicy, projectId]
  )
  const models = useMemo(
    () => policyModels(candidates, runtime, executionPolicy, cloudModels, cloudOnly),
    [candidates, runtime, executionPolicy, cloudModels, cloudOnly]
  )
  const modelAvailable =
    model !== null && models.some(item => runnerModelKey(item) === runnerModelKey(model))
  const modelPolicy: AgentModelPolicy | null =
    modelMode === 'user_select' ? { mode: 'user_select' } : model ? { mode: 'fixed', model } : null
  const validEnvironment =
    executionPolicy !== null && (executionPolicy.mode !== 'fixed' || candidates.length === 1)
  const load = useCallback(
    (policy: AgentExecutionPolicy | undefined, modelPolicy: AgentModelPolicy | undefined) => {
      setExecutionPolicy(policy ?? null)
      setModelMode(modelPolicy?.mode ?? 'fixed')
      setModel(modelPolicy?.model ?? null)
    },
    []
  )
  return {
    environments,
    candidates,
    executionPolicy,
    setExecutionPolicy,
    modelMode,
    setModelMode,
    model,
    setModel,
    modelPolicy,
    models,
    cloudModels,
    loading,
    environmentLoading,
    error,
    modelAvailable,
    valid: validEnvironment && (modelMode === 'user_select' || modelAvailable),
    load,
  }
}
