import { beforeEach, expect, test, vi } from 'vitest'
import { emptyPluginComponents } from '@/features/plugins/slimPluginComponents'
import type { InstalledPlugin } from '@/types/api'
import { clearLocalCodexPluginsReadStateCache, createLocalCodexPluginApi } from './codexPlugins'

const request = vi.hoisted(() => vi.fn())
vi.mock('@/lib/runtime-environment', () => ({
  isDesktopRuntime: () => true,
  isElectronRuntime: () => true,
}))
vi.mock('@/desktop/localExecutor', () => ({
  requestLocalExecutor: request,
  ensureLocalExecutorStarted: async () => ({ deviceId: 'test-device' }),
  getKnownLocalExecutorDeviceId: () => 'test-device',
  getInitializedBundledPluginMarketplace: () => null,
}))

beforeEach(() => {
  clearLocalCodexPluginsReadStateCache()
  request.mockReset()
})

const installed: InstalledPlugin = {
  apiVersion: 'agent.wecode.io/v1',
  kind: 'InstalledPlugin',
  metadata: { name: 'sites', namespace: 'wegent', labels: { id: 'sites@wegent' } },
  spec: {
    source: {
      type: 'marketplace',
      providerKey: 'wegent',
      pluginKey: 'sites',
      marketplace: 'wegent',
    },
    origin: 'marketplace',
    installState: 'installed',
    enabled: true,
    components: emptyPluginComponents(),
    componentStates: {},
    sourcePayload: {
      marketplaceName: 'wegent',
      marketplacePath: '/tmp/enterprise-plugins',
      pluginName: 'sites',
    },
  },
  status: { state: 'enabled' },
}

test.each([false, true])(
  'local manifest owns connector metadata even when app-server returns connectors (empty=%s)',
  async empty => {
    const connectors = empty
      ? []
      : ['one', 'two', 'three'].map(source => ({
          slug: `sites-${source}`,
          displayName: `git.${source}.example`,
          authorizationGroup: { id: 'sites', displayName: 'Sites account' },
          authPolicy: 'optional',
          accountAuth: {
            protocolVersion: 1,
            credentialType: 'bearer',
            adapter: `scripts/${source}.py`,
          },
        }))
    request.mockImplementation(async (method, payload) => {
      if (method === 'executor.plugins.manifest.read') {
        expect(payload).toEqual({ marketplacePath: '/tmp/enterprise-plugins', pluginName: 'sites' })
        return { connectors }
      }
      if (method === 'codex.app_server_request' && payload.method === 'plugin/read') {
        return {
          plugin: {
            summary: { id: 'sites@wegent', name: 'sites', installed: true, enabled: true },
            connectors: ['one', 'two', 'three'].map(source => ({
              slug: `sites-${source}`,
              authPolicy: 'optional',
            })),
          },
        }
      }
      throw new Error(`Unexpected request ${method}`)
    })

    const detail = await createLocalCodexPluginApi().readInstalledPluginDetail(installed)
    expect(detail.spec.components.connectors).toHaveLength(connectors.length)
    connectors.forEach((connector, index) => {
      expect(detail.spec.components.connectors?.[index]).toMatchObject(connector)
    })
  }
)

test('marketplace detail uses the supplied local source without consulting a catalog cache', async () => {
  request.mockImplementation(async (method, payload) => {
    if (method === 'executor.plugins.manifest.read') {
      expect(payload).toEqual({ marketplacePath: '/tmp/github-marketplace', pluginName: 'github' })
      return { connectors: [{ slug: 'github', authPolicy: 'on_use' }] }
    }
    if (method === 'codex.app_server_request' && payload.method === 'plugin/read') {
      expect(payload.params).toEqual({
        marketplacePath: '/tmp/github-marketplace',
        remoteMarketplaceName: null,
        pluginName: 'github',
      })
      return {
        plugin: { summary: { id: 'github@openai-official', name: 'github' }, connectors: [] },
      }
    }
    throw new Error(`Unexpected request ${method}`)
  })

  const detail = await createLocalCodexPluginApi().readMarketplacePluginDetail(
    { id: 'openai-official', name: 'GitHub fixture', path: '/tmp/github-marketplace' },
    'github'
  )
  expect(detail.spec.components.connectors).toMatchObject([
    { slug: 'github', authPolicy: 'on_use' },
  ])
})

test('a missing local marketplace path fails before requesting a remote catalog', async () => {
  await expect(
    createLocalCodexPluginApi().readMarketplacePluginDetail(
      { id: 'enterprise', name: 'Enterprise', path: '' },
      'wiki'
    )
  ).rejects.toThrow('Local plugin marketplace path is unavailable')
  expect(request).not.toHaveBeenCalled()
})
