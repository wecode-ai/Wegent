import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import en from '@/i18n/locales/en/common.json'
import zh from '@/i18n/locales/zh-CN/common.json'
import {
  checkForWeworkUpdate,
  downloadPendingWeworkUpdate,
  installDownloadedWeworkUpdate,
  type WeworkUpdateInfo,
} from '@/lib/app-updater'
import { WeworkUpdateRetryConfirmationError } from '@/lib/app-updater-errors'
import { AppUpdateProvider } from './AppUpdateProvider'
import {
  APP_UPDATE_AUTO_DOWNLOAD_KEY,
  APP_UPDATE_INITIAL_CHECK_DELAY_MS,
  useAppUpdate,
  type AppUpdateContextValue,
} from './app-update-context'

vi.mock('@/lib/app-updater', () => ({
  checkForWeworkUpdate: vi.fn(),
  downloadPendingWeworkUpdate: vi.fn(),
  installDownloadedWeworkUpdate: vi.fn(),
}))
vi.mock('@/hooks/useAppVersion', () => ({ useAppVersion: () => '1.0.0' }))

const retryUpdate: WeworkUpdateInfo = {
  currentVersion: '1.0.0',
  version: '1.1.0',
  readyToInstall: false,
  retryConfirmation: { token: 'failed-attempt-1', version: '1.1.0', reason: 'startup-failed' },
}
const readyUpdate = { ...retryUpdate, readyToInstall: true, retryConfirmation: undefined }
const translations = createInstance()

function renderUpdater() {
  let context!: AppUpdateContextValue
  function Probe() {
    context = useAppUpdate()
    return null
  }
  render(
    <I18nextProvider i18n={translations}>
      <AppUpdateProvider>
        <Probe />
      </AppUpdateProvider>
    </I18nextProvider>
  )
  return () => context
}

beforeEach(async () => {
  await translations.init({
    lng: 'zh-CN',
    resources: { 'zh-CN': { common: zh }, en: { common: en } },
    interpolation: { escapeValue: false },
  })
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-06T03:00:00Z'))
  localStorage.clear()
  window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
  vi.mocked(checkForWeworkUpdate).mockResolvedValue(retryUpdate)
  vi.mocked(downloadPendingWeworkUpdate).mockResolvedValue(readyUpdate)
  vi.mocked(installDownloadedWeworkUpdate).mockResolvedValue()
})

afterEach(() => {
  delete window.__WEWORK_RUNTIME_CONFIG__
  vi.useRealTimers()
  vi.resetAllMocks()
})

test('asks before automatically downloading a previously failed update', async () => {
  const updater = renderUpdater()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(APP_UPDATE_INITIAL_CHECK_DELAY_MS)
  })

  expect(screen.getByTestId('app-update-retry-dialog')).toHaveTextContent(
    '上次更新到 v1.1.0 后启动失败'
  )
  expect(updater().status).toBe('available')
  expect(downloadPendingWeworkUpdate).not.toHaveBeenCalled()
  expect(installDownloadedWeworkUpdate).not.toHaveBeenCalled()
})

test.each(['cancel', 'escape'])(
  'dismisses with %s without retrying and reopens through the existing update action',
  async action => {
    const updater = renderUpdater()
    await act(async () => {
      await updater().checkNow()
    })
    if (action === 'cancel') fireEvent.click(screen.getByTestId('app-update-retry-cancel'))
    else fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(downloadPendingWeworkUpdate).not.toHaveBeenCalled()
    expect(updater().availableUpdate).toEqual(retryUpdate)
    await act(async () => {
      await updater().installUpdate()
    })
    expect(screen.getByTestId('app-update-retry-dialog')).toBeInTheDocument()
    expect(downloadPendingWeworkUpdate).not.toHaveBeenCalled()
  }
)

test('passes only the confirmed attempt token and preserves the separate restart confirmation', async () => {
  const updater = renderUpdater()
  await act(async () => {
    await updater().checkNow()
  })
  await act(async () => {
    fireEvent.click(screen.getByTestId('app-update-retry-confirm'))
  })

  expect(downloadPendingWeworkUpdate).toHaveBeenCalledExactlyOnceWith(
    expect.any(Function),
    'failed-attempt-1'
  )
  expect(screen.queryByTestId('app-update-retry-dialog')).not.toBeInTheDocument()
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  expect(screen.getByTestId('app-update-restart-confirm')).toBeInTheDocument()
  expect(installDownloadedWeworkUpdate).not.toHaveBeenCalled()
  await act(async () => {
    fireEvent.click(screen.getByTestId('app-update-restart-confirm'))
  })
  expect(installDownloadedWeworkUpdate).toHaveBeenCalledOnce()
})

test('requires a fresh confirmation if download refresh finds a different failed attempt', async () => {
  const refreshed: WeworkUpdateInfo = {
    ...retryUpdate,
    version: '1.2.0',
    retryConfirmation: { token: 'failed-attempt-2', version: '1.2.0', reason: 'startup-failed' },
  }
  vi.mocked(downloadPendingWeworkUpdate).mockRejectedValueOnce(
    new WeworkUpdateRetryConfirmationError(refreshed)
  )
  const updater = renderUpdater()
  await act(async () => {
    await updater().checkNow()
  })
  await act(async () => {
    fireEvent.click(screen.getByTestId('app-update-retry-confirm'))
  })

  expect(screen.getByTestId('app-update-retry-dialog')).toHaveTextContent('v1.2.0')
  expect(updater().availableUpdate).toEqual(refreshed)
  expect(updater().error).toBeNull()
  expect(downloadPendingWeworkUpdate).toHaveBeenCalledTimes(1)
  expect(screen.queryByTestId('app-update-restart-confirm')).not.toBeInTheDocument()
  await act(async () => {
    fireEvent.click(screen.getByTestId('app-update-retry-confirm'))
  })
  expect(downloadPendingWeworkUpdate).toHaveBeenLastCalledWith(
    expect.any(Function),
    'failed-attempt-2'
  )
})

test('shows a retry offer found during an automatic download without treating it as ready', async () => {
  vi.mocked(checkForWeworkUpdate).mockResolvedValue({
    ...retryUpdate,
    retryConfirmation: undefined,
  })
  vi.mocked(downloadPendingWeworkUpdate).mockRejectedValueOnce(
    new WeworkUpdateRetryConfirmationError(retryUpdate)
  )
  const updater = renderUpdater()
  await act(async () => {
    await updater().checkNow()
  })

  expect(updater().status).toBe('available')
  expect(screen.getByTestId('app-update-retry-dialog')).toBeInTheDocument()
  expect(screen.queryByTestId('app-update-restart-confirm')).not.toBeInTheDocument()
  expect(downloadPendingWeworkUpdate).toHaveBeenCalledExactlyOnceWith(expect.any(Function))
})

test('replaces a stale confirmation with the new ordinary offer without automatically downloading it', async () => {
  const replacement: WeworkUpdateInfo = {
    currentVersion: '1.0.0',
    version: '1.2.0',
    readyToInstall: false,
  }
  vi.mocked(downloadPendingWeworkUpdate).mockRejectedValueOnce(
    new WeworkUpdateRetryConfirmationError(replacement)
  )
  const updater = renderUpdater()
  await act(async () => {
    await updater().checkNow()
  })
  await act(async () => {
    fireEvent.click(screen.getByTestId('app-update-retry-confirm'))
  })

  expect(updater().availableUpdate).toEqual(replacement)
  expect(updater().status).toBe('available')
  expect(updater().error).toBeNull()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(downloadPendingWeworkUpdate).toHaveBeenCalledTimes(1)
  await act(async () => {
    await updater().installUpdate()
  })
  expect(downloadPendingWeworkUpdate).toHaveBeenLastCalledWith(expect.any(Function))
})

test('invalidates the open confirmation when the selected channel no longer offers an update', async () => {
  const updater = renderUpdater()
  await act(async () => {
    await updater().checkNow()
  })
  vi.mocked(checkForWeworkUpdate).mockResolvedValue(null)
  await act(async () => {
    await updater().setUpdateChannel('beta')
  })

  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(updater().availableUpdate).toBeNull()
  expect(downloadPendingWeworkUpdate).not.toHaveBeenCalled()
})

test.each([
  ['rolled-back', '你曾从 v1.1.0 回退到原版本'],
  ['legacy-rollback', '旧版本未记录具体原因'],
] as const)(
  'describes %s without claiming a confirmed startup failure',
  async (reason, description) => {
    vi.mocked(checkForWeworkUpdate).mockResolvedValue({
      ...retryUpdate,
      retryConfirmation: { ...retryUpdate.retryConfirmation!, reason },
    })
    const updater = renderUpdater()
    await act(async () => {
      await updater().checkNow()
    })

    expect(screen.getByRole('dialog')).toHaveTextContent(description)
    expect(screen.getByRole('dialog')).not.toHaveTextContent('启动失败')
  }
)

test('enabling automatic downloads still asks before retrying a failed version', async () => {
  localStorage.setItem(APP_UPDATE_AUTO_DOWNLOAD_KEY, 'false')
  const updater = renderUpdater()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(APP_UPDATE_INITIAL_CHECK_DELAY_MS)
  })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  await act(async () => {
    updater().setAutoUpdateEnabled(true)
  })

  expect(screen.getByTestId('app-update-retry-dialog')).toBeInTheDocument()
  expect(downloadPendingWeworkUpdate).not.toHaveBeenCalled()
})

test('localizes the retry confirmation and failed version in English', async () => {
  await translations.changeLanguage('en')
  const updater = renderUpdater()
  await act(async () => {
    await updater().checkNow()
  })

  expect(screen.getByTestId('app-update-retry-dialog')).toHaveTextContent(
    'failed to start after updating to v1.1.0'
  )
  expect(screen.getByTestId('app-update-retry-confirm')).toHaveTextContent('Try update again')
})
