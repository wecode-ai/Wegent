import '@/i18n'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  AppUpdateContext,
  type AppUpdateContextValue,
} from '@/features/app-update/app-update-context'
import { AboutSettingsPage } from './AboutSettingsPage'

const appVersionMocks = vi.hoisted(() => ({
  getVersion: vi.fn(),
  isElectronRuntime: vi.fn(() => false),
}))

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: appVersionMocks.getVersion,
}))

vi.mock('@/lib/runtime-environment', () => ({
  isDesktopRuntime: appVersionMocks.isElectronRuntime,
  isElectronRuntime: appVersionMocks.isElectronRuntime,
}))

function renderPage(overrides: Partial<AppUpdateContextValue> = {}) {
  const value: AppUpdateContextValue = {
    currentVersion: '0.1.0',
    isUpdateReady: false,
    updateChannel: 'stable',
    autoUpdateEnabled: true,
    availableUpdate: null,
    installedReleaseNotes: null,
    status: 'idle',
    downloadProgress: null,
    error: null,
    checkNow: vi.fn().mockResolvedValue(null),
    installUpdate: vi.fn().mockResolvedValue(undefined),
    dismissInstalledReleaseNotes: vi.fn(),
    setAutoUpdateEnabled: vi.fn(),
    setUpdateChannel: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }

  render(
    <AppUpdateContext.Provider value={value}>
      <AboutSettingsPage />
    </AppUpdateContext.Provider>
  )
  return value
}

describe('AboutSettingsPage', () => {
  afterEach(() => {
    appVersionMocks.getVersion.mockReset()
    appVersionMocks.isElectronRuntime.mockReset()
    appVersionMocks.isElectronRuntime.mockReturnValue(false)
  })

  test('shows the package version reported by the running desktop app', async () => {
    appVersionMocks.isElectronRuntime.mockReturnValue(true)
    appVersionMocks.getVersion.mockResolvedValue({ version: '2.3.4' })

    renderPage()

    expect(screen.getByTestId('about-app-version')).toHaveTextContent('—')
    await waitFor(() => {
      expect(screen.getByTestId('about-app-version')).toHaveTextContent('v2.3.4')
    })
  })

  test('labels the screenshot scenario as returning to an older stable release', () => {
    renderPage({
      currentVersion: '0.5.0-beta.1',
      status: 'available',
      availableUpdate: {
        currentVersion: '0.5.0-beta.1',
        version: '0.4.3',
        kind: 'downgrade-to-stable',
      },
    })
    expect(screen.getByTestId('about-check-update-button')).toHaveTextContent('回到正式版 0.4.3')
    expect(screen.getByTestId('about-update-status')).toHaveTextContent('版本号低于当前版本')
    expect(screen.queryByText(/发现新版本/)).not.toBeInTheDocument()
  })

  test('lets the user opt into Beta and stable updates', () => {
    const value = renderPage()

    fireEvent.click(screen.getByTestId('about-beta-update-switch'))

    expect(value.setUpdateChannel).toHaveBeenCalledWith('beta')
  })

  test('enables automatic updates by default and lets the user disable them', () => {
    const value = renderPage()
    const autoUpdateSwitch = screen.getByTestId('about-auto-update-switch')

    expect(autoUpdateSwitch).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(autoUpdateSwitch)

    expect(value.setAutoUpdateEnabled).toHaveBeenCalledWith(false)
  })

  test('lets a Beta user return to stable-only updates', () => {
    const value = renderPage({ updateChannel: 'beta' })
    const channelSwitch = screen.getByTestId('about-beta-update-switch')

    expect(channelSwitch).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(channelSwitch)

    expect(value.setUpdateChannel).toHaveBeenCalledWith('stable')
  })
})
