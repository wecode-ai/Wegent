import { act, render } from '@testing-library/react'
import { useAppUpdate, type AppUpdateContextValue } from './app-update-context'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  APP_UPDATE_AUTO_CHECK_MIN_AGE_MS,
  APP_UPDATE_INITIAL_CHECK_DELAY_MS,
  APP_UPDATE_LAST_AUTO_CHECK_KEY,
  APP_UPDATE_SIMULATE_EVENT,
  APP_UPDATE_TIMER_INTERVAL_MS,
} from './app-update-context'
import { AppUpdateProvider } from './AppUpdateProvider'
import { checkForWeworkUpdate, installPendingWeworkUpdate } from '@/lib/app-updater'

vi.mock('@/lib/app-updater', () => ({
  checkForWeworkUpdate: vi.fn(),
  installPendingWeworkUpdate: vi.fn(),
}))

function enableTauri() {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: {},
  })
}

function disableTauri() {
  delete (window as Window & { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__
}

describe('AppUpdateProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-16T00:00:00Z'))
    localStorage.clear()
    enableTauri()
    vi.mocked(checkForWeworkUpdate).mockResolvedValue(null)
  })

  afterEach(() => {
    disableTauri()
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
    expect(localStorage.getItem(APP_UPDATE_LAST_AUTO_CHECK_KEY)).toBe(String(Date.now()))
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

  test('exposes download progress while installing an available update', async () => {
    let appUpdate: AppUpdateContextValue | null = null
    vi.mocked(checkForWeworkUpdate).mockResolvedValue({
      currentVersion: '0.0.8',
      version: '0.0.9',
    })
    vi.mocked(installPendingWeworkUpdate).mockImplementation(async onProgress => {
      onProgress({ downloadedBytes: 50, totalBytes: 100 })
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

    expect(appUpdate?.status).toBe('installing')
    expect(appUpdate?.downloadProgress).toEqual({ downloadedBytes: 50, totalBytes: 100 })
  })

  test('refreshes a failed update so installation can be retried without restarting', async () => {
    let appUpdate: AppUpdateContextValue | null = null
    const update = {
      currentVersion: '0.0.18',
      version: '0.0.19',
    }
    vi.mocked(checkForWeworkUpdate).mockResolvedValue(update)
    vi.mocked(installPendingWeworkUpdate)
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

    expect(checkForWeworkUpdate).toHaveBeenCalledTimes(2)
    expect(appUpdate?.status).toBe('available')
    expect(appUpdate?.error).toBe('The signature verification failed')

    await act(async () => {
      await appUpdate?.installUpdate()
    })

    expect(installPendingWeworkUpdate).toHaveBeenCalledTimes(2)
  })

  test('simulates an update download from the developer command menu', async () => {
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

    expect(appUpdate?.status).toBe('installing')
    expect(appUpdate?.downloadProgress).toEqual({ downloadedBytes: 0, totalBytes: 10_000_000 })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500)
    })

    expect(appUpdate?.availableUpdate).toBeNull()
    expect(appUpdate?.status).toBe('upToDate')
  })
})
