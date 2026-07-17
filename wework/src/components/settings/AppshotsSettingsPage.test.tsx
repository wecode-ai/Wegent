import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { AppPreferences } from '@/tauri/appPreferences'
import { AppshotsSettingsPage } from './AppshotsSettingsPage'

const getAppshotsStatusMock = vi.hoisted(() => vi.fn())
const getAppPreferencesMock = vi.hoisted(() => vi.fn())
const updateAppPreferencesMock = vi.hoisted(() => vi.fn())
const openAppshotsPermissionSettingsMock = vi.hoisted(() => vi.fn())

const defaultPreferences: AppPreferences = {
  closeToTrayEnabled: true,
  showMainWindowOnLaunch: true,
  closeToTrayHintSeen: false,
  language: 'zh-CN',
  terminalContextInjectionEnabled: true,
  experimentalFeaturesEnabled: false,
  taskCompletionNotificationsEnabled: false,
  trayUnreadEnabled: true,
  trayRunningEnabled: true,
  trayUsageEnabled: true,
  browserExternalLinkTarget: 'system',
  browserLocalLinkTarget: 'wework',
  browserDownloadDirectory: null,
  browserAskBeforeDownload: false,
  appshotsPlaySound: true,
}

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}))

vi.mock('@/tauri/appshots', () => ({
  getAppshotsStatus: getAppshotsStatusMock,
  openAppshotsPermissionSettings: openAppshotsPermissionSettingsMock,
}))

vi.mock('@/tauri/appPreferences', () => ({
  defaultAppPreferences: {
    closeToTrayEnabled: true,
    showMainWindowOnLaunch: true,
    closeToTrayHintSeen: false,
    language: 'zh-CN',
    terminalContextInjectionEnabled: true,
    taskCompletionNotificationsEnabled: false,
    trayUnreadEnabled: true,
    trayRunningEnabled: true,
    trayUsageEnabled: true,
    browserExternalLinkTarget: 'system',
    browserLocalLinkTarget: 'wework',
    browserDownloadDirectory: null,
    browserAskBeforeDownload: false,
    appshotsPlaySound: true,
  },
  getAppPreferences: getAppPreferencesMock,
  updateAppPreferences: updateAppPreferencesMock,
}))

describe('AppshotsSettingsPage', () => {
  beforeEach(() => {
    getAppshotsStatusMock.mockReset()
    getAppPreferencesMock.mockReset()
    updateAppPreferencesMock.mockReset()
    openAppshotsPermissionSettingsMock.mockReset()
    openAppshotsPermissionSettingsMock.mockResolvedValue(undefined)
    getAppshotsStatusMock.mockResolvedValue({
      supported: true,
      shortcut: 'CommandOrControl+Shift+2',
      shortcutRegistered: true,
      screenCapturePermissionGranted: true,
      accessibilityPermissionGranted: true,
    })
    getAppPreferencesMock.mockResolvedValue(defaultPreferences)
    updateAppPreferencesMock.mockImplementation(patch =>
      Promise.resolve({ ...defaultPreferences, ...patch })
    )
  })

  test('opens Accessibility settings when window text access is missing', async () => {
    const user = userEvent.setup()
    getAppshotsStatusMock.mockResolvedValue({
      supported: true,
      shortcut: 'CommandOrControl+Shift+2',
      shortcutRegistered: true,
      screenCapturePermissionGranted: true,
      accessibilityPermissionGranted: false,
    })
    render(<AppshotsSettingsPage />)

    await user.click(await screen.findByTestId('appshots-open-accessibility-settings-button'))

    expect(openAppshotsPermissionSettingsMock).toHaveBeenCalledWith('accessibility')
  })

  test('shows the registered shortcut and automatic destination', async () => {
    render(<AppshotsSettingsPage />)

    expect(await screen.findByText('在任意应用中截取最前面的窗口')).toBeInTheDocument()
    expect(screen.getByText('自动')).toBeInTheDocument()
    expect(screen.getByLabelText('Command')).toBeInTheDocument()
  })

  test('persists the capture sound preference', async () => {
    const user = userEvent.setup()
    render(<AppshotsSettingsPage />)

    const toggle = await screen.findByTestId('appshots-play-sound-toggle')
    await waitFor(() => expect(toggle).toBeEnabled())
    await user.click(toggle)

    await waitFor(() => {
      expect(updateAppPreferencesMock).toHaveBeenCalledWith({ appshotsPlaySound: false })
    })
  })

  test('explains when the global shortcut could not be registered', async () => {
    getAppshotsStatusMock.mockResolvedValue({
      supported: true,
      shortcut: 'CommandOrControl+Shift+2',
      shortcutRegistered: false,
    })

    render(<AppshotsSettingsPage />)

    expect(
      await screen.findByText('快捷键已被其他应用占用，请退出冲突的应用后重启 Wework。')
    ).toBeInTheDocument()
  })
})
