import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  checkForWeworkUpdate,
  downloadPendingWeworkUpdate,
  getWeworkUpdateTarget,
  installPendingWeworkUpdate,
} from './app-updater'

const updaterMocks = vi.hoisted(() => ({
  check: vi.fn(),
  relaunch: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: updaterMocks.check,
}))

vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: updaterMocks.relaunch,
}))

vi.mock('./runtime-environment', () => ({
  isTauriRuntime: () => true,
}))

function setUserAgent(userAgent: string) {
  vi.stubGlobal('navigator', { userAgent })
}

describe('getWeworkUpdateTarget', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  test('routes stable macOS updates to the stable Darwin manifest', () => {
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')

    expect(getWeworkUpdateTarget('stable')).toBe('stable-darwin')
  })

  test('routes Beta Windows updates to the Beta Windows manifest', () => {
    setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')

    expect(getWeworkUpdateTarget('beta')).toBe('beta-windows')
  })

  test('rejects Linux because desktop updates are unavailable', () => {
    setUserAgent('Mozilla/5.0 (X11; Linux x86_64)')

    expect(() => getWeworkUpdateTarget('stable')).toThrow()
  })
})

describe('Wework update download lifecycle', () => {
  test('reuses a silent background download and reports progress after a manual install click', async () => {
    let onDownloadEvent: ((event: unknown) => void) | undefined
    let finishDownload: (() => void) | undefined
    const update = {
      currentVersion: '0.1.0',
      version: '0.2.0',
      body: 'Changes',
      download: vi.fn(
        callback =>
          new Promise<void>(resolve => {
            onDownloadEvent = callback
            finishDownload = resolve
          })
      ),
      install: vi.fn().mockResolvedValue(undefined),
    }
    updaterMocks.check.mockResolvedValue(update)

    await checkForWeworkUpdate('stable')
    const backgroundDownload = downloadPendingWeworkUpdate()

    onDownloadEvent?.({ event: 'Started', data: { contentLength: 100 } })
    onDownloadEvent?.({ event: 'Progress', data: { chunkLength: 40 } })

    const progress: Array<{ downloadedBytes: number; totalBytes: number | null }> = []
    const manualInstall = installPendingWeworkUpdate(value => progress.push(value))

    expect(update.download).toHaveBeenCalledTimes(1)
    expect(progress.at(-1)).toEqual({ downloadedBytes: 40, totalBytes: 100 })

    onDownloadEvent?.({ event: 'Progress', data: { chunkLength: 60 } })
    onDownloadEvent?.({ event: 'Finished' })
    finishDownload?.()
    await backgroundDownload
    await manualInstall

    expect(progress.at(-1)).toEqual({ downloadedBytes: 100, totalBytes: 100 })
    expect(update.install).toHaveBeenCalledTimes(1)
    expect(updaterMocks.relaunch).toHaveBeenCalledTimes(1)
  })
})
