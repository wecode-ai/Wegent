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
  Play,
  Plus,
  RefreshCw,
  UserRound,
  XCircle,
} from 'lucide-react'
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
  onCreateTask?: (stageId: string) => void
  onRunAutomation?: (stageId: string, automationRuleId: string) => void
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

interface RuntimeStageNodeData extends Record<string, unknown> {
  stage: WorkflowNodeInstance
  index: number
  tasks: WorkflowTaskBinding[]
  selected: boolean
  onSelect: (stageId: string) => void
}

type RuntimeStageFlowNode = Node<RuntimeStageNodeData, 'runtimeStage'>

const NODE_WIDTH = 208
const NODE_HEIGHT = 112
const CURRENT_STAGE_STATUS_PRIORITY: WorkflowNodeInstance['status'][] = [
  'running',
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
}: NodeProps<RuntimeStageFlowNode>) {
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
        'relative flex h-[112px] w-[208px] cursor-pointer flex-col rounded-xl border bg-background p-3 shadow-sm transition',
        selected
          ? 'border-blue-500/70 ring-1 ring-blue-500/20'
          : 'border-border hover:border-text-muted/50'
      )}
    >
      <Handle type="target" position={Position.Left} className="!invisible" />
      <header className="flex items-start gap-2">
        <span
          className={cn(
            'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs',
            stage.status === 'completed'
              ? 'border-green-500/40 bg-green-500/10 text-green-600'
              : stage.status === 'running'
                ? 'border-orange-500/40 bg-orange-500/10 text-orange-600'
                : 'border-border text-text-muted'
          )}
        >
          {stage.status === 'completed' ? '✓' : data.index + 1}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-text-primary">{stage.name}</span>
          <span className="block text-xs text-text-muted">{statusLabel}</span>
        </span>
      </header>
      <footer className="mt-auto flex items-center gap-1.5 text-xs text-text-muted">
        {tasks.length > 0 ? (
          <>
            <span>{t('todo.workflow_task_executions')}</span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-text-secondary">
              {tasks.length}
            </span>
          </>
        ) : stage.status === 'blocked' ? (
          t('todo.workflow_wait_dependencies')
        ) : (
          t('todo.workflow_no_stage_tasks')
        )}
      </footer>
      <Handle type="source" position={Position.Right} className="!invisible" />
    </article>
  )
})

const nodeTypes = { runtimeStage: RuntimeStageNodeCard }

export function IssueWorkflowDag({
  nodes,
  tasks,
  deliveries = [],
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
  const [selectedStageId, setSelectedStageId] = useState<string | null>(null)
  const flowInstanceRef = useRef<ReactFlowInstance<RuntimeStageFlowNode, Edge> | null>(null)
  const currentStageId = useMemo(() => getCurrentWorkflowNodeId(nodes), [nodes])
  const selectedStage = selectedStageId
    ? nodes.find(stage => stage.id === selectedStageId)
    : undefined
  const graph = useMemo(() => {
    const edges: Edge[] = nodes.flatMap(node =>
      node.depends_on.map(dependency => ({
        id: `${dependency}-${node.id}`,
        source: dependency,
        target: node.id,
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { stroke: 'rgb(var(--color-text-muted))', strokeWidth: 1.5 },
      }))
    )
    const flowNodes: RuntimeStageFlowNode[] = nodes.map((stage, index) => ({
      id: stage.id,
      type: 'runtimeStage',
      position: { x: 0, y: 0 },
      data: {
        stage,
        index,
        tasks: tasks.filter(task => task.workflow_node_id === stage.id),
        selected: stage.id === (selectedStageId ?? currentStageId),
        onSelect: setSelectedStageId,
      },
    }))
    return {
      edges,
      nodes: layoutWorkflowGraph(flowNodes, edges, {
        nodeWidth: NODE_WIDTH,
        nodeHeight: NODE_HEIGHT,
      }) as RuntimeStageFlowNode[],
    }
  }, [currentStageId, nodes, selectedStageId, tasks])
  const focusCurrentStage = useCallback(
    (instance: ReactFlowInstance<RuntimeStageFlowNode, Edge>, duration = 0) => {
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

  const actionableStages = nodes.filter(stage =>
    stage.automation_rule_id
      ? (['ready', 'failed'].includes(stage.status) && Boolean(onRunAutomation)) ||
        (stage.status === 'awaiting_deliverables' && Boolean(onCompleteStage))
      : ['ready', 'queued', 'running', 'awaiting_approval', 'changes_requested', 'failed'].includes(
          stage.status
        ) && Boolean(onCreateTask || onDecide || onCompleteStage)
  )
  const detailStages = selectedStage ? [selectedStage] : actionableStages

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
      {detailStages.length > 0 ? (
        <section
          data-testid="cloud-todo-workflow-actions"
          className="mt-2 overflow-hidden rounded-xl border border-border bg-background"
        >
          <h4 className="border-b border-border px-3 py-2.5 text-xs font-medium text-text-muted">
            {selectedStage ? t('todo.workflow_node_details') : t('todo.workflow_active_stages')}
          </h4>
          <div className="divide-y divide-border">
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
                  className="p-3"
                >
                  <header className="flex flex-wrap items-center gap-2">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center text-text-secondary">
                      {automated ? <Bot className="h-4 w-4" /> : <UserRound className="h-4 w-4" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-text-primary">
                        {stage.name}
                      </span>
                      <span className="block text-xs text-text-muted">
                        {automated
                          ? t('todo.workflow_ai_execution')
                          : t('todo.workflow_stage_human_execution')}
                        {' · '}
                        {workflowNodeStatusLabel(t, stage.status)}
                      </span>
                    </span>
                    <span className="ml-auto flex flex-wrap items-center justify-end gap-1">
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
                          className="flex h-7 items-center gap-1 rounded-lg bg-text-primary px-2 text-xs font-medium text-background"
                        >
                          <Check className="h-3.5 w-3.5" />
                          {t('todo.workflow_submit_deliverables', '补充交付物')}
                        </button>
                      ) : canRunAutomation ? (
                        <button
                          type="button"
                          data-testid={`cloud-todo-run-workflow-node-${stage.id}`}
                          onClick={() => onRunAutomation?.(stage.id, stage.automation_rule_id!)}
                          className="flex h-7 items-center gap-1 rounded-lg px-2 text-xs font-medium text-text-secondary hover:bg-muted hover:text-text-primary"
                        >
                          {stage.status === 'failed' ? (
                            <RefreshCw className="h-3.5 w-3.5" />
                          ) : (
                            <Play className="h-3.5 w-3.5" />
                          )}
                          {stage.status === 'failed'
                            ? t('todo.workflow_run_again')
                            : t('todo.workflow_run')}
                        </button>
                      ) : canCreateTask ? (
                        <button
                          type="button"
                          data-testid={`cloud-todo-create-workflow-task-${stage.id}`}
                          onClick={() => onCreateTask?.(stage.id)}
                          className="flex h-7 items-center gap-1 rounded-lg px-2 text-xs font-medium text-text-secondary hover:bg-muted hover:text-text-primary"
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
                          className="flex h-7 items-center gap-1 rounded-lg px-2 text-xs text-text-muted hover:bg-muted hover:text-text-primary"
                        >
                          <FastForward className="h-3.5 w-3.5" />
                          {t('todo.workflow_force_advance')}
                        </button>
                      ) : null}
                    </span>
                  </header>
                  {stageTasks.length > 0 ? (
                    <div className="mt-3" data-testid={`cloud-todo-workflow-task-list-${stage.id}`}>
                      <div className="flex items-center gap-1.5 px-1 text-xs text-text-muted">
                        <span>{t('todo.workflow_task_executions')}</span>
                        <span>{stageTasks.length}</span>
                      </div>
                      <div className="mt-1 max-h-40 divide-y divide-border overflow-y-auto border-y border-border">
                        {stageTasks.map((task, index) => {
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
                              className="group flex h-9 w-full items-center gap-2 px-1 text-left transition hover:bg-muted/50 disabled:cursor-default"
                            >
                              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-muted text-xs text-text-muted">
                                {stageTasks.length - index}
                              </span>
                              <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
                                {task.task_title || task.task_id}
                              </span>
                              <span
                                data-testid={`cloud-todo-workflow-task-status-${stage.id}-${task.id}`}
                                data-status={taskStatus ?? 'pending'}
                                className={cn(
                                  'flex shrink-0 items-center gap-1 text-xs',
                                  successful
                                    ? 'text-green-600'
                                    : failed
                                      ? 'text-destructive'
                                      : taskStatus === 'running'
                                        ? 'text-orange-600'
                                        : 'text-text-muted'
                                )}
                              >
                                <span className="h-1.5 w-1.5 rounded-full bg-current" />
                                {workflowTaskStatusLabel(t, taskStatus)}
                              </span>
                              {onOpenTask ? (
                                <span className="flex shrink-0 items-center gap-0.5 text-xs text-text-muted group-hover:text-text-primary">
                                  {t('todo.workflow_view_execution_short')}
                                  <ChevronRight className="h-3.5 w-3.5" />
                                </span>
                              ) : null}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  ) : null}
                  {requirements.length > 0 ? (
                    <div className="mt-2 overflow-hidden rounded-lg border border-border">
                      <div className="flex items-center justify-between bg-muted/40 px-3 py-2">
                        <p className="text-xs font-medium text-text-secondary">
                          {t('todo.workflow_required_deliverables')}
                        </p>
                        <span
                          data-testid={`cloud-todo-workflow-deliverable-progress-${stage.id}`}
                          className="text-xs text-text-muted"
                        >
                          {fulfilledCount}/{requirements.length}
                        </span>
                      </div>
                      <div className="divide-y divide-border">
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
                              <span className="min-w-0 flex-1 truncate text-xs text-text-primary">
                                {requirement.name}
                              </span>
                              <span className="shrink-0 text-xs text-text-muted">
                                {workflowDeliverableTypeLabel(requirement.value_type, t)}
                              </span>
                              <span
                                data-testid={`cloud-todo-workflow-deliverable-status-${stage.id}-${requirement.id}`}
                                className={cn(
                                  'shrink-0 text-xs',
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
                              className="flex min-h-10 w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted"
                            >
                              {content}
                            </button>
                          ) : (
                            <div
                              key={requirement.id}
                              className="flex min-h-10 items-center gap-2 px-3 py-1.5"
                            >
                              {content}
                            </div>
                          )
                        })}
                      </div>
                      {fulfilledCount < requirements.length ? (
                        <p className="border-t border-border px-3 py-2 text-xs text-text-muted">
                          {t('todo.workflow_deliverables_missing_count', {
                            count: requirements.length - fulfilledCount,
                          })}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                  {!automated && onDecide ? (
                    <div className="mt-2 flex flex-wrap justify-end gap-1.5">
                      {awaitingApproval ? (
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
                            className="flex h-7 items-center gap-1 rounded-lg bg-text-primary px-2 text-xs font-medium text-background disabled:opacity-40"
                          >
                            <Check className="h-3.5 w-3.5" />
                            {t('todo.workflow_approve_stage')}
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setDecisionDraft({ stageId: stage.id, action: 'reject', reason: '' })
                            }
                            className="flex h-7 items-center gap-1 rounded-lg px-2 text-xs text-text-secondary hover:bg-muted"
                          >
                            <XCircle className="h-3.5 w-3.5" />
                            {t('todo.workflow_reject_stage')}
                          </button>
                        </>
                      ) : null}
                    </div>
                  ) : null}
                  {decisionDraft?.stageId === stage.id ? (
                    <div className="mt-2 rounded-lg border border-border p-2">
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
          {actionError ? (
            <p className="border-t border-border px-3 py-2 text-xs text-destructive">
              {actionError}
            </p>
          ) : null}
        </section>
      ) : null}
      <div
        data-testid="cloud-todo-workflow-dag"
        className="mt-2 h-[300px] overflow-hidden rounded-xl border border-border bg-muted/20"
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
          onNodeClick={(_, node) => setSelectedStageId(node.id)}
          minZoom={0.35}
          maxZoom={1.5}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} size={1} color="rgb(var(--color-border))" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
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
