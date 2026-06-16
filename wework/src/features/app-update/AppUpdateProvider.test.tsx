import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  APP_UPDATE_AUTO_CHECK_MIN_AGE_MS,
  APP_UPDATE_INITIAL_CHECK_DELAY_MS,
  APP_UPDATE_LAST_AUTO_CHECK_KEY,
  APP_UPDATE_TIMER_INTERVAL_MS,
} from './app-update-context'
import { AppUpdateProvider } from './AppUpdateProvider'
import { checkForWeworkUpdate } from '@/lib/app-updater'

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
})
