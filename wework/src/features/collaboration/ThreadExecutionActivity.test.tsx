import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectChatMessage } from '@wegent/chat-core'
import { ThreadExecutionActivity } from './ThreadExecutionActivity'
import { activityFixture } from './threadExecutionActivity.test-support'
import '@/i18n'
import { ThreadActionsContext } from './threadActionsContext'

vi.mock('@/features/notifications/issueDispatch', () => ({ requestIssueDispatch: vi.fn() }))
const cards = vi.hoisted(() => ({ render: vi.fn() }))
vi.mock('@/features/todo/TaskActivityMessage', () => ({
  ChatMessage: (props: {
    message: ProjectChatMessage
    onStopExecution?(): void
    onOpenExecution?(): void
  }) => {
    cards.render(props)
    return (
      <div data-testid={`existing-execution-card-${props.message.messageId}`}>
        {props.message.content}
        {props.onOpenExecution && (
          <button
            data-testid={`existing-open-${props.message.messageId}`}
            onClick={props.onOpenExecution}
          >
            Open
          </button>
        )}
        {props.onStopExecution && (
          <button
            data-testid={`existing-stop-${props.message.messageId}`}
            onClick={props.onStopExecution}
          >
            Stop
          </button>
        )}
      </div>
    )
  },
}))
afterEach(() => vi.clearAllMocks())

function setup(crewId?: string) {
  const fixture = activityFixture(crewId)
  const props = {
    context: fixture.context,
    groups: fixture.groups,
    chat: fixture.chat,
    messages: [fixture.message],
    members: [],
    locale: 'zh-CN' as const,
    focused: null,
    onConfigure: vi.fn(),
    onChanged: fixture.onChanged,
    onReply: vi.fn(),
  }
  const children = ({
    renderMessage,
  }: {
    renderMessage(message: ProjectChatMessage): React.ReactNode
  }) => <>{props.messages.map(renderMessage)}</>
  const view = render(<ThreadExecutionActivity {...props}>{children}</ThreadExecutionActivity>)
  return { ...fixture, props, children, ...view }
}

describe('Thread execution UI preserves existing work controls', () => {
  it('renders the shared execution card once, with manager role and focus metadata', () => {
    const view = setup()
    view.message.metadata.dispatch_role = 'manager'
    view.rerender(
      <ThreadExecutionActivity {...view.props} focused="run">
        {view.children}
      </ThreadExecutionActivity>
    )
    expect(screen.getAllByTestId('existing-execution-card-run')).toHaveLength(1)
    expect(screen.getByTestId('group-message-run')).toHaveAttribute('data-message-side', 'other')
    expect(screen.getByTestId('group-message-run')).toHaveAttribute('data-focused', 'true')
    expect(cards.render).toHaveBeenLastCalledWith(
      expect.objectContaining({
        agentRole: 'manager',
        showInlineExecutionStatus: true,
        allowBackendExecutionFallback: false,
        mine: false,
        flash: true,
      })
    )
  })

  it('keeps lifecycle controls next to their current execution instead of above the conversation', () => {
    setup()
    const currentMessage = screen.getByTestId('group-message-run')
    expect(currentMessage).toContainElement(screen.getByTestId('thread-execution-actions'))
    expect(currentMessage).toContainElement(screen.getByTestId('cloud-task-activity-accept-T-1'))
  })

  it('does not query execution-resource catalogs for a read-only crew conversation', async () => {
    const fixture = activityFixture('crew')
    fixture.participation.joined = false
    render(
      <ThreadExecutionActivity
        context={fixture.context}
        groups={fixture.groups}
        chat={fixture.chat}
        messages={[fixture.message]}
        members={[]}
        locale="zh-CN"
        focused={null}
        onConfigure={vi.fn()}
        onChanged={vi.fn()}
      >
        {({ renderMessage }) => renderMessage(fixture.message)}
      </ThreadExecutionActivity>
    )
    await act(async () => {})
    expect(fixture.api.projects.listCollaborationGroups).not.toHaveBeenCalled()
    expect(screen.getByTestId('existing-execution-card-run')).toBeVisible()
    expect(screen.queryByTestId('thread-execution-actions')).not.toBeInTheDocument()
  })

  it('does not expose a historical manager after crew A is reassigned to crew B', async () => {
    const view = setup('A')
    await screen.findByTestId('cloud-task-activity-rerun-T-1')
    const next = { ...view.context, item: { ...view.item, assignee_group_id: 'B' } }
    view.crew.id = 'B'
    view.rerender(
      <ThreadExecutionActivity {...view.props} context={next}>
        {view.children}
      </ThreadExecutionActivity>
    )
    expect(screen.queryByTestId('cloud-task-activity-rerun-T-1')).not.toBeInTheDocument()
    await waitFor(() => expect(view.api.projects.listCollaborationGroups).toHaveBeenCalledTimes(2))
    expect(screen.queryByTestId('cloud-task-activity-rerun-T-1')).not.toBeInTheDocument()
    expect(view.chat.send).not.toHaveBeenCalled()
  })

  it('delegates reading an execution to the existing host without requiring execution permission', async () => {
    const view = setup()
    view.participation.joined = false
    view.item.permissions!.execute = false
    view.message.runtimeAddress = { deviceId: 'device', taskId: 'runtime' }
    const openExecution = vi.fn().mockResolvedValue(undefined)
    view.rerender(
      <ThreadActionsContext
        value={{ openExecution, renderThreadActions: () => null, onThreadActionContext: vi.fn() }}
      >
        <ThreadExecutionActivity {...view.props}>{view.children}</ThreadExecutionActivity>
      </ThreadActionsContext>
    )
    fireEvent.click(screen.getByTestId('existing-open-run'))
    await waitFor(() =>
      expect(openExecution).toHaveBeenCalledExactlyOnceWith(view.context, view.message)
    )
    expect(screen.queryByTestId('thread-execution-actions')).not.toBeInTheDocument()
    expect(view.api.issues.update).not.toHaveBeenCalled()
  })

  it('opens existing assignment settings and replies through the group composer', () => {
    const { props, message } = setup()
    fireEvent.click(screen.getByTestId('thread-execution-assignee'))
    fireEvent.click(screen.getByTestId('cloud-task-activity-reply-toggle-run'))
    expect(props.onConfigure).toHaveBeenCalledOnce()
    expect(props.onReply).toHaveBeenCalledWith(message)
  })

  it('accepts the current review and reports the mutation', async () => {
    const { api, onChanged } = setup()
    fireEvent.click(screen.getByTestId('cloud-task-activity-accept-T-1'))
    await waitFor(() =>
      expect(api.issues.update).toHaveBeenCalledWith('T-1', { version: 12, status: 'completed' })
    )
    expect(onChanged).toHaveBeenCalledOnce()
  })

  it('keeps read access without execution controls for observers or inactive pages', () => {
    const view = setup()
    view.participation.joined = false
    view.rerender(
      <ThreadExecutionActivity {...view.props}>{view.children}</ThreadExecutionActivity>
    )
    expect(screen.queryByTestId('thread-execution-actions')).not.toBeInTheDocument()
    expect(screen.getByTestId('existing-execution-card-run')).toBeVisible()
    view.participation.joined = true
    view.rerender(
      <ThreadExecutionActivity {...view.props} active={false}>
        {view.children}
      </ThreadExecutionActivity>
    )
    expect(screen.queryByTestId('thread-execution-actions')).not.toBeInTheDocument()
  })

  it('keeps discussion replies available after completion without execution controls', () => {
    const view = setup()
    view.item.status = 'completed'
    view.item.permissions!.execute = false
    view.rerender(
      <ThreadExecutionActivity {...view.props}>{view.children}</ThreadExecutionActivity>
    )
    expect(screen.queryByTestId('thread-execution-actions')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '回复' }))
    expect(view.props.onReply).toHaveBeenCalledWith(view.message)
  })

  it('keeps approval limited to the current server authority', () => {
    const view = setup()
    view.item.execution_state = 'waiting_approval'
    view.item.can_approve = false
    view.rerender(
      <ThreadExecutionActivity {...view.props}>{view.children}</ThreadExecutionActivity>
    )
    expect(screen.queryByTestId('cloud-task-activity-approve-T-1')).not.toBeInTheDocument()
    view.item.can_approve = true
    view.rerender(
      <ThreadExecutionActivity {...view.props}>{view.children}</ThreadExecutionActivity>
    )
    expect(screen.getByTestId('cloud-task-activity-approve-T-1')).toBeVisible()
    expect(screen.getByTestId('cloud-task-activity-reject-T-1')).toBeVisible()
  })

  it('uses the real execution stop command for an active manager message', async () => {
    const view = setup()
    view.message.status = 'streaming'
    view.message.metadata.dispatch_role = 'manager'
    view.rerender(
      <ThreadExecutionActivity {...view.props}>{view.children}</ThreadExecutionActivity>
    )
    fireEvent.click(screen.getByTestId('existing-stop-run'))
    await waitFor(() => expect(view.api.executions!.stop).toHaveBeenCalledWith('group', 15))
  })

  it('does not treat a personal public stand-in reply as a shared execution', () => {
    const view = setup()
    view.message.metadata = { execution_dispatch: 'comment_only', stand_in: { user_id: 7 } }
    view.rerender(
      <ThreadExecutionActivity {...view.props}>{view.children}</ThreadExecutionActivity>
    )
    expect(screen.queryByTestId('existing-execution-card-run')).not.toBeInTheDocument()
  })

  it('shows a truthful error when current authority is revoked', async () => {
    const view = setup()
    vi.mocked(view.api.issues.get).mockResolvedValue({
      ...view.item,
      permissions: { ...view.item.permissions!, execute: false },
    })
    fireEvent.click(screen.getByTestId('cloud-task-activity-accept-T-1'))
    await screen.findByRole('alert')
    expect(view.api.issues.update).not.toHaveBeenCalled()
    expect(view.onChanged).not.toHaveBeenCalled()
  })

  it('does not continue a command after the account changes while permissions load', async () => {
    const view = setup()
    let complete!: (value: typeof view.item) => void
    vi.mocked(view.api.issues.get).mockReturnValue(
      new Promise(resolve => {
        complete = resolve
      })
    )
    fireEvent.click(screen.getByTestId('cloud-task-activity-accept-T-1'))
    view.rerender(
      <ThreadExecutionActivity
        {...view.props}
        context={{ ...view.context, accountScope: 'another-account' }}
      >
        {view.children}
      </ThreadExecutionActivity>
    )
    await act(async () => {
      complete(view.item)
    })
    expect(view.api.issues.update).not.toHaveBeenCalled()
    expect(view.onChanged).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
