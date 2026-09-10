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
            : [{ key: 'plugin.authorize', outcome: 'failed', failureStage: 'request' }]
        )
        return
      }
      const connection = settled.value!
      expect(results).toEqual([{ key: 'plugin.authorize', outcome: 'succeeded' }])

      expect(connection.external_account_name).toBe('octocat')
      expect(openAuthorization).toHaveBeenCalledWith('https://github.com/login/oauth/authorize')
      expect(close).toHaveBeenCalled()
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).includes('/poll?poll_token=poll-token'))
      ).toBe(true)
    }
  )
})
