import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  BaseEdge,
  Background,
  Handle,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  SelectionMode,
  getBezierPath,
  useNodesState,
  useReactFlow,
  useViewport,
} from '@xyflow/react'
import {
  Box,
  ChevronRight,
  Clock3,
  Focus,
  GitBranch,
  Hand,
  Minus,
  MousePointer2,
  Plus,
  Sparkles,
  Webhook,
} from 'lucide-react'
import { automationClass } from './automationStyles'

const OUTER_NODE_WIDTH = 300
const OUTER_NODE_HEIGHT = 88
const OUTER_NODE_GAP = 120
const DYNAMIC_NODE_WIDTH = 300
const DYNAMIC_NODE_HEIGHT = 132
const GROUP_MIN_WIDTH = 560
const GROUP_HEADER_HEIGHT = 88
const STAGE_WIDTH = 150
const STAGE_HEIGHT = 66

const HorizontalHandles = ({ hidden = true }) => (
  <>
    <Handle
      type="target"
      position={Position.Left}
      className={automationClass(hidden ? 'automation-hidden-handle' : 'automation-node-handle')}
    />
    <Handle
      type="source"
      position={Position.Right}
      className={automationClass(hidden ? 'automation-hidden-handle' : 'automation-node-handle')}
    />
  </>
)

const WorkflowNodeInsertControl = memo(function WorkflowNodeInsertControl({
  nodeId,
  placement,
  onAddTask,
  onAddDynamic,
}) {
  const [open, setOpen] = useState(false)
  const placementLabel = placement === 'before' ? '之前' : '之后'

  return (
    <div
      className={automationClass(`workflow-node-insert ${placement}`)}
      onPointerDown={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()}
    >
      <button
        type="button"
        className={automationClass('workflow-node-insert-trigger nodrag nopan')}
        data-testid={`automation-node-insert-${placement}-${nodeId}`}
        aria-label={`在当前节点${placementLabel}添加流程节点`}
        aria-expanded={open}
        onClick={() => setOpen(current => !current)}
      >
        <Plus size={16} />
      </button>
      {open ? (
        <div className={automationClass(`workflow-node-insert-menu nodrag nopan ${placement}`)}>
          <button
            type="button"
            data-testid={`automation-node-insert-${placement}-task-${nodeId}`}
            onClick={() => {
              onAddTask()
              setOpen(false)
            }}
          >
            <Box size={14} />
            执行任务
          </button>
          <button
            type="button"
            data-testid={`automation-node-insert-${placement}-dynamic-${nodeId}`}
            onClick={() => {
              onAddDynamic()
              setOpen(false)
            }}
          >
            <Sparkles size={14} />
            AI 动态分配
          </button>
        </div>
      ) : null}
    </div>
  )
})

const WorkflowNodeInsertControls = memo(function WorkflowNodeInsertControls({
  nodeId,
  allowBefore = true,
  onInsert,
}) {
  return (
    <>
      {allowBefore ? (
        <WorkflowNodeInsertControl
          nodeId={nodeId}
          placement="before"
          onAddTask={() => onInsert('before', 'task')}
          onAddDynamic={() => onInsert('before', 'dynamic')}
        />
      ) : null}
      <WorkflowNodeInsertControl
        nodeId={nodeId}
        placement="after"
        onAddTask={() => onInsert('after', 'task')}
        onAddDynamic={() => onInsert('after', 'dynamic')}
      />
    </>
  )
})

const TriggerCanvasNode = memo(function TriggerCanvasNode({ data }) {
  const TriggerIcon = data.triggerType === 'schedule' ? Clock3 : Webhook
  return (
    <article className={automationClass(`workflow-node-shell ${data.selected ? 'selected' : ''}`)}>
      <HorizontalHandles />
      <button
        type="button"
        className={automationClass(`flow-node trigger ${data.selected ? 'selected' : ''}`)}
        data-testid="automation-trigger-node"
        onClick={data.onSelect}
      >
        <span className={automationClass('node-icon trigger')}>
          <TriggerIcon size={17} />
        </span>
        <span className={automationClass('flow-node-copy')}>
          <small>触发规则</small>
          <strong>{data.title}</strong>
          <span>{data.meta}</span>
        </span>
        <ChevronRight size={14} />
      </button>
      <WorkflowNodeInsertControls nodeId="trigger" allowBefore={false} onInsert={data.onInsert} />
    </article>
  )
})

function executionSummary(environment, model) {
  const normalizedEnvironment = /^(Local Executor|本机执行器)(\s*·.*)?$/i.test(environment)
    ? '本机'
    : environment.replace(/\s*·\s*(在线|忙碌)$/, '')
  return [normalizedEnvironment, model].filter(Boolean).join(' · ') || '尚未配置执行环境'
}

const ExecutionCanvasNode = memo(function ExecutionCanvasNode({ data }) {
  return (
    <article className={automationClass(`workflow-node-shell ${data.selected ? 'selected' : ''}`)}>
      <HorizontalHandles />
      <button
        type="button"
        className={automationClass(`flow-node step ${data.selected ? 'selected' : ''}`)}
        data-testid={`execution-node-${data.step.id}`}
        onClick={data.onSelect}
      >
        <span className={automationClass('node-icon step')}>
          <Box size={17} />
        </span>
        <span className={automationClass('flow-node-copy')}>
          <small>{data.step.executionMode === 'automatic' ? '自动执行' : '手动执行'}</small>
          <strong>{data.step.name || '未命名执行节点'}</strong>
          <span>
            {data.step.executionMode === 'automatic'
              ? executionSummary(data.step.environment, data.step.model)
              : '由成员手动完成'}
          </span>
        </span>
        <ChevronRight size={14} />
      </button>
      <WorkflowNodeInsertControls nodeId={data.step.id} onInsert={data.onInsert} />
    </article>
  )
})

const DynamicCanvasNode = memo(function DynamicCanvasNode({ data }) {
  return (
    <article
      className={automationClass(`workflow-node-shell ${data.selected ? 'selected' : ''}`)}
      data-testid={`ai-allocation-node-${data.step.id}`}
    >
      <HorizontalHandles />
      <div className={automationClass(`dynamic-flow-node ${data.selected ? 'selected' : ''}`)}>
        <button
          type="button"
          className={automationClass('dynamic-node-main')}
          onClick={data.onSelect}
        >
          <span className={automationClass('node-icon coordinator')}>
            <Sparkles size={17} />
          </span>
          <span className={automationClass('flow-node-copy')}>
            <small>AI 动态分配 · 无约束</small>
            <strong>{data.step.name}</strong>
            <span>{executionSummary(data.step.environment, data.step.model)}</span>
          </span>
        </button>
        <button
          type="button"
          className={automationClass('dynamic-node-add-stage nodrag nopan')}
          data-testid={`dag-stage-add-first-${data.step.id}`}
          aria-label="添加第一个阶段"
          onClick={data.onAddFirstStage}
        >
          <GitBranch size={13} />
          添加编排约束
        </button>
      </div>
      <WorkflowNodeInsertControls nodeId={data.step.id} onInsert={data.onInsert} />
    </article>
  )
})

const DynamicGroupCanvasNode = memo(function DynamicGroupCanvasNode({ data }) {
  return (
    <section
      className={automationClass(`react-flow-dynamic-group ${data.selected ? 'selected' : ''}`)}
      data-testid={`ai-allocation-node-${data.step.id}`}
    >
      <HorizontalHandles />
      <WorkflowNodeInsertControls nodeId={data.step.id} onInsert={data.onInsert} />
      <button
        type="button"
        className={automationClass('react-flow-group-header')}
        onClick={data.onSelect}
      >
        <span className={automationClass('node-icon coordinator')}>
          <Sparkles size={17} />
        </span>
        <span>
          <small>AI 动态分配 · DAG 子图</small>
          <strong>{data.step.name}</strong>
          <em>{executionSummary(data.step.environment, data.step.model)}</em>
        </span>
        <span className={automationClass('subgraph-count')}>
          {data.step.subgraph?.nodes.length ?? 0} 个节点
        </span>
      </button>
      <div className={automationClass('react-flow-group-label')}>
        <GitBranch size={12} />
        在画布中拖动阶段，或从连接点建立依赖
      </div>
    </section>
  )
})

const DagStageCanvasNode = memo(function DagStageCanvasNode({ data }) {
  return (
    <article
      className={automationClass(`react-flow-stage-node ${data.selected ? 'selected' : ''}`)}
      data-testid={`dag-stage-container-${data.stage.id}`}
    >
      <Handle
        type="target"
        position={Position.Left}
        className={automationClass('react-flow-stage-handle target')}
      />
      <button
        type="button"
        className={automationClass('react-flow-stage-main')}
        data-testid={`dag-stage-node-${data.stage.id}`}
        onClick={data.onSelect}
      >
        <span>{data.index + 1}</span>
        <span>
          <strong>{data.stage.name}</strong>
          <small>
            {data.stage.dependencies.length
              ? `依赖 ${data.stage.dependencies.length} 个节点`
              : data.stage.executionMode === 'automatic'
                ? executionSummary(data.stage.environment, data.stage.model)
                : '手动执行'}
          </small>
        </span>
      </button>
      <button
        type="button"
        className={automationClass('react-flow-stage-insert before nodrag nopan')}
        data-testid={`dag-stage-insert-before-${data.stage.id}`}
        aria-label={`在 ${data.stage.name} 前添加阶段`}
        onClick={event => {
          event.stopPropagation()
          data.onInsert('before')
        }}
      >
        <Plus size={12} />
      </button>
      <button
        type="button"
        className={automationClass('react-flow-stage-insert after nodrag nopan')}
        data-testid={`dag-stage-insert-after-${data.stage.id}`}
        aria-label={`在 ${data.stage.name} 后添加阶段`}
        onClick={event => {
          event.stopPropagation()
          data.onInsert('after')
        }}
      >
        <Plus size={12} />
      </button>
      <Handle
        type="source"
        position={Position.Right}
        className={automationClass('react-flow-stage-handle source')}
      />
    </article>
  )
})

const DifyStyleEdge = memo(function DifyStyleEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  selected,
}) {
  const [hovered, setHovered] = useState(false)
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition: Position.Right,
    targetX,
    targetY,
    targetPosition: Position.Left,
    curvature: 0.3,
  })

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke:
            selected || hovered ? 'rgb(var(--color-focus))' : 'rgb(var(--color-text-muted) / 0.58)',
          strokeWidth: selected || hovered ? 2.4 : 2,
          transition: 'stroke 120ms ease, stroke-width 120ms ease',
        }}
      />
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={18}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />
    </>
  )
})

const DifyConnectionLine = memo(function DifyConnectionLine({ fromX, fromY, toX, toY }) {
  const [edgePath] = getBezierPath({
    sourceX: fromX,
    sourceY: fromY,
    sourcePosition: Position.Right,
    targetX: toX,
    targetY: toY,
    targetPosition: Position.Left,
    curvature: 0.3,
  })
  return (
    <g>
      <path fill="none" stroke="rgb(var(--color-text-muted) / 0.58)" strokeWidth={2} d={edgePath} />
      <rect x={toX - 1} y={toY - 4} width={2} height={8} fill="rgb(var(--color-focus))" />
    </g>
  )
})

const nodeTypes = {
  trigger: TriggerCanvasNode,
  execution: ExecutionCanvasNode,
  dynamic: DynamicCanvasNode,
  dynamicGroup: DynamicGroupCanvasNode,
  dagStage: DagStageCanvasNode,
}

const edgeTypes = {
  dify: DifyStyleEdge,
}

const CANVAS_FIT_PADDING = {
  top: '72px',
  right: '96px',
  bottom: '72px',
  left: '260px',
}

const CanvasViewportControls = memo(function CanvasViewportControls() {
  const { fitView, zoomIn, zoomOut } = useReactFlow()
  const { zoom } = useViewport()

  return (
    <Panel position="bottom-right" className={automationClass('canvas-viewport-controls')}>
      <button
        type="button"
        aria-label="缩小画布"
        data-testid="automation-canvas-zoom-out"
        onClick={() => zoomOut({ duration: 160 })}
      >
        <Minus size={16} />
      </button>
      <span>{Math.round(zoom * 100)}%</span>
      <button
        type="button"
        aria-label="放大画布"
        data-testid="automation-canvas-zoom-in"
        onClick={() => zoomIn({ duration: 160 })}
      >
        <Plus size={14} />
      </button>
      <button
        type="button"
        aria-label="显示全部节点"
        data-testid="automation-canvas-fit-view"
        onClick={() => fitView({ duration: 240, padding: CANVAS_FIT_PADDING })}
      >
        <Focus size={16} />
      </button>
    </Panel>
  )
})

function focusedViewport(node, viewport, canvasRect, rightPanelInset) {
  const visibleCenter = {
    x: Math.max(0, canvasRect.width - rightPanelInset) / 2,
    y: canvasRect.height / 2,
  }
  const nodeWidth = node.measured?.width ?? node.width ?? node.style?.width ?? OUTER_NODE_WIDTH
  const nodeHeight = node.measured?.height ?? node.height ?? node.style?.height ?? OUTER_NODE_HEIGHT
  const nodeCenter = {
    x: node.position.x + nodeWidth / 2,
    y: node.position.y + nodeHeight / 2,
  }

  return {
    x: visibleCenter.x - nodeCenter.x * viewport.zoom,
    y: visibleCenter.y - nodeCenter.y * viewport.zoom,
    zoom: viewport.zoom,
  }
}

const CanvasNewNodeFocus = memo(function CanvasNewNodeFocus({
  canvasRef,
  outerNodes,
  rightPanelInset,
  selectedNode,
}) {
  const { getViewport, setViewport } = useReactFlow()
  const previousOuterNodeIds = useRef(new Set(outerNodes.map(node => node.id)))

  useLayoutEffect(() => {
    const previousIds = previousOuterNodeIds.current
    const addedNode =
      selectedNode.type === 'step' && !previousIds.has(selectedNode.id)
        ? outerNodes.find(node => node.id === selectedNode.id)
        : outerNodes.find(node => !previousIds.has(node.id))
    previousOuterNodeIds.current = new Set(outerNodes.map(node => node.id))
    if (!addedNode) return undefined

    const canvas = canvasRef.current
    if (!canvas) return undefined
    void setViewport(
      focusedViewport(addedNode, getViewport(), canvas.getBoundingClientRect(), rightPanelInset),
      { duration: 240 }
    )
    return undefined
  }, [canvasRef, getViewport, outerNodes, rightPanelInset, selectedNode, setViewport])

  return null
})

function createsCycle(nodes, sourceId, targetId) {
  if (sourceId === targetId) return true
  const dependencies = new Map(nodes.map(node => [node.id, node.dependencies]))
  const visited = new Set()
  const visit = stageId => {
    if (stageId === targetId) return true
    if (visited.has(stageId)) return false
    visited.add(stageId)
    return (dependencies.get(stageId) ?? []).some(visit)
  }
  return visit(sourceId)
}

export function AutomationWorkflowCanvas({
  draft,
  trigger,
  selectedNode,
  rightPanelInset,
  onSelectNode,
  onInsertNode,
  onAddDagStage,
  onToggleDagDependency,
  onMoveDagStage,
  onToggleStepDependency,
  onMoveStep,
}) {
  const [interactionMode, setInteractionMode] = useState('pointer')
  const canvasRef = useRef(null)

  const graph = useMemo(() => {
    const nodes = []
    const edges = []
    const centerY = 270
    const stepIds = new Set(draft.steps.map(step => step.id))

    nodes.push({
      id: 'trigger',
      type: 'trigger',
      position: {
        x: 80,
        y: centerY - OUTER_NODE_HEIGHT / 2,
      },
      data: {
        triggerType: draft.trigger.type,
        title: trigger.label,
        meta: trigger.detail,
        selected: selectedNode.type === 'trigger',
        onSelect: () => onSelectNode({ type: 'trigger' }),
        onInsert: (placement, kind) => onInsertNode(null, placement, kind),
      },
      style: { width: OUTER_NODE_WIDTH, height: OUTER_NODE_HEIGHT },
    })

    draft.steps.forEach((step, index) => {
      const stepX = Number.isFinite(step.x) ? step.x : 440 + index * 420
      const stepY = Number.isFinite(step.y) ? step.y : centerY - OUTER_NODE_HEIGHT / 2

      if (step.kind === 'dynamic') {
        const subgraphNodes = step.subgraph?.nodes ?? []
        const selected =
          (selectedNode.type === 'step' && selectedNode.id === step.id) ||
          (selectedNode.type === 'dagStage' && selectedNode.stepId === step.id)
        if (subgraphNodes.length === 0) {
          nodes.push({
            id: step.id,
            type: 'dynamic',
            position: {
              x: stepX,
              y: stepY,
            },
            data: {
              step,
              selected,
              onSelect: () => onSelectNode({ type: 'step', id: step.id }),
              onInsert: (placement, kind) => onInsertNode(step.id, placement, kind),
              onAddFirstStage: () => onAddDagStage(step.id),
            },
            style: { width: DYNAMIC_NODE_WIDTH, height: DYNAMIC_NODE_HEIGHT },
          })
        } else {
          const graphWidth = Math.max(
            GROUP_MIN_WIDTH,
            ...subgraphNodes.map(stage => (stage.x ?? 0) + STAGE_WIDTH + 40)
          )
          const graphHeight = Math.max(
            280,
            ...subgraphNodes.map(stage => (stage.y ?? 0) + STAGE_HEIGHT + 36)
          )
          const groupHeight = GROUP_HEADER_HEIGHT + graphHeight
          nodes.push({
            id: step.id,
            type: 'dynamicGroup',
            position: {
              x: stepX,
              y: stepY,
            },
            data: {
              step,
              selected,
              onSelect: () => onSelectNode({ type: 'step', id: step.id }),
              onInsert: (placement, kind) => onInsertNode(step.id, placement, kind),
            },
            style: { width: graphWidth, height: groupHeight },
          })

          subgraphNodes.forEach((stage, stageIndex) => {
            const stageNodeId = `dag:${step.id}:${stage.id}`
            nodes.push({
              id: stageNodeId,
              type: 'dagStage',
              parentId: step.id,
              extent: 'parent',
              position: {
                x: (stage.x ?? 0) + 20,
                y: (stage.y ?? 0) + GROUP_HEADER_HEIGHT,
              },
              data: {
                stepId: step.id,
                stage,
                index: stageIndex,
                selected:
                  selectedNode.type === 'dagStage' &&
                  selectedNode.stepId === step.id &&
                  selectedNode.stageId === stage.id,
                onSelect: () =>
                  onSelectNode({ type: 'dagStage', stepId: step.id, stageId: stage.id }),
                onInsert: placement => onAddDagStage(step.id, stage.id, placement),
              },
              style: { width: STAGE_WIDTH, height: STAGE_HEIGHT },
            })
          })

          subgraphNodes.forEach(stage => {
            stage.dependencies.forEach(dependencyId => {
              edges.push({
                id: `dag-edge:${step.id}:${dependencyId}:${stage.id}`,
                source: `dag:${step.id}:${dependencyId}`,
                target: `dag:${step.id}:${stage.id}`,
                type: 'dify',
                data: {
                  kind: 'dag',
                  stepId: step.id,
                  sourceStageId: dependencyId,
                  targetStageId: stage.id,
                },
              })
            })
          })
        }
      } else {
        nodes.push({
          id: step.id,
          type: 'execution',
          position: {
            x: stepX,
            y: stepY,
          },
          data: {
            step,
            selected: selectedNode.type === 'step' && selectedNode.id === step.id,
            onSelect: () => onSelectNode({ type: 'step', id: step.id }),
            onInsert: (placement, kind) => onInsertNode(step.id, placement, kind),
          },
          style: { width: OUTER_NODE_WIDTH, height: OUTER_NODE_HEIGHT },
        })
      }

      const dependencies = step.dependencies.filter(dependencyId => stepIds.has(dependencyId))
      const sources = dependencies.length ? dependencies : ['trigger']
      sources.forEach(sourceId => {
        edges.push({
          id: `outer-edge:${sourceId}:${step.id}`,
          source: sourceId,
          target: step.id,
          type: 'dify',
          selectable: sourceId !== 'trigger',
          data: {
            kind: sourceId === 'trigger' ? 'trigger' : 'outerDependency',
            sourceStepId: sourceId,
            targetStepId: step.id,
          },
        })
      })
    })

    return { nodes, edges }
  }, [
    draft,
    onAddDagStage,
    onInsertNode,
    onSelectNode,
    selectedNode,
    trigger.detail,
    trigger.label,
  ])

  const [nodes, setNodes, onNodesChange] = useNodesState(graph.nodes)

  useEffect(() => {
    setNodes(currentNodes => {
      const currentById = new Map(currentNodes.map(node => [node.id, node]))
      return graph.nodes.map(node => {
        const current = currentById.get(node.id)
        if (!current) return node

        const authoredStageMoved =
          node.type === 'dagStage' &&
          (node.data.stage.x !== current.data.stage.x || node.data.stage.y !== current.data.stage.y)

        return {
          ...node,
          position: authoredStageMoved ? node.position : current.position,
          selected: current.selected,
          dragging: current.dragging,
        }
      })
    })
  }, [graph.nodes, setNodes])

  const onNodeDragStop = useCallback(
    (_, node) => {
      if (node.type === 'dagStage') {
        const { stepId, stage } = node.data
        onMoveDagStage(
          stepId,
          stage.id,
          Math.max(0, Math.round(node.position.x - 20)),
          Math.max(0, Math.round(node.position.y - GROUP_HEADER_HEIGHT))
        )
        return
      }
      if (node.type === 'execution' || node.type === 'dynamic' || node.type === 'dynamicGroup') {
        onMoveStep(node.id, Math.round(node.position.x), Math.round(node.position.y))
      }
    },
    [onMoveDagStage, onMoveStep]
  )

  const onConnect = useCallback(
    connection => {
      const sourceNode = nodes.find(node => node.id === connection.source)
      const targetNode = nodes.find(node => node.id === connection.target)
      if (
        sourceNode?.type === 'dagStage' &&
        targetNode?.type === 'dagStage' &&
        sourceNode.data.stepId === targetNode.data.stepId
      ) {
        const step = draft.steps.find(item => item.id === sourceNode.data.stepId)
        const subgraphNodes = step?.subgraph?.nodes ?? []
        if (
          !step ||
          createsCycle(subgraphNodes, sourceNode.data.stage.id, targetNode.data.stage.id) ||
          targetNode.data.stage.dependencies.includes(sourceNode.data.stage.id)
        ) {
          return
        }
        onToggleDagDependency(step.id, targetNode.data.stage.id, sourceNode.data.stage.id)
        return
      }
      if (
        sourceNode?.type !== 'execution' &&
        sourceNode?.type !== 'dynamic' &&
        sourceNode?.type !== 'dynamicGroup'
      ) {
        return
      }
      if (
        targetNode?.type !== 'execution' &&
        targetNode?.type !== 'dynamic' &&
        targetNode?.type !== 'dynamicGroup'
      ) {
        return
      }
      const targetStep = draft.steps.find(step => step.id === targetNode.id)
      if (
        !targetStep ||
        createsCycle(draft.steps, sourceNode.id, targetNode.id) ||
        targetStep.dependencies.includes(sourceNode.id)
      ) {
        return
      }
      onToggleStepDependency(targetNode.id, sourceNode.id)
    },
    [draft.steps, nodes, onToggleDagDependency, onToggleStepDependency]
  )

  const onEdgesDelete = useCallback(
    edges => {
      edges.forEach(edge => {
        if (edge.data?.kind === 'dag') {
          onToggleDagDependency(edge.data.stepId, edge.data.targetStageId, edge.data.sourceStageId)
        }
        if (edge.data?.kind === 'outerDependency') {
          onToggleStepDependency(edge.data.targetStepId, edge.data.sourceStepId)
        }
      })
    },
    [onToggleDagDependency, onToggleStepDependency]
  )

  return (
    <div
      ref={canvasRef}
      className={automationClass('react-flow-workflow-canvas')}
      data-testid="automation-workflow-canvas"
      onClick={event => {
        if (
          event.target instanceof Element &&
          event.target.closest(
            '.react-flow__node, .react-flow__edge, .react-flow__panel, .react-flow__minimap'
          )
        ) {
          return
        }
        onSelectNode({ type: 'none' })
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={graph.edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        onEdgesDelete={onEdgesDelete}
        connectionLineComponent={DifyConnectionLine}
        nodesDraggable
        nodesConnectable
        elementsSelectable
        onlyRenderVisibleElements
        panOnDrag={interactionMode === 'hand' ? true : [1, 2]}
        panOnScroll
        panOnScrollSpeed={0.72}
        selectionOnDrag={interactionMode === 'pointer'}
        selectionMode={SelectionMode.Partial}
        zoomOnScroll={false}
        zoomOnPinch
        zoomOnDoubleClick={false}
        minZoom={0.25}
        maxZoom={1.8}
        defaultViewport={{ x: 176, y: 136, zoom: 0.99 }}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={['Backspace', 'Delete']}
      >
        <CanvasNewNodeFocus
          canvasRef={canvasRef}
          outerNodes={graph.nodes.filter(node => node.id !== 'trigger' && !node.parentId)}
          rightPanelInset={rightPanelInset}
          selectedNode={selectedNode}
        />
        <Background
          variant="dots"
          gap={[18, 18]}
          size={1.2}
          color="rgb(var(--color-text-muted) / 0.28)"
        />
        <Panel position="top-left" className={automationClass('canvas-mode-controls')}>
          <button
            type="button"
            className={automationClass(
              'canvas-mode-button',
              interactionMode === 'pointer' && 'active'
            )}
            aria-label="选择节点"
            data-testid="automation-canvas-pointer-mode"
            onClick={() => setInteractionMode('pointer')}
          >
            <MousePointer2 size={16} />
          </button>
          <button
            type="button"
            className={automationClass(
              'canvas-mode-button',
              interactionMode === 'hand' && 'active'
            )}
            aria-label="移动画布"
            data-testid="automation-canvas-hand-mode"
            onClick={() => setInteractionMode('hand')}
          >
            <Hand size={16} />
          </button>
        </Panel>
        <MiniMap
          className={automationClass('canvas-minimap')}
          pannable
          zoomable
          position="bottom-right"
          nodeColor={node =>
            node.type === 'trigger'
              ? 'rgb(var(--color-focus))'
              : node.type === 'dynamicGroup'
                ? 'rgb(var(--color-text-secondary) / 0.5)'
                : 'rgb(var(--color-text-muted) / 0.5)'
          }
          maskColor="rgb(var(--color-bg-base) / 0.76)"
        />
        <CanvasViewportControls />
      </ReactFlow>
    </div>
  )
}
