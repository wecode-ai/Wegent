import dingtalkManifest from '../../dsh/connection-dingtalk/package.json'
import { expect, it, vi } from 'vitest'
import type { ConnectionProviderDescriptor } from './standIn'
import type { ConnectionDependencyPluginApi } from './standInConnectionDependencies'
import { installStandInConnectionDependencies } from './standInConnectionDependencies'

function fixture() {
  const dependency = {
    alias: 'dingtalk',
    status: 'missing',
    version: '*',
    source: { ...dingtalkManifest.wework.connections.dependencies.dingtalk.source },
  }
  const provider: ConnectionProviderDescriptor = {
    id: 'connection/dingtalk',
    displayName: 'DingTalk',
    resourceKinds: ['group'],
    availability: { status: 'dependency_missing' },
    dependencies: [dependency],
  }
  const item = {
    id: 42,
    name: 'dingtalk',
    sourceProvider: 'wegent',
    visibility: 'public',
    version: '1.0.0',
    installed: false,
    enabled: false,
  }
  const listMarketplacePlugins = vi.fn(async () => ({ items: [item] }))
  const installMarketplacePlugin = vi.fn(async () => {
    dependency.status = 'ready'
    return {}
  })
  const options = {
    deviceId: 'device',
    providerId: provider.id,
    aliases: ['dingtalk'],
    catalog: vi.fn(async () => ({ items: [provider] })),
    installNative: vi.fn(async () => ({})),
    plugins: {
      listMarketplacePlugins,
      installMarketplacePlugin,
    } as unknown as ConnectionDependencyPluginApi,
  }
  return { dependency, provider, item, options, listMarketplacePlugins, installMarketplacePlugin }
}

it('installs the official default-market dependency through the existing device installer and verifies runtime readiness', async () => {
  const f = fixture()
  await installStandInConnectionDependencies(f.options)
  expect(f.listMarketplacePlugins).toHaveBeenCalledWith({ source: 'wegent', deviceId: 'device' })
  expect(f.installMarketplacePlugin).toHaveBeenCalledWith(42, 'device')
  expect(f.options.catalog).toHaveBeenCalledTimes(2)
  expect(f.options.installNative).not.toHaveBeenCalled()
})

it('requires a cloud connection instead of attempting a native install for a cloud dependency', async () => {
  const f = fixture()
  await expect(
    installStandInConnectionDependencies({ ...f.options, plugins: undefined })
  ).rejects.toMatchObject({ code: 'dependency_cloud_required' })
  expect(f.options.installNative).not.toHaveBeenCalled()
})

it.each(['user', 'codex'])(
  'does not substitute a same-named %s listing for the declared official source',
  async source => {
    const f = fixture()
    f.item.sourceProvider = source
    await expect(installStandInConnectionDependencies(f.options)).rejects.toMatchObject({
      code: 'dependency_catalog_unavailable',
    })
    expect(f.installMarketplacePlugin).not.toHaveBeenCalled()
  }
)

it('rejects an ambiguous official catalog before installing', async () => {
  const f = fixture()
  f.listMarketplacePlugins.mockResolvedValue({ items: [f.item, { ...f.item, id: 43 }] })
  await expect(installStandInConnectionDependencies(f.options)).rejects.toMatchObject({
    code: 'dependency_catalog_unavailable',
  })
  expect(f.installMarketplacePlugin).not.toHaveBeenCalled()
})

it('preserves platform authentication and permission errors', async () => {
  const f = fixture()
  const denied = Object.assign(new Error('Forbidden'), { status: 403 })
  f.listMarketplacePlugins.mockRejectedValue(denied)
  await expect(installStandInConnectionDependencies(f.options)).rejects.toBe(denied)
  expect(f.installMarketplacePlugin).not.toHaveBeenCalled()
})

it('does not enable or upgrade an existing incompatible dependency', async () => {
  for (const status of ['disabled', 'incompatible']) {
    const f = fixture()
    f.dependency.status = status
    await expect(installStandInConnectionDependencies(f.options)).rejects.toMatchObject({
      code: 'dependency_conflict',
    })
    expect(f.installMarketplacePlugin).not.toHaveBeenCalled()
  }
  const f = fixture()
  f.dependency.version = '^2.0.0'
  await expect(installStandInConnectionDependencies(f.options)).rejects.toMatchObject({
    code: 'dependency_conflict',
  })
  expect(f.installMarketplacePlugin).not.toHaveBeenCalled()
})

it('does not claim success for an account install that is still unavailable on the execution device', async () => {
  const f = fixture()
  f.installMarketplacePlugin.mockImplementation(async () => ({}))
  await expect(installStandInConnectionDependencies(f.options)).rejects.toMatchObject({
    code: 'dependency_not_ready',
  })
})

it('rejects undeclared aliases before reading or mutating cloud installations', async () => {
  const f = fixture()
  await expect(
    installStandInConnectionDependencies({ ...f.options, aliases: ['other'] })
  ).rejects.toMatchObject({ code: 'invalid_dependency' })
  expect(f.listMarketplacePlugins).not.toHaveBeenCalled()
  expect(f.installMarketplacePlugin).not.toHaveBeenCalled()
})

it('keeps native marketplace dependencies on their existing exact-source installation path', async () => {
  const f = fixture()
  f.dependency.source = { marketplaceId: 'company', pluginId: 'dingtalk@company' }
  await installStandInConnectionDependencies(f.options)
  expect(f.options.installNative).toHaveBeenCalledWith(['dingtalk'])
  expect(f.listMarketplacePlugins).not.toHaveBeenCalled()
})

it.each(['workspace', 'personal'])(
  'rejects a same-named official listing from the wrong %s marketplace before installation',
  async visibility => {
    const f = fixture()
    f.item.visibility = visibility
    await expect(installStandInConnectionDependencies(f.options)).rejects.toMatchObject({
      code: 'dependency_catalog_unavailable',
    })
    expect(f.installMarketplacePlugin).not.toHaveBeenCalled()
  }
)

it('also installs workspace-scoped official dependencies through their exact wegent identity', async () => {
  const f = fixture()
  f.item.visibility = 'workspace'
  f.dependency.source = { marketplaceId: 'wegent', pluginId: 'dingtalk@wegent' }
  await installStandInConnectionDependencies(f.options)
  expect(f.installMarketplacePlugin).toHaveBeenCalledWith(42, 'device')
})
