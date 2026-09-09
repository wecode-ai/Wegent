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
  Hand,
  Minus,
  MousePointer2,
  Plus,
  Webhook,
} from 'lucide-react'
import { automationClass } from './automationStyles'
import { useTranslation } from '@/hooks/useTranslation'

const OUTER_NODE_WIDTH = 300
const OUTER_NODE_HEIGHT = 88
const OUTER_NODE_GAP = 120

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
        />
      ) : null}
      <WorkflowNodeInsertControl
        nodeId={nodeId}
        placement="after"
        onAddTask={() => onInsert('after', 'task')}
      />
    </>
  )
})

const TriggerCanvasNode = memo(function TriggerCanvasNode({ data }) {
  const { t } = useTranslation()
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
          <small>
            {t(
              data.advancement === 'ai'
                ? 'todo.automation_ai_entry'
                : 'todo.automation_trigger_entry'
            )}
          </small>
          <strong>{data.title}</strong>
          <span>{data.meta}</span>
        </span>
        <ChevronRight size={14} />
      </button>
      {!data.readOnly && (
        <WorkflowNodeInsertControls nodeId="trigger" allowBefore={false} onInsert={data.onInsert} />
      )}
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
      {!data.readOnly && (
        <WorkflowNodeInsertControls nodeId={data.step.id} onInsert={data.onInsert} />
      )}
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
  readOnly = false,
  trigger,
  selectedNode,
  rightPanelInset,
  onSelectNode,
  onInsertNode,
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
        readOnly,
        advancement: draft.advancement,
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

      nodes.push({
        id: step.id,
        type: 'execution',
        position: {
          x: stepX,
          y: stepY,
        },
        data: {
          readOnly,
          step,
          selected: selectedNode.type === 'step' && selectedNode.id === step.id,
          onSelect: () => onSelectNode({ type: 'step', id: step.id }),
          onInsert: (placement, kind) => onInsertNode(step.id, placement, kind),
        },
        style: { width: OUTER_NODE_WIDTH, height: OUTER_NODE_HEIGHT },
      })

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
  }, [draft, readOnly, onInsertNode, onSelectNode, selectedNode, trigger.detail, trigger.label])

  const [nodes, setNodes, onNodesChange] = useNodesState(graph.nodes)

  useEffect(() => {
    setNodes(currentNodes => {
      const currentById = new Map(currentNodes.map(node => [node.id, node]))
      return graph.nodes.map(node => {
        const current = currentById.get(node.id)
        if (!current) return node

        return {
          ...node,
          position: node.position,
          selected: current.selected,
          dragging: current.dragging,
        }
      })
    })
  }, [graph.nodes, setNodes])

  const onNodeDragStop = useCallback(
    (_event, node) => {
      if (node.type === 'execution')
        onMoveStep(node.id, Math.round(node.position.x), Math.round(node.position.y))
    },
    [onMoveStep]
  )

  const onConnect = useCallback(
    connection => {
      const sourceNode = nodes.find(node => node.id === connection.source)
      const targetNode = nodes.find(node => node.id === connection.target)
      if (
        draft.advancement !== 'ai' ||
        sourceNode?.type !== 'execution' ||
        targetNode?.type !== 'execution'
      )
        return
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
    [draft.advancement, draft.steps, nodes, onToggleStepDependency]
  )

  const onEdgesDelete = useCallback(
    edges => {
      if (draft.advancement !== 'ai') return
      edges.forEach(edge => {
        if (edge.data?.kind === 'outerDependency') {
          onToggleStepDependency(edge.data.targetStepId, edge.data.sourceStepId)
        }
      })
    },
    [draft.advancement, onToggleStepDependency]
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
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly && draft.advancement === 'ai'}
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
        deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
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
              : 'rgb(var(--color-text-muted) / 0.5)'
          }
          maskColor="rgb(var(--color-bg-base) / 0.76)"
        />
        <CanvasViewportControls />
      </ReactFlow>
    </div>
  )
}
