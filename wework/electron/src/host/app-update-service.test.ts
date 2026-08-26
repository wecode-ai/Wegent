import { EventEmitter } from 'node:events'
import { describe, expect, test, vi } from 'vitest'
import type { AppUpdater, UpdateCheckResult } from 'electron-updater'
import { AppUpdateService } from './app-update-service.js'

class FakeUpdater extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  allowPrerelease = false
  channel: string | null = null
  setFeedURL = vi.fn()
  checkForUpdates = vi.fn<() => Promise<UpdateCheckResult | null>>()
  downloadUpdate = vi.fn<() => Promise<string[]>>()
  quitAndInstall = vi.fn()
}

function service(updater: FakeUpdater, overrides: { packaged?: boolean } = {}) {
  return new AppUpdateService({
    updater: updater as unknown as AppUpdater,
    currentVersion: () => '0.2.6',
    isPackaged: () => overrides.packaged ?? true,
    prepareInstall: vi.fn().mockResolvedValue(undefined),
    updateBaseUrl: 'https://example.com/wework-updater/',
  })
}

describe('AppUpdateService', () => {
  test('checks the stable Electron update channel without downloading automatically', async () => {
    const updater = new FakeUpdater()
    updater.checkForUpdates.mockResolvedValue({
      updateInfo: {
        version: '0.2.7',
        files: [],
        path: 'WeWork_0.2.7_windows_x64-setup.exe',
        sha512: 'sha',
        releaseDate: '2026-08-25T00:00:00Z',
        releaseNotes: 'Changes',
      },
      cancellationToken: {} as never,
      downloadPromise: null,
      isUpdateAvailable: true,
    })

    await expect(service(updater).check('stable')).resolves.toEqual({
      currentVersion: '0.2.6',
      version: '0.2.7',
      body: 'Changes',
    })
    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(false)
    expect(updater.channel).toBe('latest')
    expect(updater.allowPrerelease).toBe(false)
    expect(updater.setFeedURL).toHaveBeenCalledWith({
      provider: 'generic',
      url: 'https://example.com/wework-updater',
    })
  })

  test('downloads once, forwards progress, prepares shutdown, and installs', async () => {
    const updater = new FakeUpdater()
    const prepareInstall = vi.fn().mockResolvedValue(undefined)
    updater.checkForUpdates.mockResolvedValue({
      updateInfo: {
        version: '0.3.0-beta.1',
        files: [],
        path: 'beta',
        sha512: 'sha',
        releaseDate: '2026-08-25T00:00:00Z',
      },
      cancellationToken: {} as never,
      downloadPromise: null,
      isUpdateAvailable: true,
    })
    updater.downloadUpdate.mockImplementation(async () => {
      updater.emit('download-progress', { transferred: 40, total: 100 })
      return ['update']
    })
    const appUpdate = new AppUpdateService({
      updater: updater as unknown as AppUpdater,
      currentVersion: () => '0.2.6',
      isPackaged: () => true,
      prepareInstall,
      updateBaseUrl: 'https://example.com',
    })

    await appUpdate.check('beta')
    await Promise.all([appUpdate.download(), appUpdate.download()])
    const install = appUpdate.createInstallAction()
    expect(prepareInstall).not.toHaveBeenCalled()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    await install()

    expect(updater.channel).toBe('beta')
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(appUpdate.downloadProgress()).toEqual({ downloadedBytes: 40, totalBytes: 100 })
    expect(prepareInstall).toHaveBeenCalledTimes(1)
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  test('rejects install actions before the pending update finishes downloading', async () => {
    const updater = new FakeUpdater()
    updater.checkForUpdates.mockResolvedValue({
      updateInfo: {
        version: '0.2.7',
        files: [],
        path: 'pending',
        sha512: 'sha',
        releaseDate: '2026-08-25T00:00:00Z',
      },
      cancellationToken: {} as never,
      downloadPromise: null,
      isUpdateAvailable: true,
    })

    const appUpdate = service(updater)
    await appUpdate.check('stable')

    expect(() => appUpdate.createInstallAction()).toThrow('has not finished downloading')
  })

  test('rejects checks from an unpackaged development app', async () => {
    const updater = new FakeUpdater()
    await expect(service(updater, { packaged: false }).check('stable')).rejects.toThrow(
      'packaged desktop app'
    )
  })

  test('returns null when electron-updater reports the current version', async () => {
    const updater = new FakeUpdater()
    updater.checkForUpdates.mockResolvedValue({
      updateInfo: {
        version: '0.2.6',
        files: [],
        path: 'current',
        sha512: 'sha',
        releaseDate: '2026-08-25T00:00:00Z',
      },
      cancellationToken: {} as never,
      downloadPromise: null,
      isUpdateAvailable: false,
    })

    const appUpdate = service(updater)
    await expect(appUpdate.check('stable')).resolves.toBeNull()
    await expect(appUpdate.download()).rejects.toThrow('No pending Wework update')
  })
})
