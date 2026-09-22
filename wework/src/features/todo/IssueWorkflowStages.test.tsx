import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import type { Delivery, WorkflowNodeInstance } from '@/api/deliveries'
import { IssueWorkflowStages } from '@wegent/collaboration'

const testTranslate = (key: string, options?: { count?: number }): string => {
  if (key === 'todo.workflow_task_count') return `${options?.count ?? 0} 个任务`
  return (
    {
      'todo.workflow_active_stages': '当前阶段',
      'todo.workflow_node_details': '节点详情',
      'todo.workflow_stage_human_execution': '手动执行',
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
      'todo.workflow_node_waiting': '等待事件',
      'todo.workflow_node_reacting': '处理事件中',
      'todo.workflow_structure_node': '流程控制',
      'todo.workflow_node_queued': '排队中',
      'todo.workflow_node_running': '执行中',
      'todo.workflow_node_awaiting_approval': '待人工批准',
      'todo.workflow_node_changes_requested': '已驳回，待修改',
      'todo.workflow_node_completed': '已完成',
      'todo.workflow_node_forced_completed': '已强制推进',
      'todo.workflow_node_failed': '执行失败',
      'todo.workflow_required_deliverables': '必要交付物',
      'todo.workflow_deliveries_submitted': '已提交',
      'todo.workflow_deliverable_fulfilled': '已提交',
      'todo.workflow_deliverable_missing': '待提交',
      'todo.workflow_deliverables_missing_count': '仍有交付物未提交',
      'todo.deliverable_type_text': '文本',
      'todo.deliverable_type_file': '文件',
      'todo.workflow_upload_deliverables': '上传交付物',
      'todo.workflow_approve_stage': '批准进入下一阶段',
      'todo.workflow_reject_stage': '驳回',
      'todo.workflow_force_advance': '强制推进',
      'todo.workflow_branch_collector_poll': '轮询采集中',
      'todo.workflow_branch_collector_webhook': 'webhook 待注册',
      'todo.workflow_decision_reason_placeholder': '填写原因',
      'todo.workflow_wait_dependencies': '等待前置阶段',
      'todo.workflow_no_stage_tasks': '尚无具体任务',
    }[key] ?? key
  )
}

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: testTranslate,
  }),
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

describe('IssueWorkflowStages', () => {
  test('renders workflow stages once in their execution order', () => {
    render(
      <IssueWorkflowStages
        translate={testTranslate}
        nodes={[
          stage('分析', { status: 'completed' }),
          stage('实现', { status: 'running' }),
          stage('验证', { status: 'blocked' }),
        ]}
        tasks={[]}
      />
    )

    const stages = screen.getByTestId('cloud-todo-workflow-stages')
    expect(within(stages).getAllByRole('button')).toHaveLength(3)
    expect(stages).toHaveTextContent('分析')
    expect(stages).toHaveTextContent('实现')
    expect(stages).toHaveTextContent('验证')
  })

  test('shows the execution failure reason in the failed stage details', () => {
    render(
      <IssueWorkflowStages
        translate={testTranslate}
        nodes={[stage('开发', { status: 'failed' })]}
        tasks={[]}
        executionError="Transient runtime payload does not match the claimed project"
      />
    )

    expect(screen.getByTestId('cloud-todo-workflow-execution-error-开发')).toHaveTextContent(
      'Transient runtime payload does not match the claimed project'
    )
  })

  test('switches the detail panel when a completed stage is clicked', () => {
    const onCreateTask = vi.fn()
    render(
      <IssueWorkflowStages
        translate={testTranslate}
        nodes={[
          stage('设计', {
            status: 'completed',
            task_statuses: { 'device-1:task-1': 'succeeded' },
          }),
          stage('开发', { status: 'running', depends_on: ['设计'] }),
        ]}
        tasks={[
          {
            id: 1,
            device_id: 'device-1',
            task_id: 'task-1',
            task_title: '设计任务',
            workflow_node_id: '设计',
          },
        ]}
        deviceNamesById={{ 'device-1': '设计工作站' }}
        onCreateTask={onCreateTask}
      />
    )

    expect(screen.getByTestId('cloud-todo-workflow-action-开发')).toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-workflow-action-设计')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('cloud-todo-workflow-node-设计'))

    expect(screen.getByTestId('cloud-todo-workflow-action-设计')).toHaveTextContent('设计任务')
    expect(screen.getByTestId('cloud-todo-workflow-action-设计')).toHaveTextContent(
      '设计工作站 · 成功'
    )
    expect(screen.getByTestId('cloud-todo-workflow-action-设计')).not.toHaveTextContent('device-1')
    expect(screen.queryByTestId('cloud-todo-workflow-action-开发')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-create-workflow-task-设计')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-workflow-node-设计')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })

  test('links the selected stage to the action panel', () => {
    const onCreateTask = vi.fn()
    const onRunAutomation = vi.fn()

    render(
      <IssueWorkflowStages
        translate={testTranslate}
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

    expect(screen.getByTestId('cloud-todo-workflow-action-编辑')).toHaveTextContent('手动执行')
    expect(screen.getByTestId('cloud-todo-workflow-action-编辑')).toHaveTextContent('可开始')
    expect(screen.queryByTestId('cloud-todo-workflow-action-审阅')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-workflow-action-交付')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('cloud-todo-create-workflow-task-编辑'))
    expect(onCreateTask).toHaveBeenCalledWith('编辑')

    fireEvent.click(screen.getByTestId('cloud-todo-workflow-node-审阅'))

    expect(screen.queryByTestId('cloud-todo-workflow-action-编辑')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-workflow-action-审阅')).toHaveTextContent('AI 执行')
    expect(screen.getByTestId('cloud-todo-workflow-action-审阅')).toHaveTextContent('可开始')
    fireEvent.click(screen.getByTestId('cloud-todo-run-workflow-node-审阅'))
    expect(onRunAutomation).toHaveBeenCalledWith('审阅', 'rule-1')
  })

  test('keeps an unconfigured automatic stage out of the manual task flow', () => {
    render(
      <IssueWorkflowStages
        translate={testTranslate}
        nodes={[stage('开发', { execution_mode: 'robot', automation_rule_id: null })]}
        tasks={[]}
        onCreateTask={vi.fn()}
        onRunAutomation={vi.fn()}
      />
    )

    expect(screen.getByTestId('cloud-todo-workflow-action-开发')).toHaveTextContent('AI 执行')
    expect(screen.queryByTestId('cloud-todo-create-workflow-task-开发')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-run-workflow-node-开发')).not.toBeInTheDocument()
  })

  test('prevents duplicate reruns and surfaces the backend rejection', async () => {
    let rejectRun: ((reason?: unknown) => void) | undefined
    const onRunAutomation = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectRun = reject
        })
    )

    render(
      <IssueWorkflowStages
        translate={testTranslate}
        nodes={[stage('部署', { automation_rule_id: 'rule-1', status: 'failed' })]}
        tasks={[]}
        onRunAutomation={onRunAutomation}
      />
    )

    const rerun = screen.getByTestId('cloud-todo-run-workflow-node-部署')
    fireEvent.click(rerun)
    fireEvent.click(rerun)

    expect(onRunAutomation).toHaveBeenCalledTimes(1)
    expect(rerun).toBeDisabled()

    rejectRun?.(new Error('执行设备当前不可用'))

    await waitFor(() => {
      expect(rerun).not.toBeDisabled()
      expect(screen.getByText('执行设备当前不可用')).toBeInTheDocument()
    })
  })

  test('offers another task after a human stage has already started', () => {
    render(
      <IssueWorkflowStages
        translate={testTranslate}
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

  test('allows another task while a human stage awaits approval', () => {
    const onCreateTask = vi.fn()
    render(
      <IssueWorkflowStages
        translate={testTranslate}
        nodes={[stage('编辑', { status: 'awaiting_approval' })]}
        tasks={[]}
        onCreateTask={onCreateTask}
        onDecide={vi.fn(async () => undefined)}
      />
    )

    fireEvent.click(screen.getByTestId('cloud-todo-create-workflow-task-编辑'))

    expect(onCreateTask).toHaveBeenCalledWith('编辑')
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
      <IssueWorkflowStages
        translate={testTranslate}
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
    expect(graphNode).toHaveTextContent('2 个任务')
    expect(within(graphNode).queryByText('最近失败的任务')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('cloud-todo-create-workflow-task-编辑'))
    expect(onCreateTask).toHaveBeenCalledWith('编辑')
  })

  test('collects deliverables when continuing a completed human stage', async () => {
    const onDecide = vi.fn(async () => undefined)
    const onCompleteStage = vi.fn(async () => undefined)
    render(
      <IssueWorkflowStages
        translate={testTranslate}
        nodes={[
          stage('编辑', {
            status: 'awaiting_approval',
            required_deliverables: [
              {
                id: 'test-report',
                name: '测试报告',
                description: '',
                value_type: 'text',
              },
            ],
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
        onCompleteStage={onCompleteStage}
        onDecide={onDecide}
      />
    )

    expect(screen.getByText(/测试报告/)).toBeInTheDocument()
    const deliverableProgress = screen.getByTestId('cloud-todo-workflow-deliverable-progress-编辑')
    const taskList = screen.getByTestId('cloud-todo-workflow-task-list-编辑')
    const createTask = screen.getByTestId('cloud-todo-create-workflow-task-编辑')
    expect(
      deliverableProgress.compareDocumentPosition(taskList) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      taskList.compareDocumentPosition(createTask) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()

    fireEvent.click(screen.getByTestId('cloud-todo-approve-workflow-node-编辑'))
    expect(screen.getByTestId('workflow-stage-completion-dialog')).toBeInTheDocument()
    const fieldset = screen.getByTestId('workflow-deliverable-input-test-report')
    fireEvent.change(fieldset.querySelector('textarea')!, {
      target: { value: '全部测试通过' },
    })
    fireEvent.click(screen.getByTestId('workflow-stage-completion-submit'))
    await waitFor(() =>
      expect(onCompleteStage).toHaveBeenCalledWith(
        '编辑',
        'approve',
        '',
        expect.arrayContaining([
          expect.objectContaining({
            requirement: expect.objectContaining({ id: 'test-report' }),
            text: '全部测试通过',
          }),
        ])
      )
    )
    expect(onDecide).not.toHaveBeenCalled()
  })

  test('shows actual fulfillment status and opens the submitted delivery', () => {
    const onOpenDelivery = vi.fn()
    const onDecide = vi.fn(async () => undefined)
    const delivery: Delivery = {
      id: 'delivery-1',
      loop_item_id: 'issue-1',
      created_by_user_id: 1,
      source_task_binding_id: 1,
      source_task_snapshot: null,
      status: 'delivered',
      created_at: '2026-08-19T00:00:00Z',
      delivered_at: '2026-08-19T00:01:00Z',
      assets: [],
      fulfillments: [
        {
          requirement_id: 'wiki',
          kind: 'text',
          text: '接口文档已完成',
        },
      ],
    }

    render(
      <IssueWorkflowStages
        translate={testTranslate}
        nodes={[
          stage('后端', {
            status: 'awaiting_approval',
            delivery_ids: ['delivery-1'],
            fulfilled_deliverable_ids: ['wiki'],
            required_deliverables: [
              {
                id: 'wiki',
                name: '接口 Wiki',
                description: '',
                value_type: 'text',
              },
              {
                id: 'report',
                name: '测试报告',
                description: '',
                value_type: 'file',
              },
            ],
          }),
        ]}
        tasks={[]}
        deliveries={[delivery]}
        onOpenDelivery={onOpenDelivery}
        onDecide={onDecide}
      />
    )

    expect(screen.getByTestId('cloud-todo-workflow-deliverable-progress-后端')).toHaveTextContent(
      '1/2'
    )
    expect(
      screen.getByTestId('cloud-todo-workflow-deliverable-status-后端-wiki')
    ).toHaveTextContent('已提交')
    expect(
      screen.getByTestId('cloud-todo-workflow-deliverable-status-后端-report')
    ).toHaveTextContent('待提交')

    fireEvent.click(screen.getByTestId('cloud-todo-open-workflow-deliverable-后端-wiki'))
    expect(onOpenDelivery).toHaveBeenCalledWith(delivery)

    fireEvent.click(screen.getByTestId('cloud-todo-approve-workflow-node-后端'))
    expect(screen.getByTestId('workflow-stage-completion-dialog')).toBeInTheDocument()
    expect(screen.queryByTestId('workflow-deliverable-input-wiki')).not.toBeInTheDocument()
    expect(screen.getByTestId('workflow-deliverable-input-report')).toBeInTheDocument()
  })

  test('approves directly when every required deliverable is already fulfilled', async () => {
    const onDecide = vi.fn(async () => undefined)
    render(
      <IssueWorkflowStages
        translate={testTranslate}
        nodes={[
          stage('后端', {
            status: 'awaiting_approval',
            fulfilled_deliverable_ids: ['wiki'],
            required_deliverables: [
              {
                id: 'wiki',
                name: '接口 Wiki',
                description: '',
                value_type: 'text',
              },
            ],
          }),
        ]}
        tasks={[]}
        onDecide={onDecide}
      />
    )

    fireEvent.click(screen.getByTestId('cloud-todo-approve-workflow-node-后端'))

    await waitFor(() => expect(onDecide).toHaveBeenCalledWith('后端', 'approve', ''))
    expect(screen.queryByTestId('workflow-stage-completion-dialog')).not.toBeInTheDocument()
  })
})
