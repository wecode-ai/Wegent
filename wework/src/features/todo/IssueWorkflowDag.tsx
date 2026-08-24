import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react'
import {
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  FastForward,
  Hourglass,
  Play,
  Plus,
  RefreshCw,
  UserRound,
  XCircle,
} from 'lucide-react'
import type { TFunction } from 'i18next'
import type { Delivery, WorkflowNodeInstance } from '@/api/deliveries'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { layoutWorkflowGraph } from './workflowGraph'
import {
  WorkflowStageCompletionDialog,
  type WorkflowDeliverableDraft,
} from './WorkflowStageCompletionDialog'
import { workflowDeliverableTypeLabel } from './workflowDeliverables'

interface WorkflowTaskBinding {
  id: number
  device_id: string
  task_id: string
  task_title: string | null
  workflow_node_id?: string | null
}

interface IssueWorkflowDagProps {
  nodes: WorkflowNodeInstance[]
  tasks: WorkflowTaskBinding[]
  deliveries?: Delivery[]
  selectedTaskId?: string | null
  onCreateTask?: (stageId: string) => void
  onRunAutomation?: (stageId: string, automationRuleId: string) => void | Promise<void>
  onOpenTask?: (task: WorkflowTaskBinding) => void
  onOpenDelivery?: (delivery: Delivery) => void
  onCompleteStage?: (
    stageId: string,
    action: 'submit' | 'approve' | 'force_advance',
    reason: string,
    values: WorkflowDeliverableDraft[]
  ) => Promise<void>
  onDecide?: (
    stageId: string,
    action: 'approve' | 'reject' | 'force_advance',
    reason: string
  ) => Promise<void>
}

interface RuntimeNodeData extends Record<string, unknown> {
  stage: WorkflowNodeInstance
  tasks: WorkflowTaskBinding[]
  selected: boolean
  onSelect: (stageId: string) => void
  nodeWidth: number
  nodeHeight: number
  onOpenTask?: (task: WorkflowTaskBinding) => void
}

type RuntimeFlowNode = Node<RuntimeNodeData>

const NODE_WIDTH = 208
const NODE_HEIGHT = 112
const WAIT_NODE_WIDTH = 228
const WAIT_NODE_HEIGHT = 180
const CURRENT_STAGE_STATUS_PRIORITY: WorkflowNodeInstance['status'][] = [
  'running',
  'waiting',
  'awaiting_approval',
  'awaiting_deliverables',
  'changes_requested',
  'failed',
  'queued',
  'ready',
]
const CURRENT_STAGE_FIT_VIEW_OPTIONS = {
  padding: 0.25,
  maxZoom: 1,
} as const

function getCurrentWorkflowNodeId(nodes: WorkflowNodeInstance[]): string | null {
  for (const status of CURRENT_STAGE_STATUS_PRIORITY) {
    const currentNode = nodes.find(node => node.status === status)
    if (currentNode) return currentNode.id
  }

  const lastCompletedNode = nodes.findLast(node =>
    ['completed', 'forced_completed'].includes(node.status)
  )
  return lastCompletedNode?.id ?? nodes[0]?.id ?? null
}

function workflowNodeStatusLabel(
  t: (key: string) => string,
  status: WorkflowNodeInstance['status']
): string {
  if (status === 'blocked') return t('todo.workflow_node_blocked')
  if (status === 'ready') return t('todo.workflow_node_ready')
  if (status === 'queued') return t('todo.workflow_node_queued')
  if (status === 'running') return t('todo.workflow_node_running')
  if (status === 'waiting') return t('todo.workflow_node_waiting')
  if (status === 'awaiting_approval') return t('todo.workflow_node_awaiting_approval')
  if (status === 'awaiting_deliverables') return t('todo.workflow_node_awaiting_deliverables')
  if (status === 'changes_requested') return t('todo.workflow_node_changes_requested')
  if (status === 'completed') return t('todo.workflow_node_completed')
  if (status === 'forced_completed') return t('todo.workflow_node_forced_completed')
  return t('todo.workflow_node_failed')
}

function workflowTaskStatusLabel(t: (key: string) => string, status?: string): string {
  if (status === 'running') return t('todo.workflow_task_status_running')
  if (status === 'succeeded') return t('todo.workflow_task_status_succeeded')
  if (status === 'failed') return t('todo.workflow_task_status_failed')
  if (status === 'cancelled') return t('todo.workflow_task_status_cancelled')
  if (status === 'archived') return t('todo.workflow_task_status_archived')
  return t('todo.workflow_task_status_pending')
}

function workflowWaitRepairLabel(t: TFunction, stage: WorkflowNodeInstance): string | null {
  const round = stage.wait_round ?? 0
  if (round <= 0) return null
  const status = stage.repair_status
  if (status === 'queued') {
    return t('todo.workflow_wait_repair_queued', '第 {{round}} 轮修复排队中', { round })
  }
  if (status === 'failed') {
    return t('todo.workflow_wait_repair_failed', '第 {{round}} 轮修复失败', { round })
  }
  if (status === 'succeeded') {
    return t('todo.workflow_wait_repair_succeeded', '第 {{round}} 轮修复完成', { round })
  }
  if (status === 'cancelled') {
    return t('todo.workflow_wait_repair_cancelled', '第 {{round}} 轮修复已取消', { round })
  }
  return t('todo.workflow_wait_round', '等待中 · 第 {{round}} 轮修复中', { round })
}

function isWorkflowNodeCompleted(status: WorkflowNodeInstance['status']): boolean {
  return status === 'completed' || status === 'forced_completed'
}

function requirementDelivery(
  stage: WorkflowNodeInstance,
  requirementId: string,
  deliveries: Delivery[]
): Delivery | undefined {
  const stageDeliveryIds = new Set(stage.delivery_ids ?? [])
  return deliveries.find(
    delivery =>
      delivery.status === 'delivered' &&
      stageDeliveryIds.has(delivery.id) &&
      delivery.fulfillments.some(fulfillment => fulfillment.requirement_id === requirementId)
  )
}

const RuntimeStageNodeCard = memo(function RuntimeStageNodeCard({
  data,
}: NodeProps<RuntimeFlowNode>) {
  const { t } = useTranslation('common')
  const { stage, tasks, selected, onSelect } = data
  const statusLabel = workflowNodeStatusLabel(t, stage.status)

  return (
    <article
      data-testid={`cloud-todo-workflow-node-${stage.id}`}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={() => onSelect(stage.id)}
      onKeyDown={event => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onSelect(stage.id)
      }}
      className={cn(
        'issue-workflow-node relative flex h-[112px] w-[208px] cursor-pointer flex-col',
        selected && 'is-selected'
      )}
    >
      <Handle type="target" position={Position.Left} className="!invisible" />
      <header className="min-w-0">
        <span className="block truncate text-sm font-medium text-text-primary">{stage.name}</span>
        <span className="issue-workflow-node-kind">
          {stage.automation_rule_id ? (
            <Bot className="h-3.5 w-3.5" />
          ) : (
            <UserRound className="h-3.5 w-3.5" />
          )}
          {stage.automation_rule_id
            ? t('todo.workflow_ai_execution')
            : t('todo.workflow_stage_human_execution')}
        </span>
      </header>
      <footer className="issue-workflow-node-footer">
        <span className={cn('issue-workflow-status', `is-${stage.status.replaceAll('_', '-')}`)}>
          {isWorkflowNodeCompleted(stage.status) ? <Check className="h-3 w-3" /> : null}
          {statusLabel}
        </span>
        <span className="ml-auto">{t('todo.workflow_task_count', { count: tasks.length })}</span>
      </footer>
      <Handle type="source" position={Position.Right} className="!invisible" />
    </article>
  )
})

const RuntimeWaitNodeCard = memo(function RuntimeWaitNodeCard({
  data,
}: NodeProps<RuntimeFlowNode>) {
  const { t } = useTranslation('common')
  const { stage, tasks } = data
  const statusLabel = workflowNodeStatusLabel(t, stage.status)
  const waitingEvents = Array.from(
    new Set((stage.wait_config?.rules ?? []).map(rule => rule.event_type.trim()).filter(Boolean))
  )
  const waiting = stage.status === 'waiting'
  const completed = ['completed', 'forced_completed'].includes(stage.status)

  return (
    <article
      data-testid={`cloud-todo-workflow-node-${stage.id}`}
      className="relative flex h-[180px] w-[228px] flex-col rounded-xl border border-dashed border-text-muted/70 bg-background p-3 shadow-sm"
    >
      <Handle type="target" position={Position.Left} className="!invisible" />
      <header className="flex items-start gap-2">
        <span
          className={cn(
            'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-dashed text-xs',
            completed
              ? 'border-green-500/40 bg-green-500/10 text-green-600'
              : waiting
                ? 'border-blue-500/40 bg-blue-500/10 text-blue-500'
                : 'border-border text-text-muted'
          )}
        >
          {completed ? <Check className="h-3.5 w-3.5" /> : <Hourglass className="h-3.5 w-3.5" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-text-primary">{stage.name}</span>
          <span className="block text-xs text-text-muted">{statusLabel}</span>
        </span>
      </header>
      <p className="mt-1 line-clamp-1 text-xs text-text-secondary">
        {waitingEvents.length
          ? t('todo.workflow_wait_event_types', '等待：{{types}}', {
              types: waitingEvents.join(' / '),
            })
          : ''}
      </p>
      {waiting && (stage.wait_round ?? 0) > 0 ? (
        <p className="mt-1 text-xs font-medium text-text-primary">
          {workflowWaitRepairLabel(t, stage)}
        </p>
      ) : null}
      <div className="mt-2 min-h-0 flex-1 space-y-1 overflow-hidden">
        {tasks.slice(0, 2).map(task => (
          <button
            key={task.id}
            type="button"
            data-testid={`cloud-todo-open-workflow-task-${stage.id}-${task.id}`}
            onClick={() => data.onOpenTask?.(task)}
            className="nodrag flex h-7 w-full items-center gap-1.5 rounded-md bg-muted/60 px-2 text-left text-xs text-text-secondary hover:bg-muted hover:text-text-primary"
          >
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-text-muted" />
            <span className="min-w-0 flex-1 truncate">{task.task_title || task.task_id}</span>
            <ChevronRight className="h-3 w-3 shrink-0" />
          </button>
        ))}
        {tasks.length > 2 ? (
          <p className="px-2 text-xs text-text-muted">
            {t('todo.workflow_more_tasks', '另有 {{count}} 个任务', {
              count: tasks.length - 2,
            })}
          </p>
        ) : null}
        {tasks.length === 0 ? (
          <p className="px-2 py-1 text-xs text-text-muted">
            {t('todo.workflow_no_stage_tasks', '尚无具体任务')}
          </p>
        ) : null}
      </div>
      <Handle type="source" position={Position.Right} className="!invisible" />
    </article>
  )
})

const nodeTypes = {
  runtimeStage: RuntimeStageNodeCard,
  runtimeWait: RuntimeWaitNodeCard,
}

function runtimeNodeType(node: WorkflowNodeInstance): string {
  if (node.node_type === 'wait') return 'runtimeWait'
  return 'runtimeStage'
}

export function IssueWorkflowDag({
  nodes,
  tasks,
  deliveries = [],
  selectedTaskId,
  onCreateTask,
  onRunAutomation,
  onOpenTask,
  onOpenDelivery,
  onCompleteStage,
  onDecide,
}: IssueWorkflowDagProps) {
  const { t } = useTranslation('common')
  const [decisionDraft, setDecisionDraft] = useState<{
    stageId: string
    action: 'reject'
    reason: string
  } | null>(null)
  const [completionDraft, setCompletionDraft] = useState<{
    stageId: string
    action: 'submit' | 'approve' | 'force_advance'
    reason: string
    values: Record<string, WorkflowDeliverableDraft>
  } | null>(null)
  const [busyStageId, setBusyStageId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [graphInteractionActive, setGraphInteractionActive] = useState(false)
  const [stageSelection, setStageSelection] = useState<{
    stageId: string
    currentStageId: string | null
  } | null>(null)
  const graphContainerRef = useRef<HTMLDivElement | null>(null)
  const flowInstanceRef = useRef<ReactFlowInstance<RuntimeFlowNode, Edge> | null>(null)
  const currentStageId = useMemo(() => getCurrentWorkflowNodeId(nodes), [nodes])
  const effectiveSelectedStageId =
    stageSelection?.currentStageId === currentStageId &&
    nodes.some(stage => stage.id === stageSelection.stageId)
      ? stageSelection.stageId
      : currentStageId
  const selectedStage = effectiveSelectedStageId
    ? nodes.find(stage => stage.id === effectiveSelectedStageId)
    : undefined
  const graph = useMemo(() => {
    const nodesById = new Map(nodes.map(node => [node.id, node]))
    const edges: Edge[] = nodes.flatMap(node =>
      node.depends_on.map(dependency => {
        const completed = isWorkflowNodeCompleted(nodesById.get(dependency)?.status ?? 'blocked')
        const color = completed ? 'rgb(0 162 64 / 0.55)' : 'rgb(var(--color-text-muted) / 0.45)'
        return {
          id: `${dependency}-${node.id}`,
          source: dependency,
          target: node.id,
          markerEnd: { type: MarkerType.ArrowClosed, color },
          style: { stroke: color, strokeWidth: 1.5 },
        }
      })
    )
    const flowNodes: RuntimeFlowNode[] = nodes.map(stage => {
      const isWait = stage.node_type === 'wait'
      return {
        id: stage.id,
        type: runtimeNodeType(stage),
        position: { x: 0, y: 0 },
        data: {
          stage,
          nodeWidth: isWait ? WAIT_NODE_WIDTH : NODE_WIDTH,
          nodeHeight: isWait ? WAIT_NODE_HEIGHT : NODE_HEIGHT,
          tasks: tasks.filter(task => task.workflow_node_id === stage.id),
          onOpenTask,
          selected: stage.id === effectiveSelectedStageId,
          onSelect: stageId => setStageSelection({ stageId, currentStageId }),
        },
      }
    })
    return {
      edges,
      nodes: layoutWorkflowGraph(flowNodes, edges, {
        nodeWidth: NODE_WIDTH,
        nodeHeight: NODE_HEIGHT,
      }) as RuntimeFlowNode[],
    }
  }, [currentStageId, effectiveSelectedStageId, nodes, onOpenTask, tasks])
  const focusCurrentStage = useCallback(
    (instance: ReactFlowInstance<RuntimeFlowNode, Edge>, duration = 0) => {
      void instance.fitView({
        ...CURRENT_STAGE_FIT_VIEW_OPTIONS,
        duration,
        nodes: currentStageId ? [{ id: currentStageId }] : undefined,
      })
    },
    [currentStageId]
  )

  useEffect(() => {
    if (!flowInstanceRef.current) return
    focusCurrentStage(flowInstanceRef.current, 300)
  }, [focusCurrentStage])

  useEffect(() => {
    const deactivateGraphInteraction = (event: PointerEvent) => {
      if (event.target instanceof Node && !graphContainerRef.current?.contains(event.target)) {
        setGraphInteractionActive(false)
      }
    }

    document.addEventListener('pointerdown', deactivateGraphInteraction)
    return () => document.removeEventListener('pointerdown', deactivateGraphInteraction)
  }, [])

  const detailStages = selectedStage ? [selectedStage] : []

  const decide = async (
    stageId: string,
    action: 'approve' | 'reject' | 'force_advance',
    reason = ''
  ) => {
    if (!onDecide) return
    setBusyStageId(stageId)
    setActionError(null)
    try {
      await onDecide(stageId, action, reason)
      setDecisionDraft(null)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t('todo.workflow_action_failed'))
    } finally {
      setBusyStageId(null)
    }
  }

  const completeStage = async () => {
    if (!completionDraft || !onCompleteStage) return
    setBusyStageId(completionDraft.stageId)
    setActionError(null)
    try {
      await onCompleteStage(
        completionDraft.stageId,
        completionDraft.action,
        completionDraft.reason,
        Object.values(completionDraft.values)
      )
      setCompletionDraft(null)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t('todo.workflow_action_failed'))
    } finally {
      setBusyStageId(null)
    }
  }

  const runAutomation = async (stageId: string, automationRuleId: string) => {
    if (!onRunAutomation || busyStageId) return
    setBusyStageId(stageId)
    setActionError(null)
    try {
      await onRunAutomation(stageId, automationRuleId)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t('todo.workflow_action_failed'))
    } finally {
      setBusyStageId(null)
    }
  }
  const completionStage = completionDraft
    ? nodes.find(stage => stage.id === completionDraft.stageId)
    : undefined
  const pendingCompletionRequirements = (completionStage?.required_deliverables ?? []).filter(
    requirement =>
      !(completionStage?.fulfilled_deliverable_ids ?? []).includes(requirement.id) &&
      (!completionStage || !requirementDelivery(completionStage, requirement.id, deliveries))
  )

  return (
    <>
      <div
        ref={graphContainerRef}
        data-testid="cloud-todo-workflow-dag"
        className="issue-workflow-dag"
        onPointerDownCapture={() => setGraphInteractionActive(true)}
      >
        <ReactFlow
          className="workflow-react-flow"
          nodes={graph.nodes}
          edges={graph.edges}
          nodeTypes={nodeTypes}
          onInit={instance => {
            flowInstanceRef.current = instance
            focusCurrentStage(instance)
          }}
          onNodeClick={(_, node) => setStageSelection({ stageId: node.id, currentStageId })}
          minZoom={0.35}
          maxZoom={1.5}
          preventScrolling={graphInteractionActive}
          zoomOnScroll={graphInteractionActive}
          zoomOnPinch={graphInteractionActive}
          zoomOnDoubleClick={graphInteractionActive}
          zoomActivationKeyCode={null}
          panOnDrag={graphInteractionActive}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={20} size={1} color="rgb(var(--color-border))" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      {detailStages.length > 0 ? (
        <section data-testid="cloud-todo-workflow-actions" className="issue-workflow-stage-panel">
          <div>
            {detailStages.map(stage => {
              const stageTasks = tasks.filter(task => task.workflow_node_id === stage.id)
              const automated = Boolean(stage.automation_rule_id)
              const startHumanStage = stageTasks.length === 0 && stage.status === 'ready'
              const awaitingApproval = stage.status === 'awaiting_approval'
              const canRunAutomation =
                automated && ['ready', 'failed'].includes(stage.status) && Boolean(onRunAutomation)
              const canSubmitDeliverables =
                automated && stage.status === 'awaiting_deliverables' && Boolean(onCompleteStage)
              const canCreateTask =
                !automated &&
                [
                  'ready',
                  'queued',
                  'running',
                  'awaiting_approval',
                  'changes_requested',
                  'failed',
                ].includes(stage.status) &&
                Boolean(onCreateTask)
              const requirements = stage.required_deliverables ?? []
              const fulfilledIds = new Set(stage.fulfilled_deliverable_ids ?? [])
              const requirementDeliveries = new Map(
                requirements.map(requirement => [
                  requirement.id,
                  requirementDelivery(stage, requirement.id, deliveries),
                ])
              )
              const fulfilledCount = requirements.filter(
                requirement =>
                  fulfilledIds.has(requirement.id) ||
                  Boolean(requirementDeliveries.get(requirement.id))
              ).length
              return (
                <article
                  key={stage.id}
                  data-testid={`cloud-todo-workflow-action-${stage.id}`}
                  className="issue-workflow-stage-content"
                >
                  <header className="issue-workflow-stage-header">
                    <span className="truncate text-sm font-medium text-text-primary">
                      {stage.name}
                    </span>
                    <span
                      className={cn(
                        'issue-workflow-status',
                        `is-${stage.status.replaceAll('_', '-')}`
                      )}
                    >
                      {isWorkflowNodeCompleted(stage.status) ? <Check className="h-3 w-3" /> : null}
                      {workflowNodeStatusLabel(t, stage.status)}
                    </span>
                    <span className="issue-workflow-stage-kind">
                      {automated ? (
                        <Bot className="h-3.5 w-3.5" />
                      ) : (
                        <UserRound className="h-3.5 w-3.5" />
                      )}
                      {automated
                        ? t('todo.workflow_ai_execution')
                        : t('todo.workflow_stage_human_execution')}
                    </span>
                  </header>
                  <div className="issue-workflow-stage-actions">
                    {canSubmitDeliverables ? (
                      <button
                        type="button"
                        data-testid={`cloud-todo-submit-workflow-deliverables-${stage.id}`}
                        onClick={() =>
                          setCompletionDraft({
                            stageId: stage.id,
                            action: 'submit',
                            reason: '',
                            values: {},
                          })
                        }
                        className="issue-workflow-secondary-action"
                      >
                        <Check className="h-3.5 w-3.5" />
                        {t('todo.workflow_submit_deliverables', '补充交付物')}
                      </button>
                    ) : null}
                    {canRunAutomation ? (
                      <button
                        type="button"
                        data-testid={`cloud-todo-run-workflow-node-${stage.id}`}
                        disabled={busyStageId !== null}
                        onClick={() => void runAutomation(stage.id, stage.automation_rule_id!)}
                        className="issue-workflow-secondary-action"
                      >
                        {busyStageId === stage.id ? (
                          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                        ) : stage.status === 'failed' ? (
                          <RefreshCw className="h-3.5 w-3.5" />
                        ) : (
                          <Play className="h-3.5 w-3.5" />
                        )}
                        {stage.status === 'failed'
                          ? t('todo.workflow_run_again')
                          : t('todo.workflow_run')}
                      </button>
                    ) : null}
                    {awaitingApproval && onDecide ? (
                      <>
                        <button
                          type="button"
                          data-testid={`cloud-todo-approve-workflow-node-${stage.id}`}
                          disabled={busyStageId === stage.id}
                          onClick={() => {
                            if (fulfilledCount === requirements.length) {
                              void decide(stage.id, 'approve')
                              return
                            }
                            setCompletionDraft({
                              stageId: stage.id,
                              action: 'approve',
                              reason: '',
                              values: {},
                            })
                          }}
                          className="issue-workflow-secondary-action is-approve"
                        >
                          <Check className="h-3.5 w-3.5" />
                          {t('todo.workflow_approve_stage')}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setDecisionDraft({ stageId: stage.id, action: 'reject', reason: '' })
                          }
                          className="issue-workflow-secondary-action is-reject"
                        >
                          <XCircle className="h-3.5 w-3.5" />
                          {t('todo.workflow_reject_stage')}
                        </button>
                      </>
                    ) : null}
                    {!automated &&
                    onDecide &&
                    !['blocked', 'completed', 'forced_completed'].includes(stage.status) ? (
                      <button
                        type="button"
                        onClick={() =>
                          setCompletionDraft({
                            stageId: stage.id,
                            action: 'force_advance',
                            reason: '',
                            values: {},
                          })
                        }
                        className="issue-workflow-secondary-action"
                      >
                        <FastForward className="h-3.5 w-3.5" />
                        {t('todo.workflow_force_advance')}
                      </button>
                    ) : null}
                  </div>
                  {requirements.length > 0 ? (
                    <div className="issue-workflow-deliverables">
                      <div className="issue-workflow-deliverables-title">
                        <p>{t('todo.workflow_required_deliverables')}</p>
                        <span data-testid={`cloud-todo-workflow-deliverable-progress-${stage.id}`}>
                          {fulfilledCount}/{requirements.length}
                        </span>
                      </div>
                      <div>
                        {requirements.map(requirement => {
                          const delivery = requirementDeliveries.get(requirement.id)
                          const fulfilled = fulfilledIds.has(requirement.id) || Boolean(delivery)
                          const content = (
                            <>
                              {fulfilled ? (
                                <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" />
                              ) : (
                                <Circle className="h-4 w-4 shrink-0 text-text-muted" />
                              )}
                              <span className="min-w-0 flex-1 truncate">{requirement.name}</span>
                              <span className="shrink-0 text-text-muted">
                                {workflowDeliverableTypeLabel(requirement.value_type, t)}
                              </span>
                              <span
                                data-testid={`cloud-todo-workflow-deliverable-status-${stage.id}-${requirement.id}`}
                                className={cn(
                                  'shrink-0',
                                  fulfilled ? 'text-green-600' : 'text-text-muted'
                                )}
                              >
                                {fulfilled
                                  ? t('todo.workflow_deliverable_fulfilled')
                                  : t('todo.workflow_deliverable_missing')}
                              </span>
                              {delivery && onOpenDelivery ? (
                                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                              ) : null}
                            </>
                          )
                          return delivery && onOpenDelivery ? (
                            <button
                              key={requirement.id}
                              type="button"
                              data-testid={`cloud-todo-open-workflow-deliverable-${stage.id}-${requirement.id}`}
                              onClick={() => onOpenDelivery(delivery)}
                              className="issue-workflow-deliverable-row w-full text-left"
                            >
                              {content}
                            </button>
                          ) : (
                            <div key={requirement.id} className="issue-workflow-deliverable-row">
                              {content}
                            </div>
                          )
                        })}
                      </div>
                      {fulfilledCount < requirements.length ? (
                        <p className="issue-workflow-deliverables-missing">
                          {t('todo.workflow_deliverables_missing_count', {
                            count: requirements.length - fulfilledCount,
                          })}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                  {stageTasks.length > 0 ? (
                    <div
                      className="issue-workflow-stage-tasks"
                      data-testid={`cloud-todo-workflow-task-list-${stage.id}`}
                    >
                      {stageTasks.map(task => {
                        const taskStatus =
                          stage.task_statuses?.[`${task.device_id}:${task.task_id}`]
                        const successful = ['succeeded', 'archived'].includes(taskStatus ?? '')
                        const failed = ['failed', 'cancelled'].includes(taskStatus ?? '')
                        return (
                          <button
                            key={task.id}
                            type="button"
                            data-testid={`cloud-todo-open-workflow-task-${stage.id}-${task.id}`}
                            disabled={!onOpenTask}
                            onClick={() => onOpenTask?.(task)}
                            data-selected={selectedTaskId === task.task_id ? 'true' : 'false'}
                            className="issue-workflow-task-row"
                          >
                            <span
                              className={cn(
                                'issue-workflow-task-dot',
                                successful
                                  ? 'is-success'
                                  : failed
                                    ? 'is-failed'
                                    : taskStatus === 'running'
                                      ? 'is-running'
                                      : 'is-pending'
                              )}
                            />
                            <span className="issue-workflow-task-info">
                              <span className="issue-workflow-task-name">
                                {task.task_title || task.task_id}
                              </span>
                              <span
                                data-testid={`cloud-todo-workflow-task-status-${stage.id}-${task.id}`}
                                data-status={taskStatus ?? 'pending'}
                                className="issue-workflow-task-sub"
                              >
                                {task.device_id} · {workflowTaskStatusLabel(t, taskStatus)}
                              </span>
                            </span>
                            {onOpenTask ? (
                              <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-text-muted" />
                            ) : null}
                          </button>
                        )
                      })}
                    </div>
                  ) : (
                    <p className="issue-workflow-stage-empty">{t('todo.no_linked_task')}</p>
                  )}
                  {canCreateTask ? (
                    <button
                      type="button"
                      data-testid={`cloud-todo-create-workflow-task-${stage.id}`}
                      onClick={() => onCreateTask?.(stage.id)}
                      className="issue-workflow-add-stage-task"
                    >
                      {startHumanStage ? (
                        <Play className="h-3.5 w-3.5" />
                      ) : (
                        <Plus className="h-3.5 w-3.5" />
                      )}
                      {startHumanStage
                        ? t('todo.workflow_start_work')
                        : t('todo.workflow_add_stage_task')}
                    </button>
                  ) : null}
                  {decisionDraft?.stageId === stage.id ? (
                    <div className="issue-workflow-reject-box">
                      <textarea
                        autoFocus
                        value={decisionDraft.reason}
                        data-testid={`cloud-todo-workflow-decision-reason-${stage.id}`}
                        onChange={event =>
                          setDecisionDraft(current =>
                            current ? { ...current, reason: event.target.value } : current
                          )
                        }
                        placeholder={t('todo.workflow_decision_reason_placeholder')}
                        className="min-h-16 w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-blue-500"
                      />
                      <div className="mt-2 flex justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => setDecisionDraft(null)}
                          className="h-7 rounded-lg px-2 text-xs text-text-secondary hover:bg-muted"
                        >
                          {t('common.cancel')}
                        </button>
                        <button
                          type="button"
                          disabled={!decisionDraft.reason.trim() || busyStageId === stage.id}
                          onClick={() =>
                            void decide(stage.id, decisionDraft.action, decisionDraft.reason)
                          }
                          className="h-7 rounded-lg bg-text-primary px-2 text-xs font-medium text-background disabled:opacity-40"
                        >
                          {t('common.confirm')}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </article>
              )
            })}
          </div>
          {actionError ? <p className="px-3 pb-3 text-xs text-destructive">{actionError}</p> : null}
        </section>
      ) : null}
      {completionDraft ? (
        <WorkflowStageCompletionDialog
          stageName={completionStage?.name ?? completionDraft.stageId}
          requirements={pendingCompletionRequirements}
          action={completionDraft.action}
          busy={busyStageId === completionDraft.stageId}
          reason={completionDraft.reason}
          values={completionDraft.values}
          onReasonChange={reason =>
            setCompletionDraft(current => (current ? { ...current, reason } : current))
          }
          onValuesChange={values =>
            setCompletionDraft(current => (current ? { ...current, values } : current))
          }
          onClose={() => setCompletionDraft(null)}
          onSubmit={() => void completeStage()}
        />
      ) : null}
    </>
  )
}
