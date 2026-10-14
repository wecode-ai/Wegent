import { CODEX_PERSONAL_MARKETPLACE_ID } from '@/features/plugins/builtinPlugins'
import { describe, expect, test, vi } from 'vitest'
import * as localPlugins from './local/codexPlugins'
import { toInstalledPlugin } from '@wegent/chat-core/codex-installed-plugins'
import {
  createLocalProjectDevicePluginApi,
  createRemoteProjectDevicePluginApi,
} from './projectDevicePlugins'

const item = {
  id: 'quality@team',
  name: 'quality',
  displayName: 'Quality',
  manifest: { id: 'quality@team', marketplaceId: 'team', marketplacePath: '/device/plugins' },
}

describe('device project plugins', () => {
  test('disables both concurrent installations without treating cache changes as a new runtime', async () => {
    let finishSecond!: (value: unknown) => void
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'plugin/installed') return { marketplaces: [] }
      if (method === 'plugin/install' && params.pluginName === 'second')
        return new Promise(resolve => {
          finishSecond = resolve
        })
      return {}
    })
    const api = createRemoteProjectDevicePluginApi('remote', request as never)
    const first = api.installAvailablePlugin(item as never)
    const second = api.installAvailablePlugin({
      ...item,
      id: 'second@team',
      name: 'second',
    } as never)
    await vi.waitFor(() => expect(finishSecond).toBeDefined())
    await first
    finishSecond({})
    await expect(second).resolves.toMatchObject({ spec: { enabled: false } })
    expect(request).toHaveBeenCalledWith(
      'config/value/write',
      expect.objectContaining({ keyPath: 'plugins."quality@team".enabled', value: false })
    )
    expect(request).toHaveBeenCalledWith(
      'config/value/write',
      expect.objectContaining({ keyPath: 'plugins."second@team".enabled', value: false })
    )
  })
  test('does not read a replacement runtime catalogue after an old inventory resolves', async () => {
    let finishRead!: (value: unknown) => void
    const request = vi.fn(async (method: string) =>
      method === 'plugin/installed'
        ? new Promise(resolve => {
            finishRead = resolve
          })
        : { marketplaces: [] }
    )
    const api = createRemoteProjectDevicePluginApi('remote', request as never)
    const device = {
      device_id: 'remote',
      device_type: 'remote',
      status: 'online',
      runtime_instance_id: 'old',
    }
    api.observeDevice?.(device as never)
    const reading = api.readState()
    api.observeDevice?.({ ...device, runtime_instance_id: 'replacement' } as never)
    finishRead({ marketplaces: [] })
    await expect(reading).rejects.toThrow()
    expect(request).not.toHaveBeenCalledWith('plugin/list', expect.anything())
  })
  test('does not start plugin RPC for an observed offline or missing owner', async () => {
    const request = vi.fn()
    const api = createRemoteProjectDevicePluginApi('remote', request as never)
    api.observeDevice?.({ device_id: 'remote', device_type: 'remote', status: 'offline' } as never)
    await expect(api.installAvailablePlugin(item as never)).rejects.toThrow()
    api.observeDevice?.(null)
    await expect(api.readState()).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
  })
  test('never starts a plugin write after capability or runtime changes during its read', async () => {
    let finishRead!: (result: unknown) => void
    const request = vi.fn(async (method: string) =>
      method === 'plugin/installed'
        ? new Promise(resolve => {
            finishRead = resolve
          })
        : { marketplaces: [] }
    )
    const api = createRemoteProjectDevicePluginApi('remote', request as never)
    api.observeDevice?.({
      device_id: 'remote',
      device_type: 'remote',
      status: 'online',
      runtime_instance_id: 'old',
    } as never)
    const installing = api.installAvailablePlugin(item as never)
    api.observeDevice?.({
      device_id: 'remote',
      device_type: 'remote',
      status: 'online',
      runtime_instance_id: 'replacement',
      runtime_features: { schemaVersion: 4, projectEditing: { plugins: false } },
    } as never)
    finishRead({ marketplaces: [] })
    await expect(installing).rejects.toThrow()
    expect(request).not.toHaveBeenCalledWith('plugin/install', expect.anything())
    expect(request).not.toHaveBeenCalledWith('config/value/write', expect.anything())
  })
  test('invalidates unsupported knowledge after runtime instance, version, and status changes', async () => {
    const request = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'unsupported_method: Unsupported runtime RPC method: runtime.codex.app_server.request'
        )
      )
    const api = createRemoteProjectDevicePluginApi('remote', request as never)
    const device = {
      device_id: 'remote',
      device_type: 'remote',
      executor_version: '2.0.21',
      runtime_instance_id: 'old',
      status: 'online',
    } as const
    api.observeDevice?.(device as never)
    await expect(api.readState()).rejects.toMatchObject({ name: 'ProjectPluginsUnsupportedError' })
    request.mockResolvedValue({ marketplaces: [] })
    api.observeDevice?.({ ...device, runtime_instance_id: 'replacement' } as never)
    await expect(api.readState()).resolves.toMatchObject({ deviceId: 'remote' })
    request.mockRejectedValue(
      new Error('Unsupported runtime RPC method: runtime.codex.app_server.request')
    )
    api.observeDevice?.({ ...device, executor_version: '2.0.22' } as never)
    await expect(api.readState()).rejects.toMatchObject({ name: 'ProjectPluginsUnsupportedError' })
    request.mockResolvedValue({ marketplaces: [] })
    api.observeDevice?.({ ...device, status: 'offline' } as never)
    api.observeDevice?.({ ...device, status: 'online' } as never)
    await expect(api.readState()).resolves.toMatchObject({ deviceId: 'remote' })
  })

  test('explicit false capability never probes or writes', async () => {
    const request = vi.fn()
    const api = createRemoteProjectDevicePluginApi('remote', request as never)
    api.observeDevice?.({
      device_id: 'remote',
      device_type: 'remote',
      status: 'online',
      runtime_features: { schemaVersion: 4, projectEditing: { plugins: false } },
    } as never)
    await expect(api.readState()).rejects.toMatchObject({ name: 'ProjectPluginsUnsupportedError' })
    await expect(api.installAvailablePlugin(item as never)).rejects.toMatchObject({
      name: 'ProjectPluginsUnsupportedError',
    })
    expect(request).not.toHaveBeenCalled()
  })
  test.each(['', 'unsupported_method: ', 'runtime_rpc_failed: '])(
    'remembers an exact unsupported runtime dispatcher with %s without repeating probes or writes',
    async prefix => {
      const request = vi
        .fn()
        .mockRejectedValue(
          new Error(`${prefix}Unsupported runtime RPC method: runtime.codex.app_server.request`)
        )
      const api = createRemoteProjectDevicePluginApi('legacy', request as never)
      await expect(api.readState()).rejects.toMatchObject({
        name: 'ProjectPluginsUnsupportedError',
      })
      await expect(api.readState({ refresh: true })).rejects.toMatchObject({
        name: 'ProjectPluginsUnsupportedError',
      })
      await expect(api.installAvailablePlugin(item as never)).rejects.toMatchObject({
        name: 'ProjectPluginsUnsupportedError',
      })
      expect(request).toHaveBeenCalledTimes(1)
      expect(request).toHaveBeenCalledWith('plugin/installed', {})
    }
  )

  test.each([
    'Unauthorized',
    'Request timed out',
    'executor disconnected',
    'plugin/installed failed',
  ])('keeps %s visible as a genuine error', async message => {
    const request = vi.fn().mockRejectedValue(new Error(message))
    const api = createRemoteProjectDevicePluginApi('remote', request as never)
    await expect(api.readState()).rejects.toThrow(message)
    await expect(api.readState({ refresh: true })).rejects.toThrow(message)
    expect(request).toHaveBeenCalledTimes(2)
  })
  test('refreshes installed membership after an external uninstall', async () => {
    let installed = true
    const request = vi.fn(async (method: string) => ({
      marketplaces: [
        {
          name: 'team',
          path: '/device/plugins',
          plugins:
            method === 'plugin/installed' && !installed
              ? []
              : [{ id: 'quality@team', name: 'quality', installed, enabled: installed }],
        },
      ],
    }))
    const api = createRemoteProjectDevicePluginApi('remote', request as never)
    expect((await api.readState({ refresh: true })).marketplaceItems[0].installed).toBe(true)
    installed = false
    expect((await api.readState({ refresh: true })).marketplaceItems[0].installed).toBe(false)
  })
  test('keeps separate device inventories and disables only newly installed plugins', async () => {
    const requestA = vi.fn(async (method: string) =>
      method === 'plugin/installed'
        ? { marketplaces: [] }
        : {
            marketplaces: [
              {
                name: 'team',
                path: '/device/plugins',
                plugins: [
                  { id: 'quality@team', name: 'quality', installed: false, enabled: false },
                ],
              },
            ],
          }
    )
    const requestB = vi.fn(async () => ({ marketplaces: [] }))
    const a = createRemoteProjectDevicePluginApi('a', requestA as never)
    const b = createRemoteProjectDevicePluginApi('b', requestB as never)
    expect((await a.readState()).deviceId).toBe('a')
    expect((await b.readState()).marketplaceItems).toEqual([])
    await a.installAvailablePlugin(item as never)
    expect(requestA).toHaveBeenCalledWith('plugin/install', {
      marketplacePath: '/device/plugins',
      remoteMarketplaceName: null,
      pluginName: 'quality',
    })
    expect(requestA).toHaveBeenCalledWith('config/value/write', {
      keyPath: 'plugins."quality@team".enabled',
      value: false,
      mergeStrategy: 'upsert',
    })
    expect(requestB).not.toHaveBeenCalledWith('plugin/install', expect.anything())
  })

  test('preserves a globally enabled plugin when a stale catalog row says uninstalled', async () => {
    const request = vi.fn(async () => ({
      marketplaces: [
        {
          name: 'team',
          path: '/device/plugins',
          plugins: [{ id: 'quality@team', name: 'quality', installed: true, enabled: true }],
        },
      ],
    }))
    const api = createRemoteProjectDevicePluginApi('device', request as never)
    const installed = await api.installAvailablePlugin(item as never)
    expect(installed.spec.enabled).toBe(true)
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith('plugin/installed', {})
  })

  test('resolves a connector installation id through the target device plugin read', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'plugin/installed') return { marketplaces: [] }
      if (method === 'plugin/read')
        return {
          plugin: {
            summary: {
              id: 'plugin_connector_quality',
              name: 'quality',
              installed: false,
              enabled: false,
            },
          },
        }
      return { authPolicy: 'ON_USE', appsNeedingAuth: [] }
    })
    const api = createRemoteProjectDevicePluginApi('remote', request as never)
    await api.installAvailablePlugin({
      ...item,
      manifest: { id: 'quality@team', marketplaceId: 'team', marketplacePath: null },
    } as never)
    expect(request).toHaveBeenCalledWith('plugin/read', {
      marketplacePath: null,
      remoteMarketplaceName: 'team',
      pluginName: 'quality',
    })
    expect(request).toHaveBeenCalledWith('plugin/install', {
      marketplacePath: null,
      remoteMarketplaceName: 'team',
      pluginName: 'plugin_connector_quality',
    })
  })

  test('preserves enabled personal plugins across equivalent marketplace identities', async () => {
    const request = vi.fn(async () => ({
      marketplaces: [
        {
          name: CODEX_PERSONAL_MARKETPLACE_ID,
          path: '/device/plugins',
          plugins: [
            {
              id: `QUALITY@${CODEX_PERSONAL_MARKETPLACE_ID}`,
              name: 'QUALITY',
              installed: true,
              enabled: true,
            },
          ],
        },
      ],
    }))
    const api = createRemoteProjectDevicePluginApi('remote', request as never)
    const installed = await api.installAvailablePlugin({
      ...item,
      manifest: { marketplaceId: 'wework-personal' },
    } as never)
    expect(installed.spec.enabled).toBe(true)
    expect(request).toHaveBeenCalledTimes(1)
  })

  test('disables a newly accepted local install without rediscovering stale membership', async () => {
    const installed = toInstalledPlugin(
      { name: 'team', path: '/device/plugins', plugins: [] },
      { id: 'quality@team', name: 'quality', installed: true, enabled: true },
      undefined,
      key => key
    )
    const local = {
      readState: vi.fn().mockResolvedValue({ installedPlugins: [] }),
      installAvailablePlugin: vi.fn().mockResolvedValue(installed),
      updateInstalledPlugin: vi.fn().mockRejectedValue(new Error('Stale membership')),
    }
    const create = vi
      .spyOn(localPlugins, 'createLocalCodexPluginApi')
      .mockReturnValue(local as never)
    const write = vi.spyOn(localPlugins, 'writeCodexPluginEnabled').mockResolvedValue(undefined)
    try {
      const plugin = await createLocalProjectDevicePluginApi().installAvailablePlugin(item as never)
      expect(plugin.spec.enabled).toBe(false)
      expect(write).toHaveBeenCalledWith('quality@team', false)
      expect(local.updateInstalledPlugin).not.toHaveBeenCalled()
    } finally {
      create.mockRestore()
      write.mockRestore()
    }
  })
})
