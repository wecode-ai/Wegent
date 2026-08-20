import dagre from '@dagrejs/dagre'
import type { Edge, Node } from '@xyflow/react'

interface LayoutOptions {
  nodeWidth: number
  nodeHeight: number
  rankSep?: number
  nodeSep?: number
}

export function layoutWorkflowGraph<NodeData extends Record<string, unknown>>(
  nodes: Node<NodeData>[],
  edges: Edge[],
  { nodeWidth, nodeHeight, rankSep = 80, nodeSep = 40 }: LayoutOptions
): Node<NodeData>[] {
  const graph = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}))
  graph.setGraph({
    rankdir: 'LR',
    ranksep: rankSep,
    nodesep: nodeSep,
    marginx: 28,
    marginy: 28,
  })
  nodes.forEach(node => graph.setNode(node.id, { width: nodeWidth, height: nodeHeight }))
  edges.forEach(edge => graph.setEdge(edge.source, edge.target))
  dagre.layout(graph)

  return nodes.map(node => {
    const position = graph.node(node.id)
    return {
      ...node,
      position: {
        x: position.x - nodeWidth / 2,
        y: position.y - nodeHeight / 2,
      },
    }
  })
}

export function wouldCreateWorkflowCycle(
  source: string,
  target: string,
  dependenciesByNode: Map<string, string[]>
): boolean {
  if (source === target) return true
  const visited = new Set<string>()
  const visit = (nodeId: string): boolean => {
    if (nodeId === target) return true
    if (visited.has(nodeId)) return false
    visited.add(nodeId)
    return (dependenciesByNode.get(nodeId) ?? []).some(visit)
  }
  return visit(source)
}
