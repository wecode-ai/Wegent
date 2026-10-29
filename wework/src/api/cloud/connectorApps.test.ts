import { subscribeOperationResults, type OperationResult } from '@/telemetry/operationBus'
import { afterEach, onTestFinished, describe, expect, test, vi } from 'vitest'
import { authorizeWegentConnector } from './connectorApps'

describe('connector OAuth client', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  test.each(['success', 'failed', 'declined'] as const)(
    'reports OAuth %s without account data and keeps cancellation silent',
    async status => {
      const results: OperationResult[] = []
      const unsubscribe = subscribeOperationResults(result => results.push(result))
      onTestFinished(unsubscribe)
      vi.useFakeTimers()
      const close = vi.fn().mockResolvedValue(undefined)
      const openAuthorization = vi.fn().mockResolvedValue({
        closed: new Promise<void>(() => undefined),
        close,
      })
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        const body = url.includes('/poll')
          ? {
              status,
              connection: {
                status: 'connected',
                external_account_name: 'octocat',
                granted_scopes: ['repo'],
                expires_at: null,
              },
            }
          : {
              session_id: 'session-id',
              poll_token: 'poll-token',
              authorize_url: 'https://github.com/login/oauth/authorize',
              expires_at: Math.floor(Date.now() / 1000) + 60,
              poll_interval_seconds: 1,
            }
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      })
      vi.stubGlobal('fetch', fetchMock)

      const authorization = authorizeWegentConnector(
        'https://backend.example.test/api',
        'cloud-token',
        'github',
        openAuthorization
      )
      const outcome = authorization.then(
        value => ({ value, error: null }),
        error => ({ value: null, error })
      )
      await vi.advanceTimersByTimeAsync(1000)
      const settled = await outcome
      if (status !== 'success') {
        expect(settled.error).toBeInstanceOf(Error)
        expect(results).toEqual(
          status === 'declined'
            ? []
            : [
                {
                  key: 'plugin.authorize',
                  outcome: 'failed',
                  failureStage: 'confirm',
                  properties: {
                    plugin_distribution: 'unknown',
                    plugin_id: 'connector/github',
                  },
                },
              ]
        )
        return
      }
      const connection = settled.value!
      expect(results).toEqual([
        {
          key: 'plugin.authorize',
          outcome: 'succeeded',
          properties: {
            plugin_distribution: 'unknown',
            plugin_id: 'connector/github',
          },
        },
      ])

      expect(connection.external_account_name).toBe('octocat')
      expect(openAuthorization).toHaveBeenCalledWith('https://github.com/login/oauth/authorize')
      expect(close).toHaveBeenCalled()
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).includes('/poll?poll_token=poll-token'))
      ).toBe(true)
    }
  )

  test('keeps polling a slow callback and resumes exactly once', async () => {
    vi.useFakeTimers()
    const close = vi.fn().mockResolvedValue(undefined)
    // The consent window stays open: closing on the callback navigation would
    // race a slow code exchange and report a cancellation.
    const openAuthorization = vi.fn().mockResolvedValue({
      closed: new Promise<void>(() => undefined),
      close,
    })
    let polls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const body = url.includes('/poll')
        ? polls++ < 3
          ? { status: 'pending' }
          : {
              status: 'success',
              connection: {
                status: 'connected',
                external_account_name: null,
                granted_scopes: [],
                expires_at: null,
              },
            }
        : {
            session_id: 'slow-session',
            poll_token: 'poll-token',
            authorize_url: 'https://provider.example/authorize',
            expires_at: Math.floor(Date.now() / 1000) + 60,
            poll_interval_seconds: 2,
          }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const authorization = authorizeWegentConnector(
      'https://backend.example.test/api',
      'cloud-token',
      'slow-connector',
      openAuthorization
    )
    // Six seconds of a still-exchanging callback at a two second poll interval.
    for (let tick = 0; tick < 4; tick += 1) {
      await vi.advanceTimersByTimeAsync(2000)
    }

    const connection = await authorization
    expect(connection.status).toBe('connected')
    expect(polls).toBe(4)
    expect(close).toHaveBeenCalledTimes(1)
  })

  test('closes the consent window when the poll request fails', async () => {
    vi.useFakeTimers()
    const close = vi.fn().mockResolvedValue(undefined)
    const openAuthorization = vi.fn().mockResolvedValue({
      closed: new Promise<void>(() => undefined),
      close,
    })
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/poll')) throw new TypeError('network down')
      return new Response(
        JSON.stringify({
          session_id: 'failing-session',
          poll_token: 'poll-token',
          authorize_url: 'https://provider.example/authorize',
          expires_at: Math.floor(Date.now() / 1000) + 60,
          poll_interval_seconds: 1,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const authorization = authorizeWegentConnector(
      'https://backend.example.test/api',
      'cloud-token',
      'slow-connector',
      openAuthorization
    )
    const outcome = authorization.catch((error: Error) => error)
    await vi.advanceTimersByTimeAsync(1000)
    const error = await outcome

    expect(error).toBeInstanceOf(Error)
    expect(close).toHaveBeenCalledTimes(1)
  })

  test('closes the consent window when the session expires', async () => {
    vi.useFakeTimers()
    const close = vi.fn().mockResolvedValue(undefined)
    const openAuthorization = vi.fn().mockResolvedValue({
      closed: new Promise<void>(() => undefined),
      close,
    })
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const body = url.includes('/poll')
        ? { status: 'pending' }
        : {
            session_id: 'expiring-session',
            poll_token: 'poll-token',
            authorize_url: 'https://provider.example/authorize',
            expires_at: Math.floor(Date.now() / 1000) + 2,
            poll_interval_seconds: 1,
          }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const authorization = authorizeWegentConnector(
      'https://backend.example.test/api',
      'cloud-token',
      'slow-connector',
      openAuthorization
    )
    const outcome = authorization.catch((error: Error) => error)
    for (let tick = 0; tick < 4; tick += 1) {
      await vi.advanceTimersByTimeAsync(1000)
    }
    const error = await outcome

    expect(error).toBeInstanceOf(Error)
    expect(String((error as Error).message)).toContain('超时')
    expect(close).toHaveBeenCalledTimes(1)
  })
})
