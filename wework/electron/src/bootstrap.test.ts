import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { DesktopRelease, ReleaseActivation } from './runtime/release-store.js'

const startup = vi.hoisted(() => ({
  roots: [] as string[],
  metadata: {} as { weworkExecutorNamespace?: string; version?: string },
  activeRelease: { id: 'pending-target' } as Partial<DesktopRelease>,
  activation: null as Partial<ReleaseActivation> | null,
  bridgeHandoff: vi.fn(),
  showErrorBox: vi.fn(),
  bridge: null as string | null,
  legacyUserData: null as string | null,
  ready: vi.fn(),
  relaunch: vi.fn(),
  home: '',
  main: vi.fn(),
  historyError: null as Error | null,
  enterInstalled: vi.fn(),
  rollback: vi.fn(),
  restoreData: vi.fn(),
}))

vi.mock('./runtime/release-snapshot.js', () => ({ restoreReleaseData: startup.restoreData }))

vi.mock('./runtime/macos-release-installation.js', () => ({
  enterInstalledMacosRelease: startup.enterInstalled,
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => startup.home,
    on: vi.fn(),
    removeListener: vi.fn(),
    whenReady: startup.ready,
    relaunch: startup.relaunch,
    exit: vi.fn(),
    setActivationPolicy: vi.fn(),
  },
  dialog: { showErrorBox: startup.showErrorBox },
}))

vi.mock('node:fs', () => ({ existsSync: () => true }))
vi.mock('./runtime/release-diagnostics.js', () => ({ recordReleaseDiagnostic: vi.fn() }))
vi.mock('./runtime/release-handoff.js', () => ({
  releaseBridgeUserData: startup.bridgeHandoff,
}))

vi.mock('node:fs/promises', () => ({
  readFile: async () => JSON.stringify(startup.metadata),
  realpath: async (path: string) =>
    path.replace(join('legacy', 'releases'), join('user-data', 'releases')),
}))

vi.mock('./runtime/release-store.js', () => ({
  optionalText: async (path: string) => (basename(path) === 'bridge' ? startup.bridge : null),
  ReleaseStore: class {
    constructor(root: string) {
      startup.roots.push(root)
    }

    async active() {
      if (startup.historyError) throw startup.historyError
      return startup.activeRelease
    }
    async activation() {
      return startup.activation
    }
    async rollback() {
      return startup.rollback()
    }
  },
}))

beforeEach(() => {
  vi.resetModules()
  vi.doMock('./main.js', () => {
    startup.main()
    return {}
  })
  startup.roots.length = 0
  startup.metadata = {}
  startup.activeRelease = { id: 'pending-target' }
  startup.activation = { token: 'trial', to: 'pending-target', from: 'source' }
  startup.historyError = null
  startup.main.mockClear()
  startup.enterInstalled.mockReset()
  startup.rollback.mockReset()
  startup.restoreData.mockReset()
  startup.bridgeHandoff.mockReset().mockImplementation(async () => startup.legacyUserData)
  startup.showErrorBox.mockClear()
  startup.bridge = null
  startup.legacyUserData = null
  startup.ready.mockReset().mockImplementation(() => new Promise(() => {}))
  startup.relaunch.mockClear()
  startup.home = join(tmpdir(), 'wework-bootstrap-home')
  vi.stubEnv('HOME', startup.home)
  vi.stubEnv('WEGENT_WORKBENCH_HOME', '')
  vi.stubEnv('WEWORK_USER_DATA_DIR', '')
  vi.stubEnv('WEWORK_RELEASE_ROOT', '')
  vi.stubEnv('WEWORK_RELEASE_SUPERVISED', '')
  vi.stubEnv('WEWORK_RELEASE_RECOVERY', '')
  for (const name of [
    'WEWORK_HARNESS_RUNTIME_ROOT',
    'WEWORK_ACTIVE_RELEASE_ID',
    'WEWORK_COMPONENT_DATA_DIRECTORY',
  ])
    vi.stubEnv(name, '')
})

afterEach(() => vi.unstubAllEnvs())

test.each(['default', 'com.example.wework'])(
  'reads pending activation from the migrated %s userData directory',
  async namespace => {
    if (namespace !== 'default') startup.metadata.weworkExecutorNamespace = namespace
    const root = join(startup.home, '.wegent/workbench/wework', namespace, 'user-data/releases')
    vi.stubEnv('WEWORK_RELEASE_ROOT', root)

    await import('./bootstrap.js')

    expect(startup.showErrorBox).not.toHaveBeenCalled()
    expect(startup.roots).toEqual([root])
  }
)

test('keeps an explicit isolated userData directory as the release store owner', async () => {
  const isolated = join(startup.home, 'isolated')
  vi.stubEnv('WEWORK_USER_DATA_DIR', isolated)
  vi.stubEnv('WEWORK_RELEASE_ROOT', join(isolated, 'releases'))

  await import('./bootstrap.js')

  expect(startup.showErrorBox).not.toHaveBeenCalled()
  expect(startup.roots).toEqual([join(isolated, 'releases')])
})

test('accepts the physical release store handed off by a repaired legacy launcher', async () => {
  vi.stubEnv('WEWORK_USER_DATA_DIR', join(startup.home, 'user-data'))
  vi.stubEnv('WEWORK_RELEASE_ROOT', join(startup.home, 'legacy/releases'))

  await import('./bootstrap.js')

  expect(startup.showErrorBox).not.toHaveBeenCalled()
  expect(startup.roots).toEqual([join(startup.home, 'user-data/releases')])
})

test('rejects a handoff to a different physical release store', async () => {
  vi.stubEnv('WEWORK_USER_DATA_DIR', join(startup.home, 'user-data'))
  vi.stubEnv('WEWORK_RELEASE_ROOT', join(startup.home, 'other/releases'))
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    await import('./bootstrap.js')
    expect(startup.showErrorBox).toHaveBeenCalledWith(
      'Wework',
      'Release root does not match the application data directory'
    )
    expect(startup.roots).toEqual([join(startup.home, 'user-data/releases')])
  } finally {
    diagnostic.mockRestore()
  }
})

test('passes the owned userData directory before relaunching a legacy recovery bridge', async () => {
  startup.bridge = join(startup.home, 'legacy/WeWork')
  startup.legacyUserData = join(startup.home, '.wegent/workbench/wework/default/user-data')
  startup.ready.mockResolvedValue(undefined)

  await import('./bootstrap.js')

  await vi.waitFor(() => expect(startup.relaunch).toHaveBeenCalled())
  expect(process.env.WEWORK_USER_DATA_DIR).toBe(startup.legacyUserData)
  expect(process.env.WEWORK_RELEASE_ROOT).toBe(join(startup.legacyUserData, 'releases'))
  expect(startup.showErrorBox).not.toHaveBeenCalled()
})

test.each(['pending', 'rollback-selected'])(
  'the installed macOS entry retains its native installer during %s recovery',
  async phase => {
    startup.metadata.version = '2.0.0'
    startup.bridge = join(startup.home, 'old-payload/WeWork')
    startup.activeRelease = {
      id: 'selected',
      executable: process.execPath,
      version: phase === 'pending' ? '2.0.0' : '1.0.0',
      macosInstallation: { payloadExecutable: startup.bridge, bootstrapFromPayload: true },
    }
    startup.activation = { token: 'trial', to: 'selected', from: 'source' }
    await import('./bootstrap.js')
    expect(startup.showErrorBox).not.toHaveBeenCalled()
    expect(startup.bridgeHandoff).not.toHaveBeenCalled()
    expect(startup.ready).toHaveBeenCalledOnce()
  }
)

test('hands the selected legacy host its physical userData before native launch', async () => {
  startup.bridge = process.execPath
  startup.activeRelease = {
    id: 'installed-source',
    executable: join(startup.home, 'legacy/WeWork.exe'),
  }
  startup.legacyUserData = join(startup.home, '.wegent/workbench/wework/default/user-data')
  startup.ready.mockResolvedValue(undefined)

  await import('./bootstrap.js')

  await vi.waitFor(() => expect(startup.relaunch).toHaveBeenCalled())
  expect(startup.bridgeHandoff).toHaveBeenCalledWith(
    expect.anything(),
    startup.activeRelease.executable,
    startup.legacyUserData
  )
  expect(process.env.WEWORK_USER_DATA_DIR).toBe(startup.legacyUserData)
  expect(process.env.WEWORK_RELEASE_ROOT).toBe(join(startup.legacyUserData, 'releases'))
  expect(startup.showErrorBox).not.toHaveBeenCalled()
})

if (process.platform === 'darwin') {
  test('a delayed native recovery handoff cannot enter the rejected installed host after rollback finalized', async () => {
    startup.activation = null
    startup.metadata.version = '2.0.0'
    startup.activeRelease = {
      id: 'source',
      version: '1.0.0',
      executable: process.execPath,
      macosInstallation: { payloadExecutable: '/retained/source', bootstrapFromPayload: false },
    }
    vi.stubEnv('WEWORK_RELEASE_RECOVERY', 'previous-trial')

    await import('./bootstrap.js')

    expect(startup.main).not.toHaveBeenCalled()
    expect(startup.ready).toHaveBeenCalledOnce()
    expect(process.env.WEWORK_RELEASE_RECOVERY).toBeUndefined()
  })

  test('an unsupervised versioned recovery payload is not an ordinary installed application', async () => {
    startup.activation = null
    startup.metadata.version = '2.0.0'
    const original = Object.getOwnPropertyDescriptor(process, 'execPath')!
    const payload = join(
      startup.home,
      '.wegent/workbench/wework/default/user-data/releases/slots/rejected/host/WeWork.app/Contents/MacOS/WeWork'
    )
    Object.defineProperty(process, 'execPath', { ...original, value: payload })
    startup.activeRelease = { id: 'source', version: '1.0.0' }
    try {
      await import('./bootstrap.js')

      expect(startup.main).not.toHaveBeenCalled()
      expect(startup.ready).toHaveBeenCalledOnce()
    } finally {
      Object.defineProperty(process, 'execPath', original)
    }
  })

  test.each([false, true])(
    'bootstrap completes manual rollback before native launch (restore=%s)',
    async restoreRequired => {
      startup.metadata.version = '2.0.0'
      startup.activeRelease = {
        id: 'target',
        version: '2.0.0',
        executable: process.execPath,
        macosInstallation: { payloadExecutable: '/retained/target' },
      }
      startup.activation = {
        token: 'rollback',
        from: 'source',
        to: 'target',
        snapshot: 'saved-data',
        restoreRequired,
        rollbackRequested: true,
      }
      startup.rollback.mockImplementation(async () => {
        startup.activeRelease = {
          ...startup.activeRelease,
          id: 'source',
          version: '1.0.0',
          macosInstallation: { payloadExecutable: '/retained/source' },
        }
        startup.activation = null
        return startup.activeRelease
      })
      startup.legacyUserData = join(startup.home, 'user-data')
      startup.ready.mockResolvedValue(undefined)
      const original = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
      Object.defineProperty(process, 'resourcesPath', {
        value: join(startup.home, 'installed.app/Contents/Resources'),
        configurable: true,
      })
      try {
        await import('./bootstrap.js')

        await vi.waitFor(() => expect(startup.relaunch).toHaveBeenCalledOnce())
        expect(startup.rollback).toHaveBeenCalledOnce()
        expect(startup.activeRelease.id).toBe('source')
        expect(startup.restoreData).toHaveBeenCalledTimes(restoreRequired ? 1 : 0)
        if (restoreRequired) {
          expect(startup.restoreData.mock.calls[0]?.[2]).toBe('saved-data')
          expect(startup.restoreData.mock.invocationCallOrder[0]).toBeLessThan(
            startup.rollback.mock.invocationCallOrder[0]!
          )
        }
        expect(startup.rollback.mock.invocationCallOrder[0]).toBeLessThan(
          startup.relaunch.mock.invocationCallOrder[0]!
        )
        expect(startup.main).not.toHaveBeenCalled()
        expect(startup.showErrorBox).not.toHaveBeenCalled()
      } finally {
        if (original) Object.defineProperty(process, 'resourcesPath', original)
        else Reflect.deleteProperty(process, 'resourcesPath')
      }
    }
  )

  test('ordinary startup ignores an old selected version, missing bridge and foreign handoff root', async () => {
    startup.activation = null
    startup.metadata.version = '3.0.0'
    startup.activeRelease = { id: 'old', version: '2.0.0' }
    startup.bridge = '/missing/old/WeWork'
    vi.stubEnv('WEWORK_RELEASE_ROOT', '/obsolete/releases')

    await import('./bootstrap.js')

    expect(startup.main).toHaveBeenCalledOnce()
    expect(startup.relaunch).not.toHaveBeenCalled()
    expect(startup.showErrorBox).not.toHaveBeenCalled()
    expect(startup.enterInstalled).not.toHaveBeenCalled()
  })

  test('corrupt release history cannot block the installed app', async () => {
    startup.activation = null
    startup.historyError = new SyntaxError('Damaged release descriptor')
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await import('./bootstrap.js')
      expect(startup.main).toHaveBeenCalledOnce()
      expect(startup.showErrorBox).not.toHaveBeenCalled()
    } finally {
      warning.mockRestore()
    }
  })

  test('ordinary startup keeps the current installed release component composition without relaunching', async () => {
    startup.activation = null
    startup.metadata.version = '3.0.0'
    startup.activeRelease = {
      id: 'current',
      version: '3.0.0',
      executable: process.execPath,
      runtimeRoot: '/prepared/runtimes',
      componentDataDirectory: '/prepared/components',
      macosInstallation: { payloadExecutable: '/prepared/WeWork', bootstrapFromPayload: true },
    }
    await import('./bootstrap.js')
    expect(startup.main).toHaveBeenCalledOnce()
    expect(startup.enterInstalled).toHaveBeenCalledOnce()
    expect(process.env.WEWORK_HARNESS_RUNTIME_ROOT).toBe('/prepared/runtimes')
    expect(process.env.WEWORK_COMPONENT_DATA_DIRECTORY).toBe('/prepared/components')
    expect(startup.relaunch).not.toHaveBeenCalled()
  })

  test('macOS rollback uses the loaded bootstrap installer rather than the legacy bridge launcher', async () => {
    const resources = join(startup.home, 'installed.app/Contents/Resources')
    const original = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
    Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true })
    try {
      startup.metadata.version = '2.0.0'
      startup.legacyUserData = join(startup.home, '.wegent/workbench/wework/default/user-data')
      startup.bridge = join(startup.home, 'old-payload/WeWork')
      startup.activeRelease = {
        id: 'rolled-back',
        executable: process.execPath,
        version: '1.0.0',
        macosInstallation: { payloadExecutable: startup.bridge, bootstrapFromPayload: false },
      }
      startup.ready.mockResolvedValue(undefined)
      await import('./bootstrap.js')
      await vi.waitFor(() => expect(startup.relaunch).toHaveBeenCalled())
      expect(startup.relaunch.mock.calls[0][0]).toMatchObject({
        execPath: join(resources, 'wework-launcher'),
      })
      expect(process.env.WEWORK_USER_DATA_DIR).toBe(startup.legacyUserData)
      expect(process.env.WEWORK_RELEASE_ROOT).toBe(join(startup.legacyUserData, 'releases'))
      expect(startup.showErrorBox).not.toHaveBeenCalled()
    } finally {
      if (original) Object.defineProperty(process, 'resourcesPath', original)
      else Reflect.deleteProperty(process, 'resourcesPath')
    }
  })
}
