import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  clearLocalCodexPluginsReadStateCache,
  createLocalCodexPluginApi,
  peekLocalCodexPluginsReadState,
} from './codexPlugins'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  writeSkill: vi.fn(),
  writeEnabled: vi.fn(),
  deviceId: 'skill-settings-device',
}))

vi.mock('@/api/local/runtimeAuthStatus', () => ({
  getLocalCodexAuthStatus: vi.fn().mockResolvedValue({ sha256: 'test-account' }),
}))

vi.mock('@/lib/runtime-environment', () => ({
  isDesktopRuntime: () => true,
  isElectronRuntime: () => true,
}))
vi.mock('@/desktop/localExecutor', () => ({
  ensureLocalExecutorStarted: async () => ({ deviceId: mocks.deviceId }),
  ensureBundledPluginMarketplaceRegistered: async () => {},
  getKnownLocalExecutorDeviceId: () => mocks.deviceId,
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
const skillStates: Record<string, boolean> = { feature: true, unrelated: false }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

async function installedApi(withPath = false) {
  const api = createLocalCodexPluginApi()
  const state = await api.readState()
  if (withPath) await api.readInstalledPluginDetail(state.installedPlugins[0]!)
  mocks.request.mockClear()
  return api
}

describe('local plugin component settings updates', () => {
  beforeEach(() => {
    mocks.deviceId = 'skill-settings-device'
    clearLocalCodexPluginsReadStateCache()
    localStorage.clear()
    sessionStorage.clear()
    mocks.request.mockReset()
    mocks.writeSkill.mockReset()
    skillStates.feature = true
    skillStates.unrelated = false
    summary.enabled = true
    mocks.writeEnabled.mockReset().mockImplementation(async ({ value }) => {
      summary.enabled = value
      return {}
    })
    mocks.writeSkill.mockImplementation(async ({ enabled, name, path }) => {
      const skillName = name ?? (path === skillPath ? 'feature' : 'unrelated')
      skillStates[skillName] = enabled
      return { effectiveEnabled: enabled }
    })
    mocks.request.mockImplementation(
      async (method: string, args?: { method: string; params: Record<string, unknown> }) => {
        if (method === 'executor.plugins.links.list') return []
        if (method === 'executor.plugins.personal.list')
          return { marketplaceId: 'wework-personal', marketplacePath: '/personal', plugins: [] }
        if (method === 'executor.codex_home.config.read') return { enabledPluginKeys: [] }
        if (method === 'executor.plugins.store.list') return { storePath: fixtureRoot, plugins: [] }
        if (method === 'executor.plugins.manifest.read') return { connectors: [] }
        if (method !== 'codex.app_server_request')
          throw new Error(`Unexpected executor call ${method}`)
        if (args?.method === 'plugin/list' || args?.method === 'plugin/installed') {
          return { marketplaces: [marketplace] }
        }
        if (args?.method === 'skills/config/write') return mocks.writeSkill(args.params)
        if (args?.method === 'config/value/write') return mocks.writeEnabled(args.params)
        if (args?.method === 'plugin/read') {
          return {
            plugin: {
              summary,
              description: 'Skill settings fixture',
              skills: [
                { name: 'feature', path: skillPath, enabled: skillStates.feature },
                {
                  name: 'unrelated',
                  path: `${fixtureRoot}/plugins/demo/skills/unrelated/SKILL.md`,
                  enabled: skillStates.unrelated,
                },
              ],
            },
          }
        }
        throw new Error(`Unexpected app-server call ${args?.method}`)
      }
    )
  })

  test.each([{}, { effectiveEnabled: 'false' }, { effectiveEnabled: true }, null])(
    'rejects an unconfirmed disable instead of returning success (%j)',
    async response => {
      const api = await installedApi()
      mocks.writeSkill.mockResolvedValue(response)

      await expect(
        api.updateInstalledPlugin(pluginId, { componentStates: { 'skill:feature': false } })
      ).rejects.toThrow('Codex did not apply the requested skill setting')

      expect(mocks.request.mock.calls.some(([, args]) => args?.method === 'plugin/list')).toBe(true)
      expect(mocks.request.mock.calls.some(([, args]) => args?.method === 'plugin/read')).toBe(true)
      expect(peekLocalCodexPluginsReadState()?.installedPlugins[0]?.spec.componentStates).toEqual({
        'skill:feature': true,
        'skill:unrelated': false,
      })
    }
  )

  test('preserves a native write failure after reconciling the actual settings', async () => {
    const api = await installedApi(true)
    const error = new Error('Native skill configuration failed')
    mocks.writeSkill.mockRejectedValue(error)

    await expect(
      api.updateInstalledPlugin(pluginId, { componentStates: { 'skill:feature': false } })
    ).rejects.toBe(error)

    expect(mocks.request.mock.calls.some(([, args]) => args?.method === 'plugin/list')).toBe(true)
    expect(mocks.request.mock.calls.some(([, args]) => args?.method === 'plugin/read')).toBe(true)
    expect(
      peekLocalCodexPluginsReadState()?.installedPlugins[0]?.spec.componentStates['skill:feature']
    ).toBe(true)
  })

  test.each([
    { failedMethods: ['plugin/list'], reconcilesSettings: true },
    { failedMethods: ['plugin/read'], reconcilesSettings: false },
    { failedMethods: ['plugin/list', 'plugin/read'], reconcilesSettings: false },
  ])(
    'preserves the write failure when $failedMethods fail during reconciliation',
    async ({ failedMethods, reconcilesSettings }) => {
      const api = await installedApi(true)
      const writeError = new Error('Native skill configuration failed')
      const reconcileError = new Error('Plugin settings could not be refreshed')
      const request = mocks.request.getMockImplementation()!
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      mocks.writeSkill.mockRejectedValue(writeError)
      mocks.request.mockImplementation((method, args) => {
        if (failedMethods.includes(args?.method)) return Promise.reject(reconcileError)
        return request(method, args)
      })

      try {
        await expect(
          api.updateInstalledPlugin(pluginId, { componentStates: { 'skill:feature': false } })
        ).rejects.toBe(writeError)

        expect(
          mocks.request.mock.calls.filter(([, args]) => args?.method === 'plugin/installed')
        ).toHaveLength(1)
        expect(
          mocks.request.mock.calls.filter(([, args]) => args?.method === 'plugin/read')
        ).toHaveLength(1)
        if (reconcilesSettings) {
          expect(warning).toHaveBeenCalledWith(
            '[Wework] codex.app_server_request failed',
            expect.objectContaining({ method: 'plugin/list', errorType: 'Error' })
          )
          expect(warning).not.toHaveBeenCalledWith(
            '[Wework] Failed to reconcile Codex plugin settings after a write failure',
            expect.anything()
          )
          const cached = peekLocalCodexPluginsReadState()
          expect(cached?.partial).toBe(true)
          expect(cached?.installedPlugins[0]?.spec.componentStates).toEqual({
            'skill:feature': true,
            'skill:unrelated': false,
          })
        } else {
          expect(warning).toHaveBeenCalledWith(
            '[Wework] Failed to reconcile Codex plugin settings after a write failure',
            { errorType: 'Error' }
          )
          expect(peekLocalCodexPluginsReadState()).toBeNull()
        }

        mocks.request.mockImplementation(request)
        const state = await api.readState({ refresh: true })
        expect(state.partial).not.toBe(true)
        const detail = await api.readInstalledPluginDetail(state.installedPlugins[0]!)
        expect(detail.spec.componentStates['skill:feature']).toBe(true)
      } finally {
        warning.mockRestore()
      }
    }
  )

  test.each(['success', 'failure'] as const)(
    'rejects a superseded component write after its late %s',
    async outcome => {
      const api = await installedApi(true)
      const held = deferred<{ effectiveEnabled: boolean }>()
      const oldError = new Error('Old native request failed')
      mocks.writeSkill.mockImplementation(({ enabled }) => {
        skillStates.feature = enabled
        return enabled ? Promise.resolve({ effectiveEnabled: true }) : held.promise
      })
      const old = api.updateInstalledPlugin(pluginId, {
        componentStates: { 'skill:feature': false },
      })
      const rejected = expect(old).rejects.toThrow('Plugin settings request is no longer current')
      await vi.waitFor(() => expect(mocks.writeSkill).toHaveBeenCalledOnce())
      await api.updateInstalledPlugin(pluginId, { componentStates: { 'skill:feature': true } })
      const before = peekLocalCodexPluginsReadState()
      expect(skillStates.feature).toBe(true)
      if (outcome === 'failure') {
        // Deliver the failure after the newer setting has been accepted.
        held.reject(oldError)
      } else held.resolve({ effectiveEnabled: false })
      await rejected
      expect(skillStates.feature).toBe(true)
      expect(peekLocalCodexPluginsReadState()).toBe(before)
      expect(before!.installedPlugins[0].spec.componentStates['skill:feature']).toBe(true)
    }
  )

  test.each(['overlapping batch'] as const)(
    'retains independent settings while a newer request changes a %s',
    async mode => {
      const api = await installedApi(true)
      const held = deferred<{ effectiveEnabled: boolean }>()
      mocks.writeSkill.mockImplementation(({ enabled, path }) => {
        const name = path === skillPath ? 'feature' : 'unrelated'
        skillStates[name] = enabled
        return name === 'feature' && !enabled
          ? held.promise
          : Promise.resolve({ effectiveEnabled: enabled })
      })
      const old = api.updateInstalledPlugin(pluginId, {
        componentStates: {
          'skill:feature': false,
          ...(mode === 'overlapping batch' ? { 'skill:unrelated': true } : {}),
        },
      })
      await vi.waitFor(() =>
        expect(mocks.writeSkill).toHaveBeenCalledTimes(mode === 'overlapping batch' ? 2 : 1)
      )
      await api.updateInstalledPlugin(pluginId, {
        componentStates:
          mode === 'overlapping batch' ? { 'skill:feature': true } : { 'skill:unrelated': true },
      })
      held.resolve({ effectiveEnabled: false })
      const result = await old
      const expected = { 'skill:feature': mode === 'overlapping batch', 'skill:unrelated': true }
      expect(result.spec.componentStates).toEqual(expected)
      expect(peekLocalCodexPluginsReadState()!.installedPlugins[0].spec.componentStates).toEqual(
        expected
      )
      expect(skillStates).toEqual({ feature: mode === 'overlapping batch', unrelated: true })
    }
  )

  test.each(['device', 'device round trip', 'invalidate'] as const)(
    'does not clear or modify newer inventory after %s',
    async change => {
      const api = await installedApi(true)
      const held = deferred<{ effectiveEnabled: boolean }>()
      mocks.writeSkill.mockReturnValue(held.promise)
      const old = api.updateInstalledPlugin(pluginId, {
        componentStates: { 'skill:feature': false },
      })
      const rejected = expect(old).rejects.toThrow('Plugin settings request is no longer current')
      await vi.waitFor(() => expect(mocks.writeSkill).toHaveBeenCalledOnce())
      if (change === 'invalidate') clearLocalCodexPluginsReadStateCache()
      else mocks.deviceId = 'other-device'
      let state = await api.readState({ refresh: true })
      await api.readInstalledPluginDetail(state.installedPlugins[0])
      if (change === 'device round trip') {
        mocks.deviceId = 'skill-settings-device'
        state = await api.readState({ refresh: true })
        await api.readInstalledPluginDetail(state.installedPlugins[0])
      }
      const before = peekLocalCodexPluginsReadState()
      expect(before!.deviceId).toBe(mocks.deviceId)
      expect(before!.installedPlugins[0].spec.componentStates['skill:feature']).toBe(true)
      held.resolve({ effectiveEnabled: false })
      await rejected
      expect(peekLocalCodexPluginsReadState()).toBe(before)
    }
  )
})
