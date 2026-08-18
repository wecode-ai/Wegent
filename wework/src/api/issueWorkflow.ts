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
  if (!definition) return null
  const stageMode = definition.stage_mode ?? (definition.nodes.length ? 'dag' : 'none')
  const advancementPolicy = definition.advancement_policy ?? 'manual'
  if (stageMode === 'none' && advancementPolicy === 'manual') return null
  return {
    version: 1,
    definition_version: definition.version,
    stage_mode: stageMode,
    advancement_policy: advancementPolicy,
    coordinator_prompt: definition.coordinator_prompt ?? '',
    ai_automation_rule_id: definition.ai_automation_rule_id ?? null,
    nodes: (stageMode === 'dag' ? definition.nodes : []).map(node => ({
      ...node,
      status: node.depends_on.length === 0 ? 'ready' : 'blocked',
      task_binding_id: null,
      task_ids: [],
      task_statuses: {},
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
  executionStatus: RuntimeWorkflowStatus,
  runtimeTaskId?: string,
  stageTaskIds: string[] = []
): IssueWorkflowInstance {
  const nodes = releaseReadyNodes(
    workflow.nodes.map(node => {
      if (node.id !== workflowNodeId) return node
      const taskStatuses = {
        ...(node.task_statuses ?? {}),
        ...(runtimeTaskId ? { [runtimeTaskId]: executionStatus } : {}),
      }
      const knownTaskIds = Array.from(
        new Set([
          ...(node.task_ids ?? []),
          ...stageTaskIds,
          ...(runtimeTaskId ? [runtimeTaskId] : []),
        ])
      )
      const allCompleted =
        knownTaskIds.length > 0 &&
        knownTaskIds.every(taskId => ['succeeded', 'archived'].includes(taskStatuses[taskId] ?? ''))
      const anyRunning = knownTaskIds.some(taskId => taskStatuses[taskId] === 'running')
      const anyFailed = knownTaskIds.some(taskId =>
        ['failed', 'cancelled'].includes(taskStatuses[taskId] ?? '')
      )
      const status =
        allCompleted || (!runtimeTaskId && executionStatus === 'succeeded')
          ? 'completed'
          : anyRunning || executionStatus === 'running'
            ? 'running'
            : anyFailed
              ? 'failed'
              : 'queued'
      return { ...node, status, task_ids: knownTaskIds, task_statuses: taskStatuses }
    })
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
