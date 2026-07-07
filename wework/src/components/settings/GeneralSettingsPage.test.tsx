import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { GeneralSettingsPage } from './GeneralSettingsPage'

const getAppPreferencesMock = vi.hoisted(() => vi.fn())
const updateAppPreferencesMock = vi.hoisted(() => vi.fn())
const defaultPreferences = vi.hoisted(() => ({
  closeToTrayEnabled: true,
  showMainWindowOnLaunch: true,
  closeToTrayHintSeen: false,
  taskCompletionNotificationsEnabled: true,
  trayUnreadEnabled: true,
  trayRunningEnabled: true,
  trayUsageEnabled: true,
}))

vi.mock('@/tauri/appPreferences', () => ({
  defaultAppPreferences: defaultPreferences,
  getAppPreferences: getAppPreferencesMock,
  updateAppPreferences: updateAppPreferencesMock,
}))

describe('GeneralSettingsPage', () => {
  beforeEach(() => {
    getAppPreferencesMock.mockReset()
    updateAppPreferencesMock.mockReset()
    getAppPreferencesMock.mockResolvedValue(defaultPreferences)
    updateAppPreferencesMock.mockImplementation(patch =>
      Promise.resolve({ ...defaultPreferences, ...patch })
    )
  })

  test('shows system tray toggles and saves each tray display preference separately', async () => {
    render(<GeneralSettingsPage />)

    expect(
      await screen.findByText('workbench.general_settings_system_tray_title')
    ).toBeInTheDocument()
    expect(screen.getByTestId('general-task-completion-notifications-toggle')).toBeChecked()
    expect(screen.getByTestId('general-tray-unread-toggle')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('general-tray-running-toggle')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByTestId('general-tray-usage-toggle')).toHaveAttribute('aria-pressed', 'true')

    await userEvent.click(screen.getByTestId('general-tray-unread-toggle'))
    await userEvent.click(screen.getByTestId('general-tray-running-toggle'))
    await userEvent.click(screen.getByTestId('general-tray-usage-toggle'))

    await waitFor(() => {
      expect(updateAppPreferencesMock).toHaveBeenCalledWith({ trayUnreadEnabled: false })
      expect(updateAppPreferencesMock).toHaveBeenCalledWith({ trayRunningEnabled: false })
      expect(updateAppPreferencesMock).toHaveBeenCalledWith({ trayUsageEnabled: false })
    })
  })
})
