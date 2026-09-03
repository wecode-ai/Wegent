import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { TaskChangeRequestSnapshot } from '@/api/changeRequests'
import type { CloudLoopItem } from '@/api/deliveries'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import { installDshUiTestContributions } from '@/test/setup'
import { CloudTodoBoardCard } from './CloudTodoBoardCard'

const changeRequestMonitorMocks = vi.hoisted(() => ({
  useTaskChangeRequest: vi.fn(),
}))

vi.mock('@/features/workbench/changeRequestMonitor', async importOriginal => {
  const actual = await importOriginal<typeof import('@/features/workbench/changeRequestMonitor')>()
  return {
    ...actual,
    useTaskChangeRequest: changeRequestMonitorMocks.useTaskChangeRequest,
  }
})

vi.mock('@/components/layout/workspace-panels/TemporaryChatPanel', () => ({
  TemporaryChatPanel: ({
    initialAddress,
    testId,
    sendEphemeral,
    collapseComposerWhenIdle,
    runtimeContext,
  }: {
    initialAddress: { deviceId: string; taskId: string }
    testId: string
    sendEphemeral: boolean
    collapseComposerWhenIdle: boolean
    runtimeContext?: { cloudProjectId?: string }
  }) => (
    <section
      data-testid={testId}
      data-device-id={initialAddress.deviceId}
      data-task-id={initialAddress.taskId}
      data-send-ephemeral={String(sendEphemeral)}
      data-collapse-composer={String(collapseComposerWhenIdle)}
      data-cloud-project-id={runtimeContext?.cloudProjectId}
    >
      Shared task conversation
    </section>
  ),
}))

const item = {
  id: 'WEG-85',
  title: 'Keep the pull request popup visible',
  description: null,
  status: 'in_review',
  priority: 'none',
  can_edit: true,
  can_view_detail: true,
  updated_at: '2026-08-21T00:00:00Z',
} as CloudLoopItem

const snapshot: TaskChangeRequestSnapshot = {
  target: {
    deviceId: 'local',
    taskId: 'task-85',
    workspacePath: '/workspace',
    remoteUrl: 'https://github.com/wecode-ai/Wegent.git',
    branch: 'fix/board-pr-popup',
  },
  changeRequest: {
    provider: 'github',
    number: 85,
    url: 'https://github.com/wecode-ai/Wegent/pull/85',
    title: 'Keep the pull request popup visible',
    state: 'open',
    draft: false,
    checks: 'pending',
    mergeability: 'unknown',
    mergeQueue: 'not_queued',
  },
  fetchedAt: '2026-08-21T00:00:00Z',
  stale: false,
  error: null,
}

describe('CloudTodoBoardCard', () => {
  beforeEach(async () => {
    await installDshUiTestContributions(
      {
        [WEWORK_DSH_SLOTS.boardCardStatus]: [
          {
            id: 'git-change-request',
            module: 'plugins/wework-ui-git-board-card-status.js',
          },
        ],
      },
      {
        'plugins/wework-ui-git-board-card-status.js': () =>
          import('../../../dsh/ui-git/src/board-card-status'),
      }
    )
  })

  it('opens execution configuration from the blocking card action', async () => {
    changeRequestMonitorMocks.useTaskChangeRequest.mockReturnValue(null)
    const onClick = vi.fn()
    const onConfigureExecution = vi.fn()

    render(
      <CloudTodoBoardCard
        item={{
          ...item,
          status: 'in_progress',
          workflow: {
            version: 1,
            definition_version: 1,
            stage_mode: 'dag',
            advancement_policy: 'manual',
            execution_config: null,
            nodes: [
              {
                id: 'automatic-stage',
                name: '自动阶段',
                execution_mode: 'robot',
                depends_on: [],
                required: true,
                workspace_policy: 'composer',
                automation_rule_id: 'automation-stage',
                execution_config: null,
                execution_config_override: false,
                status: 'ready',
                task_ids: [],
              },
            ],
          },
        }}
        processingStatus
        onClick={onClick}
        onConfigureExecution={onConfigureExecution}
        onArchive={vi.fn()}
        display={{
          showAssignee: false,
          showPriority: false,
          showTags: false,
          showDate: false,
        }}
      />
    )

    expect(screen.getByTestId('cloud-todo-card-needs-execution-config-WEG-85')).toHaveTextContent(
      '待配置'
    )
    expect(screen.queryByText('可开始')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('cloud-todo-card-configure-execution-WEG-85'))

    expect(onConfigureExecution).toHaveBeenCalledTimes(1)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('shows the current workflow stage before any task starts', () => {
    changeRequestMonitorMocks.useTaskChangeRequest.mockReturnValue(null)

    render(
      <CloudTodoBoardCard
        item={{
          ...item,
          status: 'pending',
          workflow: {
            version: 1,
            definition_version: 1,
            nodes: [
              {
                id: 'manual-stage',
                name: '手动阶段',
                execution_mode: 'human',
                depends_on: [],
                required: true,
                workspace_policy: 'none',
                status: 'ready',
              },
              {
                id: 'automatic-stage',
                name: '自动阶段',
                execution_mode: 'robot',
                depends_on: ['manual-stage'],
                required: true,
                workspace_policy: 'none',
                status: 'blocked',
              },
            ],
          },
        }}
        onClick={vi.fn()}
        onArchive={vi.fn()}
        display={{
          showAssignee: false,
          showPriority: false,
          showTags: false,
          showDate: false,
        }}
      />
    )

    expect(screen.getByTestId('cloud-todo-card-workflow-stage-WEG-85')).toHaveTextContent(
      '手动阶段'
    )
    expect(screen.getByTestId('cloud-todo-card-workflow-status-WEG-85')).toHaveTextContent('可开始')
    expect(screen.queryByTestId('cloud-todo-card-tasks-WEG-85')).not.toBeInTheDocument()
  })

  it('keeps a failed workflow stage visible after its task stops', () => {
    changeRequestMonitorMocks.useTaskChangeRequest.mockReturnValue(null)

    render(
      <CloudTodoBoardCard
        item={{
          ...item,
          status: 'pending',
          workflow: {
            version: 2,
            definition_version: 1,
            nodes: [
              {
                id: 'automatic-stage',
                name: '自动阶段',
                execution_mode: 'robot',
                depends_on: [],
                required: true,
                workspace_policy: 'none',
                status: 'failed',
                execution_error: 'Execution model is unavailable',
              },
            ],
          },
        }}
        taskBindings={[
          {
            id: 85,
            device_id: 'local',
            task_id: 'task-85',
            task_title: 'Run automation',
            running: false,
            finalResponseLoaded: true,
          },
        ]}
        onClick={vi.fn()}
        onArchive={vi.fn()}
        display={{
          showAssignee: false,
          showPriority: false,
          showTags: false,
          showDate: false,
        }}
      />
    )

    expect(screen.getByTestId('cloud-todo-card-workflow-stage-WEG-85')).toHaveTextContent(
      '自动阶段'
    )
    expect(screen.getByTestId('cloud-todo-card-workflow-status-WEG-85')).toHaveTextContent(
      '执行失败'
    )
    expect(screen.queryByTestId('cloud-todo-card-tasks-WEG-85')).not.toBeInTheDocument()
  })

  it('renders the pull request popup outside the overflow-hidden board card', async () => {
    changeRequestMonitorMocks.useTaskChangeRequest.mockReturnValue(snapshot)

    render(
      <CloudTodoBoardCard
        item={item}
        taskBindings={[
          {
            id: 85,
            device_id: 'local',
            task_id: 'task-85',
            task_title: 'Fix the board popup',
            running: false,
            changeRequestTarget: snapshot.target,
          },
        ]}
        onClick={vi.fn()}
        onArchive={vi.fn()}
        display={{
          showAssignee: false,
          showPriority: false,
          showTags: false,
          showDate: false,
        }}
      />
    )

    await userEvent.click(screen.getByTestId('cloud-todo-card-change-request-WEG-85-85'))

    const popover = screen.getByTestId('cloud-todo-card-change-request-WEG-85-85-popover')
    expect(popover.parentElement).toBe(document.body)
    expect(popover).toHaveClass('fixed', 'z-system-popover')
  })

  it('aligns the pull request status as a trailing action beside compact progress', () => {
    changeRequestMonitorMocks.useTaskChangeRequest.mockReturnValue(snapshot)

    render(
      <CloudTodoBoardCard
        item={item}
        taskBindings={[
          {
            id: 85,
            device_id: 'local',
            task_id: 'task-85',
            task_title: 'Fix the board popup',
            running: false,
            changeRequestTarget: snapshot.target,
            finalResponsePreview: '已完成布局修复',
          },
        ]}
        onClick={vi.fn()}
        onArchive={vi.fn()}
        display={{
          showAssignee: false,
          showPriority: false,
          showTags: false,
          showDate: false,
        }}
      />
    )

    const summary = screen.getByTestId('cloud-todo-card-task-summary-WEG-85-85')
    const changeRequest = screen.getByTestId('cloud-todo-card-change-request-WEG-85-85')
    const response = screen.getByTestId('cloud-todo-card-final-response-WEG-85')

    expect(summary).toHaveClass('relative')
    expect(changeRequest.parentElement?.parentElement).toHaveClass('absolute', 'right-0', 'top-0')
    expect(response).toHaveClass('h-5', 'truncate', 'pr-7')
    expect(response).not.toHaveClass('min-h-[60px]', 'border-l', 'pl-2')
    expect(summary).not.toHaveTextContent('Fix the board popup')
    expect(screen.getByTestId('cloud-todo-card-tasks-WEG-85')).not.toHaveClass('border-t')
  })

  it('uses spacing instead of full-width separators between card sections', () => {
    changeRequestMonitorMocks.useTaskChangeRequest.mockReturnValue(null)

    render(
      <CloudTodoBoardCard
        item={item}
        taskBindings={[
          {
            id: 85,
            device_id: 'local',
            task_id: 'task-85',
            task_title: 'Fix the board popup',
            running: false,
            finalResponsePreview: '已完成布局修复',
          },
        ]}
        onClick={vi.fn()}
        onArchive={vi.fn()}
        display={{
          showAssignee: false,
          showPriority: true,
          showTags: false,
          showDate: false,
        }}
      />
    )

    const priority = screen.getByText('普通')
    expect(priority.parentElement).not.toHaveClass('border-t')
    expect(screen.getByTestId('cloud-todo-card-tasks-WEG-85')).not.toHaveClass('border-t')
  })

  it('does not open a progress preview when the card has no progress binding', async () => {
    render(
      <CloudTodoBoardCard
        item={item}
        onClick={vi.fn()}
        onArchive={vi.fn()}
        display={{
          showAssignee: false,
          showPriority: false,
          showTags: false,
          showDate: false,
        }}
      />
    )

    fireEvent.mouseEnter(screen.getByTestId('cloud-todo-card-WEG-85'))

    await new Promise(resolve => window.setTimeout(resolve, 500))
    expect(screen.queryByTestId('cloud-todo-card-progress-popup-WEG-85')).not.toBeInTheDocument()
  })

  it('highlights unread cards and mounts the shared task conversation in the hover preview', async () => {
    render(
      <CloudTodoBoardCard
        item={{ ...item, is_unread: true }}
        taskBindings={[
          {
            id: 85,
            device_id: 'local',
            task_id: 'task-85',
            task_title: 'Fix the board popup',
            running: false,
            finalResponsePreview:
              '第一行：完成布局\n第二行：保留工具层级\n第三行：展示完整回复\n第四行：展示验证结果\n第五行：展示提交状态\n第六行：等待确认',
          },
        ]}
        onClick={vi.fn()}
        onArchive={vi.fn()}
        display={{
          showAssignee: false,
          showPriority: false,
          showTags: false,
          showDate: false,
        }}
      />
    )

    expect(screen.getByTestId('cloud-todo-card-drop-WEG-85')).toHaveClass(
      'border-blue-500/15',
      'bg-blue-500/[0.04]'
    )
    expect(screen.getByTestId('cloud-todo-card-final-response-WEG-85')).toHaveTextContent(
      '第六行：等待确认'
    )

    fireEvent.mouseEnter(screen.getByTestId('cloud-todo-card-WEG-85'))

    const conversation = await screen.findByTestId('cloud-todo-card-popup-conversation-WEG-85')
    expect(conversation).toHaveAttribute('data-device-id', 'local')
    expect(conversation).toHaveAttribute('data-task-id', 'task-85')
    expect(conversation).toHaveAttribute('data-send-ephemeral', 'false')
    expect(conversation).toHaveAttribute('data-collapse-composer', 'true')
    expect(conversation).toHaveAttribute('data-cloud-project-id', String(item.cloud_project_id))
  })

  it('keeps repeated task text out of the card and switches the shared hover conversation', async () => {
    render(
      <CloudTodoBoardCard
        item={{ ...item, description: 'This description must be hidden from the card' }}
        taskBindings={[
          {
            id: 85,
            device_id: 'local',
            task_id: 'task-85',
            task_title: 'Fix the board popup',
            running: true,
            finalResponsePreview: '已定位第一个任务的当前回复',
          },
          {
            id: 86,
            device_id: 'local',
            task_id: 'task-86',
            task_title: 'Verify the hover behavior',
            running: true,
            finalResponsePreview: '正在校验第二个任务的运行过程',
          },
        ]}
        onClick={vi.fn()}
        onArchive={vi.fn()}
        display={{
          showAssignee: false,
          showPriority: false,
          showTags: false,
          showDate: false,
        }}
      />
    )

    const card = screen.getByTestId('cloud-todo-card-WEG-85')
    expect(card).not.toHaveTextContent('This description must be hidden from the card')
    expect(screen.getByTestId('cloud-todo-card-tasks-WEG-85')).not.toHaveTextContent(
      'Fix the board popup'
    )

    fireEvent.mouseEnter(card)
    const popup = await screen.findByTestId('cloud-todo-card-progress-popup-WEG-85')
    expect(popup).toHaveClass('w-[480px]', 'overflow-x-hidden')
    expect(popup).toHaveAttribute('role', 'dialog')
    expect(popup).toHaveTextContent('Fix the board popup')
    expect(popup).toHaveTextContent('Verify the hover behavior')

    fireEvent.mouseEnter(screen.getByTestId('cloud-todo-card-progress-task-WEG-85-86'))
    expect(screen.queryByText('Fix the board popup')).not.toBeInTheDocument()
    expect(screen.getByText('Verify the hover behavior')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-card-popup-conversation-WEG-85')).toHaveAttribute(
      'data-task-id',
      'task-86'
    )
  })
})
