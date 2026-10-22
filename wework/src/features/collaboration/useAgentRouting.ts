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
import { createModelLoadingTrace, logModelLoading } from '@/lib/model-loading-diagnostics'

type NativeCatalog = Pick<RunnerEnvironment, 'models' | 'catalog_error'>

export interface RunnerCatalogApi {
  listEnvironments(projectId?: string): Promise<RunnerEnvironment[]>
  listNativeModels(environment: RunnerEnvironment, projectId?: string): Promise<NativeCatalog>
  listModels(): Promise<UnifiedModel[]>
}

interface RoutingDraft {
  executionPolicy: AgentExecutionPolicy | null
  modelMode: 'fixed' | 'user_select'
  model: RunnerModelIdentity | null
  initializeModel: boolean
  unchanged: boolean
}

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

export function useAgentRouting(
  api: RunnerCatalogApi,
  runtime: RunnerModelIdentity['runtime'],
  projectId?: string,
  {
    cloudOnly = false,
    creation = false,
    defer = false,
  }: {
    cloudOnly?: boolean
    creation?: boolean
    defer?: boolean
  } = {}
) {
  const [traceId] = useState(createModelLoadingTrace)
  const [activated, setActivated] = useState(!defer)
  const activate = useCallback(() => setActivated(true), [])
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
  const [nativeCatalog, setNativeCatalog] = useState<{
    api: RunnerCatalogApi
    projectId?: string
    environment: RunnerEnvironment
    result: NativeCatalog
  } | null>(null)
  const environmentLoading =
    activated && (catalog === null || catalog.api !== api || catalog.projectId !== projectId)
  const inventory = useMemo(
    () => (catalog?.api === api && catalog.projectId === projectId ? catalog.environments : []),
    [api, catalog, projectId]
  )
  const [draft, setDraft] = useState<RoutingDraft>(() => ({
    executionPolicy: creation ? { mode: 'project_pool' } : null,
    modelMode: 'fixed',
    model: null,
    initializeModel: creation,
    unchanged: false,
  }))
  const setExecutionPolicy = useCallback(
    (policy: AgentExecutionPolicy | null) => {
      setDraft(current => ({
        ...current,
        executionPolicy: policy,
        unchanged: false,
        // A device's native identity cannot be carried to another device.
        model: current.model?.source === 'cloud' ? current.model : null,
      }))
    },
    [setDraft]
  )
  const setModelMode = useCallback(
    (mode: 'fixed' | 'user_select') => {
      logModelLoading(traceId, 'agent.model_mode_selected', { fixed: mode === 'fixed' })
      setDraft(current => ({
        ...current,
        modelMode: mode,
        initializeModel: false,
        unchanged: false,
      }))
    },
    [setDraft, traceId]
  )
  const setModel = useCallback(
    (model: RunnerModelIdentity | null) => {
      logModelLoading(traceId, 'agent.model_selected', { selected: model !== null })
      setDraft(current => ({ ...current, model, initializeModel: false, unchanged: false }))
    },
    [setDraft, traceId]
  )

  useEffect(() => {
    if (!activated) return
    let active = true
    void api.listEnvironments(projectId).then(
      environments => {
        logModelLoading(traceId, 'agent.runner_inventory_loaded', {
          environments: environments.length,
        })
        if (active) setCatalog({ api, projectId, environments, error: null })
      },
      cause =>
        active && setCatalog({ api, projectId, environments: [], error: errorMessage(cause) })
    )
    return () => {
      active = false
    }
  }, [activated, api, projectId, traceId])

  let initializedDraft = draft
  const { executionPolicy } = draft
  const selectedEnvironment =
    executionPolicy?.mode === 'fixed'
      ? inventory.find(environment => environment.id === executionPolicy.environment_id)
      : undefined
  const environmentSelected = Boolean(
    executionPolicy && (executionPolicy.mode !== 'fixed' || selectedEnvironment)
  )
  // New forms need their cloud default before runtime settings are opened.
  const cloudActivated = creation || activated
  const cloudLoading = cloudActivated && environmentSelected && cloudCatalog?.api !== api
  const nativeLoading =
    activated &&
    !cloudOnly &&
    Boolean(selectedEnvironment) &&
    !(
      nativeCatalog?.api === api &&
      nativeCatalog.projectId === projectId &&
      nativeCatalog.environment === selectedEnvironment
    )

  useEffect(() => {
    if (!cloudActivated || !environmentSelected) return
    let active = true
    void api.listModels().then(
      models => active && setCloudCatalog({ api, models, error: null }),
      cause => active && setCloudCatalog({ api, models: [], error: errorMessage(cause) })
    )
    return () => {
      active = false
    }
  }, [cloudActivated, api, environmentSelected])

  useEffect(() => {
    if (!activated || cloudOnly || !selectedEnvironment) return
    let active = true
    void api.listNativeModels(selectedEnvironment, projectId).then(
      result => {
        logModelLoading(traceId, 'agent.native_catalog_loaded', { models: result.models.length })
        if (active) setNativeCatalog({ api, projectId, environment: selectedEnvironment, result })
      },
      cause =>
        active &&
        setNativeCatalog({
          api,
          projectId,
          environment: selectedEnvironment,
          result: { models: [], catalog_error: errorMessage(cause) },
        })
    )
    return () => {
      active = false
    }
  }, [activated, api, cloudOnly, projectId, selectedEnvironment, traceId])

  const environments = useMemo(
    () =>
      inventory.map(environment =>
        !nativeLoading &&
        nativeCatalog?.api === api &&
        nativeCatalog.projectId === projectId &&
        nativeCatalog.environment === environment
          ? { ...environment, ...nativeCatalog.result }
          : environment
      ),
    [api, inventory, nativeCatalog, nativeLoading, projectId]
  )
  const candidates = useMemo(
    () => policyEnvironments(environments, executionPolicy, Boolean(projectId)),
    [environments, executionPolicy, projectId]
  )
  const cloudModels = useMemo(
    () => cloudRunnerModels(cloudCatalog?.api === api ? cloudCatalog.models : []),
    [api, cloudCatalog]
  )
  const models = useMemo(
    () => policyModels(candidates, runtime, executionPolicy, cloudModels, cloudOnly),
    [candidates, runtime, executionPolicy, cloudModels, cloudOnly]
  )
  // Allocation policies can use cloud models before device inventory arrives.
  const loading =
    (executionPolicy?.mode === 'fixed' && environmentLoading) ||
    (cloudLoading && models.length === 0)
  if (
    initializedDraft.initializeModel &&
    cloudActivated &&
    environmentSelected &&
    !loading &&
    !cloudLoading
  ) {
    const defaultModel = models[0]
    if (defaultModel && (defaultModel.source === 'cloud' || !nativeLoading)) {
      initializedDraft = {
        ...initializedDraft,
        initializeModel: false,
        model: {
          runtime: defaultModel.runtime,
          provider: defaultModel.provider,
          model_id: defaultModel.model_id,
          source: defaultModel.source ?? 'native',
          ...(defaultModel.cloud_model ? { cloud_model: defaultModel.cloud_model } : {}),
        },
      }
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
        initializeModel: false,
        unchanged: true,
      })
    },
    [setDraft]
  )
  const error =
    [
      catalog?.api === api && catalog.projectId === projectId ? catalog.error : null,
      cloudCatalog?.api === api ? cloudCatalog.error : null,
    ]
      .filter(Boolean)
      .join(' · ') || null
  return {
    activated,
    activate,
    hasProject: Boolean(projectId),
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
    nativeLoading,
    error,
    modelAvailable,
    valid:
      (!activated && draft.unchanged && executionPolicy !== null && modelPolicy !== null) ||
      (validEnvironment && (modelMode === 'user_select' || modelAvailable)),
    load,
  }
}
