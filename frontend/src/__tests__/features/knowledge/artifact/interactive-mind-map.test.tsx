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
  expect(screen.getByTestId('mind-map-toggle-root')).toHaveClass('h-11', 'w-11', 'md:h-9', 'md:w-9')
  expect(screen.getByTestId('mind-map-ask-root')).toHaveClass('h-11', 'w-11', 'md:h-9', 'md:w-9')
  fireEvent.click(screen.getByTestId('mind-map-ask-root'))
  expect(onAskNode).toHaveBeenCalledWith('root')

  fireEvent.click(screen.getByTestId('mind-map-toggle-root'))
  expect(screen.queryByTestId('mind-map-node-child')).not.toBeInTheDocument()
})

it('terminates safely when parent links contain a cycle', () => {
  render(
    <InteractiveMindMap
      content={{
        schema_version: 1,
        root_id: 'a',
        nodes: [
          { id: 'a', parent_id: 'b', title: 'A' },
          { id: 'b', parent_id: 'a', title: 'B' },
        ],
      }}
      onAskNode={jest.fn()}
    />
  )

  expect(screen.getByTestId('mind-map-node-a')).toBeInTheDocument()
  expect(screen.getByTestId('mind-map-node-b')).toBeInTheDocument()
})
