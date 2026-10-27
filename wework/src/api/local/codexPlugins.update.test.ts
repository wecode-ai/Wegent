import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  clearLocalCodexPluginsReadStateCache,
  createLocalCodexPluginApi,
  peekLocalCodexPluginsReadState,
} from './codexPlugins'

const mocks = vi.hoisted(() => ({ request: vi.fn(), writeSkill: vi.fn() }))

vi.mock('@/lib/runtime-environment', () => ({
  isDesktopRuntime: () => true,
  isElectronRuntime: () => true,
}))
vi.mock('@/desktop/localExecutor', () => ({
  ensureLocalExecutorStarted: async () => ({ deviceId: 'skill-settings-device' }),
  ensureBundledPluginMarketplaceRegistered: async () => {},
  getKnownLocalExecutorDeviceId: () => 'skill-settings-device',
  getInitializedBundledPluginMarketplace: () => null,
  requestLocalExecutor: (...args: unknown[]) => mocks.request(...args),
}))

const pluginId = 'demo@skill-settings-fixture'
const fixtureRoot = '/tmp/skill-settings-fixture'
const skillPath = `${fixtureRoot}/plugins/demo/skills/feature/SKILL.md`
const summary = {
  id: pluginId,
  name: 'demo',
  installed: true,
  enabled: true,
  localVersion: '1.0.0',
  interface: { displayName: 'Demo settings' },
}
const marketplace = { name: 'skill-settings-fixture', path: fixtureRoot, plugins: [summary] }

async function installedApi(withPath = false) {
  const api = createLocalCodexPluginApi()
  const state = await api.readState()
  if (withPath) await api.readInstalledPluginDetail(state.installedPlugins[0]!)
  mocks.request.mockClear()
  return api
}

describe('local plugin component settings updates', () => {
  beforeEach(() => {
    clearLocalCodexPluginsReadStateCache()
    localStorage.clear()
    sessionStorage.clear()
    mocks.request.mockReset()
    mocks.writeSkill.mockReset()
    mocks.writeSkill.mockImplementation(async ({ enabled }) => ({ effectiveEnabled: enabled }))
    mocks.request.mockImplementation(
      async (method: string, args?: { method: string; params: Record<string, unknown> }) => {
        if (method === 'executor.plugins.store.list') return { storePath: fixtureRoot, plugins: [] }
        if (method === 'executor.plugins.manifest.read') return { connectors: [] }
        if (method !== 'codex.app_server_request')
          throw new Error(`Unexpected executor call ${method}`)
        if (args?.method === 'plugin/list' || args?.method === 'plugin/installed') {
          return { marketplaces: [marketplace] }
        }
        if (args?.method === 'skills/config/write') return mocks.writeSkill(args.params)
        if (args?.method === 'plugin/read') {
          return {
            plugin: {
              summary,
              description: 'Skill settings fixture',
              skills: [
                { name: 'feature', path: skillPath, enabled: true },
                {
                  name: 'unrelated',
                  path: `${fixtureRoot}/plugins/demo/skills/unrelated/SKILL.md`,
                  enabled: false,
                },
              ],
            },
          }
        }
        throw new Error(`Unexpected app-server call ${args?.method}`)
      }
    )
  })

  test.each([
    { enabled: false, withPath: false },
    { enabled: true, withPath: false },
    { enabled: false, withPath: true },
    { enabled: true, withPath: true },
  ])('returns the confirmed setting after summary refresh (%j)', async ({ enabled, withPath }) => {
    const api = await installedApi(withPath)

    const updated = await api.updateInstalledPlugin(pluginId, {
      componentStates: { 'skill:feature': enabled },
    })

    expect(mocks.writeSkill).toHaveBeenCalledExactlyOnceWith({
      path: withPath ? skillPath : null,
      name: withPath ? null : 'feature',
      enabled,
    })
    expect(updated.metadata.labels).toEqual({ id: pluginId })
    expect(updated.spec).toMatchObject({
      displayName: 'Demo settings',
      version: '1.0.0',
      enabled: true,
      componentStates: { 'skill:feature': enabled },
    })
    if (withPath) expect(updated.spec.componentStates['skill:unrelated']).toBe(false)
    expect(peekLocalCodexPluginsReadState()?.installedPlugins[0]?.spec.componentStates).toEqual(
      updated.spec.componentStates
    )
    expect(mocks.request.mock.calls.some(([, args]) => args?.method === 'plugin/read')).toBe(false)
  })

  test.each([{}, { effectiveEnabled: 'false' }, { effectiveEnabled: true }, null])(
    'rejects an unconfirmed disable instead of returning success (%j)',
    async response => {
      const api = await installedApi()
      mocks.writeSkill.mockResolvedValue(response)

      await expect(
        api.updateInstalledPlugin(pluginId, { componentStates: { 'skill:feature': false } })
      ).rejects.toThrow('Codex did not apply the requested skill setting')

      expect(mocks.request.mock.calls.some(([, args]) => args?.method === 'plugin/list')).toBe(
        false
      )
      expect(peekLocalCodexPluginsReadState()?.installedPlugins[0]?.spec.componentStates).toEqual(
        {}
      )
    }
  )

  test('preserves a native write failure without refreshing or reporting a saved setting', async () => {
    const api = await installedApi(true)
    mocks.writeSkill.mockRejectedValue(new Error('Native skill configuration failed'))

    await expect(
      api.updateInstalledPlugin(pluginId, { componentStates: { 'skill:feature': false } })
    ).rejects.toThrow('Native skill configuration failed')

    expect(mocks.request.mock.calls.some(([, args]) => args?.method === 'plugin/list')).toBe(false)
    expect(
      peekLocalCodexPluginsReadState()?.installedPlugins[0]?.spec.componentStates['skill:feature']
    ).toBe(true)
  })
})
