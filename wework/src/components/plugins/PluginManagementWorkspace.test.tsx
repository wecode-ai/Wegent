import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  clearPluginMarketplaceCache,
  getPluginMarketplaceCache,
  pluginMarketplaceCacheKey,
  setPluginMarketplaceCache,
} from '@/features/plugins/pluginMarketplaceCache'
import { navigateTo } from '@/lib/navigation'
import * as localPlugins from '@/api/local/codexPlugins'
import * as connectorCleanup from '@/features/plugins/logoutLocalQrConnectors'
import { ensureLocalExecutorAvailable, requestLocalExecutor } from '@/desktop/localExecutor'
import '@/i18n'
import { PluginManagementWorkspace } from './PluginManagementWorkspace'
import type { InstalledPluginItem } from './PluginManagementRows'
import type { PluginMarketplaceItem } from '@/types/api'

vi.mock('@/lib/navigation', () => ({
  navigateTo: vi.fn(),
}))

vi.mock('@/desktop/localExecutor', async importOriginal => ({
  ...(await importOriginal<typeof import('@/desktop/localExecutor')>()),
  ensureLocalExecutorAvailable: vi.fn(),
  requestLocalExecutor: vi.fn(),
}))

function cachedInstalledPlugin(): InstalledPluginItem {
  return {
    id: 'cached-1',
    name: 'Cached Plugin',
    description: 'From module cache',
    enabled: true,
    version: '1.0.0',
    origin: 'market',
    sourceLabel: 'Wework官方',
    distribution: 'public',
    updateAvailable: false,
    componentCounts: {},
    raw: {
      apiVersion: 'agent.wecode.io/v1',
      kind: 'InstalledPlugin',
      metadata: {
        name: 'cached-plugin',
        namespace: 'default',
        labels: { id: 'cached-1' },
      },
      spec: {
        source: {
          type: 'marketplace',
          providerKey: 'wegent',
          pluginKey: 'cached-plugin',
        },
        origin: 'market',
        displayName: 'Cached Plugin',
        description: 'From module cache',
        version: '1.0.0',
        installState: 'installed',
        enabled: true,
        componentStates: {},
        components: {
          skills: [],
          commands: [],
          agents: [],
          hooks: [],
          mcps: [],
          lsps: [],
          monitors: [],
          bins: [],
          connectors: [],
        },
        interface: null,
        packageRef: null,
        sourcePayload: null,
      },
      status: { state: 'enabled', devices: [] },
    },
  }
}

function seedCloudInstalledPlugin() {
  const installed = cachedInstalledPlugin().raw
  installed.spec.pluginId = 901
  installed.spec.releaseId = 6
  installed.status.devices = [
    {
      deviceId: 'device-1',
      desiredReleaseId: 6,
      actualReleaseId: 6,
      state: 'installed',
      attemptCount: 0,
      updatedAt: '2026-10-25T00:00:00Z',
    },
  ]
  const key = pluginMarketplaceCacheKey('/api', 'cloud-token')
  setPluginMarketplaceCache({
    cacheKey: key,
    marketplaceItems: [],
    installedPlugins: [installed],
    marketplaces: [],
    selectedMarketplaceKey: '',
    deviceId: 'device-1',
    fetchedAt: Date.now(),
  })
  const api = localPlugins.createLocalCodexPluginApi()
  vi.spyOn(localPlugins, 'createLocalCodexPluginApi').mockReturnValue({
    ...api,
    listInstalledPlugins: vi.fn().mockResolvedValue({ items: [installed], deviceId: 'device-1' }),
  })
  return { key, installed }
}

describe('PluginManagementWorkspace cache', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    clearPluginMarketplaceCache()
    vi.mocked(navigateTo).mockReset()
    vi.mocked(ensureLocalExecutorAvailable).mockReset().mockResolvedValue({
      running: true,
      ready: true,
      deviceId: 'device-1',
      deviceRouteId: 'app-record-70',
    })
    vi.mocked(requestLocalExecutor)
      .mockReset()
      .mockImplementation(async method => {
        if (method === 'executor.plugins.device_route') {
          const status = await vi.mocked(ensureLocalExecutorAvailable).getMockImplementation()?.({
            refresh: true,
          })
          return { device_id: status?.deviceId, device_route_id: status?.deviceRouteId }
        }
        return undefined
      })
    window.localStorage.clear()
  })

  test('shows cold local inventory while cloud is pending without reading any marketplace', async () => {
    vi.mocked(ensureLocalExecutorAvailable).mockResolvedValue({
      running: true,
      ready: true,
      deviceId: 'resolved-device',
      deviceRouteId: 'app-record-70',
    })
    const api = localPlugins.createLocalCodexPluginApi()
    const readState = vi.fn()
    const listInstalledPlugins = vi.fn().mockResolvedValue({
      items: [cachedInstalledPlugin().raw],
      deviceId: 'resolved-device',
    })
    vi.spyOn(localPlugins, 'createLocalCodexPluginApi').mockReturnValue({
      ...api,
      readState,
      listInstalledPlugins,
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {}))
    )

    render(<PluginManagementWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    expect(await screen.findByText('Cached Plugin')).toBeInTheDocument()
    expect(screen.queryByText('正在加载插件')).not.toBeInTheDocument()
    expect(listInstalledPlugins).toHaveBeenCalledWith({ requireComplete: true })
    expect(readState).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain('device_id=app-record-70')
    expect(requestLocalExecutor).toHaveBeenCalledWith(
      'executor.plugins.device_route',
      expect.objectContaining({ auth_token: 'cloud-token', device_id: 'resolved-device' })
    )
    expect(String(vi.mocked(fetch).mock.calls[0][0])).not.toContain('marketplace')
  })

  test('renders a confirmed empty inventory immediately while refreshing', () => {
    const key = pluginMarketplaceCacheKey('/api', 'cloud-token')
    setPluginMarketplaceCache({
      cacheKey: key,
      marketplaceItems: [],
      installedPlugins: [],
      installedPluginsFetchedAt: Date.now(),
      marketplaces: [],
      selectedMarketplaceKey: '',
      deviceId: 'device-1',
      fetchedAt: Date.now(),
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {}))
    )

    render(<PluginManagementWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    expect(screen.queryByText('正在加载插件')).not.toBeInTheDocument()
    expect(screen.queryByTestId('plugin-management-installed-list')).not.toBeInTheDocument()
  })

  test('unblocks rendering when another consumer publishes inventory during a slow local read', async () => {
    const api = localPlugins.createLocalCodexPluginApi()
    vi.spyOn(localPlugins, 'createLocalCodexPluginApi').mockReturnValue({
      ...api,
      listInstalledPlugins: vi.fn(() => new Promise(() => {})),
    })
    render(<PluginManagementWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
    expect(screen.getByText('正在加载插件')).toBeInTheDocument()

    act(() => {
      setPluginMarketplaceCache({
        cacheKey: pluginMarketplaceCacheKey('/api', 'cloud-token'),
        marketplaceItems: [],
        installedPlugins: [cachedInstalledPlugin().raw],
        marketplaces: [],
        selectedMarketplaceKey: '',
        deviceId: 'device-1',
        fetchedAt: Date.now(),
      })
    })

    expect(screen.getByText('Cached Plugin')).toBeInTheDocument()
    expect(screen.queryByText('正在加载插件')).not.toBeInTheDocument()
  })

  test('ends loading and reports a failed installed read instead of persisting an empty inventory', async () => {
    const api = localPlugins.createLocalCodexPluginApi()
    vi.spyOn(localPlugins, 'createLocalCodexPluginApi').mockReturnValue({
      ...api,
      listInstalledPlugins: vi.fn().mockRejectedValue(new Error('Inventory unavailable')),
    })
    render(<PluginManagementWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Inventory unavailable')
    expect(screen.queryByText('正在加载插件')).not.toBeInTheDocument()
    expect(getPluginMarketplaceCache(pluginMarketplaceCacheKey('/api', 'cloud-token'))).toBeNull()
  })

  test('resets the rendered inventory when the account changes and ignores the old read', async () => {
    const api = localPlugins.createLocalCodexPluginApi()
    let finishOldRead!: (value: { items: []; deviceId: string }) => void
    const listInstalledPlugins = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finishOldRead = resolve
          })
      )
      .mockImplementation(() => new Promise(() => {}))
    vi.spyOn(localPlugins, 'createLocalCodexPluginApi').mockReturnValue({
      ...api,
      listInstalledPlugins,
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {}))
    )
    setPluginMarketplaceCache({
      cacheKey: pluginMarketplaceCacheKey('/api', 'cloud-token'),
      marketplaceItems: [],
      installedPlugins: [cachedInstalledPlugin().raw],
      marketplaces: [],
      selectedMarketplaceKey: '',
      deviceId: 'device-1',
      fetchedAt: Date.now(),
    })
    const { rerender } = render(
      <PluginManagementWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />
    )
    expect(screen.getByText('Cached Plugin')).toBeInTheDocument()

    rerender(<PluginManagementWorkspace cloudApiBaseUrl="/api" cloudToken="other-account" />)
    expect(screen.queryByText('Cached Plugin')).not.toBeInTheDocument()
    expect(screen.getByText('正在加载插件')).toBeInTheDocument()
    await act(async () => {
      finishOldRead({ items: [], deviceId: 'device-1' })
    })
    expect(fetch).not.toHaveBeenCalled()
    expect(screen.getByText('正在加载插件')).toBeInTheDocument()
  })

  test('renders cached installed plugins immediately without the loading state', async () => {
    const key = pluginMarketplaceCacheKey('/api', 'cloud-token')
    setPluginMarketplaceCache({
      cacheKey: key,
      marketplaceItems: [],
      installedPlugins: [cachedInstalledPlugin().raw],
      marketplaces: [],
      selectedMarketplaceKey: '',
      deviceId: 'device-1',
      fetchedAt: Date.now(),
    })

    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise(() => {
            // Keep background refresh pending so the first paint is cache-only.
          })
      )
    )

    render(<PluginManagementWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    expect(screen.queryByText('正在加载插件')).not.toBeInTheDocument()
    expect(screen.getByText('Cached Plugin')).toBeInTheDocument()
    expect(screen.getByTestId('plugin-management-installed-list')).toBeInTheDocument()

    await waitFor(() => expect(fetch).toHaveBeenCalled())
  })

  test('refreshes the registered Runtime route for every enabled update and keeps stable inventory identity', async () => {
    const { key, installed } = seedCloudInstalledPlugin()
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== 'PUT') return new Promise<Response>(() => {})
      const request = JSON.parse(String(init.body)) as { enabled: boolean }
      return Promise.resolve(
        Response.json({
          ...installed,
          spec: { ...installed.spec, enabled: request.enabled },
          status: {
            state: request.enabled ? 'enabled' : 'disabled',
            devices: installed.status.devices?.map(device => ({
              ...device,
              deviceId: new URL(String(input), 'https://wegent.test').searchParams.get('device_id'),
            })),
          },
        })
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<PluginManagementWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(String(fetchMock.mock.calls[0][0])).toContain('device_id=app-record-70')

    for (const [route, enabled] of [
      ['app-record-71', false],
      ['app-record-72', true],
    ] as const) {
      vi.mocked(ensureLocalExecutorAvailable).mockResolvedValue({
        running: true,
        ready: true,
        deviceId: 'device-1',
        deviceRouteId: route,
      })
      await userEvent.click(screen.getByTestId('installed-plugin-toggle-cached-1'))
      await waitFor(() =>
        expect(getPluginMarketplaceCache(key)?.installedPlugins[0].spec.enabled).toBe(enabled)
      )
      const update = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT').at(-1)!
      expect(String(update[0])).toBe(`/api/plugins/installed/cached-1?device_id=${route}`)
      expect(JSON.parse(String(update[1]?.body))).toEqual({ enabled })
      expect(screen.getByTestId('installed-plugin-toggle-cached-1')).toHaveAttribute(
        'aria-checked',
        String(enabled)
      )
      expect(getPluginMarketplaceCache(key)?.deviceId).toBe('device-1')
      expect(getPluginMarketplaceCache(key)?.installedPlugins[0].status.devices?.[0].deviceId).toBe(
        'device-1'
      )
    }
    expect(requestLocalExecutor).toHaveBeenCalledTimes(3)
    expect(requestLocalExecutor).toHaveBeenLastCalledWith(
      'executor.plugins.device_route',
      expect.objectContaining({ auth_token: 'cloud-token', device_id: 'device-1' })
    )
  })

  test('omits the old account route after switching tokens on the same Backend before Runtime configuration', async () => {
    const { installed } = seedCloudInstalledPlugin()
    vi.mocked(requestLocalExecutor).mockImplementation(async (method, params) => {
      if (method !== 'executor.plugins.device_route') return undefined
      if (params?.auth_token !== 'cloud-token')
        throw new Error('Runtime still belongs to previous account')
      return { device_id: 'device-1', device_route_id: 'app-record-70' }
    })
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT')
        return Response.json({ ...installed, spec: { ...installed.spec, enabled: false } })
      return Response.json({ items: [installed] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { rerender } = render(
      <PluginManagementWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />
    )
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/plugins/installed?device_id=app-record-70',
        expect.anything()
      )
    )
    fetchMock.mockClear()

    rerender(<PluginManagementWorkspace cloudApiBaseUrl="/api" cloudToken="other-account" />)
    const toggle = await screen.findByTestId('installed-plugin-toggle-cached-1')
    await userEvent.click(toggle)

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/plugins/installed/cached-1',
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ enabled: false }) })
      )
    )
    expect(fetchMock.mock.calls.every(([input]) => !String(input).includes('device_id='))).toBe(
      true
    )
    expect(requestLocalExecutor).toHaveBeenLastCalledWith(
      'executor.plugins.device_route',
      expect.objectContaining({ auth_token: 'other-account', device_id: 'device-1' })
    )
    expect(
      fetchMock.mock.calls.every(
        ([, init]) => new Headers(init?.headers).get('Authorization') === 'Bearer other-account'
      )
    ).toBe(true)
  })

  test('saves account enabled preference without device targeting when Runtime IPC is unavailable', async () => {
    const { key, installed } = seedCloudInstalledPlugin()
    vi.mocked(ensureLocalExecutorAvailable).mockRejectedValue(new Error('Runtime IPC unavailable'))
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== 'PUT') return new Promise<Response>(() => {})
      return Promise.resolve(
        Response.json({
          ...installed,
          spec: { ...installed.spec, enabled: false },
          status: { ...installed.status, state: 'disabled' },
        })
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<PluginManagementWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    await userEvent.click(screen.getByTestId('installed-plugin-toggle-cached-1'))

    await waitFor(() =>
      expect(getPluginMarketplaceCache(key)?.installedPlugins[0].spec.enabled).toBe(false)
    )
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/plugins/installed/cached-1',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ enabled: false }) })
    )
    expect(screen.getByTestId('installed-plugin-toggle-cached-1')).toHaveAttribute(
      'aria-checked',
      'false'
    )
    expect(getPluginMarketplaceCache(key)?.deviceId).toBe('device-1')
  })

  test('rolls back the enabled toggle when the account preference HTTP request fails', async () => {
    const { key } = seedCloudInstalledPlugin()
    vi.mocked(ensureLocalExecutorAvailable).mockRejectedValue(new Error('Runtime IPC unavailable'))
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== 'PUT') return new Promise<Response>(() => {})
      return Promise.resolve(Response.json({ detail: 'Preference rejected' }, { status: 500 }))
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<PluginManagementWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    await userEvent.click(screen.getByTestId('installed-plugin-toggle-cached-1'))

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/plugins/installed/cached-1',
        expect.objectContaining({ method: 'PUT' })
      )
    )
    await waitFor(() =>
      expect(screen.getByTestId('installed-plugin-toggle-cached-1')).toHaveAttribute(
        'aria-checked',
        'true'
      )
    )
    expect(getPluginMarketplaceCache(key)?.installedPlugins[0].spec.enabled).toBe(true)
  })

  test('maps only the current registered record to stable inventory identity when historical device records coexist', async () => {
    const { key, installed } = seedCloudInstalledPlugin()
    const currentDevice = installed.status.devices![0]
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          items: [
            {
              ...installed,
              status: {
                ...installed.status,
                devices: [
                  { ...currentDevice, deviceId: 'app-record-69', actualReleaseId: 5 },
                  { ...currentDevice, deviceId: 'app-record-70' },
                ],
              },
            },
          ],
        })
      )
    )
    render(<PluginManagementWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    await waitFor(() =>
      expect(getPluginMarketplaceCache(key)?.installedPluginsFetchedAt).toBeTypeOf('number')
    )

    const snapshot = getPluginMarketplaceCache(key)!
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain('device_id=app-record-70')
    expect(snapshot.deviceId).toBe('device-1')
    expect(snapshot.installedPlugins[0].status.devices).toEqual([
      expect.objectContaining({ deviceId: 'app-record-69', actualReleaseId: 5 }),
      expect.objectContaining({ deviceId: 'device-1', actualReleaseId: 6 }),
    ])
    expect(screen.getByText('Cached Plugin')).toBeInTheDocument()
  })

  test('opens marketplace plugin detail instead of a separate management detail page', async () => {
    const key = pluginMarketplaceCacheKey('/api', 'cloud-token')
    const installed = cachedInstalledPlugin()
    installed.id = 267250
    installed.name = '快速建站'
    installed.raw.metadata = {
      name: 'wegent-sites',
      namespace: 'default',
      labels: { id: 267250 },
    }
    installed.raw.spec.pluginId = 267250
    installed.raw.spec.source.pluginKey = 'wegent-sites'
    installed.raw.spec.displayName = '快速建站'
    const marketplaceItem = {
      id: 267250,
      remotePluginId: 'wegent-sites',
      name: 'wegent-sites',
      displayName: '快速建站',
      description: '',
      featured: false,
      installed: true,
      installedPluginId: 267250,
      enabled: true,
      sourceType: 'marketplace' as const,
      visibility: 'workspace' as const,
      ownerUserId: 1,
      components: installed.raw.spec.components,
      manifest: {},
      latestReleaseId: 6,
    } satisfies PluginMarketplaceItem
    setPluginMarketplaceCache({
      cacheKey: key,
      marketplaceItems: [marketplaceItem],
      installedPlugins: [installed.raw],
      marketplaces: [],
      selectedMarketplaceKey: '',
      deviceId: 'device-1',
      fetchedAt: Date.now(),
    })

    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise(() => {
            // Keep background refresh pending so the first paint is cache-only.
          })
      )
    )

    render(<PluginManagementWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    await userEvent.click(screen.getByRole('button', { name: '查看 快速建站 详情' }))
    expect(navigateTo).toHaveBeenCalledWith('/plugins?plugin=wegent-sites&marketplace=wegent')
    expect(screen.queryByTestId('plugin-detail-toggle-267250')).not.toBeInTheDocument()
  })

  test('does not expose publication or scope management for a stale locally labelled received package', async () => {
    const installed = cachedInstalledPlugin()
    installed.origin = 'created'
    installed.raw.spec.origin = 'created'
    installed.raw.spec.source.type = 'local'
    installed.raw.spec.sourcePayload = { managedByWegent: true, cloudPluginId: 901 }
    const listing = {
      id: 901,
      remotePluginId: 'cached-plugin',
      name: 'cached-plugin',
      displayName: installed.name,
      description: '',
      featured: false,
      installed: true,
      installedPluginId: installed.id,
      enabled: true,
      sourceType: 'marketplace' as const,
      visibility: 'personal' as const,
      ownerUserId: 2,
      accessRole: 'recipient' as const,
      latestReleaseId: 12,
      components: installed.raw.spec.components,
      manifest: {},
    }
    setPluginMarketplaceCache({
      cacheKey: pluginMarketplaceCacheKey('/api', 'cloud-token'),
      marketplaceItems: [listing],
      installedPlugins: [installed.raw],
      marketplaces: [],
      selectedMarketplaceKey: '',
      deviceId: 'device-1',
      fetchedAt: Date.now(),
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {}))
    )
    render(<PluginManagementWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
    await userEvent.click(screen.getByTestId('installed-plugin-actions-cached-1'))
    expect(screen.queryByTestId('installed-plugin-publish-cached-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('installed-plugin-share-cached-1')).not.toBeInTheDocument()
    expect(screen.getByTestId('installed-plugin-uninstall-cached-1')).toBeInTheDocument()
  })

  test('routes personal plugin publication to the canonical plugin workspace flow', async () => {
    const key = pluginMarketplaceCacheKey('/api', 'cloud-token')
    const installed = cachedInstalledPlugin()
    installed.id = 'created-1'
    installed.name = '智能工作台开发助手'
    installed.origin = 'created'
    installed.raw.metadata = {
      name: 'smart-workbench-dev-assistant',
      namespace: 'default',
      labels: { id: 'created-1' },
    }
    installed.raw.spec.origin = 'created'
    installed.raw.spec.source = {
      type: 'local',
      providerKey: 'local',
      pluginKey: 'smart-workbench-dev-assistant',
    }
    installed.raw.spec.displayName = installed.name
    setPluginMarketplaceCache({
      cacheKey: key,
      marketplaceItems: [],
      installedPlugins: [installed.raw],
      marketplaces: [],
      selectedMarketplaceKey: '',
      deviceId: 'device-1',
      fetchedAt: Date.now(),
    })

    const fetchMock = vi.fn(
      () =>
        new Promise<Response>(() => {
          // Keep background refresh pending; publication must only navigate.
        })
    )
    vi.stubGlobal('fetch', fetchMock)

    render(<PluginManagementWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    await userEvent.click(screen.getByTestId('installed-plugin-actions-created-1'))
    await userEvent.click(screen.getByTestId('installed-plugin-publish-created-1'))

    expect(navigateTo).toHaveBeenCalledWith(
      '/plugins?plugin=smart-workbench-dev-assistant&marketplace=wework-personal'
    )
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/plugins/submissions'),
      expect.objectContaining({ method: 'POST' })
    )
  })

  test('routes personal plugin access management to the same canonical workspace flow', async () => {
    const key = pluginMarketplaceCacheKey('/api', 'cloud-token')
    const installed = cachedInstalledPlugin()
    installed.id = 'created-owner'
    installed.name = '团队助手'
    installed.origin = 'created'
    installed.raw.metadata = {
      name: 'team-helper',
      namespace: 'default',
      labels: { id: 'created-owner' },
    }
    installed.raw.spec.origin = 'created'
    installed.raw.spec.source = {
      type: 'local',
      providerKey: 'local',
      pluginKey: 'team-helper',
    }
    installed.raw.spec.displayName = installed.name
    const ownedListing = {
      id: 901,
      remotePluginId: 'team-helper',
      name: 'team-helper',
      displayName: installed.name,
      description: '',
      featured: false,
      installed: true,
      installedPluginId: 'created-owner',
      enabled: true,
      sourceType: 'marketplace' as const,
      visibility: 'personal' as const,
      ownerUserId: 1,
      accessRole: 'owner' as const,
      components: installed.raw.spec.components,
      manifest: {},
      latestReleaseId: 12,
    } satisfies PluginMarketplaceItem
    setPluginMarketplaceCache({
      cacheKey: key,
      marketplaceItems: [ownedListing],
      installedPlugins: [installed.raw],
      marketplaces: [],
      selectedMarketplaceKey: '',
      deviceId: 'device-1',
      fetchedAt: Date.now(),
    })

    const fetchMock = vi.fn(
      () =>
        new Promise<Response>(() => {
          // Keep background refresh pending; access management must only navigate.
        })
    )
    vi.stubGlobal('fetch', fetchMock)

    render(<PluginManagementWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    await userEvent.click(screen.getByTestId('installed-plugin-actions-created-owner'))
    await userEvent.click(screen.getByTestId('installed-plugin-share-created-owner'))

    expect(navigateTo).toHaveBeenCalledWith(
      '/plugins?plugin=team-helper&marketplace=wework-personal'
    )
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/plugins/marketplace/901/access'),
      expect.anything()
    )
  })

  test('commits uninstall to the shared inventory without waiting for a catalog refresh', async () => {
    const key = pluginMarketplaceCacheKey('/api', 'cloud-token')
    const installed = cachedInstalledPlugin()
    installed.id = 267250
    installed.name = '产品设计'
    installed.raw.metadata.labels = { id: 267250 }
    installed.raw.spec.pluginId = 901
    installed.raw.spec.source.pluginKey = 'product-design'
    installed.raw.spec.displayName = installed.name
    const marketplaceItem = {
      id: 901,
      remotePluginId: 'product-design',
      name: 'product-design',
      displayName: installed.name,
      description: '',
      featured: true,
      installed: true,
      installedPluginId: 267250,
      enabled: true,
      sourceType: 'marketplace' as const,
      visibility: 'public' as const,
      ownerUserId: 1,
      components: installed.raw.spec.components,
      manifest: { marketplaceId: 'openai-curated-remote' },
      latestReleaseId: 6,
    } satisfies PluginMarketplaceItem
    setPluginMarketplaceCache({
      cacheKey: key,
      marketplaceItems: [marketplaceItem],
      installedPlugins: [installed.raw],
      marketplaces: [],
      selectedMarketplaceKey: '',
      deviceId: 'device-1',
      fetchedAt: Date.now(),
    })

    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }))
        if (String(input).endsWith('/plugins/installed')) {
          return Promise.resolve(Response.json({ items: [installed.raw] }))
        }
        return new Promise<Response>(() => {
          // A slow catalog refresh must not delay the committed uninstall state.
        })
      })
    )

    render(<PluginManagementWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    await userEvent.click(screen.getByTestId('installed-plugin-actions-267250'))
    await userEvent.click(screen.getByTestId('installed-plugin-uninstall-267250'))
    await userEvent.click(screen.getByTestId('plugin-uninstall-confirm-button'))

    await waitFor(() => expect(screen.queryByText('产品设计')).not.toBeInTheDocument())
    expect(getPluginMarketplaceCache(key)?.installedPlugins).toEqual([])
    expect(getPluginMarketplaceCache(key)?.marketplaceItems).toEqual([
      expect.objectContaining({ installed: false, installedPluginId: null, enabled: false }),
    ])
  })

  test.each(['none', 'current', 'unavailable', 'delete-failure', 'account-change', 'unmount'])(
    'preflights a published local source before uninstall cleanup (%s)',
    async outcome => {
      const source = cachedInstalledPlugin().raw
      source.metadata.labels = { id: 'author-source' }
      source.spec.source = {
        type: 'local',
        providerKey: 'wework-personal',
        marketplace: 'wework-personal',
        pluginKey: 'dev-tools',
      }
      source.spec.origin = 'created'
      source.spec.sourcePayload = { cloudPluginId: 901, cloudReleaseId: 6 }
      const key = pluginMarketplaceCacheKey('/api', 'cloud-token')
      setPluginMarketplaceCache({
        cacheKey: key,
        marketplaceItems: [],
        installedPlugins: [source],
        marketplaces: [],
        selectedMarketplaceKey: '',
        deviceId: 'device-1',
        fetchedAt: Date.now(),
      })
      const api = localPlugins.createLocalCodexPluginApi()
      const uninstallLocal = vi.fn().mockResolvedValue(undefined)
      vi.spyOn(localPlugins, 'createLocalCodexPluginApi').mockReturnValue({
        ...api,
        listInstalledPlugins: vi.fn().mockResolvedValue({ items: [source], deviceId: 'device-1' }),
        uninstallInstalledPlugin: uninstallLocal,
      })
      const logout = vi
        .spyOn(connectorCleanup, 'logoutLocalConnectorsForPlugin')
        .mockResolvedValue(undefined)
      let finish!: (response: Response) => void
      const request = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'DELETE') {
          return Promise.resolve(
            outcome === 'delete-failure'
              ? Response.json({ detail: 'Forbidden' }, { status: 403 })
              : new Response(null, { status: 204 })
          )
        }
        if (String(input).endsWith('/plugins/installed')) {
          return new Promise<Response>(resolve => {
            finish = resolve
          })
        }
        return Promise.resolve(Response.json({ items: [] }))
      })
      vi.stubGlobal('fetch', request)
      const view = render(
        <PluginManagementWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />
      )
      await userEvent.click(await screen.findByTestId('installed-plugin-actions-author-source'))
      await userEvent.click(screen.getByTestId('installed-plugin-uninstall-author-source'))
      expect(screen.getByTestId('uninstall-plugin-dialog')).toHaveTextContent(
        '源码、已分享版本和分享范围会保留'
      )
      await userEvent.click(screen.getByTestId('plugin-uninstall-confirm-button'))
      await waitFor(() => expect(finish).toBeDefined())
      expect(logout).not.toHaveBeenCalled()
      expect(uninstallLocal).not.toHaveBeenCalled()
      if (outcome === 'account-change') {
        view.rerender(
          <PluginManagementWorkspace cloudApiBaseUrl="/api" cloudToken="another-account" />
        )
      } else if (outcome === 'unmount') view.unmount()
      const accountPlugin = {
        ...source,
        metadata: { ...source.metadata, labels: { id: 208 } },
        spec: { ...source.spec, pluginId: 901, releaseId: 6 },
      }
      await act(async () =>
        finish(
          outcome === 'unavailable'
            ? Response.json({ detail: 'Unavailable' }, { status: 503 })
            : Response.json({
                items: outcome === 'current' || outcome === 'delete-failure' ? [accountPlugin] : [],
              })
        )
      )
      if (outcome === 'none' || outcome === 'current') {
        await waitFor(() => expect(uninstallLocal).toHaveBeenCalledWith('author-source'))
        expect(logout).toHaveBeenCalledOnce()
        expect(getPluginMarketplaceCache(key)?.installedPlugins).toEqual([])
      } else {
        await waitFor(() => {
          if (outcome === 'unavailable' || outcome === 'delete-failure') {
            expect(screen.getByTestId('plugin-operation-notice')).toHaveAttribute(
              'data-notice-kind',
              'error'
            )
          }
        })
        expect(logout).not.toHaveBeenCalled()
        expect(uninstallLocal).not.toHaveBeenCalled()
        if (outcome !== 'account-change') {
          expect(getPluginMarketplaceCache(key)?.installedPlugins).toEqual([source])
        }
      }
      const deletes = request.mock.calls.filter(([, init]) => init?.method === 'DELETE')
      if (outcome === 'current' || outcome === 'delete-failure') {
        expect(deletes).toEqual([
          ['/api/plugins/installed/208', expect.objectContaining({ method: 'DELETE' })],
        ])
      } else expect(deletes).toEqual([])
      view.unmount()
    }
  )
})
