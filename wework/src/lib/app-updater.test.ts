import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  checkForWeworkUpdate,
  downloadPendingWeworkUpdate,
  installDownloadedWeworkUpdate,
} from './app-updater'

const desktopHostMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
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
      version: '0.2.7',
      body: 'Changes',
    }
    desktopHostMocks.invoke.mockImplementation(async capability => {
      if (capability === 'appUpdate.check') return update
      if (capability === 'appUpdate.downloadProgress') {
        return { downloadedBytes: 100, totalBytes: 100, phase: 'ready' }
      }
      return undefined
    })
    const onProgress = vi.fn()

    await checkForWeworkUpdate('stable')
    await downloadPendingWeworkUpdate(onProgress)
    await installDownloadedWeworkUpdate()

    expect(desktopHostMocks.invoke.mock.calls).toEqual(
      expect.arrayContaining([
        ['appUpdate.download'],
        ['appUpdate.downloadProgress'],
        ['appUpdate.install'],
      ])
    )
    expect(onProgress).toHaveBeenLastCalledWith({
      downloadedBytes: 100,
      totalBytes: 100,
      phase: 'ready',
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
        return { currentVersion: '0.2.6', version: '0.2.7' }
      }
      if (capability === 'appUpdate.downloadProgress') {
        polls += 1
        return polls < 3
          ? { downloadedBytes: polls * 40, totalBytes: 100, phase: 'host' }
          : { downloadedBytes: 100, totalBytes: 100, phase: 'ready' }
      }
      return undefined
    })
    const onProgress = vi.fn()

    await checkForWeworkUpdate('stable')
    const download = downloadPendingWeworkUpdate(onProgress)
    await vi.advanceTimersByTimeAsync(1_000)

    await expect(download).resolves.toBeUndefined()
    expect(polls).toBe(3)
    expect(onProgress).toHaveBeenLastCalledWith({
      downloadedBytes: 100,
      totalBytes: 100,
      phase: 'ready',
    })
  })

  test('surfaces the download failure reported by the desktop host', async () => {
    desktopHostMocks.invoke.mockImplementation(async capability => {
      if (capability === 'appUpdate.check') {
        return { currentVersion: '0.2.6', version: '0.2.7' }
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
})
