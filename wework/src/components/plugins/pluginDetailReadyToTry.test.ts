import { describe, expect, test } from 'vitest'
import type { InstalledPlugin, PluginMarketplaceItem } from '@/types/api'
import type { InstalledPluginItem } from './PluginManagementRows'
import { pluginDetailReadyToTry } from './pluginDetailReadyToTry'

function installedItem(overrides: Partial<InstalledPlugin['spec']> = {}): InstalledPluginItem {
  const raw: InstalledPlugin = {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: { name: 'wegent-sites', namespace: 'default', labels: { id: '267250' } },
    spec: {
      source: {
        type: 'marketplace',
        providerKey: 'wegent',
        pluginKey: 'wegent-sites',
      },
      origin: 'market',
      pluginId: 267250,
      installState: 'installed',
      enabled: true,
      displayName: '快速建站',
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
      sourcePayload: null,
      ...overrides,
    },
    status: { state: 'installed', devices: [] },
  }
  return {
    id: 267250,
    name: '快速建站',
    description: '',
    enabled: true,
    version: '0.1.6',
    origin: 'market',
    sourceLabel: 'Wegent 官方',
    distribution: 'workspace',
    updateAvailable: false,
    componentCounts: {},
    raw,
  }
}

function marketplaceItem(overrides: Partial<PluginMarketplaceItem> = {}): PluginMarketplaceItem {
  return {
    id: 267250,
    remotePluginId: 'wegent-sites',
    name: 'wegent-sites',
    displayName: '快速建站',
    description: '',
    version: '0.1.6',
    author: 'Wegent',
    visibility: 'workspace',
    featured: false,
    installed: true,
    installedLocally: false,
    installedPluginId: 267250,
    enabled: true,
    sourceType: 'marketplace',
    latestReleaseId: 1001,
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
    manifest: {},
    interface: null,
    ownerUserId: 1,
    currentDeviceInstallation: {
      deviceId: 'current-device',
      desiredReleaseId: 1001,
      actualReleaseId: null,
      state: 'pending',
      errorCode: null,
      errorMessage: null,
      attemptCount: 1,
      lastSyncAt: null,
      updatedAt: '2026-07-25T12:00:00',
    },
    ...overrides,
  }
}

describe('pluginDetailReadyToTry', () => {
  test('treats a local ZIP/Codex package as ready even when cloud device state is pending', () => {
    const plugin = installedItem({ sourcePayload: { localPresent: true } })
    expect(pluginDetailReadyToTry(plugin, marketplaceItem())).toBe(true)
  })

  test('does not treat an account install as ready when this device is still pending', () => {
    expect(pluginDetailReadyToTry(installedItem(), marketplaceItem())).toBe(false)
  })

  test('treats a wegent store directory as ready even when cloud device state is pending', () => {
    const plugin = installedItem({ pluginId: undefined })
    plugin.id = '267250-wegent-wegent-sites-0.1.6'
    plugin.raw.metadata = {
      name: '267250-wegent-wegent-sites-0.1.6',
      namespace: 'default',
      labels: { id: '267250-wegent-wegent-sites-0.1.6' },
    }
    plugin.raw.spec.source.pluginKey = '267250-wegent-wegent-sites-0.1.6'
    expect(pluginDetailReadyToTry(plugin, marketplaceItem())).toBe(true)
  })

  test('does not treat a same-name Codex plugin as this catalog row', () => {
    const plugin = installedItem({ pluginId: undefined })
    plugin.id = 'documents@openai-official'
    plugin.raw.metadata.name = 'documents'
    plugin.raw.spec.source.pluginKey = 'documents'
    plugin.raw.spec.source.providerKey = 'openai-official'
    expect(
      pluginDetailReadyToTry(
        plugin,
        marketplaceItem({
          id: 101,
          name: 'documents',
          installed: false,
          installedLocally: false,
          installedPluginId: null,
          currentDeviceInstallation: null,
        })
      )
    ).toBe(false)
  })

  test('treats this device installed state as ready', () => {
    expect(
      pluginDetailReadyToTry(
        installedItem(),
        marketplaceItem({
          currentDeviceInstallation: {
            deviceId: 'current-device',
            desiredReleaseId: 1001,
            actualReleaseId: 1001,
            state: 'installed',
            errorCode: null,
            errorMessage: null,
            attemptCount: 1,
            lastSyncAt: null,
            updatedAt: '2026-07-25T12:00:00',
          },
        })
      )
    ).toBe(true)
  })
})
