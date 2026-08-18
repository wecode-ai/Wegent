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
      data?: Record<string, unknown>
    }>
    nodeTypes: Record<string, ComponentType<Record<string, unknown>>>
    edgeTypes: Record<string, ComponentType<Record<string, unknown>>>
    onNodeClick?: (event: unknown, node: { id: string }) => void
    children?: ReactNode
  }) => (
    <div>
      {nodes.map(node => {
        const NodeComponent = nodeTypes[node.type]
        return (
          <button key={node.id} type="button" onClick={() => onNodeClick?.({}, node)}>
            <NodeComponent data={node.data} selected={node.selected} />
          </button>
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
      depends_on: [],
      required: true,
      workspace_policy: 'composer',
      automation_rule_id: null,
    },
    {
      id: 'test',
      name: '测试',
      prompt: '运行测试并修复失败',
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
        ...workflow.nodes,
        expect.objectContaining({
          id: 'stage-3',
          name: '新阶段 3',
          depends_on: ['test'],
          dependency_context: {
            test: ['final_result', 'deliveries'],
          },
        }),
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
})
