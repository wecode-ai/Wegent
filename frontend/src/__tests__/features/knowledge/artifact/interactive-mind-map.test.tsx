// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ComponentType } from 'react'
import { InteractiveMindMap } from '@/features/knowledge/artifact/components/InteractiveMindMap'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

jest.mock('@dagrejs/dagre', () => {
  class Graph {
    private positions = new Map<string, { x: number; y: number }>()

    setDefaultEdgeLabel() {
      return this
    }

    setGraph() {
      return this
    }

    setNode(id: string) {
      this.positions.set(id, { x: 0, y: 0 })
      return this
    }

    setEdge() {
      return this
    }

    node(id: string) {
      return this.positions.get(id)
    }
  }

  return {
    __esModule: true,
    default: {
      graphlib: { Graph },
      layout: jest.fn(),
    },
  }
})

jest.mock('@xyflow/react', () => ({
  Background: () => null,
  Controls: () => null,
  Handle: () => null,
  Position: { Left: 'left', Right: 'right' },
  ReactFlow: ({
    nodes,
    nodeTypes,
  }: {
    nodes: Array<{ id: string; type: string; data: object; selected: boolean }>
    nodeTypes: Record<string, ComponentType<{ data: object; selected: boolean }>>
  }) => (
    <div>
      {nodes.map(node => {
        const NodeComponent = nodeTypes[node.type]
        return <NodeComponent key={node.id} data={node.data} selected={node.selected} />
      })}
    </div>
  ),
}))

const content = {
  schema_version: 1 as const,
  root_id: 'root',
  nodes: [
    { id: 'root', parent_id: null, title: 'Root' },
    { id: 'child', parent_id: 'root', title: 'Child' },
  ],
}

it('keeps select, collapse, and ask as independent buttons', () => {
  const onAskNode = jest.fn()
  render(<InteractiveMindMap content={content} onAskNode={onAskNode} />)

  expect(screen.getByTestId('mind-map-node-root').tagName).toBe('BUTTON')
  fireEvent.click(screen.getByTestId('mind-map-ask-root'))
  expect(onAskNode).toHaveBeenCalledWith('root')

  fireEvent.click(screen.getByTestId('mind-map-toggle-root'))
  expect(screen.queryByTestId('mind-map-node-child')).not.toBeInTheDocument()
})
