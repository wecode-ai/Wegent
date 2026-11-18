import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import {
  policyEnvironments,
  policyModels,
  runnerModelKey,
  cloudRunnerModels,
  runnerSupportsModel,
  type AgentExecutionPolicy,
  type AgentModelPolicy,
  type RunnerEnvironment,
  type RunnerModelIdentity,
} from '@wegent/collaboration'
import type { UnifiedModel } from '@/types/api'
import { createModelLoadingTrace, logModelLoading } from '@/lib/model-loading-diagnostics'

const EMPTY_ENVIRONMENTS: RunnerEnvironment[] = []
const EMPTY_MODELS: UnifiedModel[] = []

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
  /** The fixed model came from a saved policy and may be hidden from the catalog. */
  modelPersisted: boolean
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
  const [environmentPickerOpen, setEnvironmentPickerOpen] = useState(false)
  const activate = useCallback(() => setActivated(true), [])
  const environmentResource = useMemo(
    () =>
      createAsyncResource(
        'agent/runner-inventory',
        async signal => {
          await Promise.resolve()
          signal.throwIfAborted()
          return api.listEnvironments(projectId)
        },
        {
          success(environments) {
            logModelLoading(traceId, 'agent.runner_inventory_loaded', {
              environments: environments.length,
            })
          },
        }
      ),
    [api, projectId, traceId]
  )
  const catalog = useSyncExternalStore(
    activated ? environmentResource.subscribe : subscribeIdleResource,
    environmentResource.getSnapshot,
    getIdleResourceSnapshot
  )
  const environmentLoading = activated && !catalog.settled
  const inventory = catalog.data ?? EMPTY_ENVIRONMENTS
  const [draft, setDraft] = useState<RoutingDraft>(() => ({
    executionPolicy: creation ? { mode: 'project_pool' } : null,
    modelMode: 'fixed',
    model: null,
    modelPersisted: false,
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
        modelPersisted: current.model?.source === 'cloud' ? current.modelPersisted : false,
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
        modelPersisted: false,
        initializeModel: false,
        unchanged: false,
      }))
    },
    [setDraft, traceId]
  )
  const setModel = useCallback(
    (model: RunnerModelIdentity | null) => {
      logModelLoading(traceId, 'agent.model_selected', { selected: model !== null })
      setDraft(current => ({
        ...current,
        model,
        modelPersisted: false,
        initializeModel: false,
        unchanged: false,
      }))
    },
    [setDraft, traceId]
  )

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
  const cloudResource = useMemo(
    () =>
      createAsyncResource(
        'agent/cloud-models',
        async signal => {
          await Promise.resolve()
          signal.throwIfAborted()
          return api.listModels()
        },
        { refreshOnSubscribe: true }
      ),
    [api]
  )
  const cloudEnabled = cloudActivated && environmentSelected
  const cloudCatalog = useSyncExternalStore(
    cloudEnabled ? cloudResource.subscribe : subscribeIdleResource,
    cloudResource.getSnapshot,
    getIdleResourceSnapshot
  )
  const cloudLoading = cloudEnabled && !cloudCatalog.settled
  const nativeResource = useMemo(
    () =>
      createAsyncResource<NativeCatalog>(
        'agent/native-models',
        async signal => {
          await Promise.resolve()
          signal.throwIfAborted()
          if (!selectedEnvironment)
            throw new Error('An environment must be selected to load native models')
          return api.listNativeModels(selectedEnvironment, projectId)
        },
        {
          success(result) {
            logModelLoading(traceId, 'agent.native_catalog_loaded', {
              models: result.models.length,
            })
          },
        }
      ),
    [api, projectId, selectedEnvironment, traceId]
  )
  const nativeEnabled = activated && !cloudOnly && Boolean(selectedEnvironment)
  const nativeCatalog = useSyncExternalStore(
    nativeEnabled ? nativeResource.subscribe : subscribeIdleResource,
    nativeResource.getSnapshot,
    getIdleResourceSnapshot
  )
  const nativeLoading = nativeEnabled && !nativeCatalog.settled
  const environments = useMemo(
    () =>
      inventory.map(environment =>
        !nativeLoading && nativeCatalog.settled && environment === selectedEnvironment
          ? {
              ...environment,
              ...(nativeCatalog.status === 'error'
                ? { models: [], catalog_error: errorMessage(nativeCatalog.error) }
                : nativeCatalog.data),
            }
          : environment
      ),
    [inventory, nativeCatalog, nativeLoading, selectedEnvironment]
  )
  const candidates = useMemo(
    () => policyEnvironments(environments, executionPolicy, Boolean(projectId)),
    [environments, executionPolicy, projectId]
  )
  const cloudModels = useMemo(
    () => cloudRunnerModels(cloudCatalog.data ?? EMPTY_MODELS),
    [cloudCatalog.data]
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
  // A saved cloud model is supported when any merged candidate for the policy
  // supports its runtime. For fixed policies the inventory may omit runtimes
  // that the native catalog reveals, so validate against the merged candidates
  // instead of the raw inventory entry.
  const persistedModelSupported =
    draft.modelPersisted &&
    model !== null &&
    candidates.some(environment => runnerSupportsModel(environment, model))
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
        modelPersisted: modelPolicy?.mode === 'fixed' && modelPolicy.model?.source === 'cloud',
        initializeModel: false,
        unchanged: true,
      })
    },
    [setDraft]
  )
  const error =
    [
      catalog.status === 'error' ? errorMessage(catalog.error) : null,
      cloudCatalog.status === 'error' ? errorMessage(cloudCatalog.error) : null,
    ]
      .filter(Boolean)
      .join(' · ') || null
  return {
    changed: !initializedDraft.unchanged,
    activated,
    activate,
    hasProject: Boolean(projectId),
    environments,
    environmentPickerOpen,
    setEnvironmentPickerOpen,
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
    persistedModelSupported,
    valid:
      (!activated && draft.unchanged && executionPolicy !== null && modelPolicy !== null) ||
      (validEnvironment &&
        (modelMode === 'user_select' || modelAvailable || persistedModelSupported)),
    load,
  }
}
