// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { memo, useCallback, useMemo, useState } from 'react'
import dagre from '@dagrejs/dagre'
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import { ChevronDown, ChevronRight, MessageSquareText } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { MindMapContent, MindMapNode } from '@/types/knowledge-artifact'

const NODE_WIDTH = 190
const NODE_HEIGHT = 52
const DEFAULT_VISIBLE_DEPTH = 2

interface MindMapNodeData extends Record<string, unknown> {
  node: MindMapNode
  isRoot: boolean
  hasChildren: boolean
  isCollapsed: boolean
  onSelect: (nodeId: string) => void
  onToggle: (nodeId: string) => void
  onAsk: (nodeId: string) => void
}

type MindMapFlowNode = Node<MindMapNodeData, 'mindMap'>

interface InteractiveMindMapProps {
  content: MindMapContent
  onAskNode: (nodeId: string) => void
}

function getDepths(content: MindMapContent): Map<string, number> {
  const nodesById = new Map(content.nodes.map(node => [node.id, node]))
  const depths = new Map<string, number>()
  for (const node of content.nodes) {
    if (depths.has(node.id)) continue
    const path: MindMapNode[] = []
    const visited = new Set<string>()
    let current: MindMapNode | undefined = node
    while (current && !depths.has(current.id) && !visited.has(current.id)) {
      visited.add(current.id)
      path.push(current)
      current = current.parent_id ? nodesById.get(current.parent_id) : undefined
    }
    let depth = current ? (depths.get(current.id) ?? -1) : -1
    for (let index = path.length - 1; index >= 0; index -= 1) {
      depth += 1
      depths.set(path[index].id, depth)
    }
  }
  return depths
}

function getVisibleNodeIds(content: MindMapContent, collapsed: Set<string>): Set<string> {
  const childrenByParent = new Map<string, string[]>()
  content.nodes.forEach(node => {
    if (!node.parent_id) return
    const children = childrenByParent.get(node.parent_id) ?? []
    children.push(node.id)
    childrenByParent.set(node.parent_id, children)
  })

  const visible = new Set<string>()
  const visit = (nodeId: string) => {
    if (visible.has(nodeId)) return
    visible.add(nodeId)
    if (collapsed.has(nodeId)) return
    childrenByParent.get(nodeId)?.forEach(visit)
  }
  visit(content.root_id)
  return visible
}

function layoutMindMap(nodes: MindMapFlowNode[], edges: Edge[]): MindMapFlowNode[] {
  const graph = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}))
  graph.setGraph({
    rankdir: 'LR',
    ranksep: 72,
    nodesep: 28,
    marginx: 24,
    marginy: 24,
  })
  nodes.forEach(node => graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT }))
  edges.forEach(edge => graph.setEdge(edge.source, edge.target))
  dagre.layout(graph)

  return nodes.map(node => {
    const position = graph.node(node.id)
    return {
      ...node,
      position: {
        x: position.x - NODE_WIDTH / 2,
        y: position.y - NODE_HEIGHT / 2,
      },
    }
  })
}

const MindMapNodeCard = memo(function MindMapNodeCard({
  data,
  selected,
}: NodeProps<MindMapFlowNode>) {
  const { t } = useTranslation('knowledge')
  return (
    <div
      className={`group flex min-h-[52px] w-[190px] items-center rounded-xl border px-3 py-2 shadow-sm transition-colors ${
        selected
          ? 'border-primary bg-primary/10 ring-2 ring-primary/20'
          : data.isRoot
            ? 'border-primary/40 bg-primary/15'
            : 'border-border bg-surface hover:border-primary/50'
      }`}
      title={data.node.summary || data.node.title}
    >
      <Handle type="target" position={Position.Left} className="!invisible" />
      <button
        type="button"
        className="nodrag min-w-0 flex-1 text-left"
        aria-label={data.node.title}
        onClick={() => data.onSelect(data.node.id)}
        data-testid={`mind-map-node-${data.node.id}`}
      >
        <p className="line-clamp-2 text-sm font-medium leading-5">{data.node.title}</p>
      </button>
      {data.hasChildren && (
        <button
          type="button"
          className="nodrag ml-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-text-muted hover:bg-hover hover:text-text-primary md:h-9 md:w-9"
          onClick={event => {
            event.stopPropagation()
            data.onToggle(data.node.id)
          }}
          aria-label={
            data.isCollapsed ? t('artifact.mindMap.expand') : t('artifact.mindMap.collapse')
          }
          data-testid={`mind-map-toggle-${data.node.id}`}
        >
          {data.isCollapsed ? (
            <ChevronRight className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
        </button>
      )}
      <button
        type="button"
        className="nodrag ml-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary hover:bg-primary hover:text-white md:h-9 md:w-9"
        onClick={event => {
          event.stopPropagation()
          data.onAsk(data.node.id)
        }}
        aria-label={t('artifact.mindMap.ask')}
        title={t('artifact.mindMap.ask')}
        data-testid={`mind-map-ask-${data.node.id}`}
      >
        <MessageSquareText className="h-4 w-4" />
      </button>
      <Handle type="source" position={Position.Right} className="!invisible" />
    </div>
  )
})

const nodeTypes = { mindMap: MindMapNodeCard }

export function InteractiveMindMap({ content, onAskNode }: InteractiveMindMapProps) {
  const depths = useMemo(() => getDepths(content), [content])
  const children = useMemo(() => {
    const parentIds = new Set<string>()
    content.nodes.forEach(node => {
      if (node.parent_id) parentIds.add(node.parent_id)
    })
    return parentIds
  }, [content])
  const [collapsed, setCollapsed] = useState<Set<string>>(() =>
    content.nodes.length <= 20
      ? new Set()
      : new Set(
          content.nodes
            .filter(
              node => children.has(node.id) && (depths.get(node.id) ?? 0) >= DEFAULT_VISIBLE_DEPTH
            )
            .map(node => node.id)
        )
  )
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)

  const handleToggle = useCallback((nodeId: string) => {
    setCollapsed(current => {
      const next = new Set(current)
      if (next.has(nodeId)) next.delete(nodeId)
      else next.add(nodeId)
      return next
    })
  }, [])

  const { nodes, edges } = useMemo(() => {
    const visible = getVisibleNodeIds(content, collapsed)
    const nextEdges: Edge[] = content.nodes
      .filter(node => node.parent_id && visible.has(node.id) && visible.has(node.parent_id))
      .map(node => ({
        id: `${node.parent_id}-${node.id}`,
        source: node.parent_id!,
        target: node.id,
        type: 'bezier',
        style: { stroke: 'rgb(var(--color-primary) / 0.5)', strokeWidth: 1.5 },
      }))
    const nextNodes: MindMapFlowNode[] = content.nodes
      .filter(node => visible.has(node.id))
      .map(node => ({
        id: node.id,
        type: 'mindMap',
        position: { x: 0, y: 0 },
        draggable: false,
        selected: node.id === selectedNodeId,
        data: {
          node,
          isRoot: node.id === content.root_id,
          hasChildren: children.has(node.id),
          isCollapsed: collapsed.has(node.id),
          onSelect: setSelectedNodeId,
          onToggle: handleToggle,
          onAsk: onAskNode,
        },
      }))
    return { nodes: layoutMindMap(nextNodes, nextEdges), edges: nextEdges }
  }, [children, collapsed, content, handleToggle, onAskNode, selectedNodeId])

  return (
    <div
      className="h-full min-h-[420px] overflow-hidden rounded-lg bg-muted/30"
      data-testid="interactive-mind-map"
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1.2 }}
        minZoom={0.2}
        maxZoom={2}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} size={1} color="rgb(var(--color-border))" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}
