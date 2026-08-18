import { memo, useMemo } from 'react'
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
} from '@xyflow/react'
import { Bot, ChevronRight, Plus } from 'lucide-react'
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
}

interface RuntimeStageNodeData extends Record<string, unknown> {
  stage: WorkflowNodeInstance
  index: number
  tasks: WorkflowTaskBinding[]
  onCreateTask?: (stageId: string) => void
  onRunAutomation?: (stageId: string, automationRuleId: string) => void
  onOpenTask?: (task: WorkflowTaskBinding) => void
}

type RuntimeStageFlowNode = Node<RuntimeStageNodeData, 'runtimeStage'>

const NODE_WIDTH = 228
const NODE_HEIGHT = 180

const RuntimeStageNodeCard = memo(function RuntimeStageNodeCard({
  data,
}: NodeProps<RuntimeStageFlowNode>) {
  const { t } = useTranslation('common')
  const { stage, tasks } = data
  const canCreate =
    !stage.automation_rule_id &&
    ['ready', 'queued', 'running', 'failed'].includes(stage.status) &&
    data.onCreateTask
  const canRun =
    Boolean(stage.automation_rule_id) &&
    ['ready', 'failed'].includes(stage.status) &&
    data.onRunAutomation
  const statusLabel =
    stage.status === 'blocked'
      ? t('todo.workflow_node_blocked')
      : stage.status === 'ready'
        ? t('todo.workflow_node_ready')
        : stage.status === 'queued'
          ? t('todo.workflow_node_queued')
          : stage.status === 'running'
            ? t('todo.workflow_node_running')
            : stage.status === 'completed'
              ? t('todo.workflow_node_completed')
              : t('todo.workflow_node_failed')

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
      {canCreate ? (
        <button
          type="button"
          data-testid={`cloud-todo-create-workflow-task-${stage.id}`}
          onClick={() => data.onCreateTask?.(stage.id)}
          className="nodrag mt-2 flex h-7 items-center justify-center gap-1 rounded-lg bg-foreground px-2 text-xs text-background"
        >
          <Plus className="h-3.5 w-3.5" />
          {t('todo.create_task_tab')}
        </button>
      ) : canRun ? (
        <button
          type="button"
          data-testid={`cloud-todo-run-workflow-node-${stage.id}`}
          onClick={() => data.onRunAutomation?.(stage.id, stage.automation_rule_id!)}
          className="nodrag mt-2 flex h-7 items-center justify-center gap-1 rounded-lg bg-foreground px-2 text-xs text-background"
        >
          <Bot className="h-3.5 w-3.5" />
          {t('todo.workflow_run')}
        </button>
      ) : null}
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
}: IssueWorkflowDagProps) {
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
        onCreateTask,
        onRunAutomation,
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
  }, [nodes, onCreateTask, onOpenTask, onRunAutomation, tasks])

  return (
    <div
      data-testid="cloud-todo-workflow-dag"
      className="mt-2 h-[300px] overflow-hidden rounded-xl border border-border bg-muted/20"
    >
      <ReactFlow
        className="workflow-react-flow"
        nodes={graph.nodes}
        edges={graph.edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
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
  )
}
