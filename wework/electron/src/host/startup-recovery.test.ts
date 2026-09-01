import { describe, expect, test, vi } from 'vitest'
import {
  assertStartupRecoverySender,
  StartupRecoveryService,
  WORKBENCH_RECOVERY_STORAGE_PREFIXES,
  type StartupRecoveryDependencies,
} from './startup-recovery.js'

function createFixture() {
  const dependencies = {
    rendererStorage: {
      clear: vi.fn(async () => undefined),
      removeByPrefixes: vi.fn(async () => undefined),
    },
    preferences: {
      clear: vi.fn(async () => undefined),
    },
    cloudCredentials: {
      clear: vi.fn(async () => undefined),
    },
    clearCache: vi.fn(async () => undefined),
    clearAppStorage: vi.fn(async () => undefined),
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

  test('recovers workbench restore state without clearing sign-in or preferences', async () => {
    const { dependencies, recovery } = createFixture()

    await recovery.run('workbench')

    expect(dependencies.rendererStorage.removeByPrefixes).toHaveBeenCalledWith(
      WORKBENCH_RECOVERY_STORAGE_PREFIXES
    )
    expect(dependencies.rendererStorage.clear).not.toHaveBeenCalled()
    expect(dependencies.preferences.clear).not.toHaveBeenCalled()
    expect(dependencies.cloudCredentials.clear).not.toHaveBeenCalled()
    expect(dependencies.relaunch).toHaveBeenCalledOnce()
    expect(dependencies.shutdown).toHaveBeenCalledOnce()
  })

  test('clears application state without deleting runtime-owned data', async () => {
    const { dependencies, recovery } = createFixture()

    await recovery.run('app-state')

    expect(dependencies.rendererStorage.clear).toHaveBeenCalledOnce()
    expect(dependencies.preferences.clear).toHaveBeenCalledOnce()
    expect(dependencies.cloudCredentials.clear).toHaveBeenCalledOnce()
    expect(dependencies.clearCache).toHaveBeenCalledOnce()
    expect(dependencies.clearAppStorage).toHaveBeenCalledOnce()
    expect(dependencies.rendererStorage.removeByPrefixes).not.toHaveBeenCalled()
    expect(dependencies.relaunch).toHaveBeenCalledOnce()
    expect(dependencies.shutdown).toHaveBeenCalledOnce()
  })

  test('shares one recovery operation across repeated clicks', async () => {
    const { dependencies, recovery } = createFixture()

    await Promise.all([recovery.run('retry'), recovery.run('app-state')])

    expect(dependencies.rendererStorage.clear).not.toHaveBeenCalled()
    expect(dependencies.relaunch).toHaveBeenCalledOnce()
    expect(dependencies.shutdown).toHaveBeenCalledOnce()
  })

  test('logs cleanup failures without relaunching', async () => {
    const { dependencies, recovery } = createFixture()
    dependencies.rendererStorage.removeByPrefixes.mockRejectedValueOnce(
      new Error('storage unavailable')
    )

    await expect(recovery.run('workbench')).rejects.toThrow('storage unavailable')

    expect(dependencies.log).toHaveBeenLastCalledWith(
      'startup-recovery-workbench-cleanup',
      'failed',
      { errorType: 'Error' }
    )
    expect(dependencies.relaunch).not.toHaveBeenCalled()
    expect(dependencies.shutdown).not.toHaveBeenCalled()
  })
})
