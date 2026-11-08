import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  checkForWeworkUpdate,
  downloadPendingWeworkUpdate,
  installDownloadedWeworkUpdate,
} from './app-updater'
import { WeworkUpdateRetryConfirmationError } from './app-updater-errors'
import { createAppUpdateError } from '@/features/app-update/app-update-error'

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

  test('retains a refreshed retry offer and sends authorization only for the confirmed attempt', async () => {
    const checked = { currentVersion: '1.0.0', version: '1.1.0', readyToInstall: false }
    const refreshed = {
      ...checked,
      version: '1.2.0',
      retryConfirmation: { token: 'attempt-2', version: '1.2.0', reason: 'startup-failed' },
    }
    desktopHostMocks.invoke.mockImplementation(async capability => {
      if (capability === 'appUpdate.check') return checked
      if (capability === 'appUpdate.downloadProgress')
        return {
          phase: 'failed',
          failure: {
            message: 'Confirmation required',
            code: 'UPDATE_RETRY_CONFIRMATION_REQUIRED',
            stage: 'check',
          },
          update: refreshed,
        }
    })
    await checkForWeworkUpdate('beta')
    await expect(downloadPendingWeworkUpdate()).rejects.toMatchObject({
      name: 'WeworkUpdateRetryConfirmationError',
      update: refreshed,
    })
    expect(desktopHostMocks.invoke).toHaveBeenCalledWith('appUpdate.download', { channel: 'beta' })
    desktopHostMocks.invoke.mockImplementation(async capability => {
      if (capability === 'appUpdate.downloadProgress')
        return {
          phase: 'ready',
          update: { ...refreshed, readyToInstall: true, retryConfirmation: undefined },
        }
    })

    await downloadPendingWeworkUpdate(undefined, 'attempt-2')
    await installDownloadedWeworkUpdate()
    expect(desktopHostMocks.invoke).toHaveBeenCalledWith('appUpdate.download', {
      channel: 'beta',
      retryToken: 'attempt-2',
    })
    expect(desktopHostMocks.invoke).toHaveBeenCalledWith('appUpdate.install', { version: '1.2.0' })
  })

  test.each(['extract', 'verify', 'prepare'] as const)(
    'preserves the host %s failure stage through polling and error wrapping',
    async stage => {
      desktopHostMocks.invoke.mockImplementation(async capability => {
        if (capability === 'appUpdate.check')
          return { currentVersion: '1.0.0', version: '1.1.0', readyToInstall: false }
        if (capability === 'appUpdate.downloadProgress')
          return {
            phase: 'failed',
            failure: {
              message: 'Update could not finish',
              stage,
              code: 'UPDATE_PREPARATION_FAILED',
              retryable: false,
            },
          }
      })
      await checkForWeworkUpdate('stable')
      const error = await downloadPendingWeworkUpdate().catch(error => error)
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(WeworkUpdateRetryConfirmationError)
      expect(createAppUpdateError(error, 'download')).toMatchObject({
        stage,
        code: 'UPDATE_PREPARATION_FAILED',
        retryable: false,
      })
    }
  )

  test('returns the current ordinary offer when an earlier retry token is stale', async () => {
    const replacement = { currentVersion: '1.0.0', version: '1.2.0', readyToInstall: false }
    desktopHostMocks.invoke.mockImplementation(async capability => {
      if (capability === 'appUpdate.check') return { ...replacement, version: '1.1.0' }
      if (capability === 'appUpdate.downloadProgress')
        return {
          phase: 'failed',
          update: replacement,
          failure: {
            message: 'Confirmation changed',
            code: 'UPDATE_RETRY_CONFIRMATION_REQUIRED',
            stage: 'check',
          },
        }
    })
    await checkForWeworkUpdate('stable')

    await expect(downloadPendingWeworkUpdate(undefined, 'stale-attempt')).rejects.toMatchObject({
      name: 'WeworkUpdateRetryConfirmationError',
      update: replacement,
    })
    expect(
      desktopHostMocks.invoke.mock.calls.filter(([name]) => name === 'appUpdate.download')
    ).toHaveLength(1)
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
