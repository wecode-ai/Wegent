import { describe, expect, test, vi } from 'vitest'
import type { InstalledPlugin } from '@/types/api'
import { LocalPluginUninstallCleanupError } from '@/api/local/pluginUninstallError'
import { uninstallAccountPlugin, uninstallPluginIdentities } from './pluginUninstall'

function installedPlugin(origin: 'created' | 'market'): InstalledPlugin {
  return {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: { name: 'dev-tools', namespace: 'default', labels: { id: 'local-plugin' } },
    spec: {
      source: {
        type: origin === 'created' ? 'local' : 'marketplace',
        providerKey: 'wegent',
        pluginKey: 'dev-tools',
        catalogItemId: '71',
        marketplace: origin === 'created' ? 'wework-personal' : 'wegent',
      },
      origin,
      pluginId: origin === 'market' ? 71 : null,
      releaseId: origin === 'market' ? 82 : null,
      installState: 'installed',
      enabled: true,
      sourceProvider: origin === 'created' ? 'codex' : 'wegent',
      sourceLabel: '',
      displayName: 'Dev Tools',
      description: '',
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
      },
      interface: null,
      packageRef: null,
      sourcePayload:
        origin === 'created'
          ? { cloudPluginId: 71, cloudInstalledPluginId: 104 }
          : { localId: 104 },
    },
    status: { state: 'installed' },
  }
}

function managedStorePlugin(cloudInstalledPluginId: number | null = 104): InstalledPlugin {
  const plugin = installedPlugin('market')
  plugin.metadata.labels = { id: '104-wegent-dev-tools-1.0.0' }
  plugin.spec.pluginId = undefined
  plugin.spec.sourcePayload = {
    managedByWegent: true,
    cloudInstalledPluginId,
  }
  return plugin
}

function uninstallContext(items?: InstalledPlugin[]) {
  const cloud = installedPlugin('market')
  cloud.metadata.labels = { id: 104 }
  return {
    readLocalInstalled: vi.fn().mockResolvedValue({ items: [installedPlugin('created')] }),
    readCloudInstalled: vi.fn().mockResolvedValue({ items: items ?? [cloud] }),
    logoutLocal: vi.fn().mockResolvedValue(undefined),
    isCurrent: () => true,
  }
}

describe('uninstallAccountPlugin', () => {
  test('removes the exact fresh account record even when its device installation failed', async () => {
    const other = installedPlugin('market')
    other.metadata.labels = { id: 104 }
    other.spec.pluginId = 99
    const current = installedPlugin('market')
    current.metadata.labels = { id: 208 }
    current.spec.installState = 'failed'
    current.status = { state: 'failed', devices: [] }
    const context = uninstallContext([other, current])
    const uninstallCloud = vi.fn().mockResolvedValue(undefined)
    const uninstallLocal = vi.fn()
    const operations = { ...context, uninstallCloud, uninstallLocal }

    await uninstallAccountPlugin('71', 'device-1', operations)

    expect(context.readCloudInstalled).toHaveBeenCalledOnce()
    expect(uninstallCloud).toHaveBeenCalledOnce()
    expect(uninstallCloud).toHaveBeenCalledWith(208, 'device-1')
    expect(uninstallCloud).not.toHaveBeenCalledWith(104, expect.anything())
    expect(context.readCloudInstalled.mock.invocationCallOrder[0]).toBeLessThan(
      uninstallCloud.mock.invocationCallOrder[0]
    )
    expect(context.readLocalInstalled).not.toHaveBeenCalled()
    expect(context.logoutLocal).not.toHaveBeenCalled()
    expect(uninstallLocal).not.toHaveBeenCalled()
  })

  test('succeeds idempotently when a fresh account read contains only a same-name plugin', async () => {
    const other = installedPlugin('market')
    other.metadata.labels = { id: 104 }
    other.spec.pluginId = 99
    const context = uninstallContext([other])
    const uninstallCloud = vi.fn()

    await expect(
      uninstallAccountPlugin(71, undefined, { ...context, uninstallCloud })
    ).resolves.toBeUndefined()

    expect(context.readCloudInstalled).toHaveBeenCalledOnce()
    expect(uninstallCloud).not.toHaveBeenCalled()
    expect(context.readLocalInstalled).not.toHaveBeenCalled()
    expect(context.logoutLocal).not.toHaveBeenCalled()
  })

  test.each([
    ['wegent-market', null],
    ['wegent-market', undefined],
    ['wegent-market', 0],
    ['wegent-market', NaN],
    ['unknown-provider', null],
    ['unknown-provider', undefined],
  ] as const)(
    'does not confirm absence when a foreign %s catalog row has invalid plugin identity %s',
    async (providerKey, pluginId) => {
      const other = installedPlugin('market')
      other.metadata.labels = { id: 208 }
      other.spec.pluginId = pluginId
      other.spec.source.providerKey = providerKey
      const context = uninstallContext([other])
      const uninstallCloud = vi.fn()

      await expect(
        uninstallAccountPlugin(71, 'device-1', { ...context, uninstallCloud })
      ).rejects.toThrow('PLUGIN_UNINSTALL_PREFLIGHT_FAILED')

      expect(context.readCloudInstalled).toHaveBeenCalledOnce()
      expect(uninstallCloud).not.toHaveBeenCalled()
    }
  )

  test.each([
    ['upload', 'codex-local', null, null],
    ['upload', 'codex-local', undefined, undefined],
    ['marketplace', 'wegent-marketplace', '55', null],
    ['marketplace', 'wegent-marketplace', '55', undefined],
  ] as const)(
    'confirms absence alongside an actual legacy %s/%s row with catalog %s and plugin %s',
    async (type, providerKey, catalogItemId, pluginId) => {
      const legacy = installedPlugin('market')
      legacy.metadata.labels = { id: 208 }
      legacy.spec.pluginId = pluginId
      legacy.spec.source = {
        ...legacy.spec.source,
        type,
        providerKey,
        catalogItemId,
      }
      const other = installedPlugin('market')
      other.metadata.labels = { id: 209 }
      other.spec.pluginId = 99
      const context = uninstallContext([legacy, other])
      const uninstallCloud = vi.fn()

      await expect(
        uninstallAccountPlugin(71, 'device-1', { ...context, uninstallCloud })
      ).resolves.toBeUndefined()

      expect(context.readCloudInstalled).toHaveBeenCalledOnce()
      expect(uninstallCloud).not.toHaveBeenCalled()
      expect(context.readLocalInstalled).not.toHaveBeenCalled()
      expect(context.logoutLocal).not.toHaveBeenCalled()
    }
  )

  test.each([
    ['upload', 'codex-local', '55', undefined],
    ['marketplace', 'wegent-marketplace', undefined, undefined],
    ['marketplace', 'wegent-marketplace', '0', undefined],
    ['marketplace', 'wegent-marketplace', '55', 0],
  ] as const)(
    'rejects a foreign row that only resembles legacy source %s/%s with catalog %s and plugin %s',
    async (type, providerKey, catalogItemId, pluginId) => {
      const other = installedPlugin('market')
      other.metadata.labels = { id: 208 }
      other.spec.pluginId = pluginId
      other.spec.source = { ...other.spec.source, type, providerKey, catalogItemId }
      const context = uninstallContext([other])
      const uninstallCloud = vi.fn()

      await expect(
        uninstallAccountPlugin(71, 'device-1', { ...context, uninstallCloud })
      ).rejects.toThrow('PLUGIN_UNINSTALL_PREFLIGHT_FAILED')

      expect(uninstallCloud).not.toHaveBeenCalled()
    }
  )

  test('rejects globally duplicate installation ids even when their catalog ids differ', async () => {
    const current = installedPlugin('market')
    current.metadata.labels = { id: 208 }
    const other = installedPlugin('market')
    other.metadata.labels = { id: '208' }
    other.spec.pluginId = 99
    const context = uninstallContext([current, other])
    const uninstallCloud = vi.fn()

    await expect(
      uninstallAccountPlugin(71, 'device-1', { ...context, uninstallCloud })
    ).rejects.toThrow('PLUGIN_UNINSTALL_PREFLIGHT_FAILED')

    expect(uninstallCloud).not.toHaveBeenCalled()
  })

  test.each(['spec', 'source', 'installation-id'] as const)(
    'rejects an invalid foreign %s before deleting a valid exact match',
    async invalidField => {
      const current = installedPlugin('market')
      current.metadata.labels = { id: 208 }
      const other = installedPlugin('market')
      other.metadata.labels = { id: invalidField === 'installation-id' ? 'local-id' : 209 }
      other.spec.pluginId = 99
      const foreign =
        invalidField === 'spec'
          ? { ...other, spec: null }
          : invalidField === 'source'
            ? { ...other, spec: { ...other.spec, source: null } }
            : other
      const context = uninstallContext()
      context.readCloudInstalled.mockResolvedValue({ items: [current, foreign] })
      const uninstallCloud = vi.fn()

      await expect(
        uninstallAccountPlugin(71, 'device-1', { ...context, uninstallCloud })
      ).rejects.toThrow('PLUGIN_UNINSTALL_PREFLIGHT_FAILED')

      expect(uninstallCloud).not.toHaveBeenCalled()
    }
  )

  test('rejects invalid catalog identities before reading or deleting account state', async () => {
    const context = uninstallContext()
    const uninstallCloud = vi.fn()

    for (const pluginId of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1, '0', '071', 'local-id']) {
      await expect(
        uninstallAccountPlugin(pluginId, undefined, { ...context, uninstallCloud })
      ).rejects.toThrow('PLUGIN_UNINSTALL_PREFLIGHT_FAILED')
    }

    expect(context.readCloudInstalled).not.toHaveBeenCalled()
    expect(uninstallCloud).not.toHaveBeenCalled()
  })

  test('rejects duplicate fresh records for the exact catalog identity', async () => {
    const first = installedPlugin('market')
    first.metadata.labels = { id: 208 }
    const second = installedPlugin('market')
    second.metadata.labels = { id: 209 }
    const context = uninstallContext([first, second])
    const uninstallCloud = vi.fn()

    await expect(
      uninstallAccountPlugin(71, 'device-1', { ...context, uninstallCloud })
    ).rejects.toThrow('PLUGIN_UNINSTALL_PREFLIGHT_FAILED')

    expect(uninstallCloud).not.toHaveBeenCalled()
  })

  test('rejects an exact catalog match with an invalid account installation identity', async () => {
    const context = uninstallContext()
    const uninstallCloud = vi.fn()

    for (const id of [undefined, 0, -1, 1.5, '0', 'local-id']) {
      const current = installedPlugin('market')
      current.metadata.labels = { id }
      context.readCloudInstalled.mockResolvedValue({ items: [current] })
      await expect(
        uninstallAccountPlugin(71, 'device-1', { ...context, uninstallCloud })
      ).rejects.toThrow('PLUGIN_UNINSTALL_PREFLIGHT_FAILED')
    }

    expect(uninstallCloud).not.toHaveBeenCalled()
  })

  test('rejects an incomplete account inventory instead of treating it as absence', async () => {
    const context = uninstallContext()
    context.readCloudInstalled.mockResolvedValue({})
    const uninstallCloud = vi.fn()

    await expect(
      uninstallAccountPlugin(71, 'device-1', { ...context, uninstallCloud })
    ).rejects.toThrow('PLUGIN_UNINSTALL_PREFLIGHT_FAILED')

    expect(uninstallCloud).not.toHaveBeenCalled()
  })

  test('does not delete when fresh account inventory is unavailable', async () => {
    const context = uninstallContext()
    context.readCloudInstalled.mockRejectedValue(new Error('Account inventory unavailable'))
    const uninstallCloud = vi.fn()

    await expect(
      uninstallAccountPlugin(71, 'device-1', { ...context, uninstallCloud })
    ).rejects.toThrow('PLUGIN_UNINSTALL_PREFLIGHT_FAILED')

    expect(uninstallCloud).not.toHaveBeenCalled()
  })

  test('does not read or delete after the initiating account scope already changed', async () => {
    const context = uninstallContext()
    const uninstallCloud = vi.fn()

    await expect(
      uninstallAccountPlugin(71, 'device-1', {
        ...context,
        isCurrent: () => false,
        uninstallCloud,
      })
    ).rejects.toThrow(/cancelled/i)

    expect(context.readCloudInstalled).not.toHaveBeenCalled()
    expect(uninstallCloud).not.toHaveBeenCalled()
  })

  test('does not delete after the account scope changes during inventory loading', async () => {
    let current = true
    let finish!: (value: { items: InstalledPlugin[] }) => void
    const context = uninstallContext()
    context.readCloudInstalled.mockReturnValue(
      new Promise(resolve => {
        finish = resolve
      })
    )
    const uninstallCloud = vi.fn()
    const pending = uninstallAccountPlugin(71, 'device-1', {
      ...context,
      isCurrent: () => current,
      uninstallCloud,
    })
    const record = installedPlugin('market')
    record.metadata.labels = { id: 208 }
    current = false
    finish({ items: [record] })

    await expect(pending).rejects.toThrow(/cancelled/i)
    expect(uninstallCloud).not.toHaveBeenCalled()
  })

  test('does not report success after the account scope changes during deletion', async () => {
    let current = true
    let finish!: () => void
    const context = uninstallContext()
    const uninstallCloud = vi.fn().mockReturnValue(
      new Promise<void>(resolve => {
        finish = resolve
      })
    )
    const pending = uninstallAccountPlugin(71, 'device-1', {
      ...context,
      isCurrent: () => current,
      uninstallCloud,
    })
    await vi.waitFor(() => expect(uninstallCloud).toHaveBeenCalledOnce())
    expect(uninstallCloud).toHaveBeenCalledWith(104, 'device-1')
    current = false
    finish()

    await expect(pending).rejects.toThrow(/cancelled/i)
  })
})

describe('uninstallPluginIdentities', () => {
  test('removes the cloud installation before a linked local plugin', async () => {
    const uninstallCloud = vi.fn().mockResolvedValue(undefined)
    const uninstallLocal = vi.fn().mockResolvedValue(undefined)

    const outcome = await uninstallPluginIdentities(
      installedPlugin('created'),
      'local-plugin',
      'device-1',
      {
        ...uninstallContext(),
        uninstallCloud,
        uninstallLocal,
      }
    )

    expect(outcome.warnings).toEqual([])
    expect(uninstallCloud).toHaveBeenCalledWith(104, 'device-1')
    expect(uninstallLocal).toHaveBeenCalledWith('local-plugin')
    expect(uninstallCloud.mock.invocationCallOrder[0]).toBeLessThan(
      uninstallLocal.mock.invocationCallOrder[0]
    )
  })

  test('only calls the cloud API for a cloud-managed plugin', async () => {
    const uninstallCloud = vi.fn().mockResolvedValue(undefined)
    const uninstallLocal = vi.fn().mockResolvedValue(undefined)

    await uninstallPluginIdentities(installedPlugin('market'), 104, 'device-1', {
      ...uninstallContext(),
      uninstallCloud,
      uninstallLocal,
    })

    expect(uninstallCloud).toHaveBeenCalledWith(104, 'device-1')
    expect(uninstallLocal).not.toHaveBeenCalled()
  })

  test('only calls the cloud API for a Wegent managed store package', async () => {
    const uninstallCloud = vi.fn().mockResolvedValue(undefined)
    const uninstallLocal = vi.fn().mockResolvedValue(undefined)

    await uninstallPluginIdentities(
      managedStorePlugin(),
      '104-wegent-dev-tools-1.0.0',
      'device-1',
      { ...uninstallContext(), uninstallCloud, uninstallLocal }
    )

    expect(uninstallCloud).toHaveBeenCalledWith(104, 'device-1')
    expect(uninstallLocal).not.toHaveBeenCalled()
  })

  test('does not fall back to local uninstall when a managed store account id is missing', async () => {
    const uninstallCloud = vi.fn().mockResolvedValue(undefined)
    const uninstallLocal = vi.fn().mockResolvedValue(undefined)

    await expect(
      uninstallPluginIdentities(
        managedStorePlugin(null),
        '104-wegent-dev-tools-1.0.0',
        'device-1',
        { ...uninstallContext(), uninstallCloud, uninstallLocal }
      )
    ).rejects.toThrow(/account install id is unavailable/i)

    expect(uninstallCloud).not.toHaveBeenCalled()
    expect(uninstallLocal).not.toHaveBeenCalled()
  })

  test('does not remove the local plugin when cloud uninstall fails', async () => {
    const cloudError = new Error('Cloud unavailable')
    const uninstallCloud = vi.fn().mockRejectedValue(cloudError)
    const uninstallLocal = vi.fn().mockResolvedValue(undefined)

    await expect(
      uninstallPluginIdentities(installedPlugin('created'), 'local-plugin', 'device-1', {
        ...uninstallContext(),
        uninstallCloud,
        uninstallLocal,
      })
    ).rejects.toThrow('Cloud unavailable')

    expect(uninstallLocal).not.toHaveBeenCalled()
  })

  test('does not remove the local plugin when the cloud install id is missing', async () => {
    const plugin = installedPlugin('created')
    plugin.spec.sourcePayload = { cloudPluginId: 71 }
    const uninstallCloud = vi.fn().mockResolvedValue(undefined)
    const uninstallLocal = vi.fn().mockResolvedValue(undefined)

    await expect(
      uninstallPluginIdentities(plugin, 'local-plugin', 'device-1', {
        ...uninstallContext(),
        uninstallCloud,
        uninstallLocal,
      })
    ).rejects.toThrow(/account install id is unavailable/i)

    expect(uninstallCloud).not.toHaveBeenCalled()
    expect(uninstallLocal).not.toHaveBeenCalled()
  })

  test('reports cleanup failure after a completed local uninstall', async () => {
    const cleanupError = new LocalPluginUninstallCleanupError('Plugin alias cleanup failed')
    const uninstallCloud = vi.fn().mockResolvedValue(undefined)
    const uninstallLocal = vi.fn().mockRejectedValue(cleanupError)

    const outcome = await uninstallPluginIdentities(
      installedPlugin('created'),
      'local-plugin',
      'device-1',
      {
        ...uninstallContext(),
        uninstallCloud,
        uninstallLocal,
      }
    )

    expect(outcome.warnings).toEqual([cleanupError])
  })

  test('rejects when the local plugin itself could not be removed', async () => {
    const uninstallCloud = vi.fn().mockResolvedValue(undefined)
    const uninstallLocal = vi.fn().mockRejectedValue(new Error('Local uninstall failed'))

    await expect(
      uninstallPluginIdentities(installedPlugin('created'), 'local-plugin', 'device-1', {
        ...uninstallContext(),
        uninstallCloud,
        uninstallLocal,
      })
    ).rejects.toThrow('Local uninstall failed')
  })

  test('uninstalls an independent published source after confirming no account install exists', async () => {
    const plugin = installedPlugin('created')
    plugin.spec.sourcePayload = { cloudPluginId: 71, cloudReleaseId: null }
    const context = uninstallContext([])
    const uninstallCloud = vi.fn()
    const uninstallLocal = vi.fn().mockResolvedValue(undefined)

    await uninstallPluginIdentities(plugin, 'local-plugin', 'device-1', {
      ...context,
      uninstallCloud,
      uninstallLocal,
    })

    expect(context.readCloudInstalled).toHaveBeenCalledWith()
    expect(uninstallCloud).not.toHaveBeenCalled()
    expect(context.logoutLocal).toHaveBeenCalledOnce()
    expect(uninstallLocal).toHaveBeenCalledWith('local-plugin')
    expect(context.logoutLocal.mock.invocationCallOrder[0]).toBeLessThan(
      uninstallLocal.mock.invocationCallOrder[0]
    )
  })

  test('uses the current account record instead of a stale install id on the source', async () => {
    const plugin = installedPlugin('created')
    plugin.spec.sourcePayload = {
      cloudPluginId: 71,
      cloudReleaseId: 82,
      cloudInstalledPluginId: 104,
    }
    const cloud = installedPlugin('market')
    cloud.metadata.labels = { id: 208 }
    const context = uninstallContext([cloud])
    const uninstallCloud = vi.fn().mockResolvedValue(undefined)
    const uninstallLocal = vi.fn().mockResolvedValue(undefined)

    await uninstallPluginIdentities(plugin, 'local-plugin', 'device-1', {
      ...context,
      uninstallCloud,
      uninstallLocal,
    })

    expect(uninstallCloud).toHaveBeenCalledWith(208, 'device-1')
    expect(uninstallCloud).not.toHaveBeenCalledWith(104, 'device-1')
    expect(uninstallCloud.mock.invocationCallOrder[0]).toBeLessThan(
      context.logoutLocal.mock.invocationCallOrder[0]
    )
    expect(context.logoutLocal.mock.invocationCallOrder[0]).toBeLessThan(
      uninstallLocal.mock.invocationCallOrder[0]
    )
  })

  test('does not use a same-name plugin or another account install id', async () => {
    const plugin = installedPlugin('created')
    plugin.spec.sourcePayload = { cloudPluginId: 71, cloudReleaseId: 82 }
    const other = installedPlugin('market')
    other.spec.pluginId = 99
    other.metadata.labels = { id: 104 }
    const context = uninstallContext([other])
    const uninstallCloud = vi.fn()
    const uninstallLocal = vi.fn().mockResolvedValue(undefined)

    await uninstallPluginIdentities(plugin, 'local-plugin', 'device-1', {
      ...context,
      uninstallCloud,
      uninstallLocal,
    })

    expect(context.readCloudInstalled).toHaveBeenCalledOnce()
    expect(uninstallCloud).not.toHaveBeenCalled()
    expect(uninstallLocal).toHaveBeenCalledWith('local-plugin')
  })

  test('does not log out or uninstall when the current account inventory is unavailable', async () => {
    const context = uninstallContext()
    context.readCloudInstalled.mockRejectedValue(new Error('Account inventory unavailable'))
    const uninstallCloud = vi.fn()
    const uninstallLocal = vi.fn()

    await expect(
      uninstallPluginIdentities(installedPlugin('created'), 'local-plugin', 'device-1', {
        ...context,
        uninstallCloud,
        uninstallLocal,
      })
    ).rejects.toThrow()

    expect(context.logoutLocal).not.toHaveBeenCalled()
    expect(uninstallCloud).not.toHaveBeenCalled()
    expect(uninstallLocal).not.toHaveBeenCalled()
  })

  test('stops after the account scope changes during inventory loading', async () => {
    let current = true
    let finish!: (value: { items: InstalledPlugin[] }) => void
    const context = uninstallContext()
    context.readCloudInstalled.mockReturnValue(
      new Promise(resolve => {
        finish = resolve
      })
    )
    const uninstallCloud = vi.fn()
    const uninstallLocal = vi.fn()
    const pending = uninstallPluginIdentities(
      installedPlugin('created'),
      'local-plugin',
      'device-1',
      {
        ...context,
        isCurrent: () => current,
        uninstallCloud,
        uninstallLocal,
      }
    )
    current = false
    finish({ items: [] })

    await expect(pending).rejects.toThrow(/cancelled/i)
    expect(context.logoutLocal).not.toHaveBeenCalled()
    expect(uninstallCloud).not.toHaveBeenCalled()
    expect(uninstallLocal).not.toHaveBeenCalled()
  })

  test('uninstalls an unbound local plugin offline', async () => {
    const plugin = installedPlugin('created')
    plugin.spec.sourcePayload = {}
    const context = uninstallContext()
    context.readLocalInstalled.mockResolvedValue({ items: [plugin] })
    context.readCloudInstalled.mockRejectedValue(new Error('Offline'))
    const uninstallCloud = vi.fn()
    const uninstallLocal = vi.fn().mockResolvedValue(undefined)

    await uninstallPluginIdentities(plugin, 'local-plugin', 'device-1', {
      ...context,
      uninstallCloud,
      uninstallLocal,
    })

    expect(context.readCloudInstalled).not.toHaveBeenCalled()
    expect(uninstallCloud).not.toHaveBeenCalled()
    expect(context.logoutLocal).toHaveBeenCalledOnce()
    expect(uninstallLocal).toHaveBeenCalledWith('local-plugin')
  })

  test.each(['unavailable', 'missing', 'duplicate', 'scope-changed'] as const)(
    'does not clean up an apparently unbound plugin when strict local identity is %s',
    async failure => {
      const plugin = installedPlugin('created')
      plugin.spec.sourcePayload = {}
      const context = uninstallContext()
      if (failure === 'unavailable') {
        context.readLocalInstalled.mockRejectedValue(new Error('Publication links unavailable'))
      } else {
        context.readLocalInstalled.mockResolvedValue({
          items: failure === 'missing' ? [] : [plugin, plugin],
        })
      }
      const uninstallCloud = vi.fn()
      const uninstallLocal = vi.fn()
      await expect(
        uninstallPluginIdentities(plugin, 'local-plugin', 'device-1', {
          ...context,
          isCurrent: () =>
            failure !== 'scope-changed' || context.readLocalInstalled.mock.calls.length === 0,
          uninstallCloud,
          uninstallLocal,
        })
      ).rejects.toThrow(
        failure === 'scope-changed' ? /cancelled/i : 'PLUGIN_UNINSTALL_PREFLIGHT_FAILED'
      )
      expect(context.readCloudInstalled).not.toHaveBeenCalled()
      expect(context.logoutLocal).not.toHaveBeenCalled()
      expect(uninstallCloud).not.toHaveBeenCalled()
      expect(uninstallLocal).not.toHaveBeenCalled()
    }
  )

  test('recovers publication links omitted from a rendered local summary before uninstall', async () => {
    const plugin = installedPlugin('created')
    plugin.spec.sourcePayload = {}
    const context = uninstallContext()
    const uninstallCloud = vi.fn().mockResolvedValue(undefined)
    const uninstallLocal = vi.fn().mockResolvedValue(undefined)
    await uninstallPluginIdentities(plugin, 'local-plugin', 'device-1', {
      ...context,
      uninstallCloud,
      uninstallLocal,
    })
    expect(context.readLocalInstalled).toHaveBeenCalledOnce()
    expect(context.readCloudInstalled).toHaveBeenCalledOnce()
    expect(uninstallCloud).toHaveBeenCalledWith(104, 'device-1')
    expect(uninstallCloud.mock.invocationCallOrder[0]).toBeLessThan(
      context.logoutLocal.mock.invocationCallOrder[0]
    )
    expect(uninstallLocal).toHaveBeenCalledWith('local-plugin')
  })

  test('recovers a managed package installation by its exact catalog id', async () => {
    const plugin = managedStorePlugin(null)
    plugin.spec.sourcePayload = { ...plugin.spec.sourcePayload, cloudPluginId: 71 }
    const cloud = installedPlugin('market')
    cloud.metadata.labels = { id: 208 }
    const context = uninstallContext([cloud])
    const uninstallCloud = vi.fn().mockResolvedValue(undefined)
    const uninstallLocal = vi.fn()

    await uninstallPluginIdentities(plugin, '104-wegent-dev-tools-1.0.0', 'device-1', {
      ...context,
      uninstallCloud,
      uninstallLocal,
    })

    expect(context.readCloudInstalled).toHaveBeenCalledOnce()
    expect(uninstallCloud).toHaveBeenCalledWith(208, 'device-1')
    expect(uninstallLocal).not.toHaveBeenCalled()
  })

  test('rejects conflicting catalog and installation identities before cleanup', async () => {
    const other = installedPlugin('market')
    other.metadata.labels = { id: 104 }
    other.spec.pluginId = 99
    const current = installedPlugin('market')
    current.metadata.labels = { id: 208 }
    const context = uninstallContext([other, current])
    const uninstallCloud = vi.fn()
    const uninstallLocal = vi.fn()

    await expect(
      uninstallPluginIdentities(installedPlugin('created'), 'local-plugin', 'device-1', {
        ...context,
        uninstallCloud,
        uninstallLocal,
      })
    ).rejects.toThrow('PLUGIN_UNINSTALL_PREFLIGHT_FAILED')

    expect(uninstallCloud).not.toHaveBeenCalled()
    expect(context.logoutLocal).not.toHaveBeenCalled()
    expect(uninstallLocal).not.toHaveBeenCalled()
  })

  test('does not trust a managed package install id absent from the current account', async () => {
    const context = uninstallContext([])
    const uninstallCloud = vi.fn()
    const uninstallLocal = vi.fn()

    await expect(
      uninstallPluginIdentities(managedStorePlugin(), '104-wegent-dev-tools-1.0.0', 'device-1', {
        ...context,
        uninstallCloud,
        uninstallLocal,
      })
    ).rejects.toThrow('PLUGIN_UNINSTALL_PREFLIGHT_FAILED')

    expect(uninstallCloud).not.toHaveBeenCalled()
    expect(context.logoutLocal).not.toHaveBeenCalled()
    expect(uninstallLocal).not.toHaveBeenCalled()
  })

  test.each(['cloud', 'logout'] as const)(
    'stops local removal when scope changes during %s cleanup',
    async stage => {
      let current = true
      let finish!: () => void
      const pendingCleanup = new Promise<void>(resolve => {
        finish = resolve
      })
      const context = uninstallContext()
      const uninstallCloud = vi.fn().mockResolvedValue(undefined)
      const uninstallLocal = vi.fn()
      if (stage === 'cloud') uninstallCloud.mockReturnValue(pendingCleanup)
      else context.logoutLocal.mockReturnValue(pendingCleanup)
      const pending = uninstallPluginIdentities(
        installedPlugin('created'),
        'local-plugin',
        'device-1',
        {
          ...context,
          isCurrent: () => current,
          uninstallCloud,
          uninstallLocal,
        }
      )
      await vi.waitFor(() =>
        expect(stage === 'cloud' ? uninstallCloud : context.logoutLocal).toHaveBeenCalledOnce()
      )
      current = false
      finish()

      await expect(pending).rejects.toThrow(/cancelled/i)
      expect(uninstallLocal).not.toHaveBeenCalled()
      if (stage === 'cloud') expect(context.logoutLocal).not.toHaveBeenCalled()
    }
  )
})
