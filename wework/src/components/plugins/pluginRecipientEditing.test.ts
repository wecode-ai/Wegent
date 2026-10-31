import { describe, expect, test } from 'vitest'
import {
  toInstalledPlugin,
  toWegentStoreInstalledPlugin,
} from '@wegent/chat-core/codex-installed-plugins'
import { mergeLocalInstalledWithStorePackages } from '@wegent/chat-core/installed-plugin-merge'
import { toInstalledPluginItem } from './installedPluginPresentation'
import {
  marketplaceItemOwnsLocalCreatedPackage,
  resolveContinueEditingPluginKey,
} from './pluginOwnerLocalPackage'

const translate = (key: string) => key
const store = toWegentStoreInstalledPlugin(
  {
    packageId: '42-wework-personal-tianhe-direct-1.0.0',
    marketplace: 'wework-personal',
    name: 'tianhe-direct',
    version: '1.0.0',
    enabled: true,
    pluginPath: '/tmp/recipient/plugin-store/42-wework-personal-tianhe-direct-1.0.0',
    cloudPluginId: 42,
    installedPluginId: 75,
  },
  '/tmp/recipient/plugin-store',
  translate
)

describe('personal share recipient editing permission audit', () => {
  test('a managed store row alone has no continue editing action', () => {
    expect(
      resolveContinueEditingPluginKey({
        packableCreated: null,
        currentPlugin: toInstalledPluginItem(store),
        listing: { accessRole: 'recipient', visibility: 'personal', latestReleaseId: 100 },
      })
    ).toBeNull()
  })

  test('a recipient remains read only after Codex membership is merged with the managed store', () => {
    // Capability sync registers personal shares in this same local marketplace.
    const codexMembership = toInstalledPlugin(
      {
        name: 'wework-personal',
        path: '/tmp/recipient/capabilities/bundled-marketplaces/wework-personal',
        plugins: [],
      },
      {
        id: 'tianhe-direct@wework-personal',
        name: 'tianhe-direct',
        installed: true,
        enabled: true,
        localVersion: '1.0.0',
        source: { source: 'local', path: './plugins/tianhe-direct' },
      },
      null,
      translate
    )
    const [merged] = mergeLocalInstalledWithStorePackages([codexMembership], [store])
    expect(merged.spec.sourcePayload?.managedByWegent).toBe(true)
    expect(merged.spec.sourcePayload?.cloudPluginId).toBe(42)
    const recipientListing = {
      accessRole: 'recipient' as const,
      visibility: 'personal' as const,
      latestReleaseId: 100,
    }
    expect(marketplaceItemOwnsLocalCreatedPackage(recipientListing)).toBe(false)

    // This matches PluginsWorkspace's marketplace-detail call: the recipient
    // check cleared packableCreated but the installed detail is still passed.
    expect(
      resolveContinueEditingPluginKey({
        packableCreated: null,
        currentPlugin: toInstalledPluginItem(merged),
        listing: recipientListing,
      })
    ).toBeNull()
  })
})
