// Shared canvas geometry for the automation rule editor. Both the workflow
// canvas (React Flow node sizes) and the draft editor (insertion coordinates)
// derive their numbers from this module so a node that grows (loop, dynamic
// group, branch) is never overlapped by a node inserted to its right.

export const OUTER_NODE_WIDTH = 300
export const OUTER_NODE_HEIGHT = 88
export const OUTER_NODE_GAP = 120
export const DYNAMIC_NODE_WIDTH = 300
export const DYNAMIC_NODE_HEIGHT = 132
export const GROUP_MIN_WIDTH = 560
export const GROUP_HEADER_HEIGHT = 88
export const LOOP_HEADER_HEIGHT = 80
export const STAGE_WIDTH = 150
export const STAGE_HEIGHT = 66
export const LOOP_BODY_WIDTH = 168
export const LOOP_BODY_HEIGHT = 58
export const LOOP_MARKER_SIZE = 48
export const LOOP_BRANCH_WIDTH = 232
export const BRANCH_HEADER_HEIGHT = 46
export const BRANCH_ROW_HEIGHT = 30
export const BRANCH_FOOTER_HEIGHT = 32
export const BRANCH_VERTICAL_PADDING = 12
// Vertical gap between branch condition handlers stacked in a single column.
export const BRANCH_HANDLER_ROW_GAP = 28

interface BranchConditionRow {
  handlerNodeIds?: string[]
}

interface SizeStep {
  branchConditions?: BranchConditionRow[]
  handlerNodeIds?: string[]
}

export function branchNodeHeight(
  step: SizeStep,
  { footer = false }: { footer?: boolean } = {}
): number {
  const conditionRows = Math.max(1, (step.branchConditions ?? []).length)
  return (
    BRANCH_HEADER_HEIGHT +
    conditionRows * BRANCH_ROW_HEIGHT +
    BRANCH_VERTICAL_PADDING +
    (footer ? BRANCH_FOOTER_HEIGHT : 0)
  )
}

export function loopBodyNodeSize(step: SizeStep & { nodeType?: string }): {
  width: number
  height: number
} {
  if (step.nodeType === 'branch') {
    return { width: LOOP_BRANCH_WIDTH, height: branchNodeHeight(step) }
  }
  if (step.nodeType === 'loopStart' || step.nodeType === 'loopEnd') {
    return { width: LOOP_MARKER_SIZE, height: LOOP_MARKER_SIZE }
  }
  return { width: LOOP_BODY_WIDTH, height: LOOP_BODY_HEIGHT }
}

interface Positioned {
  x?: number | null
  y?: number | null
}

interface CanvasStep {
  kind?: string
  nodeType?: string
  branchConditions?: BranchConditionRow[]
  subgraph?: { nodes?: Array<Positioned & CanvasStep> } | null
}

export function stepCanvasSize(step: CanvasStep): { width: number; height: number } {
  if (step.kind === 'dynamic') {
    const subgraphNodes = step.subgraph?.nodes ?? []
    if (subgraphNodes.length === 0) {
      return { width: DYNAMIC_NODE_WIDTH, height: DYNAMIC_NODE_HEIGHT }
    }
    const graphWidth = Math.max(
      GROUP_MIN_WIDTH,
      ...subgraphNodes.map(stage => (stage.x ?? 0) + STAGE_WIDTH + 40)
    )
    const graphHeight = Math.max(
      280,
      ...subgraphNodes.map(stage => (stage.y ?? 0) + STAGE_HEIGHT + 36)
    )
    return { width: graphWidth, height: GROUP_HEADER_HEIGHT + graphHeight }
  }

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
    return { width: graphWidth, height: LOOP_HEADER_HEIGHT + graphHeight }
  }

  if (step.kind === 'branch') {
    return { width: OUTER_NODE_WIDTH, height: branchNodeHeight(step, { footer: true }) }
  }

  return { width: OUTER_NODE_WIDTH, height: OUTER_NODE_HEIGHT }
}
