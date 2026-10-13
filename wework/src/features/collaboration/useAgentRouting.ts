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

interface RoutingDraft {
  executionPolicy: AgentExecutionPolicy | null
  modelMode: 'fixed' | 'user_select'
  model: RunnerModelIdentity | null
  initializeEnvironment: boolean
  initializeModel: boolean
}

export function useAgentRouting(
  api: RunnerCatalogApi,
  runtime: RunnerModelIdentity['runtime'],
  projectId?: string,
  {
    cloudOnly = false,
    creationDefaults,
  }: {
    cloudOnly?: boolean
    creationDefaults?: { preferredDeviceIds: string[] }
  } = {}
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
  const [draft, setDraft] = useState<RoutingDraft>(() => ({
    executionPolicy: creationDefaults ? { mode: 'fixed', environment_id: '' } : null,
    modelMode: 'fixed',
    model: null,
    initializeEnvironment: Boolean(creationDefaults),
    initializeModel: Boolean(creationDefaults),
  }))

  const setExecutionPolicy = useCallback(
    (policy: AgentExecutionPolicy | null) => {
      setDraft(draft => ({ ...draft, executionPolicy: policy, initializeEnvironment: false }))
    },
    [setDraft]
  )
  const setModelMode = useCallback(
    (mode: 'fixed' | 'user_select') => {
      setDraft(draft => ({ ...draft, modelMode: mode, initializeModel: false }))
    },
    [setDraft]
  )
  const setModel = useCallback(
    (model: RunnerModelIdentity | null) => {
      setDraft(draft => ({ ...draft, model, initializeModel: false }))
    },
    [setDraft]
  )

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

  // Snapshot defaults once when catalogs settle, before rendering the form.
  let initializedDraft = draft
  if (creationDefaults && draft.initializeEnvironment && !environmentLoading) {
    const eligible = environments.filter(
      environment =>
        environment.runtimes?.includes(runtime) ||
        environment.models.some(model => model.runtime === runtime)
    )
    const preferred = creationDefaults.preferredDeviceIds
      .map(id => eligible.find(environment => environment.device_key === id))
      .find(Boolean)
    const environment = preferred ?? (eligible.length === 1 ? eligible[0] : undefined)
    initializedDraft = {
      ...initializedDraft,
      initializeEnvironment: false,
      executionPolicy: environment
        ? { mode: 'fixed', environment_id: environment.id }
        : draft.executionPolicy,
    }
  }

  const { executionPolicy } = initializedDraft
  const loading = cloudLoading || (executionPolicy?.mode === 'fixed' && environmentLoading)
  const candidates = useMemo(
    () => policyEnvironments(environments, executionPolicy, Boolean(projectId)),
    [environments, executionPolicy, projectId]
  )
  const models = useMemo(
    () => policyModels(candidates, runtime, executionPolicy, cloudModels, cloudOnly),
    [candidates, runtime, executionPolicy, cloudModels, cloudOnly]
  )

  if (
    initializedDraft.initializeModel &&
    !loading &&
    executionPolicy?.mode === 'fixed' &&
    candidates.length === 1
  ) {
    const defaultModel =
      models.find(model => model.is_default) ?? (models.length === 1 ? models[0] : undefined)
    initializedDraft = {
      ...initializedDraft,
      initializeModel: false,
      model: defaultModel
        ? {
            runtime: defaultModel.runtime,
            provider: defaultModel.provider,
            model_id: defaultModel.model_id,
            source: defaultModel.source ?? 'native',
            ...(defaultModel.cloud_model ? { cloud_model: defaultModel.cloud_model } : {}),
          }
        : initializedDraft.model,
    }
  }
  if (initializedDraft !== draft) setDraft(initializedDraft)
  const { modelMode, model } = initializedDraft
  const modelAvailable =
    model !== null && models.some(item => runnerModelKey(item) === runnerModelKey(model))
  const modelPolicy: AgentModelPolicy | null =
    modelMode === 'user_select' ? { mode: 'user_select' } : model ? { mode: 'fixed', model } : null
  const validEnvironment =
    executionPolicy !== null && (executionPolicy.mode !== 'fixed' || candidates.length === 1)
  const load = useCallback(
    (policy: AgentExecutionPolicy | undefined, modelPolicy: AgentModelPolicy | undefined) => {
      setDraft({
        executionPolicy: policy ?? null,
        modelMode: modelPolicy?.mode ?? 'fixed',
        model: modelPolicy?.model ?? null,
        initializeEnvironment: false,
        initializeModel: false,
      })
    },
    [setDraft]
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
