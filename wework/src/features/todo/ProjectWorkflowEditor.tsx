import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  getBezierPath,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react'
import {
  Bot,
  Check,
  ChevronDown,
  GitBranch,
  Plus,
  Settings2,
  Sparkles,
  Trash2,
  UserRound,
  Workflow,
  X,
} from 'lucide-react'
import type {
  IssueStageMode,
  ProjectWorkflowDefinition,
  WorkflowContextSource,
  WorkflowNodeDefinition,
  WorkflowWorkspacePolicy,
} from '@/api/deliveries'
import type { ProjectAutomationRule } from '@/api/projectAutomations'
import type { ProjectChatAgent } from '@/api/projectChatAgents'
import { workflowNodeExecutionMode } from '@/api/issueWorkflow'
import { PopupMenu } from '@/components/common/MenuSelect'
import { Tooltip } from '@/components/ui/tooltip'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { WorkflowDeliverableRequirementsDialog } from './WorkflowDeliverableRequirementsDialog'
import { layoutWorkflowGraph, wouldCreateWorkflowCycle } from './workflowGraph'
import {
  createWorkflowDeliverableRequirement,
  workflowDeliverableTypeLabel,
} from './workflowDeliverables'

interface ProjectWorkflowEditorProps {
  value: ProjectWorkflowDefinition
  busy: boolean
  onChange: (value: ProjectWorkflowDefinition) => void
  onSave: (value: ProjectWorkflowDefinition) => void | Promise<void>
  automationRules?: ProjectAutomationRule[]
  projectAgents?: ProjectChatAgent[]
  onEnsureStageRobotRule?: (config: {
    roleSource: 'generic' | 'agent'
    agentId: string | null
    runtimeSource: 'issue_creator' | 'agent_default' | 'fixed_profile' | 'runtime_user'
    runtimeProfileId: string | null
    runtimeUserId: number | null
  }) => Promise<string | null>
  onRequestCreateRobot?: () => Promise<ProjectChatAgent | null>
  onRequestConfigureAiCoordinator?: () => void
}

interface StageNodeData extends Record<string, unknown> {
  stage: WorkflowNodeDefinition
  index: number
  actionLabel: string
  dependencyCount: number
  onInsertBefore: () => void
  onInsertAfter: () => void
}

interface WorkflowEdgeData extends Record<string, unknown> {
  onSelect: (source: string, target: string) => void
  selected: boolean
}

type StageFlowNode = Node<StageNodeData, 'stage'>
type WorkflowFlowEdge = Edge<WorkflowEdgeData, 'workflow'>
type OrchestrationMode = 'manual' | 'workflow' | 'ai'
type StageInsertionDirection = 'before' | 'after'
interface DeliverableDialogState {
  nodeId: string
  requirements: NonNullable<WorkflowNodeDefinition['required_deliverables']>
}

const STAGE_NODE_WIDTH = 220
const STAGE_NODE_HEIGHT = 116
const DEFAULT_DEPENDENCY_CONTEXT: WorkflowContextSource[] = ['final_result', 'deliveries']

function nextNodeId(nodes: WorkflowNodeDefinition[]): string {
  let index = nodes.length + 1
  while (nodes.some(node => node.id === `stage-${index}`)) index += 1
  return `stage-${index}`
}

function stageMode(value: ProjectWorkflowDefinition): IssueStageMode {
  return value.stage_mode ?? (value.nodes.length ? 'dag' : 'none')
}

function dependencyContext(
  node: WorkflowNodeDefinition,
  dependencyId: string
): WorkflowContextSource[] {
  return [...(node.dependency_context?.[dependencyId] ?? DEFAULT_DEPENDENCY_CONTEXT)]
}

function createStage(
  id: string,
  name: string,
  dependsOn: string[],
  dependencyContexts: Record<string, WorkflowContextSource[]>
): WorkflowNodeDefinition {
  return {
    id,
    name,
    prompt: '',
    depends_on: dependsOn,
    dependency_context: dependencyContexts,
    required: true,
    required_deliverables: [],
    workspace_policy: dependsOn.length ? 'inherit' : 'composer',
    execution_mode: 'human',
    automation_rule_id: null,
  }
}

const StageNodeCard = memo(function StageNodeCard({ data, selected }: NodeProps<StageFlowNode>) {
  const { t } = useTranslation('common')
  return (
    <article
      data-testid={`project-workflow-stage-${data.stage.id}`}
      className={cn(
        'relative h-[116px] w-[220px] rounded-xl border bg-background px-3 py-2.5 shadow-sm transition',
        selected
          ? 'border-blue-500 ring-2 ring-blue-500/15'
          : 'border-border hover:border-text-muted'
      )}
    >
      <Handle
        type="target"
        position={Position.Left}
        className={cn(
          '!h-3 !w-3 !border-2 !border-background !bg-text-muted',
          selected && '!opacity-0'
        )}
      />
      {selected ? (
        <Tooltip
          label={t('todo.workflow_insert_stage_before', '在此阶段前插入阶段')}
          className="!absolute left-0 top-1/2 -translate-x-1/2 -translate-y-1/2"
        >
          <button
            type="button"
            data-testid={`project-workflow-insert-before-${data.stage.id}`}
            aria-label={t('todo.workflow_insert_stage_before', '在此阶段前插入阶段')}
            onClick={event => {
              event.stopPropagation()
              data.onInsertBefore()
            }}
            className="nodrag nopan flex h-6 w-6 items-center justify-center rounded-full border border-blue-500 bg-background text-blue-500 shadow-sm transition hover:bg-blue-500 hover:text-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
      ) : null}
      <div className="flex items-start gap-2">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border text-xs text-text-muted">
          {data.index + 1}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-text-primary">{data.stage.name}</p>
          <p className="mt-0.5 truncate text-xs text-text-muted">{data.actionLabel}</p>
        </div>
      </div>
      <p className="mt-2 line-clamp-2 min-h-8 text-xs leading-4 text-text-secondary">
        {data.stage.prompt || t('todo.workflow_stage_prompt_empty', '尚未设置这个阶段需要完成什么')}
      </p>
      <p className="mt-1 text-xs text-text-muted">
        {data.dependencyCount
          ? t('todo.workflow_dependency_count', '{{count}} 个前置阶段', {
              count: data.dependencyCount,
            })
          : t('todo.workflow_no_dependencies', '无前置阶段')}
      </p>
      <Handle
        type="source"
        position={Position.Right}
        className={cn(
          '!h-3 !w-3 !border-2 !border-background !bg-text-muted',
          selected && '!opacity-0'
        )}
      />
      {selected ? (
        <Tooltip
          label={t('todo.workflow_insert_stage_after', '在此阶段后插入阶段')}
          className="!absolute right-0 top-1/2 translate-x-1/2 -translate-y-1/2"
        >
          <button
            type="button"
            data-testid={`project-workflow-insert-after-${data.stage.id}`}
            aria-label={t('todo.workflow_insert_stage_after', '在此阶段后插入阶段')}
            onClick={event => {
              event.stopPropagation()
              data.onInsertAfter()
            }}
            className="nodrag nopan flex h-6 w-6 items-center justify-center rounded-full border border-blue-500 bg-background text-blue-500 shadow-sm transition hover:bg-blue-500 hover:text-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
      ) : null}
    </article>
  )
})

const nodeTypes = { stage: StageNodeCard }

const WorkflowEdge = memo(function WorkflowEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  data,
}: EdgeProps<WorkflowFlowEdge>) {
  const { t } = useTranslation('common')
  const [hovered, setHovered] = useState(false)
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  })
  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...style,
          stroke: hovered || data?.selected ? 'rgb(59 130 246)' : style?.stroke,
          strokeWidth: hovered || data?.selected ? 2.5 : style?.strokeWidth,
        }}
      />
      <path
        data-testid={`project-workflow-edge-${source}-${target}`}
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={18}
        className="cursor-pointer"
        role="button"
        tabIndex={0}
        aria-label={t('todo.workflow_configure_context', '点击配置上下文传递')}
        onClick={() => data?.onSelect(source, target)}
        onKeyDown={event => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          data?.onSelect(source, target)
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />
      <EdgeLabelRenderer>
        <span
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute flex h-6 w-6 items-center justify-center rounded-full border border-blue-500/40 bg-background text-blue-500 shadow-sm transition-opacity',
            hovered || data?.selected ? 'opacity-100' : 'opacity-0'
          )}
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
          }}
        >
          <Settings2 className="h-3.5 w-3.5" />
        </span>
      </EdgeLabelRenderer>
    </>
  )
})

const edgeTypes = { workflow: WorkflowEdge }

function DependencyContextInspector({
  source,
  target,
  contextSources,
  onChange,
  onDelete,
}: {
  source?: WorkflowNodeDefinition
  target?: WorkflowNodeDefinition
  contextSources: WorkflowContextSource[]
  onChange: (sources: WorkflowContextSource[]) => void
  onDelete: () => void
}) {
  const { t } = useTranslation('common')
  const options: Array<[WorkflowContextSource, string, string]> = [
    [
      'final_result',
      t('todo.workflow_context_final_result', '最终结果'),
      t('todo.workflow_context_final_result_hint', '前序任务完成后的 final content 摘要'),
    ],
    [
      'deliveries',
      t('todo.workflow_context_deliveries', '交付附件'),
      t('todo.workflow_context_deliveries_hint', '前序阶段交付的文件和附件引用'),
    ],
    [
      'activity',
      t('todo.workflow_context_activity', '执行过程'),
      t('todo.workflow_context_activity_hint', '前序任务的关键过程与动态摘要'),
    ],
  ]
  return (
    <div data-testid={`project-workflow-edge-inspector-${source?.id}-${target?.id}`}>
      <div className="flex items-center justify-between gap-2">
        <h5 className="text-sm font-semibold text-text-primary">
          {t('todo.workflow_context_transfer', '上下文传递')}
        </h5>
        <button
          type="button"
          data-testid={`project-workflow-edge-delete-${source?.id}-${target?.id}`}
          onClick={onDelete}
          aria-label={t('todo.workflow_remove_dependency', '移除前置阶段 {{name}}', {
            name: source?.name ?? '',
          })}
          className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-muted hover:text-red-600"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-4 flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm text-text-secondary">
        <span className="min-w-0 flex-1 truncate">{source?.name}</span>
        <span className="text-text-muted">→</span>
        <span className="min-w-0 flex-1 truncate text-right">{target?.name}</span>
      </div>
      <p className="mt-4 text-xs text-text-muted">
        {t(
          'todo.workflow_issue_context_always',
          'Issue 信息始终自动传递。额外选择要从前序阶段带入的内容。'
        )}
      </p>
      <div className="mt-3 space-y-2">
        {options.map(([sourceType, label, hint]) => (
          <label
            key={sourceType}
            className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-2 hover:bg-muted"
          >
            <input
              type="checkbox"
              data-testid={`project-workflow-edge-context-${sourceType}`}
              checked={contextSources.includes(sourceType)}
              onChange={event =>
                onChange(
                  event.target.checked
                    ? [...contextSources, sourceType]
                    : contextSources.filter(value => value !== sourceType)
                )
              }
              className="mt-0.5"
            />
            <span className="min-w-0">
              <span className="block text-sm text-text-primary">{label}</span>
              <span className="mt-0.5 block text-xs text-text-muted">{hint}</span>
            </span>
          </label>
        ))}
      </div>
    </div>
  )
}

export function ProjectWorkflowEditor({
  value,
  busy,
  onChange,
  onSave,
  automationRules = [],
  projectAgents = [],
  onEnsureStageRobotRule,
  onRequestCreateRobot,
  onRequestConfigureAiCoordinator,
}: ProjectWorkflowEditorProps) {
  const { t } = useTranslation('common')
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(value.nodes[0]?.id ?? null)
  const [selectedEdge, setSelectedEdge] = useState<{ source: string; target: string } | null>(null)
  const [graphActive, setGraphActive] = useState(false)
  const [stageRobotBusyId, setStageRobotBusyId] = useState<string | null>(null)
  const [deliverableDialog, setDeliverableDialog] = useState<DeliverableDialogState | null>(null)
  const graphContainerRef = useRef<HTMLDivElement>(null)
  const [robotModeNodeIds, setRobotModeNodeIds] = useState<Set<string>>(
    () =>
      new Set(
        value.nodes.filter(node => workflowNodeExecutionMode(node) === 'robot').map(node => node.id)
      )
  )
  const currentStageMode = stageMode(value)
  const currentAdvancementPolicy = value.advancement_policy ?? 'manual'
  const orchestrationMode: OrchestrationMode =
    currentAdvancementPolicy === 'ai' ? 'ai' : currentStageMode === 'dag' ? 'workflow' : 'manual'
  const aiRules = useMemo(
    () =>
      automationRules.filter(
        rule =>
          rule.assignmentMode === 'ai_managed' &&
          rule.triggerType === 'event' &&
          rule.eventType === 'task.created'
      ),
    [automationRules]
  )
  const stageRules = useMemo(
    () =>
      automationRules.filter(
        rule => rule.assignmentMode === 'manual' && rule.triggerType === 'workflow'
      ),
    [automationRules]
  )
  const selectedNode = value.nodes.find(node => node.id === selectedNodeId) ?? null
  const selectedStageRule = stageRules.find(rule => rule.id === selectedNode?.automation_rule_id)
  const selectedStageRobotMode =
    Boolean(selectedStageRule) || Boolean(selectedNode && robotModeNodeIds.has(selectedNode.id))
  const canSave =
    (currentStageMode === 'none' ||
      (value.nodes.length > 0 &&
        value.nodes.every(node => node.name.trim() && node.depends_on.every(Boolean)))) &&
    (currentAdvancementPolicy === 'manual' || Boolean(value.ai_automation_rule_id))

  const updateDefinition = useCallback(
    (patch: Partial<ProjectWorkflowDefinition>) => {
      onChange({ ...value, ...patch })
    },
    [onChange, value]
  )
  const updateNode = useCallback(
    (id: string, patch: Partial<WorkflowNodeDefinition>) => {
      updateDefinition({
        nodes: value.nodes.map(node => (node.id === id ? { ...node, ...patch } : node)),
      })
    },
    [updateDefinition, value.nodes]
  )
  const saveDeliverables = useCallback(
    (
      nodeId: string,
      requirements: NonNullable<WorkflowNodeDefinition['required_deliverables']>
    ) => {
      if (!value.nodes.some(node => node.id === nodeId)) return
      const nextDefinition = {
        ...value,
        nodes: value.nodes.map(node =>
          node.id === nodeId ? { ...node, required_deliverables: requirements } : node
        ),
      }
      onChange(nextDefinition)
      void onSave(nextDefinition)
    },
    [onChange, onSave, value]
  )
  const addNode = () => {
    const id = nextNodeId(value.nodes)
    const stageNumber = Number(id.replace('stage-', ''))
    const previous = value.nodes.at(-1)
    const dependsOn = previous ? [previous.id] : []
    updateDefinition({
      stage_mode: 'dag',
      nodes: [
        ...value.nodes,
        createStage(
          id,
          t('todo.workflow_new_stage_numbered', '新阶段 {{number}}', {
            number: stageNumber,
          }),
          dependsOn,
          previous ? { [previous.id]: [...DEFAULT_DEPENDENCY_CONTEXT] } : {}
        ),
      ],
    })
    setSelectedNodeId(id)
  }
  const insertNode = useCallback(
    (selectedId: string, direction: StageInsertionDirection) => {
      const selectedIndex = value.nodes.findIndex(node => node.id === selectedId)
      if (selectedIndex < 0) return
      const selected = value.nodes[selectedIndex]
      const id = nextNodeId(value.nodes)
      const stageNumber = Number(id.replace('stage-', ''))
      const name = t('todo.workflow_new_stage_numbered', '新阶段 {{number}}', {
        number: stageNumber,
      })

      if (direction === 'before') {
        const inserted = createStage(
          id,
          name,
          [...selected.depends_on],
          Object.fromEntries(
            selected.depends_on.map(dependencyId => [
              dependencyId,
              dependencyContext(selected, dependencyId),
            ])
          )
        )
        const rewiredSelected = {
          ...selected,
          depends_on: [id],
          dependency_context: { [id]: [...DEFAULT_DEPENDENCY_CONTEXT] },
        }
        updateDefinition({
          stage_mode: 'dag',
          nodes: [
            ...value.nodes.slice(0, selectedIndex),
            inserted,
            rewiredSelected,
            ...value.nodes.slice(selectedIndex + 1),
          ],
        })
      } else {
        const inserted = createStage(id, name, [selectedId], {
          [selectedId]: [...DEFAULT_DEPENDENCY_CONTEXT],
        })
        const rewiredNodes = value.nodes.map(node => {
          if (!node.depends_on.includes(selectedId)) return node
          const nextContext = Object.fromEntries(
            Object.entries(node.dependency_context ?? {}).filter(
              ([dependencyId]) => dependencyId !== selectedId
            )
          )
          nextContext[id] = dependencyContext(node, selectedId)
          return {
            ...node,
            depends_on: node.depends_on.map(dependencyId =>
              dependencyId === selectedId ? id : dependencyId
            ),
            dependency_context: nextContext,
          }
        })
        rewiredNodes.splice(selectedIndex + 1, 0, inserted)
        updateDefinition({ stage_mode: 'dag', nodes: rewiredNodes })
      }
      setSelectedEdge(null)
      setSelectedNodeId(id)
    },
    [t, updateDefinition, value.nodes]
  )
  const removeNode = (id: string) => {
    const remainingNodes = value.nodes.filter(node => node.id !== id)
    updateDefinition({
      nodes: remainingNodes.map(node => ({
        ...node,
        depends_on: node.depends_on.filter(dependency => dependency !== id),
        dependency_context: Object.fromEntries(
          Object.entries(node.dependency_context ?? {}).filter(([dependency]) => dependency !== id)
        ),
      })),
    })
    if (selectedNodeId === id) setSelectedNodeId(remainingNodes[0]?.id ?? null)
    if (selectedEdge?.source === id || selectedEdge?.target === id) setSelectedEdge(null)
  }
  const removeDependency = useCallback(
    (source: string, target: string) => {
      const targetNode = value.nodes.find(node => node.id === target)
      if (!targetNode) return
      updateNode(target, {
        depends_on: targetNode.depends_on.filter(dependency => dependency !== source),
        dependency_context: Object.fromEntries(
          Object.entries(targetNode.dependency_context ?? {}).filter(
            ([dependency]) => dependency !== source
          )
        ),
      })
      setSelectedEdge(null)
    },
    [updateNode, value.nodes]
  )
  const handleGraphKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Backspace' && event.key !== 'Delete') return
    const target = event.target as HTMLElement
    if (target.closest('input, textarea, select, button, a, [contenteditable="true"]')) return
    if (selectedNodeId) {
      event.preventDefault()
      updateDefinition({
        nodes: value.nodes
          .filter(node => node.id !== selectedNodeId)
          .map(node => {
            if (!node.depends_on.includes(selectedNodeId)) return node
            return {
              ...node,
              depends_on: node.depends_on.filter(dependency => dependency !== selectedNodeId),
              dependency_context: Object.fromEntries(
                Object.entries(node.dependency_context ?? {}).filter(
                  ([dependency]) => dependency !== selectedNodeId
                )
              ),
            }
          }),
      })
      setSelectedNodeId(null)
      setSelectedEdge(null)
      return
    }
    if (selectedEdge) {
      event.preventDefault()
      removeDependency(selectedEdge.source, selectedEdge.target)
    }
  }

  const graph = useMemo(() => {
    const edges: WorkflowFlowEdge[] = value.nodes.flatMap(node =>
      node.depends_on.map(dependency => ({
        id: `${dependency}-${node.id}`,
        type: 'workflow',
        source: dependency,
        target: node.id,
        selected: selectedEdge?.source === dependency && selectedEdge.target === node.id,
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { stroke: 'rgb(var(--color-text-muted))', strokeWidth: 1.5 },
        data: {
          selected: selectedEdge?.source === dependency && selectedEdge.target === node.id,
          onSelect: (source: string, target: string) => {
            setSelectedNodeId(null)
            setSelectedEdge({ source, target })
          },
        },
      }))
    )
    const nodes: StageFlowNode[] = value.nodes.map((node, index) => {
      const automationRule = stageRules.find(rule => rule.id === node.automation_rule_id)
      return {
        id: node.id,
        type: 'stage',
        position: { x: 0, y: 0 },
        selected: node.id === selectedNodeId,
        data: {
          stage: node,
          index,
          actionLabel: automationRule
            ? t('todo.workflow_stage_robot_named', '机器人：{{name}}', {
                name: automationRule.agentName || automationRule.name,
              })
            : workflowNodeExecutionMode(node) === 'robot'
              ? t('todo.workflow_stage_robot_execution', '自动执行')
              : t('todo.workflow_stage_human_execution', '手动执行'),
          dependencyCount: node.depends_on.length,
          onInsertBefore: () => insertNode(node.id, 'before'),
          onInsertAfter: () => insertNode(node.id, 'after'),
        },
      }
    })
    return {
      edges,
      nodes: layoutWorkflowGraph(nodes, edges, {
        nodeWidth: STAGE_NODE_WIDTH,
        nodeHeight: STAGE_NODE_HEIGHT,
      }) as StageFlowNode[],
    }
  }, [insertNode, selectedEdge, selectedNodeId, stageRules, t, value.nodes])

  const flowInstanceRef = useRef<ReactFlowInstance<StageFlowNode, WorkflowFlowEdge> | null>(null)
  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      setGraphActive(
        target instanceof globalThis.Node && Boolean(graphContainerRef.current?.contains(target))
      )
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => document.removeEventListener('pointerdown', handlePointerDown, true)
  }, [])
  useEffect(() => {
    const instance = flowInstanceRef.current
    if (!instance) return
    const frame = requestAnimationFrame(() => {
      void instance.fitView({ padding: 0.25, maxZoom: 1 })
    })
    return () => cancelAnimationFrame(frame)
  }, [value.nodes.length])

  const handleConnect = useCallback(
    (connection: Connection) => {
      const { source, target } = connection
      if (!source || !target) return
      const dependencies = new Map(value.nodes.map(node => [node.id, node.depends_on]))
      if (wouldCreateWorkflowCycle(source, target, dependencies)) return
      const targetNode = value.nodes.find(node => node.id === target)
      if (!targetNode || targetNode.depends_on.includes(source)) return
      updateNode(target, {
        depends_on: [...targetNode.depends_on, source],
        dependency_context: {
          ...(targetNode.dependency_context ?? {}),
          [source]: DEFAULT_DEPENDENCY_CONTEXT,
        },
      })
      setSelectedNodeId(null)
      setSelectedEdge({ source, target })
    },
    [updateNode, value.nodes]
  )

  const selectStageExecutor = useCallback(
    async (
      node: WorkflowNodeDefinition,
      config: {
        roleSource: 'generic' | 'agent'
        agentId: string | null
        runtimeSource: 'issue_creator' | 'agent_default' | 'fixed_profile' | 'runtime_user'
        runtimeProfileId: string | null
        runtimeUserId: number | null
      } | null
    ) => {
      if (!config) {
        updateNode(node.id, {
          execution_mode: 'robot',
          automation_rule_id: null,
          workspace_policy: node.workspace_policy === 'none' ? 'composer' : node.workspace_policy,
        })
        return
      }
      if (!onEnsureStageRobotRule) return
      const clearStageRobotRule = () => {
        updateNode(node.id, {
          execution_mode: 'robot',
          automation_rule_id: null,
          workspace_policy: node.workspace_policy === 'none' ? 'composer' : node.workspace_policy,
        })
      }
      setStageRobotBusyId(node.id)
      try {
        const ruleId = await onEnsureStageRobotRule(config)
        if (!ruleId) {
          clearStageRobotRule()
          return
        }
        updateNode(node.id, {
          execution_mode: 'robot',
          automation_rule_id: ruleId,
          workspace_policy: node.workspace_policy === 'none' ? 'composer' : node.workspace_policy,
        })
      } catch {
        clearStageRobotRule()
      } finally {
        setStageRobotBusyId(null)
      }
    },
    [onEnsureStageRobotRule, updateNode]
  )
  const selectStageExecutionMode = (node: WorkflowNodeDefinition, mode: 'human' | 'robot') => {
    setRobotModeNodeIds(current => {
      const next = new Set(current)
      if (mode === 'robot') next.add(node.id)
      else next.delete(node.id)
      return next
    })
    if (mode === 'human') {
      updateNode(node.id, {
        execution_mode: 'human',
        automation_rule_id: null,
        workspace_policy: node.workspace_policy === 'none' ? 'composer' : node.workspace_policy,
      })
      return
    }
    updateNode(node.id, { execution_mode: 'robot' })
  }

  return (
    <section className="mt-8 border-t border-border pt-8" data-testid="project-workflow-editor">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="flex items-center gap-2 text-heading-md font-semibold">
            <GitBranch className="h-4 w-4" />
            {t('todo.issue_orchestration', 'Issue 编排')}
          </h3>
          <p className="mt-1 text-sm text-text-muted">
            {t(
              'todo.issue_orchestration_hint',
              '阶段负责组织任务，推进方式决定由你还是 AI 拆解和分配具体任务。'
            )}
          </p>
        </div>
        <button
          type="button"
          data-testid="project-workflow-save"
          disabled={busy || !canSave}
          onClick={() => void onSave(value)}
          className="h-8 rounded-lg bg-text-primary px-3 text-sm font-medium text-background disabled:opacity-40"
        >
          {busy ? t('todo.workflow_saving', '保存中…') : t('todo.workflow_save', '保存编排')}
        </button>
      </div>

      <div className="mt-5 inline-flex h-10 rounded-xl bg-muted p-1">
        {(
          [
            ['manual', UserRound, t('todo.workflow_mode_manual', '自己管理任务')],
            ['workflow', Workflow, t('todo.workflow_mode_preset', '预置流程')],
            ['ai', Sparkles, t('todo.workflow_mode_ai', 'AI 动态分配')],
          ] as const
        ).map(([mode, Icon, label]) => (
          <button
            key={mode}
            type="button"
            data-testid={`project-workflow-mode-${mode}`}
            aria-pressed={orchestrationMode === mode}
            onClick={() => {
              if (mode === 'manual') {
                updateDefinition({ advancement_policy: 'manual', stage_mode: 'none' })
              } else if (mode === 'workflow') {
                updateDefinition({ advancement_policy: 'manual', stage_mode: 'dag' })
              } else {
                updateDefinition({ advancement_policy: 'ai' })
              }
            }}
            className={cn(
              'flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs transition',
              orchestrationMode === mode
                ? 'bg-background font-medium text-text-primary shadow-sm'
                : 'text-text-muted hover:text-text-primary'
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>

      {currentAdvancementPolicy === 'ai' ? (
        <div className="mt-4 grid gap-3 rounded-xl border border-border bg-muted/30 p-3 lg:grid-cols-[240px_1fr]">
          <div>
            <label className="text-xs font-medium text-text-secondary">
              {t('todo.workflow_ai_coordinator', '调度 AI')}
              <div className="mt-1.5 flex gap-2">
                <select
                  data-testid="project-workflow-ai-rule"
                  value={value.ai_automation_rule_id ?? ''}
                  onChange={event =>
                    updateDefinition({ ai_automation_rule_id: event.target.value || null })
                  }
                  className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-2 text-sm"
                >
                  <option value="">
                    {aiRules.length
                      ? t('todo.workflow_select_ai_coordinator', '选择负责拆解和分配任务的 AI')
                      : t('todo.workflow_no_ai_coordinator', '尚未配置调度 AI')}
                  </option>
                  {aiRules.map(rule => (
                    <option key={rule.id} value={rule.id}>
                      {rule.agentName || rule.name}
                      {rule.agentName && rule.agentName !== rule.name ? ` · ${rule.name}` : ''}
                    </option>
                  ))}
                </select>
                {onRequestConfigureAiCoordinator ? (
                  <button
                    type="button"
                    data-testid="project-workflow-configure-ai-coordinator"
                    onClick={onRequestConfigureAiCoordinator}
                    aria-label={t('todo.workflow_configure_ai_coordinator', '配置调度 AI')}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border text-text-secondary hover:bg-muted"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                ) : null}
              </div>
            </label>
            <p className="mt-1.5 text-xs text-text-muted">
              {t(
                'todo.workflow_ai_coordinator_hint',
                '负责读取 Issue、拆解并分配具体任务，本身不执行任务。'
              )}
            </p>
          </div>
          <label className="text-xs font-medium text-text-secondary">
            {t('todo.workflow_coordinator_prompt', '调度提示词')}
            <textarea
              data-testid="project-workflow-coordinator-prompt"
              value={value.coordinator_prompt ?? ''}
              onChange={event => updateDefinition({ coordinator_prompt: event.target.value })}
              placeholder={t(
                'todo.workflow_coordinator_prompt_placeholder',
                '说明如何拆解、选择执行者、何时等待确认，以及如何判断阶段完成'
              )}
              className="mt-1.5 min-h-20 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-text-muted"
            />
          </label>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-text-secondary lg:col-span-2">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                data-testid="project-workflow-ai-require-approval"
                checked={(value.approval_policy ?? 'required') === 'required'}
                onChange={event =>
                  updateDefinition({
                    approval_policy: event.target.checked ? 'required' : 'automatic',
                  })
                }
              />
              {t('todo.workflow_ai_require_approval', '执行前需要人工确认')}
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                data-testid="project-workflow-ai-use-stages"
                checked={currentStageMode === 'dag'}
                onChange={event =>
                  updateDefinition({ stage_mode: event.target.checked ? 'dag' : 'none' })
                }
              />
              {t('todo.workflow_ai_use_stages', '使用阶段 DAG 约束 AI 分配')}
            </label>
          </div>
        </div>
      ) : null}

      {currentStageMode === 'dag' ? (
        <div className="mt-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h4 className="text-sm font-semibold text-text-primary">
                {t('todo.workflow_stage_graph', '阶段图')}
              </h4>
              <p className="mt-0.5 text-xs text-text-muted">
                {t(
                  'todo.workflow_stage_graph_flow_hint',
                  '拖动连接点设置依赖；点击节点修改阶段，点击连线配置传递上下文。'
                )}
              </p>
            </div>
            <button
              type="button"
              data-testid="project-workflow-add"
              onClick={addNode}
              className="flex h-8 items-center gap-1 rounded-lg px-2.5 text-sm text-text-secondary hover:bg-muted"
            >
              <Plus className="h-3.5 w-3.5" />
              {t('todo.workflow_add_stage', '添加阶段')}
            </button>
          </div>
          {value.nodes.length === 0 ? (
            <button
              type="button"
              data-testid="project-workflow-empty-add"
              onClick={addNode}
              className="flex h-40 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border text-sm text-text-muted hover:bg-muted"
            >
              <Plus className="h-4 w-4" />
              {t('todo.workflow_add_first_stage', '添加第一个阶段')}
            </button>
          ) : (
            <div className="grid min-h-[420px] overflow-hidden rounded-xl border border-border bg-muted/20 lg:grid-cols-[minmax(0,1fr)_300px]">
              <div
                ref={graphContainerRef}
                className="h-[420px] lg:h-auto"
                data-testid="project-workflow-dag"
                data-active={graphActive ? 'true' : 'false'}
                onFocusCapture={() => setGraphActive(true)}
                onBlurCapture={event => {
                  if (
                    !(event.relatedTarget instanceof globalThis.Node) ||
                    !event.currentTarget.contains(event.relatedTarget)
                  ) {
                    setGraphActive(false)
                  }
                }}
                onKeyDown={handleGraphKeyDown}
              >
                <ReactFlow
                  className="workflow-react-flow"
                  nodes={graph.nodes}
                  edges={graph.edges}
                  nodeTypes={nodeTypes}
                  edgeTypes={edgeTypes}
                  onInit={instance => {
                    flowInstanceRef.current = instance
                    void instance.fitView({ padding: 0.25, maxZoom: 1 })
                  }}
                  onNodeClick={(_, node) => {
                    setSelectedEdge(null)
                    setSelectedNodeId(node.id)
                  }}
                  onPaneClick={() => {
                    setSelectedNodeId(null)
                    setSelectedEdge(null)
                  }}
                  onConnect={handleConnect}
                  minZoom={0.35}
                  maxZoom={1.5}
                  zoomOnScroll={graphActive}
                  zoomOnPinch={graphActive}
                  zoomOnDoubleClick={graphActive}
                  panOnDrag={graphActive}
                  preventScrolling={graphActive}
                  nodesDraggable={false}
                  deleteKeyCode={null}
                  proOptions={{ hideAttribution: true }}
                  defaultEdgeOptions={{ deletable: true }}
                >
                  <Background gap={24} size={1} color="rgb(var(--color-border))" />
                  <Controls showInteractive={false} />
                </ReactFlow>
              </div>
              <aside className="border-t border-border bg-background p-4 lg:border-l lg:border-t-0">
                {selectedEdge ? (
                  <DependencyContextInspector
                    source={value.nodes.find(node => node.id === selectedEdge.source)}
                    target={value.nodes.find(node => node.id === selectedEdge.target)}
                    contextSources={
                      value.nodes.find(node => node.id === selectedEdge.target)
                        ?.dependency_context?.[selectedEdge.source] ?? DEFAULT_DEPENDENCY_CONTEXT
                    }
                    onChange={sources => {
                      const targetNode = value.nodes.find(node => node.id === selectedEdge.target)
                      if (!targetNode) return
                      updateNode(targetNode.id, {
                        dependency_context: {
                          ...(targetNode.dependency_context ?? {}),
                          [selectedEdge.source]: sources,
                        },
                      })
                    }}
                    onDelete={() => removeDependency(selectedEdge.source, selectedEdge.target)}
                  />
                ) : selectedNode ? (
                  <div data-testid={`project-workflow-inspector-${selectedNode.id}`}>
                    <div className="flex items-center justify-between gap-2">
                      <h5 className="text-sm font-semibold text-text-primary">
                        {t('todo.workflow_stage_settings', '阶段设置')}
                      </h5>
                      <button
                        type="button"
                        data-testid={`project-workflow-remove-${selectedNode.id}`}
                        onClick={() => removeNode(selectedNode.id)}
                        aria-label={t('todo.workflow_remove_stage', '删除阶段 {{name}}', {
                          name: selectedNode.name,
                        })}
                        className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-muted hover:text-red-600"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <label className="mt-4 block text-xs font-medium text-text-secondary">
                      {t('todo.workflow_stage_name_label', '阶段名称')}
                      <input
                        value={selectedNode.name}
                        data-testid={`project-workflow-stage-name-${selectedNode.id}`}
                        onChange={event =>
                          updateNode(selectedNode.id, { name: event.target.value })
                        }
                        className="mt-1.5 h-9 w-full rounded-lg border border-border bg-background px-2.5 text-sm outline-none focus:border-blue-500"
                      />
                    </label>
                    <label className="mt-4 block text-xs font-medium text-text-secondary">
                      {t('todo.workflow_stage_prompt_label', '阶段提示词')}
                      <textarea
                        value={selectedNode.prompt ?? ''}
                        data-testid={`project-workflow-stage-prompt-${selectedNode.id}`}
                        onChange={event =>
                          updateNode(selectedNode.id, { prompt: event.target.value })
                        }
                        placeholder={t(
                          'todo.workflow_stage_prompt_placeholder',
                          '这个阶段需要完成什么'
                        )}
                        className="mt-1.5 min-h-28 w-full resize-y rounded-lg border border-border bg-background px-2.5 py-2 text-sm outline-none focus:border-blue-500"
                      />
                    </label>
                    <fieldset className="mt-4">
                      <div className="flex items-center justify-between gap-2">
                        <legend className="text-xs font-medium text-text-secondary">
                          {t('todo.workflow_stage_deliverables_label', '必要交付物')}
                        </legend>
                        <button
                          type="button"
                          data-testid={`project-workflow-add-deliverable-${selectedNode.id}`}
                          onClick={() => {
                            const requirements = selectedNode.required_deliverables ?? []
                            setDeliverableDialog({
                              nodeId: selectedNode.id,
                              requirements: [
                                ...requirements,
                                createWorkflowDeliverableRequirement(requirements),
                              ],
                            })
                          }}
                          className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-text-secondary hover:bg-muted"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          {t('todo.workflow_add_deliverable', '添加交付物')}
                        </button>
                      </div>
                      {(selectedNode.required_deliverables ?? []).length ? (
                        <div
                          data-testid={`project-workflow-deliverable-list-${selectedNode.id}`}
                          className="mt-2 max-h-60 divide-y divide-border overflow-y-auto overscroll-contain rounded-lg border border-border"
                        >
                          {(selectedNode.required_deliverables ?? []).map(requirement => (
                            <div key={requirement.id} className="flex min-h-12 items-stretch">
                              <button
                                type="button"
                                data-testid={`project-workflow-deliverable-${requirement.id}`}
                                onClick={() =>
                                  setDeliverableDialog({
                                    nodeId: selectedNode.id,
                                    requirements: (selectedNode.required_deliverables ?? []).map(
                                      valueRequirement => ({ ...valueRequirement })
                                    ),
                                  })
                                }
                                className="flex min-h-12 min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left transition hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                              >
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-sm font-medium text-text-primary">
                                    {requirement.name}
                                  </span>
                                  <span className="mt-0.5 block truncate text-xs text-text-muted">
                                    {requirement.description ||
                                      t('todo.workflow_deliverable_no_description', '暂无验收说明')}
                                  </span>
                                </span>
                                <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-xs text-text-muted">
                                  {workflowDeliverableTypeLabel(requirement.value_type, t)}
                                </span>
                              </button>
                              <button
                                type="button"
                                data-testid={`project-workflow-remove-deliverable-${requirement.id}`}
                                aria-label={t(
                                  'todo.workflow_remove_named_deliverable',
                                  '删除交付物 {{name}}',
                                  { name: requirement.name }
                                )}
                                onClick={() =>
                                  saveDeliverables(
                                    selectedNode.id,
                                    (selectedNode.required_deliverables ?? []).filter(
                                      valueRequirement => valueRequirement.id !== requirement.id
                                    )
                                  )
                                }
                                className="flex w-10 shrink-0 items-center justify-center text-text-muted transition hover:bg-muted hover:text-red-600 focus-visible:bg-muted focus-visible:text-red-600 focus-visible:outline-none"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() =>
                            setDeliverableDialog({
                              nodeId: selectedNode.id,
                              requirements: [createWorkflowDeliverableRequirement([])],
                            })
                          }
                          className="mt-2 flex h-11 w-full items-center justify-center rounded-lg border border-dashed border-border px-3 text-xs text-text-muted hover:bg-muted hover:text-text-secondary"
                        >
                          {t('todo.workflow_deliverable_empty', '暂无交付物，点击添加')}
                        </button>
                      )}
                      <span className="mt-1.5 block text-xs font-normal text-text-muted">
                        {t(
                          'todo.workflow_stage_deliverables_hint',
                          '每项交付要求都会绑定一个实际结果；全部满足后才可继续。'
                        )}
                      </span>
                    </fieldset>
                    <fieldset className="mt-4">
                      <legend className="text-xs font-medium text-text-secondary">
                        {t('todo.workflow_stage_executor_label', '任务执行方式')}
                      </legend>
                      <div className="mt-2 grid grid-cols-2 gap-2">
                        {(
                          [
                            [
                              'human',
                              UserRound,
                              t('todo.workflow_stage_human_execution', '手动执行'),
                            ],
                            ['robot', Bot, t('todo.workflow_stage_robot_execution', '自动执行')],
                          ] as const
                        ).map(([mode, Icon, label]) => (
                          <label
                            key={mode}
                            className={cn(
                              'flex h-10 cursor-pointer items-center justify-center gap-2 rounded-lg border text-sm transition',
                              selectedStageRobotMode === (mode === 'robot')
                                ? 'border-blue-500 bg-blue-500/10 text-blue-500'
                                : 'border-border text-text-secondary hover:bg-muted'
                            )}
                          >
                            <input
                              type="radio"
                              name={`project-workflow-stage-executor-${selectedNode.id}`}
                              value={mode}
                              checked={selectedStageRobotMode === (mode === 'robot')}
                              data-testid={`project-workflow-stage-executor-${mode}-${selectedNode.id}`}
                              onChange={() => selectStageExecutionMode(selectedNode, mode)}
                              className="sr-only"
                            />
                            <Icon className="h-4 w-4" />
                            {label}
                          </label>
                        ))}
                      </div>
                    </fieldset>
                    {selectedStageRobotMode ? (
                      <div className="mt-3">
                        <span className="block text-xs font-medium text-text-secondary">
                          {t('todo.workflow_stage_robot_label', '执行机器人')}
                        </span>
                        <div className="mt-1.5">
                          <PopupMenu
                            testId={`project-workflow-stage-automation-${selectedNode.id}`}
                            disabled={stageRobotBusyId === selectedNode.id}
                            menuWidth={280}
                            fullWidth
                            trigger={
                              <span className="flex h-10 w-full items-center gap-2 rounded-lg border border-dashed border-border px-3 text-sm text-text-secondary transition hover:border-text-tertiary hover:bg-muted">
                                <Bot className="h-4 w-4 shrink-0" />
                                <span className="min-w-0 flex-1 truncate text-left">
                                  {selectedStageRule?.roleSource === 'generic'
                                    ? t('todo.workflow_stage_generic_ai', '通用 AI')
                                    : (projectAgents.find(
                                        agent => agent.id === selectedStageRule?.agentId
                                      )?.name ?? t('todo.workflow_stage_add_robot', '添加机器人'))}
                                </span>
                                <ChevronDown className="h-4 w-4 shrink-0 text-text-muted" />
                              </span>
                            }
                          >
                            {close => (
                              <>
                                <div className="max-h-60 overflow-y-auto">
                                  {selectedStageRule ? (
                                    <button
                                      type="button"
                                      role="menuitem"
                                      data-testid={`project-workflow-stage-automation-${selectedNode.id}-clear`}
                                      onClick={() => {
                                        void selectStageExecutor(selectedNode, null)
                                        close()
                                      }}
                                      className="flex h-10 w-full items-center gap-2 rounded-xl px-3 text-left text-sm text-text-secondary hover:bg-surface"
                                    >
                                      <X className="h-4 w-4 shrink-0 text-text-muted" />
                                      <span className="min-w-0 flex-1 truncate">
                                        {t('todo.workflow_stage_clear_robot', '取消选择机器人')}
                                      </span>
                                    </button>
                                  ) : null}
                                  {[
                                    {
                                      id: '__generic__',
                                      name: t('todo.workflow_stage_generic_ai', '通用 AI'),
                                    },
                                    ...projectAgents,
                                  ].map(agent => {
                                    const selected =
                                      selectedStageRule?.roleSource === 'generic'
                                        ? agent.id === '__generic__'
                                        : agent.id === selectedStageRule?.agentId
                                    return (
                                      <button
                                        key={agent.id}
                                        type="button"
                                        role="menuitem"
                                        data-testid={`project-workflow-stage-automation-${selectedNode.id}-option-${agent.id}`}
                                        onClick={() => {
                                          const roleSource =
                                            agent.id === '__generic__' ? 'generic' : 'agent'
                                          void selectStageExecutor(selectedNode, {
                                            roleSource,
                                            agentId: roleSource === 'agent' ? agent.id : null,
                                            runtimeSource:
                                              roleSource === 'agent'
                                                ? 'agent_default'
                                                : 'issue_creator',
                                            runtimeProfileId: null,
                                            runtimeUserId: null,
                                          })
                                          close()
                                        }}
                                        className="flex h-10 w-full items-center gap-2 rounded-xl px-3 text-left text-sm hover:bg-surface"
                                      >
                                        <Bot className="h-4 w-4 shrink-0 text-text-muted" />
                                        <span className="min-w-0 flex-1 truncate">
                                          {agent.name}
                                        </span>
                                        {selected ? <Check className="h-4 w-4 shrink-0" /> : null}
                                      </button>
                                    )
                                  })}
                                </div>
                                <div className="mt-1 border-t border-border pt-1">
                                  {onRequestCreateRobot ? (
                                    <button
                                      type="button"
                                      role="menuitem"
                                      data-testid="project-workflow-stage-create-robot"
                                      onClick={async () => {
                                        close()
                                        const agent = await onRequestCreateRobot()
                                        if (!agent) return
                                        await selectStageExecutor(selectedNode, {
                                          roleSource: 'agent',
                                          agentId: agent.id,
                                          runtimeSource: 'agent_default',
                                          runtimeProfileId: null,
                                          runtimeUserId: null,
                                        })
                                      }}
                                      className="flex h-10 w-full items-center gap-2 rounded-xl px-3 text-left text-sm font-medium hover:bg-surface"
                                    >
                                      <Plus className="h-4 w-4 shrink-0" />
                                      {t('todo.workflow_stage_create_robot', '创建机器人')}
                                    </button>
                                  ) : null}
                                </div>
                              </>
                            )}
                          </PopupMenu>
                        </div>
                      </div>
                    ) : null}
                    <p className="mt-1.5 text-xs text-text-muted">
                      {selectedStageRobotMode
                        ? t(
                            'todo.workflow_stage_robot_hint',
                            '阶段提示词会作为机器人的任务指令，执行记录归入当前阶段。'
                          )
                        : t(
                            'todo.workflow_stage_user_hint',
                            '阶段就绪后打开标准任务 Composer，可继续选择本地模式、工作空间和分支。'
                          )}
                    </p>
                    {!selectedNode.automation_rule_id ? (
                      <label className="mt-4 block text-xs font-medium text-text-secondary">
                        {t('todo.workflow_workspace_policy_label', '任务工作空间')}
                        <select
                          value={selectedNode.workspace_policy}
                          data-testid={`project-workflow-stage-workspace-${selectedNode.id}`}
                          onChange={event =>
                            updateNode(selectedNode.id, {
                              workspace_policy: event.target.value as WorkflowWorkspacePolicy,
                            })
                          }
                          className="mt-1.5 h-9 w-full rounded-lg border border-border bg-background px-2 text-sm"
                        >
                          <option value="composer">
                            {t('todo.workflow_workspace_composer', '创建任务时选择工作空间')}
                          </option>
                          <option value="inherit">
                            {t('todo.workflow_workspace_inherit', '继承前序任务工作空间')}
                          </option>
                          <option value="none">
                            {t('todo.workflow_workspace_none', '不限定工作空间')}
                          </option>
                        </select>
                      </label>
                    ) : null}
                    <label className="mt-4 flex items-center gap-2 text-xs text-text-secondary">
                      <input
                        type="checkbox"
                        data-testid={`project-workflow-stage-required-${selectedNode.id}`}
                        checked={selectedNode.required}
                        onChange={event =>
                          updateNode(selectedNode.id, { required: event.target.checked })
                        }
                      />
                      {t('todo.workflow_stage_required', '该阶段完成后才能推进 Issue')}
                    </label>
                    <div className="mt-5 border-t border-border pt-4">
                      <p className="text-xs font-medium text-text-secondary">
                        {t('todo.workflow_dependencies', '前置阶段')}
                      </p>
                      {selectedNode.depends_on.length ? (
                        <div className="mt-2 space-y-1">
                          {selectedNode.depends_on.map(dependencyId => {
                            const dependency = value.nodes.find(node => node.id === dependencyId)
                            if (!dependency) return null
                            return (
                              <div
                                key={dependencyId}
                                className="flex h-8 items-center justify-between rounded-lg bg-muted px-2 text-xs text-text-secondary"
                              >
                                <span className="truncate">{dependency.name}</span>
                                <button
                                  type="button"
                                  data-testid={`project-workflow-remove-dependency-${selectedNode.id}-${dependencyId}`}
                                  onClick={() => removeDependency(dependencyId, selectedNode.id)}
                                  aria-label={t(
                                    'todo.workflow_remove_dependency',
                                    '移除前置阶段 {{name}}',
                                    { name: dependency.name }
                                  )}
                                  className="ml-2 text-text-muted hover:text-red-600"
                                >
                                  ×
                                </button>
                              </div>
                            )
                          })}
                        </div>
                      ) : (
                        <p className="mt-2 text-xs text-text-muted">
                          {t('todo.workflow_no_dependencies', '无前置阶段')}
                        </p>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="flex h-full min-h-40 flex-col items-center justify-center text-center">
                    <GitBranch className="h-5 w-5 text-text-muted" />
                    <p className="mt-2 text-sm text-text-secondary">
                      {t('todo.workflow_select_stage', '选择一个阶段进行配置')}
                    </p>
                  </div>
                )}
              </aside>
            </div>
          )}
        </div>
      ) : (
        <div className="mt-5 rounded-xl border border-dashed border-border px-4 py-8 text-center">
          <p className="text-sm font-medium text-text-primary">
            {t('todo.workflow_free_tasks_title', 'Issue 内直接创建具体任务')}
          </p>
          <p className="mt-1 text-xs text-text-muted">
            {currentAdvancementPolicy === 'ai'
              ? t(
                  'todo.workflow_free_tasks_ai_hint',
                  'AI 根据 Issue 和提示词决定需要哪些任务、由谁执行以及执行顺序。'
                )
              : t(
                  'todo.workflow_free_tasks_manual_hint',
                  '用户自行创建和管理任务，不受阶段或固定流程约束。'
                )}
          </p>
        </div>
      )}
      {deliverableDialog ? (
        <WorkflowDeliverableRequirementsDialog
          key={deliverableDialog.nodeId}
          requirements={deliverableDialog.requirements ?? []}
          onClose={() => setDeliverableDialog(null)}
          onSave={requirements => {
            if (!value.nodes.some(node => node.id === deliverableDialog.nodeId)) {
              setDeliverableDialog(null)
              return
            }
            saveDeliverables(deliverableDialog.nodeId, requirements)
            setDeliverableDialog(null)
          }}
        />
      ) : null}
    </section>
  )
}
