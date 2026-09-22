import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { TaskChangeRequestSnapshot } from '@/api/changeRequests'
import type { CloudLoopItem } from '@/api/deliveries'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import {
  applyRuntimeConversationAction,
  clearRuntimeConversationCacheForTests,
} from '@/features/workbench/runtimeConversationCache'
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

function seedAssistantResponse(content: string, taskId = 'task-85') {
  const address = { deviceId: 'local', taskId }
  const turnId = `turn-${taskId}`
  applyRuntimeConversationAction(address, {
    type: 'assistant_started',
    taskId,
    subtaskId: turnId,
  })
  applyRuntimeConversationAction(address, {
    type: 'assistant_chunk',
    subtaskId: turnId,
    itemId: `assistant-${taskId}`,
    content,
  })
  applyRuntimeConversationAction(address, {
    type: 'assistant_done',
    subtaskId: turnId,
  })
}

describe('CloudTodoBoardCard', () => {
  afterEach(() => {
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

  it('keeps local card actions editable through the explicit local adapter marker', () => {
    changeRequestMonitorMocks.useTaskChangeRequest.mockReturnValue(null)

    render(
      <CloudTodoBoardCard
        item={{ ...item, can_edit: undefined, project_store: 'local' }}
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

    expect(screen.getByTestId('cloud-todo-card-more-WEG-85')).toBeInTheDocument()
  })

  it('closes the card menu when clicking outside of it', async () => {
    changeRequestMonitorMocks.useTaskChangeRequest.mockReturnValue(null)

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

    await userEvent.click(screen.getByTestId('cloud-todo-card-more-WEG-85'))
    expect(screen.getByTestId('cloud-todo-card-menu-WEG-85')).toBeInTheDocument()

    fireEvent.mouseDown(document.body)
    expect(screen.queryByTestId('cloud-todo-card-menu-WEG-85')).not.toBeInTheDocument()
  })

  it('keeps the card menu open when clicking inside it', async () => {
    changeRequestMonitorMocks.useTaskChangeRequest.mockReturnValue(null)

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

    await userEvent.click(screen.getByTestId('cloud-todo-card-more-WEG-85'))
    const menu = screen.getByTestId('cloud-todo-card-menu-WEG-85')
    fireEvent.mouseDown(menu)
    expect(screen.getByTestId('cloud-todo-card-menu-WEG-85')).toBeInTheDocument()
  })

  it('toggles the card menu from its trigger button', async () => {
    changeRequestMonitorMocks.useTaskChangeRequest.mockReturnValue(null)

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

    const trigger = screen.getByTestId('cloud-todo-card-more-WEG-85')
    await userEvent.click(trigger)
    expect(screen.getByTestId('cloud-todo-card-menu-WEG-85')).toBeInTheDocument()
    await userEvent.click(trigger)
    expect(screen.queryByTestId('cloud-todo-card-menu-WEG-85')).not.toBeInTheDocument()
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
    seedAssistantResponse('已完成布局修复')

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

    const summary = screen.getByTestId('cloud-todo-card-task-summary-WEG-85-85')
    const changeRequest = screen.getByTestId('cloud-todo-card-change-request-WEG-85-85')
    const response = screen.getByTestId('cloud-todo-card-final-response-WEG-85')

    expect(summary).toHaveClass('relative')
    expect(changeRequest.parentElement?.parentElement).toHaveClass('absolute', 'right-0', 'top-0')
    expect(response).toHaveClass('line-clamp-2', 'pr-7')
    expect(response).not.toHaveClass('min-h-[60px]', 'border-l', 'pl-2')
    expect(summary).not.toHaveTextContent('Fix the board popup')
    expect(screen.getByTestId('cloud-todo-card-tasks-WEG-85')).not.toHaveClass('border-t')
  })

  it('keeps normal priority out of the compact card', () => {
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

    expect(screen.queryByText('普通')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-card-tasks-WEG-85')).not.toHaveClass('border-t')
  })

  it('renders the shared issue reference, tags, creation date and resolved assignee', () => {
    changeRequestMonitorMocks.useTaskChangeRequest.mockReturnValue(null)

    render(
      <CloudTodoBoardCard
        item={{
          ...item,
          created_at: '2026-09-12T03:00:00Z',
          due_at: '2026-09-23T03:00:00Z',
          tags: ['frontend', 'shared', 'architecture'],
          priority: 'high',
          assignee_agent_id: 'agent-1',
          assignee_agent_name: null,
        }}
        onClick={vi.fn()}
        onArchive={vi.fn()}
        agentNames={{ 'agent-1': 'Codex' }}
        display={{
          showAssignee: true,
          showPriority: true,
          showTags: true,
          showDate: true,
        }}
      />
    )

    const card = screen.getByTestId('cloud-todo-card-drop-WEG-85')
    expect(screen.getByTestId('cloud-todo-card-reference-WEG-85')).toHaveTextContent('#85')
    expect(screen.getByTestId('cloud-todo-card-reference-WEG-85')).toHaveAttribute(
      'title',
      'WEG-85'
    )
    expect(card).toHaveTextContent('高')
    expect(card.querySelector('time')).toHaveAttribute('dateTime', '2026-09-12')
    expect(card.querySelector('time')).toHaveAttribute('title', '创建时间: 2026-09-12')
    expect(card).toHaveTextContent('frontend')
    expect(screen.getByTitle('frontend, shared, architecture')).toHaveTextContent('frontend')
    expect(card).toHaveTextContent('+2')
    expect(screen.getByTestId('cloud-todo-card-assignee-WEG-85')).toHaveTextContent('Codex')
  })

  it('keeps creation time stable after updates and respects the date display setting', () => {
    changeRequestMonitorMocks.useTaskChangeRequest.mockReturnValue(null)
    const props = {
      item: {
        ...item,
        created_at: '2026-09-14T08:00:00Z',
        due_at: '2026-09-23',
        updated_at: '2026-09-21T08:00:00Z',
      },
      onClick: vi.fn(),
      onArchive: vi.fn(),
      processingStatus: false,
      display: { showAssignee: false, showPriority: false, showTags: false, showDate: true },
    }
    const { rerender } = render(<CloudTodoBoardCard {...props} />)
    const date = screen.getByLabelText('创建时间: 2026-09-14')
    expect(date).toHaveAttribute('datetime', '2026-09-14')
    expect(date).toHaveTextContent('09-14')
    expect(date).not.toHaveTextContent('今天截止')
    expect(date).not.toHaveClass('text-amber-600')

    rerender(
      <CloudTodoBoardCard {...props} item={{ ...props.item, updated_at: '2026-09-22T08:00:00Z' }} />
    )
    expect(screen.getByLabelText('创建时间: 2026-09-14')).toHaveAttribute('datetime', '2026-09-14')

    rerender(<CloudTodoBoardCard {...props} display={{ ...props.display, showDate: false }} />)
    expect(screen.queryByLabelText('创建时间: 2026-09-14')).not.toBeInTheDocument()
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

  it('keeps a stopped task accessible while its change request is open', () => {
    changeRequestMonitorMocks.useTaskChangeRequest.mockReturnValue(snapshot)
    render(
      <CloudTodoBoardCard
        item={{ ...item, status: 'completed' }}
        taskBindings={[
          {
            id: 85,
            device_id: 'local',
            task_id: 'task-85',
            task_title: 'Task',
            running: false,
            changeRequestTarget: snapshot.target,
          },
        ]}
        processingStatus={false}
        onClick={vi.fn()}
        onArchive={vi.fn()}
        display={{ showAssignee: false, showPriority: false, showTags: false, showDate: false }}
      />
    )
    expect(screen.getByTestId('cloud-todo-card-WEG-85')).toHaveAttribute('aria-haspopup', 'dialog')
  })

  it('hides progress and its summaries when the Issue cannot be viewed', () => {
    changeRequestMonitorMocks.useTaskChangeRequest.mockReturnValue(null)
    render(
      <CloudTodoBoardCard
        item={{ ...item, can_view_detail: false }}
        taskBindings={[
          { id: 85, device_id: 'local', task_id: 'task-85', task_title: 'Task', running: true },
        ]}
        processingStatus={false}
        onClick={vi.fn()}
        onArchive={vi.fn()}
        display={{ showAssignee: false, showPriority: false, showTags: false, showDate: false }}
      />
    )
    expect(screen.getByTestId('cloud-todo-card-WEG-85')).not.toHaveAttribute('aria-haspopup')
    expect(screen.queryByTestId('cloud-todo-card-tasks-WEG-85')).not.toBeInTheDocument()
  })

  it('places the response between the title and metadata and separates preview from navigation', () => {
    changeRequestMonitorMocks.useTaskChangeRequest.mockReturnValue(null)
    seedAssistantResponse('Latest response')
    const onClick = vi.fn()
    render(
      <CloudTodoBoardCard
        item={{
          ...item,
          due_at: '2026-09-23',
          assignee_agent_name: 'Codex',
          assignee_agent_id: 'agent-1',
        }}
        taskBindings={[
          { id: 85, device_id: 'local', task_id: 'task-85', task_title: 'Task', running: false },
        ]}
        processingStatus={false}
        onClick={onClick}
        onArchive={vi.fn()}
        display={{ showAssignee: true, showPriority: true, showTags: true, showDate: true }}
      />
    )
    const title = screen.getByTestId('cloud-todo-card-WEG-85')
    const response = screen.getByTestId('cloud-todo-card-final-response-WEG-85')
    const metadata = screen.getByTestId('cloud-todo-card-metadata-WEG-85')
    expect(title.compareDocumentPosition(response) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(
      response.compareDocumentPosition(metadata) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    fireEvent.click(metadata)
    expect(onClick).not.toHaveBeenCalled()
    expect(screen.getByTestId('cloud-todo-card-progress-popup-WEG-85')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('cloud-todo-card-open-task-WEG-85'))
    expect(onClick).toHaveBeenCalledOnce()
    expect(screen.queryByTestId('cloud-todo-card-progress-popup-WEG-85')).not.toBeInTheDocument()
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

    expect(screen.queryByTestId(/cloud-todo-card-goal-/)).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-card-open-task-WEG-85')).not.toBeInTheDocument()
    fireEvent.mouseEnter(screen.getByTestId('cloud-todo-card-WEG-85'))

    await new Promise(resolve => window.setTimeout(resolve, 500))
    expect(screen.queryByTestId('cloud-todo-card-progress-popup-WEG-85')).not.toBeInTheDocument()
  })

  it('uses a distinct card color until the item is read', () => {
    const onClick = vi.fn()
    const onArchive = vi.fn()
    const display = {
      showAssignee: false,
      showPriority: false,
      showTags: false,
      showDate: false,
    }
    const { rerender } = render(
      <CloudTodoBoardCard
        item={{ ...item, is_unread: true }}
        processingStatus={false}
        onClick={onClick}
        onArchive={onArchive}
        display={display}
      />
    )

    const card = screen.getByTestId('cloud-todo-card-drop-WEG-85')
    expect(card).toHaveClass(
      'border-focus/30',
      'bg-focus/10',
      'hover:border-focus/40',
      'hover:bg-focus/[0.14]'
    )
    expect(card).not.toHaveClass('border-border', 'bg-background')

    rerender(
      <CloudTodoBoardCard
        item={{ ...item, is_unread: false }}
        processingStatus={false}
        onClick={onClick}
        onArchive={onArchive}
        display={display}
      />
    )

    expect(card).toHaveClass('border-border', 'bg-background', 'hover:border-text-primary/15')
    expect(card).not.toHaveClass('border-focus/30', 'bg-focus/10')
  })

  it('keeps the card geometry stable while hovered', () => {
    changeRequestMonitorMocks.useTaskChangeRequest.mockReturnValue(null)

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

    const card = screen.getByTestId('cloud-todo-card-drop-WEG-85')
    expect(card).toHaveClass('transition-colors')
    expect(card).not.toHaveClass('hover:-translate-y-px')
  })

  it('mounts the shared task conversation in the explicitly opened preview', async () => {
    seedAssistantResponse(
      '第一行：完成布局\n第二行：保留工具层级\n第三行：展示完整回复\n第四行：展示验证结果\n第五行：展示提交状态\n第六行：等待确认'
    )
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

    expect(screen.getByTestId('cloud-todo-card-final-response-WEG-85')).toHaveTextContent(
      '第六行：等待确认'
    )

    fireEvent.click(screen.getByTestId('cloud-todo-card-WEG-85'))

    const conversation = await screen.findByTestId('cloud-todo-card-popup-conversation-WEG-85')
    expect(conversation).toHaveAttribute('data-device-id', 'local')
    expect(conversation).toHaveAttribute('data-task-id', 'task-85')
    expect(conversation).toHaveAttribute('data-send-ephemeral', 'false')
    expect(conversation).toHaveAttribute('data-collapse-composer', 'true')
    expect(conversation).toHaveAttribute('data-cloud-project-id', String(item.cloud_project_id))
    expect(conversation).toHaveAttribute('data-initial-scroll-position', 'latest')
  })

  it('does not show an older response while a new task turn is starting', () => {
    seedAssistantResponse('older completed response')
    applyRuntimeConversationAction(
      { deviceId: 'local', taskId: 'task-85' },
      {
        type: 'assistant_started',
        taskId: 'task-85',
        subtaskId: 'turn-new',
      }
    )

    render(
      <CloudTodoBoardCard
        item={{ ...item, status: 'in_progress' }}
        taskBindings={[
          {
            id: 85,
            device_id: 'local',
            task_id: 'task-85',
            task_title: 'Fix the board popup',
            running: false,
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

    expect(screen.queryByText('older completed response')).not.toBeInTheDocument()
  })

  it('marks an unread task as read after its conversation preview stays open for 3 seconds', async () => {
    vi.useFakeTimers()
    const onMarkRead = vi.fn()
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
          },
        ]}
        onClick={vi.fn()}
        onArchive={vi.fn()}
        onMarkRead={onMarkRead}
        display={{
          showAssignee: false,
          showPriority: false,
          showTags: false,
          showDate: false,
        }}
      />
    )

    fireEvent.click(screen.getByTestId('cloud-todo-card-WEG-85'))
    expect(screen.getByTestId('cloud-todo-card-progress-popup-WEG-85')).toBeInTheDocument()

    await act(async () => vi.advanceTimersByTime(2999))
    expect(onMarkRead).not.toHaveBeenCalled()

    await act(async () => vi.advanceTimersByTime(1))
    expect(onMarkRead).toHaveBeenCalledOnce()
    expect(onMarkRead).toHaveBeenCalledWith(expect.objectContaining({ id: 'WEG-85' }))
  })

  it('keeps an unread task unread when its conversation preview closes before 3 seconds', async () => {
    vi.useFakeTimers()
    const onMarkRead = vi.fn()
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
          },
        ]}
        onClick={vi.fn()}
        onArchive={vi.fn()}
        onMarkRead={onMarkRead}
        display={{
          showAssignee: false,
          showPriority: false,
          showTags: false,
          showDate: false,
        }}
      />
    )

    fireEvent.click(screen.getByTestId('cloud-todo-card-WEG-85'))
    await act(async () => vi.advanceTimersByTime(2000))

    fireEvent.click(screen.getByTestId('cloud-todo-card-progress-popup-WEG-85-close'))
    expect(screen.queryByTestId('cloud-todo-card-progress-popup-WEG-85')).not.toBeInTheDocument()

    await act(async () => vi.advanceTimersByTime(1000))
    expect(onMarkRead).not.toHaveBeenCalled()
  })

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

  it('opens task progress without opening the Issue card', () => {
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

    fireEvent.click(screen.getByTestId('cloud-todo-card-WEG-85'))

    expect(onClick).not.toHaveBeenCalled()
    expect(onPreviewPinnedChange).toHaveBeenNthCalledWith(1, true)
  })

  it('keeps repeated task text out of the card and switches the shared progress conversation', async () => {
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
          },
          {
            id: 86,
            device_id: 'local',
            task_id: 'task-86',
            task_title: 'Verify the hover behavior',
            running: true,
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

    fireEvent.click(screen.getByTestId('cloud-todo-card-WEG-85'))
    const popup = await screen.findByTestId('cloud-todo-card-progress-popup-WEG-85')
    expect(popup).toHaveClass('w-[480px]', 'overflow-x-hidden')
    expect(popup).toHaveAttribute('role', 'dialog')
    expect(screen.getByTestId('cloud-todo-card-progress-title-WEG-85')).toHaveTextContent(
      'Keep the pull request popup visible'
    )
    expect(popup).not.toHaveTextContent('当前任务进展')
    expect(popup).toHaveTextContent('Fix the board popup')
    expect(popup).toHaveTextContent('Verify the hover behavior')

    fireEvent.mouseEnter(screen.getByTestId('cloud-todo-card-progress-select-WEG-85-86'))
    expect(screen.getByTestId('cloud-todo-card-popup-conversation-WEG-85')).toHaveAttribute(
      'data-task-id',
      'task-85'
    )
    fireEvent.click(screen.getByTestId('cloud-todo-card-progress-select-WEG-85-86'))
    expect(screen.getByTestId('cloud-todo-card-popup-conversation-WEG-85')).toHaveAttribute(
      'data-task-id',
      'task-86'
    )
  })
})
