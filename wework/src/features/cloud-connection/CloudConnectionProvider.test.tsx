import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHttpClient } from '@/api/http'
import type { OpenCloudAuthorizationUrl } from './CloudConnectionContext'
import { CloudConnectionProvider } from './CloudConnectionProvider'
import { saveStoredCloudConnection } from './cloudConnectionStorage'
import { useCloudConnection } from './useCloudConnection'

const httpMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}))

vi.mock('@/api/http', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/http')>()
  return {
    ...actual,
    createHttpClient: vi.fn(() => ({
      get: httpMocks.get,
      post: httpMocks.post,
      put: vi.fn(),
      delete: vi.fn(),
    })),
  }
})

function CloudConnectProbe({
  onError,
  openAuthorizationUrl = vi.fn(),
}: {
  onError: (error: unknown) => void
  openAuthorizationUrl?: OpenCloudAuthorizationUrl
}) {
  const cloud = useCloudConnection()
  return (
    <button
      type="button"
      data-testid="connect-cloud-button"
      onClick={async () => {
        try {
          await cloud.connectWithAuthorization('https://cloud.example.com', openAuthorizationUrl)
        } catch (error) {
          onError(error)
        }
      }}
    >
      connect
    </button>
  )
}

function CloudSocketProbe() {
  const cloud = useCloudConnection()
  return (
    <>
      <span data-testid="cloud-connection-status">{cloud.status}</span>
      <span data-testid="cloud-socket-base-url">{cloud.socketBaseUrl}</span>
      <span data-testid="cloud-web-url">{cloud.webUrl}</span>
    </>
  )
}

describe('CloudConnectionProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reports the failing cloud connection stage when health cannot reach backend', async () => {
    const onError = vi.fn()
    httpMocks.get.mockRejectedValueOnce(new Error('url not allowed on the configured scope'))

    render(
      <CloudConnectionProvider>
        <CloudConnectProbe onError={onError} />
      </CloudConnectionProvider>
    )

    await userEvent.click(screen.getByTestId('connect-cloud-button'))

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
    const error = onError.mock.calls[0][0]
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('健康检查失败')
    expect((error as Error).message).toContain('HTTP 权限拦截')
    expect(httpMocks.post).not.toHaveBeenCalled()
  })

  it('opens the cloud authorization page and stores the claimed token', async () => {
    const onError = vi.fn()
    const closeAuthorizationWindow = vi.fn()
    const openAuthorizationUrl = vi.fn(() => ({
      close: closeAuthorizationWindow,
    }))
    const token = `header.${btoa(JSON.stringify({ exp: 2_000_000_000 })).replace(/=/g, '')}.sig`
    httpMocks.get.mockResolvedValueOnce({ status: 'healthy' })
    httpMocks.post.mockResolvedValueOnce({
      session_id: 'session-1',
      poll_token: 'poll-1',
      authorize_url: 'https://cloud.example.com/auth/wework/authorize?session_id=session-1',
      web_url: 'https://cloud.example.com',
      expires_at: Math.floor(Date.now() / 1000) + 30,
      poll_interval_seconds: 0.001,
    })
    httpMocks.get.mockResolvedValueOnce({
      status: 'success',
      access_token: token,
      token_type: 'bearer',
      username: 'alice',
    })
    httpMocks.get.mockResolvedValueOnce({
      id: 7,
      user_name: 'alice',
      email: 'alice@example.com',
    })

    render(
      <CloudConnectionProvider>
        <CloudConnectProbe onError={onError} openAuthorizationUrl={openAuthorizationUrl} />
      </CloudConnectionProvider>
    )

    await userEvent.click(screen.getByTestId('connect-cloud-button'))

    await waitFor(() => expect(onError).not.toHaveBeenCalled())
    await waitFor(() => {
      expect(
        JSON.parse(localStorage.getItem('wework.cloudConnection') || '{}').user.user_name
      ).toBe('alice')
    })
    expect(createHttpClient).toHaveBeenCalled()
    expect(httpMocks.post).toHaveBeenCalledWith('/auth/wework/sessions')
    expect(closeAuthorizationWindow).toHaveBeenCalled()
  })

  it('uses the configured Socket URL for the packaged Backend', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = {
      wegentBackendUrl: 'https://cloud.example.com/api',
      socketBaseUrl: 'wss://wss-cloud.example.com',
    }
    saveStoredCloudConnection({
      backendUrl: 'https://cloud.example.com',
      apiBaseUrl: 'https://cloud.example.com/api',
      socketBaseUrl: 'https://wss-cloud.example.com',
      socketPath: '/socket.io',
      webUrl: 'https://cloud.example.com',
      token: 'cloud-token',
      tokenExpiresAt: null,
      user: { id: 7, user_name: 'alice', email: 'alice@example.com' },
      connectedAt: '2026-07-20T00:00:00.000Z',
    })
    httpMocks.get.mockResolvedValueOnce({
      id: 7,
      user_name: 'alice',
      email: 'alice@example.com',
    })

    render(
      <CloudConnectionProvider>
        <CloudSocketProbe />
      </CloudConnectionProvider>
    )

    expect(screen.getByTestId('cloud-socket-base-url')).toHaveTextContent(
      'wss://wss-cloud.example.com'
    )
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem('wework.cloudConnection') || '{}').socketBaseUrl).toBe(
        'wss://wss-cloud.example.com'
      )
    })
  })

  it('corrects and stores the Web URL for an existing cloud connection', async () => {
    saveStoredCloudConnection({
      backendUrl: 'https://api.example.com',
      apiBaseUrl: 'https://api.example.com/api',
      socketBaseUrl: 'https://api.example.com',
      socketPath: '/socket.io',
      webUrl: 'https://wework.example.com',
      token: 'cloud-token',
      tokenExpiresAt: null,
      user: { id: 7, user_name: 'alice', email: 'alice@example.com' },
      connectedAt: '2026-07-20T00:00:00.000Z',
    })
    httpMocks.get.mockImplementation((endpoint: string) => {
      if (endpoint === '/auth/wework/config') {
        return Promise.resolve({ web_url: 'https://app.example.com/' })
      }
      return Promise.resolve({ id: 7, user_name: 'alice', email: 'alice@example.com' })
    })

    render(
      <CloudConnectionProvider>
        <CloudSocketProbe />
      </CloudConnectionProvider>
    )

    await waitFor(() => {
      expect(screen.getByTestId('cloud-web-url')).toHaveTextContent('https://app.example.com')
    })
    expect(JSON.parse(localStorage.getItem('wework.cloudConnection') || '{}').webUrl).toBe(
      'https://app.example.com'
    )
  })

  it('discards a stored connection with an invalid backend URL', () => {
    localStorage.setItem(
      'wework.cloudConnection',
      JSON.stringify({
        backendUrl: '',
        apiBaseUrl: 'https://cloud.example.com/api',
        socketBaseUrl: 'https://cloud.example.com',
        socketPath: '/socket.io',
        token: 'cloud-token',
        tokenExpiresAt: null,
        user: { id: 7, user_name: 'alice', email: 'alice@example.com' },
        connectedAt: '2026-07-20T00:00:00.000Z',
      })
    )

    render(
      <CloudConnectionProvider>
        <CloudSocketProbe />
      </CloudConnectionProvider>
    )

    expect(screen.getByTestId('cloud-connection-status')).toHaveTextContent('disconnected')
    expect(localStorage.getItem('wework.cloudConnection')).toBeNull()
    expect(httpMocks.get).not.toHaveBeenCalled()
  })

  it('keeps the cloud connection when closing the authorization window fails after success', async () => {
    const onError = vi.fn()
    const openAuthorizationUrl = vi.fn(() => ({
      close: vi.fn(() => Promise.reject(new Error('close failed'))),
    }))
    const token = `header.${btoa(JSON.stringify({ exp: 2_000_000_000 })).replace(/=/g, '')}.sig`
    httpMocks.get.mockResolvedValueOnce({ status: 'healthy' })
    httpMocks.post.mockResolvedValueOnce({
      session_id: 'session-1',
      poll_token: 'poll-1',
      authorize_url: 'https://cloud.example.com/auth/wework/authorize?session_id=session-1',
      web_url: 'https://cloud.example.com',
      expires_at: Math.floor(Date.now() / 1000) + 30,
      poll_interval_seconds: 0.001,
    })
    httpMocks.get.mockResolvedValueOnce({
      status: 'success',
      access_token: token,
      token_type: 'bearer',
      username: 'alice',
    })
    httpMocks.get.mockResolvedValueOnce({
      id: 7,
      user_name: 'alice',
      email: 'alice@example.com',
    })

    render(
      <CloudConnectionProvider>
        <CloudConnectProbe onError={onError} openAuthorizationUrl={openAuthorizationUrl} />
      </CloudConnectionProvider>
    )

    await userEvent.click(screen.getByTestId('connect-cloud-button'))

    await waitFor(() => expect(onError).not.toHaveBeenCalled())
    await waitFor(() => {
      expect(
        JSON.parse(localStorage.getItem('wework.cloudConnection') || '{}').user.user_name
      ).toBe('alice')
    })
  })

  it('cancels cloud authorization when the authorization window closes', async () => {
    const onError = vi.fn()
    let closeAuthorizationWindow: () => void = () => undefined
    const openAuthorizationUrl = vi.fn(() => ({
      closed: new Promise<void>(resolve => {
        closeAuthorizationWindow = resolve
      }),
    }))
    httpMocks.get.mockResolvedValueOnce({ status: 'healthy' })
    httpMocks.post.mockResolvedValueOnce({
      session_id: 'session-1',
      poll_token: 'poll-1',
      authorize_url: 'https://cloud.example.com/auth/wework/authorize?session_id=session-1',
      web_url: 'https://cloud.example.com',
      expires_at: Math.floor(Date.now() / 1000) + 30,
      poll_interval_seconds: 30,
    })

    render(
      <CloudConnectionProvider>
        <CloudConnectProbe onError={onError} openAuthorizationUrl={openAuthorizationUrl} />
      </CloudConnectionProvider>
    )

    await userEvent.click(screen.getByTestId('connect-cloud-button'))
    await waitFor(() => expect(openAuthorizationUrl).toHaveBeenCalledTimes(1))
    closeAuthorizationWindow()

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
    expect((onError.mock.calls[0][0] as Error).message).toBe('云端授权窗口已关闭，请重新连接')
    expect(httpMocks.get).toHaveBeenCalledTimes(1)
  })
})
