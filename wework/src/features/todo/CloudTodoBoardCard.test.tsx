import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { TaskChangeRequestSnapshot } from '@/api/changeRequests'
import type { CloudLoopItem } from '@/api/deliveries'
import { WorkbenchContext } from '@/features/workbench/workbenchContexts'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import { projectRuntimeConversationTurns } from '@/features/workbench/runtimeConversationTurns'
import type { RuntimeConversationTurn } from '@/types/workbench'
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

function conversationTurn(
  id: string,
  userContent: string,
  assistantContent: string,
  createdAt: string
): RuntimeConversationTurn {
  return {
    id,
    status: 'done',
    items: [
      {
        id: `${id}:user`,
        type: 'user_message',
        message: {
          id: `${id}:user`,
          role: 'user',
          content: userContent,
          status: 'done',
          createdAt,
        },
      },
      {
        id: `${id}:assistant`,
        type: 'assistant_text',
        content: assistantContent,
        createdAt,
      },
    ],
  }
}

describe('CloudTodoBoardCard', () => {
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
            conversationLoaded: true,
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
            conversationLoaded: true,
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
            conversationLoaded: true,
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

  it('highlights unread cards and keeps full final content in the hover preview', async () => {
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
            conversationLoaded: true,
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

    const fullResponse = await screen.findByTestId('cloud-todo-card-popup-conversation-WEG-85')
    expect(fullResponse).toHaveTextContent('第一行：完成布局')
    expect(fullResponse).toHaveTextContent('第六行：等待确认')
    expect(fullResponse).toHaveClass('max-h-[min(68vh,42rem)]', 'overflow-hidden')
  })

  it('keeps repeated task text out of the card and narrows the full-card hover preview', async () => {
    const onSendMessage = vi.fn(async () => true)

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
        onSendMessage={onSendMessage}
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
    expect(popup).toHaveTextContent('Fix the board popup')
    expect(popup).toHaveTextContent('Verify the hover behavior')

    fireEvent.mouseEnter(screen.getByTestId('cloud-todo-card-progress-task-WEG-85-86'))
    expect(screen.queryByText('Fix the board popup')).not.toBeInTheDocument()
    expect(screen.getByText('Verify the hover behavior')).toBeInTheDocument()

    const input = screen.getByTestId('cloud-todo-card-popup-input-WEG-85-86')
    const composer = screen.getByTestId('project-chat-composer-form')
    expect(composer).toHaveAttribute('data-short-expanded', 'false')
    fireEvent.click(input)
    expect(composer).toHaveAttribute('data-short-expanded', 'true')

    await userEvent.type(input, '继续检查 hover 交互{enter}')
    expect(onSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 86, task_id: 'task-86' }),
      '继续检查 hover 交互'
    )
  })

  it('shows the latest user and assistant round first, then loads older transcript pages', async () => {
    const loadRuntimeTranscriptForPane = vi.fn(
      async (
        _address,
        options
      ): ReturnType<WorkbenchContextValue['loadRuntimeTranscriptForPane']> => ({
        messages: [],
        turns: options?.beforeCursor
          ? [
              conversationTurn(
                'turn-oldest',
                '最早一轮用户消息',
                '最早一轮 AI 回复',
                '2026-08-21T00:00:00Z'
              ),
            ]
          : [],
        hasMoreBefore: false,
        beforeCursor: null,
      })
    )
    const initialTurns = [
      conversationTurn('turn-older', '上一轮用户消息', '上一轮 AI 回复', '2026-08-21T00:01:00Z'),
      conversationTurn(
        'turn-latest',
        '最新一轮用户消息',
        '最新一轮 AI 回复',
        '2026-08-21T00:02:00Z'
      ),
    ]
    const workbench = {
      state: {
        devices: [],
        runtimeWork: null,
      },
      loadRuntimeTranscriptForPane,
      loadTurnFileChangesDiff: vi.fn(),
      revertTurnFileChanges: vi.fn(),
    } as unknown as WorkbenchContextValue

    render(
      <WorkbenchContext.Provider value={workbench}>
        <CloudTodoBoardCard
          item={item}
          taskBindings={[
            {
              id: 87,
              device_id: 'local',
              task_id: 'task-history',
              task_title: 'Inspect paginated history',
              running: false,
              finalResponsePreview: '最新一轮 AI 回复',
              conversationLoaded: true,
              conversationMessages: projectRuntimeConversationTurns(initialTurns),
              conversationHasMoreBefore: true,
              conversationBeforeCursor: 'older-page',
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
      </WorkbenchContext.Provider>
    )

    fireEvent.mouseEnter(screen.getByTestId('cloud-todo-card-WEG-85'))
    const popup = await screen.findByTestId('cloud-todo-card-progress-popup-WEG-85')
    const popupQueries = within(popup)

    expect(await popupQueries.findByText('最新一轮用户消息')).toBeInTheDocument()
    expect(popupQueries.getByText('最新一轮 AI 回复')).toBeInTheDocument()
    expect(popupQueries.queryByText('上一轮用户消息')).not.toBeInTheDocument()

    await userEvent.click(popupQueries.getByTestId('load-older-runtime-transcript-button'))
    expect(
      popupQueries.queryByTestId('cloud-todo-card-progress-popup-WEG-85-close')
    ).not.toBeInTheDocument()
    expect((await popupQueries.findAllByText('上一轮用户消息')).length).toBeGreaterThan(0)
    expect(popupQueries.getAllByText('上一轮 AI 回复').length).toBeGreaterThan(0)

    await userEvent.click(popupQueries.getByTestId('load-older-runtime-transcript-button'))
    expect((await popupQueries.findAllByText('最早一轮用户消息')).length).toBeGreaterThan(0)
    expect(popupQueries.getAllByText('最早一轮 AI 回复').length).toBeGreaterThan(0)
    expect(loadRuntimeTranscriptForPane).toHaveBeenCalledTimes(1)
    expect(loadRuntimeTranscriptForPane).toHaveBeenLastCalledWith(
      expect.objectContaining({ deviceId: 'local', taskId: 'task-history' }),
      { limit: 50, beforeCursor: 'older-page' }
    )
  })

  it('shows fallback conversation and the loading-older control before prefetch completes', async () => {
    const loadRuntimeTranscriptForPane = vi.fn()
    const workbench = {
      state: {
        devices: [],
        runtimeWork: null,
      },
      loadRuntimeTranscriptForPane,
      loadTurnFileChangesDiff: vi.fn(),
      revertTurnFileChanges: vi.fn(),
    } as unknown as WorkbenchContextValue

    render(
      <WorkbenchContext.Provider value={workbench}>
        <CloudTodoBoardCard
          item={{ ...item, description: '立即显示的用户消息' }}
          taskBindings={[
            {
              id: 88,
              device_id: 'local',
              task_id: 'task-prefetching',
              task_title: 'Prefetching conversation',
              running: false,
              finalResponsePreview: '立即显示的 AI 回复',
              conversationLoaded: false,
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
      </WorkbenchContext.Provider>
    )

    fireEvent.mouseEnter(screen.getByTestId('cloud-todo-card-WEG-85'))
    const popup = await screen.findByTestId('cloud-todo-card-progress-popup-WEG-85')
    expect(popup).toHaveTextContent('立即显示的用户消息')
    expect(popup).toHaveTextContent('立即显示的 AI 回复')
    expect(within(popup).getByTestId('load-older-runtime-transcript-button')).toBeDisabled()
    expect(loadRuntimeTranscriptForPane).not.toHaveBeenCalled()
  })
})
