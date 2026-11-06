import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHttpClient } from '@/api/http'
import { updateAppPreferences } from '@/desktop/appPreferences'
import * as appPreferences from '@/desktop/appPreferences'
import { DesktopCloudCredentialError } from '@/desktop/cloudCredentials'
import type {
  CloudConnectionContextValue,
  OpenCloudAuthorizationUrl,
} from './CloudConnectionContext'
import type { User } from '@/types/api'
import { CloudConnectionProvider } from './CloudConnectionProvider'
import {
  getJwtExpiry,
  readStoredCloudConnection,
  saveStoredCloudConnection,
} from './cloudConnectionStorage'
import { useCloudConnection } from './useCloudConnection'

const httpMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}))

const credentialMocks = vi.hoisted(() => ({
  prepareAuthorization: vi.fn(),
  commitAuthorization: vi.fn(),
  discardAuthorization: vi.fn(),
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
    prepareDesktopCloudAuthorization: credentialMocks.prepareAuthorization,
    commitDesktopCloudAuthorization: credentialMocks.commitAuthorization,
    discardDesktopCloudAuthorization: credentialMocks.discardAuthorization,
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

function CloudSnapshotProbe({
  observe,
}: {
  observe: (snapshot: CloudConnectionContextValue) => void
}) {
  const cloud = useCloudConnection()
  useEffect(() => observe(cloud), [cloud, observe])
  return null
}

async function observeConnectedOwner() {
  const owner = {
    backendUrl: 'https://owner-a.example.com',
    apiBaseUrl: 'https://owner-a.example.com/api',
    socketBaseUrl: 'wss://owner-a.example.com',
    socketPath: '/socket.io',
    webUrl: 'https://owner-a.example.com',
    credentialMode: 'legacy_access_token' as const,
    token: tokenWithExp(),
    user: { id: 7, user_name: 'alice', email: 'alice@example.com' },
    connectedAt: '2026-08-28T00:00:00.000Z',
  }
  saveStoredCloudConnection(owner)
  httpMocks.get.mockImplementation((endpoint: string) => {
    if (endpoint === '/auth/wework/config') {
      return Promise.resolve({ web_url: owner.webUrl, socket_url: owner.socketBaseUrl })
    }
    if (endpoint === '/users/me') return Promise.resolve(owner.user)
    return Promise.reject(new Error(`Unexpected GET ${endpoint}`))
  })
  const observe = vi.fn<(snapshot: CloudConnectionContextValue) => void>()
  render(
    <CloudConnectionProvider>
      <CloudSnapshotProbe observe={observe} />
    </CloudConnectionProvider>
  )
  await waitFor(() =>
    expect(httpMocks.get).toHaveBeenCalledWith('/users/me', { redirectOnUnauthorized: false })
  )
  const read = () => observe.mock.lastCall![0]
  await waitFor(() => expect(read().status).toBe('connected'))
  return { owner, observe, read }
}

function mockCandidateAuthSession() {
  httpMocks.post.mockResolvedValueOnce({
    session_id: 'candidate-session',
    poll_token: 'candidate-poll',
    authorize_url: 'https://owner-b.example.com/auth/wework/authorize',
    web_url: 'https://owner-b.example.com',
    expires_at: Math.floor(Date.now() / 1000) + 30,
    poll_interval_seconds: 0.001,
  })
}

describe('CloudConnectionProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    credentialMocks.prepareAuthorization.mockResolvedValue({
      authorizationId: 'authorization-id',
      publicKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
    })
    credentialMocks.commitAuthorization.mockResolvedValue(undefined)
    credentialMocks.discardAuthorization.mockResolvedValue(undefined)
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
    delete window.weworkElectronLifecycle
    vi.restoreAllMocks()
  })

  describe('connection owner publication', () => {
    afterEach(() => {
      httpMocks.get.mockReset()
      httpMocks.post.mockReset()
      credentialMocks.claimAuthorization.mockReset()
    })

    function candidateEndpoints(user: User) {
      httpMocks.get.mockImplementation((endpoint: string) => {
        if (endpoint === '/health') return Promise.resolve({ status: 'healthy' })
        if (endpoint === '/auth/wework/config')
          return Promise.resolve({ web_url: 'https://candidate.example.com' })
        if (endpoint === '/users/me') return Promise.resolve(user)
        return Promise.reject(new Error(`Unexpected GET ${endpoint}`))
      })
      mockCandidateAuthSession()
      credentialMocks.claimAuthorization.mockResolvedValue({
        status: 'success',
        accessToken: tokenWithExp(),
        credentialMode: 'desktop_refresh',
      })
    }

    it('does not let delayed desktop restore replace the active owner after a candidate starts', async () => {
      const owner = {
        backendUrl: 'https://active.example.com',
        apiBaseUrl: 'https://active.example.com/api',
        socketBaseUrl: 'https://active.example.com',
        socketPath: '/socket.io',
        credentialMode: 'legacy_access_token' as const,
        token: tokenWithExp(),
        user: { id: 7, user_name: 'active', email: 'active@example.com' },
        connectedAt: '2026-08-28T00:00:00Z',
      }
      saveStoredCloudConnection(owner)
      let finishRestore!: (value: appPreferences.AppPreferences) => void
      vi.spyOn(appPreferences, 'getAppPreferences').mockImplementationOnce(
        () => new Promise(resolve => (finishRestore = resolve))
      )
      let failHealth!: (error: Error) => void
      httpMocks.get.mockImplementation((endpoint: string) => {
        if (endpoint === '/health') return new Promise((_, reject) => (failHealth = reject))
        if (endpoint === '/auth/wework/config')
          return Promise.resolve({ web_url: owner.backendUrl })
        if (endpoint === '/users/me') return Promise.resolve(owner.user)
        return Promise.reject(new Error(`Unexpected GET ${endpoint}`))
      })
      const observe = vi.fn<(snapshot: CloudConnectionContextValue) => void>()
      render(
        <CloudConnectionProvider>
          <CloudSnapshotProbe observe={observe} />
        </CloudConnectionProvider>
      )
      await waitFor(() => expect(observe.mock.lastCall?.[0].isConnected).toBe(true))
      const read = () => observe.mock.lastCall![0]
      let candidate!: Promise<unknown>
      act(() => {
        candidate = read()
          .connectWithAuthorization('https://candidate.example.com')
          .catch(error => error)
      })
      await waitFor(() => expect(failHealth).toBeDefined())
      await act(async () => {
        finishRestore({
          ...appPreferences.defaultAppPreferences,
          cloudConnection: { ...owner, user: { id: 99, user_name: 'stale', email: '' } },
        })
      })
      expect(read().user).toEqual(owner.user)
      expect(readStoredCloudConnection()?.user).toEqual(owner.user)
      await act(async () => {
        failHealth(new Error('Candidate failed'))
        await candidate
      })
      expect(observe.mock.calls.every(([snapshot]) => snapshot.user?.id === 7)).toBe(true)
    })

    it('discards staged credentials when candidate user validation fails', async () => {
      const { owner, read } = await observeConnectedOwner()
      candidateEndpoints(owner.user)
      httpMocks.get.mockImplementation((endpoint: string) => {
        if (endpoint === '/health') return Promise.resolve({ status: 'healthy' })
        if (endpoint === '/auth/wework/config')
          return Promise.resolve({ web_url: 'https://candidate.example.com' })
        return Promise.reject(new Error('Candidate user validation failed'))
      })
      await act(async () => {
        await expect(
          read().connectWithAuthorization('https://candidate.example.com')
        ).rejects.toThrow('Candidate user validation failed')
      })
      expect(credentialMocks.commitAuthorization).not.toHaveBeenCalled()
      expect(credentialMocks.discardAuthorization).toHaveBeenCalledWith('authorization-id')
      expect(read()).toMatchObject({ ...owner, status: 'connected', isConnected: true })
    })

    it.each(['failed-candidate', 'newer-commit', 'disconnect-reconnect'] as const)(
      'preserves native commit ordering when its acknowledgement overlaps %s',
      async overlap => {
        const { read } = await observeConnectedOwner()
        const firstUser: User = { id: 8, user_name: 'bob', email: 'bob@example.com' }
        const secondUser: User = { id: 9, user_name: 'carol', email: 'carol@example.com' }
        credentialMocks.prepareAuthorization
          .mockResolvedValueOnce({ authorizationId: 'first', publicKey: {} })
          .mockResolvedValueOnce({ authorizationId: 'second', publicKey: {} })
        const acknowledgements = new Map<string, () => void>()
        credentialMocks.commitAuthorization.mockImplementation(
          (id: string) => new Promise<void>(resolve => acknowledgements.set(id, resolve))
        )
        candidateEndpoints(firstUser)
        let first!: Promise<User | Error>
        act(() => {
          first = read()
            .connectWithAuthorization('https://candidate.example.com')
            .catch(error => error)
        })
        await waitFor(() => expect(acknowledgements.has('first')).toBe(true))
        await act(async () => expect(await read().refreshUser()).toBeNull())
        if (overlap === 'disconnect-reconnect') act(() => read().disconnect())
        candidateEndpoints(secondUser)
        if (overlap === 'failed-candidate') {
          httpMocks.get.mockRejectedValueOnce(new Error('Second candidate failed'))
        }
        let second!: Promise<User | Error>
        act(() => {
          second = read()
            .connectWithAuthorization('https://candidate.example.com')
            .catch(error => error)
        })
        if (overlap === 'failed-candidate') {
          await act(async () => expect(await second).toBeInstanceOf(Error))
        } else {
          await waitFor(() => expect(acknowledgements.has('second')).toBe(true))
          await act(async () => {
            acknowledgements.get('second')!()
            expect(await second).toEqual(secondUser)
          })
          expect(read().user).toEqual(secondUser)
        }
        await act(async () => {
          acknowledgements.get('first')!()
          const result = await first
          if (overlap === 'disconnect-reconnect')
            expect(result).toMatchObject({ message: 'Cloud connection was cancelled' })
          else expect(result).toEqual(firstUser)
        })
        expect(read()).toMatchObject({
          status: 'connected',
          user: overlap === 'failed-candidate' ? firstUser : secondUser,
        })
        expect(readStoredCloudConnection()?.user).toEqual(
          overlap === 'failed-candidate' ? firstUser : secondUser
        )
      }
    )

    it('publishes a committed owner when React batches its acknowledgement with a later failed commit', async () => {
      const { read } = await observeConnectedOwner()
      const firstUser: User = { id: 8, user_name: 'bob', email: 'bob@example.com' }
      const secondUser: User = { id: 9, user_name: 'carol', email: 'carol@example.com' }
      let acknowledgeFirst!: () => void
      let rejectSecond!: (error: Error) => void
      let commitRequested!: () => void
      const secondCommitRequested = new Promise<void>(resolve => (commitRequested = resolve))
      credentialMocks.commitAuthorization
        .mockImplementationOnce(() => new Promise<void>(resolve => (acknowledgeFirst = resolve)))
        .mockImplementationOnce(
          () =>
            new Promise<void>((_, reject) => {
              rejectSecond = reject
              commitRequested()
            })
        )
      candidateEndpoints(firstUser)
      let first!: Promise<User>
      act(() => {
        first = read().connectWithAuthorization('https://candidate.example.com')
      })
      await waitFor(() => expect(acknowledgeFirst).toBeDefined())
      candidateEndpoints(secondUser)
      const fallback = httpMocks.get.getMockImplementation()!
      let userRequested!: () => void
      const secondUserRequested = new Promise<void>(resolve => (userRequested = resolve))
      let releaseUser!: (user: User) => void
      const userResponse = new Promise<User>(resolve => (releaseUser = resolve))
      httpMocks.get.mockImplementation((endpoint: string) => {
        if (endpoint !== '/users/me') return fallback(endpoint)
        userRequested()
        return userResponse
      })
      let second!: Promise<unknown>
      await act(async () => {
        // Keep the committed owner update in the same React batch as the next
        // commit attempt without flushing it through nested waitFor calls.
        second = read()
          .connectWithAuthorization('https://candidate.example.com')
          .catch(error => error)
        await secondUserRequested
        acknowledgeFirst()
        await first
        releaseUser(secondUser)
        await secondCommitRequested
        rejectSecond(new Error('Newer native commit failed'))
        expect(await second).toBeInstanceOf(Error)
      })
      expect(read().user).toEqual(firstUser)
      expect(readStoredCloudConnection()?.user).toEqual(firstUser)
    })

    it('keeps an empty owner while an unreachable candidate connects and fails', async () => {
      let rejectHealth!: (error: Error) => void
      httpMocks.get.mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectHealth = reject
          })
      )
      const observe = vi.fn<(snapshot: CloudConnectionContextValue) => void>()
      render(
        <CloudConnectionProvider>
          <CloudSnapshotProbe observe={observe} />
        </CloudConnectionProvider>
      )
      const read = () => observe.mock.lastCall![0]
      let pending!: Promise<unknown>
      act(() => {
        pending = read()
          .connectWithAuthorization('https://unreachable.example.com')
          .catch(error => error)
      })
      await waitFor(() => expect(rejectHealth).toBeDefined())
      const connecting = read()
      await act(async () => {
        rejectHealth(new Error('Backend unavailable'))
        await pending
      })

      expect(connecting.status).toBe('connecting')
      expect(read().status).toBe('error')
      expect(read().error).toContain('健康检查失败')
      for (const [snapshot] of observe.mock.calls) {
        expect(snapshot.backendUrl).toBeUndefined()
        expect(snapshot.apiBaseUrl).toBeUndefined()
        expect(snapshot.socketBaseUrl).toBeUndefined()
        expect(snapshot.user).toBeNull()
        expect(snapshot.token).toBeNull()
      }
    })

    it('publishes a candidate backend and its authenticated user together after authorization', async () => {
      const { owner, observe, read } = await observeConnectedOwner()
      const nextUser: User = { id: 8, user_name: 'bob', email: 'bob@example.com' }
      const nextToken = tokenWithExp(Math.floor(Date.now() / 1000) + 7200)
      let resolveClaim!: (result: unknown) => void
      let resolveUser!: (user: User) => void
      credentialMocks.claimAuthorization.mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveClaim = resolve
          })
      )
      httpMocks.get.mockImplementation((endpoint: string) => {
        if (endpoint === '/health') return Promise.resolve({ status: 'healthy' })
        if (endpoint === '/auth/wework/config') {
          return Promise.resolve({
            web_url: 'https://owner-b.example.com',
            socket_url: 'wss://owner-b.example.com',
          })
        }
        if (endpoint === '/users/me') {
          return new Promise<User>(resolve => {
            resolveUser = resolve
          })
        }
        return Promise.reject(new Error(`Unexpected GET ${endpoint}`))
      })
      mockCandidateAuthSession()
      let pending!: Promise<unknown>
      act(() => {
        pending = read().connectWithAuthorization('https://owner-b.example.com')
      })
      await waitFor(() => expect(resolveClaim).toBeDefined())
      const authorizing = read()
      await act(async () => {
        resolveClaim({ status: 'success', accessToken: nextToken })
      })
      await waitFor(() => expect(resolveUser).toBeDefined())
      const authenticating = read()
      await act(async () => {
        resolveUser(nextUser)
        await pending
      })

      for (const snapshot of [authorizing, authenticating]) {
        expect(snapshot.status).toBe('connected')
        expect(snapshot.isConnected).toBe(true)
        expect(snapshot).toMatchObject(owner)
      }
      expect(read()).toMatchObject({
        status: 'connected',
        apiBaseUrl: 'https://owner-b.example.com/api',
        socketBaseUrl: 'wss://owner-b.example.com',
        token: nextToken,
        user: nextUser,
      })
      for (const [snapshot] of observe.mock.calls) {
        if (snapshot.apiBaseUrl === 'https://owner-b.example.com/api') {
          expect(snapshot.user).toEqual(nextUser)
          expect(snapshot.token).toBe(nextToken)
        }
      }
    })

    it('retains the previous owner and services after candidate authorization fails', async () => {
      const { owner, observe, read } = await observeConnectedOwner()
      let rejectClaim!: (error: Error) => void
      credentialMocks.claimAuthorization.mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectClaim = reject
          })
      )
      httpMocks.get.mockImplementation((endpoint: string) => {
        if (endpoint === '/health') return Promise.resolve({ status: 'healthy' })
        if (endpoint === '/auth/wework/config') {
          return Promise.resolve({
            web_url: 'https://owner-b.example.com',
            socket_url: 'wss://owner-b.example.com',
          })
        }
        return Promise.reject(new Error(`Unexpected GET ${endpoint}`))
      })
      mockCandidateAuthSession()
      let pending!: Promise<unknown>
      act(() => {
        pending = read()
          .connectWithAuthorization('https://owner-b.example.com')
          .catch(error => error)
      })
      await waitFor(() => expect(rejectClaim).toBeDefined())
      await act(async () => {
        rejectClaim(new Error('Authorization failed'))
        await pending
      })

      expect(read()).toMatchObject({
        ...owner,
        status: 'connected',
        isConnected: true,
      })
      expect(read().error).toBeNull()
      expect(readStoredCloudConnection()).toMatchObject(owner)
      expect(
        observe.mock.calls.every(([snapshot]) => snapshot.apiBaseUrl === owner.apiBaseUrl)
      ).toBe(true)
    })

    it('invalidates an old owner refresh when a candidate commits', async () => {
      const { owner, read } = await observeConnectedOwner()
      const nextUser: User = { id: 8, user_name: 'bob', email: 'bob@example.com' }
      let resolveOldRefresh!: (user: User) => void
      httpMocks.get.mockImplementation((endpoint: string) => {
        if (endpoint === '/users/me')
          return new Promise<User>(resolve => {
            resolveOldRefresh = resolve
          })
        return Promise.reject(new Error(`Unexpected GET ${endpoint}`))
      })
      let oldRefresh!: Promise<User | null>
      act(() => {
        oldRefresh = read().refreshUser()
      })
      await waitFor(() => expect(resolveOldRefresh).toBeDefined())
      httpMocks.get.mockImplementation((endpoint: string) => {
        if (endpoint === '/health') return Promise.resolve({ status: 'healthy' })
        if (endpoint === '/auth/wework/config')
          return Promise.resolve({ web_url: 'https://owner-b.example.com' })
        if (endpoint === '/users/me') return Promise.resolve(nextUser)
        return Promise.reject(new Error(`Unexpected GET ${endpoint}`))
      })
      mockCandidateAuthSession()
      credentialMocks.claimAuthorization.mockResolvedValueOnce({
        status: 'success',
        accessToken: tokenWithExp(Math.floor(Date.now() / 1000) + 7200),
      })
      await act(async () => {
        await read().connectWithAuthorization('https://owner-b.example.com')
        resolveOldRefresh(owner.user)
        expect(await oldRefresh).toBeNull()
      })
      expect(read()).toMatchObject({
        status: 'connected',
        isConnected: true,
        apiBaseUrl: 'https://owner-b.example.com/api',
        user: nextUser,
      })
    })

    it('does not open a superseded authorization window after its session request finishes', async () => {
      const { read } = await observeConnectedOwner()
      const session = {
        session_id: 'stale-session',
        poll_token: 'stale-poll',
        authorize_url: 'https://owner-b.example.com/authorize',
        web_url: 'https://owner-b.example.com',
        expires_at: Math.floor(Date.now() / 1000) + 30,
        poll_interval_seconds: 0.001,
      }
      let resolveSession!: (value: typeof session) => void
      httpMocks.get.mockImplementation((endpoint: string) => {
        if (endpoint === '/health') return Promise.resolve({ status: 'healthy' })
        if (endpoint === '/auth/wework/config')
          return Promise.resolve({ web_url: 'https://owner-b.example.com' })
        return Promise.reject(new Error(`Unexpected GET ${endpoint}`))
      })
      httpMocks.post.mockImplementationOnce(
        () => new Promise(resolve => (resolveSession = resolve))
      )
      const open = vi.fn()
      let request!: Promise<unknown>
      act(() => {
        request = read()
          .connectWithAuthorization('https://owner-b.example.com', open)
          .catch(error => error)
      })
      await waitFor(() => expect(resolveSession).toBeDefined())
      act(() => read().disconnect())
      await act(async () => {
        resolveSession(session)
        expect(await request).toMatchObject({ message: 'Cloud connection was cancelled' })
      })
      expect(open).not.toHaveBeenCalled()
      expect(read().status).toBe('disconnected')
      expect(read().isConnected).toBe(false)
    })
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

  it('preserves the resolved socket endpoint while refreshing restored cloud metadata', async () => {
    const connection = {
      backendUrl: 'https://cloud.example.com',
      apiBaseUrl: 'https://cloud.example.com/api',
      socketBaseUrl: 'wss://backend-socket.example.com',
      socketPath: '/socket.io',
      webUrl: 'https://cloud.example.com',
      user: { id: 7, user_name: 'alice', email: 'alice@example.com' },
      connectedAt: '2026-07-20T00:00:00.000Z',
    }
    saveStoredCloudConnection(connection)
    await updateAppPreferences({ cloudConnection: connection })
    let resolveMetadata!: (value: { web_url: string; socket_url: string }) => void
    httpMocks.get.mockImplementation((endpoint: string) => {
      if (endpoint === '/auth/wework/config') {
        return new Promise(resolve => {
          resolveMetadata = resolve
        })
      }
      if (endpoint === '/users/me') return Promise.resolve(connection.user)
      return Promise.reject(new Error(`Unexpected GET ${endpoint}`))
    })
    render(
      <CloudConnectionProvider>
        <CloudSocketProbe />
      </CloudConnectionProvider>
    )
    await waitFor(() => expect(resolveMetadata).toBeDefined())
    expect(screen.getByTestId('cloud-socket-base-url')).toHaveTextContent(connection.socketBaseUrl)
    await act(async () =>
      resolveMetadata({
        web_url: connection.webUrl,
        socket_url: connection.socketBaseUrl,
      })
    )
    expect(screen.getByTestId('cloud-socket-base-url')).toHaveTextContent(connection.socketBaseUrl)
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

  it('recovers when desktop credentials become available after the initial refresh fails', async () => {
    const storedConnection = {
      backendUrl: 'https://cloud.example.com',
      apiBaseUrl: 'https://cloud.example.com/api',
      socketBaseUrl: 'wss://backend-socket.example.com',
      socketPath: '/socket.io',
      webUrl: 'https://cloud.example.com',
      credentialMode: 'desktop_refresh' as const,
      user: { id: 7, user_name: 'alice', email: 'alice@example.com' },
      connectedAt: '2026-07-20T00:00:00.000Z',
    }
    saveStoredCloudConnection(storedConnection)
    credentialMocks.refreshAccessToken
      .mockRejectedValueOnce(
        new DesktopCloudCredentialError(
          'credentials_unavailable',
          'Desktop cloud credentials are unavailable',
          null
        )
      )
      .mockResolvedValueOnce({
        accessToken: tokenWithExp(),
        tokenType: 'bearer',
        expiresIn: 3600,
      })
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
      expect(screen.getByTestId('cloud-connection-status')).toHaveTextContent('error')
    )

    window.dispatchEvent(new Event('online'))

    await waitFor(() =>
      expect(screen.getByTestId('cloud-connection-status')).toHaveTextContent('connected')
    )
    expect(credentialMocks.refreshAccessToken).toHaveBeenCalledTimes(2)
  })

  it('periodically retries a transient desktop credential refresh failure', async () => {
    vi.useFakeTimers()
    try {
      const storedConnection = {
        backendUrl: 'https://cloud.example.com',
        apiBaseUrl: 'https://cloud.example.com/api',
        socketBaseUrl: 'wss://backend-socket.example.com',
        socketPath: '/socket.io',
        webUrl: 'https://cloud.example.com',
        credentialMode: 'desktop_refresh' as const,
        user: { id: 7, user_name: 'alice', email: 'alice@example.com' },
        connectedAt: '2026-07-20T00:00:00.000Z',
      }
      saveStoredCloudConnection(storedConnection)
      credentialMocks.refreshAccessToken
        .mockRejectedValueOnce(new Error('network unavailable'))
        .mockResolvedValueOnce({
          accessToken: tokenWithExp(),
          tokenType: 'bearer',
          expiresIn: 3600,
        })
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

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(screen.getByTestId('cloud-connection-status')).toHaveTextContent('error')
      expect(credentialMocks.refreshAccessToken).toHaveBeenCalledTimes(1)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })

      expect(screen.getByTestId('cloud-connection-status')).toHaveTextContent('connected')
      expect(credentialMocks.refreshAccessToken).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not retry a terminal desktop credential expiry', async () => {
    saveStoredCloudConnection({
      backendUrl: 'https://cloud.example.com',
      apiBaseUrl: 'https://cloud.example.com/api',
      socketBaseUrl: 'wss://backend-socket.example.com',
      socketPath: '/socket.io',
      webUrl: 'https://cloud.example.com',
      credentialMode: 'desktop_refresh',
      user: { id: 7, user_name: 'alice', email: 'alice@example.com' },
      connectedAt: '2026-07-20T00:00:00.000Z',
    })
    credentialMocks.refreshAccessToken.mockRejectedValue(
      new DesktopCloudCredentialError('cloud_auth_expired', 'Refresh token expired', 401)
    )

    render(
      <CloudConnectionProvider>
        <CloudSocketProbe />
      </CloudConnectionProvider>
    )

    await waitFor(() =>
      expect(screen.getByTestId('cloud-connection-status')).toHaveTextContent('expired')
    )

    window.dispatchEvent(new Event('online'))

    await act(async () => {
      await Promise.resolve()
    })
    expect(credentialMocks.refreshAccessToken).toHaveBeenCalledTimes(1)
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

  it.each(['legacy_access_token', 'desktop_refresh'] as const)(
    'keeps loopback for a local Backend with %s credentials when it advertises its same-port LAN socket',
    async credentialMode => {
      saveStoredCloudConnection({
        backendUrl: 'http://127.0.0.1:8000',
        apiBaseUrl: 'http://127.0.0.1:8000/api',
        socketBaseUrl: 'http://127.0.0.1:8000',
        socketPath: '/socket.io',
        credentialMode,
        token: credentialMode === 'legacy_access_token' ? tokenWithExp() : undefined,
        user: { id: 2, user_name: 'local', email: 'local@example.com' },
        connectedAt: '2026-09-30T00:00:00.000Z',
      })
      httpMocks.get.mockImplementation((endpoint: string) => {
        if (endpoint === '/auth/wework/config') {
          return Promise.resolve({
            web_url: 'http://127.0.0.1:3000',
            socket_url: 'http://192.168.31.132:8000',
          })
        }
        return Promise.resolve({ id: 2, user_name: 'local', email: 'local@example.com' })
      })

      render(
        <CloudConnectionProvider>
          <CloudSocketProbe />
        </CloudConnectionProvider>
      )

      await waitFor(() => {
        expect(screen.getByTestId('cloud-connection-status')).toHaveTextContent('connected')
        expect(screen.getByTestId('cloud-web-url')).toHaveTextContent('http://127.0.0.1:3000')
        expect(
          JSON.parse(localStorage.getItem('wework.cloudConnection') || '{}').socketBaseUrl
        ).toBe('http://127.0.0.1:8000')
      })
      if (credentialMode === 'desktop_refresh') {
        expect(credentialMocks.refreshAccessToken).toHaveBeenCalledWith(
          'http://127.0.0.1:8000/api',
          2
        )
      } else {
        expect(credentialMocks.refreshAccessToken).not.toHaveBeenCalled()
      }
    }
  )

  it('preserves an explicit Socket override for a local Backend', async () => {
    saveStoredCloudConnection({
      backendUrl: 'http://127.0.0.1:8000',
      apiBaseUrl: 'http://127.0.0.1:8000/api',
      socketBaseUrl: 'ws://192.168.31.132:8000',
      socketBaseUrlOverride: 'ws://192.168.31.132:8000',
      socketPath: '/socket.io',
      user: { id: 2, user_name: 'local', email: 'local@example.com' },
      connectedAt: '2026-09-30T00:00:00.000Z',
    })
    httpMocks.get.mockImplementation((endpoint: string) => {
      if (endpoint === '/auth/wework/config') {
        return Promise.resolve({
          web_url: 'http://127.0.0.1:3000',
          socket_url: 'http://192.168.31.132:8000',
        })
      }
      return Promise.resolve({ id: 2, user_name: 'local', email: 'local@example.com' })
    })

    render(
      <CloudConnectionProvider>
        <CloudSocketProbe />
      </CloudConnectionProvider>
    )

    await waitFor(() => {
      expect(screen.getByTestId('cloud-web-url')).toHaveTextContent('http://127.0.0.1:3000')
      expect(screen.getByTestId('cloud-socket-base-url')).toHaveTextContent(
        'ws://192.168.31.132:8000'
      )
    })
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
