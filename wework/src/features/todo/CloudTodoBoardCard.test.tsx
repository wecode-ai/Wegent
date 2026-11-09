import type { CloudLoopItem } from '@/api/deliveries'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import { clearRuntimeConversationCacheForTests } from '@/features/workbench/runtimeConversationCache'
import '@/i18n'
import { installDshUiTestContributions } from '@/test/setup.dom'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CloudTodoBoardCard, CloudTodoCardContent } from './CloudTodoBoardCard'

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
    initialScrollPosition,
    scrollOrigin,
  }: {
    initialAddress: {
      deviceId: string
      taskId: string
      runtimeHandle?: { modelSelection?: { modelName?: string } }
    }
    testId: string
    sendEphemeral: boolean
    collapseComposerWhenIdle: boolean
    runtimeContext?: { cloudProjectId?: string }
    initialScrollPosition?: 'restore' | 'latest'
    scrollOrigin?: 'top' | 'bottom'
  }) => (
    <section
      data-testid={testId}
      data-device-id={initialAddress.deviceId}
      data-task-id={initialAddress.taskId}
      data-send-ephemeral={String(sendEphemeral)}
      data-collapse-composer={String(collapseComposerWhenIdle)}
      data-cloud-project-id={runtimeContext?.cloudProjectId}
      data-model-name={initialAddress.runtimeHandle?.modelSelection?.modelName}
      data-initial-scroll-position={initialScrollPosition}
      data-scroll-origin={scrollOrigin}
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

describe('CloudTodoBoardCard', () => {
  it('projects the running stand-in identity next to the title without a status text row', () => {
    render(
      <CloudTodoCardContent
        item={{ ...item, created_by_user_id: 1, created_by_user_name: '创建人' }}
        goalBinding={{
          id: 1,
          device_id: 'device',
          task_id: 'task',
          task_title: 'Work',
          running: true,
          runtimeTask: {
            taskId: 'task',
            title: 'Work',
            workspacePath: '',
            runtime: 'codex',
            runtimeHandle: { origin: { initiatedBy: 'stand_in', roleName: '研发分身' } },
          },
        }}
        display={{ showAssignee: true, showDate: false, showTags: false, showPriority: false }}
      />
    )
    const actor = screen.getByTestId('issue-participation-WEG-85')
    expect(actor).toHaveTextContent('研发分身')
    expect(actor).toHaveAttribute('data-processing-kind', 'stand_in')
    expect(screen.getByTestId('cloud-todo-card-header-WEG-85')).toContainElement(actor)
    expect(screen.getByTestId('cloud-todo-card-header-actors-WEG-85')).toHaveClass('ml-auto')
    expect(actor.parentElement).not.toHaveTextContent(item.title)
    expect(screen.queryByText('AI 处理中')).not.toBeInTheDocument()
  })
  afterEach(async () => {
    // Finish Radix's deferred focus restoration before jsdom disposes this realm.
    vi.useFakeTimers()
    cleanup()
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
    })
    expect(vi.getTimerCount()).toBe(0)
    clearRuntimeConversationCacheForTests()
    vi.useRealTimers()
  })

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

  it('keeps cloud card details accessible when edit permission is missing', async () => {
    changeRequestMonitorMocks.useTaskChangeRequest.mockReturnValue(null)
    const onClick = vi.fn()

    render(
      <CloudTodoBoardCard
        item={{
          ...item,
          can_edit: undefined,
          can_view_detail: undefined,
          project_store: 'backend',
        }}
        onClick={onClick}
        onArchive={vi.fn()}
        display={{
          showAssignee: false,
          showPriority: false,
          showTags: false,
          showDate: false,
        }}
      />
    )

    expect(screen.queryByTestId('cloud-todo-card-more-WEG-85')).not.toBeInTheDocument()
    const detailButton = screen.getByTestId('cloud-todo-card-WEG-85')
    expect(detailButton).not.toBeDisabled()
    expect(detailButton).not.toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(detailButton)
    expect(onClick).toHaveBeenCalledOnce()
  })

  it.each([
    { status: 'pending', running: false, bound: false, visible: false },
    { status: 'in_progress', running: false, bound: false, visible: false },
    { status: 'in_review', running: false, bound: false, visible: false },
    { status: 'pending', running: false, bound: true, visible: false },
    { status: 'in_progress', running: false, bound: true, visible: true },
    { status: 'in_review', running: false, bound: true, visible: true },
    { status: 'completed', running: false, bound: true, visible: false },
    { status: 'cancelled', running: false, bound: true, visible: false },
    { status: 'pending', running: true, bound: true, visible: true },
    { status: 'completed', running: true, bound: true, visible: true },
  ])(
    'shows progress=$visible for $status with bound=$bound, running=$running',
    ({ status, running, bound, visible }) => {
      changeRequestMonitorMocks.useTaskChangeRequest.mockReturnValue(null)
      render(
        <CloudTodoBoardCard
          item={{ ...item, status }}
          taskBindings={
            bound
              ? [{ id: 85, device_id: 'local', task_id: 'task-85', task_title: 'Task', running }]
              : []
          }
          processingStatus={status === 'in_progress'}
          onClick={vi.fn()}
          onArchive={vi.fn()}
          display={{ showAssignee: true, showPriority: true, showTags: true, showDate: true }}
        />
      )
      expect(screen.getByTestId('cloud-todo-card-WEG-85').getAttribute('aria-haspopup')).toBe(
        visible ? 'dialog' : null
      )
    }
  )

  it('shows the current conversation goal and opens the progress panel', async () => {
    const onClick = vi.fn()
    const onPreviewPinnedChange = vi.fn()
    render(
      <CloudTodoBoardCard
        item={item}
        taskBindings={[
          {
            id: 85,
            device_id: 'local',
            task_id: 'task-85',
            task_title: 'Fix the board popup',
            running: true,
            runtimeGoalLoaded: true,
            runtimeGoal: {
              threadId: 'thread-85',
              objective: '让用户在看板悬浮态快速理解当前会话正在完成什么',
              status: 'active',
              tokenBudget: null,
              tokensUsed: 1200,
              timeUsedSeconds: 90,
              createdAt: 1,
              updatedAt: 2,
            },
          },
        ]}
        onClick={onClick}
        onArchive={vi.fn()}
        onPreviewPinnedChange={onPreviewPinnedChange}
        display={{
          showAssignee: false,
          showPriority: false,
          showTags: false,
          showDate: false,
        }}
      />
    )

    expect(screen.getByTestId('cloud-todo-card-goal-WEG-85-85')).toHaveAttribute(
      'title',
      expect.stringContaining('让用户在看板悬浮态快速理解当前会话正在完成什么')
    )
    expect(screen.getByTestId('cloud-todo-card-goal-WEG-85-85')).not.toHaveTextContent(
      '让用户在看板悬浮态快速理解当前会话正在完成什么'
    )

    fireEvent.click(screen.getByTestId('cloud-todo-card-WEG-85'))

    expect(await screen.findByTestId('cloud-todo-card-popup-goal-WEG-85-85')).toHaveTextContent(
      '让用户在看板悬浮态快速理解当前会话正在完成什么'
    )
    expect(onPreviewPinnedChange).toHaveBeenCalledWith(true)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('forwards the bound task model to the shared progress conversation', async () => {
    render(
      <CloudTodoBoardCard
        item={item}
        taskBindings={[
          {
            id: 85,
            device_id: 'local',
            task_id: 'task-85',
            task_title: 'Fix the board popup model',
            running: false,
            modelSelection: {
              modelName: 'gpt-5.6-sol',
              modelType: 'public',
              options: { reasoning: 'high' },
            },
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

    fireEvent.click(screen.getByTestId('cloud-todo-card-WEG-85'))

    expect(await screen.findByTestId('cloud-todo-card-popup-conversation-WEG-85')).toHaveAttribute(
      'data-model-name',
      'gpt-5.6-sol'
    )
  })
})
