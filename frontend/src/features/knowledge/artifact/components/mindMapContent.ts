// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { MindMapContent, MindMapNode } from '@/types/knowledge-artifact'

const MAX_NODES = 200
type Translate = (key: string, options?: Record<string, string>) => string

function isMindMapNode(value: unknown): value is MindMapNode {
  if (!value || typeof value !== 'object') return false
  const node = value as Partial<MindMapNode>
  return (
    typeof node.id === 'string' &&
    node.id.trim().length > 0 &&
    (node.parent_id === null || typeof node.parent_id === 'string') &&
    typeof node.title === 'string' &&
    node.title.trim().length > 0 &&
    (node.summary === undefined || node.summary === null || typeof node.summary === 'string')
  )
}

export function parseMindMapContent(content: string): MindMapContent | null {
  try {
    const value = JSON.parse(content) as Partial<MindMapContent>
    if (
      value.schema_version !== 1 ||
      typeof value.root_id !== 'string' ||
      !Array.isArray(value.nodes) ||
      value.nodes.length === 0 ||
      value.nodes.length > MAX_NODES ||
      !value.nodes.every(isMindMapNode)
    ) {
      return null
    }

    const nodesById = new Map(value.nodes.map(node => [node.id, node]))
    if (nodesById.size !== value.nodes.length || !nodesById.has(value.root_id)) {
      return null
    }
    const roots = value.nodes.filter(node => node.parent_id === null)
    if (roots.length !== 1 || roots[0].id !== value.root_id) return null

    for (const node of value.nodes) {
      if (node.parent_id !== null && !nodesById.has(node.parent_id)) return null
      const visited = new Set<string>()
      let current = node
      while (current.parent_id !== null) {
        if (visited.has(current.id)) return null
        visited.add(current.id)
        const parent = nodesById.get(current.parent_id)
        if (!parent) return null
        current = parent
      }
      if (current.id !== value.root_id) return null
    }

    return {
      schema_version: 1,
      root_id: value.root_id,
      nodes: value.nodes,
    }
  } catch {
    return null
  }
}

export function getMindMapNodePath(content: MindMapContent, nodeId: string): MindMapNode[] {
  const nodesById = new Map(content.nodes.map(node => [node.id, node]))
  const path: MindMapNode[] = []
  const visited = new Set<string>()
  let current = nodesById.get(nodeId)

  while (current && !visited.has(current.id)) {
    path.unshift(current)
    visited.add(current.id)
    current = current.parent_id ? nodesById.get(current.parent_id) : undefined
  }
  return path
}

export function buildMindMapQuestion(
  content: MindMapContent,
  nodeId: string,
  t: Translate
): string {
  const path = getMindMapNodePath(content, nodeId)
  const node = path[path.length - 1]
  if (!node) return ''
  const pathText = path.map(item => item.title).join(' > ')
  return [
    t('artifact.mindMap.question', { title: node.title }),
    t('artifact.mindMap.path', { path: pathText }),
    t('artifact.mindMap.instruction'),
  ].join('\n')
}
