import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHttpClient } from '@/api/http'
import { updateAppPreferences } from '@/desktop/appPreferences'
import type { OpenCloudAuthorizationUrl } from './CloudConnectionContext'
import { CloudConnectionProvider } from './CloudConnectionProvider'
import { getJwtExpiry, saveStoredCloudConnection } from './cloudConnectionStorage'
import { useCloudConnection } from './useCloudConnection'

const httpMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}))

const credentialMocks = vi.hoisted(() => ({
  getDevicePublicKey: vi.fn(),
  claimAuthorization: vi.fn(),
  refreshAccessToken: vi.fn(),
  clear: vi.fn(),
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

vi.mock('@/desktop/cloudCredentials', async importOriginal => {
  const actual = await importOriginal<typeof import('@/desktop/cloudCredentials')>()
  return {
    ...actual,
    getDesktopDevicePublicKey: credentialMocks.getDevicePublicKey,
    claimDesktopCloudAuthorization: credentialMocks.claimAuthorization,
    refreshDesktopCloudAccessToken: credentialMocks.refreshAccessToken,
    clearDesktopCloudCredentials: credentialMocks.clear,
  }
})

function tokenWithExp(exp = Math.floor(Date.now() / 1000) + 3600): string {
  return `header.${btoa(JSON.stringify({ exp })).replace(/=/g, '')}.sig`
}

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
      <button type="button" data-testid="disconnect-cloud-button" onClick={cloud.disconnect}>
        disconnect
      </button>
      <button
        type="button"
        data-testid="refresh-cloud-button"
        onClick={() => void cloud.refreshUser()}
      >
        refresh
      </button>
    </>
  )
}

describe('CloudConnectionProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    credentialMocks.getDevicePublicKey.mockResolvedValue({
      kty: 'EC',
      crv: 'P-256',
      x: 'x',
      y: 'y',
    })
    credentialMocks.refreshAccessToken.mockResolvedValue({
      accessToken: tokenWithExp(),
      tokenType: 'bearer',
      expiresIn: 3600,
    })
    credentialMocks.clear.mockResolvedValue(undefined)
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

  it('opens the cloud authorization page and stores connection metadata without the token', async () => {
    const onError = vi.fn()
    const closeAuthorizationWindow = vi.fn()
    const openAuthorizationUrl = vi.fn(() => ({
      close: closeAuthorizationWindow,
    }))
    const token = tokenWithExp()
    httpMocks.get.mockResolvedValueOnce({ status: 'healthy' })
    httpMocks.get.mockResolvedValueOnce({
      web_url: 'https://cloud.example.com',
      socket_url: 'wss://backend-socket.example.com',
    })
    httpMocks.post.mockResolvedValueOnce({
      session_id: 'session-1',
      poll_token: 'poll-1',
      authorize_url: 'https://cloud.example.com/auth/wework/authorize?session_id=session-1',
      web_url: 'https://cloud.example.com',
      expires_at: Math.floor(Date.now() / 1000) + 30,
      poll_interval_seconds: 0.001,
    })
    credentialMocks.claimAuthorization.mockResolvedValueOnce({
      status: 'success',
      accessToken: token,
      tokenType: 'bearer',
      username: 'alice',
      credentialMode: 'desktop_refresh',
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
    expect(credentialMocks.refreshAccessToken).not.toHaveBeenCalled()
    expect(httpMocks.post).toHaveBeenCalledWith('/auth/wework/sessions', {
      device_public_key: {
        kty: 'EC',
        crv: 'P-256',
        x: 'x',
        y: 'y',
      },
    })
    expect(closeAuthorizationWindow).toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem('wework.cloudConnection') || '{}').socketBaseUrl).toBe(
      'wss://backend-socket.example.com'
    )
    expect(JSON.parse(localStorage.getItem('wework.cloudConnection') || '{}')).not.toHaveProperty(
      'token'
    )
  })

  it('stores the access token when the Backend does not support refresh tokens', async () => {
    const onError = vi.fn()
    const token = tokenWithExp()
    httpMocks.get
      .mockResolvedValueOnce({ status: 'healthy' })
      .mockResolvedValueOnce({
        web_url: 'https://legacy.example.com',
        socket_url: 'wss://legacy.example.com',
      })
      .mockResolvedValueOnce({
        id: 7,
        user_name: 'alice',
        email: 'alice@example.com',
      })
    httpMocks.post.mockResolvedValueOnce({
      session_id: 'session-1',
      poll_token: 'poll-1',
      authorize_url: 'https://legacy.example.com/auth/wework/authorize?session_id=session-1',
      web_url: 'https://legacy.example.com',
      expires_at: Math.floor(Date.now() / 1000) + 30,
      poll_interval_seconds: 0.001,
    })
    credentialMocks.claimAuthorization.mockResolvedValueOnce({
      status: 'success',
      accessToken: token,
      tokenType: 'bearer',
      username: 'alice',
      credentialMode: 'legacy_access_token',
    })

    render(
      <CloudConnectionProvider>
        <CloudConnectProbe onError={onError} />
      </CloudConnectionProvider>
    )

    await userEvent.click(screen.getByTestId('connect-cloud-button'))

    await waitFor(() => expect(onError).not.toHaveBeenCalled())
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem('wework.cloudConnection') || '{}')).toMatchObject({
        credentialMode: 'legacy_access_token',
        token,
      })
    })
    expect(credentialMocks.refreshAccessToken).not.toHaveBeenCalled()
  })

  it('restores a legacy access-token connection without the desktop refresh service', async () => {
    const token = tokenWithExp()
    saveStoredCloudConnection({
      backendUrl: 'https://legacy.example.com',
      apiBaseUrl: 'https://legacy.example.com/api',
      socketBaseUrl: 'wss://legacy.example.com',
      socketPath: '/socket.io',
      webUrl: 'https://legacy.example.com',
      credentialMode: 'legacy_access_token',
      token,
      tokenExpiresAt: getJwtExpiry(token),
      user: { id: 7, user_name: 'alice', email: 'alice@example.com' },
      connectedAt: '2026-08-28T00:00:00.000Z',
    })
    httpMocks.get.mockImplementation((endpoint: string) => {
      if (endpoint === '/auth/wework/config') {
        return Promise.resolve({
          web_url: 'https://legacy.example.com',
          socket_url: 'wss://legacy.example.com',
        })
      }
      if (endpoint === '/users/me') {
        return Promise.resolve({
          id: 7,
          user_name: 'alice',
          email: 'alice@example.com',
        })
      }
      return Promise.reject(new Error(`Unexpected GET ${endpoint}`))
    })

    render(
      <CloudConnectionProvider>
        <CloudSocketProbe />
      </CloudConnectionProvider>
    )

    await waitFor(() =>
      expect(httpMocks.get).toHaveBeenCalledWith('/users/me', {
        redirectOnUnauthorized: false,
      })
    )
    expect(screen.getByTestId('cloud-connection-status')).toHaveTextContent('connected')
    expect(credentialMocks.refreshAccessToken).not.toHaveBeenCalled()
  })

  it('does not initialize application plugins when restoring a cloud connection', async () => {
    saveStoredCloudConnection({
      backendUrl: 'https://cloud.example.com',
      apiBaseUrl: 'https://cloud.example.com/api',
      socketBaseUrl: 'wss://backend-socket.example.com',
      socketPath: '/socket.io',
      webUrl: 'https://cloud.example.com',
      user: { id: 7, user_name: 'alice', email: 'alice@example.com' },
      connectedAt: '2026-07-20T00:00:00.000Z',
    })
    httpMocks.get.mockImplementation((endpoint: string) => {
      if (endpoint === '/auth/wework/config') {
        return Promise.resolve({
          web_url: 'https://cloud.example.com',
          socket_url: 'wss://backend-socket.example.com',
        })
      }
      if (endpoint === '/users/me') {
        return Promise.resolve({
          id: 7,
          user_name: 'alice',
          email: 'alice@example.com',
        })
      }
      return Promise.reject(new Error(`Unexpected GET ${endpoint}`))
    })

    render(
      <CloudConnectionProvider>
        <CloudSocketProbe />
      </CloudConnectionProvider>
    )

    await waitFor(() =>
      expect(httpMocks.get).toHaveBeenCalledWith('/auth/wework/config', {
        redirectOnUnauthorized: false,
      })
    )
    expect(httpMocks.get).not.toHaveBeenCalledWith('/plugins/installed')
    expect(httpMocks.post).not.toHaveBeenCalledWith(
      '/plugins/builtin/wegent-sites/ensure-installed',
      {}
    )
  })

  it('restores the cloud connection from desktop preferences on a new local origin', async () => {
    const storedConnection = {
      backendUrl: 'https://cloud.example.com',
      apiBaseUrl: 'https://cloud.example.com/api',
      socketBaseUrl: 'wss://backend-socket.example.com',
      socketPath: '/socket.io',
      webUrl: 'https://cloud.example.com',
      user: { id: 7, user_name: 'alice', email: 'alice@example.com' },
      connectedAt: '2026-07-20T00:00:00.000Z',
    }
    await updateAppPreferences({ cloudConnection: storedConnection })
    localStorage.clear()
    httpMocks.get.mockImplementation((endpoint: string) => {
      if (endpoint === '/auth/wework/config') {
        return Promise.resolve({
          web_url: 'https://cloud.example.com',
          socket_url: 'wss://backend-socket.example.com',
        })
      }
      if (endpoint === '/users/me') return Promise.resolve(storedConnection.user)
      return Promise.reject(new Error(`Unexpected GET ${endpoint}`))
    })

    render(
      <CloudConnectionProvider>
        <CloudSocketProbe />
      </CloudConnectionProvider>
    )

    await waitFor(() =>
      expect(screen.getByTestId('cloud-connection-status')).toHaveTextContent('connected')
    )
    expect(JSON.parse(localStorage.getItem('wework.cloudConnection') || '{}')).toMatchObject({
      user: { id: 7, user_name: 'alice' },
    })
    expect(JSON.parse(localStorage.getItem('wework.cloudConnection') || '{}')).not.toHaveProperty(
      'token'
    )
  })

  it('prefers desktop connection settings over a stale renderer connection', async () => {
    const staleToken = tokenWithExp()
    saveStoredCloudConnection({
      backendUrl: 'https://stale.example.com',
      apiBaseUrl: 'https://stale.example.com/api',
      socketBaseUrl: 'wss://stale.example.com',
      socketPath: '/socket.io',
      webUrl: 'https://stale.example.com',
      credentialMode: 'legacy_access_token',
      token: staleToken,
      tokenExpiresAt: getJwtExpiry(staleToken),
      user: { id: 99, user_name: 'stale', email: 'stale@example.com' },
      connectedAt: '2026-08-27T00:00:00.000Z',
    })
    const desktopConnection = {
      backendUrl: 'http://127.0.0.1:8000',
      apiBaseUrl: 'http://127.0.0.1:8000/api',
      socketBaseUrl: 'http://127.0.0.1:8000',
      socketPath: '/socket.io',
      webUrl: 'http://127.0.0.1:3000',
      credentialMode: 'desktop_refresh' as const,
      user: { id: 2, user_name: 'local', email: 'local@example.com' },
      connectedAt: '2026-08-31T00:00:00.000Z',
    }
    await updateAppPreferences({ cloudConnection: desktopConnection })
    httpMocks.get.mockImplementation((endpoint: string) => {
      if (endpoint === '/auth/wework/config') {
        return Promise.resolve({
          web_url: 'http://127.0.0.1:3000',
          socket_url: 'http://127.0.0.1:8000',
        })
      }
      if (endpoint === '/users/me') return Promise.resolve(desktopConnection.user)
      return Promise.reject(new Error(`Unexpected GET ${endpoint}`))
    })

    render(
      <CloudConnectionProvider>
        <CloudSocketProbe />
      </CloudConnectionProvider>
    )

    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem('wework.cloudConnection') || '{}')).toMatchObject({
        backendUrl: 'http://127.0.0.1:8000',
        user: { id: 2, user_name: 'local' },
      })
      expect(screen.getByTestId('cloud-connection-status')).toHaveTextContent('connected')
    })
    expect(createHttpClient).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'http://127.0.0.1:8000/api' })
    )
    expect(createHttpClient).not.toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'https://stale.example.com/api' })
    )
  })

  it('does not restore stale desktop preferences after disconnecting', async () => {
    const storedConnection = {
      backendUrl: 'https://cloud.example.com',
      apiBaseUrl: 'https://cloud.example.com/api',
      socketBaseUrl: 'wss://backend-socket.example.com',
      socketPath: '/socket.io',
      user: { id: 7, user_name: 'alice', email: 'alice@example.com' },
      connectedAt: '2026-07-20T00:00:00.000Z',
    }
    await updateAppPreferences({ cloudConnection: storedConnection })
    saveStoredCloudConnection(storedConnection)
    httpMocks.get.mockImplementation((endpoint: string) => {
      if (endpoint === '/auth/wework/config') return Promise.resolve({})
      if (endpoint === '/users/me') return Promise.resolve(storedConnection.user)
      return Promise.reject(new Error(`Unexpected GET ${endpoint}`))
    })

    render(
      <CloudConnectionProvider>
        <CloudSocketProbe />
      </CloudConnectionProvider>
    )

    await waitFor(() =>
      expect(screen.getByTestId('cloud-connection-status')).toHaveTextContent('connected')
    )
    await userEvent.click(screen.getByTestId('disconnect-cloud-button'))

    await waitFor(() =>
      expect(screen.getByTestId('cloud-connection-status')).toHaveTextContent('disconnected')
    )
    expect(localStorage.getItem('wework.cloudConnection')).toBeNull()
    expect(credentialMocks.clear).toHaveBeenCalledTimes(1)
  })

  it('disconnects when the desktop credential bridge throws synchronously', async () => {
    saveStoredCloudConnection({
      backendUrl: 'https://cloud.example.com',
      apiBaseUrl: 'https://cloud.example.com/api',
      socketBaseUrl: 'https://cloud.example.com',
      socketPath: '/socket.io',
      user: { id: 7, user_name: 'alice', email: 'alice@example.com' },
      connectedAt: '2026-08-28T00:00:00.000Z',
    })
    credentialMocks.clear.mockImplementation(() => {
      throw new Error('Desktop cloud credential service is unavailable')
    })

    render(
      <CloudConnectionProvider>
        <CloudSocketProbe />
      </CloudConnectionProvider>
    )

    await userEvent.click(screen.getByTestId('disconnect-cloud-button'))

    expect(screen.getByTestId('cloud-connection-status')).toHaveTextContent('disconnected')
    expect(localStorage.getItem('wework.cloudConnection')).toBeNull()
  })

  it('does not reconnect when an in-flight credential refresh completes after disconnecting', async () => {
    const storedConnection = {
      backendUrl: 'https://cloud.example.com',
      apiBaseUrl: 'https://cloud.example.com/api',
      socketBaseUrl: 'wss://backend-socket.example.com',
      socketPath: '/socket.io',
      user: { id: 7, user_name: 'alice', email: 'alice@example.com' },
      connectedAt: '2026-07-20T00:00:00.000Z',
    }
    let resolveRefresh: (value: {
      accessToken: string
      tokenType: string
      expiresIn: number
    }) => void = () => undefined
    credentialMocks.refreshAccessToken.mockReturnValueOnce(
      new Promise(resolve => {
        resolveRefresh = resolve
      })
    )
    await updateAppPreferences({ cloudConnection: storedConnection })
    saveStoredCloudConnection(storedConnection)

    render(
      <CloudConnectionProvider>
        <CloudSocketProbe />
      </CloudConnectionProvider>
    )

    await waitFor(() => expect(credentialMocks.refreshAccessToken).toHaveBeenCalledTimes(1))
    await userEvent.click(screen.getByTestId('disconnect-cloud-button'))
    resolveRefresh({
      accessToken: tokenWithExp(),
      tokenType: 'bearer',
      expiresIn: 3600,
    })

    await waitFor(() =>
      expect(screen.getByTestId('cloud-connection-status')).toHaveTextContent('disconnected')
    )
    expect(httpMocks.get).not.toHaveBeenCalled()
    expect(localStorage.getItem('wework.cloudConnection')).toBeNull()
  })

  it('does not let a stale refresh callback reconnect after disconnecting', async () => {
    const storedConnection = {
      backendUrl: 'https://cloud.example.com',
      apiBaseUrl: 'https://cloud.example.com/api',
      socketBaseUrl: 'wss://backend-socket.example.com',
      socketPath: '/socket.io',
      user: { id: 7, user_name: 'alice', email: 'alice@example.com' },
      connectedAt: '2026-07-20T00:00:00.000Z',
    }
    saveStoredCloudConnection(storedConnection)

    render(
      <CloudConnectionProvider>
        <CloudSocketProbe />
      </CloudConnectionProvider>
    )

    await waitFor(() => expect(credentialMocks.refreshAccessToken).toHaveBeenCalledTimes(1))
    await userEvent.click(screen.getByTestId('disconnect-cloud-button'))
    await userEvent.click(screen.getByTestId('refresh-cloud-button'))

    expect(credentialMocks.refreshAccessToken).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('cloud-connection-status')).toHaveTextContent('disconnected')
    expect(localStorage.getItem('wework.cloudConnection')).toBeNull()
  })

  it('keeps stored connection metadata while the initial credential refresh is pending', async () => {
    vi.useFakeTimers()
    try {
      saveStoredCloudConnection({
        backendUrl: 'https://cloud.example.com',
        apiBaseUrl: 'https://cloud.example.com/api',
        socketBaseUrl: 'wss://backend-socket.example.com',
        socketPath: '/socket.io',
        webUrl: 'https://cloud.example.com',
        user: { id: 7, user_name: 'alice', email: 'alice@example.com' },
        connectedAt: '2026-07-20T00:00:00.000Z',
      })
      credentialMocks.refreshAccessToken.mockReturnValue(new Promise(() => undefined))

      render(
        <CloudConnectionProvider>
          <CloudSocketProbe />
        </CloudConnectionProvider>
      )

      expect(screen.getByTestId('cloud-connection-status')).toHaveTextContent('restoring')

      await act(async () => {
        await vi.advanceTimersByTimeAsync(8000)
      })

      expect(screen.getByTestId('cloud-connection-status')).toHaveTextContent('restoring')
      expect(JSON.parse(localStorage.getItem('wework.cloudConnection') || '{}')).not.toHaveProperty(
        'token'
      )
    } finally {
      vi.useRealTimers()
    }
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
      user: { id: 7, user_name: 'alice', email: 'alice@example.com' },
      connectedAt: '2026-07-20T00:00:00.000Z',
    })
    httpMocks.get.mockImplementation((endpoint: string) => {
      if (endpoint === '/auth/wework/config') {
        return Promise.resolve({
          web_url: 'https://cloud.example.com',
          socket_url: 'wss://backend-socket.example.com',
        })
      }
      return Promise.resolve({
        id: 7,
        user_name: 'alice',
        email: 'alice@example.com',
      })
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

  it('uses the Backend declaration when the package only configures the Backend URL', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = {
      wegentBackendUrl: 'https://cloud.example.com/api',
    }
    saveStoredCloudConnection({
      backendUrl: 'https://cloud.example.com',
      apiBaseUrl: 'https://cloud.example.com/api',
      socketBaseUrl: 'https://cloud.example.com',
      socketPath: '/socket.io',
      webUrl: 'https://cloud.example.com',
      user: { id: 7, user_name: 'alice', email: 'alice@example.com' },
      connectedAt: '2026-07-20T00:00:00.000Z',
    })
    httpMocks.get.mockImplementation((endpoint: string) => {
      if (endpoint === '/auth/wework/config') {
        return Promise.resolve({
          web_url: 'https://cloud.example.com',
          socket_url: 'wss://backend-socket.example.com',
        })
      }
      return Promise.resolve({ id: 7, user_name: 'alice', email: 'alice@example.com' })
    })

    render(
      <CloudConnectionProvider>
        <CloudSocketProbe />
      </CloudConnectionProvider>
    )

    await waitFor(() => {
      expect(screen.getByTestId('cloud-socket-base-url')).toHaveTextContent(
        'wss://backend-socket.example.com'
      )
    })
    expect(JSON.parse(localStorage.getItem('wework.cloudConnection') || '{}').socketBaseUrl).toBe(
      'wss://backend-socket.example.com'
    )
  })

  it('keeps the user Socket URL ahead of the Backend declaration', async () => {
    saveStoredCloudConnection({
      backendUrl: 'https://api.example.com',
      apiBaseUrl: 'https://api.example.com/api',
      socketBaseUrl: 'wss://user-socket.example.com',
      socketBaseUrlOverride: 'wss://user-socket.example.com',
      socketPath: '/socket.io',
      webUrl: 'https://app.example.com',
      user: { id: 7, user_name: 'alice', email: 'alice@example.com' },
      connectedAt: '2026-07-20T00:00:00.000Z',
    })
    httpMocks.get.mockImplementation((endpoint: string) => {
      if (endpoint === '/auth/wework/config') {
        return Promise.resolve({
          web_url: 'https://app.example.com',
          socket_url: 'wss://backend-socket.example.com',
        })
      }
      return Promise.resolve({ id: 7, user_name: 'alice', email: 'alice@example.com' })
    })

    render(
      <CloudConnectionProvider>
        <CloudSocketProbe />
      </CloudConnectionProvider>
    )

    await waitFor(() => {
      expect(screen.getByTestId('cloud-socket-base-url')).toHaveTextContent(
        'wss://user-socket.example.com'
      )
    })
    expect(JSON.parse(localStorage.getItem('wework.cloudConnection') || '{}').socketBaseUrl).toBe(
      'wss://user-socket.example.com'
    )
  })

  it('corrects and stores the Web URL for an existing cloud connection', async () => {
    saveStoredCloudConnection({
      backendUrl: 'https://api.example.com',
      apiBaseUrl: 'https://api.example.com/api',
      socketBaseUrl: 'https://api.example.com',
      socketPath: '/socket.io',
      webUrl: 'https://wework.example.com',
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
    const token = tokenWithExp()
    httpMocks.get.mockResolvedValueOnce({ status: 'healthy' })
    httpMocks.get.mockResolvedValueOnce({
      web_url: 'https://cloud.example.com',
      socket_url: 'wss://backend-socket.example.com',
    })
    httpMocks.post.mockResolvedValueOnce({
      session_id: 'session-1',
      poll_token: 'poll-1',
      authorize_url: 'https://cloud.example.com/auth/wework/authorize?session_id=session-1',
      web_url: 'https://cloud.example.com',
      expires_at: Math.floor(Date.now() / 1000) + 30,
      poll_interval_seconds: 0.001,
    })
    credentialMocks.claimAuthorization.mockResolvedValueOnce({
      status: 'success',
      accessToken: token,
      tokenType: 'bearer',
      username: 'alice',
      credentialMode: 'desktop_refresh',
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
    httpMocks.get.mockResolvedValueOnce({
      web_url: 'https://cloud.example.com',
      socket_url: 'wss://backend-socket.example.com',
    })
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
    expect(httpMocks.get).toHaveBeenCalledTimes(2)
  })
})
