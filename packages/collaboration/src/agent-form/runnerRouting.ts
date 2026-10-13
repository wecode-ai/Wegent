import { getCloudModelUpstreamApiFormat } from '@wegent/chat-core/model-execution'
import type { UnifiedModel } from '@wegent/chat-core/models'

export type AgentExecutionPolicy =
  | { mode: 'project_pool' | 'user_select'; environment_id?: never }
  | { mode: 'fixed'; environment_id: string }

export interface RunnerModelIdentity {
  runtime: 'codex' | 'claude_code'
  provider: string
  model_id: string
  source?: 'native' | 'cloud' | null
  cloud_model?: {
    name: string
    type: 'public' | 'user' | 'group'
    namespace: string
    resource_user_id: number
  } | null
}

export type AgentModelPolicy =
  | { mode: 'user_select'; model?: never }
  | { mode: 'fixed'; model: RunnerModelIdentity }

export interface RunnerModel extends RunnerModelIdentity {
  label: string
  local_model_id: string
  account_label: string
  is_default: boolean
}

export interface RunnerEnvironment {
  id: string
  device_key: string
  name: string
  owner_type: 'user' | 'workspace'
  owner_id: string
  status: 'online' | 'offline' | 'unknown'
  project_authorized: boolean
  catalog_error?: string | null
  models: RunnerModel[]
  runtimes?: RunnerModelIdentity['runtime'][]
}

export function runnerModelKey(model: RunnerModelIdentity): string {
  if (model.source === 'cloud') {
    const ref = model.cloud_model
    return JSON.stringify([
      model.runtime,
      'cloud',
      ref?.type,
      ref?.namespace,
      ref?.resource_user_id,
      ref?.name,
    ])
  }
  return JSON.stringify([model.runtime, model.provider, model.model_id])
}

/** Resource references and account labels only; never persist a model config. */
export function cloudRunnerModels(models: UnifiedModel[]): RunnerModel[] {
  return models.flatMap(model => {
    const protocol = getCloudModelUpstreamApiFormat(model)
    if (
      model.type === 'runtime' ||
      model.isActive === false ||
      model.compatibilityDisabled ||
      !protocol ||
      !model.namespace ||
      model.resourceUserId == null
    )
      return []
    const runtimes: RunnerModelIdentity['runtime'][] = ['codex', 'claude_code']
    return runtimes.map(runtime => ({
      runtime,
      source: 'cloud' as const,
      provider: model.provider || protocol,
      model_id: model.modelId || model.name,
      cloud_model: {
        name: model.name,
        type: model.type as 'public' | 'user' | 'group',
        namespace: model.namespace!,
        resource_user_id: model.resourceUserId!,
      },
      label: model.displayName || model.name,
      local_model_id: '',
      account_label: 'cloud_gateway',
      is_default: false,
    }))
  })
}

export function runnerSupportsModel(
  environment: RunnerEnvironment,
  model: RunnerModelIdentity
): boolean {
  if (model.source === 'cloud')
    return [
      ...(environment.runtimes ?? []),
      ...environment.models.map(item => item.runtime),
    ].includes(model.runtime)
  return environment.models.some(candidate => runnerModelKey(candidate) === runnerModelKey(model))
}

export function policyEnvironments(
  environments: RunnerEnvironment[],
  policy: AgentExecutionPolicy | null,
  hasProject: boolean
): RunnerEnvironment[] {
  if (!policy) return []
  if (policy.mode === 'fixed') return environments.filter(item => item.id === policy.environment_id)
  if (policy.mode === 'project_pool' && hasProject)
    return environments.filter(item => item.project_authorized)
  return environments
}

export function policyModels(
  environments: RunnerEnvironment[],
  runtime: RunnerModelIdentity['runtime'],
  policy: AgentExecutionPolicy | null,
  cloudModels: RunnerModel[] = [],
  cloudOnly = false
) {
  const models = new Map<string, RunnerModel & { environments: string[] }>()
  if (!policy) return []
  if (policy.mode === 'fixed')
    environments = environments.filter(item => item.id === policy.environment_id)
  for (const model of cloudModels) {
    if (model.runtime !== runtime) continue
    if (policy.mode === 'fixed' && !environments.some(item => runnerSupportsModel(item, model)))
      continue
    models.set(runnerModelKey(model), { ...model, environments: [] })
  }
  if (policy.mode !== 'fixed' || cloudOnly) return [...models.values()]
  for (const environment of environments) {
    for (const model of environment.models) {
      if (model.runtime !== runtime) continue
      const key = runnerModelKey(model)
      const previous = models.get(key)
      const source = `${environment.name}${model.account_label ? ` · ${model.account_label}` : ''}`
      models.set(key, {
        ...model,
        environments: [...(previous?.environments ?? []), source],
      })
    }
  }
  return [...models.values()]
}

export interface RunnerSelection {
  execution_policy?: AgentExecutionPolicy
  model?: RunnerModelIdentity
}

/** Resolve a local execution using the same rules as the server queue. */
export function resolveRunnerSelection(input: {
  environments: RunnerEnvironment[]
  cloudModels?: RunnerModel[]
  executionPolicy: AgentExecutionPolicy
  modelPolicy: AgentModelPolicy
  runtime: RunnerModelIdentity['runtime']
  selection?: RunnerSelection
  boundEnvironmentId?: string
  defaultEnvironmentId?: string | null
  automatic?: boolean
}) {
  let policy = input.executionPolicy
  let source: string = policy.mode
  const selection = input.selection ?? {}
  if (policy.mode === 'user_select') {
    if (selection.execution_policy && selection.execution_policy.mode !== 'user_select') {
      policy = selection.execution_policy
      source = 'execution_selection'
    } else if (input.automatic) {
      throw new Error('AUTOMATION_RUNNER_REQUIRED: configure the automation environment')
    } else if (input.boundEnvironmentId || input.defaultEnvironmentId) {
      policy = {
        mode: 'fixed',
        environment_id: input.boundEnvironmentId || input.defaultEnvironmentId!,
      }
      source = input.boundEnvironmentId ? 'issue_binding' : 'personal_default'
    } else {
      throw new Error(
        'RUNNER_SELECTION_REQUIRED: select an environment or set your personal default'
      )
    }
  } else if (
    selection.execution_policy &&
    (selection.execution_policy.mode !== policy.mode ||
      selection.execution_policy.environment_id !== policy.environment_id)
  ) {
    throw new Error('RUNNER_POLICY_FIXED: this agent has a fixed environment rule')
  }
  let candidates = policyEnvironments(input.environments, policy, true)
  if (input.boundEnvironmentId)
    candidates = candidates.filter(item => item.id === input.boundEnvironmentId)
  if (!candidates.length)
    throw new Error(
      input.boundEnvironmentId
        ? 'ISSUE_RUNNER_CONFLICT: the bound runner is not authorized for this policy'
        : 'RUNNER_ENVIRONMENT_UNAVAILABLE: no environment is authorized'
    )
  let model = input.modelPolicy.mode === 'fixed' ? input.modelPolicy.model : selection.model
  if (
    input.modelPolicy.mode === 'fixed' &&
    selection.model &&
    runnerModelKey(selection.model) !== runnerModelKey(model!)
  ) {
    throw new Error('RUNNER_MODEL_FIXED: this agent has a fixed model')
  }
  if (!model && !input.automatic && input.executionPolicy.mode === 'fixed') {
    const defaults = candidates.map(environment =>
      environment.models.find(item => item.runtime === input.runtime && item.is_default)
    )
    if (defaults.every(Boolean) && new Set(defaults.map(item => runnerModelKey(item!))).size === 1)
      model = defaults[0]
  }
  if (!model) throw new Error('RUNNER_MODEL_REQUIRED: select a model before execution')
  if (model.runtime !== input.runtime)
    throw new Error('RUNNER_RUNTIME_MISMATCH: the model does not support this runtime')
  const selectedModel: RunnerModelIdentity = {
    runtime: model.runtime,
    provider: model.provider,
    model_id: model.model_id,
    ...(model.source ? { source: model.source } : {}),
    ...(model.cloud_model ? { cloud_model: model.cloud_model } : {}),
  }
  if (model.source === 'native' && input.executionPolicy.mode !== 'fixed')
    throw new Error('RUNNER_MODEL_UNAVAILABLE: local models require a fixed environment')
  if (
    model.source === 'cloud' &&
    !(input.cloudModels ?? []).some(item => runnerModelKey(item) === runnerModelKey(model!))
  )
    throw new Error(
      'RUNNER_MODEL_UNAVAILABLE: the cloud model is unavailable or no longer authorized'
    )
  candidates = candidates.filter(item => runnerSupportsModel(item, selectedModel))
  if (!candidates.length)
    throw new Error('RUNNER_MODEL_UNAVAILABLE: no authorized environment supports this model')
  return {
    candidates,
    model: selectedModel,
    source,
    execution_policy: policy,
    model_source:
      input.modelPolicy.mode === 'fixed'
        ? 'agent_fixed'
        : selection.model
          ? 'execution_selection'
          : 'environment_default',
  }
}
