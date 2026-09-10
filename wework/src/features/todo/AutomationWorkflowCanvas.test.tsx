import { render } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { AutomationWorkflowCanvas } from './AutomationWorkflowCanvas.jsx'

const flowMocks = vi.hoisted(() => ({
  defaultViewport: null as { x: number; y: number; zoom: number } | null,
  getViewport: vi.fn(() => ({ x: 0, y: 0, zoom: 0.99 })),
  setViewport: vi.fn(),
}))

vi.mock('@xyflow/react', () => ({
  Background: () => null,
  BaseEdge: () => null,
  Handle: () => null,
  MiniMap: () => null,
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Position: { Left: 'left', Right: 'right' },
  ReactFlow: ({
    children,
    defaultViewport,
  }: {
    children: React.ReactNode
    defaultViewport: { x: number; y: number; zoom: number }
  }) => {
    flowMocks.defaultViewport = defaultViewport
    return <div>{children}</div>
  },
  SelectionMode: { Partial: 'partial' },
  getBezierPath: () => ['', 0, 0],
  useNodesState: (nodes: unknown[]) => {
    const [currentNodes, setCurrentNodes] = useState(nodes)
    return [currentNodes, setCurrentNodes, vi.fn()]
  },
  useReactFlow: () => ({
    fitView: vi.fn(),
    getViewport: flowMocks.getViewport,
    setViewport: flowMocks.setViewport,
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
  }),
  useViewport: () => ({ zoom: 0.99 }),
}))

const baseProps = {
  trigger: { label: '每小时第 16 分钟', detail: '按计划执行 · Asia/Shanghai' },
  onSelectNode: vi.fn(),
  onInsertNode: vi.fn(),
  onAddDagStage: vi.fn(),
  onToggleDagDependency: vi.fn(),
  onMoveDagStage: vi.fn(),
  onToggleStepDependency: vi.fn(),
  onMoveStep: vi.fn(),
}

const emptyDraft = {
  trigger: { type: 'schedule' },
  steps: [],
}

describe('AutomationWorkflowCanvas viewport', () => {
  beforeEach(() => {
    flowMocks.defaultViewport = null
    flowMocks.getViewport.mockReset()
    flowMocks.getViewport.mockReturnValue({ x: 0, y: 0, zoom: 0.99 })
    flowMocks.setViewport.mockReset()
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 1200,
      bottom: 800,
      left: 0,
      width: 1200,
      height: 800,
      toJSON: () => ({}),
    })
  })

  test('starts at 99 percent zoom', () => {
    render(
      <AutomationWorkflowCanvas
        {...baseProps}
        draft={emptyDraft}
        selectedNode={{ type: 'trigger' }}
        rightPanelInset={0}
      />
    )

    expect(flowMocks.defaultViewport).toEqual({ x: 176, y: 136, zoom: 0.99 })
  })

  test('centers a new node in the canvas area left visible beside the editor panel', () => {
    const view = render(
      <AutomationWorkflowCanvas
        {...baseProps}
        draft={emptyDraft}
        selectedNode={{ type: 'trigger' }}
        rightPanelInset={0}
      />
    )

    view.rerender(
      <AutomationWorkflowCanvas
        {...baseProps}
        draft={{
          ...emptyDraft,
          steps: [
            {
              id: 'step-new',
              kind: 'task',
              x: 440,
              y: 226,
              dependencies: [],
            },
          ],
        }}
        selectedNode={{ type: 'step', id: 'step-new' }}
        rightPanelInset={412}
      />
    )

    expect(flowMocks.setViewport).toHaveBeenCalledWith(
      {
        x: 394 - 590 * 0.99,
        y: 400 - 270 * 0.99,
        zoom: 0.99,
      },
      { duration: 240 }
    )
  })

  test('keeps the selected trigger visible when the editor panel opens', () => {
    const view = render(
      <AutomationWorkflowCanvas
        {...baseProps}
        draft={emptyDraft}
        selectedNode={{ type: 'none' }}
        rightPanelInset={0}
      />
    )

    view.rerender(
      <AutomationWorkflowCanvas
        {...baseProps}
        draft={emptyDraft}
        selectedNode={{ type: 'trigger' }}
        rightPanelInset={412}
      />
    )

    expect(flowMocks.setViewport).toHaveBeenCalledWith(
      {
        x: 394 - 230 * 0.99,
        y: 400 - 270 * 0.99,
        zoom: 0.99,
      },
      { duration: 240 }
    )
  })

  test('focuses the trigger after the selected step is deleted', () => {
    const view = render(
      <AutomationWorkflowCanvas
        {...baseProps}
        draft={{
          ...emptyDraft,
          steps: [
            {
              id: 'step-deleted',
              kind: 'task',
              name: 'Deleted step',
              prompt: '',
              dependencies: [],
              dependencyContext: {},
              x: 440,
              y: 220,
            },
          ],
        }}
        selectedNode={{ type: 'step', id: 'step-deleted' }}
        rightPanelInset={412}
      />
    )

    flowMocks.setViewport.mockClear()
    view.rerender(
      <AutomationWorkflowCanvas
        {...baseProps}
        draft={emptyDraft}
        selectedNode={{ type: 'trigger' }}
        rightPanelInset={412}
      />
    )

    expect(flowMocks.setViewport).toHaveBeenCalledWith(
      {
        x: 394 - 230 * 0.99,
        y: 400 - 270 * 0.99,
        zoom: 0.99,
      },
      { duration: 240 }
    )
  })

  test('focuses a selected DAG stage using its parent-relative position', () => {
    const draft = {
      ...emptyDraft,
      steps: [
        {
          id: 'dynamic-step',
          kind: 'dynamic',
          x: 440,
          y: 200,
          dependencies: [],
          subgraph: {
            nodes: [{ id: 'stage-1', x: 30, y: 20, dependencies: [] }],
          },
        },
      ],
    }
    const view = render(
      <AutomationWorkflowCanvas
        {...baseProps}
        draft={draft}
        selectedNode={{ type: 'none' }}
        rightPanelInset={0}
      />
    )

    view.rerender(
      <AutomationWorkflowCanvas
        {...baseProps}
        draft={draft}
        selectedNode={{ type: 'dagStage', stepId: 'dynamic-step', stageId: 'stage-1' }}
        rightPanelInset={412}
      />
    )

    expect(flowMocks.setViewport).toHaveBeenCalledWith(
      {
        x: 394 - 565 * 0.99,
        y: 400 - 341 * 0.99,
        zoom: 0.99,
      },
      { duration: 240 }
    )
  })

  test('focuses a selected loop body using its parent-relative position', () => {
    const draft = {
      ...emptyDraft,
      steps: [
        {
          id: 'loop-step',
          kind: 'loop',
          x: 500,
          y: 180,
          dependencies: [],
          subgraph: {
            nodes: [{ id: 'body-1', nodeType: 'task', x: 40, y: 30, dependencies: [] }],
          },
        },
      ],
    }
    const view = render(
      <AutomationWorkflowCanvas
        {...baseProps}
        draft={draft}
        selectedNode={{ type: 'none' }}
        rightPanelInset={0}
      />
    )

    view.rerender(
      <AutomationWorkflowCanvas
        {...baseProps}
        draft={draft}
        selectedNode={{ type: 'loopBody', loopId: 'loop-step', bodyId: 'body-1' }}
        rightPanelInset={412}
      />
    )

    expect(flowMocks.setViewport).toHaveBeenCalledWith(
      {
        x: 394 - 644 * 0.99,
        y: 400 - 319 * 0.99,
        zoom: 0.99,
      },
      { duration: 240 }
    )
  })

  test('does not treat a nested selection as deleted when selecting its parent', () => {
    const draft = {
      ...emptyDraft,
      steps: [
        {
          id: 'dynamic-step',
          kind: 'dynamic',
          x: 440,
          y: 200,
          dependencies: [],
          subgraph: {
            nodes: [{ id: 'stage-1', x: 30, y: 20, dependencies: [] }],
          },
        },
      ],
    }
    const view = render(
      <AutomationWorkflowCanvas
        {...baseProps}
        draft={draft}
        selectedNode={{ type: 'dagStage', stepId: 'dynamic-step', stageId: 'stage-1' }}
        rightPanelInset={412}
      />
    )

    flowMocks.setViewport.mockClear()
    view.rerender(
      <AutomationWorkflowCanvas
        {...baseProps}
        draft={draft}
        selectedNode={{ type: 'step', id: 'dynamic-step' }}
        rightPanelInset={412}
      />
    )

    expect(flowMocks.setViewport).not.toHaveBeenCalled()
  })
})
