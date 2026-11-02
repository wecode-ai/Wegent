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

  test('checks for updates through the Electron desktop capability', async () => {
    const update = {
      currentVersion: '0.2.6',
      readyToInstall: false,
      version: '0.2.7',
      body: 'Changes',
    }
    desktopHostMocks.invoke.mockResolvedValue(update)

    await expect(checkForWeworkUpdate('stable')).resolves.toEqual(update)
    expect(desktopHostMocks.invoke).toHaveBeenCalledWith('appUpdate.check', {
      channel: 'stable',
    })
  })

  test('downloads and then installs a checked update through Electron capabilities', async () => {
    const update = {
      currentVersion: '0.2.6',
      readyToInstall: false,
      version: '0.2.7',
      body: 'Changes',
    }
    desktopHostMocks.invoke.mockImplementation(async capability => {
      if (capability === 'appUpdate.check') return update
      if (capability === 'appUpdate.downloadProgress') {
        return { downloadedBytes: 100, totalBytes: 100, phase: 'ready', update }
      }
      return undefined
    })
    const onProgress = vi.fn()

    await checkForWeworkUpdate('stable')
    await downloadPendingWeworkUpdate(onProgress)
    await installDownloadedWeworkUpdate()

    expect(desktopHostMocks.invoke.mock.calls).toEqual(
      expect.arrayContaining([
        ['appUpdate.download', { channel: 'stable' }],
        ['appUpdate.downloadProgress'],
        ['appUpdate.install', { version: '0.2.7' }],
      ])
    )
    expect(onProgress).toHaveBeenLastCalledWith({
      downloadedBytes: 100,
      totalBytes: 100,
      phase: 'ready',
      update,
    })
    expect(
      desktopHostMocks.invoke.mock.calls.filter(
        ([capability]) => capability === 'appUpdate.download'
      )
    ).toHaveLength(1)
  })

  test('follows the reported progress until the download is ready', async () => {
    vi.useFakeTimers()
    let polls = 0
    desktopHostMocks.invoke.mockImplementation(async capability => {
      if (capability === 'appUpdate.check') {
        return { currentVersion: '0.2.6', readyToInstall: false, version: '0.2.7' }
      }
      if (capability === 'appUpdate.downloadProgress') {
        polls += 1
        return polls < 3
          ? { downloadedBytes: polls * 40, totalBytes: 100, phase: 'host' }
          : {
              downloadedBytes: 100,
              totalBytes: 100,
              phase: 'ready',
              update: { currentVersion: '0.2.6', readyToInstall: false, version: '0.2.7' },
            }
      }
      return undefined
    })
    const onProgress = vi.fn()

    await checkForWeworkUpdate('stable')
    const download = downloadPendingWeworkUpdate(onProgress)
    await vi.advanceTimersByTimeAsync(1_000)

    await expect(download).resolves.toEqual({
      currentVersion: '0.2.6',
      readyToInstall: false,
      version: '0.2.7',
    })
    expect(polls).toBe(3)
    expect(onProgress).toHaveBeenLastCalledWith({
      downloadedBytes: 100,
      totalBytes: 100,
      phase: 'ready',
      update: { currentVersion: '0.2.6', readyToInstall: false, version: '0.2.7' },
    })
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

  test('returns the refreshed download target and installs that exact version', async () => {
    const oldUpdate = {
      currentVersion: '1.0.1-beta.5',
      readyToInstall: false,
      version: '1.0.1-beta.6',
    }
    const newUpdate = { ...oldUpdate, version: '1.1.0-beta.1', body: 'New notes' }
    desktopHostMocks.invoke.mockImplementation(async capability => {
      if (capability === 'appUpdate.check') return oldUpdate
      if (capability === 'appUpdate.downloadProgress') {
        return { downloadedBytes: 100, totalBytes: 100, phase: 'ready', update: newUpdate }
      }
    })
    await checkForWeworkUpdate('beta')

    await expect(downloadPendingWeworkUpdate()).resolves.toEqual(newUpdate)
    await installDownloadedWeworkUpdate()

    expect(desktopHostMocks.invoke).toHaveBeenCalledWith('appUpdate.download', { channel: 'beta' })
    expect(desktopHostMocks.invoke).toHaveBeenCalledWith('appUpdate.install', {
      version: newUpdate.version,
    })
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

  test('preserves the confirmed install version while local storage is being flushed', async () => {
    const flushed = Promise.withResolvers<undefined>()
    desktopHostMocks.flush.mockReturnValueOnce(flushed.promise)
    desktopHostMocks.invoke.mockResolvedValueOnce({
      currentVersion: '0.2.6',
      readyToInstall: false,
      version: '0.2.7',
    })
    await checkForWeworkUpdate('stable')
    const installing = installDownloadedWeworkUpdate()
    desktopHostMocks.invoke.mockResolvedValueOnce({
      currentVersion: '0.2.6',
      readyToInstall: false,
      version: '0.2.8',
    })
    await checkForWeworkUpdate('stable')
    expect(desktopHostMocks.invoke).not.toHaveBeenCalledWith('appUpdate.install', expect.anything())

    flushed.resolve(undefined)
    await installing

    expect(desktopHostMocks.invoke).toHaveBeenCalledWith('appUpdate.install', { version: '0.2.7' })
    expect(desktopHostMocks.flush).toHaveBeenCalledOnce()
  })
})
