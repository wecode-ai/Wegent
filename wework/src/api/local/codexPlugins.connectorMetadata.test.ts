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
