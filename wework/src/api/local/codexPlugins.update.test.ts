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
const skillStates: Record<string, boolean> = { feature: true, unrelated: false }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(promiseResolve => {
    resolve = promiseResolve
  })
  return { promise, resolve }
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
    clearLocalCodexPluginsReadStateCache()
    localStorage.clear()
    sessionStorage.clear()
    mocks.request.mockReset()
    mocks.writeSkill.mockReset()
    skillStates.feature = true
    skillStates.unrelated = false
    mocks.writeSkill.mockImplementation(async ({ enabled, name, path }) => {
      const skillName = name ?? (path === skillPath ? 'feature' : 'unrelated')
      skillStates[skillName] = enabled
      return { effectiveEnabled: enabled }
    })
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

  test('waits for every write before reconciling a partially applied batch', async () => {
    const api = await installedApi(true)
    const pendingWrite = deferred<{ effectiveEnabled: boolean }>()
    const error = new Error('Feature setting rejected')
    const settled = vi.fn()
    mocks.writeSkill.mockImplementation(({ path }) =>
      path === skillPath ? Promise.reject(error) : pendingWrite.promise
    )

    const update = api.updateInstalledPlugin(pluginId, {
      componentStates: { 'skill:feature': false, 'skill:unrelated': true },
    })
    void update.then(settled, settled)
    await vi.waitFor(() => expect(mocks.writeSkill).toHaveBeenCalledTimes(2))

    expect(settled).not.toHaveBeenCalled()
    expect(mocks.request.mock.calls.some(([, args]) => args?.method === 'plugin/list')).toBe(false)

    skillStates.unrelated = true
    pendingWrite.resolve({ effectiveEnabled: true })
    await expect(update).rejects.toBe(error)

    const state = await api.readState()
    expect(state.installedPlugins[0]?.spec.componentStates).toEqual({
      'skill:feature': true,
      'skill:unrelated': true,
    })
    expect(peekLocalCodexPluginsReadState()?.installedPlugins[0]?.spec.componentStates).toEqual(
      state.installedPlugins[0]?.spec.componentStates
    )
    expect(
      mocks.request.mock.calls.filter(([, args]) => args?.method === 'plugin/list')
    ).toHaveLength(1)
    expect(
      mocks.request.mock.calls.filter(([, args]) => args?.method === 'plugin/read')
    ).toHaveLength(1)
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
})
