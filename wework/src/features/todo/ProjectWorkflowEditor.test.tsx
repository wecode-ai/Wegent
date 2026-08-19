import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentType, ReactNode } from 'react'
import { describe, expect, test, vi } from 'vitest'
import type { ProjectWorkflowDefinition } from '@/api/deliveries'
import type { ProjectChatAgent } from '@/api/projectChatAgents'
import { ProjectWorkflowEditor } from './ProjectWorkflowEditor'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string, values?: Record<string, string | number>): string =>
      Object.entries(values ?? {}).reduce(
        (text, [name, value]) => text.replace(`{{${name}}}`, String(value)),
        fallback ?? _key
      ),
  }),
}))

vi.mock('@xyflow/react', () => ({
  Background: () => null,
  BaseEdge: () => null,
  Controls: () => null,
  EdgeLabelRenderer: ({ children }: { children?: ReactNode }) => children,
  Handle: () => null,
  MarkerType: { ArrowClosed: 'arrowclosed' },
  Position: { Left: 'left', Right: 'right' },
  getBezierPath: () => ['', 0, 0],
  ReactFlow: ({
    nodes,
    edges,
    nodeTypes,
    edgeTypes,
    onNodeClick,
    onDelete,
    children,
  }: {
    nodes: Array<{
      id: string
      type: string
      selected?: boolean
      data: Record<string, unknown>
    }>
    edges: Array<{
      id: string
      type: string
      source: string
      target: string
      selected?: boolean
      data?: Record<string, unknown>
    }>
    nodeTypes: Record<string, ComponentType<Record<string, unknown>>>
    edgeTypes: Record<string, ComponentType<Record<string, unknown>>>
    onNodeClick?: (event: unknown, node: { id: string }) => void
    onDelete?: (elements: {
      nodes: Array<{ id: string }>
      edges: Array<{ id: string; source: string; target: string }>
    }) => void
    children?: ReactNode
  }) => (
    <div
      data-testid="mock-react-flow"
      tabIndex={0}
      onKeyDown={event => {
        if (event.key !== 'Backspace' && event.key !== 'Delete') return
        const selectedNodes = nodes.filter(node => node.selected)
        const selectedNodeIds = new Set(selectedNodes.map(node => node.id))
        const selectedEdges = edges.filter(
          edge =>
            edge.selected || selectedNodeIds.has(edge.source) || selectedNodeIds.has(edge.target)
        )
        onDelete?.({ nodes: selectedNodes, edges: selectedEdges })
      }}
    >
      {nodes.map(node => {
        const NodeComponent = nodeTypes[node.type]
        return (
          <div key={node.id} onClick={() => onNodeClick?.({}, node)}>
            <NodeComponent data={node.data} selected={node.selected} />
          </div>
        )
      })}
      {edges.map(edge => {
        const EdgeComponent = edgeTypes[edge.type]
        return (
          <EdgeComponent
            key={edge.id}
            {...edge}
            sourceX={0}
            sourceY={0}
            targetX={0}
            targetY={0}
            sourcePosition="right"
            targetPosition="left"
          />
        )
      })}
      {children}
    </div>
  ),
}))

const startNode = {
  id: 'start',
  name: '开始',
  node_type: 'start' as const,
  depends_on: [],
  required: false,
  workspace_policy: 'none' as const,
  automation_rule_id: null,
}

const endNode = {
  id: 'end',
  name: '结束',
  node_type: 'end' as const,
  depends_on: ['test'],
  required: true,
  workspace_policy: 'none' as const,
  automation_rule_id: null,
}

const workflow: ProjectWorkflowDefinition = {
  version: 1,
  stage_mode: 'dag',
  advancement_policy: 'manual',
  nodes: [
    startNode,
    {
      id: 'develop',
      name: '开发',
      prompt: '实现 Issue 中描述的功能',
      node_type: 'stage',
      depends_on: ['start'],
      required: true,
      workspace_policy: 'composer',
      automation_rule_id: null,
    },
    {
      id: 'test',
      name: '测试',
      prompt: '运行测试并修复失败',
      node_type: 'stage',
      depends_on: ['develop'],
      required: true,
      workspace_policy: 'inherit',
      automation_rule_id: null,
    },
    endNode,
  ],
}

const robot: ProjectChatAgent = {
  id: 'robot-1',
  projectId: 'project-1',
  name: '开发机器人',
  runtime: 'codex',
  wegentTeamId: null,
  model: 'gpt-5.6-codex',
  systemPrompt: '',
  capabilityDescription: '实现功能',
  status: 'active',
  visibility: 'creator_admin',
  executionEnvironment: 'local',
  executionMode: 'auto',
  executionDeviceId: 'device-1',
  localProjectId: 1,
  maxConcurrentExecutions: 1,
  createdByUserId: 1,
  version: 1,
  createdAt: '2026-08-18T00:00:00Z',
  updatedAt: '2026-08-18T00:00:00Z',
}

describe('ProjectWorkflowEditor', () => {
  test('renders the save action with the visible Wework primary color', () => {
    render(
      <ProjectWorkflowEditor value={workflow} busy={false} onChange={vi.fn()} onSave={vi.fn()} />
    )

    expect(screen.getByTestId('project-workflow-save')).toHaveClass(
      'bg-text-primary',
      'text-background'
    )
    expect(screen.getByTestId('project-workflow-save')).not.toHaveClass('bg-foreground')
  })

  test('renders structural start and end nodes alongside stage cards', () => {
    render(
      <ProjectWorkflowEditor value={workflow} busy={false} onChange={vi.fn()} onSave={vi.fn()} />
    )

    expect(screen.getByTestId('project-workflow-start-start')).toBeInTheDocument()
    expect(screen.getByTestId('project-workflow-end-end')).toBeInTheDocument()
    expect(screen.getByTestId('project-workflow-stage-develop')).toBeInTheDocument()
    expect(screen.getAllByText('开始').length).toBeGreaterThan(0)
    expect(screen.getAllByText('结束').length).toBeGreaterThan(0)
  })

  test('auto-creates start and end nodes when a dag workflow has none', () => {
    const onChange = vi.fn()
    render(
      <ProjectWorkflowEditor
        value={{ version: 1, stage_mode: 'dag', advancement_policy: 'manual', nodes: [] }}
        busy={false}
        onChange={onChange}
        onSave={vi.fn()}
      />
    )

    expect(onChange).toHaveBeenCalledWith({
      version: 1,
      stage_mode: 'dag',
      advancement_policy: 'manual',
      nodes: [
        expect.objectContaining({ id: 'start', node_type: 'start', depends_on: [] }),
        expect.objectContaining({
          id: 'end',
          node_type: 'end',
          depends_on: ['start'],
        }),
      ],
    })
    expect(screen.getByTestId('project-workflow-start-start')).toBeInTheDocument()
    expect(screen.getByTestId('project-workflow-end-end')).toBeInTheDocument()
  })

  test('keeps structural nodes out of the removal path', () => {
    render(
      <ProjectWorkflowEditor value={workflow} busy={false} onChange={vi.fn()} onSave={vi.fn()} />
    )

    fireEvent.click(screen.getByTestId('project-workflow-start-start'))
    expect(screen.getByTestId('project-workflow-inspector-start')).toBeInTheDocument()
    expect(screen.queryByTestId('project-workflow-remove-start')).not.toBeInTheDocument()
    expect(screen.queryByTestId('project-workflow-insert-before-start')).not.toBeInTheDocument()
    expect(screen.getByTestId('project-workflow-insert-after-start')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('project-workflow-end-end'))
    expect(screen.getByTestId('project-workflow-inspector-end')).toBeInTheDocument()
    expect(screen.queryByTestId('project-workflow-remove-end')).not.toBeInTheDocument()
    expect(screen.queryByTestId('project-workflow-insert-after-end')).not.toBeInTheDocument()
    expect(screen.getByTestId('project-workflow-insert-before-end')).toBeInTheDocument()
  })

  test('shows a compact graph and edits the selected stage in the inspector', () => {
    const onChange = vi.fn()
    render(
      <ProjectWorkflowEditor value={workflow} busy={false} onChange={onChange} onSave={vi.fn()} />
    )

    expect(screen.getByTestId('project-workflow-dag')).toBeInTheDocument()
    expect(screen.getByTestId('project-workflow-inspector-start')).toBeInTheDocument()
    expect(screen.getByText('运行测试并修复失败')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('project-workflow-stage-test'))
    expect(screen.getByTestId('project-workflow-inspector-test')).toBeInTheDocument()

    fireEvent.change(screen.getByTestId('project-workflow-stage-prompt-test'), {
      target: { value: '验证开发结果并提交报告' },
    })
    expect(onChange).toHaveBeenCalledWith({
      ...workflow,
      nodes: [
        workflow.nodes[0],
        workflow.nodes[1],
        {
          ...workflow.nodes[2],
          prompt: '验证开发结果并提交报告',
        },
        workflow.nodes[3],
      ],
    })

    fireEvent.click(screen.getByTestId('project-workflow-edge-develop-test'))
    expect(screen.getByTestId('project-workflow-edge-inspector-develop-test')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('project-workflow-edge-context-activity'))
    expect(onChange).toHaveBeenLastCalledWith({
      ...workflow,
      nodes: [
        workflow.nodes[0],
        workflow.nodes[1],
        {
          ...workflow.nodes[2],
          dependency_context: {
            develop: ['final_result', 'deliveries', 'activity'],
          },
        },
        workflow.nodes[3],
      ],
    })

    fireEvent.click(screen.getByTestId('project-workflow-edge-delete-develop-test'))
    expect(onChange).toHaveBeenLastCalledWith({
      ...workflow,
      nodes: [
        workflow.nodes[0],
        workflow.nodes[1],
        { ...workflow.nodes[2], depends_on: [], dependency_context: {} },
        workflow.nodes[3],
      ],
    })

    fireEvent.click(screen.getByTestId('project-workflow-add'))
    expect(onChange).toHaveBeenLastCalledWith({
      ...workflow,
      stage_mode: 'dag',
      nodes: [
        workflow.nodes[0],
        workflow.nodes[1],
        workflow.nodes[2],
        expect.objectContaining({
          id: 'stage-1',
          name: '新阶段 1',
          node_type: 'stage',
          depends_on: ['test'],
          dependency_context: {
            test: ['final_result', 'deliveries'],
          },
        }),
        expect.objectContaining({
          id: 'end',
          depends_on: ['stage-1'],
        }),
      ],
    })
  })

  test('creates deliverables in a dialog and keeps the inspector as a compact list', () => {
    const onChange = vi.fn()
    const onSave = vi.fn()
    render(
      <ProjectWorkflowEditor value={workflow} busy={false} onChange={onChange} onSave={onSave} />
    )

    expect(screen.queryByTestId('workflow-deliverable-requirements-dialog')).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText('交付物名称')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('project-workflow-stage-develop'))
    fireEvent.click(screen.getByTestId('project-workflow-add-deliverable-develop'))

    expect(screen.getByTestId('workflow-deliverable-requirements-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('workflow-deliverable-requirements-save')).toBeDisabled()

    fireEvent.change(screen.getByTestId('workflow-deliverable-requirement-name-deliverable-1'), {
      target: { value: '后端 Wiki' },
    })
    fireEvent.change(screen.getByTestId('workflow-deliverable-requirement-type-deliverable-1'), {
      target: { value: 'url' },
    })
    fireEvent.change(
      screen.getByTestId('workflow-deliverable-requirement-description-deliverable-1'),
      {
        target: { value: '包含接口和部署说明' },
      }
    )
    fireEvent.click(screen.getByTestId('workflow-deliverable-requirement-add'))
    fireEvent.change(screen.getByTestId('workflow-deliverable-requirement-name-deliverable-2'), {
      target: { value: '后端代码' },
    })
    fireEvent.change(screen.getByTestId('workflow-deliverable-requirement-type-deliverable-2'), {
      target: { value: 'code_snapshot' },
    })
    fireEvent.click(screen.getByTestId('workflow-deliverable-requirements-save'))

    const expectedDefinition: ProjectWorkflowDefinition = {
      ...workflow,
      nodes: [
        workflow.nodes[0],
        {
          ...workflow.nodes[1],
          required_deliverables: [
            {
              id: 'deliverable-1',
              name: '后端 Wiki',
              description: '包含接口和部署说明',
              value_type: 'url',
              file_constraints: null,
            },
            {
              id: 'deliverable-2',
              name: '后端代码',
              description: '',
              value_type: 'code_snapshot',
              file_constraints: null,
            },
          ],
        },
        workflow.nodes[2],
        workflow.nodes[3],
      ],
    }
    expect(onChange).toHaveBeenLastCalledWith(expectedDefinition)
    expect(onSave).toHaveBeenCalledWith(expectedDefinition)
    expect(screen.queryByTestId('workflow-deliverable-requirements-dialog')).not.toBeInTheDocument()
  })

  test('edits an existing deliverable by clicking its compact tile', () => {
    const onChange = vi.fn()
    const workflowWithDeliverable: ProjectWorkflowDefinition = {
      ...workflow,
      nodes: [
        workflow.nodes[0],
        {
          ...workflow.nodes[1],
          required_deliverables: [
            {
              id: 'backend-wiki',
              name: '后端 Wiki',
              description: '接口说明',
              value_type: 'url',
              file_constraints: null,
            },
          ],
        },
        workflow.nodes[2],
        workflow.nodes[3],
      ],
    }
    render(
      <ProjectWorkflowEditor
        value={workflowWithDeliverable}
        busy={false}
        onChange={onChange}
        onSave={vi.fn()}
      />
    )

    fireEvent.click(screen.getByTestId('project-workflow-stage-develop'))
    expect(screen.getByTestId('project-workflow-deliverable-backend-wiki')).toHaveTextContent(
      '后端 Wiki'
    )
    expect(
      screen.queryByTestId('project-workflow-deliverable-name-backend-wiki')
    ).not.toBeInTheDocument()
    expect(screen.getByTestId('project-workflow-deliverable-list-develop')).toHaveClass(
      'max-h-60',
      'divide-y',
      'overflow-y-auto',
      'overscroll-contain'
    )
    expect(screen.getByTestId('project-workflow-deliverable-backend-wiki')).toHaveClass('min-h-12')

    fireEvent.click(screen.getByTestId('project-workflow-deliverable-backend-wiki'))
    fireEvent.change(
      screen.getByTestId('workflow-deliverable-requirement-description-backend-wiki'),
      {
        target: { value: '接口、部署和回滚说明' },
      }
    )
    fireEvent.click(screen.getByTestId('workflow-deliverable-requirements-save'))

    expect(onChange).toHaveBeenLastCalledWith({
      ...workflowWithDeliverable,
      nodes: [
        workflowWithDeliverable.nodes[0],
        {
          ...workflowWithDeliverable.nodes[1],
          required_deliverables: [
            {
              id: 'backend-wiki',
              name: '后端 Wiki',
              description: '接口、部署和回滚说明',
              value_type: 'url',
              file_constraints: null,
            },
          ],
        },
        workflowWithDeliverable.nodes[2],
        workflowWithDeliverable.nodes[3],
      ],
    })
  })

  test('keeps the three orchestration choices as one dimension', () => {
    const onChange = vi.fn()
    render(
      <ProjectWorkflowEditor
        value={{ ...workflow, stage_mode: 'none', nodes: [] }}
        busy={false}
        onChange={onChange}
        onSave={vi.fn()}
      />
    )

    expect(screen.getByTestId('project-workflow-mode-manual')).toBeInTheDocument()
    expect(screen.getByTestId('project-workflow-mode-workflow')).toBeInTheDocument()
    expect(screen.getByTestId('project-workflow-mode-ai')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('project-workflow-mode-ai'))
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ advancement_policy: 'ai', stage_mode: 'none' })
    )
  })

  test('shows insertion controls only on the selected stage and inserts after it', () => {
    const onChange = vi.fn()
    render(
      <ProjectWorkflowEditor value={workflow} busy={false} onChange={onChange} onSave={vi.fn()} />
    )

    fireEvent.click(screen.getByTestId('project-workflow-stage-develop'))
    expect(screen.getByTestId('project-workflow-insert-before-develop')).toBeInTheDocument()
    expect(screen.getByTestId('project-workflow-insert-after-develop')).toBeInTheDocument()
    expect(screen.queryByTestId('project-workflow-insert-before-test')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('project-workflow-insert-after-develop'))

    expect(onChange).toHaveBeenCalledWith({
      ...workflow,
      stage_mode: 'dag',
      nodes: [
        workflow.nodes[0],
        workflow.nodes[1],
        expect.objectContaining({
          id: 'stage-1',
          name: '新阶段 1',
          depends_on: ['develop'],
          dependency_context: {
            develop: ['final_result', 'deliveries'],
          },
        }),
        {
          ...workflow.nodes[2],
          depends_on: ['stage-1'],
          dependency_context: {
            'stage-1': ['final_result', 'deliveries'],
          },
        },
        workflow.nodes[3],
      ],
    })
  })

  test('deletes exactly the selected graph element with the keyboard', () => {
    const onChange = vi.fn()
    render(
      <ProjectWorkflowEditor value={workflow} busy={false} onChange={onChange} onSave={vi.fn()} />
    )

    fireEvent.click(screen.getByTestId('project-workflow-edge-develop-test'))
    fireEvent.keyDown(screen.getByTestId('mock-react-flow'), { key: 'Delete' })
    expect(onChange).toHaveBeenLastCalledWith({
      ...workflow,
      nodes: [
        workflow.nodes[0],
        workflow.nodes[1],
        { ...workflow.nodes[2], depends_on: [], dependency_context: {} },
        workflow.nodes[3],
      ],
    })

    onChange.mockClear()
    fireEvent.click(screen.getByTestId('project-workflow-stage-test'))
    fireEvent.keyDown(screen.getByTestId('mock-react-flow'), { key: 'Backspace' })
    expect(onChange).toHaveBeenLastCalledWith({
      ...workflow,
      nodes: [
        workflow.nodes[0],
        workflow.nodes[1],
        {
          ...workflow.nodes[3],
          depends_on: ['develop'],
          dependency_context: {
            develop: ['final_result', 'deliveries'],
          },
        },
      ],
    })
  })

  test('does not delete structural nodes with the keyboard', () => {
    const onChange = vi.fn()
    render(
      <ProjectWorkflowEditor value={workflow} busy={false} onChange={onChange} onSave={vi.fn()} />
    )

    fireEvent.click(screen.getByTestId('project-workflow-start-start'))
    fireEvent.keyDown(screen.getByTestId('mock-react-flow'), { key: 'Delete' })
    expect(onChange).toHaveBeenLastCalledWith({
      ...workflow,
      nodes: workflow.nodes,
    })
  })

  test('inserts before a selected stage and migrates its incoming edge context', () => {
    const onChange = vi.fn()
    const workflowWithContext: ProjectWorkflowDefinition = {
      ...workflow,
      nodes: [
        workflow.nodes[0],
        workflow.nodes[1],
        {
          ...workflow.nodes[2],
          dependency_context: {
            develop: ['activity'],
          },
        },
        workflow.nodes[3],
      ],
    }
    render(
      <ProjectWorkflowEditor
        value={workflowWithContext}
        busy={false}
        onChange={onChange}
        onSave={vi.fn()}
      />
    )

    fireEvent.click(screen.getByTestId('project-workflow-stage-test'))
    expect(screen.getByTestId('project-workflow-insert-before-test')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('project-workflow-insert-before-test'))

    expect(onChange).toHaveBeenCalledWith({
      ...workflowWithContext,
      stage_mode: 'dag',
      nodes: [
        workflow.nodes[0],
        workflow.nodes[1],
        expect.objectContaining({
          id: 'stage-1',
          depends_on: ['develop'],
          dependency_context: {
            develop: ['activity'],
          },
        }),
        {
          ...workflowWithContext.nodes[2],
          depends_on: ['stage-1'],
          dependency_context: {
            'stage-1': ['final_result', 'deliveries'],
          },
        },
        workflow.nodes[3],
      ],
    })
  })

  test('adds a wait node before the end node and rewires it', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <ProjectWorkflowEditor value={workflow} busy={false} onChange={onChange} onSave={vi.fn()} />
    )

    fireEvent.click(screen.getByTestId('project-workflow-add-wait'))

    const workflowWithWait: ProjectWorkflowDefinition = {
      ...workflow,
      stage_mode: 'dag',
      nodes: [
        workflow.nodes[0],
        workflow.nodes[1],
        workflow.nodes[2],
        {
          id: 'wait-1',
          name: '新等待 1',
          node_type: 'wait',
          prompt: '',
          depends_on: ['test'],
          dependency_context: {
            test: ['final_result', 'deliveries'],
          },
          required: true,
          required_deliverables: [],
          workspace_policy: 'none',
          automation_rule_id: null,
          wait_config: {
            rules: [
              {
                id: 'rule-1',
                event_type: '',
                mode: 'trigger',
                action: 'complete',
                rerun_prompt: '',
              },
            ],
          },
        },
        {
          ...workflow.nodes[3],
          id: 'end',
          depends_on: ['wait-1'],
          dependency_context: {
            'wait-1': ['final_result', 'deliveries'],
          },
        },
      ],
    }
    expect(onChange).toHaveBeenCalledWith(workflowWithWait)
    rerender(
      <ProjectWorkflowEditor
        value={workflowWithWait}
        busy={false}
        onChange={onChange}
        onSave={vi.fn()}
      />
    )
    expect(screen.getByTestId('project-workflow-wait-wait-1')).toBeInTheDocument()
    expect(screen.getByTestId('project-workflow-wait-mode-wait-1-trigger')).toBeInTheDocument()
  })

  test('edits wait rules and gates saving on a non-empty event type', () => {
    const onChange = vi.fn()
    const workflowWithWait: ProjectWorkflowDefinition = {
      ...workflow,
      nodes: [
        workflow.nodes[0],
        workflow.nodes[1],
        workflow.nodes[2],
        {
          id: 'wait-1',
          name: '等待外部事件',
          node_type: 'wait',
          depends_on: ['test'],
          required: true,
          workspace_policy: 'none',
          automation_rule_id: null,
          wait_config: {
            rules: [
              { id: 'rule-1', event_type: '', mode: 'trigger', action: 'rerun', rerun_prompt: '' },
            ],
          },
        },
        {
          ...workflow.nodes[3],
          depends_on: ['wait-1'],
        },
      ],
    }
    const { rerender } = render(
      <ProjectWorkflowEditor
        value={workflowWithWait}
        busy={false}
        onChange={onChange}
        onSave={vi.fn()}
      />
    )

    expect(screen.getByTestId('project-workflow-save')).toBeDisabled()
    fireEvent.click(screen.getByTestId('project-workflow-wait-wait-1'))
    expect(screen.getByTestId('project-workflow-inspector-wait-1')).toBeInTheDocument()
    expect(
      screen.getByTestId('project-workflow-wait-rule-rerun-prompt-wait-1-rule-1')
    ).toBeInTheDocument()

    fireEvent.change(screen.getByTestId('project-workflow-wait-rule-event-wait-1-rule-1'), {
      target: { value: 'merged' },
    })
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        nodes: expect.arrayContaining([
          expect.objectContaining({
            id: 'wait-1',
            wait_config: {
              rules: [
                expect.objectContaining({
                  id: 'rule-1',
                  event_type: 'merged',
                }),
              ],
            },
          }),
        ]),
      })
    )

    const ruleWithEvent: ProjectWorkflowDefinition = {
      ...workflowWithWait,
      nodes: workflowWithWait.nodes.map(node =>
        node.id === 'wait-1'
          ? {
              ...node,
              wait_config: {
                rules: [
                  {
                    ...node.wait_config!.rules[0],
                    event_type: 'merged',
                  },
                ],
              },
            }
          : node
      ),
    }
    rerender(
      <ProjectWorkflowEditor
        value={ruleWithEvent}
        busy={false}
        onChange={onChange}
        onSave={vi.fn()}
      />
    )
    expect(screen.getByTestId('project-workflow-save')).toBeEnabled()

    fireEvent.change(screen.getByTestId('project-workflow-wait-rule-mode-wait-1-rule-1'), {
      target: { value: 'debounce' },
    })

    fireEvent.click(screen.getByTestId('project-workflow-wait-rule-add-wait-1'))
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        nodes: expect.arrayContaining([
          expect.objectContaining({
            id: 'wait-1',
            wait_config: {
              rules: [
                expect.objectContaining({ id: 'rule-1' }),
                expect.objectContaining({ id: 'rule-2', event_type: '' }),
              ],
            },
          }),
        ]),
      })
    )
    const workflowWithTwoRules: ProjectWorkflowDefinition = {
      ...ruleWithEvent,
      nodes: ruleWithEvent.nodes.map(node =>
        node.id === 'wait-1'
          ? {
              ...node,
              wait_config: {
                rules: [
                  {
                    ...node.wait_config!.rules[0],
                    mode: 'debounce',
                  },
                  {
                    id: 'rule-2',
                    event_type: '',
                    mode: 'trigger',
                    action: 'complete',
                    rerun_prompt: '',
                  },
                ],
              },
            }
          : node
      ),
    }
    rerender(
      <ProjectWorkflowEditor
        value={workflowWithTwoRules}
        busy={false}
        onChange={onChange}
        onSave={vi.fn()}
      />
    )
    expect(screen.getByTestId('project-workflow-save')).toBeDisabled()

    fireEvent.click(screen.getByTestId('project-workflow-wait-rule-remove-wait-1-rule-2'))
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        nodes: expect.arrayContaining([
          expect.objectContaining({
            id: 'wait-1',
            wait_config: {
              rules: [expect.objectContaining({ id: 'rule-1' })],
            },
          }),
        ]),
      })
    )
    rerender(
      <ProjectWorkflowEditor
        value={ruleWithEvent}
        busy={false}
        onChange={onChange}
        onSave={vi.fn()}
      />
    )
    expect(screen.getByTestId('project-workflow-save')).toBeEnabled()
  })

  test('presents AI advancement as a concrete dispatcher instead of an automation rule', () => {
    const onRequestConfigureAiCoordinator = vi.fn()
    render(
      <ProjectWorkflowEditor
        value={{
          ...workflow,
          stage_mode: 'none',
          advancement_policy: 'ai',
          ai_automation_rule_id: null,
          nodes: [],
        }}
        busy={false}
        onChange={vi.fn()}
        onSave={vi.fn()}
        onRequestConfigureAiCoordinator={onRequestConfigureAiCoordinator}
      />
    )

    expect(screen.getByText('调度 AI')).toBeInTheDocument()
    expect(screen.getByText('尚未配置调度 AI')).toBeInTheDocument()
    expect(
      screen.getByText('负责读取 Issue、拆解并分配具体任务，本身不执行任务。')
    ).toBeInTheDocument()
    expect(screen.queryByText('选择 AI 自动化')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('project-workflow-configure-ai-coordinator'))
    expect(onRequestConfigureAiCoordinator).toHaveBeenCalledOnce()
  })

  test('selects execution type with radios and binds a concrete robot separately', async () => {
    const onChange = vi.fn()
    const onEnsureStageRobotRule = vi.fn().mockResolvedValue('workflow-rule-1')
    const onRequestCreateRobot = vi.fn()
    render(
      <ProjectWorkflowEditor
        value={workflow}
        busy={false}
        onChange={onChange}
        onSave={vi.fn()}
        projectAgents={[robot]}
        onEnsureStageRobotRule={onEnsureStageRobotRule}
        onRequestCreateRobot={onRequestCreateRobot}
      />
    )

    fireEvent.click(screen.getByTestId('project-workflow-stage-develop'))
    expect(screen.getByTestId('project-workflow-stage-executor-human-develop')).toBeChecked()
    expect(
      screen.queryByTestId('project-workflow-stage-automation-develop')
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('project-workflow-stage-executor-robot-develop'))
    expect(screen.getByTestId('project-workflow-stage-executor-robot-develop')).toBeChecked()
    expect(screen.getByTestId('project-workflow-stage-automation-develop')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('project-workflow-stage-add-robot'))
    expect(onRequestCreateRobot).toHaveBeenCalledOnce()

    fireEvent.change(screen.getByTestId('project-workflow-stage-automation-develop'), {
      target: { value: robot.id },
    })
    await waitFor(() => expect(onEnsureStageRobotRule).toHaveBeenCalledWith(robot.id))
    expect(onChange).toHaveBeenLastCalledWith({
      ...workflow,
      nodes: [
        workflow.nodes[0],
        {
          ...workflow.nodes[1],
          automation_rule_id: 'workflow-rule-1',
          workspace_policy: 'none',
        },
        workflow.nodes[2],
        workflow.nodes[3],
      ],
    })
  })

  test('returns a stage to human execution when robot rule creation fails', async () => {
    const onChange = vi.fn()
    render(
      <ProjectWorkflowEditor
        value={workflow}
        busy={false}
        onChange={onChange}
        onSave={vi.fn()}
        projectAgents={[robot]}
        onEnsureStageRobotRule={vi.fn().mockRejectedValue(new Error('offline'))}
      />
    )

    fireEvent.click(screen.getByTestId('project-workflow-stage-develop'))
    fireEvent.click(screen.getByTestId('project-workflow-stage-executor-robot-develop'))
    fireEvent.change(screen.getByTestId('project-workflow-stage-automation-develop'), {
      target: { value: robot.id },
    })

    await waitFor(() =>
      expect(screen.getByTestId('project-workflow-stage-executor-human-develop')).toBeChecked()
    )
    expect(onChange).toHaveBeenLastCalledWith(workflow)
  })
})
