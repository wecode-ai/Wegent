import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { StandInNotificationProcessing } from './StandInNotificationProcessing'
import { assignment, runtimeItem } from './standInNotifications.fixtures'
import { mergeStandInNotifications } from './standInNotifications'

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
  it('retains the draft and shows the real error on rejected send', async () => {
    send.mockResolvedValue({ accepted: false, error: 'Device offline' })
    render(view())
    fireEvent.click(screen.getByTestId('notification-stand-in-reply-open-assignment'))
    const input = screen.getByTestId('notification-stand-in-reply-assignment')
    fireEvent.change(input, { target: { value: 'Keep my draft' } })
    fireEvent.click(screen.getByTestId('notification-stand-in-send-assignment'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Device offline')
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
      expect(run).toHaveBeenCalledWith('12', 'ISSUE-1', 1, 'cloud', 'device', 'default')
    )
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
