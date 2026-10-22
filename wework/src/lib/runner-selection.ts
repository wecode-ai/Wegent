import type {
  AgentExecutionPolicy,
  AgentModelPolicy,
  RunnerEnvironment,
  RunnerModelIdentity,
  RunnerSelection,
} from '@wegent/collaboration'
import type { UnifiedModel } from '@/types/api'

export interface RunnerSelectionRequest {
  runtime: RunnerModelIdentity['runtime']
  execution_policy: AgentExecutionPolicy
  model_policy: AgentModelPolicy
  environments: RunnerEnvironment[]
  cloud_models: UnifiedModel[]
  cloud_only: boolean
  automatic?: boolean
}

type SelectionHandler = (request: RunnerSelectionRequest) => Promise<RunnerSelection>
let handler: SelectionHandler | undefined
export function registerRunnerSelectionHandler(value: SelectionHandler) {
  handler = value
  return () => {
    if (handler === value) handler = undefined
  }
}
export function requestRunnerSelection(request: RunnerSelectionRequest): Promise<RunnerSelection> {
  if (!handler)
    return Promise.reject(
      new Error('RUNNER_SELECTION_REQUIRED: choose an execution environment and model')
    )
  return handler(request)
}

export function runnerSelectionRequest(error: unknown): RunnerSelectionRequest | undefined {
  const detail = (error as { detail?: { runner_selection_request?: RunnerSelectionRequest } })
    ?.detail
  return detail?.runner_selection_request
}
