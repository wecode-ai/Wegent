import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  AppUpdateContext,
  type AppUpdateContextValue,
} from '@/features/app-update/app-update-context'
import { AboutSettingsPage } from './AboutSettingsPage'

const appVersionMocks = vi.hoisted(() => ({
  getVersion: vi.fn(),
  isTauriRuntime: vi.fn(() => false),
}))

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: appVersionMocks.getVersion,
}))

vi.mock('@/lib/runtime-environment', () => ({
  isTauriRuntime: appVersionMocks.isTauriRuntime,
}))

function renderPage(overrides: Partial<AppUpdateContextValue> = {}) {
  const value: AppUpdateContextValue = {
    updateChannel: 'stable',
    availableUpdate: null,
    installedReleaseNotes: null,
    status: 'idle',
    downloadProgress: null,
    message: null,
    error: null,
    checkNow: vi.fn().mockResolvedValue(null),
    installUpdate: vi.fn().mockResolvedValue(undefined),
    dismissInstalledReleaseNotes: vi.fn(),
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
    appVersionMocks.isTauriRuntime.mockReset()
    appVersionMocks.isTauriRuntime.mockReturnValue(false)
  })

  test('shows the package version reported by the running desktop app', async () => {
    appVersionMocks.isTauriRuntime.mockReturnValue(true)
    appVersionMocks.getVersion.mockResolvedValue('2.3.4')

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

  test('lets a Beta user return to stable-only updates', () => {
    const value = renderPage({ updateChannel: 'beta' })
    const channelSwitch = screen.getByTestId('about-beta-update-switch')

    expect(channelSwitch).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(channelSwitch)

    expect(value.setUpdateChannel).toHaveBeenCalledWith('stable')
  })
})
