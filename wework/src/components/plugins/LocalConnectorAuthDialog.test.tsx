import { StrictMode } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'

const authMocks = vi.hoisted(() => ({
  start: vi.fn(),
  poll: vi.fn(),
  cancel: vi.fn(),
}))

vi.mock('@/api/local/localConnectorAuth', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/local/localConnectorAuth')>()
  return {
    ...actual,
    localConnectorAuthStart: authMocks.start,
    localConnectorAuthPoll: authMocks.poll,
    localConnectorAuthCancel: authMocks.cancel,
  }
})

import { LocalConnectorAuthDialog } from './LocalConnectorAuthDialog'

const target = {
  pluginKey: 'gitlab-intra',
  connectorSlug: 'gitlab-intra',
  localAuth: {
    kind: 'browser_oauth' as const,
    health: ['scripts/local-auth.sh', 'health'],
    start: ['scripts/local-auth.sh', 'login'],
    poll: [],
    pollIntervalSeconds: 1,
  },
}

const executorTarget = {
  pluginKey: target.pluginKey,
  connectorSlug: target.connectorSlug,
}

describe('LocalConnectorAuthDialog browser oauth', () => {
  beforeEach(() => {
    authMocks.start.mockReset()
    authMocks.poll.mockReset()
    authMocks.cancel.mockReset().mockResolvedValue({ status: 'cancelled' })
  })

  test('polls an asynchronous browser session until authorization succeeds', async () => {
    authMocks.start.mockResolvedValue({
      status: 'waiting_browser',
      sessionId: 'session-1',
    })
    authMocks.poll.mockResolvedValue({ status: 'ok', sessionId: 'session-1' })
    const onSuccess = vi.fn()

    render(
      <LocalConnectorAuthDialog open target={target} onSuccess={onSuccess} onCancel={vi.fn()} />
    )

    expect(await screen.findByTestId('local-connector-auth-browser')).toBeInTheDocument()
    expect(screen.queryByTestId('local-connector-auth-retry')).not.toBeInTheDocument()
    await waitFor(() => expect(authMocks.start).toHaveBeenCalledWith(executorTarget))
    await waitFor(() => expect(authMocks.poll).toHaveBeenCalledWith(executorTarget, 'session-1'), {
      timeout: 2_000,
    })
    await waitFor(() =>
      expect(onSuccess).toHaveBeenCalledWith({ status: 'ok', sessionId: 'session-1' })
    )
  })

  test('starts one browser session under React StrictMode', async () => {
    authMocks.start.mockResolvedValue({
      status: 'waiting_browser',
      sessionId: 'strict-session',
    })
    authMocks.poll.mockImplementation(() => new Promise(() => undefined))

    render(
      <StrictMode>
        <LocalConnectorAuthDialog open target={target} onSuccess={vi.fn()} onCancel={vi.fn()} />
      </StrictMode>
    )

    await waitFor(() => expect(authMocks.start).toHaveBeenCalledTimes(1))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(authMocks.start).toHaveBeenCalledTimes(1)
    expect(authMocks.cancel).not.toHaveBeenCalled()
  })

  test('cancels the executor session when the dialog is dismissed', async () => {
    authMocks.start.mockResolvedValue({
      status: 'waiting_browser',
      sessionId: 'session-2',
    })
    authMocks.poll.mockResolvedValue({
      status: 'waiting_browser',
      sessionId: 'session-2',
    })
    const onCancel = vi.fn()

    render(
      <LocalConnectorAuthDialog open target={target} onSuccess={vi.fn()} onCancel={onCancel} />
    )

    await waitFor(() => expect(authMocks.start).toHaveBeenCalled())
    await userEvent.click(screen.getByTestId('local-connector-auth-cancel'))

    expect(onCancel).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(authMocks.cancel).toHaveBeenCalledWith(executorTarget, 'session-2'))
  })

  test('cancels the abandoned session and starts a new session after a host remount', async () => {
    authMocks.start
      .mockResolvedValueOnce({
        status: 'waiting_browser',
        sessionId: 'session-remount',
      })
      .mockResolvedValue({
        status: 'waiting_browser',
        sessionId: 'session-new',
      })
    authMocks.poll.mockImplementation(() => new Promise(() => undefined))

    const view = render(
      <LocalConnectorAuthDialog open target={target} onSuccess={vi.fn()} onCancel={vi.fn()} />
    )

    await waitFor(() => expect(authMocks.start).toHaveBeenCalled())
    view.unmount()
    render(<LocalConnectorAuthDialog open target={target} onSuccess={vi.fn()} onCancel={vi.fn()} />)

    await waitFor(() => expect(authMocks.start).toHaveBeenCalledTimes(2))
    expect(authMocks.cancel).toHaveBeenCalledExactlyOnceWith(executorTarget, 'session-remount')
  })

  test('shows a string executor error once', async () => {
    authMocks.start.mockRejectedValue('internal_error: HOME is not set')

    render(<LocalConnectorAuthDialog open target={target} onSuccess={vi.fn()} onCancel={vi.fn()} />)

    await screen.findByTestId('local-connector-auth-retry')
    expect(screen.getAllByText('internal_error: HOME is not set')).toHaveLength(1)
    expect(screen.getByTestId('local-connector-auth-browser-error')).toBeInTheDocument()
    expect(screen.queryByTestId('local-connector-auth-browser-loading')).not.toBeInTheDocument()
  })

  test.each(['local-connector-auth-cancel', 'local-connector-auth-close'])(
    'preserves local success when %s dismisses a cloud sync failure',
    async testId => {
      const local = { status: 'ok', accountSyncStatus: 'failed' }
      authMocks.start.mockResolvedValue(local)
      const onSuccess = vi.fn()
      const onCancel = vi.fn()
      render(
        <LocalConnectorAuthDialog open target={target} onSuccess={onSuccess} onCancel={onCancel} />
      )
      expect(
        await screen.findByText('本机登录已成功，云端同步未完成。请重试同步，或先在本机使用。')
      ).toBeInTheDocument()
      expect(screen.getByTestId('local-connector-auth-retry')).toHaveTextContent('重试云端同步')
      expect(onSuccess).not.toHaveBeenCalled()
      await userEvent.click(screen.getByTestId(testId))
      expect(onSuccess).toHaveBeenCalledExactlyOnceWith(local)
      expect(onCancel).not.toHaveBeenCalled()
      expect(authMocks.cancel).not.toHaveBeenCalled()
    }
  )

  test('retries cloud synchronization before completing the login flow', async () => {
    authMocks.start
      .mockResolvedValueOnce({ status: 'ok', accountSyncStatus: 'failed' })
      .mockResolvedValueOnce({ status: 'ok' })
    const onSuccess = vi.fn()
    render(
      <LocalConnectorAuthDialog open target={target} onSuccess={onSuccess} onCancel={vi.fn()} />
    )
    await userEvent.click(await screen.findByTestId('local-connector-auth-retry'))
    await waitFor(() => expect(onSuccess).toHaveBeenCalledExactlyOnceWith({ status: 'ok' }))
    expect(authMocks.start).toHaveBeenCalledTimes(2)
  })

  test('does not reuse a previous local success when the dialog is reopened', async () => {
    authMocks.start.mockResolvedValueOnce({ status: 'ok', accountSyncStatus: 'failed' })
    const onSuccess = vi.fn()
    const view = render(
      <LocalConnectorAuthDialog open target={target} onSuccess={onSuccess} onCancel={vi.fn()} />
    )
    await screen.findByTestId('local-connector-auth-retry')
    view.rerender(
      <LocalConnectorAuthDialog
        open={false}
        target={target}
        onSuccess={onSuccess}
        onCancel={vi.fn()}
      />
    )
    authMocks.start.mockResolvedValue({ status: 'waiting_browser', sessionId: 'new-session' })
    authMocks.poll.mockResolvedValue({ status: 'waiting_browser', sessionId: 'new-session' })
    view.rerender(
      <LocalConnectorAuthDialog open target={target} onSuccess={onSuccess} onCancel={vi.fn()} />
    )
    await waitFor(() => expect(authMocks.start).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('local-connector-auth-cancel')).toHaveTextContent('取消')
    expect(onSuccess).not.toHaveBeenCalled()
  })
})
