import { StrictMode } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
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

import { ConnectorAuthCard } from './ConnectorAuthCard'

const browserTarget = {
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
  pluginKey: browserTarget.pluginKey,
  connectorSlug: browserTarget.connectorSlug,
}

describe('ConnectorAuthCard browser oauth', () => {
  beforeEach(() => {
    authMocks.start.mockReset()
    authMocks.poll.mockReset()
    authMocks.cancel.mockReset().mockResolvedValue({ status: 'cancelled' })
  })

  test('polls browser sessions with sessionId until authorization succeeds', async () => {
    authMocks.start.mockResolvedValue({
      status: 'waiting_browser',
      sessionId: 'card-session-1',
    })
    authMocks.poll.mockResolvedValue({ status: 'ok', sessionId: 'card-session-1' })
    const onSuccess = vi.fn()

    render(<ConnectorAuthCard target={browserTarget} onSuccess={onSuccess} onCancel={vi.fn()} />)

    expect(await screen.findByTestId('connector-auth-browser')).toBeInTheDocument()
    await waitFor(() => expect(authMocks.start).toHaveBeenCalledWith(executorTarget))
    await waitFor(
      () => expect(authMocks.poll).toHaveBeenCalledWith(executorTarget, 'card-session-1'),
      { timeout: 2_000 }
    )
    await waitFor(() =>
      expect(onSuccess).toHaveBeenCalledWith({ status: 'ok', sessionId: 'card-session-1' })
    )
  })

  test('starts one browser session under React StrictMode', async () => {
    authMocks.start.mockResolvedValue({
      status: 'waiting_browser',
      sessionId: 'strict-card-session',
    })
    authMocks.poll.mockImplementation(() => new Promise(() => undefined))

    render(
      <StrictMode>
        <ConnectorAuthCard target={browserTarget} onSuccess={vi.fn()} onCancel={vi.fn()} />
      </StrictMode>
    )

    await waitFor(() => expect(authMocks.start).toHaveBeenCalledTimes(1))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(authMocks.start).toHaveBeenCalledTimes(1)
  })

  test('starts QR auth when chat resume omits localAuth on the target', async () => {
    authMocks.start.mockResolvedValue({
      status: 'waiting_scan',
      qrImage: { dataUrl: 'data:image/png;base64,abc' },
    })
    authMocks.poll.mockResolvedValue({ status: 'waiting_scan' })

    render(
      <ConnectorAuthCard
        target={{ pluginKey: 'weibo-api-wiki', connectorSlug: 'weibo-wiki' }}
        onSuccess={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    await waitFor(() =>
      expect(authMocks.start).toHaveBeenCalledWith({
        pluginKey: 'weibo-api-wiki',
        connectorSlug: 'weibo-wiki',
      })
    )
    expect(await screen.findByTestId('connector-auth-qr')).toBeInTheDocument()
    expect(screen.queryByText(/does not support local authentication/i)).not.toBeInTheDocument()
  })
})
