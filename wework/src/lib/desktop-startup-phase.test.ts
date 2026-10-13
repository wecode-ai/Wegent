import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
let markDesktopStartupPhase: typeof import('./desktop-startup-phase').markDesktopStartupPhase
let traceDesktopStartupPhase: typeof import('./desktop-startup-phase').traceDesktopStartupPhase
let clearDshUiModuleCache: typeof import('@/features/dsh-runtime/dshUiModules').clearDshUiModuleCache
let getLoadedDshUiModule: typeof import('@/features/dsh-runtime/dshUiModules').getLoadedDshUiModule
let importDshUiModule: typeof import('@/features/dsh-runtime/dshUiModules').importDshUiModule
let stylesheetModule: typeof import('@/features/dsh-runtime/dshUiStylesheets')

const runtime = vi.hoisted(() => ({ electron: true, label: 'main' }))
vi.mock('@/lib/runtime-environment', () => ({
  isElectronRuntime: () => runtime.electron,
  getDesktopWindowLabel: () => runtime.label,
}))

const prefix = '[startup][renderer-phase] '

function recordedPhases(spy: ReturnType<typeof vi.spyOn>) {
  return spy.mock.calls.map(([message]) => JSON.parse(String(message).slice(prefix.length)))
}

describe('desktop startup phase diagnostics', () => {
  beforeEach(async () => {
    vi.resetModules()
    const diagnostics = await import('./desktop-startup-phase')
    const modules = await import('@/features/dsh-runtime/dshUiModules')
    stylesheetModule = await import('@/features/dsh-runtime/dshUiStylesheets')
    markDesktopStartupPhase = diagnostics.markDesktopStartupPhase
    traceDesktopStartupPhase = diagnostics.traceDesktopStartupPhase
    clearDshUiModuleCache = modules.clearDshUiModuleCache
    getLoadedDshUiModule = modules.getLoadedDshUiModule
    importDshUiModule = modules.importDshUiModule
    runtime.electron = true
    runtime.label = 'main'
    clearDshUiModuleCache()
  })
  afterEach(() => {
    delete window.__WEWORK_DSH_UI_MODULES__
    vi.restoreAllMocks()
  })

  test('records only fixed fields for the primary Electron renderer', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    markDesktopStartupPhase('app-gate', 'waiting', {
      authLoading: true,
      preferencesLoaded: false,
      ...{ token: 'private', error: 'private' },
    })
    expect(recordedPhases(info)).toEqual([
      {
        phase: 'app-gate',
        status: 'waiting',
        navigationTimeMs: expect.any(Number),
        authLoading: true,
        preferencesLoaded: false,
      },
    ])
    runtime.label = 'popout'
    markDesktopStartupPhase('task-bootstrap', 'started')
    runtime.label = 'main'
    runtime.electron = false
    markDesktopStartupPhase('task-bootstrap', 'started')
    expect(info).toHaveBeenCalledTimes(1)
  })

  test.each([
    'renderer-entry',
    'renderer-storage-initialize',
    'renderer-storage-restore',
    'renderer-storage-request',
    'renderer-storage-response-body',
    'renderer-storage-replace',
    'provider-model-initialize',
    'provider-model-read',
    'provider-model-migration',
    'provider-model-runtime',
    'automation-bridge-install',
    'controller-client',
    'controller-register',
  ] as const)('persists the %s boundary without exposing control configuration', phase => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    markDesktopStartupPhase(phase, 'started', { ...{ controlUrl: 'private', token: 'private' } })
    markDesktopStartupPhase(phase, 'completed')
    expect(recordedPhases(info)).toEqual([
      { phase, status: 'started', navigationTimeMs: expect.any(Number) },
      { phase, status: 'completed', navigationTimeMs: expect.any(Number) },
    ])
  })

  test('traces the existing asynchronous operation without changing its result or failure', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    let release!: (result: object) => void
    const operation = new Promise<object>(resolve => {
      release = resolve
    })
    const traced = traceDesktopStartupPhase('renderer-storage-restore', () => operation)
    expect(recordedPhases(info).map(({ phase, status }) => [phase, status])).toEqual([
      ['renderer-storage-restore', 'started'],
    ])
    const value = { private: 'private-token' }
    release(value)
    await expect(traced).resolves.toBe(value)
    const error = new Error('private-token')
    await expect(
      traceDesktopStartupPhase('provider-model-read', async () => {
        throw error
      })
    ).rejects.toBe(error)
    const phases = recordedPhases(info)
    expect(phases.map(({ phase, status }) => [phase, status])).toEqual([
      ['renderer-storage-restore', 'started'],
      ['renderer-storage-restore', 'completed'],
      ['provider-model-read', 'started'],
      ['provider-model-read', 'failed'],
    ])
    expect(phases[1].durationMs).toEqual(expect.any(Number))
    expect(phases[3].durationMs).toEqual(expect.any(Number))
    expect(JSON.stringify(phases)).not.toContain('private-token')
  })

  test.each(['plugins/wework-ui-home-developer.js', 'plugins/wework-ui-core-apps.js'])(
    'records one import interval for %s while preserving its shared promise and loaded cache',
    async modulePath => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
      let resolve!: (value: unknown) => void
      const value = { home: true }
      window.__WEWORK_DSH_UI_MODULES__ = {
        [modulePath]: () =>
          new Promise(done => {
            resolve = done
          }),
      }
      const first = importDshUiModule(modulePath)
      expect(importDshUiModule(modulePath)).toBe(first)
      expect(getLoadedDshUiModule(modulePath)).toBeNull()
      resolve(value)
      await expect(first).resolves.toBe(value)
      expect(getLoadedDshUiModule(modulePath)).toBe(value)
      expect(recordedPhases(info).map(({ phase, status }) => [phase, status])).toEqual([
        [
          modulePath.includes('core-apps') ? 'core-app-module-import' : 'home-module-import',
          'started',
        ],
        ['module-import-resolved', 'completed'],
        ['module-stylesheets', 'started'],
        ['module-stylesheets', 'completed'],
        [
          modulePath.includes('core-apps') ? 'core-app-module-import' : 'home-module-import',
          'completed',
        ],
      ])
    }
  )

  test('records module and stylesheet boundaries without completing a held stylesheet', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    let clock = 10
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    let release!: () => void
    vi.spyOn(stylesheetModule, 'loadDshUiStylesheets').mockImplementation(
      () => new Promise<void>(resolve => (release = resolve))
    )
    const modulePath = 'plugins/wework-ui-core-apps.js'
    const value = { privateContent: 'private' }
    window.__WEWORK_DSH_UI_MODULES__ = { [modulePath]: value }
    const loading = importDshUiModule(modulePath)
    clock = 20
    await Promise.resolve()
    expect(getLoadedDshUiModule(modulePath)).toBeNull()
    expect(recordedPhases(info).map(({ phase, status }) => [phase, status])).toEqual([
      ['core-app-module-import', 'started'],
      ['module-import-resolved', 'completed'],
      ['module-stylesheets', 'started'],
    ])
    clock = 35
    release()
    await expect(loading).resolves.toBe(value)
    expect(getLoadedDshUiModule(modulePath)).toBe(value)
    expect(recordedPhases(info).map(({ navigationTimeMs }) => navigationTimeMs)).toEqual([
      10, 20, 20, 35, 35,
    ])
    expect(recordedPhases(info).map(({ durationMs }) => durationMs)).toEqual([
      undefined,
      10,
      undefined,
      15,
      25,
    ])
    expect(JSON.stringify(info.mock.calls)).not.toContain('private')
  })

  test('preserves stylesheet error identity and records no private error or module data', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const error = new Error('private-stylesheet-url?token=private')
    vi.spyOn(stylesheetModule, 'loadDshUiStylesheets').mockRejectedValue(error)
    const modulePath = 'plugins/wework-ui-home-focus.js'
    window.__WEWORK_DSH_UI_MODULES__ = { [modulePath]: { privateContent: 'private' } }
    await expect(importDshUiModule(modulePath)).rejects.toBe(error)
    expect(getLoadedDshUiModule(modulePath)).toBeNull()
    expect(recordedPhases(info).map(({ phase, status }) => [phase, status])).toEqual([
      ['home-module-import', 'started'],
      ['module-import-resolved', 'completed'],
      ['module-stylesheets', 'started'],
      ['module-stylesheets', 'failed'],
      ['home-module-import', 'failed'],
    ])
    expect(JSON.stringify(info.mock.calls)).not.toContain('private')
  })

  test('preserves failed imports without recording error contents or custom module paths', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const modulePath = 'plugins/wework-ui-home-focus.js'
    const error = new Error('private error')
    window.__WEWORK_DSH_UI_MODULES__ = {
      [modulePath]: () => Promise.reject(error),
      'custom.js?secret': {},
    }
    await expect(importDshUiModule(modulePath)).rejects.toBe(error)
    await importDshUiModule('custom.js?secret')
    expect(recordedPhases(info).map(({ status }) => status)).toEqual(['started', 'failed'])
    expect(JSON.stringify(info.mock.calls)).not.toContain('private')
    expect(JSON.stringify(info.mock.calls)).not.toContain('secret')
  })
})
