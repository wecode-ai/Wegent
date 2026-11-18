import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { DesktopRelease, ReleaseActivation } from './runtime/release-store.js'

const resourcesPathDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath')

const startup = vi.hoisted(() => ({
  roots: [] as string[],
  metadata: {} as { weworkExecutorNamespace?: string; version?: string },
  activeRelease: { id: 'pending-target' } as Partial<DesktopRelease> | null,
  activation: null as Partial<ReleaseActivation> | null,
  bridgeHandoff: vi.fn(),
  showRecovery: vi.fn(),
  bridge: null as string | null,
  macosRollback: null as string | null,
  legacyUserData: null as string | null,
  ready: vi.fn(),
  relaunch: vi.fn(),
  home: '',
  main: vi.fn(),
  historyError: null as Error | null,
  enterInstalled: vi.fn(),
  rollback: vi.fn(),
  restoreData: vi.fn(),
  acquireStartup: vi.fn(),
  releaseStartup: vi.fn(),
  afterStopReady: vi.fn(),
  afterStopPrepare: vi.fn(),
  markers: {} as Record<string, string>,
  restoreConsent: vi.fn(),
  exit: vi.fn(),
}))

vi.mock('./runtime/release-startup-owner.js', () => ({
  acquireReleaseStartup: startup.acquireStartup,
}))

vi.mock('./runtime/release-after-stop.js', () => ({
  assertReleaseAfterStopReady: startup.afterStopReady,
  prepareReleaseAfterStop: startup.afterStopPrepare,
}))

vi.mock('./host/startup-recovery-window.js', () => ({
  showStartupRecovery: startup.showRecovery,
}))

vi.mock('./runtime/release-snapshot.js', () => ({ restoreReleaseData: startup.restoreData }))

vi.mock('./runtime/macos-release-installation.js', () => ({
  enterInstalledMacosRelease: startup.enterInstalled,
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => startup.home,
    getLocale: () => 'en',
    on: vi.fn(),
    removeListener: vi.fn(),
    whenReady: startup.ready,
    relaunch: startup.relaunch,
    exit: startup.exit,
    setActivationPolicy: vi.fn(),
  },
  dialog: { showMessageBox: startup.restoreConsent },
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

vi.mock('./runtime/release-store.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./runtime/release-store.js')>()
  return {
    ...actual,
    atomicReleaseWrite: async (path: string, value: string) => {
      startup.markers[basename(path)] = value
    },
    optionalText: async (path: string) =>
      startup.markers[basename(path)] ??
      (basename(path) === 'bridge'
        ? startup.bridge
        : basename(path) === 'macos-rollback'
          ? startup.macosRollback
          : null),
    ReleaseStore: class {
      constructor(readonly root: string) {
        startup.roots.push(root)
      }

      async isSlotExecutable(executable: string) {
        return actual.ReleaseStore.prototype.isSlotExecutable.call(this as never, executable)
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
  }
})

beforeEach(() => {
  Object.defineProperty(process, 'resourcesPath', {
    value: join(tmpdir(), 'wework-bootstrap-resources'),
    configurable: true,
  })
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
  startup.releaseStartup.mockReset().mockResolvedValue(undefined)
  startup.acquireStartup.mockReset().mockResolvedValue(startup.releaseStartup)
  startup.afterStopReady.mockReset().mockResolvedValue(undefined)
  startup.afterStopPrepare.mockReset().mockResolvedValue(undefined)
  startup.markers = {}
  startup.restoreConsent.mockReset().mockResolvedValue({ response: 0 })
  startup.exit.mockReset()
  startup.bridgeHandoff.mockReset().mockImplementation(async () => startup.legacyUserData)
  startup.showRecovery.mockReset().mockResolvedValue(undefined)
  startup.bridge = null
  startup.macosRollback = null
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
  vi.stubEnv('WEWORK_STARTUP_RECOVERY', '')
  for (const name of [
    'WEWORK_HARNESS_RUNTIME_ROOT',
    'WEWORK_ACTIVE_RELEASE_ID',
    'WEWORK_COMPONENT_DATA_DIRECTORY',
  ])
    vi.stubEnv(name, '')
})

afterEach(() => {
  vi.unstubAllEnvs()
  if (resourcesPathDescriptor)
    Object.defineProperty(process, 'resourcesPath', resourcesPathDescriptor)
  else Reflect.deleteProperty(process, 'resourcesPath')
})

test('a concurrent recovery entry waits before reading or restoring the shared transaction', async () => {
  let grant!: (release: () => Promise<void>) => void
  startup.acquireStartup.mockImplementation(
    () =>
      new Promise(resolve => {
        grant = resolve
      })
  )
  startup.activation = { token: 'rollback', rollbackRequested: true }
  const loading = import('./bootstrap.js')
  await vi.waitFor(() => expect(startup.acquireStartup).toHaveBeenCalledOnce())
  expect(startup.roots).toHaveLength(0)
  expect(startup.rollback).not.toHaveBeenCalled()
  expect(startup.restoreData).not.toHaveBeenCalled()
  expect(startup.relaunch).not.toHaveBeenCalled()
  expect(startup.main).not.toHaveBeenCalled()
  expect(startup.releaseStartup).not.toHaveBeenCalled()
  expect(startup.showRecovery).not.toHaveBeenCalled()
  grant(startup.releaseStartup)
  await loading
  expect(startup.roots).toHaveLength(1)
})

test('startup ownership failure cannot open application data', async () => {
  startup.acquireStartup.mockRejectedValue(new Error('Native startup lock failed'))
  await import('./bootstrap.js')
  expect(startup.main).not.toHaveBeenCalled()
  expect(startup.rollback).not.toHaveBeenCalled()
  expect(startup.showRecovery).toHaveBeenCalledWith(new Error('Native startup lock failed'))
})

test('lost startup ownership terminates data routing and relaunches isolated recovery', async () => {
  await import('./bootstrap.js')
  const lost = startup.acquireStartup.mock.calls[0]?.[2] as (error: Error) => void
  lost(new Error('Native release startup lock was lost'))
  expect(process.env.WEWORK_STARTUP_RECOVERY).toBe('Native release startup lock was lost')
  expect(startup.relaunch).toHaveBeenCalledWith({ args: expect.any(Array) })
  expect(startup.exit).toHaveBeenCalledWith(1)
  expect(startup.main).not.toHaveBeenCalled()
  expect(startup.restoreData).not.toHaveBeenCalled()
})

test('ordinary startup releases transaction ownership before entering the main application', async () => {
  startup.activation = null
  startup.activeRelease = null
  startup.main.mockImplementationOnce(() => {
    expect(startup.releaseStartup).toHaveBeenCalledOnce()
  })
  await import('./bootstrap.js')
  expect(startup.main).toHaveBeenCalledOnce()
  expect(startup.releaseStartup).toHaveBeenCalledOnce()
})

test('routing errors release transaction ownership before opening recovery', async () => {
  startup.bridge = join(startup.home, 'missing-bridge')
  startup.bridgeHandoff.mockRejectedValue(new Error('Cannot resolve healthy bridge'))
  startup.showRecovery.mockImplementationOnce(async () => {
    expect(startup.releaseStartup).toHaveBeenCalledOnce()
  })
  await import('./bootstrap.js')
  expect(startup.showRecovery).toHaveBeenCalledWith(new Error('Cannot resolve healthy bridge'))
  expect(startup.main).not.toHaveBeenCalled()
})

test('failed ownership release cannot enter the main application', async () => {
  startup.activation = null
  startup.activeRelease = null
  startup.releaseStartup.mockRejectedValue(new Error('Native startup lock was lost'))
  await import('./bootstrap.js')
  expect(startup.main).not.toHaveBeenCalled()
  expect(startup.releaseStartup).toHaveBeenCalledOnce()
  expect(startup.showRecovery).toHaveBeenCalledWith(new Error('Native startup lock was lost'))
})

test('a native launcher failure opens recovery without loading release records or main', async () => {
  vi.stubEnv('WEWORK_STARTUP_RECOVERY', 'Selected program is unavailable')
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    await import('./bootstrap.js')
    expect(startup.showRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Selected program is unavailable' })
    )
    expect(startup.roots).toEqual([])
    expect(startup.main).not.toHaveBeenCalled()
    expect(process.env.WEWORK_STARTUP_RECOVERY).toBeUndefined()
  } finally {
    diagnostic.mockRestore()
  }
})

test.each(['default', 'com.example.wework'])(
  'reads pending activation from the migrated %s userData directory',
  async namespace => {
    if (namespace !== 'default') startup.metadata.weworkExecutorNamespace = namespace
    const root = join(startup.home, '.wegent/workbench/wework', namespace, 'user-data/releases')
    vi.stubEnv('WEWORK_RELEASE_ROOT', root)

    await import('./bootstrap.js')

    expect(startup.showRecovery).not.toHaveBeenCalled()
    expect(startup.roots).toEqual([root])
  }
)

test('keeps an explicit isolated userData directory as the release store owner', async () => {
  const isolated = join(startup.home, 'isolated')
  vi.stubEnv('WEWORK_USER_DATA_DIR', isolated)
  vi.stubEnv('WEWORK_RELEASE_ROOT', join(isolated, 'releases'))

  await import('./bootstrap.js')

  expect(startup.showRecovery).not.toHaveBeenCalled()
  expect(startup.roots).toEqual([join(isolated, 'releases')])
})

test('accepts the physical release store handed off by a repaired legacy launcher', async () => {
  vi.stubEnv('WEWORK_USER_DATA_DIR', join(startup.home, 'user-data'))
  vi.stubEnv('WEWORK_RELEASE_ROOT', join(startup.home, 'legacy/releases'))

  await import('./bootstrap.js')

  expect(startup.showRecovery).not.toHaveBeenCalled()
  expect(startup.roots).toEqual([join(startup.home, 'user-data/releases')])
})

test('rejects a handoff to a different physical release store', async () => {
  vi.stubEnv('WEWORK_USER_DATA_DIR', join(startup.home, 'user-data'))
  vi.stubEnv('WEWORK_RELEASE_ROOT', join(startup.home, 'other/releases'))
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    await import('./bootstrap.js')
    expect(startup.showRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Release root does not match the application data directory',
      })
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
  expect(startup.showRecovery).not.toHaveBeenCalled()
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
    expect(startup.showRecovery).not.toHaveBeenCalled()
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
  expect(startup.showRecovery).not.toHaveBeenCalled()
})

test.each([
  'ordinary',
  'activation',
  'rollback',
  'supervised',
  'recovery',
  'different-path',
  'versioned-slot',
  'same-version',
] as const)('Windows in-place replacement respects %s launch ownership', async mode => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
  startup.metadata.version = '2.0.0'
  startup.activeRelease = {
    id: mode === 'versioned-slot' ? 'downloaded-source' : 'installed-source',
    version: mode === 'same-version' ? '2.0.0' : '1.0.0',
    executable:
      mode === 'different-path' ? join(startup.home, 'other/WeWork.exe') : process.execPath,
  }
  startup.activation =
    mode === 'activation' || mode === 'rollback'
      ? { token: 'trial', from: 'source', to: 'target', rollbackRequested: mode === 'rollback' }
      : null
  if (mode === 'supervised') vi.stubEnv('WEWORK_RELEASE_SUPERVISED', 'installed-source')
  if (mode === 'recovery') vi.stubEnv('WEWORK_RELEASE_RECOVERY', 'trial')
  try {
    await import('./bootstrap.js')

    if (mode === 'ordinary') {
      expect(startup.main).toHaveBeenCalledOnce()
      expect(startup.ready).not.toHaveBeenCalled()
      expect(startup.showRecovery).not.toHaveBeenCalled()
      expect(process.env.WEWORK_ACTIVE_RELEASE_ID).toBe('')
      expect(process.env.WEWORK_HARNESS_RUNTIME_ROOT).toBe('')
    } else {
      expect(startup.main).not.toHaveBeenCalled()
      if (mode === 'supervised') {
        expect(startup.showRecovery).toHaveBeenCalledWith(
          expect.objectContaining({
            message: 'The installed host does not match the selected release version',
          })
        )
      } else {
        expect(startup.ready).toHaveBeenCalledOnce()
        expect(startup.showRecovery).not.toHaveBeenCalled()
      }
    }
  } finally {
    Object.defineProperty(process, 'platform', platform)
    diagnostic.mockRestore()
  }
})

test('the bridge waits for stopped preparation before granting a launcher any health budget', async () => {
  startup.bridge = process.execPath
  startup.activeRelease = { id: 'target', executable: join(startup.home, 'target/WeWork') }
  startup.legacyUserData = join(startup.home, '.wegent/workbench/wework/default/user-data')
  startup.ready.mockResolvedValue(undefined)
  let finish!: () => void
  startup.afterStopPrepare.mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        finish = resolve
      })
  )
  await import('./bootstrap.js')
  await vi.waitFor(() => expect(startup.afterStopPrepare).toHaveBeenCalledOnce())
  expect(startup.relaunch).not.toHaveBeenCalled()
  expect(startup.main).not.toHaveBeenCalled()
  finish()
  await vi.waitFor(() => expect(startup.relaunch).toHaveBeenCalledOnce())
})

test.each([false, true])(
  'stopped preparation uses the runtime Home with explicit Codex override=%s',
  async explicitCodex => {
    startup.bridge = process.execPath
    startup.activeRelease = { id: 'target', executable: join(startup.home, 'target/WeWork') }
    startup.legacyUserData = join(startup.home, '.wegent/workbench/wework/default/user-data')
    startup.ready.mockResolvedValue(undefined)
    const executorHome = join(startup.home, 'custom-executor')
    const codexHome = explicitCodex
      ? join(startup.home, 'explicit-codex')
      : join(executorHome, 'codex')
    vi.stubEnv('WEGENT_EXECUTOR_HOME', executorHome)
    vi.stubEnv('WEGENT_CODEX_HOME', explicitCodex ? codexHome : '')
    await import('./bootstrap.js')
    await vi.waitFor(() => expect(startup.afterStopPrepare).toHaveBeenCalledOnce())
    expect(startup.afterStopPrepare).toHaveBeenCalledWith(
      expect.anything(),
      startup.activeRelease,
      startup.legacyUserData,
      expect.objectContaining({ codexHome })
    )
  }
)

test('a supervised target cannot open data or recover Goals without its stopped-preparation receipt', async () => {
  startup.activeRelease = { id: 'target', version: '1.1.0', executable: process.execPath }
  startup.metadata.version = '1.1.0'
  vi.stubEnv('WEWORK_RELEASE_SUPERVISED', 'target')
  startup.afterStopReady.mockRejectedValue(new Error('bridge receipt missing'))
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    await import('./bootstrap.js')
    expect(startup.showRecovery).toHaveBeenCalledWith(new Error('bridge receipt missing'))
    expect(startup.main).not.toHaveBeenCalled()
    expect(startup.enterInstalled).not.toHaveBeenCalled()
  } finally {
    diagnostic.mockRestore()
  }
})

test.each([false, true])(
  'stopped-preparation failure reuses rollback, requiring restore consent only for incompatible data (%s)',
  async incompatible => {
    startup.bridge = process.execPath
    startup.activeRelease = { id: 'target', executable: join(startup.home, 'target/WeWork') }
    startup.activation = {
      token: 'trial',
      to: 'target',
      from: 'source',
      restoreRequired: incompatible,
      snapshot: 'original-snapshot',
    }
    startup.legacyUserData = join(startup.home, '.wegent/workbench/wework/default/user-data')
    startup.ready.mockResolvedValue(undefined)
    startup.restoreConsent.mockResolvedValue({ response: 1 })
    startup.afterStopPrepare.mockImplementationOnce(async () => {
      startup.markers['data-opened'] = 'trial'
      throw new Error('stopped preparation interrupted')
    })
    startup.rollback.mockImplementation(async () => {
      startup.activeRelease = { id: 'source', executable: process.execPath }
      startup.activation = null
    })
    await import('./bootstrap.js')
    await vi.waitFor(() => expect(startup.relaunch).toHaveBeenCalledOnce())
    expect(startup.rollback).toHaveBeenCalledOnce()
    expect(startup.restoreConsent).toHaveBeenCalledTimes(incompatible ? 1 : 0)
    expect(startup.restoreData).toHaveBeenCalledTimes(incompatible ? 1 : 0)
    expect(startup.main).not.toHaveBeenCalled()
    expect(startup.showRecovery).not.toHaveBeenCalled()
  }
)

test('declining incompatible stopped-preparation recovery never restores or starts either runtime', async () => {
  startup.bridge = process.execPath
  startup.activeRelease = { id: 'target', executable: join(startup.home, 'target/WeWork') }
  startup.activation = {
    token: 'trial',
    to: 'target',
    from: 'source',
    restoreRequired: true,
    snapshot: 'original-snapshot',
  }
  startup.ready.mockResolvedValue(undefined)
  startup.afterStopPrepare.mockImplementationOnce(async () => {
    startup.markers['data-opened'] = 'trial'
    throw new Error('stopped preparation interrupted')
  })
  await import('./bootstrap.js')
  await vi.waitFor(() => expect(startup.showRecovery).toHaveBeenCalledOnce())
  expect(startup.exit).not.toHaveBeenCalled()
  expect(startup.restoreConsent).toHaveBeenCalledOnce()
  expect(startup.restoreData).not.toHaveBeenCalled()
  expect(startup.rollback).not.toHaveBeenCalled()
  expect(startup.relaunch).not.toHaveBeenCalled()
  expect(startup.main).not.toHaveBeenCalled()
})

if (process.platform === 'darwin') {
  test('an installed entry resumes a selected rollback before its physical bundle was restored', async () => {
    startup.activation = null
    startup.macosRollback = 'source'
    startup.metadata.version = '2.0.0'
    startup.activeRelease = {
      id: 'source',
      version: '1.0.0',
      executable: process.execPath,
      macosInstallation: { payloadExecutable: '/retained/source', bootstrapFromPayload: false },
    }

    await import('./bootstrap.js')

    expect(startup.main).not.toHaveBeenCalled()
    expect(startup.ready).toHaveBeenCalledOnce()
  })

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
        expect(startup.showRecovery).not.toHaveBeenCalled()
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
    expect(startup.showRecovery).not.toHaveBeenCalled()
    expect(startup.enterInstalled).not.toHaveBeenCalled()
  })

  test('corrupt release history cannot block the installed app', async () => {
    startup.activation = null
    startup.historyError = new SyntaxError('Damaged release descriptor')
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await import('./bootstrap.js')
      expect(startup.main).toHaveBeenCalledOnce()
      expect(startup.showRecovery).not.toHaveBeenCalled()
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
      expect(startup.showRecovery).not.toHaveBeenCalled()
    } finally {
      if (original) Object.defineProperty(process, 'resourcesPath', original)
      else Reflect.deleteProperty(process, 'resourcesPath')
    }
  })
}
