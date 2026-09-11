import dagre from "@dagrejs/dagre";
import type { Edge, Node } from "@xyflow/react";

interface LayoutOptions {
  nodeWidth: number;
  nodeHeight: number;
  rankSep?: number;
  nodeSep?: number;
  nodeSize?: (node: Node) => { width: number; height: number };
}

export function layoutWorkflowGraph<NodeType extends Node>(
  nodes: NodeType[],
  edges: Edge[],
  {
    nodeWidth,
    nodeHeight,
    rankSep = 80,
    nodeSep = 40,
    nodeSize,
  }: LayoutOptions,
): NodeType[] {
  const graph = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  graph.setGraph({
    rankdir: "LR",
    ranksep: rankSep,
    nodesep: nodeSep,
    marginx: 28,
    marginy: 28,
  });
  const sizes = new Map(
    nodes.map((node) => [
      node.id,
      nodeSize?.(node) ?? {
        width: nodeWidth,
        height: nodeHeight,
      },
    ]),
  );
  nodes.forEach((node) => graph.setNode(node.id, sizes.get(node.id)));
  edges.forEach((edge) => graph.setEdge(edge.source, edge.target));
  dagre.layout(graph);

  return nodes.map((node) => {
    const position = graph.node(node.id);
    const size = sizes.get(node.id) ?? { width: nodeWidth, height: nodeHeight };
    return {
      ...node,
      position: {
        x: position.x - size.width / 2,
        y: position.y - size.height / 2,
      },
    } as NodeType;
  });
}

export function wouldCreateWorkflowCycle(
  source: string,
  target: string,
  dependenciesByNode: Map<string, string[]>,
): boolean {
  if (source === target) return true;
  const visited = new Set<string>();
  const visit = (nodeId: string): boolean => {
    if (nodeId === target) return true;
    if (visited.has(nodeId)) return false;
    visited.add(nodeId);
    return (dependenciesByNode.get(nodeId) ?? []).some(visit);
  };
  return visit(source);
}
