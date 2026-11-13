import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, test, vi } from 'vitest'

const preparation = vi.hoisted(() => ({
  exit: vi.fn(),
  getPath: vi.fn(),
  initializeDesktopData: vi.fn(),
  prepareInstalledEnvironment: vi.fn(),
  resolveWorkbenchPaths: vi.fn(),
}))

vi.mock('electron', () => ({
  app: {
    exit: preparation.exit,
    getPath: preparation.getPath,
  },
}))
vi.mock('./installed-preparation.js', () => ({
  prepareInstalledEnvironment: preparation.prepareInstalledEnvironment,
}))
vi.mock('./workbench-desktop-startup.js', () => ({
  initializeWorkbenchDesktopData: preparation.initializeDesktopData,
}))
vi.mock('./workbench-environment.js', () => ({
  resolveWorkbenchPaths: preparation.resolveWorkbenchPaths,
}))
vi.mock('./workbench-migration-lock.js', () => ({
  executorMigrationLock: vi.fn(() => vi.fn()),
}))
vi.mock('./release-diagnostics.js', () => ({ recordReleaseDiagnostic: vi.fn() }))

const { prepareInstallation } = await import('./installed-preparation-bootstrap.js')
const roots: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

test('migrates the default desktop data layout before installation preparation writes to it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-installed-bootstrap-'))
  roots.push(root)
  const appData = join(root, 'app-data')
  const desktop = join(root, 'desktop')
  const userData = join(desktop, 'user-data')
  const order: string[] = []
  vi.stubEnv('WEWORK_USER_DATA_DIR', '')
  vi.stubEnv('WEWORK_APP_IDENTIFIER', 'test.wegent.wework')
  vi.stubEnv('WEWORK_EXECUTOR_PATH', join(root, 'wegent-executor'))
  preparation.getPath.mockImplementation((name: string) => (name === 'appData' ? appData : root))
  preparation.resolveWorkbenchPaths.mockReturnValue({ desktop })
  preparation.initializeDesktopData.mockImplementation(async () => {
    order.push('initialize')
    return { userData, logs: join(userData, 'logs') }
  })
  preparation.prepareInstalledEnvironment.mockImplementation(async () => {
    order.push('prepare')
  })

  await prepareInstallation({ version: '1.2.3' })

  expect(order).toEqual(['initialize', 'prepare'])
  expect(preparation.initializeDesktopData).toHaveBeenCalledWith(
    expect.objectContaining({
      source: join(appData, 'test.wegent.wework'),
      desktop,
      additionalData: { installedPreparation: true },
    })
  )
  expect(preparation.prepareInstalledEnvironment).toHaveBeenCalledWith(
    expect.objectContaining({
      dataDirectory: userData,
      statusFile: join(userData, 'logs', 'install-preparation.json'),
    })
  )
  expect(preparation.exit).toHaveBeenCalledWith(0)
})

test('keeps an explicitly configured user data directory independent from desktop migration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-installed-bootstrap-'))
  roots.push(root)
  const userData = join(root, 'isolated-user-data')
  vi.stubEnv('WEWORK_USER_DATA_DIR', userData)
  preparation.prepareInstalledEnvironment.mockResolvedValue(undefined)

  await prepareInstallation({ version: '1.2.3' })

  expect(preparation.initializeDesktopData).not.toHaveBeenCalled()
  expect(preparation.prepareInstalledEnvironment).toHaveBeenCalledWith(
    expect.objectContaining({ dataDirectory: userData })
  )
  expect(preparation.exit).toHaveBeenCalledWith(0)
})
