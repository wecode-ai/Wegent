import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  checkForWeworkUpdate,
  downloadPendingWeworkUpdate,
  installDownloadedWeworkUpdate,
} from '@/lib/app-updater'
import { AppUpdateProvider } from './AppUpdateProvider'
import {
  APP_UPDATE_AUTO_CHECK_MIN_AGE_MS,
  APP_UPDATE_AUTO_DOWNLOAD_KEY,
  APP_UPDATE_INITIAL_CHECK_DELAY_MS,
  APP_UPDATE_TIMER_INTERVAL_MS,
  useAppUpdate,
  type AppUpdateContextValue,
} from './app-update-context'
import { APP_UPDATE_PENDING_RELEASE_NOTES_KEY } from './app-release-notes'

vi.mock('@/lib/app-updater', () => ({
  checkForWeworkUpdate: vi.fn(),
  downloadPendingWeworkUpdate: vi.fn(),
  installDownloadedWeworkUpdate: vi.fn(),
}))
vi.mock('@/hooks/useAppVersion', () => ({ useAppVersion: () => '1.0.1-beta.5' }))

const oldUpdate = { currentVersion: '1.0.1-beta.5', readyToInstall: false, version: '1.0.1-beta.6' }
const newUpdate = {
  ...oldUpdate,
  version: '1.1.0-beta.1',
  body: 'New release notes',
  readyToInstall: true,
}

function renderUpdater() {
  let context!: AppUpdateContextValue
  function Probe() {
    context = useAppUpdate()
    return null
  }
  render(
    <AppUpdateProvider>
      <Probe />
    </AppUpdateProvider>
  )
  return () => context
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-02T03:00:00Z'))
  localStorage.clear()
  localStorage.setItem(APP_UPDATE_AUTO_DOWNLOAD_KEY, 'false')
  window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
  vi.mocked(checkForWeworkUpdate).mockResolvedValue(oldUpdate)
  vi.mocked(downloadPendingWeworkUpdate).mockResolvedValue(newUpdate)
  vi.mocked(installDownloadedWeworkUpdate).mockResolvedValue()
})

afterEach(() => {
  delete window.__WEWORK_RUNTIME_CONFIG__
  vi.useRealTimers()
  vi.resetAllMocks()
})

test('retries a failed download using the refreshed version and release notes returned by the host', async () => {
  vi.mocked(downloadPendingWeworkUpdate).mockRejectedValueOnce(new Error('Download interrupted'))
  const updater = renderUpdater()
  await act(async () => {
    await updater().checkNow()
  })
  await act(async () => {
    await updater().installUpdate()
  })
  expect(updater().error?.stage).toBe('download')

  await act(async () => {
    await updater().installUpdate()
  })

  expect(updater().error).toBeNull()
  expect(updater().availableUpdate).toEqual(newUpdate)
  expect(screen.getByRole('dialog')).toHaveTextContent('v1.1.0-beta.1')
  await act(async () => {
    fireEvent.click(screen.getByTestId('app-update-restart-confirm'))
  })
  expect(JSON.parse(localStorage.getItem(APP_UPDATE_PENDING_RELEASE_NOTES_KEY)!)).toEqual({
    version: newUpdate.version,
    body: newUpdate.body,
  })
})

test('clears the old offer when refreshing a delayed download finds no available update', async () => {
  vi.mocked(downloadPendingWeworkUpdate).mockResolvedValue(null)
  const updater = renderUpdater()
  await act(async () => {
    await updater().checkNow()
  })

  await act(async () => {
    await updater().installUpdate()
  })

  expect(updater().availableUpdate).toBeNull()
  expect(updater().status).toBe('upToDate')
  expect(updater().error).toBeNull()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(installDownloadedWeworkUpdate).not.toHaveBeenCalled()
})

test('uses the refreshed version when automatic downloading is enabled for an old offer', async () => {
  const updater = renderUpdater()
  await act(async () => {
    await updater().checkNow()
  })

  await act(async () => {
    updater().setAutoUpdateEnabled(true)
  })

  expect(updater().availableUpdate).toEqual(newUpdate)
  expect(updater().status).toBe('available')
  expect(screen.getByRole('dialog')).toHaveTextContent('v1.1.0-beta.1')
  expect(downloadPendingWeworkUpdate).toHaveBeenCalledTimes(1)
})

test('periodically refreshes an old offer and clears it when the channel withdraws it', async () => {
  const updater = renderUpdater()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(APP_UPDATE_INITIAL_CHECK_DELAY_MS)
  })
  expect(updater().availableUpdate).toEqual(oldUpdate)
  vi.mocked(checkForWeworkUpdate).mockResolvedValue(null)
  vi.setSystemTime(Date.now() + APP_UPDATE_AUTO_CHECK_MIN_AGE_MS)

  await act(async () => {
    await vi.advanceTimersByTimeAsync(APP_UPDATE_TIMER_INTERVAL_MS)
  })

  expect(checkForWeworkUpdate).toHaveBeenCalledTimes(2)
  expect(updater().availableUpdate).toBeNull()
  expect(updater().status).toBe('upToDate')
  expect(downloadPendingWeworkUpdate).not.toHaveBeenCalled()
})

test('preserves a downloaded version across checks and re-enabling automatic downloads', async () => {
  vi.mocked(checkForWeworkUpdate).mockResolvedValue(newUpdate)
  const updater = renderUpdater()
  await act(async () => {
    await updater().checkNow()
  })
  await act(async () => {
    await updater().installUpdate()
  })
  fireEvent.click(screen.getByTestId('app-update-restart-confirm-cancel-button'))

  vi.setSystemTime(Date.now() + APP_UPDATE_AUTO_CHECK_MIN_AGE_MS)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(APP_UPDATE_TIMER_INTERVAL_MS)
  })
  expect(checkForWeworkUpdate).toHaveBeenCalledTimes(1)

  await act(async () => {
    await updater().checkNow()
    updater().setAutoUpdateEnabled(true)
  })
  await act(async () => {
    await updater().installUpdate()
  })

  expect(downloadPendingWeworkUpdate).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('dialog')).toHaveTextContent('v1.1.0-beta.1')
})

test('clears restart readiness when the host invalidates preparation for the same version', async () => {
  vi.mocked(checkForWeworkUpdate).mockResolvedValue(newUpdate)
  const updater = renderUpdater()
  await act(async () => {
    await updater().checkNow()
  })
  await act(async () => {
    await updater().installUpdate()
  })
  fireEvent.click(screen.getByTestId('app-update-restart-confirm-cancel-button'))
  vi.mocked(checkForWeworkUpdate).mockResolvedValue({ ...newUpdate, readyToInstall: false })

  await act(async () => {
    await updater().checkNow()
  })

  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  await act(async () => {
    await updater().installUpdate()
  })
  expect(downloadPendingWeworkUpdate).toHaveBeenCalledTimes(2)
})

test('coalesced checks cannot replace an active download with an available state', async () => {
  localStorage.setItem(APP_UPDATE_AUTO_DOWNLOAD_KEY, 'true')
  let finishCheck!: (update: typeof newUpdate) => void
  let finishDownload!: (update: typeof newUpdate) => void
  vi.mocked(checkForWeworkUpdate).mockImplementation(
    () =>
      new Promise(resolve => {
        finishCheck = resolve
      })
  )
  vi.mocked(downloadPendingWeworkUpdate).mockImplementation(
    () =>
      new Promise(resolve => {
        finishDownload = resolve
      })
  )
  const updater = renderUpdater()
  let first!: Promise<unknown>
  let second!: Promise<unknown>
  act(() => {
    first = updater().checkNow()
    second = updater().checkNow()
  })

  await act(async () => {
    finishCheck(newUpdate)
    await Promise.all([first, second])
  })

  expect(updater().status).toBe('downloading')
  expect(checkForWeworkUpdate).toHaveBeenCalledTimes(1)
  expect(downloadPendingWeworkUpdate).toHaveBeenCalledTimes(1)
  await act(async () => {
    finishDownload(newUpdate)
  })
  expect(updater().status).toBe('available')
})

test('coalesced checks cannot overwrite a newer completed download with the checked version', async () => {
  localStorage.setItem(APP_UPDATE_AUTO_DOWNLOAD_KEY, 'true')
  let finishCheck!: (update: typeof oldUpdate) => void
  vi.mocked(checkForWeworkUpdate).mockImplementation(
    () =>
      new Promise(resolve => {
        finishCheck = resolve
      })
  )
  const updater = renderUpdater()
  let first!: Promise<unknown>
  let second!: Promise<unknown>
  act(() => {
    first = updater().checkNow()
    second = updater().checkNow()
  })

  await act(async () => {
    finishCheck(oldUpdate)
    await Promise.all([first, second])
  })

  expect(updater().availableUpdate).toEqual(newUpdate)
  expect(screen.getByRole('dialog')).toHaveTextContent('v1.1.0-beta.1')
})
