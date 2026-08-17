import type {
  CloudLoopItem,
  IssueWorkflowInstance,
  ProjectWorkflowDefinition,
  WorkflowNodeInstance,
} from './deliveries'

type RuntimeWorkflowStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'archived'

export function instantiateIssueWorkflow(
  definition: ProjectWorkflowDefinition | null | undefined
): IssueWorkflowInstance | null {
  if (!definition?.nodes.length) return null
  return {
    version: 1,
    definition_version: definition.version,
    nodes: definition.nodes.map(node => ({
      ...node,
      status: node.depends_on.length === 0 ? 'ready' : 'blocked',
      task_binding_id: null,
      execution_id: null,
    })),
  }
}

function releaseReadyNodes(nodes: WorkflowNodeInstance[]): WorkflowNodeInstance[] {
  const completed = new Set(nodes.filter(node => node.status === 'completed').map(node => node.id))
  return nodes.map(node => {
    if (node.status !== 'blocked') return node
    return node.depends_on.every(dependency => completed.has(dependency))
      ? { ...node, status: 'ready' }
      : node
  })
}

export function updateIssueWorkflowForRuntime(
  workflow: IssueWorkflowInstance,
  workflowNodeId: string,
  executionStatus: RuntimeWorkflowStatus
): IssueWorkflowInstance {
  const status =
    executionStatus === 'running'
      ? 'running'
      : executionStatus === 'succeeded' || executionStatus === 'archived'
        ? 'completed'
        : 'failed'
  const nodes = releaseReadyNodes(
    workflow.nodes.map(node => (node.id === workflowNodeId ? { ...node, status } : node))
  )
  return { ...workflow, version: workflow.version + 1, nodes }
}

export function workflowBoardStatus(workflow: IssueWorkflowInstance): CloudLoopItem['status'] {
  const required = workflow.nodes.filter(node => node.required)
  if (required.length > 0 && required.every(node => node.status === 'completed')) {
    return 'in_review'
  }
  if (workflow.nodes.some(node => node.status === 'running')) return 'in_progress'
  return 'pending'
}

export function workflowNodeForBinding(
  workflow: IssueWorkflowInstance | null | undefined,
  workflowNodeId: string | null | undefined
): WorkflowNodeInstance | null {
  if (!workflow || !workflowNodeId) return null
  return workflow.nodes.find(node => node.id === workflowNodeId) ?? null
}

export function preferNewestLoopItemSnapshot<T extends CloudLoopItem>(current: T, incoming: T): T {
  if (current.id !== incoming.id) return incoming
  if (current.version !== incoming.version) {
    return current.version > incoming.version ? current : incoming
  }
  const currentWorkflowVersion = current.workflow?.version ?? 0
  const incomingWorkflowVersion = incoming.workflow?.version ?? 0
  return currentWorkflowVersion > incomingWorkflowVersion ? current : incoming
}
