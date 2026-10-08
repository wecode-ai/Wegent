/**
 * Regression coverage for the desktop access-token refresh getting stuck.
 *
 * A sleep or a dead network path can leave the refresh request unanswered. The
 * provider owns the "one refresh in flight" guard, so an unanswered request
 * previously disabled every later trigger (expiry timer, system resume,
 * `online`, retry interval) and kept sending an expired token until the
 * workbench page was reloaded.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CloudConnectionProvider } from './CloudConnectionProvider'
import { saveStoredCloudConnection } from './cloudConnectionStorage'
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

const STORED_CONNECTION = {
  backendUrl: 'https://cloud.example.com',
  apiBaseUrl: 'https://cloud.example.com/api',
  socketBaseUrl: 'wss://backend-socket.example.com',
  socketPath: '/socket.io',
  webUrl: 'https://cloud.example.com',
  credentialMode: 'desktop_refresh' as const,
  user: { id: 7, user_name: 'alice', email: 'alice@example.com' },
  connectedAt: '2026-07-20T00:00:00.000Z',
}

type RefreshedToken = { accessToken: string; tokenType: string; expiresIn: number }

function tokenExpiringIn(seconds: number): string {
  const exp = Math.floor(Date.now() / 1000) + seconds
  return `header.${btoa(JSON.stringify({ exp })).replace(/=/g, '')}.sig`
}

function refreshedToken(seconds: number): RefreshedToken {
  return { accessToken: tokenExpiringIn(seconds), tokenType: 'bearer', expiresIn: seconds }
}

function CloudRefreshProbe() {
  const cloud = useCloudConnection()
  return (
    <>
      <span data-testid="cloud-connection-status">{cloud.status}</span>
      <span data-testid="cloud-connection-token">{cloud.token ?? ''}</span>
      <span data-testid="cloud-connection-error">{cloud.error ?? ''}</span>
      <button
        type="button"
        data-testid="reconnect-cloud-button"
        onClick={() => {
          void cloud.connectWithAuthorization('https://cloud.example.com', vi.fn())
        }}
      >
        reconnect
      </button>
    </>
  )
}

function stubCloudHttpEndpoints() {
  httpMocks.get.mockImplementation((endpoint: string) => {
    if (endpoint === '/health') return Promise.resolve({ status: 'healthy' })
    if (endpoint === '/auth/wework/config') {
      return Promise.resolve({
        web_url: 'https://cloud.example.com',
        socket_url: 'wss://backend-socket.example.com',
      })
    }
    if (endpoint === '/users/me') return Promise.resolve(STORED_CONNECTION.user)
    return Promise.reject(new Error(`Unexpected GET ${endpoint}`))
  })
}

describe('cloud connection refresh recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    credentialMocks.getDevicePublicKey.mockResolvedValue({
      kty: 'EC',
      crv: 'P-256',
      x: 'x',
      y: 'y',
    })
    credentialMocks.refreshAccessToken.mockImplementation(() =>
      Promise.resolve(refreshedToken(3600))
    )
    credentialMocks.clear.mockResolvedValue(undefined)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    delete window.weworkElectronLifecycle
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('releases the refresh guard when a request stops responding and recovers afterwards', async () => {
    vi.useFakeTimers()
    const liveToken = tokenExpiringIn(3600)
    const recoveredToken = tokenExpiringIn(5400)
    saveStoredCloudConnection(STORED_CONNECTION)
    stubCloudHttpEndpoints()
    credentialMocks.refreshAccessToken
      .mockResolvedValueOnce({ accessToken: liveToken, tokenType: 'bearer', expiresIn: 3600 })
      // The refresh that fires just before expiry never answers, which is what
      // a request suspended by machine sleep or a dead network path looks like.
      .mockReturnValueOnce(new Promise(() => undefined))
      .mockResolvedValue({ accessToken: recoveredToken, tokenType: 'bearer', expiresIn: 5400 })

    render(
      <CloudConnectionProvider>
        <CloudRefreshProbe />
      </CloudConnectionProvider>
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByTestId('cloud-connection-status')).toHaveTextContent('connected')
    expect(credentialMocks.refreshAccessToken).toHaveBeenCalledTimes(1)

    // The expiry timer fires five minutes before the token expires.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3300_000)
    })
    expect(credentialMocks.refreshAccessToken).toHaveBeenCalledTimes(2)

    // The unanswered request is bounded instead of holding the guard forever.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(46_000)
    })
    expect(credentialMocks.refreshAccessToken).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('cloud-connection-error')).toHaveTextContent('45s 未返回')

    // Once the network works again the scheduled retry picks up a fresh token.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(credentialMocks.refreshAccessToken).toHaveBeenCalledTimes(3)
    expect(screen.getByTestId('cloud-connection-status')).toHaveTextContent('connected')
    expect(screen.getByTestId('cloud-connection-token')).toHaveTextContent(recoveredToken)
    expect(screen.getByTestId('cloud-connection-error')).toHaveTextContent('')
  })

  it('refreshes again on system resume after an unanswered request timed out', async () => {
    vi.useFakeTimers()
    const liveToken = tokenExpiringIn(3600)
    let resumeListener: (() => void) | undefined
    window.weworkElectronLifecycle = {
      onSystemResume: listener => {
        resumeListener = listener
        return () => undefined
      },
    }
    saveStoredCloudConnection(STORED_CONNECTION)
    stubCloudHttpEndpoints()
    credentialMocks.refreshAccessToken
      .mockResolvedValueOnce({ accessToken: liveToken, tokenType: 'bearer', expiresIn: 3600 })
      .mockReturnValueOnce(new Promise(() => undefined))
      .mockResolvedValue(refreshedToken(5400))

    render(
      <CloudConnectionProvider>
        <CloudRefreshProbe />
      </CloudConnectionProvider>
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3300_000)
    })
    expect(credentialMocks.refreshAccessToken).toHaveBeenCalledTimes(2)

    // The unanswered request times out while the machine is asleep.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(46_000)
    })
    // Waking up triggers another attempt instead of reusing the dead request.
    await act(async () => {
      resumeListener?.()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(credentialMocks.refreshAccessToken).toHaveBeenCalledTimes(3)
    expect(screen.getByTestId('cloud-connection-status')).toHaveTextContent('connected')
  })

  it('does not lose the refresh guard when a reconnect lands mid-refresh', async () => {
    vi.useFakeTimers()
    let settleInitialRefresh: (value: RefreshedToken) => void = () => undefined
    credentialMocks.refreshAccessToken
      .mockReturnValueOnce(
        new Promise<RefreshedToken>(resolve => {
          settleInitialRefresh = resolve
        })
      )
      .mockResolvedValue(refreshedToken(3600))
    saveStoredCloudConnection(STORED_CONNECTION)
    stubCloudHttpEndpoints()
    httpMocks.post.mockResolvedValue({
      session_id: 'session-1',
      poll_token: 'poll-1',
      authorize_url: 'https://cloud.example.com/auth/wework/authorize?session_id=session-1',
      web_url: 'https://cloud.example.com',
      expires_at: Math.floor(Date.now() / 1000) + 30,
      poll_interval_seconds: 0.001,
    })
    credentialMocks.claimAuthorization.mockResolvedValue({
      status: 'success',
      accessToken: tokenExpiringIn(3600),
      tokenType: 'bearer',
      username: 'alice',
      credentialMode: 'desktop_refresh',
    })

    render(
      <CloudConnectionProvider>
        <CloudRefreshProbe />
      </CloudConnectionProvider>
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(credentialMocks.refreshAccessToken).toHaveBeenCalledTimes(1)

    // A manual reconnect while the initial refresh is still in flight bumps the
    // generation counter; the settled refresh then cannot clear the guard.
    await act(async () => {
      fireEvent.click(screen.getByTestId('reconnect-cloud-button'))
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(screen.getByTestId('cloud-connection-status')).toHaveTextContent('connected')

    await act(async () => {
      settleInitialRefresh(refreshedToken(3600))
      await vi.advanceTimersByTimeAsync(0)
    })
    await act(async () => {
      window.dispatchEvent(new Event('online'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(credentialMocks.refreshAccessToken).toHaveBeenCalledTimes(2)
  })
})
