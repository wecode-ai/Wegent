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
  model_type: null,
  model_options: {},
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
  const usesRuntimeProfile = Boolean(runtimeProfile?.model)
  return {
    agent_id: agent.id,
    runtime_profile_id: runtimeProfileId,
    execution_device_id: runtimeProfile?.executionDeviceId || agent.executionDeviceId || null,
    model: runtimeProfile?.model || agent.model || null,
    model_type: usesRuntimeProfile
      ? (runtimeProfile?.modelType ?? null)
      : (agent.modelType ?? null),
    model_options: usesRuntimeProfile
      ? (runtimeProfile?.modelOptions ?? {})
      : (agent.modelOptions ?? {}),
    workspace_binding: executionWorkspaceBinding(agent),
  }
}

export function mergeWorkflowExecutionConfig(
  base: WorkflowExecutionConfig | null | undefined,
  override: WorkflowExecutionConfig | null | undefined
): WorkflowExecutionConfig | null {
  if (!override) return base ?? null
  if (!base) return override
  const modelOverridden = Boolean(override.model?.trim())
  const merged: WorkflowExecutionConfig = {
    agent_id: override.agent_id || base.agent_id,
    runtime_profile_id: override.runtime_profile_id || base.runtime_profile_id,
    execution_device_id: override.execution_device_id || base.execution_device_id,
    model: override.model?.trim() || base.model,
    model_type: modelOverridden ? override.model_type : base.model_type,
    model_options: modelOverridden ? override.model_options : base.model_options,
    workspace_binding: override.workspace_binding || base.workspace_binding,
    runtime_permission_mode: override.runtime_permission_mode ?? base.runtime_permission_mode,
    execution: override.execution ?? base.execution,
    initial_goal: override.initial_goal ?? base.initial_goal,
    initial_supervisor: override.initial_supervisor ?? base.initial_supervisor,
    additional_skills: override.additional_skills ?? base.additional_skills,
    attachment_ids: override.attachment_ids ?? base.attachment_ids,
    attachments: override.attachments ?? base.attachments,
    project_plugins: override.project_plugins ?? base.project_plugins,
    additional_context: override.additional_context ?? base.additional_context,
    ephemeral: override.ephemeral ?? base.ephemeral,
  }
  for (const key of Object.keys(merged) as Array<keyof WorkflowExecutionConfig>) {
    if (merged[key] === undefined) delete merged[key]
  }
  return merged
}

export function resolveWorkflowExecutionConfig(
  config: WorkflowExecutionConfig,
  agents: ProjectChatAgent[],
  runtimeProfiles: RuntimeProfile[]
): WorkflowExecutionConfig {
  const agent = agents.find(candidate => candidate.id === config.agent_id)
  if (!agent) {
    return config.workspace_binding
      ? config
      : { ...config, workspace_binding: { type: 'standalone' } }
  }
  const runtimeProfileId = config.runtime_profile_id ?? agent.defaultRuntimeProfileId
  const runtimeProfile = runtimeProfiles.find(candidate => candidate.id === runtimeProfileId)
  const resolved =
    mergeWorkflowExecutionConfig(
      workflowExecutionConfigForAgent(agent, runtimeProfile, runtimeProfileId),
      config
    ) ?? config
  return resolved.workspace_binding
    ? resolved
    : { ...resolved, workspace_binding: { type: 'standalone' } }
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
  if (workflow.advancement_policy === 'ai') {
    return Boolean(
      workflow.execution_config && !workflowExecutionConfigComplete(workflow.execution_config)
    )
  }
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
    'assignee_agent_id' | 'execution_config' | 'execution_state' | 'workflow'
  >
): boolean {
  if (item.workflow) return workflowNeedsExecutionConfiguration(item.workflow)
  return Boolean(
    item.assignee_agent_id &&
    (!workflowExecutionConfigComplete(item.execution_config) ||
      ['waiting_runtime', 'waiting_device'].includes(item.execution_state ?? ''))
  )
}
