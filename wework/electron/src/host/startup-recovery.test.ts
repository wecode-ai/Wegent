import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { LocalJsonReadError } from '../runtime/local-json.js'
import { OpenAiCatalogStore } from './openai-catalog-store.js'
import {
  assertStartupRecoverySender,
  StartupRecoveryService,
  type StartupRecoveryDependencies,
} from './startup-recovery.js'

function createFixture() {
  const dependencies = {
    rendererStorage: {
      clear: vi.fn(async () => undefined),
      canRepairStartup: vi.fn(() => false),
      repairStartupState: vi.fn(async () => 'renderer-local-storage.json.corrupt-1'),
    },
    preferences: {
      clear: vi.fn(async () => undefined),
    },
    cloudCredentials: {
      clear: vi.fn(async () => undefined),
    },
    prepareCleanup: vi.fn(async () => undefined),
    clearRuntimeFiles: vi.fn(async () => undefined),
    clearUserFiles: vi.fn(async () => undefined),
    clearOpenAiCatalog: vi.fn(async () => undefined),
    clearCache: vi.fn(async () => undefined),
    clearAppStorage: vi.fn(async () => undefined),
    clearUserStorage: vi.fn(async () => undefined),
    disablePlugin: vi.fn(async () => undefined),
    log: vi.fn(),
    relaunch: vi.fn(),
    shutdown: vi.fn(),
  } satisfies StartupRecoveryDependencies
  return {
    dependencies,
    recovery: new StartupRecoveryService(dependencies),
  }
}

describe('StartupRecoveryService', () => {
  test('allows only the startup splash sender', () => {
    expect(() => assertStartupRecoverySender(7, 7)).not.toThrow()
    expect(() => assertStartupRecoverySender(7, null)).toThrow(
      'Startup recovery is only available from the startup splash'
    )
    expect(() => assertStartupRecoverySender(7, 8)).toThrow(
      'Startup recovery is only available from the startup splash'
    )
  })

  test('rebuilds runtime without clearing user state', async () => {
    const { dependencies, recovery } = createFixture()

    await recovery.run('workbench')

    expect(dependencies.prepareCleanup).toHaveBeenCalledOnce()
    expect(dependencies.clearRuntimeFiles).toHaveBeenCalledOnce()
    expect(dependencies.clearUserFiles).not.toHaveBeenCalled()
    expect(dependencies.clearOpenAiCatalog).not.toHaveBeenCalled()
    expect(dependencies.clearUserStorage).not.toHaveBeenCalled()
    expect(dependencies.clearCache).toHaveBeenCalledOnce()
    expect(dependencies.prepareCleanup.mock.invocationCallOrder[0]).toBeLessThan(
      dependencies.clearRuntimeFiles.mock.invocationCallOrder[0]
    )
    expect(dependencies.rendererStorage.clear).not.toHaveBeenCalled()
    expect(dependencies.preferences.clear).not.toHaveBeenCalled()
    expect(dependencies.cloudCredentials.clear).not.toHaveBeenCalled()
    expect(dependencies.relaunch).toHaveBeenCalledOnce()
    expect(dependencies.shutdown).toHaveBeenCalledOnce()
  })

  test('clears runtime, user settings, and plugins', async () => {
    const { dependencies, recovery } = createFixture()

    await recovery.run('app-state')

    expect(dependencies.rendererStorage.clear).toHaveBeenCalledOnce()
    expect(dependencies.preferences.clear).toHaveBeenCalledOnce()
    expect(dependencies.cloudCredentials.clear).toHaveBeenCalledOnce()
    expect(dependencies.clearCache).toHaveBeenCalledOnce()
    expect(dependencies.clearAppStorage).toHaveBeenCalledOnce()
    expect(dependencies.clearUserStorage).toHaveBeenCalledOnce()
    expect(dependencies.disablePlugin).not.toHaveBeenCalled()
    expect(dependencies.clearUserFiles).toHaveBeenCalledOnce()
    expect(dependencies.clearOpenAiCatalog).toHaveBeenCalledOnce()
    expect(dependencies.clearRuntimeFiles).toHaveBeenCalledOnce()
    expect(dependencies.relaunch).toHaveBeenCalledOnce()
    expect(dependencies.shutdown).toHaveBeenCalledOnce()
  })

  test('reports a catalog cleanup failure and still resets user state and relaunches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-recovery-catalog-'))
    try {
      const path = join(root, 'plugin-cache', 'openai-official-catalog.json')
      await mkdir(path, { recursive: true })
      const catalog = new OpenAiCatalogStore(root)
      const { dependencies, recovery } = createFixture()
      dependencies.clearOpenAiCatalog.mockImplementation(() => catalog.clear())

      await recovery.run('app-state')

      expect(dependencies.log).toHaveBeenCalledWith(
        'startup-recovery-clear-openai-catalog',
        'failed',
        { errorType: expect.any(String) }
      )
      expect((await stat(path)).isDirectory()).toBe(true)
      expect(dependencies.rendererStorage.clear).toHaveBeenCalledOnce()
      expect(dependencies.preferences.clear).toHaveBeenCalledOnce()
      expect(dependencies.cloudCredentials.clear).toHaveBeenCalledOnce()
      expect(dependencies.relaunch).toHaveBeenCalledOnce()
      expect(dependencies.shutdown).toHaveBeenCalledOnce()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('backs up damaged renderer state after stopping writers and relaunches', async () => {
    const { dependencies, recovery } = createFixture()
    const failure = new LocalJsonReadError('renderer-local-storage.json', 'INVALID_JSON')
    dependencies.rendererStorage.canRepairStartup.mockReturnValue(true)

    await recovery.repairStartup(failure)

    expect(dependencies.rendererStorage.repairStartupState).toHaveBeenCalledOnce()
    expect(dependencies.prepareCleanup.mock.invocationCallOrder[0]).toBeLessThan(
      dependencies.rendererStorage.repairStartupState.mock.invocationCallOrder[0]
    )
    expect(dependencies.clearRuntimeFiles).not.toHaveBeenCalled()
    expect(dependencies.clearCache).not.toHaveBeenCalled()
    expect(dependencies.clearAppStorage).not.toHaveBeenCalled()
    expect(dependencies.clearUserStorage).not.toHaveBeenCalled()
    expect(dependencies.clearUserFiles).not.toHaveBeenCalled()
    expect(dependencies.rendererStorage.clear).not.toHaveBeenCalled()
    expect(dependencies.preferences.clear).not.toHaveBeenCalled()
    expect(dependencies.cloudCredentials.clear).not.toHaveBeenCalled()
    expect(dependencies.relaunch).toHaveBeenCalledOnce()
    expect(dependencies.shutdown).toHaveBeenCalledOnce()
  })

  test('keeps file access or format failures on the manual recovery path', async () => {
    const { dependencies, recovery } = createFixture()
    const failure = new LocalJsonReadError('renderer-local-storage.json', 'EACCES')

    await expect(recovery.repairStartup(failure)).rejects.toThrow('manual recovery')
    expect(dependencies.prepareCleanup).not.toHaveBeenCalled()
    expect(dependencies.rendererStorage.repairStartupState).not.toHaveBeenCalled()
    expect(dependencies.clearRuntimeFiles).not.toHaveBeenCalled()
  })

  test('keeps recovery open when the renderer state repair fails', async () => {
    const { dependencies, recovery } = createFixture()
    dependencies.rendererStorage.repairStartupState.mockRejectedValueOnce(new Error('disk full'))

    await expect(recovery.run('renderer-state')).rejects.toThrow('disk full')

    expect(dependencies.relaunch).not.toHaveBeenCalled()
    expect(dependencies.shutdown).not.toHaveBeenCalled()
    await recovery.run('renderer-state')
    expect(dependencies.relaunch).toHaveBeenCalledOnce()
  })

  test('shares one recovery operation across repeated clicks', async () => {
    const { dependencies, recovery } = createFixture()

    await Promise.all([recovery.run('retry'), recovery.run('app-state')])

    expect(dependencies.rendererStorage.clear).not.toHaveBeenCalled()
    expect(dependencies.prepareCleanup).not.toHaveBeenCalled()
    expect(dependencies.clearRuntimeFiles).not.toHaveBeenCalled()
    expect(dependencies.relaunch).toHaveBeenCalledOnce()
    expect(dependencies.shutdown).toHaveBeenCalledOnce()
  })

  test('disables one detected plugin before relaunching', async () => {
    const { dependencies, recovery } = createFixture()

    await recovery.disablePlugin('@wegent/ai-fleet-defense')

    expect(dependencies.disablePlugin).toHaveBeenCalledWith('@wegent/ai-fleet-defense')
    expect(dependencies.rendererStorage.clear).not.toHaveBeenCalled()
    expect(dependencies.relaunch).toHaveBeenCalledOnce()
    expect(dependencies.shutdown).toHaveBeenCalledOnce()
  })

  test('logs cleanup failures without relaunching', async () => {
    const { dependencies, recovery } = createFixture()
    dependencies.clearRuntimeFiles.mockRejectedValueOnce(new Error('storage unavailable'))

    await expect(recovery.run('workbench')).rejects.toThrow('storage unavailable')

    expect(dependencies.log).toHaveBeenLastCalledWith(
      'startup-recovery-workbench-cleanup',
      'failed',
      { errorType: 'Error' }
    )
    expect(dependencies.relaunch).not.toHaveBeenCalled()
    expect(dependencies.shutdown).not.toHaveBeenCalled()
    expect(dependencies.clearCache).not.toHaveBeenCalled()

    await recovery.run('workbench')
    expect(dependencies.clearRuntimeFiles).toHaveBeenCalledTimes(2)
    expect(dependencies.relaunch).toHaveBeenCalledOnce()
  })
})
