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
})
