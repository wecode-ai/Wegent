import { StrictMode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'

const authMocks = vi.hoisted(() => ({
  start: vi.fn(),
  poll: vi.fn(),
  cancel: vi.fn(),
  open: vi.fn(),
}))

vi.mock('@/lib/external-links', () => ({ openExternalUrl: authMocks.open }))

vi.mock('@/api/local/localConnectorAuth', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/local/localConnectorAuth')>()
  return {
    ...actual,
    localConnectorAuthStart: authMocks.start,
    localConnectorAuthPoll: authMocks.poll,
    localConnectorAuthCancel: authMocks.cancel,
  }
})

const cloudMocks = vi.hoisted(() => ({ authorize: vi.fn(), open: vi.fn() }))

vi.mock('@/api/cloud/connectorApps', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/cloud/connectorApps')>()
  return {
    ...actual,
    authorizeWegentConnector: cloudMocks.authorize,
    notifyConnectorAuthorizationChanged: vi.fn(),
  }
})

vi.mock('@/lib/cloud-authorization-window', () => ({
  openCloudAuthorizationWindow: cloudMocks.open,
}))

import { CloudConnectorAuthCard, ConnectorAuthCard } from './ConnectorAuthCard'
import { GITHUB_CLI_TARGET } from '@/api/local/githubCli'
import type { LocalConnectorAuthResult } from '@/api/local/localConnectorAuth'

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
    authMocks.open.mockReset().mockResolvedValue(true)
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

  test('uses native browser session status without fetching plugin details', async () => {
    authMocks.start.mockResolvedValue({
      status: 'waiting_browser',
      sessionId: 'identity-only-browser-session',
    })
    authMocks.poll.mockImplementation(() => new Promise(() => undefined))

    render(<ConnectorAuthCard target={executorTarget} onSuccess={vi.fn()} onCancel={vi.fn()} />)

    expect(await screen.findByTestId('connector-auth-browser')).toBeInTheDocument()
    expect(authMocks.start).toHaveBeenCalledExactlyOnceWith(executorTarget)
    expect(screen.queryByTestId('connector-auth-qr')).not.toBeInTheDocument()
    expect(screen.getByText('在浏览器中授权')).toBeInTheDocument()
  })

  test('GitHub CLI waits for consent, displays a device code, and opens GitHub in the system browser', async () => {
    authMocks.start.mockResolvedValue({
      status: 'waiting_browser',
      sessionId: 'gh-session',
      userCode: 'ABCD-1234',
      verificationUrl: 'https://github.com/login/device',
    })
    let finishPoll!: (value: LocalConnectorAuthResult) => void
    authMocks.poll.mockImplementation(
      () =>
        new Promise(resolve => {
          finishPoll = resolve
        })
    )
    const onSuccess = vi.fn()
    render(
      <ConnectorAuthCard target={GITHUB_CLI_TARGET} onSuccess={onSuccess} onCancel={vi.fn()} />
    )
    expect(authMocks.start).not.toHaveBeenCalled()
    expect(authMocks.open).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('github-cli-login'))
    expect(await screen.findByTestId('github-cli-device-code')).toHaveTextContent('ABCD-1234')
    expect(authMocks.open).not.toHaveBeenCalled()
    authMocks.open.mockRejectedValueOnce(new Error('sensitive internal error'))
    fireEvent.click(screen.getByTestId('github-cli-open-browser'))
    expect(await screen.findByRole('alert')).not.toHaveTextContent('sensitive internal error')
    fireEvent.click(screen.getByTestId('github-cli-open-browser'))
    await waitFor(() =>
      expect(authMocks.open).toHaveBeenLastCalledWith('https://github.com/login/device', {
        target: 'system',
      })
    )
    await waitFor(
      () =>
        expect(authMocks.poll).toHaveBeenCalledExactlyOnceWith(
          { pluginKey: 'github', connectorSlug: 'wework-github-cli' },
          'gh-session'
        ),
      { timeout: 2000 }
    )
    expect(onSuccess).not.toHaveBeenCalled()
    await act(async () => finishPoll({ status: 'ok', sessionId: 'gh-session' }))
    await waitFor(
      () =>
        expect(onSuccess).toHaveBeenCalledExactlyOnceWith({
          status: 'ok',
          sessionId: 'gh-session',
        }),
      { timeout: 2000 }
    )
  })

  test('GitHub CLI rejects foreign authorization URLs and cancels the native session', async () => {
    authMocks.start.mockResolvedValue({
      status: 'waiting_browser',
      sessionId: 'gh-unsafe',
      verificationUrl: 'https://evil.test/login/device',
    })
    authMocks.poll.mockImplementation(() => new Promise(() => undefined))
    const onCancel = vi.fn()
    render(<ConnectorAuthCard target={GITHUB_CLI_TARGET} onSuccess={vi.fn()} onCancel={onCancel} />)
    fireEvent.click(screen.getByTestId('github-cli-login'))
    await waitFor(() => expect(authMocks.start).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('github-cli-open-browser')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('connector-auth-cancel'))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(authMocks.open).not.toHaveBeenCalled()
    expect(authMocks.cancel).toHaveBeenCalledWith(
      { pluginKey: 'github', connectorSlug: 'wework-github-cli' },
      'gh-unsafe'
    )
  })

  test('GitHub CLI shows missing CLI errors and allows retry without reporting success', async () => {
    authMocks.start.mockResolvedValue({ status: 'error', errorCode: 'gh_missing' })
    const onSuccess = vi.fn()
    render(<ConnectorAuthCard target={GITHUB_CLI_TARGET} onSuccess={onSuccess} />)
    fireEvent.click(screen.getByTestId('github-cli-login'))
    // The status region is already mounted while the asynchronous start is pending.
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/gh/))
    fireEvent.click(screen.getByTestId('connector-auth-retry'))
    await waitFor(() => expect(authMocks.start).toHaveBeenCalledTimes(2))
    expect(onSuccess).not.toHaveBeenCalled()
  })
})

describe('CloudConnectorAuthCard', () => {
  beforeEach(() => {
    authMocks.start.mockReset()
    cloudMocks.authorize.mockReset()
    cloudMocks.open.mockReset()
  })

  test('authorizes the connector app and reports success', async () => {
    cloudMocks.authorize.mockResolvedValue({ status: 'connected' })
    const onSuccess = vi.fn()

    render(
      <CloudConnectorAuthCard
        slug="dingtalk_log"
        apiBaseUrl="https://wegent.test/api"
        token="cloud-token"
        onSuccess={onSuccess}
      />
    )
    fireEvent.click(screen.getByTestId('cloud-connector-auth-authorize'))

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1))
    expect(cloudMocks.authorize).toHaveBeenCalledWith(
      'https://wegent.test/api',
      'cloud-token',
      'dingtalk_log',
      cloudMocks.open
    )
  })

  test('explains that the Wegent account must be connected first', async () => {
    const onSuccess = vi.fn()

    render(
      <CloudConnectorAuthCard
        slug="dingtalk_log"
        apiBaseUrl={null}
        token={null}
        onSuccess={onSuccess}
      />
    )
    fireEvent.click(screen.getByTestId('cloud-connector-auth-authorize'))

    await waitFor(() =>
      expect(screen.getByTestId('cloud-connector-auth-error')).toBeInTheDocument()
    )
    expect(cloudMocks.authorize).not.toHaveBeenCalled()
    expect(onSuccess).not.toHaveBeenCalled()
  })
})
