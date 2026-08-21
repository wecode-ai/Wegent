import type {
  IssueWorkflowInstance,
  WorkflowExecutionConfig,
  WorkflowNodeDefinition,
} from '@/api/deliveries'

export const emptyWorkflowExecutionConfig = (): WorkflowExecutionConfig => ({
  agent_id: null,
  runtime_profile_id: null,
  model: null,
  workspace_binding: null,
})

export function workflowExecutionConfigComplete(
  config: WorkflowExecutionConfig | null | undefined
): boolean {
  return Boolean(
    config?.agent_id &&
    config.runtime_profile_id &&
    config.model?.trim() &&
    config.workspace_binding &&
    config.workspace_binding.type !== 'standalone'
  )
}

export function effectiveWorkflowNodeExecutionConfig(
  workflow: Pick<IssueWorkflowInstance, 'execution_config'>,
  node: Pick<WorkflowNodeDefinition, 'execution_config' | 'execution_config_override'>
): WorkflowExecutionConfig | null {
  if (node.execution_config_override) return node.execution_config ?? null
  return workflow.execution_config ?? node.execution_config ?? null
}

export function workflowNeedsExecutionConfiguration(
  workflow: IssueWorkflowInstance | null | undefined
): boolean {
  if (!workflow) return false
  return workflow.nodes.some(
    node =>
      Boolean(node.automation_rule_id) &&
      ['blocked', 'ready', 'failed'].includes(node.status) &&
      !workflowExecutionConfigComplete(effectiveWorkflowNodeExecutionConfig(workflow, node))
  )
}
