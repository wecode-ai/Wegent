import { describe, expect, test, vi } from 'vitest'
import { AppUpdater, type UpdateInfo } from 'electron-updater'
import { AppUpdateService, type WeworkUpdateChannel } from './app-update-service.js'

// Keep electron-updater's real channel setter and SemVer decision logic.
// Only the application adapter and remote release metadata are replaced.
class ReleaseUpdater extends AppUpdater {
  release: UpdateInfo
  doDownloadUpdate = vi.fn(async () => [])
  quitAndInstall = vi.fn()

  constructor(currentVersion: string, targetVersion: string) {
    super(null, {
      version: currentVersion,
      name: 'Wework test',
      isPackaged: true,
      appUpdateConfigPath: '',
      userDataPath: '',
      baseCachePath: '',
      whenReady: async () => undefined,
      relaunch: () => undefined,
      quit: () => undefined,
      onQuit: () => undefined,
    })
    this.release = { version: targetVersion, files: [], releaseDate: '' }
    this.logger = null
    this.isUserWithinRollout = async () => true
    this.isUpdateSupported = async () => true
  }

  protected async getUpdateInfoAndProvider() {
    return { info: this.release, provider: {} as never }
  }
}

function setup(current: string, target: string) {
  const updater = new ReleaseUpdater(current, target)
  const service = new AppUpdateService({
    updater,
    currentVersion: () => current,
    isPackaged: () => true,
    prepareUpdate: vi.fn(async () => undefined),
    prepareInstall: vi.fn(async () => undefined),
    updateBaseUrl: 'https://example.test',
  })
  return { updater, service }
}

describe('app update release policy with electron-updater', () => {
  test.each([
    ['0.5.0-beta.1', 'stable', '0.4.3', 'downgrade-to-stable'],
    ['0.5.0-beta.1', 'stable', '0.5.0', 'return-to-stable'],
    ['0.4.2', 'stable', '0.4.3', 'upgrade-stable'],
    ['0.4.3', 'stable', '0.4.3', null],
    ['0.5.0', 'stable', '0.4.3', null],
    ['0.4.3', 'beta', '0.5.0-beta.1', 'upgrade-beta'],
    ['0.4.3', 'beta', '0.5.0', 'upgrade-stable'],
    ['0.5.0-beta.1', 'beta', '0.5.0-beta.2', 'upgrade-beta'],
    ['0.5.0-beta.1', 'beta', '0.5.0', 'upgrade-stable'],
    ['0.5.0-beta.1', 'beta', '0.4.3', null],
    ['0.5.0', 'beta', '0.5.0-beta.2', null],
    ['0.5.0-beta.2', 'beta', '0.5.0-beta.1', null],
    ['0.5.0-beta.2', 'beta', '0.5.0-beta.2', null],
    ['0.5.0-beta.2', 'beta', '0.5.0-beta.10', 'upgrade-beta'],
    ['0.5.0+build.1', 'stable', '0.5.0+build.2', null],
  ])('%s on %s with %s yields %s', async (current, channel, target, kind) => {
    const { updater, service } = setup(current, target)
    const update = await service.check(channel as WeworkUpdateChannel)
    if (kind === null) {
      expect(update).toBeNull()
      await expect(service.download()).rejects.toThrow('No pending Wework update')
    } else {
      expect(update).toMatchObject({ currentVersion: current, version: target, kind })
    }
    expect(updater.doDownloadUpdate).not.toHaveBeenCalled()
  })

  test('resets downgrade permission and clears pending rollback when opting back into Beta', async () => {
    const { updater, service } = setup('0.5.0-beta.1', '0.4.3')
    await expect(service.check('stable')).resolves.toMatchObject({ kind: 'downgrade-to-stable' })
    expect(updater.allowDowngrade).toBe(true)
    await expect(service.check('beta')).resolves.toBeNull()
    expect(updater.allowDowngrade).toBe(false)
    await expect(service.download()).rejects.toThrow('No pending Wework update')
  })

  test('does not offer a prerelease from an invalid stable manifest', async () => {
    const { service } = setup('0.4.3', '0.5.0-beta.1')
    await expect(service.check('stable')).rejects.toThrow('stable release')
    await expect(service.download()).rejects.toThrow('No pending Wework update')
  })
})
