import { subscribeOperationResults, type OperationResult } from '@/telemetry/operationBus'
import { afterEach, onTestFinished, describe, expect, test, vi } from 'vitest'
import {
  authorizeWegentConnector,
  CONNECTOR_AUTHORIZATION_CHANGED_EVENT,
  ConnectorAuthorizationError,
  listWegentInstalledConnectorApps,
  waitForConnectorToolCatalog,
} from './connectorApps'

describe('connector OAuth client', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  test('does not create a session for an obsolete account', async () => {
    const fetchMock = vi.fn()
    const openAuthorization = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      authorizeWegentConnector(
        'https://backend.example.test/api',
        'old-token',
        'records',
        openAuthorization,
        { isCurrent: () => false }
      )
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(openAuthorization).not.toHaveBeenCalled()
  })

  test.each(['session', 'open', 'isOpen', 'poll', 'poll-failure', 'close'] as const)(
    'discards an obsolete account while awaiting %s',
    async stage => {
      vi.useFakeTimers()
      let current = true
      let release: () => void = () => undefined
      let entered: () => void = () => undefined
      const blocked = new Promise<void>(resolve => {
        release = resolve
      })
      const waiting = new Promise<void>(resolve => {
        entered = resolve
      })
      const hold = async () => {
        entered()
        await blocked
      }
      const results: OperationResult[] = []
      onTestFinished(subscribeOperationResults(result => results.push(result)))
      const changed = vi.fn()
      window.addEventListener(CONNECTOR_AUTHORIZATION_CHANGED_EVENT, changed)
      onTestFinished(() =>
        window.removeEventListener(CONNECTOR_AUTHORIZATION_CHANGED_EVENT, changed)
      )
      const close = vi.fn(async () => {
        if (stage === 'close') await hold()
      })
      const isOpen = vi.fn(async () => {
        if (stage === 'isOpen') await hold()
        return true
      })
      const openAuthorization = vi.fn(async () => {
        if (stage === 'open') await hold()
        return { closed: new Promise<void>(() => undefined), isOpen, close }
      })
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const poll = String(input).includes('/poll')
        if ((!poll && stage === 'session') || (poll && stage.startsWith('poll'))) await hold()
        if (poll && stage === 'poll-failure') throw new TypeError('old account network failure')
        const body = poll
          ? {
              status: 'success',
              connection: {
                status: 'connected',
                external_account_name: 'old-account',
                granted_scopes: [],
                expires_at: null,
              },
            }
          : {
              session_id: 'old-session',
              poll_token: 'old-poll',
              authorize_url: 'https://provider.example.test/authorize',
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
        'old-token',
        'records',
        openAuthorization,
        { isCurrent: () => current }
      )
      const outcome = authorization.catch((error: Error) => error)
      await vi.advanceTimersByTimeAsync(1000)
      await waiting
      current = false
      release()
      const error = await outcome
      expect(error).toMatchObject({ name: 'AbortError' })
      expect(results).toEqual([])
      expect(changed).not.toHaveBeenCalled()
      expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/poll'))).toHaveLength(
        stage.startsWith('poll') || stage === 'close' ? 1 : 0
      )
      expect(openAuthorization).toHaveBeenCalledTimes(stage === 'session' ? 0 : 1)
      expect(close).toHaveBeenCalledTimes(stage === 'session' ? 0 : 1)
    }
  )

  test('requests a compact installed catalog only for synchronization', async () => {
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify({ apps: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    )
    vi.stubGlobal('fetch', fetchMock)
    await listWegentInstalledConnectorApps('https://backend.example.test/api', 'cloud-token')
    await listWegentInstalledConnectorApps('https://backend.example.test/api', 'cloud-token', {
      compact: true,
    })
    const requests = fetchMock.mock.calls.map(([, options]) => new Headers(options.headers))
    expect(requests[0].has('X-Connector-Loading')).toBe(false)
    expect(requests[1].get('X-Connector-Loading')).toBe('compact')
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
    expect((error as Error).message).toBe('network down')
    expect(close).toHaveBeenCalledTimes(1)
  })

  test('cancels when consent closes long after the host request timeout', async () => {
    vi.useFakeTimers()
    const close = vi.fn().mockResolvedValue(undefined)
    let closeWindow: () => void = () => undefined
    const openAuthorization = vi.fn().mockResolvedValue({
      closed: new Promise<void>(resolve => {
        closeWindow = resolve
      }),
      close,
    })
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    onTestFinished(() => process.off('unhandledRejection', onUnhandled))
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const body = url.includes('/poll')
        ? { status: 'pending' }
        : {
            session_id: 'long-session',
            poll_token: 'poll-token',
            authorize_url: 'https://provider.example/authorize',
            expires_at: Math.floor(Date.now() / 1000) + 600,
            poll_interval_seconds: 30,
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

    // Well past the 120 second host request budget the consent page is still
    // open and the poll loop is still running.
    for (let tick = 0; tick < 6; tick += 1) {
      await vi.advanceTimersByTimeAsync(30_000)
    }
    closeWindow()
    await vi.advanceTimersByTimeAsync(30_000)

    const error = await outcome
    expect(error).toBeInstanceOf(ConnectorAuthorizationError)
    expect((error as ConnectorAuthorizationError).code).toBe('window_closed')
    expect(close).toHaveBeenCalledTimes(1)
    expect(unhandled).toEqual([])
  })

  test('stops polling and closes the window once the attempt ends', async () => {
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
            session_id: 'superseded-session',
            poll_token: 'poll-token',
            authorize_url: 'https://provider.example/authorize',
            expires_at: Math.floor(Date.now() / 1000) + 600,
            poll_interval_seconds: 1,
          }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    let current = true

    const authorization = authorizeWegentConnector(
      'https://backend.example.test/api',
      'cloud-token',
      'slow-connector',
      openAuthorization,
      { isCurrent: () => current }
    )
    const outcome = authorization.catch((error: Error) => error)

    await vi.advanceTimersByTimeAsync(1_000)
    // Signing out ends the attempt while the poll loop is waiting.
    current = false
    await vi.advanceTimersByTimeAsync(1_000)

    const error = await outcome
    expect((error as Error).name).toBe('AbortError')
    expect(close).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/poll'))).toHaveLength(1)
  })

  test('cancels within one poll when the close notification is missed', async () => {
    vi.useFakeTimers()
    const close = vi.fn().mockResolvedValue(undefined)
    let stateReads = 0
    const openAuthorization = vi.fn().mockResolvedValue({
      // The notification never arrives; only the authoritative state read can
      // tell the poll loop the user dismissed the window.
      closed: new Promise<void>(() => undefined),
      isOpen: async () => {
        stateReads += 1
        return stateReads < 2
      },
      close,
    })
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const body = url.includes('/poll')
        ? { status: 'pending' }
        : {
            session_id: 'lost-event-session',
            poll_token: 'poll-token',
            authorize_url: 'https://provider.example/authorize',
            expires_at: Math.floor(Date.now() / 1000) + 600,
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
    await vi.advanceTimersByTimeAsync(3_000)

    const error = await outcome
    expect(error).toBeInstanceOf(ConnectorAuthorizationError)
    expect((error as ConnectorAuthorizationError).code).toBe('window_closed')
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

    expect(error).toBeInstanceOf(ConnectorAuthorizationError)
    expect((error as ConnectorAuthorizationError).code).toBe('timeout')
    expect(close).toHaveBeenCalledTimes(1)
  })

  test('waits for the catalog until the connector tools appear', async () => {
    vi.useFakeTimers()
    let reads = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (!String(input).includes('/apps/installed')) throw new Error('unexpected request')
      reads += 1
      const apps =
        reads < 2
          ? []
          : [{ slug: 'slow-connector', tool_summaries: [{ name: 'slow-connector__echo' }] }]
      return new Response(JSON.stringify({ apps }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const waiting = waitForConnectorToolCatalog(
      'https://backend.example.test/api',
      'cloud-token',
      'slow-connector',
      { intervalMs: 500, timeoutMs: 5_000 }
    )
    await vi.advanceTimersByTimeAsync(1_000)

    await expect(waiting).resolves.toBe(true)
    expect(reads).toBe(2)
  })

  test('gives up when the catalog never syncs', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ apps: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const waiting = waitForConnectorToolCatalog(
      'https://backend.example.test/api',
      'cloud-token',
      'slow-connector',
      { intervalMs: 500, timeoutMs: 1_000 }
    )
    await vi.advanceTimersByTimeAsync(3_000)

    await expect(waiting).resolves.toBe(false)
  })
})
