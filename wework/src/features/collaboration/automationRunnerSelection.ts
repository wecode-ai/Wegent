import {
  cloudRunnerModels,
  requiresCloudModelCatalog,
  resolveRunnerSelection,
  type AgentExecutionPolicy,
  type AgentModelPolicy,
  type CollaborationGroup,
  type RunnerEnvironment,
  type RunnerSelection,
} from '@wegent/collaboration'
import type { UnifiedModel } from '@/types/api'
import { requestRunnerSelection } from '@/lib/runner-selection'

export interface AutomationRoutingTarget {
  id: string
  runtime: 'codex' | 'claude_code'
  executionPolicy?: AgentExecutionPolicy
  modelPolicy?: AgentModelPolicy
}
export interface AutomationRoutingRule {
  enabled: boolean
  targetKind: string
  targetId: string
  runnerSelection?: RunnerSelection
}

/** Project schedules and connected sources resolve the same unattended execution policy. */
export async function validateAutomationRunnerSelections(
  agents: AutomationRoutingTarget[],
  groups: CollaborationGroup[],
  environments: RunnerEnvironment[],
  listModels: () => Promise<UnifiedModel[]>,
  rules: AutomationRoutingRule[],
  loadNativeModels?: (
    environment: RunnerEnvironment
  ) => Promise<Pick<RunnerEnvironment, 'models' | 'catalog_error'>>
) {
  for (const rule of rules) {
    if (!rule.enabled || rule.targetKind === 'human') continue
    const group =
      rule.targetKind === 'collaboration_group'
        ? groups.find(item => item.id === rule.targetId)
        : undefined
    const ids = group
      ? [group.leader, ...group.members].filter(item => item.kind === 'agent').map(item => item.id)
      : [rule.targetId]
    const members = [...new Set(ids)].map(id => {
      const agent = agents.find(item => item.id === id)
      if (!agent) throw new Error(`Automation agent '${id}' is unavailable`)
      return agent
    })
    for (const agent of members) {
      const model =
        agent.modelPolicy?.mode === 'fixed' ? agent.modelPolicy.model : rule.runnerSelection?.model
      if (!loadNativeModels || agent.executionPolicy?.mode !== 'fixed' || model?.source === 'cloud')
        continue
      const environment = environments.find(
        item => item.id === agent.executionPolicy?.environment_id
      )
      if (environment) Object.assign(environment, await loadNativeModels(environment))
    }
    const cloudModels = members.some(
      agent =>
        agent.executionPolicy && requiresCloudModelCatalog(agent.modelPolicy, rule.runnerSelection)
    )
      ? await listModels()
      : []
    for (const agent of members) {
      if (!agent.executionPolicy || !agent.modelPolicy) continue
      const selection = () => ({
        ...(agent.executionPolicy?.mode === 'user_select'
          ? { execution_policy: rule.runnerSelection?.execution_policy }
          : {}),
        ...(agent.modelPolicy?.mode === 'user_select'
          ? { model: rule.runnerSelection?.model }
          : {}),
      })
      const input = {
        environments,
        cloudModels: cloudRunnerModels(cloudModels),
        executionPolicy: agent.executionPolicy,
        modelPolicy: agent.modelPolicy,
        runtime: agent.runtime,
        automatic: true,
      }
      try {
        resolveRunnerSelection({ ...input, selection: selection() })
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !/^(AUTOMATION_RUNNER_REQUIRED|RUNNER_MODEL_REQUIRED):/.test(error.message)
        )
          throw error
        rule.runnerSelection = {
          ...rule.runnerSelection,
          ...(await requestRunnerSelection({
            environments,
            cloud_models: cloudModels,
            cloud_only: agent.executionPolicy.mode !== 'fixed',
            runtime: agent.runtime,
            execution_policy: agent.executionPolicy,
            model_policy: agent.modelPolicy,
            automatic: true,
          })),
        }
        resolveRunnerSelection({ ...input, selection: selection() })
      }
    }
    // Recheck the entire group after the last choice: one deferred selection
    // must satisfy every member that delegates that choice to the operator.
    for (const agent of members) {
      if (!agent.executionPolicy || !agent.modelPolicy) continue
      resolveRunnerSelection({
        environments,
        cloudModels: cloudRunnerModels(cloudModels),
        executionPolicy: agent.executionPolicy,
        modelPolicy: agent.modelPolicy,
        runtime: agent.runtime,
        automatic: true,
        selection: {
          ...(agent.executionPolicy.mode === 'user_select'
            ? { execution_policy: rule.runnerSelection?.execution_policy }
            : {}),
          ...(agent.modelPolicy.mode === 'user_select'
            ? { model: rule.runnerSelection?.model }
            : {}),
        },
      })
    }
  }
}
