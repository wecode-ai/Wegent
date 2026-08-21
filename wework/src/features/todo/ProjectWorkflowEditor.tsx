import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  GitBranch,
  Hourglass,
  Plus,
  Settings2,
  Sparkles,
  Trash2,
  UserRound,
  Workflow,
} from 'lucide-react'
import type {
  IssueStageMode,
  ProjectWorkflowDefinition,
  WaitEventRule,
  WorkflowContextSource,
  WorkflowNodeDefinition,
  WorkflowWorkspacePolicy,
} from '@/api/deliveries'
import type { ExternalEventType } from '@/api/externalEvents'
import { stripWorkflowEndpointNodes } from '@/api/issueWorkflow'
import type { ProjectAutomationRule } from '@/api/projectAutomations'
import type { ProjectChatAgent } from '@/api/projectChatAgents'
import { Combobox, type ComboboxOption } from '@/components/common/Combobox'
import { Tooltip } from '@/components/ui/tooltip'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { layoutWorkflowGraph, wouldCreateWorkflowCycle } from './workflowGraph'
import { WorkflowDeliverableRequirementsDialog } from './WorkflowDeliverableRequirementsDialog'
import {
  createWorkflowDeliverableRequirement,
  workflowDeliverableTypeLabel,
} from './workflowDeliverables'

interface ProjectWorkflowEditorProps {
  value: ProjectWorkflowDefinition
  busy: boolean
  onChange: (value: ProjectWorkflowDefinition) => void
  onSave: (value: ProjectWorkflowDefinition) => void | Promise<void>
  externalEventCatalog?: ExternalEventType[] | null
  automationRules?: ProjectAutomationRule[]
  projectAgents?: ProjectChatAgent[]
  onEnsureStageRobotRule?: (agentId: string) => Promise<string | null>
  onRequestCreateRobot?: () => void
  onRequestConfigureAiCoordinator?: () => void
}

interface EditorNodeData extends Record<string, unknown> {
  node: WorkflowNodeDefinition
  index: number
  actionLabel: string
  dependencyCount: number
  nodeWidth: number
  nodeHeight: number
  canInsertBefore: boolean
  canInsertAfter: boolean
  onInsertBefore: () => void
  onInsertAfter: () => void
}

interface WorkflowEdgeData extends Record<string, unknown> {
  onSelect: (source: string, target: string) => void
  selected: boolean
}

type EditorFlowNode = Node<EditorNodeData>
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

function nextNodeId(nodes: WorkflowNodeDefinition[], prefix: 'stage' | 'wait'): string {
  let index = 1
  while (nodes.some(node => node.id === `${prefix}-${index}`)) index += 1
  return `${prefix}-${index}`
}

function nextRuleId(rules: WaitEventRule[]): string {
  let index = 1
  while (rules.some(rule => rule.id === `rule-${index}`)) index += 1
  return `rule-${index}`
}

interface ExternalEventCategoryGroup {
  category: string
  types: ExternalEventType[]
}

interface ExternalEventProviderGroup {
  provider: string
  categories: ExternalEventCategoryGroup[]
}

function groupExternalEventCatalog(types: ExternalEventType[]): ExternalEventProviderGroup[] {
  const byProvider = new Map<string, Map<string, ExternalEventType[]>>()
  for (const type of types) {
    let byCategory = byProvider.get(type.provider)
    if (!byCategory) {
      byCategory = new Map()
      byProvider.set(type.provider, byCategory)
    }
    const list = byCategory.get(type.category) ?? []
    list.push(type)
    byCategory.set(type.category, list)
  }
  return [...byProvider.entries()].map(([provider, byCategory]) => ({
    provider,
    categories: [...byCategory.entries()].map(([category, groupedTypes]) => ({
      category,
      types: groupedTypes,
    })),
  }))
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

/** Replace one incoming dependency with another, keeping context in sync. */
function rewireDependency(
  node: WorkflowNodeDefinition,
  from: string,
  to: string
): WorkflowNodeDefinition {
  if (!node.depends_on.includes(from)) return node
  const nextContext = Object.fromEntries(
    Object.entries(node.dependency_context ?? {}).filter(([dependencyId]) => dependencyId !== from)
  )
  nextContext[to] = dependencyContext(node, from)
  return {
    ...node,
    depends_on: node.depends_on.map(dependencyId => (dependencyId === from ? to : dependencyId)),
    dependency_context: nextContext,
  }
}

function createStageNode(
  id: string,
  name: string,
  dependsOn: string[],
  dependencyContexts: Record<string, WorkflowContextSource[]>
): WorkflowNodeDefinition {
  return {
    id,
    name,
    node_type: 'stage',
    prompt: '',
    depends_on: dependsOn,
    dependency_context: dependencyContexts,
    required: true,
    required_deliverables: [],
    workspace_policy: dependsOn.length ? 'inherit' : 'composer',
    automation_rule_id: null,
  }
}

function createWaitNode(
  id: string,
  name: string,
  dependsOn: string[],
  dependencyContexts: Record<string, WorkflowContextSource[]>
): WorkflowNodeDefinition {
  return {
    id,
    name,
    node_type: 'wait',
    prompt: '',
    wait_config: {
      rules: [
        {
          id: 'rule-1',
          event_type: '',
          action: 'complete',
          rerun_prompt: '',
        },
      ],
      agent_id: null,
    },
    depends_on: dependsOn,
    dependency_context: dependencyContexts,
    required: true,
    required_deliverables: [],
    workspace_policy: 'none',
    automation_rule_id: null,
  }
}

function InsertNodeButton({
  side,
  testId,
  label,
  onClick,
}: {
  side: 'left' | 'right'
  testId: string
  label: string
  onClick: () => void
}) {
  return (
    <Tooltip
      label={label}
      className={cn(
        '!absolute top-1/2 -translate-y-1/2',
        side === 'left' ? 'left-0 -translate-x-1/2' : 'right-0 translate-x-1/2'
      )}
    >
      <button
        type="button"
        data-testid={testId}
        aria-label={label}
        onClick={event => {
          event.stopPropagation()
          onClick()
        }}
        className="nodrag nopan flex h-6 w-6 items-center justify-center rounded-full border border-blue-500 bg-background text-blue-500 shadow-sm transition hover:bg-blue-500 hover:text-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </Tooltip>
  )
}

const StageNodeCard = memo(function StageNodeCard({ data, selected }: NodeProps<EditorFlowNode>) {
  const { t } = useTranslation('common')
  return (
    <article
      data-testid={`project-workflow-stage-${data.node.id}`}
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
      {selected && data.canInsertBefore ? (
        <InsertNodeButton
          side="left"
          testId={`project-workflow-insert-before-${data.node.id}`}
          label={t('todo.workflow_insert_stage_before', '在此阶段前插入阶段')}
          onClick={data.onInsertBefore}
        />
      ) : null}
      <div className="flex items-start gap-2">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border text-xs text-text-muted">
          {data.index + 1}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-text-primary">{data.node.name}</p>
          <p className="mt-0.5 truncate text-xs text-text-muted">{data.actionLabel}</p>
        </div>
      </div>
      <p className="mt-2 line-clamp-2 min-h-8 text-xs leading-4 text-text-secondary">
        {data.node.prompt || t('todo.workflow_stage_prompt_empty', '尚未设置这个阶段需要完成什么')}
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
      {selected && data.canInsertAfter ? (
        <InsertNodeButton
          side="right"
          testId={`project-workflow-insert-after-${data.node.id}`}
          label={t('todo.workflow_insert_stage_after', '在此阶段后插入阶段')}
          onClick={data.onInsertAfter}
        />
      ) : null}
    </article>
  )
})

const WaitNodeCard = memo(function WaitNodeCard({ data, selected }: NodeProps<EditorFlowNode>) {
  const { t } = useTranslation('common')
  const waitingEvents = Array.from(
    new Set(
      (data.node.wait_config?.rules ?? []).map(rule => rule.event_type.trim()).filter(Boolean)
    )
  )
  return (
    <article
      data-testid={`project-workflow-wait-${data.node.id}`}
      className={cn(
        'relative h-[116px] w-[220px] rounded-xl border border-dashed bg-background px-3 py-2.5 shadow-sm transition',
        selected
          ? 'border-blue-500 ring-2 ring-blue-500/15'
          : 'border-text-muted/60 hover:border-text-muted'
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
      {selected && data.canInsertBefore ? (
        <InsertNodeButton
          side="left"
          testId={`project-workflow-insert-before-${data.node.id}`}
          label={t('todo.workflow_insert_node_before', '在此节点前插入阶段')}
          onClick={data.onInsertBefore}
        />
      ) : null}
      <div className="flex items-start gap-2">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-dashed border-text-muted/70 text-text-muted">
          <Hourglass className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-text-primary">{data.node.name}</p>
          <p className="mt-0.5 truncate text-xs text-text-muted">{data.actionLabel}</p>
        </div>
      </div>
      <p className="mt-1 line-clamp-1 text-xs text-text-secondary">
        {waitingEvents.length
          ? t('todo.workflow_wait_event_types', '等待：{{types}}', {
              types: waitingEvents.join(' / '),
            })
          : t('todo.workflow_wait_event_types_empty', '尚未配置等待事件')}
      </p>
      <Handle
        type="source"
        position={Position.Right}
        className={cn(
          '!h-3 !w-3 !border-2 !border-background !bg-text-muted',
          selected && '!opacity-0'
        )}
      />
      {selected && data.canInsertAfter ? (
        <InsertNodeButton
          side="right"
          testId={`project-workflow-insert-after-${data.node.id}`}
          label={t('todo.workflow_insert_node_after', '在此节点后插入阶段')}
          onClick={data.onInsertAfter}
        />
      ) : null}
    </article>
  )
})

const nodeTypes = {
  stage: StageNodeCard,
  wait: WaitNodeCard,
}

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

function StageInspector({
  node,
  automationRule,
  robotMode,
  robotBusy,
  projectAgents,
  dependencies,
  onUpdate,
  onRemove,
  onRemoveDependency,
  onSelectExecutor,
  onSelectExecutionMode,
  onRequestCreateRobot,
  onManageDeliverables,
}: {
  node: WorkflowNodeDefinition
  automationRule?: ProjectAutomationRule
  robotMode: boolean
  robotBusy: boolean
  projectAgents: ProjectChatAgent[]
  dependencies: WorkflowNodeDefinition[]
  onUpdate: (patch: Partial<WorkflowNodeDefinition>) => void
  onRemove: () => void
  onRemoveDependency: (dependencyId: string) => void
  onSelectExecutor: (agentId: string) => void
  onSelectExecutionMode: (mode: 'human' | 'robot') => void
  onRequestCreateRobot?: () => void
  onManageDeliverables: (
    requirements: NonNullable<WorkflowNodeDefinition['required_deliverables']>
  ) => void
}) {
  const { t } = useTranslation('common')
  return (
    <div data-testid={`project-workflow-inspector-${node.id}`}>
      <div className="flex items-center justify-between gap-2">
        <h5 className="text-sm font-semibold text-text-primary">
          {t('todo.workflow_stage_settings', '阶段设置')}
        </h5>
        <button
          type="button"
          data-testid={`project-workflow-remove-${node.id}`}
          onClick={onRemove}
          aria-label={t('todo.workflow_remove_stage', '删除阶段 {{name}}', {
            name: node.name,
          })}
          className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-muted hover:text-red-600"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <label className="mt-4 block text-xs font-medium text-text-secondary">
        {t('todo.workflow_stage_name_label', '阶段名称')}
        <input
          value={node.name}
          data-testid={`project-workflow-stage-name-${node.id}`}
          onChange={event => onUpdate({ name: event.target.value })}
          className="mt-1.5 h-9 w-full rounded-lg border border-border bg-background px-2.5 text-sm outline-none focus:border-blue-500"
        />
      </label>
      <label className="mt-4 block text-xs font-medium text-text-secondary">
        {t('todo.workflow_stage_prompt_label', '阶段提示词')}
        <textarea
          value={node.prompt ?? ''}
          data-testid={`project-workflow-stage-prompt-${node.id}`}
          onChange={event => onUpdate({ prompt: event.target.value })}
          placeholder={t('todo.workflow_stage_prompt_placeholder', '这个阶段需要完成什么')}
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
            data-testid={`project-workflow-add-deliverable-${node.id}`}
            onClick={() => {
              const requirements = node.required_deliverables ?? []
              onManageDeliverables([
                ...requirements,
                createWorkflowDeliverableRequirement(requirements),
              ])
            }}
            className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-text-secondary hover:bg-muted"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('todo.workflow_add_deliverable', '添加交付物')}
          </button>
        </div>
        {(node.required_deliverables ?? []).length ? (
          <div
            data-testid={`project-workflow-deliverable-list-${node.id}`}
            className="mt-2 max-h-60 min-w-0 divide-y divide-border overflow-y-auto overscroll-contain rounded-lg border border-border"
          >
            {(node.required_deliverables ?? []).map(requirement => (
              <button
                key={requirement.id}
                type="button"
                data-testid={`project-workflow-deliverable-${requirement.id}`}
                onClick={() =>
                  onManageDeliverables(
                    (node.required_deliverables ?? []).map(valueRequirement => ({
                      ...valueRequirement,
                    }))
                  )
                }
                className="flex min-h-12 w-full min-w-0 items-center gap-3 px-3 py-2 text-left transition hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
              >
                <span className="min-w-0 flex-1 overflow-hidden">
                  <span className="block truncate text-sm font-medium text-text-primary">
                    {requirement.name}
                  </span>
                  <span className="mt-0.5 block whitespace-normal text-xs text-text-muted [overflow-wrap:anywhere]">
                    {requirement.description ||
                      t('todo.workflow_deliverable_no_description', '暂无验收说明')}
                  </span>
                </span>
                <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-xs text-text-muted">
                  {workflowDeliverableTypeLabel(requirement.value_type, t)}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => onManageDeliverables([createWorkflowDeliverableRequirement([])])}
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
              ['human', UserRound, t('todo.workflow_stage_human_execution', '人工执行')],
              ['robot', Bot, t('todo.workflow_stage_robot_execution', '机器人执行')],
            ] as const
          ).map(([mode, Icon, label]) => (
            <label
              key={mode}
              className={cn(
                'flex h-10 cursor-pointer items-center justify-center gap-2 rounded-lg border text-sm transition',
                robotMode === (mode === 'robot')
                  ? 'border-blue-500 bg-blue-500/10 text-blue-500'
                  : 'border-border text-text-secondary hover:bg-muted'
              )}
            >
              <input
                type="radio"
                name={`project-workflow-stage-executor-${node.id}`}
                value={mode}
                checked={robotMode === (mode === 'robot')}
                data-testid={`project-workflow-stage-executor-${mode}-${node.id}`}
                onChange={() => onSelectExecutionMode(mode)}
                className="sr-only"
              />
              <Icon className="h-4 w-4" />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      {robotMode ? (
        <div className="mt-3">
          <label className="block text-xs font-medium text-text-secondary">
            {t('todo.workflow_stage_robot_label', '执行机器人')}
            <div className="mt-1.5 flex gap-2">
              <select
                value={automationRule?.agentId ?? ''}
                data-testid={`project-workflow-stage-automation-${node.id}`}
                disabled={robotBusy}
                onChange={event => void onSelectExecutor(event.target.value)}
                className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-2 text-sm"
              >
                <option value="">
                  {projectAgents.length
                    ? t('todo.workflow_stage_select_robot', '选择机器人')
                    : t('todo.workflow_stage_no_robots', '暂无可用机器人')}
                </option>
                {projectAgents.map(agent => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
              {onRequestCreateRobot ? (
                <button
                  type="button"
                  data-testid="project-workflow-stage-add-robot"
                  onClick={onRequestCreateRobot}
                  aria-label={t('todo.workflow_stage_add_robot', '添加机器人')}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border text-text-secondary hover:bg-muted"
                >
                  <Plus className="h-4 w-4" />
                </button>
              ) : null}
            </div>
          </label>
        </div>
      ) : null}
      <p className="mt-1.5 text-xs text-text-muted">
        {robotMode
          ? t(
              'todo.workflow_stage_robot_hint',
              '阶段提示词会作为机器人的任务指令，执行记录归入当前阶段。'
            )
          : t(
              'todo.workflow_stage_user_hint',
              '阶段就绪后打开标准任务 Composer，可继续选择本地模式、工作空间和分支。'
            )}
      </p>
      {!node.automation_rule_id ? (
        <label className="mt-4 block text-xs font-medium text-text-secondary">
          {t('todo.workflow_workspace_policy_label', '任务工作空间')}
          <select
            value={node.workspace_policy}
            data-testid={`project-workflow-stage-workspace-${node.id}`}
            onChange={event =>
              onUpdate({
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
            <option value="none">{t('todo.workflow_workspace_none', '不限定工作空间')}</option>
          </select>
        </label>
      ) : null}
      <label className="mt-4 flex items-center gap-2 text-xs text-text-secondary">
        <input
          type="checkbox"
          data-testid={`project-workflow-stage-required-${node.id}`}
          checked={node.required}
          onChange={event => onUpdate({ required: event.target.checked })}
        />
        {t('todo.workflow_stage_required', '该阶段完成后才能推进 Issue')}
      </label>
      <div className="mt-5 border-t border-border pt-4">
        <p className="text-xs font-medium text-text-secondary">
          {t('todo.workflow_dependencies', '前置阶段')}
        </p>
        {node.depends_on.length ? (
          <div className="mt-2 space-y-1">
            {node.depends_on.map(dependencyId => {
              const dependency = dependencies.find(candidate => candidate.id === dependencyId)
              return (
                <div
                  key={dependencyId}
                  className="flex h-8 items-center justify-between rounded-lg bg-muted px-2 text-xs text-text-secondary"
                >
                  <span className="truncate">{dependency?.name ?? dependencyId}</span>
                  <button
                    type="button"
                    data-testid={`project-workflow-remove-dependency-${node.id}-${dependencyId}`}
                    onClick={() => onRemoveDependency(dependencyId)}
                    aria-label={t('todo.workflow_remove_dependency', '移除前置阶段 {{name}}', {
                      name: dependency?.name ?? dependencyId,
                    })}
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
  )
}

function WaitNodeInspector({
  node,
  onUpdate,
  onRemove,
  externalEventCatalog,
  projectAgents = [],
  onRequestCreateRobot,
}: {
  node: WorkflowNodeDefinition
  onUpdate: (patch: Partial<WorkflowNodeDefinition>) => void
  onRemove: () => void
  externalEventCatalog?: ExternalEventType[] | null
  projectAgents?: ProjectChatAgent[]
  onRequestCreateRobot?: () => void
}) {
  const { t } = useTranslation('common')
  const rules = node.wait_config?.rules ?? []
  const catalogGroups = useMemo(
    () => groupExternalEventCatalog(externalEventCatalog ?? []),
    [externalEventCatalog]
  )
  const catalogOptions = useMemo(() => {
    const options: ComboboxOption[] = []
    for (const group of catalogGroups) {
      for (const category of group.categories) {
        for (const type of category.types) {
          options.push({
            id: `${type.provider}-${type.event_type}`,
            value: type.event_type,
            detail: t(`todo.workflow_wait_event_category_${type.category}`, type.category),
            groupLabel: group.provider,
          })
        }
      }
    }
    return options
  }, [catalogGroups, t])
  const catalogTypesByValue = useMemo(() => {
    const byValue = new Map<string, ExternalEventType>()
    for (const group of catalogGroups) {
      for (const category of group.categories) {
        for (const type of category.types) {
          byValue.set(type.event_type, type)
        }
      }
    }
    return byValue
  }, [catalogGroups])
  const referenceHints = useMemo(() => {
    const hints = new Map<string, ExternalEventType>()
    for (const group of catalogGroups) {
      for (const category of group.categories) {
        for (const type of category.types) {
          if (type.opaque_ref_format && !hints.has(group.provider)) {
            hints.set(group.provider, type)
          }
        }
      }
    }
    return hints
  }, [catalogGroups])
  const updateRule = (ruleId: string, patch: Partial<WaitEventRule>) => {
    onUpdate({
      wait_config: {
        ...node.wait_config,
        rules: rules.map(rule => (rule.id === ruleId ? { ...rule, ...patch } : rule)),
      },
    })
  }
  const addRule = () => {
    const id = nextRuleId(rules)
    onUpdate({
      wait_config: {
        ...node.wait_config,
        rules: [
          ...rules,
          {
            id,
            provider: null,
            event_type: '',
            action: 'complete',
            rerun_prompt: '',
          },
        ],
      },
    })
  }
  const removeRule = (ruleId: string) => {
    onUpdate({
      wait_config: {
        ...node.wait_config,
        rules: rules.filter(rule => rule.id !== ruleId),
      },
    })
  }
  return (
    <div data-testid={`project-workflow-inspector-${node.id}`}>
      <div className="flex items-center justify-between gap-2">
        <h5 className="flex items-center gap-1.5 text-sm font-semibold text-text-primary">
          <Hourglass className="h-4 w-4 text-text-muted" />
          {t('todo.workflow_wait_settings', '等待节点设置')}
        </h5>
        <button
          type="button"
          data-testid={`project-workflow-remove-${node.id}`}
          onClick={onRemove}
          aria-label={t('todo.workflow_remove_wait_node', '删除等待节点 {{name}}', {
            name: node.name,
          })}
          className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-muted hover:text-red-600"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <label className="mt-4 block text-xs font-medium text-text-secondary">
        {t('todo.workflow_stage_name_label', '阶段名称')}
        <input
          value={node.name}
          data-testid={`project-workflow-wait-name-${node.id}`}
          onChange={event => onUpdate({ name: event.target.value })}
          className="mt-1.5 h-9 w-full rounded-lg border border-border bg-background px-2.5 text-sm outline-none focus:border-blue-500"
        />
      </label>
      {rules.some(rule => rule.action === 'rerun') ? (
        <div className="mt-5">
          <label className="block text-xs font-medium text-text-secondary">
            {t('todo.workflow_stage_robot_label', '执行机器人')}
            <div className="mt-1.5 flex gap-2">
              <select
                value={node.wait_config?.agent_id ?? ''}
                data-testid={`project-workflow-wait-robot-${node.id}`}
                onChange={event =>
                  onUpdate({
                    wait_config: {
                      rules: node.wait_config?.rules ?? [],
                      agent_id: event.target.value || null,
                    },
                  })
                }
                className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-2 text-sm"
              >
                <option value="">
                  {projectAgents.length
                    ? t('todo.workflow_stage_select_robot', '选择机器人')
                    : t('todo.workflow_stage_no_robots', '暂无可用机器人')}
                </option>
                {projectAgents.map(agent => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
              {onRequestCreateRobot ? (
                <button
                  type="button"
                  data-testid={`project-workflow-wait-add-robot-${node.id}`}
                  onClick={onRequestCreateRobot}
                  aria-label={t('todo.workflow_stage_add_robot', '添加机器人')}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border text-text-secondary hover:bg-muted"
                >
                  <Plus className="h-4 w-4" />
                </button>
              ) : null}
            </div>
          </label>
        </div>
      ) : null}
      <div className="mt-5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium text-text-secondary">
            {t('todo.workflow_wait_rules', '事件规则')}
          </p>
          <button
            type="button"
            data-testid={`project-workflow-wait-rule-add-${node.id}`}
            onClick={addRule}
            className="flex h-7 items-center gap-1 rounded-lg px-2 text-xs text-text-secondary hover:bg-muted"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('todo.workflow_wait_rule_add', '添加规则')}
          </button>
        </div>
        <div className="mt-2 space-y-4">
          {rules.map((rule, index) => (
            <div
              key={rule.id}
              data-testid={`project-workflow-wait-rule-${node.id}-${rule.id}`}
              className="rounded-lg border border-border p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-text-muted">
                  {t('todo.workflow_wait_rule_number', '规则 {{number}}', { number: index + 1 })}
                </p>
                <button
                  type="button"
                  data-testid={`project-workflow-wait-rule-remove-${node.id}-${rule.id}`}
                  onClick={() => removeRule(rule.id)}
                  aria-label={t('todo.workflow_wait_rule_remove', '删除规则')}
                  className="flex h-6 w-6 items-center justify-center rounded-md text-text-muted hover:bg-muted hover:text-red-600"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <label className="mt-3 block text-xs font-medium text-text-secondary">
                {t('todo.workflow_wait_rule_event_type', '事件类型')}
                <div className="mt-1.5">
                  <Combobox
                    testId={`project-workflow-wait-rule-event-${node.id}-${rule.id}`}
                    value={rule.event_type}
                    onChange={value => updateRule(rule.id, { event_type: value })}
                    onPick={option => {
                      const type = catalogTypesByValue.get(option.value)
                      updateRule(rule.id, {
                        event_type: option.value,
                        provider: type?.provider ?? null,
                      })
                    }}
                    options={catalogOptions}
                    placeholder={t(
                      'todo.workflow_wait_rule_event_type_placeholder',
                      '选择或输入事件类型'
                    )}
                  />
                </div>
              </label>
              {rule.provider && referenceHints.has(rule.provider) ? (
                <p className="mt-1.5 text-xs leading-4 text-text-muted">
                  {t(
                    'todo.workflow_wait_rule_reference_hint',
                    '上游阶段将自动要求交付 {{kind}} 引用，系统据此登记等待事件（opaque_ref 形如 {{format}}）',
                    {
                      kind: referenceHints.get(rule.provider)?.reference_name ?? rule.provider,
                      format: referenceHints.get(rule.provider)?.opaque_ref_format ?? '',
                    }
                  )}
                </p>
              ) : null}
              <label className="mt-3 block text-xs font-medium text-text-secondary">
                {t('todo.workflow_wait_rule_action', '动作')}
                <select
                  value={rule.action}
                  data-testid={`project-workflow-wait-rule-action-${node.id}-${rule.id}`}
                  onChange={event =>
                    updateRule(rule.id, {
                      action: event.target.value as WaitEventRule['action'],
                    })
                  }
                  className="mt-1.5 h-9 w-full rounded-lg border border-border bg-background px-2 text-sm"
                >
                  <option value="complete">
                    {t('todo.workflow_wait_rule_action_complete', '完成并放行后继')}
                  </option>
                  <option value="rerun">
                    {t('todo.workflow_wait_rule_action_rerun', '重跑当前任务')}
                  </option>
                </select>
              </label>
              {rule.action === 'rerun' ? (
                <label className="mt-3 block text-xs font-medium text-text-secondary">
                  {t('todo.workflow_wait_rule_rerun_prompt', '重跑提示词')}
                  <textarea
                    value={rule.rerun_prompt ?? ''}
                    data-testid={`project-workflow-wait-rule-rerun-prompt-${node.id}-${rule.id}`}
                    onChange={event => updateRule(rule.id, { rerun_prompt: event.target.value })}
                    placeholder={t(
                      'todo.workflow_wait_rule_rerun_prompt_placeholder',
                      '事件命中后按此提示词发一轮新消息'
                    )}
                    className="mt-1.5 min-h-20 w-full resize-y rounded-lg border border-border bg-background px-2.5 py-2 text-sm outline-none focus:border-blue-500"
                  />
                </label>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export function ProjectWorkflowEditor({
  value,
  busy,
  onChange,
  onSave,
  externalEventCatalog,
  automationRules = [],
  projectAgents = [],
  onEnsureStageRobotRule,
  onRequestCreateRobot,
  onRequestConfigureAiCoordinator,
}: ProjectWorkflowEditorProps) {
  const { t } = useTranslation('common')
  const normalized = useMemo(() => {
    const nodes = stripWorkflowEndpointNodes(value.nodes)
    return nodes === value.nodes ? value : { ...value, nodes }
  }, [value])
  useEffect(() => {
    if (normalized !== value) onChange(normalized)
  }, [normalized, onChange, value])

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(
    normalized.nodes[0]?.id ?? null
  )
  const [selectedEdge, setSelectedEdge] = useState<{ source: string; target: string } | null>(null)
  const [deliverableDialog, setDeliverableDialog] = useState<DeliverableDialogState | null>(null)
  const [stageRobotBusyId, setStageRobotBusyId] = useState<string | null>(null)
  const [robotModeNodeIds, setRobotModeNodeIds] = useState<Set<string>>(
    () => new Set(normalized.nodes.filter(node => node.automation_rule_id).map(node => node.id))
  )
  const currentStageMode = stageMode(normalized)
  const currentAdvancementPolicy = normalized.advancement_policy ?? 'manual'
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
  const selectedNode = normalized.nodes.find(node => node.id === selectedNodeId) ?? null
  const selectedStageRule = stageRules.find(rule => rule.id === selectedNode?.automation_rule_id)
  const selectedStageRobotMode =
    Boolean(selectedStageRule) || Boolean(selectedNode && robotModeNodeIds.has(selectedNode.id))
  const nodesValid =
    normalized.nodes.length > 0 &&
    normalized.nodes.every(node => node.name.trim() && node.depends_on.every(Boolean)) &&
    normalized.nodes
      .filter(node => node.node_type === 'wait')
      .every(node => {
        const rules = node.wait_config?.rules ?? []
        const hasRerun = rules.some(rule => rule.action === 'rerun')
        return (
          rules.length > 0 &&
          rules.every(rule => rule.event_type.trim()) &&
          (!hasRerun || Boolean(node.wait_config?.agent_id))
        )
      })
  const canSave =
    (currentStageMode === 'none' || nodesValid) &&
    (currentAdvancementPolicy === 'manual' || Boolean(normalized.ai_automation_rule_id))

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
  const appendNode = useCallback(
    (newNode: WorkflowNodeDefinition) => {
      const nodes = value.nodes
      const previous = nodes[nodes.length - 1]
      const inserted: WorkflowNodeDefinition = {
        ...newNode,
        depends_on: previous ? [previous.id] : [],
        dependency_context: previous ? { [previous.id]: [...DEFAULT_DEPENDENCY_CONTEXT] } : {},
      }
      updateDefinition({
        stage_mode: 'dag',
        nodes: [...nodes, inserted],
      })
      setSelectedNodeId(inserted.id)
    },
    [updateDefinition, value.nodes]
  )
  const addNode = () => {
    const id = nextNodeId(value.nodes, 'stage')
    const stageNumber = Number(id.replace('stage-', ''))
    appendNode(
      createStageNode(
        id,
        t('todo.workflow_new_stage_numbered', '新阶段 {{number}}', {
          number: stageNumber,
        }),
        [],
        {}
      )
    )
  }
  const addWaitNode = () => {
    const id = nextNodeId(value.nodes, 'wait')
    const waitNumber = Number(id.replace('wait-', ''))
    appendNode(
      createWaitNode(
        id,
        t('todo.workflow_new_wait_numbered', '新等待 {{number}}', {
          number: waitNumber,
        }),
        [],
        {}
      )
    )
  }
  const insertNode = useCallback(
    (selectedId: string, direction: StageInsertionDirection) => {
      const selectedIndex = value.nodes.findIndex(node => node.id === selectedId)
      if (selectedIndex < 0) return
      const selected = value.nodes[selectedIndex]
      const id = nextNodeId(value.nodes, 'stage')
      const stageNumber = Number(id.replace('stage-', ''))
      const name = t('todo.workflow_new_stage_numbered', '新阶段 {{number}}', {
        number: stageNumber,
      })

      if (direction === 'before') {
        const inserted = createStageNode(
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
        const inserted = createStageNode(id, name, [selectedId], {
          [selectedId]: [...DEFAULT_DEPENDENCY_CONTEXT],
        })
        const rewiredNodes = value.nodes.map(node => rewireDependency(node, selectedId, id))
        rewiredNodes.splice(selectedIndex + 1, 0, inserted)
        updateDefinition({ stage_mode: 'dag', nodes: rewiredNodes })
      }
      setSelectedEdge(null)
      setSelectedNodeId(id)
    },
    [t, updateDefinition, value.nodes]
  )
  const spliceOutNode = useCallback(
    (nodes: WorkflowNodeDefinition[], removedId: string): WorkflowNodeDefinition[] => {
      const removed = nodes.find(node => node.id === removedId)
      if (!removed) return nodes
      const removedDependencies = removed.depends_on
      return nodes
        .filter(node => node.id !== removedId)
        .map(node => {
          if (!node.depends_on.includes(removedId)) return node
          const nextDependencies = Array.from(
            new Set([...removedDependencies, ...node.depends_on.filter(dep => dep !== removedId)])
          ).filter(dep => dep !== node.id)
          const nextContext = { ...(node.dependency_context ?? {}) }
          delete nextContext[removedId]
          for (const dependency of removedDependencies) {
            if (dependency === node.id) continue
            nextContext[dependency] = dependencyContext(removed, dependency)
          }
          return {
            ...node,
            depends_on: nextDependencies,
            dependency_context: nextContext,
          }
        })
    },
    []
  )
  const removeNode = useCallback(
    (id: string) => {
      const target = value.nodes.find(node => node.id === id)
      if (!target) return
      const remainingNodes = spliceOutNode(value.nodes, id)
      updateDefinition({
        nodes: remainingNodes,
      })
      if (selectedNodeId === id) setSelectedNodeId(remainingNodes[0]?.id ?? null)
      if (selectedEdge?.source === id || selectedEdge?.target === id) setSelectedEdge(null)
    },
    [selectedEdge, selectedNodeId, spliceOutNode, updateDefinition, value.nodes]
  )
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

  const graph = useMemo(() => {
    const edges: WorkflowFlowEdge[] = normalized.nodes.flatMap(node =>
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
    const nodes: EditorFlowNode[] = normalized.nodes.map((node, index) => {
      const automationRule = stageRules.find(rule => rule.id === node.automation_rule_id)
      return {
        id: node.id,
        type: node.node_type ?? 'stage',
        position: { x: 0, y: 0 },
        selected: node.id === selectedNodeId,
        data: {
          node,
          index,
          nodeWidth: STAGE_NODE_WIDTH,
          nodeHeight: STAGE_NODE_HEIGHT,
          actionLabel: automationRule
            ? t('todo.workflow_stage_robot_named', '机器人：{{name}}', {
                name: automationRule.agentName || automationRule.name,
              })
            : node.node_type === 'wait'
              ? t('todo.workflow_wait_node_action', '等待外部事件')
              : t('todo.workflow_stage_human_execution', '人工执行'),
          dependencyCount: node.depends_on.length,
          canInsertBefore: true,
          canInsertAfter: true,
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
      }) as EditorFlowNode[],
    }
  }, [insertNode, normalized.nodes, selectedEdge, selectedNodeId, stageRules, t])

  const flowInstanceRef = useRef<ReactFlowInstance<EditorFlowNode, WorkflowFlowEdge> | null>(null)
  useEffect(() => {
    const instance = flowInstanceRef.current
    if (!instance) return
    const frame = requestAnimationFrame(() => {
      void instance.fitView({ padding: 0.25, maxZoom: 1 })
    })
    return () => cancelAnimationFrame(frame)
  }, [normalized.nodes.length])

  const handleConnect = useCallback(
    (connection: Connection) => {
      const { source, target } = connection
      if (!source || !target) return
      const sourceNode = value.nodes.find(node => node.id === source)
      const targetNode = value.nodes.find(node => node.id === target)
      if (!sourceNode || !targetNode) return
      const dependencies = new Map(value.nodes.map(node => [node.id, node.depends_on]))
      if (wouldCreateWorkflowCycle(source, target, dependencies)) return
      if (targetNode.depends_on.includes(source)) return
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

  const handleDelete = useCallback(
    ({ nodes, edges }: { nodes: Node[]; edges: Edge[] }) => {
      const removedNodeIds = new Set(
        nodes
          .filter(node => value.nodes.some(candidate => candidate.id === node.id))
          .map(node => node.id)
      )
      const removedEdges = new Set(edges.map(edge => `${edge.source}-${edge.target}`))
      let nextNodes = value.nodes
      for (const removedId of removedNodeIds) {
        nextNodes = spliceOutNode(nextNodes, removedId)
      }
      updateDefinition({
        nodes: nextNodes.map(node => {
          const shouldRemoveDependency = (dependency: string) =>
            removedEdges.has(`${dependency}-${node.id}`)
          if (!node.depends_on.some(shouldRemoveDependency)) return node
          return {
            ...node,
            depends_on: node.depends_on.filter(dependency => !shouldRemoveDependency(dependency)),
            dependency_context: Object.fromEntries(
              Object.entries(node.dependency_context ?? {}).filter(
                ([dependency]) => !shouldRemoveDependency(dependency)
              )
            ),
          }
        }),
      })
      setSelectedNodeId(null)
      setSelectedEdge(null)
    },
    [spliceOutNode, updateDefinition, value.nodes]
  )

  const selectStageExecutor = async (node: WorkflowNodeDefinition, agentId: string) => {
    if (!agentId) {
      updateNode(node.id, {
        automation_rule_id: null,
        workspace_policy: node.workspace_policy === 'none' ? 'composer' : node.workspace_policy,
      })
      return
    }
    if (!onEnsureStageRobotRule) return
    const revertToHumanExecution = () => {
      setRobotModeNodeIds(current => {
        const next = new Set(current)
        next.delete(node.id)
        return next
      })
      updateNode(node.id, {
        automation_rule_id: null,
        workspace_policy: node.workspace_policy === 'none' ? 'composer' : node.workspace_policy,
      })
    }
    setStageRobotBusyId(node.id)
    try {
      const ruleId = await onEnsureStageRobotRule(agentId)
      if (!ruleId) {
        revertToHumanExecution()
        return
      }
      updateNode(node.id, {
        automation_rule_id: ruleId,
        workspace_policy: 'none',
      })
    } catch {
      revertToHumanExecution()
    } finally {
      setStageRobotBusyId(null)
    }
  }
  const selectStageExecutionMode = (node: WorkflowNodeDefinition, mode: 'human' | 'robot') => {
    setRobotModeNodeIds(current => {
      const next = new Set(current)
      if (mode === 'robot') next.add(node.id)
      else next.delete(node.id)
      return next
    })
    if (mode === 'human') void selectStageExecutor(node, '')
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
                  value={normalized.ai_automation_rule_id ?? ''}
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
              value={normalized.coordinator_prompt ?? ''}
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
            <div className="flex items-center gap-1">
              <button
                type="button"
                data-testid="project-workflow-add-wait"
                onClick={addWaitNode}
                className="flex h-8 items-center gap-1 rounded-lg px-2.5 text-sm text-text-secondary hover:bg-muted"
              >
                <Hourglass className="h-3.5 w-3.5" />
                {t('todo.workflow_add_wait_node', '添加等待节点')}
              </button>
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
          </div>
          <div className="grid min-h-[420px] overflow-hidden rounded-xl border border-border bg-muted/20 lg:grid-cols-[minmax(0,1fr)_300px]">
            <div className="h-[420px]" data-testid="project-workflow-dag">
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
                onDelete={handleDelete}
                minZoom={0.35}
                maxZoom={1.5}
                nodesDraggable={false}
                deleteKeyCode={['Backspace', 'Delete']}
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
                  source={normalized.nodes.find(node => node.id === selectedEdge.source)}
                  target={normalized.nodes.find(node => node.id === selectedEdge.target)}
                  contextSources={
                    normalized.nodes.find(node => node.id === selectedEdge.target)
                      ?.dependency_context?.[selectedEdge.source] ?? DEFAULT_DEPENDENCY_CONTEXT
                  }
                  onChange={sources => {
                    const targetNode = normalized.nodes.find(
                      node => node.id === selectedEdge.target
                    )
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
                selectedNode.node_type === 'wait' ? (
                  <WaitNodeInspector
                    node={selectedNode}
                    onUpdate={patch => updateNode(selectedNode.id, patch)}
                    onRemove={() => removeNode(selectedNode.id)}
                    externalEventCatalog={externalEventCatalog}
                    projectAgents={projectAgents}
                    onRequestCreateRobot={onRequestCreateRobot}
                  />
                ) : (
                  <StageInspector
                    node={selectedNode}
                    automationRule={selectedStageRule}
                    robotMode={selectedStageRobotMode}
                    robotBusy={stageRobotBusyId === selectedNode.id}
                    projectAgents={projectAgents}
                    dependencies={normalized.nodes}
                    onUpdate={patch => updateNode(selectedNode.id, patch)}
                    onRemove={() => removeNode(selectedNode.id)}
                    onRemoveDependency={dependencyId =>
                      removeDependency(dependencyId, selectedNode.id)
                    }
                    onSelectExecutor={agentId => void selectStageExecutor(selectedNode, agentId)}
                    onSelectExecutionMode={mode => selectStageExecutionMode(selectedNode, mode)}
                    onRequestCreateRobot={onRequestCreateRobot}
                    onManageDeliverables={requirements =>
                      setDeliverableDialog({ nodeId: selectedNode.id, requirements })
                    }
                  />
                )
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
            const node = value.nodes.find(valueNode => valueNode.id === deliverableDialog.nodeId)
            if (!node) {
              setDeliverableDialog(null)
              return
            }
            const nextDefinition = {
              ...value,
              nodes: value.nodes.map(valueNode =>
                valueNode.id === node.id
                  ? { ...valueNode, required_deliverables: requirements }
                  : valueNode
              ),
            }
            onChange(nextDefinition)
            setDeliverableDialog(null)
            void onSave(nextDefinition)
          }}
        />
      ) : null}
    </section>
  )
}
