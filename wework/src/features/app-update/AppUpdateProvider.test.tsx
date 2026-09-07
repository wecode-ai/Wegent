import { act, fireEvent, render, screen } from '@testing-library/react'
import { useAppUpdate, type AppUpdateContextValue } from './app-update-context'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  APP_UPDATE_AUTO_CHECK_MIN_AGE_MS,
  APP_UPDATE_AUTO_DOWNLOAD_KEY,
  APP_UPDATE_CHANNEL_KEY,
  APP_UPDATE_INITIAL_CHECK_DELAY_MS,
  APP_UPDATE_LAST_AUTO_CHECK_KEY,
  APP_UPDATE_SIMULATE_EVENT,
  APP_UPDATE_TIMER_INTERVAL_MS,
} from './app-update-context'
import { AppUpdateProvider } from './AppUpdateProvider'
import {
  checkForWeworkUpdate,
  downloadPendingWeworkUpdate,
  installDownloadedWeworkUpdate,
} from '@/lib/app-updater'
import { APP_UPDATE_PENDING_RELEASE_NOTES_KEY } from './app-release-notes'

const appVersionMock = vi.hoisted(() => ({ value: '0.1.0' }))

vi.mock('@/lib/app-updater', () => ({
  checkForWeworkUpdate: vi.fn(),
  downloadPendingWeworkUpdate: vi.fn(),
  installDownloadedWeworkUpdate: vi.fn(),
}))

vi.mock('@/hooks/useAppVersion', () => ({
  useAppVersion: () => appVersionMock.value,
}))

function enableElectron() {
  window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
}

function disableElectron() {
  delete window.__WEWORK_RUNTIME_CONFIG__
}

describe('AppUpdateProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-16T00:00:00Z'))
    localStorage.clear()
    enableElectron()
    appVersionMock.value = '0.1.0'
    vi.mocked(checkForWeworkUpdate).mockResolvedValue(null)
    vi.mocked(downloadPendingWeworkUpdate).mockResolvedValue()
    vi.mocked(installDownloadedWeworkUpdate).mockResolvedValue()
  })

  afterEach(() => {
    disableElectron()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  test('runs a startup auto check after the initial delay', async () => {
    render(
      <AppUpdateProvider>
        <div />
      </AppUpdateProvider>
    )

    await vi.advanceTimersByTimeAsync(APP_UPDATE_INITIAL_CHECK_DELAY_MS)

    expect(checkForWeworkUpdate).toHaveBeenCalledTimes(1)
    expect(checkForWeworkUpdate).toHaveBeenCalledWith('stable')
    expect(localStorage.getItem(APP_UPDATE_LAST_AUTO_CHECK_KEY)).toBe(String(Date.now()))
  })

  test('persists the Beta channel and checks it immediately', async () => {
    let appUpdate: AppUpdateContextValue | null = null

    const Probe = () => {
      appUpdate = useAppUpdate()
      return null
    }

    render(
      <AppUpdateProvider>
        <Probe />
      </AppUpdateProvider>
    )

    await act(async () => {
      await appUpdate?.setUpdateChannel('beta')
    })

    expect(localStorage.getItem(APP_UPDATE_CHANNEL_KEY)).toBe('beta')
    expect(appUpdate?.updateChannel).toBe('beta')
    expect(checkForWeworkUpdate).toHaveBeenCalledWith('beta')
  })

  test('downloads a discovered update silently by default', async () => {
    let appUpdate: AppUpdateContextValue | null = null
    vi.mocked(checkForWeworkUpdate).mockResolvedValue({
      currentVersion: '0.1.0',
      version: '0.2.0',
    })

    const Probe = () => {
      appUpdate = useAppUpdate()
      return null
    }

    render(
      <AppUpdateProvider>
        <Probe />
      </AppUpdateProvider>
    )

    await act(async () => {
      await appUpdate?.checkNow()
    })

    expect(appUpdate?.autoUpdateEnabled).toBe(true)
    expect(downloadPendingWeworkUpdate).toHaveBeenCalledWith(expect.any(Function))
    expect(appUpdate?.downloadProgress).toBeNull()
    expect(appUpdate?.status).toBe('available')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await act(async () => {
      await appUpdate?.installUpdate()
    })

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(downloadPendingWeworkUpdate).toHaveBeenCalledTimes(1)
    expect(installDownloadedWeworkUpdate).not.toHaveBeenCalled()
  })

  test('waits for an active background download before asking for restart confirmation', async () => {
    let appUpdate: AppUpdateContextValue | null = null
    let finishDownload: (() => void) | undefined
    let reportProgress:
      | ((progress: { downloadedBytes: number; totalBytes: number | null }) => void)
      | undefined
    let updateRequest: Promise<void> | undefined
    vi.mocked(checkForWeworkUpdate).mockResolvedValue({
      currentVersion: '0.1.0',
      version: '0.2.0',
    })
    vi.mocked(downloadPendingWeworkUpdate).mockImplementation(
      onProgress =>
        new Promise(resolve => {
          finishDownload = resolve
          reportProgress = onProgress
        })
    )

    const Probe = () => {
      appUpdate = useAppUpdate()
      return null
    }

    render(
      <AppUpdateProvider>
        <Probe />
      </AppUpdateProvider>
    )

    await act(async () => {
      await appUpdate?.checkNow()
    })
    await act(async () => {
      updateRequest = appUpdate?.installUpdate()
      await Promise.resolve()
    })

    expect(appUpdate?.status).toBe('downloading')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(downloadPendingWeworkUpdate).toHaveBeenCalledTimes(1)

    act(() => {
      reportProgress?.({ downloadedBytes: 50, totalBytes: 100 })
    })
    expect(appUpdate?.downloadProgress).toEqual({ downloadedBytes: 50, totalBytes: 100 })

    if (!finishDownload) {
      throw new Error('Background download resolver was not initialized')
    }
    finishDownload()
    await act(async () => {
      await updateRequest
    })

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(downloadPendingWeworkUpdate).toHaveBeenCalledTimes(1)
    expect(installDownloadedWeworkUpdate).not.toHaveBeenCalled()
  })

  test('does not download automatically when automatic updates are disabled', async () => {
    let appUpdate: AppUpdateContextValue | null = null
    localStorage.setItem(APP_UPDATE_AUTO_DOWNLOAD_KEY, 'false')
    vi.mocked(checkForWeworkUpdate).mockResolvedValue({
      currentVersion: '0.1.0',
      version: '0.2.0',
    })

    const Probe = () => {
      appUpdate = useAppUpdate()
      return null
    }

    render(
      <AppUpdateProvider>
        <Probe />
      </AppUpdateProvider>
    )

    await act(async () => {
      await appUpdate?.checkNow()
    })

    expect(appUpdate?.autoUpdateEnabled).toBe(false)
    expect(downloadPendingWeworkUpdate).not.toHaveBeenCalled()
  })

  test('starts a silent download when automatic updates are enabled for an available update', async () => {
    let appUpdate: AppUpdateContextValue | null = null
    localStorage.setItem(APP_UPDATE_AUTO_DOWNLOAD_KEY, 'false')
    vi.mocked(checkForWeworkUpdate).mockResolvedValue({
      currentVersion: '0.1.0',
      version: '0.2.0',
    })

    const Probe = () => {
      appUpdate = useAppUpdate()
      return null
    }

    render(
      <AppUpdateProvider>
        <Probe />
      </AppUpdateProvider>
    )

    await act(async () => {
      await appUpdate?.checkNow()
    })
    await act(async () => {
      appUpdate?.setAutoUpdateEnabled(true)
    })

    expect(localStorage.getItem(APP_UPDATE_AUTO_DOWNLOAD_KEY)).toBe('true')
    expect(downloadPendingWeworkUpdate).toHaveBeenCalledWith(expect.any(Function))
    expect(appUpdate?.downloadProgress).toBeNull()
  })

  test('clears a previous download error when retrying automatically', async () => {
    let appUpdate: AppUpdateContextValue | null = null
    let failInitialDownload: ((error: Error) => void) | undefined
    let finishRetry: (() => void) | undefined
    localStorage.setItem(APP_UPDATE_AUTO_DOWNLOAD_KEY, 'false')
    vi.mocked(checkForWeworkUpdate).mockResolvedValue({
      currentVersion: '0.1.0',
      version: '0.2.0',
    })
    vi.mocked(downloadPendingWeworkUpdate)
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            failInitialDownload = reject
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finishRetry = resolve
          })
      )

    const Probe = () => {
      appUpdate = useAppUpdate()
      return null
    }

    render(
      <AppUpdateProvider>
        <Probe />
      </AppUpdateProvider>
    )

    await act(async () => {
      await appUpdate?.checkNow()
    })
    act(() => {
      appUpdate?.setAutoUpdateEnabled(true)
    })
    if (!failInitialDownload) {
      throw new Error('Initial background download rejecter was not initialized')
    }
    await act(async () => {
      failInitialDownload?.(new Error('download failed'))
      await Promise.resolve()
    })
    expect(appUpdate?.status).toBe('error')
    expect(appUpdate?.error).not.toBeNull()

    act(() => {
      appUpdate?.setAutoUpdateEnabled(false)
      appUpdate?.setAutoUpdateEnabled(true)
    })
    expect(appUpdate?.status).toBe('downloading')
    expect(appUpdate?.error).toBeNull()

    if (!finishRetry) {
      throw new Error('Background download retry resolver was not initialized')
    }
    await act(async () => {
      finishRetry?.()
    })
    expect(appUpdate?.status).toBe('available')
  })

  test('restores the persisted Beta channel for automatic checks', async () => {
    localStorage.setItem(APP_UPDATE_CHANNEL_KEY, 'beta')

    render(
      <AppUpdateProvider>
        <div />
      </AppUpdateProvider>
    )

    await vi.advanceTimersByTimeAsync(APP_UPDATE_INITIAL_CHECK_DELAY_MS)

    expect(checkForWeworkUpdate).toHaveBeenCalledWith('beta')
    expect(localStorage.getItem(`${APP_UPDATE_LAST_AUTO_CHECK_KEY}:beta`)).toBe(String(Date.now()))
  })

  test('finishes a Beta check after an overlapping stable automatic check', async () => {
    let appUpdate: AppUpdateContextValue | null = null
    let finishStableCheck: (() => void) | undefined
    vi.mocked(checkForWeworkUpdate).mockImplementation(channel =>
      channel === 'stable'
        ? new Promise(resolve => {
            finishStableCheck = () => resolve(null)
          })
        : Promise.resolve({
            currentVersion: '0.1.0',
            version: '0.2.0-beta.1',
          })
    )

    const Probe = () => {
      appUpdate = useAppUpdate()
      return null
    }

    render(
      <AppUpdateProvider>
        <Probe />
      </AppUpdateProvider>
    )

    await vi.advanceTimersByTimeAsync(APP_UPDATE_INITIAL_CHECK_DELAY_MS)
    const channelChange = appUpdate?.setUpdateChannel('beta')
    finishStableCheck?.()
    await act(async () => {
      await channelChange
    })

    expect(checkForWeworkUpdate).toHaveBeenNthCalledWith(1, 'stable')
    expect(checkForWeworkUpdate).toHaveBeenNthCalledWith(2, 'beta')
    expect(appUpdate?.updateChannel).toBe('beta')
    expect(appUpdate?.availableUpdate?.version).toBe('0.2.0-beta.1')
  })

  test('shows manual feedback when reusing an in-flight automatic check', async () => {
    let appUpdate: AppUpdateContextValue | null = null
    let finishCheck: (() => void) | undefined
    vi.mocked(checkForWeworkUpdate).mockImplementation(
      () =>
        new Promise(resolve => {
          finishCheck = () => resolve(null)
        })
    )

    const Probe = () => {
      appUpdate = useAppUpdate()
      return null
    }

    render(
      <AppUpdateProvider>
        <Probe />
      </AppUpdateProvider>
    )

    await vi.advanceTimersByTimeAsync(APP_UPDATE_INITIAL_CHECK_DELAY_MS)
    let manualCheck: Promise<unknown> | undefined
    await act(async () => {
      manualCheck = appUpdate?.checkNow()
      await Promise.resolve()
    })

    expect(appUpdate?.status).toBe('checking')
    expect(checkForWeworkUpdate).toHaveBeenCalledTimes(1)

    if (!finishCheck) {
      throw new Error('Automatic update check resolver was not initialized')
    }
    finishCheck()
    await act(async () => {
      await manualCheck
    })

    expect(appUpdate?.status).toBe('upToDate')
  })

  test('normalizes an HTML network failure before publishing update state', async () => {
    let appUpdate: AppUpdateContextValue | null = null
    vi.mocked(checkForWeworkUpdate).mockRejectedValue(
      new Error(
        '<!doctype html><style>body{color:red}</style><body>SGErrorDomain EOF https://internal.example/update</body>'
      )
    )

    const Probe = () => {
      appUpdate = useAppUpdate()
      return null
    }

    render(
      <AppUpdateProvider>
        <Probe />
      </AppUpdateProvider>
    )

    await act(async () => {
      await appUpdate?.checkNow()
    })

    expect(appUpdate?.status).toBe('error')
    expect(appUpdate?.error).toEqual({
      stage: 'check',
      kind: 'network',
      code: 'APP_UPDATE_NETWORK_UNAVAILABLE',
      occurredAt: Date.now(),
      detail: null,
    })
  })

  test('wakes hourly but only checks the update source after 24 hours', async () => {
    localStorage.setItem(APP_UPDATE_LAST_AUTO_CHECK_KEY, String(Date.now()))

    render(
      <AppUpdateProvider>
        <div />
      </AppUpdateProvider>
    )

    await vi.advanceTimersByTimeAsync(APP_UPDATE_INITIAL_CHECK_DELAY_MS)
    await vi.advanceTimersByTimeAsync(APP_UPDATE_TIMER_INTERVAL_MS)
    expect(checkForWeworkUpdate).not.toHaveBeenCalled()

    vi.setSystemTime(new Date(Date.now() + APP_UPDATE_AUTO_CHECK_MIN_AGE_MS))
    await vi.advanceTimersByTimeAsync(APP_UPDATE_TIMER_INTERVAL_MS)

    expect(checkForWeworkUpdate).toHaveBeenCalledTimes(1)
  })

  test('downloads an update before asking for restart confirmation', async () => {
    let appUpdate: AppUpdateContextValue | null = null
    let finishDownload: (() => void) | undefined
    let updateRequest: Promise<void> | undefined
    localStorage.setItem(APP_UPDATE_AUTO_DOWNLOAD_KEY, 'false')
    vi.mocked(checkForWeworkUpdate).mockResolvedValue({
      currentVersion: '0.0.8',
      version: '0.0.9',
    })
    vi.mocked(downloadPendingWeworkUpdate).mockImplementation(onProgress => {
      onProgress?.({ downloadedBytes: 50, totalBytes: 100 })
      return new Promise(resolve => {
        finishDownload = resolve
      })
    })

    function Probe() {
      appUpdate = useAppUpdate()
      return null
    }

    render(
      <AppUpdateProvider>
        <Probe />
      </AppUpdateProvider>
    )

    await act(async () => {
      await appUpdate?.checkNow()
    })
    await act(async () => {
      updateRequest = appUpdate?.installUpdate()
      await Promise.resolve()
    })

    expect(appUpdate?.status).toBe('downloading')
    expect(appUpdate?.downloadProgress).toEqual({ downloadedBytes: 50, totalBytes: 100 })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(installDownloadedWeworkUpdate).not.toHaveBeenCalled()

    if (!finishDownload) {
      throw new Error('Update download resolver was not initialized')
    }
    finishDownload()
    await act(async () => {
      await updateRequest
    })

    expect(screen.getByRole('dialog')).toHaveTextContent('重启并更新 Wework？')
    expect(screen.getByRole('dialog')).toHaveTextContent('v0.0.9')
    expect(appUpdate?.status).toBe('available')
    expect(appUpdate?.downloadProgress).toBeNull()
    expect(installDownloadedWeworkUpdate).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('app-update-restart-confirm-cancel-button'))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(appUpdate?.status).toBe('available')
    expect(installDownloadedWeworkUpdate).not.toHaveBeenCalled()
    expect(localStorage.getItem(APP_UPDATE_PENDING_RELEASE_NOTES_KEY)).toBeNull()

    await act(async () => {
      await appUpdate?.installUpdate()
    })

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(downloadPendingWeworkUpdate).toHaveBeenCalledTimes(1)
  })

  test('installs a downloaded update only after restart confirmation', async () => {
    let appUpdate: AppUpdateContextValue | null = null
    localStorage.setItem(APP_UPDATE_AUTO_DOWNLOAD_KEY, 'false')
    vi.mocked(checkForWeworkUpdate).mockResolvedValue({
      currentVersion: '0.0.8',
      version: '0.0.9',
    })

    function Probe() {
      appUpdate = useAppUpdate()
      return null
    }

    render(
      <AppUpdateProvider>
        <Probe />
      </AppUpdateProvider>
    )

    await act(async () => {
      await appUpdate?.checkNow()
    })
    await act(async () => {
      await appUpdate?.installUpdate()
    })

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(downloadPendingWeworkUpdate).toHaveBeenCalledTimes(1)
    expect(installDownloadedWeworkUpdate).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(screen.getByTestId('app-update-restart-confirm'))
      await Promise.resolve()
    })

    expect(appUpdate?.status).toBe('installing')
    expect(appUpdate?.downloadProgress).toBeNull()
    expect(installDownloadedWeworkUpdate).toHaveBeenCalledTimes(1)
  })

  test('persists release notes before installing an available update', async () => {
    let appUpdate: AppUpdateContextValue | null = null
    localStorage.setItem(APP_UPDATE_AUTO_DOWNLOAD_KEY, 'false')
    vi.mocked(checkForWeworkUpdate).mockResolvedValue({
      currentVersion: '0.1.0',
      version: '0.2.0',
      body: '## Changes\n\n- Added release notes.',
    })
    function Probe() {
      appUpdate = useAppUpdate()
      return null
    }

    render(
      <AppUpdateProvider>
        <Probe />
      </AppUpdateProvider>
    )

    await act(async () => {
      await appUpdate?.checkNow()
    })
    await act(async () => {
      await appUpdate?.installUpdate()
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('app-update-restart-confirm'))
      await Promise.resolve()
    })

    expect(JSON.parse(localStorage.getItem(APP_UPDATE_PENDING_RELEASE_NOTES_KEY) ?? '{}')).toEqual({
      version: '0.2.0',
      body: '## Changes\n\n- Added release notes.',
    })
  })

  test('restores release notes after the installed version starts', async () => {
    let appUpdate: AppUpdateContextValue | null = null
    appVersionMock.value = '0.2.0'
    localStorage.setItem(
      APP_UPDATE_PENDING_RELEASE_NOTES_KEY,
      JSON.stringify({
        version: '0.2.0',
        body: '## Changes\n\n- Added release notes.',
      })
    )

    function Probe() {
      appUpdate = useAppUpdate()
      return null
    }

    render(
      <AppUpdateProvider>
        <Probe />
      </AppUpdateProvider>
    )

    await act(async () => {
      await Promise.resolve()
    })

    expect(appUpdate?.installedReleaseNotes).toEqual({
      version: '0.2.0',
      body: '## Changes\n\n- Added release notes.',
    })

    act(() => {
      appUpdate?.dismissInstalledReleaseNotes()
    })

    expect(appUpdate?.installedReleaseNotes).toBeNull()
    expect(localStorage.getItem(APP_UPDATE_PENDING_RELEASE_NOTES_KEY)).toBeNull()
  })

  test('discards release notes that do not match the running version', async () => {
    appVersionMock.value = '0.1.0'
    localStorage.setItem(
      APP_UPDATE_PENDING_RELEASE_NOTES_KEY,
      JSON.stringify({
        version: '0.2.0',
        body: '## Changes',
      })
    )

    render(
      <AppUpdateProvider>
        <div />
      </AppUpdateProvider>
    )

    await act(async () => {
      await Promise.resolve()
    })

    expect(localStorage.getItem(APP_UPDATE_PENDING_RELEASE_NOTES_KEY)).toBeNull()
  })

  test('refreshes a failed update so installation can be retried without restarting', async () => {
    let appUpdate: AppUpdateContextValue | null = null
    localStorage.setItem(APP_UPDATE_AUTO_DOWNLOAD_KEY, 'false')
    const update = {
      currentVersion: '0.0.18',
      version: '0.0.19',
      body: '## Changes\n\n- Fixed update retries.',
    }
    vi.mocked(checkForWeworkUpdate).mockResolvedValue(update)
    vi.mocked(installDownloadedWeworkUpdate)
      .mockRejectedValueOnce(new Error('The signature verification failed'))
      .mockResolvedValueOnce()

    function Probe() {
      appUpdate = useAppUpdate()
      return null
    }

    render(
      <AppUpdateProvider>
        <Probe />
      </AppUpdateProvider>
    )

    await act(async () => {
      await appUpdate?.checkNow()
    })
    await act(async () => {
      await appUpdate?.installUpdate()
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('app-update-restart-confirm'))
      await Promise.resolve()
    })

    expect(checkForWeworkUpdate).toHaveBeenCalledTimes(2)
    expect(appUpdate?.status).toBe('available')
    expect(appUpdate?.error).toMatchObject({
      stage: 'install',
      kind: 'generic',
      code: 'APP_UPDATE_INSTALL_FAILED',
      detail: 'The signature verification failed',
    })
    expect(localStorage.getItem(APP_UPDATE_PENDING_RELEASE_NOTES_KEY)).toBeNull()

    await act(async () => {
      await appUpdate?.installUpdate()
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('app-update-restart-confirm'))
      await Promise.resolve()
    })

    expect(downloadPendingWeworkUpdate).toHaveBeenCalledTimes(2)
    expect(installDownloadedWeworkUpdate).toHaveBeenCalledTimes(2)
  })

  test('routes simulated updates through download before restart confirmation', async () => {
    let appUpdate: AppUpdateContextValue | null = null

    function Probe() {
      appUpdate = useAppUpdate()
      return null
    }

    render(
      <AppUpdateProvider>
        <Probe />
      </AppUpdateProvider>
    )

    await act(async () => {
      window.dispatchEvent(new Event(APP_UPDATE_SIMULATE_EVENT))
    })

    expect(appUpdate?.status).toBe('available')
    expect(appUpdate?.availableUpdate?.version).toBe('debug-simulation')
    expect(appUpdate?.downloadProgress).toBeNull()

    await act(async () => {
      await appUpdate?.installUpdate()
    })

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(appUpdate?.status).toBe('downloading')
    expect(appUpdate?.downloadProgress).toEqual({ downloadedBytes: 0, totalBytes: 10_000_000 })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_750)
    })

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(appUpdate?.downloadProgress).toEqual({
      downloadedBytes: 9_500_000,
      totalBytes: 10_000_000,
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })

    expect(screen.getByRole('dialog')).toHaveTextContent('重启并更新 Wework？')
    expect(appUpdate?.status).toBe('available')
    expect(appUpdate?.downloadProgress).toBeNull()

    fireEvent.click(screen.getByTestId('app-update-restart-confirm-cancel-button'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await act(async () => {
      await appUpdate?.installUpdate()
    })
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('app-update-restart-confirm'))

    expect(appUpdate?.availableUpdate).toBeNull()
    expect(appUpdate?.status).toBe('upToDate')
    expect(appUpdate?.installedReleaseNotes?.body).toContain('changelog announcement')
  })
})
