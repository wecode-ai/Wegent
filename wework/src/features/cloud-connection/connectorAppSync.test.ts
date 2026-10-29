import { beforeEach, describe, expect, test, vi } from 'vitest'
import { synchronizeConnectorApps } from './connectorAppSync'

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
})
