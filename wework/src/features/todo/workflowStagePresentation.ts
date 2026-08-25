import type { WorkflowNodeInstance } from '@/api/deliveries'

const CURRENT_STAGE_STATUS_PRIORITY: WorkflowNodeInstance['status'][] = [
  'running',
  'awaiting_approval',
  'awaiting_deliverables',
  'changes_requested',
  'failed',
  'queued',
  'ready',
]

export function getCurrentWorkflowNode(nodes: WorkflowNodeInstance[]): WorkflowNodeInstance | null {
  for (const status of CURRENT_STAGE_STATUS_PRIORITY) {
    const currentNode = nodes.find(node => node.status === status)
    if (currentNode) return currentNode
  }

  return nodes.findLast(node => isWorkflowNodeCompleted(node.status)) ?? nodes[0] ?? null
}

export function workflowNodeStatusLabel(
  t: (key: string) => string,
  status: WorkflowNodeInstance['status']
): string {
  if (status === 'blocked') return t('todo.workflow_node_blocked')
  if (status === 'ready') return t('todo.workflow_node_ready')
  if (status === 'queued') return t('todo.workflow_node_queued')
  if (status === 'running') return t('todo.workflow_node_running')
  if (status === 'awaiting_approval') return t('todo.workflow_node_awaiting_approval')
  if (status === 'awaiting_deliverables') return t('todo.workflow_node_awaiting_deliverables')
  if (status === 'changes_requested') return t('todo.workflow_node_changes_requested')
  if (status === 'completed') return t('todo.workflow_node_completed')
  if (status === 'forced_completed') return t('todo.workflow_node_forced_completed')
  return t('todo.workflow_node_failed')
}

export function isWorkflowNodeCompleted(status: WorkflowNodeInstance['status']): boolean {
  return status === 'completed' || status === 'forced_completed'
}
