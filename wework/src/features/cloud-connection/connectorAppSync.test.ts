import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  ConnectorSyncAbortedError,
  synchronizeConnectorApps,
  waitForLocalConnectorSync,
} from './connectorAppSync'

const mocks = vi.hoisted(() => ({
  issueToken: vi.fn(),
  listInstalled: vi.fn(),
  listCatalog: vi.fn(),
  request: vi.fn(),
}))

vi.mock('@/api/cloud/connectorApps', () => ({
  issueWegentConnectorToken: mocks.issueToken,
  listWegentInstalledConnectorApps: mocks.listInstalled,
  listWegentConnectorApps: mocks.listCatalog,
}))

vi.mock('@/desktop/localExecutor', () => ({
  requestLocalExecutor: mocks.request,
}))

describe('synchronizeConnectorApps', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.issueToken.mockResolvedValue({
      access_token: 'connector-token',
      token_type: 'bearer',
      expires_in: 900,
    })
    mocks.listInstalled.mockResolvedValue({
      apps: [
        {
          id: '1',
          slug: 'ready-app',
          runtime_name: 'Ready',
          enabled: true,
          callable: true,
          tool_summaries: [
            { name: 'ready_app__echo', title: null, description: '', raw_tool_name: 'echo' },
          ],
          connection: { status: 'connected' },
        },
        {
          id: '2',
          slug: 'disabled-app',
          runtime_name: 'Disabled',
          enabled: false,
          callable: true,
          tool_summaries: [],
          connection: { status: 'connected' },
        },
      ],
    })
    mocks.listCatalog.mockResolvedValue([
      {
        id: 3,
        slug: 'pending-app',
        name: 'Pending',
        description: '',
        icon_url: null,
        auth_type: 'oauth2',
        tool_loading_mode: 'static',
        connection: { status: 'disconnected' },
      },
    ])
    mocks.request.mockResolvedValue({ changed: true })
  })

  test('resolves only after the local executor applied the app list', async () => {
    let releaseSync: (value: { changed: boolean }) => void = () => {}
    mocks.request.mockImplementation((method: string) =>
      method === 'runtime.connectors.apps.sync'
        ? new Promise(resolve => {
            releaseSync = resolve
          })
        : Promise.resolve({})
    )
    let resolved = false
    const synchronization = synchronizeConnectorApps({
      apiBaseUrl: 'https://cloud.example.test/api',
      token: 'cloud-token',
      requestedAtMs: 1_000,
    }).then(result => {
      resolved = true
      return result
    })

    await vi.waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith(
        'runtime.connectors.apps.sync',
        expect.objectContaining({
          apps: expect.arrayContaining([
            expect.objectContaining({ slug: 'ready-app', authorizationRequired: false }),
            expect.objectContaining({ slug: 'pending-app', authorizationRequired: true }),
          ]),
        })
      )
    )
    expect(resolved).toBe(false)

    releaseSync({ changed: true })
    const result = await synchronization

    expect(result.changed).toBe(true)
    expect(result.callableSlugs).toEqual(['ready-app'])
    expect(result.expiresAtMs).toBe(1_000 + 900_000)
    expect(result.expiresInSeconds).toBe(900)
  })

  test('reports the token deadline as soon as the runtime accepts it', async () => {
    const deadlines: number[] = []
    await synchronizeConnectorApps({
      apiBaseUrl: 'https://cloud.example.test/api',
      token: 'cloud-token',
      requestedAtMs: 5_000,
      onConfigured: deadline => deadlines.push(deadline.expiresAtMs),
    })

    expect(deadlines).toEqual([5_000 + 900_000])
    expect(mocks.request).toHaveBeenCalledWith(
      'runtime.connectors.configure',
      expect.objectContaining({ expiresAtMs: 5_000 + 900_000 })
    )
  })

  test('uses the revision the caller allocated before its first await', async () => {
    await synchronizeConnectorApps({
      apiBaseUrl: 'https://cloud.example.test/api',
      token: 'cloud-token',
      syncRevision: 42,
    })

    expect(mocks.request).toHaveBeenCalledWith(
      'runtime.connectors.configure',
      expect.objectContaining({ syncRevision: 42 })
    )
  })

  test('never writes a configuration once the attempt was superseded', async () => {
    let releaseToken: (value: {
      access_token: string
      token_type: string
      expires_in: number
    }) => void = () => undefined
    mocks.issueToken.mockReturnValue(
      new Promise(resolve => {
        releaseToken = resolve
      })
    )
    let current = true
    const synchronization = synchronizeConnectorApps({
      apiBaseUrl: 'https://cloud.example.test/api',
      token: 'account-a-token',
      syncRevision: 7,
      isCurrent: () => current,
    })

    // The user signed out while the cloud token request was in flight.
    current = false
    releaseToken({ access_token: 'stale-token', token_type: 'bearer', expires_in: 900 })

    await expect(synchronization).rejects.toBeInstanceOf(ConnectorSyncAbortedError)
    expect(mocks.request).not.toHaveBeenCalled()
  })
})

describe('waitForLocalConnectorSync', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.issueToken.mockResolvedValue({
      access_token: 'connector-token',
      token_type: 'bearer',
      expires_in: 900,
    })
    mocks.listCatalog.mockResolvedValue([])
    mocks.request.mockResolvedValue({ changed: false })
  })

  function respondWith(slugs: () => string[]) {
    mocks.listInstalled.mockImplementation(async () => ({
      apps: slugs().map(slug => ({
        id: slug,
        slug,
        runtime_name: slug,
        enabled: true,
        callable: true,
        tool_summaries: [],
        connection: { status: 'connected' },
      })),
    }))
  }

  test('retries until the app is callable and then stops', async () => {
    let attempt = 0
    respondWith(() => (++attempt < 3 ? [] : ['ready-app']))

    const waiting = waitForLocalConnectorSync({
      apiBaseUrl: 'https://cloud.example.test/api',
      token: 'cloud-token',
      slug: 'ready-app',
      timeoutMs: 10_000,
      intervalMs: 1_000,
    })
    await vi.advanceTimersByTimeAsync(5_000)

    await expect(waiting).resolves.toBe(true)
    expect(attempt).toBe(3)
  })

  test('gives up at the deadline while keeping the app unsynced', async () => {
    respondWith(() => [])

    const waiting = waitForLocalConnectorSync({
      apiBaseUrl: 'https://cloud.example.test/api',
      token: 'cloud-token',
      slug: 'missing-app',
      timeoutMs: 3_000,
      intervalMs: 1_000,
    })
    await vi.advanceTimersByTimeAsync(5_000)

    await expect(waiting).resolves.toBe(false)
  })

  test('keeps retrying after a failed synchronization', async () => {
    respondWith(() => ['ready-app'])
    let calls = 0
    mocks.request.mockImplementation((method: string) => {
      if (method !== 'runtime.connectors.apps.sync') return Promise.resolve({})
      calls += 1
      return calls === 1
        ? Promise.reject(new Error('executor offline'))
        : Promise.resolve({ changed: true })
    })

    const waiting = waitForLocalConnectorSync({
      apiBaseUrl: 'https://cloud.example.test/api',
      token: 'cloud-token',
      slug: 'ready-app',
      timeoutMs: 10_000,
      intervalMs: 1_000,
    })
    await vi.advanceTimersByTimeAsync(5_000)

    await expect(waiting).resolves.toBe(true)
    expect(calls).toBe(2)
  })
})
