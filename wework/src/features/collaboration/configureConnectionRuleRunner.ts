import type { ConnectionAutomationRule } from '@wegent/collaboration/automation'
import type { SharedWorkspaceApi } from '@wegent/collaboration'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import {
  validateAutomationRunnerSelections,
  type AutomationRoutingTarget,
} from './automationRunnerSelection'

export async function configureConnectionRuleRunner(
  rule: ConnectionAutomationRule,
  services: WorkbenchServices,
  api: SharedWorkspaceApi
): Promise<ConnectionAutomationRule> {
  if (!rule.enabled || rule.targetKind === 'human') return rule
  const catalog =
    rule.project.store === 'local' ? services.localProjectChatAgentApi : services.agentResourceApi
  if (!catalog) throw new Error('Runner catalog is unavailable')
  const agents: AutomationRoutingTarget[] =
    rule.project.store === 'local'
      ? await services.localProjectChatAgentApi!.list(rule.project.id, { forceRefresh: true })
      : (await api.agents.list(rule.project.id, { forceRefresh: true })).map(agent => ({
          id: agent.id,
          runtime: agent.runtime as AutomationRoutingTarget['runtime'],
          executionPolicy: agent.executionPolicy as AutomationRoutingTarget['executionPolicy'],
          modelPolicy: agent.modelPolicy as AutomationRoutingTarget['modelPolicy'],
        }))
  const groups = (await api.projects.listCollaborationGroups?.(rule.project.id)) ?? []
  const inventory =
    rule.project.store === 'local'
      ? await services.localProjectChatAgentApi!.listRunnerEnvironments(rule.project.id)
      : await services.agentResourceApi!.listEnvironments(rule.project.id)
  const configured = { ...rule }
  await validateAutomationRunnerSelections(
    agents,
    groups,
    inventory,
    () => catalog.listModels(),
    [configured],
    rule.project.store === 'cloud'
      ? environment => catalog.listNativeModels(environment, rule.project.id)
      : undefined
  )
  return configured
}
