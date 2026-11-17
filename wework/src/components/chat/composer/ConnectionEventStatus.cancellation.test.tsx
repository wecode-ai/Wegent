import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import messages from '@/i18n/locales/zh-CN/common.json'
import { ConnectionEventStatus } from './ConnectionEventStatus'
import { ConversationEventContext } from './ConversationEventContext'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, options?: string | Record<string, string>) => {
      const value = key
        .split('.')
        .reduce<unknown>((current, part) => (current as Record<string, unknown>)?.[part], messages)
      return String(value ?? (typeof options === 'string' ? options : key)).replace(
        /{{(\w+)}}/g,
        (_, name) => (typeof options === 'object' ? (options[name] ?? '') : '')
      )
    },
  }),
}))
const watch = (key: string) => ({
  subscription_key: key,
  source: { name: key },
  status: 'armed',
  last_collected_at: Date.now(),
})

test('cancels one watch without a model and leaves the other watch available', async () => {
  let finish!: () => void
  const onCancel = vi.fn(
    () =>
      new Promise<void>(resolve => {
        finish = resolve
      })
  )
  render(
    <ConnectionEventStatus subscriptions={[watch('PR'), watch('Document')]} onCancel={onCancel} />
  )
  const button = screen.getByRole('button', { name: '取消 PR 监听' })
  fireEvent.click(button)
  fireEvent.click(button)
  expect(onCancel).toHaveBeenCalledExactlyOnceWith('PR')
  expect(button).toBeDisabled()
  expect(button).toHaveTextContent('正在取消')
  expect(screen.getByRole('button', { name: '取消 Document 监听' })).toBeEnabled()
  await act(async () => finish())
  expect(screen.queryByRole('button', { name: '取消 PR 监听' })).not.toBeInTheDocument()
  expect(screen.getByText('已取消 PR 监听。已开始的执行会继续。')).toBeInTheDocument()
})

test('failed cancellation retains the watch and permits an explicit retry', async () => {
  const onCancel = vi
    .fn()
    .mockRejectedValueOnce(new Error('device offline'))
    .mockResolvedValueOnce(undefined)
  render(<ConnectionEventStatus subscriptions={[watch('PR')]} onCancel={onCancel} />)
  fireEvent.click(screen.getByRole('button', { name: '取消 PR 监听' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('取消失败，请重试')
  expect(screen.getByText('等待事件，到达后自动继续')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '取消 PR 监听' }))
  await waitFor(() => expect(screen.queryByRole('button')).not.toBeInTheDocument())
  expect(onCancel).toHaveBeenCalledTimes(2)
})

test('offline cancellation remains visible and becomes available after reconnect', () => {
  const onCancel = vi.fn()
  const { rerender } = render(
    <ConnectionEventStatus subscriptions={[watch('PR')]} onCancel={onCancel} unavailable />
  )
  expect(screen.getByRole('button')).toBeDisabled()
  expect(screen.getByText('设备离线，恢复后可取消')).toBeInTheDocument()
  rerender(<ConnectionEventStatus subscriptions={[watch('PR')]} onCancel={onCancel} />)
  expect(screen.getByRole('button')).toBeEnabled()
  expect(onCancel).not.toHaveBeenCalled()
})

test('a late cancellation cannot affect a different task with the same subscription key', async () => {
  let finish!: () => void
  const onCancel = vi.fn(
    () =>
      new Promise<void>(resolve => {
        finish = resolve
      })
  )
  const { rerender } = render(
    <ConversationEventContext
      eventSubscriptionScope="task-a"
      subscriptions={[watch('PR')]}
      onCancelEventSubscription={onCancel}
    />
  )
  fireEvent.click(screen.getByRole('button'))
  rerender(
    <ConversationEventContext
      eventSubscriptionScope="task-b"
      subscriptions={[watch('PR')]}
      onCancelEventSubscription={vi.fn()}
    />
  )
  await act(async () => finish())
  expect(screen.getByRole('button', { name: '取消 PR 监听' })).toBeEnabled()
  expect(screen.queryByText(/已取消/)).not.toBeInTheDocument()
})

test.each(['preparing', 'armed', 'pending', 'resuming_goal', 'error', 'needs_attention'])(
  'a %s subscription can be cancelled while a question is pending',
  status => {
    render(
      <ConnectionEventStatus
        subscriptions={[{ ...watch('PR'), status }]}
        interactionStatus="awaitingUserReply"
        onCancel={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: '取消 PR 监听' })).toBeEnabled()
  }
)

test('distinguishes watches in the same repository by their discovered resource summary', async () => {
  const onCancel = vi.fn().mockResolvedValue(undefined)
  render(
    <ConnectionEventStatus
      subscriptions={[
        { ...watch('one'), source: { name: 'org/repo', configurationSummary: 'PRs #1' } },
        { ...watch('two'), source: { name: 'org/repo', configurationSummary: 'PRs #2' } },
      ]}
      onCancel={onCancel}
    />
  )
  const first = screen.getByRole('button', { name: '取消 org/repo · PRs #1 监听' })
  first.focus()
  fireEvent.click(first)
  expect(
    await screen.findByText('已取消 org/repo · PRs #1 监听。已开始的执行会继续。')
  ).toBeInTheDocument()
  const second = screen.getByRole('button', { name: '取消 org/repo · PRs #2 监听' })
  await waitFor(() => expect(second).toHaveFocus())
  expect(onCancel).toHaveBeenCalledExactlyOnceWith('one')
})

test('preserves keyboard focus in the confirmation when the last watch is cancelled', async () => {
  render(
    <ConnectionEventStatus
      subscriptions={[watch('PR')]}
      onCancel={vi.fn().mockResolvedValue(undefined)}
    />
  )
  const button = screen.getByRole('button')
  button.focus()
  fireEvent.click(button)
  const feedback = await screen.findByTestId('connection-event-cancel-feedback')
  await waitFor(() => expect(feedback).toHaveFocus())
})

test('unsupported devices explain the upgrade requirement without offering a broken action', () => {
  const onCancel = vi.fn()
  render(<ConnectionEventStatus subscriptions={[watch('PR')]} onCancel={onCancel} unsupported />)
  expect(screen.getByRole('button')).toBeDisabled()
  expect(screen.getByText('此设备需升级执行器以使用事件监听')).toBeInTheDocument()
  expect(onCancel).not.toHaveBeenCalled()
})

test.each(['unsupported_method', 'permission_denied'])(
  'classifies a %s response without treating permissions as a version problem',
  async code => {
    const onCancel = vi.fn().mockRejectedValue(Object.assign(new Error(code), { code }))
    render(<ConnectionEventStatus subscriptions={[watch('PR')]} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole('button'))
    if (code === 'unsupported_method') {
      expect(await screen.findByText('此设备需升级执行器以使用事件监听')).toBeInTheDocument()
      expect(screen.getByRole('button')).toBeDisabled()
    } else {
      expect(await screen.findByRole('alert')).toHaveTextContent('取消失败，请重试')
      expect(screen.queryByText('此设备需升级执行器以使用事件监听')).not.toBeInTheDocument()
      expect(screen.getByRole('button')).toBeEnabled()
    }
  }
)

test('a replaced executor clears an unsupported response and permits cancellation again', async () => {
  const onCancel = vi
    .fn()
    .mockRejectedValueOnce(Object.assign(new Error('old executor'), { code: 'unsupported_method' }))
    .mockResolvedValue(undefined)
  const { rerender } = render(
    <ConversationEventContext
      eventSubscriptionScope="task-executor-v1"
      subscriptions={[watch('PR')]}
      onCancelEventSubscription={onCancel}
    />
  )
  fireEvent.click(screen.getByRole('button'))
  expect(await screen.findByText('此设备需升级执行器以使用事件监听')).toBeInTheDocument()
  rerender(
    <ConversationEventContext
      eventSubscriptionScope="task-executor-v2"
      subscriptions={[watch('PR')]}
      onCancelEventSubscription={onCancel}
    />
  )
  expect(screen.getByRole('button')).toBeEnabled()
  fireEvent.click(screen.getByRole('button'))
  await waitFor(() => expect(screen.queryByRole('button')).not.toBeInTheDocument())
  expect(onCancel).toHaveBeenCalledTimes(2)
})

test('offline status takes precedence over unavailable capability metadata and recovers accurately', () => {
  const onCancel = vi.fn()
  const { rerender } = render(
    <ConnectionEventStatus
      subscriptions={[watch('PR')]}
      onCancel={onCancel}
      unavailable
      unsupported
    />
  )
  expect(screen.getByRole('button')).toBeDisabled()
  expect(screen.getByText('设备离线，恢复后可取消')).toBeInTheDocument()
  expect(screen.queryByTestId('connection-event-upgrade-required')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button'))
  expect(onCancel).not.toHaveBeenCalled()

  rerender(<ConnectionEventStatus subscriptions={[watch('PR')]} onCancel={onCancel} unsupported />)
  expect(screen.queryByText('设备离线，恢复后可取消')).not.toBeInTheDocument()
  expect(screen.getByTestId('connection-event-upgrade-required')).toBeInTheDocument()
  expect(screen.getByRole('button')).toBeDisabled()

  rerender(<ConnectionEventStatus subscriptions={[watch('PR')]} onCancel={onCancel} />)
  expect(screen.queryByTestId('connection-event-upgrade-required')).not.toBeInTheDocument()
  expect(screen.getByRole('button')).toBeEnabled()
})
