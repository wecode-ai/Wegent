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

const workflow: ProjectWorkflowDefinition = {
  version: 1,
  stage_mode: 'dag',
  advancement_policy: 'manual',
  nodes: [
    {
      id: 'develop',
      name: '开发',
      prompt: '实现 Issue 中描述的功能',
      node_type: 'stage',
      depends_on: [],
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

  test('renders stage cards without any start or end node', () => {
    render(
      <ProjectWorkflowEditor value={workflow} busy={false} onChange={vi.fn()} onSave={vi.fn()} />
    )

    expect(screen.getByTestId('project-workflow-stage-develop')).toBeInTheDocument()
    expect(screen.queryByTestId('project-workflow-end-marker-test')).not.toBeInTheDocument()
    expect(screen.queryByTestId('project-workflow-start-start')).not.toBeInTheDocument()
    expect(screen.queryByTestId('project-workflow-end-end')).not.toBeInTheDocument()
  })

  test('keeps an empty dag empty and gates saving until a stage is added', () => {
    const onChange = vi.fn()
    render(
      <ProjectWorkflowEditor
        value={{ version: 1, stage_mode: 'dag', advancement_policy: 'manual', nodes: [] }}
        busy={false}
        onChange={onChange}
        onSave={vi.fn()}
      />
    )

    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByTestId('project-workflow-save')).toBeDisabled()
    expect(screen.queryByTestId('project-workflow-stage-develop')).not.toBeInTheDocument()
  })

  test('shows a compact graph and edits the selected stage in the inspector', () => {
    const onChange = vi.fn()
    render(
      <ProjectWorkflowEditor value={workflow} busy={false} onChange={onChange} onSave={vi.fn()} />
    )

    expect(screen.getByTestId('project-workflow-dag')).toBeInTheDocument()
    expect(screen.getByTestId('project-workflow-inspector-develop')).toBeInTheDocument()
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
        {
          ...workflow.nodes[1],
          prompt: '验证开发结果并提交报告',
        },
      ],
    })

    fireEvent.click(screen.getByTestId('project-workflow-edge-develop-test'))
    expect(screen.getByTestId('project-workflow-edge-inspector-develop-test')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('project-workflow-edge-context-activity'))
    expect(onChange).toHaveBeenLastCalledWith({
      ...workflow,
      nodes: [
        workflow.nodes[0],
        {
          ...workflow.nodes[1],
          dependency_context: {
            develop: ['final_result', 'deliveries', 'activity'],
          },
        },
      ],
    })

    fireEvent.click(screen.getByTestId('project-workflow-edge-delete-develop-test'))
    expect(onChange).toHaveBeenLastCalledWith({
      ...workflow,
      nodes: [workflow.nodes[0], { ...workflow.nodes[1], depends_on: [], dependency_context: {} }],
    })

    fireEvent.click(screen.getByTestId('project-workflow-add'))
    expect(onChange).toHaveBeenLastCalledWith({
      ...workflow,
      stage_mode: 'dag',
      nodes: [
        workflow.nodes[0],
        workflow.nodes[1],
        expect.objectContaining({
          id: 'stage-1',
          name: '新阶段 1',
          node_type: 'stage',
          depends_on: ['test'],
          dependency_context: {
            test: ['final_result', 'deliveries'],
          },
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
        {
          ...workflow.nodes[0],
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
        workflow.nodes[1],
      ],
    }
    expect(onChange).toHaveBeenLastCalledWith(expectedDefinition)
    expect(onSave).toHaveBeenCalledWith(expectedDefinition)
    expect(screen.queryByTestId('workflow-deliverable-requirements-dialog')).not.toBeInTheDocument()
  })

  test('wraps long deliverable acceptance descriptions inside the inspector list', () => {
    const onChange = vi.fn()
    render(
      <ProjectWorkflowEditor
        value={{
          ...workflow,
          nodes: [
            {
              ...workflow.nodes[0],
              required_deliverables: [
                {
                  id: 'report',
                  name: '测试报告',
                  description:
                    'https://very-long-acceptance-' + 'x'.repeat(300) + '.example.com/说明',
                  value_type: 'text',
                },
              ],
            },
          ],
        }}
        busy={false}
        onChange={onChange}
        onSave={vi.fn()}
      />
    )

    fireEvent.click(screen.getByTestId('project-workflow-stage-develop'))
    const list = screen.getByTestId('project-workflow-deliverable-list-develop')
    const tile = screen.getByTestId('project-workflow-deliverable-report')
    expect(list).toHaveClass('min-w-0')
    expect(tile.querySelectorAll('span > span')[1]).toHaveClass(
      'whitespace-normal',
      '[overflow-wrap:anywhere]'
    )
  })

  test('edits an existing deliverable by clicking its compact tile', () => {
    const onChange = vi.fn()
    const workflowWithDeliverable: ProjectWorkflowDefinition = {
      ...workflow,
      nodes: [
        {
          ...workflow.nodes[0],
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
        workflow.nodes[1],
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
        {
          ...workflowWithDeliverable.nodes[0],
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
        workflowWithDeliverable.nodes[1],
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
        expect.objectContaining({
          id: 'stage-1',
          name: '新阶段 1',
          depends_on: ['develop'],
          dependency_context: {
            develop: ['final_result', 'deliveries'],
          },
        }),
        {
          ...workflow.nodes[1],
          depends_on: ['stage-1'],
          dependency_context: {
            'stage-1': ['final_result', 'deliveries'],
          },
        },
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
      nodes: [workflow.nodes[0], { ...workflow.nodes[1], depends_on: [], dependency_context: {} }],
    })

    onChange.mockClear()
    fireEvent.click(screen.getByTestId('project-workflow-stage-test'))
    fireEvent.keyDown(screen.getByTestId('mock-react-flow'), { key: 'Backspace' })
    expect(onChange).toHaveBeenLastCalledWith({
      ...workflow,
      nodes: [workflow.nodes[0]],
    })
  })

  test('inserts before a selected stage and migrates its incoming edge context', () => {
    const onChange = vi.fn()
    const workflowWithContext: ProjectWorkflowDefinition = {
      ...workflow,
      nodes: [
        workflow.nodes[0],
        {
          ...workflow.nodes[1],
          dependency_context: {
            develop: ['activity'],
          },
        },
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
        expect.objectContaining({
          id: 'stage-1',
          depends_on: ['develop'],
          dependency_context: {
            develop: ['activity'],
          },
        }),
        {
          ...workflowWithContext.nodes[1],
          depends_on: ['stage-1'],
          dependency_context: {
            'stage-1': ['final_result', 'deliveries'],
          },
        },
      ],
    })
  })

  test('adds a wait node at the end of the workflow', () => {
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
                action: 'complete',
                rerun_prompt: '',
              },
            ],
            agent_id: null,
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
  })

  test('appends stages after the current tail without rewriting existing edges', () => {
    const initial = workflow
    const onChange = vi.fn()
    const { rerender } = render(
      <ProjectWorkflowEditor value={initial} busy={false} onChange={onChange} onSave={vi.fn()} />
    )

    fireEvent.click(screen.getByTestId('project-workflow-add'))
    const afterStage = onChange.mock.calls.at(-1)![0] as ProjectWorkflowDefinition
    expect(afterStage.nodes.at(-1)).toEqual(
      expect.objectContaining({
        id: 'stage-1',
        depends_on: ['test'],
        dependency_context: { test: ['final_result', 'deliveries'] },
      })
    )
    expect(afterStage.nodes.find(node => node.id === 'test')).toEqual(
      expect.objectContaining({ depends_on: ['develop'] })
    )
    rerender(
      <ProjectWorkflowEditor value={afterStage} busy={false} onChange={onChange} onSave={vi.fn()} />
    )

    fireEvent.click(screen.getByTestId('project-workflow-add-wait'))
    const afterWait = onChange.mock.calls.at(-1)![0] as ProjectWorkflowDefinition
    expect(afterWait.nodes.find(node => node.id === 'wait-1')).toEqual(
      expect.objectContaining({
        depends_on: ['stage-1'],
        dependency_context: { 'stage-1': ['final_result', 'deliveries'] },
      })
    )
    expect(afterWait.nodes.find(node => node.id === 'stage-1')).toEqual(
      expect.objectContaining({ depends_on: ['test'] })
    )
  })

  test('edits wait rules and gates saving on a non-empty event type', () => {
    const onChange = vi.fn()
    const workflowWithWait: ProjectWorkflowDefinition = {
      ...workflow,
      nodes: [
        workflow.nodes[0],
        {
          id: 'wait-1',
          name: '等待外部事件',
          node_type: 'wait',
          depends_on: ['test'],
          required: true,
          workspace_policy: 'none',
          automation_rule_id: null,
          wait_config: {
            rules: [{ id: 'rule-1', event_type: '', action: 'rerun', rerun_prompt: '' }],
            agent_id: null,
          },
        },
        workflow.nodes[1],
      ],
    }
    const renderEditor = (value: ProjectWorkflowDefinition) =>
      render(
        <ProjectWorkflowEditor
          value={value}
          busy={false}
          onChange={onChange}
          onSave={vi.fn()}
          projectAgents={[robot]}
        />
      )
    const { rerender } = renderEditor(workflowWithWait)

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
              agent_id: null,
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
                ...node.wait_config,
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
        projectAgents={[robot]}
      />
    )
    // A rerun rule with no robot still blocks saving: the robot must be picked
    // explicitly instead of inheriting the upstream stage's robot.
    expect(screen.getByTestId('project-workflow-save')).toBeDisabled()
    fireEvent.change(screen.getByTestId('project-workflow-wait-robot-wait-1'), {
      target: { value: robot.id },
    })
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        nodes: expect.arrayContaining([
          expect.objectContaining({
            id: 'wait-1',
            wait_config: {
              agent_id: 'robot-1',
              rules: [expect.objectContaining({ id: 'rule-1' })],
            },
          }),
        ]),
      })
    )

    const ruleWithRobot: ProjectWorkflowDefinition = {
      ...ruleWithEvent,
      nodes: ruleWithEvent.nodes.map(node =>
        node.id === 'wait-1'
          ? {
              ...node,
              wait_config: {
                ...node.wait_config,
                agent_id: robot.id,
              },
            }
          : node
      ),
    }
    rerender(
      <ProjectWorkflowEditor
        value={ruleWithRobot}
        busy={false}
        onChange={onChange}
        onSave={vi.fn()}
        projectAgents={[robot]}
      />
    )
    expect(screen.getByTestId('project-workflow-save')).toBeEnabled()

    fireEvent.click(screen.getByTestId('project-workflow-wait-rule-add-wait-1'))
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        nodes: expect.arrayContaining([
          expect.objectContaining({
            id: 'wait-1',
            wait_config: {
              agent_id: 'robot-1',
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
      ...ruleWithRobot,
      nodes: ruleWithRobot.nodes.map(node =>
        node.id === 'wait-1'
          ? {
              ...node,
              wait_config: {
                ...node.wait_config,
                rules: [
                  {
                    ...node.wait_config!.rules[0],
                  },
                  {
                    id: 'rule-2',
                    event_type: '',
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
        projectAgents={[robot]}
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
              agent_id: 'robot-1',
              rules: [expect.objectContaining({ id: 'rule-1' })],
            },
          }),
        ]),
      })
    )
    rerender(
      <ProjectWorkflowEditor
        value={ruleWithRobot}
        busy={false}
        onChange={onChange}
        onSave={vi.fn()}
        projectAgents={[robot]}
      />
    )
    expect(screen.getByTestId('project-workflow-save')).toBeEnabled()
  })

  test('shows no trigger policy controls in the wait rule panel', () => {
    const onChange = vi.fn()
    const workflowWithWait: ProjectWorkflowDefinition = {
      ...workflow,
      nodes: [
        workflow.nodes[0],
        workflow.nodes[1],
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
              {
                id: 'rule-1',
                event_type: 'ci_failed',
                action: 'rerun',
                rerun_prompt: '',
              },
            ],
          },
        },
      ],
    }
    render(
      <ProjectWorkflowEditor
        value={workflowWithWait}
        busy={false}
        onChange={onChange}
        onSave={vi.fn()}
      />
    )

    fireEvent.click(screen.getByTestId('project-workflow-wait-wait-1'))
    expect(
      screen.getByTestId('project-workflow-wait-rule-action-wait-1-rule-1')
    ).toBeInTheDocument()
    expect(
      screen.queryByTestId('project-workflow-wait-rule-mode-wait-1-rule-1')
    ).not.toBeInTheDocument()
    expect(
      screen.queryByTestId('project-workflow-wait-rule-policy-wait-1-rule-1')
    ).not.toBeInTheDocument()
  })

  test('only shows a rerun robot picker when a rerun rule exists', () => {
    const onChange = vi.fn()
    const completeOnly: ProjectWorkflowDefinition = {
      ...workflow,
      nodes: [
        workflow.nodes[0],
        workflow.nodes[1],
        {
          id: 'wait-1',
          name: '等待外部事件',
          node_type: 'wait',
          depends_on: ['test'],
          required: true,
          workspace_policy: 'none',
          automation_rule_id: null,
          wait_config: {
            rules: [{ id: 'rule-1', event_type: 'merged', action: 'complete', rerun_prompt: '' }],
            agent_id: null,
          },
        },
      ],
    }
    const { rerender } = render(
      <ProjectWorkflowEditor
        value={completeOnly}
        busy={false}
        onChange={onChange}
        onSave={vi.fn()}
        projectAgents={[robot]}
      />
    )

    fireEvent.click(screen.getByTestId('project-workflow-wait-wait-1'))
    expect(screen.queryByTestId('project-workflow-wait-robot-wait-1')).not.toBeInTheDocument()

    const withRerun: ProjectWorkflowDefinition = {
      ...completeOnly,
      nodes: completeOnly.nodes.map(node =>
        node.id === 'wait-1'
          ? {
              ...node,
              wait_config: {
                ...node.wait_config,
                rules: [
                  { id: 'rule-1', event_type: 'ci_failed', action: 'rerun', rerun_prompt: '' },
                ],
              },
            }
          : node
      ),
    }
    rerender(
      <ProjectWorkflowEditor
        value={withRerun}
        busy={false}
        onChange={onChange}
        onSave={vi.fn()}
        projectAgents={[robot]}
      />
    )
    expect(screen.getByTestId('project-workflow-wait-robot-wait-1')).toBeInTheDocument()
  })

  test('picks adapter event types from a combobox and keeps typing for custom values', () => {
    const onChange = vi.fn()
    const catalog = [
      {
        provider: 'gitlab',
        event_type: 'merged',
        category: 'lifecycle',
        description: 'The merge request was merged',
        reference_kind: 'pull_request',
        reference_name: 'GitLab MR',
        opaque_ref_format: 'group/project!iid',
      },
      {
        provider: 'gitlab',
        event_type: 'ci_failed',
        category: 'ci',
        description: 'A pipeline for the merge request failed',
        reference_kind: 'pull_request',
        reference_name: 'GitLab MR',
        opaque_ref_format: 'group/project!iid',
      },
      {
        provider: 'gitlab',
        event_type: 'review_comment',
        category: 'review',
        description: 'A new comment was added to the merge request',
        reference_kind: 'pull_request',
        reference_name: 'GitLab MR',
        opaque_ref_format: 'group/project!iid',
      },
    ]
    const workflowWithWait: ProjectWorkflowDefinition = {
      ...workflow,
      nodes: [
        workflow.nodes[0],
        workflow.nodes[1],
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
              {
                id: 'rule-1',
                event_type: '',
                action: 'complete',
                rerun_prompt: '',
              },
            ],
          },
        },
      ],
    }
    const { rerender } = render(
      <ProjectWorkflowEditor
        value={workflowWithWait}
        busy={false}
        onChange={onChange}
        onSave={vi.fn()}
        externalEventCatalog={catalog}
      />
    )

    fireEvent.click(screen.getByTestId('project-workflow-wait-wait-1'))
    expect(screen.getByTestId('project-workflow-inspector-wait-1')).toBeInTheDocument()
    expect(screen.getByTestId('project-workflow-wait-rule-event-wait-1-rule-1')).toHaveClass(
      'w-full'
    )

    fireEvent.focus(screen.getByTestId('project-workflow-wait-rule-event-wait-1-rule-1'))
    expect(screen.getByText('gitlab')).toBeInTheDocument()
    expect(screen.getByText('ci_failed')).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('project-workflow-wait-rule-event-wait-1-rule-1'), {
      target: { value: 'ci' },
    })
    expect(screen.getByText('ci_failed')).toBeInTheDocument()
    expect(screen.queryByText('merged')).not.toBeInTheDocument()
    expect(screen.queryByText('review_comment')).not.toBeInTheDocument()
    fireEvent.change(screen.getByTestId('project-workflow-wait-rule-event-wait-1-rule-1'), {
      target: { value: '' },
    })
    fireEvent.click(
      screen.getByTestId('project-workflow-wait-rule-event-wait-1-rule-1-option-gitlab-ci_failed')
    )
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        nodes: expect.arrayContaining([
          expect.objectContaining({
            id: 'wait-1',
            wait_config: {
              rules: [
                expect.objectContaining({
                  id: 'rule-1',
                  event_type: 'ci_failed',
                  provider: 'gitlab',
                }),
              ],
            },
          }),
        ]),
      })
    )

    const selectedWorkflow = onChange.mock.calls.at(-1)?.[0] as ProjectWorkflowDefinition
    rerender(
      <ProjectWorkflowEditor
        value={selectedWorkflow}
        busy={false}
        onChange={onChange}
        onSave={vi.fn()}
        externalEventCatalog={catalog}
      />
    )
    expect(screen.getByText(/opaque_ref 形如 group\/project!iid/)).toBeInTheDocument()

    fireEvent.change(screen.getByTestId('project-workflow-wait-rule-event-wait-1-rule-1'), {
      target: { value: 'gitlab.merge' },
    })
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        nodes: expect.arrayContaining([
          expect.objectContaining({
            id: 'wait-1',
            wait_config: {
              rules: [expect.objectContaining({ id: 'rule-1', event_type: 'gitlab.merge' })],
            },
          }),
        ]),
      })
    )
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
        {
          ...workflow.nodes[0],
          automation_rule_id: 'workflow-rule-1',
          workspace_policy: 'none',
        },
        workflow.nodes[1],
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
