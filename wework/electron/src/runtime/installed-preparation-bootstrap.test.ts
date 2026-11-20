import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, test, vi } from 'vitest'

const preparation = vi.hoisted(() => ({
  exit: vi.fn(),
  getPath: vi.fn(),
  initializeDesktopData: vi.fn(),
  prepareInstalledEnvironment: vi.fn(),
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
vi.mock('./release-diagnostics.js', () => ({ recordReleaseDiagnostic: vi.fn() }))

const { prepareInstallation } = await import('./installed-preparation-bootstrap.js')
const roots: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

test('selects the default desktop data directory and obtains the instance lock before preparation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-installed-bootstrap-'))
  roots.push(root)
  const userData = join(root, '.wegent', 'workbench', 'wework', 'installer-test', 'user-data')
  const order: string[] = []
  vi.stubEnv('WEWORK_USER_DATA_DIR', '')
  vi.stubEnv('WEGENT_WORKBENCH_HOME', '')
  vi.stubEnv('HOME', root)
  preparation.getPath.mockReturnValue(root)
  preparation.initializeDesktopData.mockImplementation(() => {
    order.push('initialize')
    return true
  })
  preparation.prepareInstalledEnvironment.mockImplementation(async () => {
    order.push('prepare')
  })

  await prepareInstallation({ version: '1.2.3', weworkExecutorNamespace: 'installer-test' })

  expect(order).toEqual(['initialize', 'prepare'])
  expect(preparation.initializeDesktopData).toHaveBeenCalledWith(
    expect.objectContaining({ getPath: preparation.getPath }),
    userData,
    { installedPreparation: true }
  )
  expect(preparation.prepareInstalledEnvironment).toHaveBeenCalledWith(
    expect.objectContaining({
      dataDirectory: userData,
      statusFile: join(userData, 'logs', 'install-preparation.json'),
    })
  )
  expect(preparation.exit).toHaveBeenCalledWith(0)
})

test('uses the explicitly configured user data directory', async () => {
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
