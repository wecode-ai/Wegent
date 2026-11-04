import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  checkForWeworkUpdate,
  downloadPendingWeworkUpdate,
  installDownloadedWeworkUpdate,
} from './app-updater'

const desktopHostMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  flush: vi.fn(async () => undefined),
}))

vi.mock('@/desktop/localStoragePersistence', () => ({
  flushDesktopLocalStoragePersistence: desktopHostMocks.flush,
}))

vi.mock('./runtime-environment', () => ({
  isElectronRuntime: () => true,
}))

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: desktopHostMocks.invoke,
}))

function setUserAgent(userAgent: string) {
  vi.stubGlobal('navigator', { userAgent })
}

describe('Wework app updater', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.restoreAllMocks()
    desktopHostMocks.invoke.mockReset()
    desktopHostMocks.flush.mockReset().mockResolvedValue(undefined)
  })

  test('does not invoke the Electron updater on Linux', async () => {
    setUserAgent('Mozilla/5.0 (X11; Linux x86_64)')

    await expect(checkForWeworkUpdate('stable')).rejects.toThrow(
      'Wework updater is not available on Linux'
    )
    expect(desktopHostMocks.invoke).not.toHaveBeenCalled()
  })

  test('surfaces the download failure reported by the desktop host', async () => {
    desktopHostMocks.invoke.mockImplementation(async capability => {
      if (capability === 'appUpdate.check') {
        return { currentVersion: '0.2.6', readyToInstall: false, version: '0.2.7' }
      }
      if (capability === 'appUpdate.downloadProgress') {
        return {
          downloadedBytes: 10,
          totalBytes: 100,
          phase: 'failed',
          failure: {
            message: 'Cannot download "https://example.com/private" status 404',
            code: 'ERR_UPDATER_HTTP_ERROR',
          },
        }
      }
      return undefined
    })

    await checkForWeworkUpdate('stable')
    await expect(downloadPendingWeworkUpdate()).rejects.toThrow(
      'Cannot download "https://example.com/private" status 404'
    )
  })

  test('a failed same-channel recheck preserves the offer for a freshly resolved download', async () => {
    const oldUpdate = { currentVersion: '0.2.6', version: '0.2.7', readyToInstall: false }
    const refreshed = { ...oldUpdate, version: '0.2.8', readyToInstall: true }
    desktopHostMocks.invoke.mockResolvedValueOnce(oldUpdate)
    await checkForWeworkUpdate('stable')
    desktopHostMocks.invoke.mockRejectedValueOnce(new Error('Catalog offline'))
    await expect(checkForWeworkUpdate('stable')).rejects.toThrow('Catalog offline')
    desktopHostMocks.invoke.mockImplementation(async capability => {
      if (capability === 'appUpdate.downloadProgress') {
        return { downloadedBytes: 100, totalBytes: 100, phase: 'ready', update: refreshed }
      }
    })

    await expect(downloadPendingWeworkUpdate()).resolves.toEqual(refreshed)
    await installDownloadedWeworkUpdate()
    expect(desktopHostMocks.invoke).toHaveBeenCalledWith('appUpdate.download', {
      channel: 'stable',
    })
    expect(desktopHostMocks.invoke).toHaveBeenCalledWith('appUpdate.install', { version: '0.2.8' })
  })

  test('a failed recheck keeps a prepared update available for host install revalidation', async () => {
    const update = { currentVersion: '0.2.6', version: '0.2.7', readyToInstall: true }
    desktopHostMocks.invoke.mockImplementation(async capability => {
      if (capability === 'appUpdate.check') return update
      if (capability === 'appUpdate.downloadProgress') {
        return { downloadedBytes: 100, totalBytes: 100, phase: 'ready', update }
      }
    })
    await checkForWeworkUpdate('stable')
    await downloadPendingWeworkUpdate()
    desktopHostMocks.invoke.mockRejectedValueOnce(new Error('Catalog offline'))
    await expect(checkForWeworkUpdate('stable')).rejects.toThrow('Catalog offline')

    await installDownloadedWeworkUpdate()
    expect(desktopHostMocks.invoke).toHaveBeenCalledWith('appUpdate.install', {
      version: update.version,
    })
  })

  test('installation and recheck failures still allow a fresh download retry', async () => {
    const update = { currentVersion: '0.2.6', version: '0.2.7', readyToInstall: true }
    desktopHostMocks.invoke.mockImplementation(async capability => {
      if (capability === 'appUpdate.check') return update
      if (capability === 'appUpdate.downloadProgress') {
        return { downloadedBytes: 100, totalBytes: 100, phase: 'ready', update }
      }
    })
    await checkForWeworkUpdate('stable')
    await downloadPendingWeworkUpdate()
    desktopHostMocks.invoke.mockRejectedValueOnce(new Error('Installation revalidation offline'))
    await expect(installDownloadedWeworkUpdate()).rejects.toThrow(
      'Installation revalidation offline'
    )
    desktopHostMocks.invoke.mockRejectedValueOnce(new Error('Catalog offline'))
    await expect(checkForWeworkUpdate('stable')).rejects.toThrow('Catalog offline')

    await expect(downloadPendingWeworkUpdate()).resolves.toEqual(update)
    expect(
      desktopHostMocks.invoke.mock.calls.filter(([name]) => name === 'appUpdate.download')
    ).toHaveLength(2)
  })

  test.each(['withdrawn', 'channel-change'] as const)(
    'clears the prior offer after %s',
    async reason => {
      desktopHostMocks.invoke.mockResolvedValueOnce({
        currentVersion: '0.2.6',
        version: '0.2.7',
        readyToInstall: false,
      })
      await checkForWeworkUpdate('stable')
      if (reason === 'withdrawn') {
        desktopHostMocks.invoke.mockResolvedValueOnce(null)
        await checkForWeworkUpdate('stable')
      } else {
        desktopHostMocks.invoke.mockRejectedValueOnce(new Error('Beta catalog offline'))
        await expect(checkForWeworkUpdate('beta')).rejects.toThrow('Beta catalog offline')
      }
      desktopHostMocks.invoke.mockClear()

      await expect(downloadPendingWeworkUpdate()).rejects.toThrow('No pending Wework update')
      expect(desktopHostMocks.invoke).not.toHaveBeenCalled()
    }
  )

  test('stops polling and clears a withdrawn target', async () => {
    desktopHostMocks.invoke.mockImplementation(async capability => {
      if (capability === 'appUpdate.check')
        return { currentVersion: '0.2.6', readyToInstall: false, version: '0.2.7' }
      if (capability === 'appUpdate.downloadProgress') {
        return { downloadedBytes: 0, totalBytes: null, phase: 'upToDate', update: null }
      }
    })
    await checkForWeworkUpdate('stable')

    await expect(downloadPendingWeworkUpdate()).resolves.toBeNull()
    await expect(installDownloadedWeworkUpdate()).rejects.toThrow('No pending Wework update')
    expect(
      desktopHostMocks.invoke.mock.calls.filter(([name]) => name === 'appUpdate.downloadProgress')
    ).toHaveLength(1)
  })
})
