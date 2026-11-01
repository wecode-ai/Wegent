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
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => startup.home,
    on: vi.fn(),
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
      return startup.activeRelease
    }
    async activation() {
      return startup.activation
    }
  },
}))

beforeEach(() => {
  vi.resetModules()
  startup.roots.length = 0
  startup.metadata = {}
  startup.activeRelease = { id: 'pending-target' }
  startup.activation = null
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
    expect(startup.roots).toEqual([])
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
