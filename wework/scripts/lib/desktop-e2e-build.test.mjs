import { constants } from 'node:fs'
import { describe, expect, test, vi } from 'vitest'

import { prepareDesktopE2EBuild, resolvePackagedDesktopE2EBuild } from './desktop-e2e-build.mjs'

describe('resolvePackagedDesktopE2EBuild', () => {
  test.each([
    [
      { arch: 'arm64', platform: 'darwin' },
      {
        appBinary:
          '/repo/wework/electron/release/WeWork-darwin-arm64/WeWork.app/Contents/MacOS/WeWork',
        executorBinary:
          '/repo/wework/electron/release/WeWork-darwin-arm64/WeWork.app/Contents/Resources/bin/wegent-executor',
      },
    ],
    [
      { arch: 'x64', platform: 'linux' },
      {
        appBinary: '/repo/wework/electron/release/WeWork-linux-x64/WeWork',
        executorBinary:
          '/repo/wework/electron/release/WeWork-linux-x64/resources/bin/wegent-executor',
      },
    ],
    [
      { arch: 'x64', platform: 'win32' },
      {
        appBinary: '/repo/wework/electron/release/WeWork-win32-x64/WeWork.exe',
        executorBinary:
          '/repo/wework/electron/release/WeWork-win32-x64/resources/bin/wegent-executor.exe',
      },
    ],
  ])('resolves the packaged binaries for $platform-$arch', (runtime, expected) => {
    expect(resolvePackagedDesktopE2EBuild('/repo/wework', runtime)).toEqual(expected)
  })
})

describe('prepareDesktopE2EBuild', () => {
  test('builds and validates both binaries when no prebuilt paths are configured', async () => {
    const runBuild = vi.fn()
    const checkAccess = vi.fn()

    await expect(
      prepareDesktopE2EBuild({
        checkAccess,
        environment: {},
        runBuild,
        runtime: { arch: 'arm64', platform: 'darwin' },
        weworkDir: '/repo/wework',
      })
    ).resolves.toEqual({
      appBinary:
        '/repo/wework/electron/release/WeWork-darwin-arm64/WeWork.app/Contents/MacOS/WeWork',
      executorBinary:
        '/repo/wework/electron/release/WeWork-darwin-arm64/WeWork.app/Contents/Resources/bin/wegent-executor',
    })
    expect(runBuild).toHaveBeenCalledOnce()
    expect(checkAccess).toHaveBeenCalledTimes(2)
    expect(checkAccess).toHaveBeenCalledWith(expect.any(String), constants.X_OK)
  })

  test('reuses and validates a complete configured build without rebuilding', async () => {
    const runBuild = vi.fn()
    const checkAccess = vi.fn()

    await expect(
      prepareDesktopE2EBuild({
        checkAccess,
        environment: {
          WEWORK_E2E_APP_BIN: '/tmp/WeWork',
          WEWORK_E2E_EXECUTOR_BIN: '/tmp/wegent-executor',
        },
        runBuild,
        weworkDir: '/repo/wework',
      })
    ).resolves.toEqual({
      appBinary: '/tmp/WeWork',
      executorBinary: '/tmp/wegent-executor',
    })
    expect(runBuild).not.toHaveBeenCalled()
    expect(checkAccess).toHaveBeenCalledTimes(2)
  })

  test('rejects a partial configured build instead of mixing unrelated binaries', async () => {
    await expect(
      prepareDesktopE2EBuild({
        environment: { WEWORK_E2E_APP_BIN: '/tmp/WeWork' },
        runBuild: vi.fn(),
        weworkDir: '/repo/wework',
      })
    ).rejects.toThrow('WEWORK_E2E_APP_BIN and WEWORK_E2E_EXECUTOR_BIN must be configured together')
  })

  test('fails when the build command does not produce an executable application', async () => {
    const checkAccess = vi.fn(async path => {
      if (path.endsWith('/WeWork')) throw new Error('missing')
    })

    await expect(
      prepareDesktopE2EBuild({
        checkAccess,
        environment: {},
        runBuild: vi.fn(),
        runtime: { arch: 'x64', platform: 'linux' },
        weworkDir: '/repo/wework',
      })
    ).rejects.toThrow(
      'Wework desktop E2E application is not executable: /repo/wework/electron/release/WeWork-linux-x64/WeWork'
    )
  })
})
