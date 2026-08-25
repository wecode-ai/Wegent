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
  isElectronRuntime: () => false,
  isElectronRuntime: appVersionMocks.isElectronRuntime,
}))

function renderPage(overrides: Partial<AppUpdateContextValue> = {}) {
  const value: AppUpdateContextValue = {
    updateChannel: 'stable',
    autoUpdateEnabled: true,
    availableUpdate: null,
    installedReleaseNotes: null,
    status: 'idle',
    downloadProgress: null,
    message: null,
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
