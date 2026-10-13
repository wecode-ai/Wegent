import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
let markDesktopStartupPhase: typeof import('./desktop-startup-phase').markDesktopStartupPhase
let clearDshUiModuleCache: typeof import('@/features/dsh-runtime/dshUiModules').clearDshUiModuleCache
let getLoadedDshUiModule: typeof import('@/features/dsh-runtime/dshUiModules').getLoadedDshUiModule
let importDshUiModule: typeof import('@/features/dsh-runtime/dshUiModules').importDshUiModule

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
    markDesktopStartupPhase = diagnostics.markDesktopStartupPhase
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

  test('records one import interval while preserving the shared promise and loaded cache', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const modulePath = 'plugins/wework-ui-home-developer.js'
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
    expect(recordedPhases(info).map(({ status }) => status)).toEqual(['started', 'completed'])
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
