import type { CloudLoopItem, WorkflowExecutionConfig } from '@/api/deliveries'
import type { RuntimeTaskCreateRequest } from '@/types/api'
import { effectiveWorkflowNodeExecutionConfig } from './workflowExecutionConfig'

export function taskActivityExecutionConfig(task: CloudLoopItem): WorkflowExecutionConfig | null {
  const workflow = task.workflow
  if (!workflow) return task.execution_config ?? null
  const node = workflow.nodes.find(node => node.id === workflow.current_stage_id)
  return (
    (node ? effectiveWorkflowNodeExecutionConfig(workflow, node) : workflow.execution_config) ??
    task.execution_config ??
    null
  )
}

export function activityTaskRequest(
  config: WorkflowExecutionConfig | null,
  message: string
): RuntimeTaskCreateRequest | undefined {
  if (!config) return undefined
  const binding = config.workspace_binding
  return {
    runtime: 'codex',
    message,
    ...(config.execution_device_id ? { deviceId: config.execution_device_id } : {}),
    ...(binding?.type === 'backend_project'
      ? {
          projectId: binding.projectId,
          ...(binding.deviceWorkspaceId ? { deviceWorkspaceId: binding.deviceWorkspaceId } : {}),
          ...(binding.deviceId ? { deviceId: binding.deviceId } : {}),
        }
      : binding?.type === 'device_project'
        ? { deviceId: binding.deviceId, runtimeProjectKey: binding.runtimeProjectKey }
        : { standaloneChatWorkspace: true }),
    ...(config.model
      ? {
          modelId: config.model,
          modelType: config.model_type,
          modelOptions: config.model_options,
          modelSelection: {
            modelName: config.model,
            modelType: config.model_type,
            options: config.model_options,
          },
        }
      : {}),
    ...(config.execution ? { execution: config.execution } : {}),
    ...(config.runtime_permission_mode
      ? { runtimePermissionMode: config.runtime_permission_mode }
      : {}),
    ...(config.initial_goal ? { initialGoal: config.initial_goal } : {}),
    ...(config.initial_supervisor ? { initialSupervisor: config.initial_supervisor } : {}),
    ...(config.additional_skills ? { additionalSkills: config.additional_skills } : {}),
    ...(config.project_plugins ? { projectPlugins: config.project_plugins } : {}),
    ...(config.additional_context ? { additionalContext: config.additional_context } : {}),
    ...(config.attachment_ids ? { attachmentIds: config.attachment_ids } : {}),
    ...(config.attachments ? { attachments: config.attachments } : {}),
    ephemeral: false,
  }
}
