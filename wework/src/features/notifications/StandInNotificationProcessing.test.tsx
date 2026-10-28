import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { StandInNotificationProcessing } from './StandInNotificationProcessing'
import { assignment, runtimeItem } from './standInNotifications.fixtures'
import { mergeStandInNotifications } from './standInNotifications'
import { useStandInAssignmentNotifications } from './useStandInAssignmentNotifications'
import type { TaskSource } from './NotificationTaskSourceContext'
import * as runtimeEnvironment from '@/lib/runtime-environment'

const { send, transcript, run } = vi.hoisted(() => ({
  send: vi.fn(),
  transcript: vi.fn(),
  run: vi.fn(),
}))
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { actor?: string }) =>
      values?.actor ? key + ':' + values.actor : key,
    i18n: { language: 'en' },
  }),
}))
const services = {
  runtimeWorkApi: { sendRuntimeMessage: send, getRuntimeTranscript: transcript },
  standInApi: { run },
  getLocalRuntimeSidebarIdentity: async () => ({ deviceId: 'device' }),
} as unknown as WorkbenchServices
const onChanged = vi.fn().mockResolvedValue(undefined)
const rowProps = {
  testId: 'notification-row',
  title: 'Review',
  body: '',
  timestamp: Date.parse('2026-10-21T12:05:00Z'),
  unread: false,
  unreadLabel: 'Unread',
  busy: false,
  onClick: vi.fn(),
}
function notification(status: 'done' | 'failed' = 'done') {
  return mergeStandInNotifications(
    [assignment],
    [
      {
        ...runtimeItem,
        task: { ...runtimeItem.task, status, running: false, completedAt: '2026-10-21T12:05:00Z' },
      },
    ]
  )[0]
}
function view(status: 'done' | 'failed' = 'done') {
  return (
    <StandInNotificationProcessing
      notification={notification(status)}
      rowProps={rowProps}
      services={services}
      userId={1}
      onChanged={onChanged}
    />
  )
}
beforeEach(() => {
  vi.clearAllMocks()
  transcript.mockResolvedValue({
    workspacePath: '/project',
    runtime: 'codex',
    running: false,
    messages: [],
    turns: [],
  })
  send.mockResolvedValue({ accepted: true, taskId: 'task' })
  run.mockResolvedValue(runtimeItem.address)
})
describe('notification inline handling', () => {
  it('lets the Executor resolve the connected identity for an unhandled assignment', async () => {
    render(
      <StandInNotificationProcessing
        notification={assignment}
        rowProps={rowProps}
        services={services}
        userId={1}
        onChanged={onChanged}
      />
    )
    fireEvent.click(screen.getByTestId('notification-stand-in-start-assignment'))
    await waitFor(() =>
      expect(run).toHaveBeenCalledExactlyOnceWith('12', 'ISSUE-1', 1, 'cloud', 'device', undefined)
    )
  })

  it('keeps manual delegation available when automatic handling fails before task creation', async () => {
    const windowLabel = vi
      .spyOn(runtimeEnvironment, 'getDesktopWindowLabel')
      .mockReturnValue('main')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const notifyAssignment = vi.fn().mockRejectedValue(new Error('cloud_unavailable'))
    const automaticServices = {
      ...services,
      standInApi: { ...services.standInApi!, notifyAssignment },
    }
    const pending = {
      ...assignment,
      payload: { ...assignment.payload, assignmentId: 'active-assignment' },
    }
    function PendingAssignment() {
      useStandInAssignmentNotifications(
        { items: [pending], unread_count: 1, next_offset: null },
        { services: automaticServices } as TaskSource,
        'account',
        1
      )
      return (
        <StandInNotificationProcessing
          notification={pending}
          rowProps={rowProps}
          services={automaticServices}
          userId={1}
          onChanged={onChanged}
        />
      )
    }
    try {
      render(<PendingAssignment />)
      await waitFor(() => expect(log).toHaveBeenCalled())
      expect(run).not.toHaveBeenCalled()
      const delegate = screen.getByTestId('notification-stand-in-start-assignment')
      expect(delegate).toBeEnabled()
      fireEvent.click(delegate)
      await waitFor(() =>
        expect(run).toHaveBeenCalledExactlyOnceWith(
          '12',
          'ISSUE-1',
          1,
          'cloud',
          'device',
          undefined
        )
      )
      expect(notifyAssignment).toHaveBeenCalledOnce()
      expect(screen.getByTestId('notification-stand-in-status-assignment')).toHaveTextContent(
        'notifications.stand_in_running'
      )
    } finally {
      windowLabel.mockRestore()
      log.mockRestore()
    }
  })

  it('keeps the completed result under the original title with its handling badge', async () => {
    transcript.mockResolvedValue({
      workspacePath: '/project',
      runtime: 'codex',
      running: false,
      messages: [
        { id: 'prompt', role: 'user', content: 'Review' },
        { id: 'result', role: 'assistant', content: 'Review completed' },
      ],
      turns: [],
    })
    render(view())
    expect(screen.getByTestId('notification-row')).toHaveTextContent('Review')
    expect(screen.getByText('notifications.stand_in_handling')).toBeVisible()
    expect(screen.getByTestId('notification-stand-in-status-assignment')).toHaveTextContent(
      'notifications.stand_in_completed'
    )
    expect(await screen.findByText('Review completed')).toBeVisible()
    expect(screen.getByTestId('notification-stand-in-reply-open-assignment')).toBeEnabled()
  })

  it.each([undefined, 'Alice'])('preserves the assignment layout with assigner %s', actorName => {
    const original = { ...assignment, payload: { ...assignment.payload, actorName } }
    const renderRow = (handled: boolean) => (
      <StandInNotificationProcessing
        notification={handled ? mergeStandInNotifications([original], [runtimeItem])[0] : original}
        rowProps={rowProps}
        services={services}
        userId={1}
        onChanged={onChanged}
      />
    )
    const rendered = render(renderRow(false))
    const titleClass = screen.getByText(actorName || 'Review').className
    const avatar = screen.getByTestId('notification-row-container').firstElementChild?.innerHTML
    rendered.rerender(renderRow(true))
    expect(screen.getByText(actorName || 'Review')).toHaveClass(titleClass)
    expect(screen.getByTestId('notification-row-container').firstElementChild?.innerHTML).toBe(
      avatar
    )
    expect(screen.getByText('notifications.stand_in_handling')).toBeVisible()
    expect(screen.queryByText('notifications.stand_in_identity')).not.toBeInTheDocument()
    if (actorName) expect(screen.getByTestId('notification-row-body')).toHaveTextContent('Review')
    else expect(screen.queryByTestId('notification-row-body')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('notification-row'))
    expect(rowProps.onClick).toHaveBeenCalledOnce()
  })

  it('omits missing assigner information and shows the task directly', () => {
    render(
      <StandInNotificationProcessing
        notification={assignment}
        rowProps={rowProps}
        services={services}
        userId={1}
        onChanged={onChanged}
      />
    )
    expect(screen.getByTestId('notification-row')).toHaveTextContent('Review')
    expect(screen.queryByTestId('notification-row-body')).not.toBeInTheDocument()
    expect(screen.queryByText('notifications.stand_in_assignment')).not.toBeInTheDocument()
    expect(screen.queryByText('notifications.new_assignment')).not.toBeInTheDocument()
    expect(screen.getByTestId('notification-stand-in-start-assignment')).toBeEnabled()
  })
  it('identifies the actual assigner directly above the task without a new-task heading', () => {
    render(
      <StandInNotificationProcessing
        notification={{ ...assignment, payload: { ...assignment.payload, actorName: 'Alice' } }}
        rowProps={rowProps}
        services={services}
        userId={1}
        onChanged={onChanged}
      />
    )
    expect(screen.getByTestId('notification-row')).toHaveTextContent('Alice')
    expect(screen.getByTestId('notification-row-body')).toHaveTextContent('Review')
    expect(screen.queryByText('notifications.new_assignment')).not.toBeInTheDocument()
    expect(screen.getByTestId('notification-stand-in-start-assignment')).toBeEnabled()
  })
  it('does not reload an unchanged execution when the notification source republishes', async () => {
    const rendered = render(view())
    await waitFor(() => expect(transcript).toHaveBeenCalledOnce())
    rendered.rerender(view())
    expect(transcript).toHaveBeenCalledOnce()
  })
  it('sends follow-up to the existing execution without navigation or task creation', async () => {
    render(view())
    expect(screen.queryByTestId('notification-stand-in-reply-assignment')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('notification-stand-in-reply-open-assignment'))
    expect(screen.getByTestId('notification-stand-in-reply-assignment')).toHaveFocus()
    fireEvent.change(screen.getByTestId('notification-stand-in-reply-assignment'), {
      target: { value: 'Also check ordering' },
    })
    fireEvent.click(screen.getByTestId('notification-stand-in-send-assignment'))
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce())
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ address: runtimeItem.address, message: 'Also check ordering' })
    )
    expect(run).not.toHaveBeenCalled()
    expect(screen.getByTestId('notification-stand-in-status-assignment')).toHaveTextContent(
      'notifications.stand_in_running'
    )
  })
  it('localizes the assignment rejection returned by manual delegation', async () => {
    run.mockRejectedValueOnce(
      Object.assign(new Error('This assignment has already been handled or is no longer active'), {
        code: 'assignment_already_handled',
      })
    )
    render(
      <StandInNotificationProcessing
        notification={assignment}
        rowProps={rowProps}
        services={services}
        userId={1}
        onChanged={onChanged}
      />
    )
    fireEvent.click(screen.getByTestId('notification-stand-in-start-assignment'))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '本次分配已处理或已失效，请刷新任务并查看最新分配。'
    )
  })

  it('retains the draft and shows the localized error on rejected send', async () => {
    send.mockResolvedValue({ accepted: false, error: 'Device offline' })
    render(view())
    fireEvent.click(screen.getByTestId('notification-stand-in-reply-open-assignment'))
    const input = screen.getByTestId('notification-stand-in-reply-assignment')
    fireEvent.change(input, { target: { value: 'Keep my draft' } })
    fireEvent.click(screen.getByTestId('notification-stand-in-send-assignment'))
    expect(await screen.findByRole('alert')).toHaveTextContent('执行设备离线，请连接设备后重试。')
    expect(input).toHaveValue('Keep my draft')
    expect(onChanged).not.toHaveBeenCalled()
  })
  it('prevents duplicate submissions while awaiting acceptance', async () => {
    let accept!: (value: unknown) => void
    send.mockImplementation(
      () =>
        new Promise(resolve => {
          accept = resolve
        })
    )
    render(view())
    fireEvent.click(screen.getByTestId('notification-stand-in-reply-open-assignment'))
    fireEvent.change(screen.getByTestId('notification-stand-in-reply-assignment'), {
      target: { value: 'Once' },
    })
    const button = screen.getByTestId('notification-stand-in-send-assignment')
    fireEvent.click(button)
    fireEvent.click(button)
    expect(send).toHaveBeenCalledTimes(1)
    await act(async () => accept({ accepted: true, taskId: 'task' }))
  })
  it('retries the failed assignment on its original execution device', async () => {
    render(view('failed'))
    fireEvent.click(screen.getByTestId('notification-stand-in-retry-assignment'))
    await waitFor(() =>
      expect(run).toHaveBeenCalledWith('12', 'ISSUE-1', 1, 'cloud', 'device', undefined)
    )
  })

  it('shows the failed turn error when no model reply was produced', async () => {
    transcript.mockResolvedValue({
      workspacePath: '/project',
      runtime: 'codex',
      running: false,
      messages: [{ id: 'prompt', role: 'user', content: 'Review' }],
      turns: [{ id: 'turn', items: [], status: 'failed', error: 'Workspace config is invalid' }],
    })
    render(view('failed'))
    expect(await screen.findByText('所选工作目录在此执行设备上不可用，请重新选择。')).toBeVisible()
    expect(screen.queryByText(/Model reply is ready|模型回复已完成/)).not.toBeInTheDocument()
    expect(screen.getByTestId('notification-stand-in-retry-assignment')).toBeEnabled()
  })

  it('leaves the summary empty when a failed execution has neither an error nor a reply', async () => {
    transcript.mockResolvedValue({
      workspacePath: '/project',
      runtime: 'codex',
      running: false,
      messages: [{ id: 'prompt', role: 'user', content: 'Review' }],
      turns: [],
    })
    render(view('failed'))
    await waitFor(() => expect(transcript).toHaveBeenCalledOnce())
    expect(screen.getByTestId('notification-stand-in-status-assignment')).toHaveTextContent(
      'notifications.stand_in_failed'
    )
    expect(screen.queryByText(/Model reply is ready|模型回复已完成/)).not.toBeInTheDocument()
  })
  it('answers the actual pending runtime question with its original request identity', async () => {
    transcript.mockResolvedValue({
      workspacePath: '/project',
      runtime: 'codex',
      running: true,
      turns: [],
      messages: [
        {
          id: 'message',
          subtaskId: 'turn',
          role: 'assistant',
          content: '',
          blocks: [
            {
              id: 'question',
              type: 'tool',
              status: 'pending',
              toolName: 'request_user_input',
              renderPayload: {
                kind: 'request_user_input',
                requestId: 7,
                itemId: 'input-1',
                questions: [
                  {
                    id: 'confirm',
                    question: 'Continue submitting?',
                    options: [
                      { label: 'Continue', value: 'continue' },
                      { label: 'Stop', value: 'stop' },
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
    })
    const waiting = mergeStandInNotifications(
      [assignment],
      [{ ...runtimeItem, task: { ...runtimeItem.task, interactionStatus: 'waitingForUserInput' } }]
    )[0]
    render(
      <StandInNotificationProcessing
        notification={waiting}
        rowProps={rowProps}
        services={services}
        userId={1}
        onChanged={onChanged}
      />
    )
    const card = await screen.findByTestId('request-user-input-card')
    expect(card).toHaveTextContent('Continue submitting?')
    fireEvent.click(screen.getByTestId('request-user-input-option-confirm-0'))
    fireEvent.submit(card)
    await waitFor(() => expect(send).toHaveBeenCalledOnce())
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        address: runtimeItem.address,
        requestUserInputResponse: {
          requestId: 7,
          itemId: 'input-1',
          answers: { confirm: { answers: ['continue'] } },
        },
      })
    )
  })
})

it('localizes the persisted failed-task summary before transcript loading', async () => {
  const value = mergeStandInNotifications(
    [assignment],
    [
      {
        ...runtimeItem,
        task: {
          ...runtimeItem.task,
          status: 'failed',
          running: false,
          error: 'Stand-in role no longer exists',
        },
      },
    ]
  )[0]
  render(
    <StandInNotificationProcessing
      notification={value}
      rowProps={rowProps}
      services={services}
      userId={1}
      onChanged={onChanged}
    />
  )
  expect(await screen.findByText('该分身角色已被删除，请重新选择角色。')).toBeVisible()
  expect(screen.queryByText('Stand-in role no longer exists')).not.toBeInTheDocument()
})
