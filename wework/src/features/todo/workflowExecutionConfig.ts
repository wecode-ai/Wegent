import type {
  CloudLoopItem,
  IssueWorkflowInstance,
  WorkflowExecutionConfig,
  WorkflowNodeDefinition,
} from '@/api/deliveries'
import { workflowNodeExecutionMode } from '@/api/issueWorkflow'
import {
  projectChatAgentWorkspaceBinding,
  type ProjectChatAgent,
  type ProjectChatWorkspaceBindingInput,
} from '@/api/projectChatAgents'
import type { RuntimeProfile } from '@/api/runtimeProfiles'

export const emptyWorkflowExecutionConfig = (): WorkflowExecutionConfig => ({
  agent_id: null,
  runtime_profile_id: null,
  execution_device_id: null,
  model: null,
  workspace_binding: { type: 'standalone' },
})

export function workflowExecutionConfigComplete(
  config: WorkflowExecutionConfig | null | undefined
): boolean {
  return Boolean(
    (config?.agent_id?.trim() || config?.execution_device_id?.trim()) &&
    config?.model?.trim() &&
    config?.workspace_binding
  )
}

function executionWorkspaceBinding(
  agent: ProjectChatAgent
): ProjectChatWorkspaceBindingInput | null {
  const binding = projectChatAgentWorkspaceBinding(agent)
  if (binding.status !== 'ready') return null
  if (binding.type === 'backend_project') {
    return {
      type: 'backend_project',
      projectId: binding.projectId,
      deviceWorkspaceId: binding.deviceWorkspaceId,
      deviceId: binding.deviceId,
    }
  }
  if (binding.type === 'device_project') {
    return {
      type: 'device_project',
      deviceId: binding.deviceId,
      runtimeProjectKey: binding.runtimeProjectKey,
    }
  }
  return null
}

export function workflowExecutionConfigForAgent(
  agent: ProjectChatAgent,
  runtimeProfile?: RuntimeProfile,
  runtimeProfileId = runtimeProfile?.id ?? agent.defaultRuntimeProfileId
): WorkflowExecutionConfig {
  return {
    agent_id: agent.id,
    runtime_profile_id: runtimeProfileId,
    execution_device_id: runtimeProfile?.executionDeviceId || agent.executionDeviceId || null,
    model: runtimeProfile?.model || agent.model || null,
    workspace_binding: executionWorkspaceBinding(agent),
  }
}

export function mergeWorkflowExecutionConfig(
  base: WorkflowExecutionConfig | null | undefined,
  override: WorkflowExecutionConfig | null | undefined
): WorkflowExecutionConfig | null {
  if (!override) return base ?? null
  if (!base) return override
  return {
    agent_id: override.agent_id || base.agent_id,
    runtime_profile_id: override.runtime_profile_id || base.runtime_profile_id,
    execution_device_id: override.execution_device_id || base.execution_device_id,
    model: override.model?.trim() || base.model,
    workspace_binding: override.workspace_binding || base.workspace_binding,
  }
}

export function resolveWorkflowExecutionConfig(
  config: WorkflowExecutionConfig,
  agents: ProjectChatAgent[],
  runtimeProfiles: RuntimeProfile[]
): WorkflowExecutionConfig {
  const agent = agents.find(candidate => candidate.id === config.agent_id)
  if (!agent) return config
  const runtimeProfileId = config.runtime_profile_id ?? agent.defaultRuntimeProfileId
  const runtimeProfile = runtimeProfiles.find(candidate => candidate.id === runtimeProfileId)
  return (
    mergeWorkflowExecutionConfig(
      workflowExecutionConfigForAgent(agent, runtimeProfile, runtimeProfileId),
      config
    ) ?? config
  )
}

export function effectiveWorkflowNodeExecutionConfig(
  workflow: Pick<IssueWorkflowInstance, 'execution_config'>,
  node: Pick<WorkflowNodeDefinition, 'execution_config' | 'execution_config_override'>
): WorkflowExecutionConfig | null {
  if (node.execution_config_override) {
    return mergeWorkflowExecutionConfig(workflow.execution_config, node.execution_config)
  }
  return workflow.execution_config ?? node.execution_config ?? null
}

export function workflowNeedsExecutionConfiguration(
  workflow: IssueWorkflowInstance | null | undefined
): boolean {
  if (!workflow) return false
  return workflow.nodes.some(
    node =>
      workflowNodeExecutionMode(node) === 'robot' &&
      ['blocked', 'ready', 'failed'].includes(node.status) &&
      !workflowExecutionConfigComplete(effectiveWorkflowNodeExecutionConfig(workflow, node))
  )
}

export function itemNeedsExecutionConfiguration(
  item: Pick<
    CloudLoopItem,
    'assignee_agent_id' | 'execution_config' | 'execution_state' | 'status' | 'workflow'
  >,
  targetStatus: CloudLoopItem['status'] = item.status
): boolean {
  if (!['pending', 'in_progress'].includes(targetStatus)) return false
  if (item.workflow) return workflowNeedsExecutionConfiguration(item.workflow)
  return Boolean(
    item.assignee_agent_id &&
    (!workflowExecutionConfigComplete(item.execution_config) ||
      ['waiting_runtime', 'waiting_device'].includes(item.execution_state ?? ''))
  )
}
