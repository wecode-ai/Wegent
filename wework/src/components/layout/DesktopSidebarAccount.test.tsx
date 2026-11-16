import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import {
  AppUpdateContext,
  type AppUpdateContextValue,
} from '@/features/app-update/app-update-context'
import {
  CloudConnectionContext,
  DISCONNECTED_STATE,
} from '@/features/cloud-connection/CloudConnectionContext'
import '@/i18n'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { DesktopSidebarAccount } from './DesktopSidebarAccount'

vi.mock('@/api/dsh/desktopHost', () => ({ invokeDesktopHost: vi.fn() }))

function renderAccount(availableUpdate: AppUpdateContextValue['availableUpdate'] = null) {
  const checkNow = vi.fn().mockResolvedValue(null)
  const installUpdate = vi.fn().mockResolvedValue(undefined)
  const update: AppUpdateContextValue = {
    updateChannel: 'stable',
    autoUpdateEnabled: false,
    availableUpdate,
    installedReleaseNotes: null,
    status: 'error',
    downloadProgress: null,
    error: {
      stage: availableUpdate ? 'download' : 'check',
      kind: 'generic',
      code: availableUpdate ? 'APP_UPDATE_DOWNLOAD_FAILED' : 'APP_UPDATE_CHECK_FAILED',
      occurredAt: Date.parse('2026-11-06T03:37:24Z'),
      detail: 'Release download failed: HTTP 503',
    },
    checkNow,
    installUpdate,
    dismissInstalledReleaseNotes: vi.fn(),
    setAutoUpdateEnabled: vi.fn(),
    setUpdateChannel: vi.fn().mockResolvedValue(undefined),
  }
  render(
    <CloudConnectionContext.Provider
      value={{
        ...DISCONNECTED_STATE,
        isConnected: false,
        serviceKey: 'disconnected-test',
        connectWithAuthorization: vi.fn(),
        refreshUser: vi.fn(),
        disconnect: vi.fn(),
      }}
    >
      <AppUpdateContext.Provider value={update}>
        <DesktopSidebarAccount user={null} onOpenSettings={vi.fn()} onLogout={vi.fn()} />
      </AppUpdateContext.Provider>
    </CloudConnectionContext.Provider>
  )
  return { checkNow, installUpdate }
}

async function openErrorDetails(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId('settings-button'))
  await user.click(screen.getByTestId('app-update-error-details-button'))
  expect(screen.getByTestId('app-update-error-dialog')).toBeInTheDocument()
}

describe('DesktopSidebarAccount update diagnostics', () => {
  beforeEach(() => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    vi.mocked(invokeDesktopHost).mockReset().mockResolvedValue(undefined)
  })

  test('keeps the portaled dialog mounted through a real pointer click and native clipboard completion', async () => {
    const user = userEvent.setup()
    let finishCopy!: () => void
    vi.mocked(invokeDesktopHost).mockReturnValueOnce(
      new Promise<void>(resolve => {
        finishCopy = resolve
      })
    )
    renderAccount()
    await openErrorDetails(user)

    try {
      await user.click(screen.getByTestId('app-update-error-copy'))

      expect(invokeDesktopHost).toHaveBeenCalledExactlyOnceWith('clipboard.writeText', {
        text: expect.stringContaining('APP_UPDATE_CHECK_FAILED'),
      })
      expect(screen.getByTestId('settings-menu')).toBeInTheDocument()
      expect(screen.getByTestId('app-update-error-copy')).toBeDisabled()
      expect(screen.getByTestId('app-update-error-dialog')).toBeInTheDocument()
    } finally {
      await act(async () => finishCopy())
    }

    await waitFor(() =>
      expect(screen.getByTestId('app-update-error-copy')).toHaveTextContent('已复制')
    )
    expect(screen.getByTestId('app-update-error-dialog')).toBeInTheDocument()
  })

  test.each([false, true])(
    'runs the retry action before closing the dialog (available update: %s)',
    async available => {
      const user = userEvent.setup()
      const { checkNow, installUpdate } = renderAccount(
        available ? { currentVersion: '1.1.1', version: '1.1.2' } : null
      )
      await openErrorDetails(user)

      await user.click(screen.getByTestId('app-update-error-retry'))

      expect(available ? installUpdate : checkNow).toHaveBeenCalledOnce()
      expect(available ? checkNow : installUpdate).not.toHaveBeenCalled()
      expect(screen.queryByTestId('app-update-error-dialog')).not.toBeInTheDocument()
      expect(screen.getByTestId('settings-menu')).toBeInTheDocument()
    }
  )

  test.each(['close', 'escape', 'overlay'])(
    'dismisses only the dialog with %s and still closes the menu on an outside click',
    async action => {
      const user = userEvent.setup()
      renderAccount()
      await openErrorDetails(user)

      if (action === 'close') await user.click(screen.getByTestId('app-update-error-dialog-close'))
      else if (action === 'escape') await user.keyboard('{Escape}')
      else await user.click(screen.getByTestId('app-update-error-dialog-overlay'))

      expect(screen.queryByTestId('app-update-error-dialog')).not.toBeInTheDocument()
      expect(screen.getByTestId('settings-menu')).toBeInTheDocument()
      await user.click(document.body)
      expect(screen.queryByTestId('settings-menu')).not.toBeInTheDocument()
    }
  )
})
