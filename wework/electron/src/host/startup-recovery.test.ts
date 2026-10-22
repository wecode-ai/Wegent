import { describe, expect, test, vi } from 'vitest'
import {
  assertStartupRecoverySender,
  StartupRecoveryService,
  type StartupRecoveryDependencies,
} from './startup-recovery.js'

function createFixture() {
  const dependencies = {
    rendererStorage: {
      clear: vi.fn(async () => undefined),
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
    expect(dependencies.clearRuntimeFiles).toHaveBeenCalledOnce()
    expect(dependencies.relaunch).toHaveBeenCalledOnce()
    expect(dependencies.shutdown).toHaveBeenCalledOnce()
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
