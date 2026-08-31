import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  checkForWeworkUpdate,
  downloadPendingWeworkUpdate,
  getWeworkUpdateTarget,
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

describe('getWeworkUpdateTarget', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    desktopHostMocks.invoke.mockReset()
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
        return { downloadedBytes: 100, totalBytes: 100 }
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
    })
    expect(
      desktopHostMocks.invoke.mock.calls.filter(
        ([capability]) => capability === 'appUpdate.download'
      )
    ).toHaveLength(1)
  })
})
