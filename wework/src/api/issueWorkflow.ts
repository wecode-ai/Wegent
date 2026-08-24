import type {
  CloudLoopItem,
  IssueWorkflowInstance,
  ProjectWorkflowDefinition,
  WorkflowNodeInstance,
} from './deliveries'

type RuntimeWorkflowStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'archived'
export type WorkflowDecisionAction = 'approve' | 'reject' | 'force_advance'

export interface WorkflowTaskBinding {
  id?: number | string
  device_id: string
  task_id: string
  workflow_node_id?: string | null
  linked_at?: string
}

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
    approval_policy: definition.approval_policy ?? 'required',
    ai_automation_rule_id: definition.ai_automation_rule_id ?? null,
    orchestration_status: 'idle',
    active_run_id: null,
    active_plan_version: null,
    current_stage_id: null,
    nodes: (stageMode === 'dag' ? definition.nodes : []).map(node => ({
      ...node,
      status: node.depends_on.length === 0 ? 'ready' : 'blocked',
      task_binding_id: null,
      task_ids: [],
      task_statuses: {},
      delivery_ids: [],
      fulfilled_deliverable_ids: [],
      decision_history: [],
      execution_id: null,
    })),
  }
}

function releaseReadyNodes(nodes: WorkflowNodeInstance[]): WorkflowNodeInstance[] {
  const completed = new Set(
    nodes
      .filter(node => ['completed', 'forced_completed'].includes(node.status))
      .map(node => node.id)
  )
  return nodes.map(node => {
    if (node.status !== 'blocked') return node
    return node.depends_on.every(dependency => completed.has(dependency))
      ? { ...node, status: 'ready' }
      : node
  })
}

function projectWorkflowNodeTaskStatus(
  node: WorkflowNodeInstance,
  taskStatuses: Record<string, string>,
  orderedTaskIds: string[],
  fallbackStatus?: RuntimeWorkflowStatus
): WorkflowNodeInstance['status'] {
  if (['completed', 'forced_completed'].includes(node.status)) return node.status
  if (orderedTaskIds.some(taskId => taskStatuses[taskId] === 'running')) return 'running'
  const latestStatus = orderedTaskIds[0] ? taskStatuses[orderedTaskIds[0]] : fallbackStatus
  if (latestStatus === 'running') return 'running'
  if (['succeeded', 'archived'].includes(latestStatus ?? '')) {
    if (!node.automation_rule_id) return 'awaiting_approval'
    const fulfilled = new Set(node.fulfilled_deliverable_ids ?? [])
    return (node.required_deliverables ?? []).every(requirement => fulfilled.has(requirement.id))
      ? 'completed'
      : 'awaiting_deliverables'
  }
  if (['failed', 'cancelled'].includes(latestStatus ?? '')) return 'failed'
  return node.status
}

export function reconcileIssueWorkflowForTaskBindings(
  workflow: IssueWorkflowInstance,
  bindings: WorkflowTaskBinding[]
): IssueWorkflowInstance {
  const orderedBindings = [...bindings].sort((left, right) => {
    const timeOrder = (right.linked_at ?? '').localeCompare(left.linked_at ?? '')
    if (timeOrder !== 0) return timeOrder
    return String(right.id ?? '').localeCompare(String(left.id ?? ''), undefined, {
      numeric: true,
    })
  })
  let changed = false
  const nodes = workflow.nodes.map(node => {
    const stageTaskIds = orderedBindings
      .filter(binding => binding.workflow_node_id === node.id)
      .map(binding => `${binding.device_id}:${binding.task_id}`)
    const knownTaskIds = Array.from(new Set([...stageTaskIds, ...(node.task_ids ?? [])]))
    const taskStatuses = node.task_statuses ?? {}
    if (knownTaskIds.every(taskId => taskStatuses[taskId] === undefined)) return node
    const status = projectWorkflowNodeTaskStatus(node, taskStatuses, knownTaskIds)
    if (
      status === node.status &&
      knownTaskIds.length === (node.task_ids?.length ?? 0) &&
      knownTaskIds.every((taskId, index) => taskId === node.task_ids?.[index])
    ) {
      return node
    }
    changed = true
    return { ...node, status, task_ids: knownTaskIds }
  })
  return changed ? { ...workflow, nodes } : workflow
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
          ...stageTaskIds,
          ...(node.task_ids ?? []),
          ...(runtimeTaskId ? [runtimeTaskId] : []),
        ])
      )
      const orderedTaskIds = Array.from(
        new Set([
          ...(stageTaskIds.length > 0 ? stageTaskIds : runtimeTaskId ? [runtimeTaskId] : []),
          ...knownTaskIds,
        ])
      )
      const status = projectWorkflowNodeTaskStatus(
        node,
        taskStatuses,
        orderedTaskIds,
        executionStatus
      )
      return { ...node, status, task_ids: knownTaskIds, task_statuses: taskStatuses }
    })
  )
  return { ...workflow, version: workflow.version + 1, nodes }
}

export function workflowBoardStatus(workflow: IssueWorkflowInstance): CloudLoopItem['status'] {
  const required = workflow.nodes.filter(node => node.required)
  if (
    required.length > 0 &&
    required.every(node => ['completed', 'forced_completed'].includes(node.status))
  ) {
    return 'in_review'
  }
  if (workflow.nodes.some(node => ['running', 'changes_requested'].includes(node.status))) {
    return 'in_progress'
  }
  return 'pending'
}

export function decideIssueWorkflowNode(
  workflow: IssueWorkflowInstance,
  workflowNodeId: string,
  action: WorkflowDecisionAction,
  actorUserId: number,
  reason: string
): IssueWorkflowInstance {
  const normalizedReason = reason.trim()
  const nodes = releaseReadyNodes(
    workflow.nodes.map(node => {
      if (node.id !== workflowNodeId) return node
      if (node.automation_rule_id) throw new Error('Automated stages do not accept decisions')
      if (action === 'approve') {
        if (node.status !== 'awaiting_approval') throw new Error('Stage is not awaiting approval')
        const fulfilled = new Set(node.fulfilled_deliverable_ids ?? [])
        if (
          (node.required_deliverables ?? []).some(requirement => !fulfilled.has(requirement.id))
        ) {
          throw new Error('Required deliverables are missing')
        }
      } else if (action === 'reject') {
        if (node.status !== 'awaiting_approval') throw new Error('Stage is not awaiting approval')
        if (!normalizedReason) throw new Error('Rejection requires a reason')
      } else {
        if (['blocked', 'completed', 'forced_completed'].includes(node.status)) {
          throw new Error('Stage cannot be force-advanced')
        }
        if (!normalizedReason) throw new Error('Force advancement requires a reason')
      }
      return {
        ...node,
        status:
          action === 'approve'
            ? ('completed' as const)
            : action === 'reject'
              ? ('changes_requested' as const)
              : ('forced_completed' as const),
        decision_history: [
          ...(node.decision_history ?? []),
          {
            action,
            actor_user_id: actorUserId,
            reason: normalizedReason,
            decided_at: new Date().toISOString(),
          },
        ],
      }
    })
  )
  return { ...workflow, version: workflow.version + 1, nodes }
}

export function attachIssueWorkflowDelivery(
  workflow: IssueWorkflowInstance,
  workflowNodeId: string,
  deliveryId: string,
  fulfilledDeliverableIds: string[] = []
): IssueWorkflowInstance {
  const nodes = workflow.nodes.map(node => {
    if (node.id !== workflowNodeId) return node
    const fulfilled = Array.from(
      new Set([...(node.fulfilled_deliverable_ids ?? []), ...fulfilledDeliverableIds])
    )
    const allRequiredFulfilled = (node.required_deliverables ?? []).every(requirement =>
      fulfilled.includes(requirement.id)
    )
    return {
      ...node,
      delivery_ids: Array.from(new Set([...(node.delivery_ids ?? []), deliveryId])),
      fulfilled_deliverable_ids: fulfilled,
      status:
        node.automation_rule_id && node.status === 'awaiting_deliverables' && allRequiredFulfilled
          ? ('completed' as const)
          : node.status,
    }
  })
  return {
    ...workflow,
    version: workflow.version + 1,
    nodes: releaseReadyNodes(nodes),
  }
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
