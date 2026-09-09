import { nodeTypes } from './AutomationCanvasNodes.jsx'
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
  useStore,
  useViewport,
} from '@xyflow/react'
import {
  Box,
  ChevronRight,
  CircleDot,
  Clock3,
  Flag,
  Focus,
  GitBranch,
  Hand,
  Minus,
  MousePointer2,
  Plus,
  Repeat,
  Sparkles,
  Webhook,
} from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { automationClass } from './automationStyles'
import { canvasNodeIdToSelection, setCanvasEventBus, useCanvasEventBus } from './canvasEventBus'
import { eventTypeLabel } from './eventTypeLabel'
import {
  DYNAMIC_NODE_WIDTH,
  DYNAMIC_NODE_HEIGHT,
  GROUP_HEADER_HEIGHT,
  GROUP_MIN_WIDTH,
  LOOP_HEADER_HEIGHT,
  OUTER_NODE_HEIGHT,
  OUTER_NODE_WIDTH,
  STAGE_HEIGHT,
  STAGE_WIDTH,
  branchNodeHeight,
  loopBodyNodeSize,
} from './canvasGeometry'

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
  onAddBranchHandler,
  onAddBranchContinuation,
  onToggleStepDependency,
  onMoveStep,
  onInsertLoopBodyNode,
  onToggleLoopBodyDependency,
  onMoveLoopBodyNode,
  onDeleteNode,
}) {
  const [interactionMode, setInteractionMode] = useState('pointer')
  const canvasRef = useRef(null)
  const onSelectNodeRef = useRef(onSelectNode)
  onSelectNodeRef.current = onSelectNode

  useEffect(() => {
    setCanvasEventBus({ selectNode: selection => onSelectNodeRef.current(selection) })
  }, [])

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
        onSelect: () => onSelectNode({ type: 'trigger' }),
        onInsert: (placement, kind) => onInsertNode(null, placement, kind),
      },
      style: { width: OUTER_NODE_WIDTH, height: OUTER_NODE_HEIGHT },
    })

    draft.steps.forEach((step, index) => {
      const stepX = Number.isFinite(step.x) ? step.x : 440 + index * 420
      const stepY = Number.isFinite(step.y) ? step.y : centerY - OUTER_NODE_HEIGHT / 2

      if (step.kind === 'loop') {
        const bodySteps = step.subgraph?.nodes ?? []
        const graphWidth = Math.max(
          GROUP_MIN_WIDTH,
          ...bodySteps.map(bodyStep => (bodyStep.x ?? 0) + loopBodyNodeSize(bodyStep).width + 56)
        )
        const graphHeight = Math.max(
          220,
          ...bodySteps.map(bodyStep => (bodyStep.y ?? 0) + loopBodyNodeSize(bodyStep).height + 48)
        )
        const groupHeight = LOOP_HEADER_HEIGHT + graphHeight
        nodes.push({
          id: step.id,
          type: 'loopGroup',
          position: {
            x: stepX,
            y: stepY,
          },
          data: {
            readOnly,
            step,
            onSelect: () => onSelectNode({ type: 'step', id: step.id }),
            onInsert: (placement, kind) => onInsertNode(step.id, placement, kind),
          },
          style: { width: graphWidth, height: groupHeight },
        })
        bodySteps.forEach(bodyStep => {
          const bodyNodeId = `loop:${step.id}:${bodyStep.id}`
          const bodySize = loopBodyNodeSize(bodyStep)
          const bodyType =
            bodyStep.nodeType === 'branch'
              ? 'loopBranch'
              : bodyStep.nodeType === 'loopStart' || bodyStep.nodeType === 'loopEnd'
                ? 'loopMarker'
                : 'loopBody'
          nodes.push({
            id: bodyNodeId,
            type: bodyType,
            parentId: step.id,
            extent: 'parent',
            position: {
              x: (bodyStep.x ?? 0) + 20,
              y: (bodyStep.y ?? 0) + LOOP_HEADER_HEIGHT,
            },
            data: {
              readOnly,
              step: bodyStep,
              loopId: step.id,
              onSelect: () =>
                onSelectNode({ type: 'loopBody', loopId: step.id, bodyId: bodyStep.id }),
              onInsert: (placement, kind) =>
                onInsertLoopBodyNode(step.id, bodyStep.id, placement, kind),
              onAddBranchHandler,
            },
            style: { width: bodySize.width, height: bodySize.height },
          })
        })
        bodySteps.forEach(bodyStep => {
          ;(bodyStep.dependencies ?? []).forEach(dependencyId => {
            const dependency = bodySteps.find(candidate => candidate.id === dependencyId)
            if (!dependency || dependency.nodeType === 'branch') return
            edges.push({
              id: `loop-edge:${step.id}:${dependencyId}:${bodyStep.id}`,
              source: `loop:${step.id}:${dependencyId}`,
              target: `loop:${step.id}:${bodyStep.id}`,
              type: 'dify',
              data: {
                readOnly,
                kind: 'loopBody',
                loopId: step.id,
                sourceBodyId: dependencyId,
                targetBodyId: bodyStep.id,
              },
            })
          })
        })
        bodySteps
          .filter(bodyStep => bodyStep.nodeType === 'branch')
          .forEach(branchStep => {
            ;(branchStep.branchConditions ?? []).forEach((condition, conditionIndex) => {
              ;(condition.handlerNodeIds ?? []).forEach(handlerId => {
                if (!bodySteps.some(candidate => candidate.id === handlerId)) return
                edges.push({
                  id: `branch-edge:${step.id}:${branchStep.id}:${conditionIndex}:${handlerId}`,
                  source: `loop:${step.id}:${branchStep.id}`,
                  sourceHandle: `cond-${conditionIndex}`,
                  target: `loop:${step.id}:${handlerId}`,
                  type: 'dify',
                  selectable: false,
                  deletable: false,
                  data: { kind: 'branchHandler' },
                })
              })
            })
          })
      } else if (step.kind === 'branch') {
        nodes.push({
          id: step.id,
          type: 'branch',
          position: {
            x: stepX,
            y: stepY,
          },
          data: {
            readOnly,
            step,
            onSelect: () => onSelectNode({ type: 'step', id: step.id }),
            onAddBranchHandler,
            onAddBranchContinuation,
          },
          style: { width: OUTER_NODE_WIDTH, height: branchNodeHeight(step, { footer: true }) },
        })
      } else {
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
            onSelect: () => onSelectNode({ type: 'step', id: step.id }),
            onInsert: (placement, kind) => onInsertNode(step.id, placement, kind),
          },
          style: { width: OUTER_NODE_WIDTH, height: OUTER_NODE_HEIGHT },
        })
      }

      const dependencies = step.dependencies.filter(dependencyId => stepIds.has(dependencyId))
      const sources = dependencies.length ? dependencies : ['trigger']
      sources.forEach(sourceId => {
        const sourceStep = draft.steps.find(candidate => candidate.id === sourceId)
        if (sourceStep?.kind === 'branch') {
          const isConditionHandler = (sourceStep.branchConditions ?? []).some(condition =>
            (condition.handlerNodeIds ?? []).includes(step.id)
          )
          if (isConditionHandler) return
        }
        edges.push({
          id: `outer-edge:${sourceId}:${step.id}`,
          source: sourceId,
          sourceHandle: sourceStep?.kind === 'branch' ? 'default' : undefined,
          target: step.id,
          type: 'dify',
          selectable: sourceId !== 'trigger',
          data: {
            readOnly,
            kind: sourceId === 'trigger' ? 'trigger' : 'outerDependency',
            sourceStepId: sourceId,
            targetStepId: step.id,
          },
        })
      })
      if (step.kind === 'branch') {
        ;(step.branchConditions ?? []).forEach((condition, conditionIndex) => {
          ;(condition.handlerNodeIds ?? []).forEach(handlerId => {
            if (!stepIds.has(handlerId)) return
            edges.push({
              id: `branch-edge:${step.id}:${conditionIndex}:${handlerId}`,
              source: step.id,
              sourceHandle: `cond-${conditionIndex}`,
              target: handlerId,
              type: 'dify',
              selectable: false,
              deletable: false,
              data: { kind: 'branchHandler' },
            })
          })
        })
      }
    })

    return { nodes, edges }
  }, [
    draft,
    readOnly,
    onAddBranchContinuation,
    onAddBranchHandler,
    onInsertLoopBodyNode,
    onInsertNode,
    onSelectNode,
    trigger.detail,
    trigger.label,
  ])

  const [nodes, setNodes, onNodesChange] = useNodesState(graph.nodes)

  // Mirror the editor's selection model onto React Flow's native node
  // selection. Unchanged nodes keep object identity so only the two nodes
  // whose selection actually flips re-render.
  useEffect(() => {
    const selectedId =
      selectedNode.type === 'trigger'
        ? 'trigger'
        : selectedNode.type === 'step'
          ? selectedNode.id
          : selectedNode.type === 'dagStage'
            ? `dag:${selectedNode.stepId}:${selectedNode.stageId}`
            : selectedNode.type === 'loopBody'
              ? `loop:${selectedNode.loopId}:${selectedNode.bodyId}`
              : null
    setNodes(currentNodes =>
      currentNodes.map(node =>
        node.selected === (node.id === selectedId)
          ? node
          : { ...node, selected: node.id === selectedId }
      )
    )
  }, [selectedNode, setNodes])

  useEffect(() => {
    setNodes(currentNodes => {
      const currentById = new Map(currentNodes.map(node => [node.id, node]))
      return graph.nodes.map(node => {
        const current = currentById.get(node.id)
        if (!current) return node

        // The graph derived from the draft is the single source of truth for
        // node layout. React Flow only owns transient interaction state
        // (selection, drag-in-progress); never let its already-rendered
        // positions shadow an edited draft, otherwise newly inserted nodes
        // stack on top of pre-existing ones because the stale position wins.
        return {
          ...node,
          position: current.dragging ? current.position : node.position,
          selected: current.selected,
          dragging: current.dragging,
        }
      })
    })
  }, [graph.nodes, setNodes])

  const onNodeDragStop = useCallback(
    (_, node) => {
      if (node.type === 'loopBody' || node.type === 'loopBranch' || node.type === 'loopMarker') {
        node.data.onSelect?.()
        const { loopId, step } = node.data
        onMoveLoopBodyNode(
          loopId,
          step.id,
          Math.max(0, Math.round(node.position.x - 20)),
          Math.max(0, Math.round(node.position.y - LOOP_HEADER_HEIGHT))
        )
        return
      }
      if (node.type === 'execution' || node.type === 'loopGroup' || node.type === 'branch') {
        node.data.onSelect?.()
        onMoveStep(node.id, Math.round(node.position.x), Math.round(node.position.y))
      }
    },
    [onMoveLoopBodyNode, onMoveStep]
  )

  const onConnect = useCallback(
    connection => {
      const sourceNode = nodes.find(node => node.id === connection.source)
      const targetNode = nodes.find(node => node.id === connection.target)
      // Branch condition handles only route through settings; the default
      // handle carries the continuation dependency.
      if (sourceNode?.type === 'loopBranch') {
        return
      }
      if (sourceNode?.type === 'branch' && connection.sourceHandle !== 'default') {
        return
      }
      if (
        sourceNode?.type !== 'execution' &&
        sourceNode?.type !== 'branch' &&
        sourceNode?.type !== 'loopBranch' &&
        sourceNode?.type !== 'loopMarker' &&
        sourceNode?.type !== 'loopBody'
      ) {
        return
      }
      if (
        targetNode?.type !== 'execution' &&
        targetNode?.type !== 'branch' &&
        targetNode?.type !== 'loopBranch' &&
        targetNode?.type !== 'loopMarker' &&
        targetNode?.type !== 'loopBody'
      ) {
        return
      }
      if (
        (sourceNode?.type === 'loopBody' ||
          sourceNode?.type === 'loopBranch' ||
          sourceNode?.type === 'loopMarker') &&
        (targetNode?.type === 'loopBody' ||
          targetNode?.type === 'loopBranch' ||
          targetNode?.type === 'loopMarker') &&
        sourceNode.data.loopId === targetNode.data.loopId
      ) {
        const loop = draft.steps.find(item => item.id === sourceNode.data.loopId)
        const bodyNodes = loop?.subgraph?.nodes ?? []
        if (
          !loop ||
          createsCycle(bodyNodes, sourceNode.data.step.id, targetNode.data.step.id) ||
          targetNode.data.step.dependencies.includes(sourceNode.data.step.id)
        ) {
          return
        }
        onToggleLoopBodyDependency(loop.id, targetNode.data.step.id, sourceNode.data.step.id)
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
    [draft.advancement, draft.steps, nodes, onToggleLoopBodyDependency, onToggleStepDependency]
  )

  const onEdgesDelete = useCallback(
    edges => {
      edges.forEach(edge => {
        if (edge.data?.kind === 'loopBody') {
          onToggleLoopBodyDependency(
            edge.data.loopId,
            edge.data.targetBodyId,
            edge.data.sourceBodyId
          )
        }
        if (edge.data?.kind === 'outerDependency') {
          onToggleStepDependency(edge.data.targetStepId, edge.data.sourceStepId)
        }
      })
    },
    [draft.advancement, onToggleLoopBodyDependency, onToggleStepDependency]
  )

  const onNodesDelete = useCallback(
    nodes => {
      nodes.forEach(node => onDeleteNode(node))
    },
    [onDeleteNode]
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
        onNodeClick={(event, node) => {
          if (event.target instanceof Element && event.target.closest('.nodrag, .nopan')) {
            return
          }
          node.data.onSelect?.()
        }}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        onEdgesDelete={onEdgesDelete}
        onNodesDelete={onNodesDelete}
        connectionLineComponent={DifyConnectionLine}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
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
