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
  ChevronRight,
  FastForward,
  Play,
  Plus,
  Upload,
  UserRound,
  XCircle,
} from 'lucide-react'
import type { WorkflowNodeInstance } from '@/api/deliveries'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { layoutWorkflowGraph } from './workflowGraph'

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
  onCreateTask?: (stageId: string) => void
  onRunAutomation?: (stageId: string, automationRuleId: string) => void
  onOpenTask?: (task: WorkflowTaskBinding) => void
  onUploadDeliverables?: (stageId: string, files: File[]) => Promise<void>
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
  onOpenTask?: (task: WorkflowTaskBinding) => void
}

type RuntimeStageFlowNode = Node<RuntimeStageNodeData, 'runtimeStage'>

const NODE_WIDTH = 228
const NODE_HEIGHT = 180
const CURRENT_STAGE_STATUS_PRIORITY: WorkflowNodeInstance['status'][] = [
  'running',
  'awaiting_approval',
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
  if (status === 'changes_requested') return t('todo.workflow_node_changes_requested')
  if (status === 'completed') return t('todo.workflow_node_completed')
  if (status === 'forced_completed') return t('todo.workflow_node_forced_completed')
  return t('todo.workflow_node_failed')
}

const RuntimeStageNodeCard = memo(function RuntimeStageNodeCard({
  data,
}: NodeProps<RuntimeStageFlowNode>) {
  const { t } = useTranslation('common')
  const { stage, tasks } = data
  const statusLabel = workflowNodeStatusLabel(t, stage.status)

  return (
    <article
      data-testid={`cloud-todo-workflow-node-${stage.id}`}
      className="relative flex h-[180px] w-[228px] flex-col rounded-xl border border-border bg-background p-3 shadow-sm"
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
            {stage.status === 'blocked'
              ? t('todo.workflow_wait_dependencies', '等待前置阶段')
              : t('todo.workflow_no_stage_tasks', '尚无具体任务')}
          </p>
        ) : null}
      </div>
      <Handle type="source" position={Position.Right} className="!invisible" />
    </article>
  )
})

const nodeTypes = { runtimeStage: RuntimeStageNodeCard }

export function IssueWorkflowDag({
  nodes,
  tasks,
  onCreateTask,
  onRunAutomation,
  onOpenTask,
  onUploadDeliverables,
  onDecide,
}: IssueWorkflowDagProps) {
  const { t } = useTranslation('common')
  const [decisionDraft, setDecisionDraft] = useState<{
    stageId: string
    action: 'reject' | 'force_advance'
    reason: string
  } | null>(null)
  const [busyStageId, setBusyStageId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const flowInstanceRef = useRef<ReactFlowInstance<RuntimeStageFlowNode, Edge> | null>(null)
  const currentStageId = useMemo(() => getCurrentWorkflowNodeId(nodes), [nodes])
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
        onOpenTask,
      },
    }))
    return {
      edges,
      nodes: layoutWorkflowGraph(flowNodes, edges, {
        nodeWidth: NODE_WIDTH,
        nodeHeight: NODE_HEIGHT,
      }) as RuntimeStageFlowNode[],
    }
  }, [nodes, onOpenTask, tasks])
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
      ? ['ready', 'failed'].includes(stage.status) && Boolean(onRunAutomation)
      : ['ready', 'queued', 'running', 'awaiting_approval', 'changes_requested', 'failed'].includes(
          stage.status
        ) && Boolean(onCreateTask || onDecide)
  )

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

  return (
    <>
      {actionableStages.length > 0 ? (
        <section
          data-testid="cloud-todo-workflow-actions"
          className="mt-2 rounded-xl border border-border bg-background p-3"
        >
          <h4 className="text-xs font-medium text-text-muted">{t('todo.workflow_next_actions')}</h4>
          <div className="mt-2 space-y-2">
            {actionableStages.map(stage => {
              const stageTasks = tasks.filter(task => task.workflow_node_id === stage.id)
              const automated = Boolean(stage.automation_rule_id)
              const startHumanStage = stageTasks.length === 0 && stage.status === 'ready'
              const awaitingApproval = stage.status === 'awaiting_approval'
              const missingDeliverables =
                (stage.required_deliverables?.length ?? 0) > 0 &&
                (stage.delivery_ids?.length ?? 0) === 0
              const actionLabel = automated
                ? t('todo.workflow_run')
                : startHumanStage
                  ? t('todo.workflow_start_work')
                  : t('todo.workflow_add_stage_task')
              return (
                <div
                  key={stage.id}
                  data-testid={`cloud-todo-workflow-action-${stage.id}`}
                  className="rounded-lg"
                >
                  <button
                    type="button"
                    data-testid={
                      automated
                        ? `cloud-todo-run-workflow-node-${stage.id}`
                        : `cloud-todo-create-workflow-task-${stage.id}`
                    }
                    onClick={() =>
                      automated
                        ? onRunAutomation?.(stage.id, stage.automation_rule_id!)
                        : awaitingApproval
                          ? undefined
                          : onCreateTask?.(stage.id)
                    }
                    className="group flex w-full items-center gap-3 rounded-lg bg-muted/50 px-3 py-2 text-left transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-background text-text-secondary">
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
                    {!awaitingApproval ? (
                      <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-text-secondary transition group-hover:text-text-primary">
                        {automated || startHumanStage ? (
                          <Play className="h-3.5 w-3.5" />
                        ) : (
                          <Plus className="h-3.5 w-3.5" />
                        )}
                        {actionLabel}
                        <ChevronRight className="h-3.5 w-3.5" />
                      </span>
                    ) : null}
                  </button>
                  {!automated && (stage.required_deliverables?.length ?? 0) > 0 ? (
                    <div className="mt-2 rounded-lg bg-muted/40 px-3 py-2">
                      <p className="text-xs font-medium text-text-secondary">
                        {t('todo.workflow_required_deliverables')}
                      </p>
                      <ul className="mt-1 space-y-1 text-xs text-text-muted">
                        {stage.required_deliverables?.map(requirement => (
                          <li key={requirement}>· {requirement}</li>
                        ))}
                      </ul>
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <span className="text-xs text-text-muted">
                          {t('todo.workflow_deliveries_submitted', {
                            count: stage.delivery_ids?.length ?? 0,
                          })}
                        </span>
                        <label className="flex h-7 cursor-pointer items-center gap-1 rounded-lg px-2 text-xs font-medium text-text-secondary hover:bg-muted">
                          <Upload className="h-3.5 w-3.5" />
                          {t('todo.workflow_upload_deliverables')}
                          <input
                            type="file"
                            multiple
                            className="sr-only"
                            data-testid={`cloud-todo-upload-workflow-deliverables-${stage.id}`}
                            disabled={!stageTasks.length || busyStageId === stage.id}
                            onChange={event => {
                              const files = Array.from(event.target.files ?? [])
                              event.target.value = ''
                              if (!files.length || !onUploadDeliverables) return
                              setBusyStageId(stage.id)
                              setActionError(null)
                              void onUploadDeliverables(stage.id, files)
                                .catch(error =>
                                  setActionError(
                                    error instanceof Error
                                      ? error.message
                                      : t('todo.workflow_action_failed')
                                  )
                                )
                                .finally(() => setBusyStageId(null))
                            }}
                          />
                        </label>
                      </div>
                    </div>
                  ) : null}
                  {!automated && onDecide ? (
                    <div className="mt-2 flex flex-wrap justify-end gap-1.5">
                      {awaitingApproval ? (
                        <>
                          <button
                            type="button"
                            data-testid={`cloud-todo-approve-workflow-node-${stage.id}`}
                            disabled={busyStageId === stage.id || missingDeliverables}
                            onClick={() => void decide(stage.id, 'approve')}
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
                      {!['blocked', 'completed', 'forced_completed'].includes(stage.status) ? (
                        <button
                          type="button"
                          onClick={() =>
                            setDecisionDraft({
                              stageId: stage.id,
                              action: 'force_advance',
                              reason: '',
                            })
                          }
                          className="flex h-7 items-center gap-1 rounded-lg px-2 text-xs text-text-muted hover:bg-muted hover:text-text-primary"
                        >
                          <FastForward className="h-3.5 w-3.5" />
                          {t('todo.workflow_force_advance')}
                        </button>
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
                </div>
              )
            })}
          </div>
          {actionError ? <p className="mt-2 text-xs text-destructive">{actionError}</p> : null}
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
    </>
  )
}
