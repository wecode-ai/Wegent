import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useEffect, type ComponentType, type ReactNode } from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { WorkflowNodeInstance } from '@/api/deliveries'
import { IssueWorkflowDag } from './IssueWorkflowDag'

const fitView = vi.fn()

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string): string =>
      ({
        'todo.workflow_active_stages': '当前阶段',
        'todo.workflow_stage_human_execution': '人工执行',
        'todo.workflow_ai_execution': 'AI 执行',
        'todo.workflow_start_work': '开始处理',
        'todo.workflow_add_stage_task': '添加任务',
        'todo.workflow_view_execution_short': '查看',
        'todo.workflow_task_executions': '任务执行',
        'todo.workflow_task_status_running': '执行中',
        'todo.workflow_task_status_succeeded': '成功',
        'todo.workflow_task_status_failed': '失败',
        'todo.workflow_task_status_cancelled': '已取消',
        'todo.workflow_task_status_archived': '已归档',
        'todo.workflow_task_status_pending': '等待执行',
        'todo.workflow_run_again': '重新运行',
        'todo.workflow_run': '运行',
        'todo.workflow_node_blocked': '等待前置任务',
        'todo.workflow_node_ready': '可开始',
        'todo.workflow_node_queued': '排队中',
        'todo.workflow_node_running': '执行中',
        'todo.workflow_node_awaiting_approval': '待人工批准',
        'todo.workflow_node_changes_requested': '已驳回，待修改',
        'todo.workflow_node_completed': '已完成',
        'todo.workflow_node_forced_completed': '已强制推进',
        'todo.workflow_node_failed': '执行失败',
        'todo.workflow_required_deliverables': '必要交付物',
        'todo.workflow_deliveries_submitted': '已提交',
        'todo.workflow_upload_deliverables': '上传交付物',
        'todo.workflow_approve_stage': '批准进入下一阶段',
        'todo.workflow_reject_stage': '驳回',
        'todo.workflow_force_advance': '强制推进',
        'todo.workflow_decision_reason_placeholder': '填写原因',
        'todo.workflow_wait_dependencies': '等待前置阶段',
        'todo.workflow_no_stage_tasks': '尚无具体任务',
      })[key] ?? key,
  }),
}))

vi.mock('@xyflow/react', () => ({
  Background: () => null,
  Controls: () => null,
  Handle: () => null,
  MarkerType: { ArrowClosed: 'arrowclosed' },
  Position: { Left: 'left', Right: 'right' },
  ReactFlow: ({
    nodes,
    nodeTypes,
    children,
    onInit,
  }: {
    nodes: Array<{ id: string; type: string; data: Record<string, unknown> }>
    nodeTypes: Record<string, ComponentType<{ data: Record<string, unknown> }>>
    children?: ReactNode
    onInit?: (instance: { fitView: typeof fitView }) => void
  }) => {
    useEffect(() => {
      onInit?.({ fitView })
    }, [onInit])

    return (
      <div data-testid="mock-react-flow">
        {nodes.map(node => {
          const NodeComponent = nodeTypes[node.type]
          return <NodeComponent key={node.id} data={node.data} />
        })}
        {children}
      </div>
    )
  },
}))

const stage = (
  id: string,
  overrides: Partial<WorkflowNodeInstance> = {}
): WorkflowNodeInstance => ({
  id,
  name: id,
  depends_on: [],
  required: true,
  workspace_policy: 'composer',
  status: 'ready',
  ...overrides,
})

describe('IssueWorkflowDag', () => {
  beforeEach(() => {
    fitView.mockReset()
  })

  test('focuses the current stage and follows it when execution advances', async () => {
    const { rerender } = render(
      <IssueWorkflowDag
        nodes={[stage('编辑', { status: 'running' }), stage('审阅', { status: 'blocked' })]}
        tasks={[]}
      />
    )

    await waitFor(() =>
      expect(fitView).toHaveBeenCalledWith({
        padding: 0.25,
        maxZoom: 1,
        duration: 0,
        nodes: [{ id: '编辑' }],
      })
    )

    fitView.mockClear()
    rerender(
      <IssueWorkflowDag
        nodes={[stage('编辑', { status: 'completed' }), stage('审阅', { status: 'ready' })]}
        tasks={[]}
      />
    )

    await waitFor(() =>
      expect(fitView).toHaveBeenCalledWith({
        padding: 0.25,
        maxZoom: 1,
        duration: 300,
        nodes: [{ id: '审阅' }],
      })
    )
  })

  test('exposes ready human and AI stage actions outside the zoomable graph', () => {
    const onCreateTask = vi.fn()
    const onRunAutomation = vi.fn()

    render(
      <IssueWorkflowDag
        nodes={[
          stage('编辑'),
          stage('审阅', { automation_rule_id: 'rule-1' }),
          stage('交付', { status: 'blocked' }),
        ]}
        tasks={[]}
        onCreateTask={onCreateTask}
        onRunAutomation={onRunAutomation}
      />
    )

    expect(screen.getByTestId('cloud-todo-workflow-actions')).toHaveTextContent('当前阶段')
    expect(screen.getByTestId('cloud-todo-workflow-action-编辑')).toHaveTextContent(
      '人工执行 · 可开始'
    )
    expect(screen.getByTestId('cloud-todo-workflow-action-审阅')).toHaveTextContent(
      'AI 执行 · 可开始'
    )
    expect(screen.queryByTestId('cloud-todo-workflow-action-交付')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('cloud-todo-create-workflow-task-编辑'))
    expect(onCreateTask).toHaveBeenCalledWith('编辑')

    fireEvent.click(screen.getByTestId('cloud-todo-run-workflow-node-审阅'))
    expect(onRunAutomation).toHaveBeenCalledWith('审阅', 'rule-1')
  })

  test('offers another task after a human stage has already started', () => {
    render(
      <IssueWorkflowDag
        nodes={[stage('编辑', { status: 'running' })]}
        tasks={[
          {
            id: 1,
            device_id: 'device-1',
            task_id: 'task-1',
            task_title: '已有任务',
            workflow_node_id: '编辑',
          },
        ]}
        onCreateTask={vi.fn()}
      />
    )

    expect(screen.getByTestId('cloud-todo-create-workflow-task-编辑')).toHaveTextContent('添加任务')
  })

  test('lists every task execution for a failed stage and keeps the add task action', () => {
    const onOpenTask = vi.fn()
    const onCreateTask = vi.fn()
    const latestTask = {
      id: 2,
      device_id: 'device-1',
      task_id: 'task-2',
      task_title: '最近失败的任务',
      workflow_node_id: '编辑',
    }

    render(
      <IssueWorkflowDag
        nodes={[
          stage('编辑', {
            status: 'failed',
            task_statuses: {
              'device-1:task-1': 'failed',
              'device-1:task-2': 'succeeded',
            },
          }),
        ]}
        tasks={[
          latestTask,
          {
            id: 1,
            device_id: 'device-1',
            task_id: 'task-1',
            task_title: '较早的任务',
            workflow_node_id: '编辑',
          },
        ]}
        onCreateTask={onCreateTask}
        onOpenTask={onOpenTask}
      />
    )

    const taskList = screen.getByTestId('cloud-todo-workflow-task-list-编辑')
    expect(within(taskList).getAllByRole('button')).toHaveLength(2)
    expect(taskList).toHaveTextContent('最近失败的任务')
    expect(taskList).toHaveTextContent('较早的任务')
    expect(screen.getByTestId('cloud-todo-workflow-task-status-编辑-2')).toHaveTextContent('成功')
    expect(screen.getByTestId('cloud-todo-workflow-task-status-编辑-1')).toHaveTextContent('失败')

    fireEvent.click(screen.getByTestId('cloud-todo-open-workflow-task-编辑-2'))
    expect(onOpenTask).toHaveBeenCalledWith(latestTask)

    const graphNode = screen.getByTestId('cloud-todo-workflow-node-编辑')
    expect(graphNode).toHaveTextContent('任务执行2')
    expect(within(graphNode).queryByText('最近失败的任务')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('cloud-todo-create-workflow-task-编辑'))
    expect(onCreateTask).toHaveBeenCalledWith('编辑')
  })

  test('exposes deliverable upload and approval for a completed human task', () => {
    const onDecide = vi.fn(async () => undefined)
    render(
      <IssueWorkflowDag
        nodes={[
          stage('编辑', {
            status: 'awaiting_approval',
            required_deliverables: ['测试报告'],
            delivery_ids: ['delivery-1'],
          }),
        ]}
        tasks={[
          {
            id: 1,
            device_id: 'device-1',
            task_id: 'task-1',
            task_title: '已有任务',
            workflow_node_id: '编辑',
          },
        ]}
        onCreateTask={vi.fn()}
        onDecide={onDecide}
      />
    )

    expect(screen.getByText(/测试报告/)).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('cloud-todo-approve-workflow-node-编辑'))
    expect(onDecide).toHaveBeenCalledWith('编辑', 'approve', '')
  })
})
