import type { AppPreferences } from '@/desktop/appPreferences'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { AppshotsSettingsPage } from './AppshotsSettingsPage'

const getAppshotsStatusMock = vi.hoisted(() => vi.fn())
const getAppPreferencesMock = vi.hoisted(() => vi.fn())
const updateAppPreferencesMock = vi.hoisted(() => vi.fn())
const openAppshotsPermissionSettingsMock = vi.hoisted(() => vi.fn())

const defaultPreferences: AppPreferences = {
  workbenchMode: 'developer',
  appearanceMode: 'system',
  appearanceThemeSnapshot: null,
  closeToTrayEnabled: true,
  showMainWindowOnLaunch: true,
  systemDragEnabled: true,
  preventSleepWhileTasksRunning: true,
  closeToTrayHintSeen: false,
  language: 'zh-CN',
  terminalContextInjectionEnabled: true,
  contextCompactionThreshold: 85,
  experimentalFeaturesEnabled: false,
  telemetryEnabled: true,
  trayUnreadEnabled: true,
  trayRunningEnabled: true,
  trayUsageEnabled: true,
  trayWegentUsageEnabled: true,
  browserExternalLinkTarget: 'system',
  browserLocalLinkTarget: 'wework',
  browserDownloadDirectory: null,
  browserFullControl: false,
  browserAskBeforeDownload: false,
  appshotsPlaySound: true,
}

const language = vi.hoisted(() => ({ current: 'en' }))
vi.mock('@/hooks/useTranslation', () => {
  const en = (key: string, fallback?: string) => fallback ?? key
  const zh = (key: string, fallback?: string) => fallback ?? key
  return { useTranslation: () => ({ t: language.current === 'en' ? en : zh }) }
})

vi.mock('@/desktop/appshots', () => ({
  getAppshotsStatus: getAppshotsStatusMock,
  openAppshotsPermissionSettings: openAppshotsPermissionSettingsMock,
}))

vi.mock('@/desktop/appPreferences', () => ({
  defaultAppPreferences: {
    workbenchMode: 'developer',
    appearanceMode: 'system',
    appearanceThemeSnapshot: null,
    closeToTrayEnabled: true,
    showMainWindowOnLaunch: true,
    systemDragEnabled: true,
    preventSleepWhileTasksRunning: true,
    closeToTrayHintSeen: false,
    language: 'zh-CN',
    terminalContextInjectionEnabled: true,
    telemetryEnabled: true,
    trayUnreadEnabled: true,
    trayRunningEnabled: true,
    trayUsageEnabled: true,
    trayWegentUsageEnabled: true,
    browserExternalLinkTarget: 'system',
    browserLocalLinkTarget: 'wework',
    browserDownloadDirectory: null,
    browserFullControl: false,
    browserAskBeforeDownload: false,
    appshotsPlaySound: true,
  },
  getAppPreferences: getAppPreferencesMock,
  updateAppPreferences: updateAppPreferencesMock,
}))

describe('AppshotsSettingsPage', () => {
  beforeEach(() => {
    language.current = 'en'
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
  test('shows shortcut readiness while the independent sound preference is pending', async () => {
    let resolve!: (value: AppPreferences) => void
    getAppPreferencesMock.mockReturnValueOnce(
      new Promise<AppPreferences>(done => {
        resolve = done
      })
    )
    render(<AppshotsSettingsPage />)
    await act(async () => {})
    expect(screen.getByText('在任意应用中截取最前面的窗口')).toBeInTheDocument()
    expect(screen.getByTestId('appshots-play-sound-toggle')).toBeDisabled()
    await act(async () => resolve({ ...defaultPreferences, appshotsPlaySound: false }))
    expect(screen.getByTestId('appshots-play-sound-toggle')).toHaveAttribute(
      'aria-checked',
      'false'
    )
  })

  test('changing language does not repeat native status or preference reads', async () => {
    const view = render(<AppshotsSettingsPage />)
    await act(async () => {})
    language.current = 'zh'
    view.rerender(<AppshotsSettingsPage />)
    await act(async () => {})
    expect(getAppshotsStatusMock).toHaveBeenCalledOnce()
    expect(getAppPreferencesMock).toHaveBeenCalledOnce()
  })
  test('keeps successful shortcut status visible when the sound preference read fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      getAppPreferencesMock.mockRejectedValueOnce(new Error('preferences unavailable'))
      render(<AppshotsSettingsPage />)
      await act(async () => {})
      expect(screen.getByText('在任意应用中截取最前面的窗口')).toBeInTheDocument()
      expect(screen.getByTestId('appshots-settings-error')).toBeInTheDocument()
      expect(screen.getByTestId('appshots-play-sound-toggle')).toBeDisabled()
    } finally {
      log.mockRestore()
    }
  })

  test('reports a failed capability read without claiming that the platform is unsupported', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      getAppshotsStatusMock.mockRejectedValueOnce(new Error('host unavailable'))
      render(<AppshotsSettingsPage />)
      await act(async () => {})
      expect(screen.getByTestId('appshots-settings-error')).toHaveTextContent(
        '应用快照设置加载失败'
      )
      expect(screen.queryByText('应用快照目前仅支持 macOS。')).toBeNull()
      expect(screen.getByTestId('appshots-play-sound-toggle')).toBeDisabled()
    } finally {
      log.mockRestore()
    }
  })

  test('preserves a sound preference after saving fails and supports retry without reloading', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      updateAppPreferencesMock.mockRejectedValueOnce(new Error('offline'))
      render(<AppshotsSettingsPage />)
      await act(async () => {})
      const user = userEvent.setup()
      await user.click(screen.getByTestId('appshots-play-sound-toggle'))
      expect(screen.getByTestId('appshots-play-sound-toggle')).toHaveAttribute(
        'aria-checked',
        'true'
      )
      expect(screen.getByTestId('appshots-settings-error')).toHaveTextContent(
        '应用快照设置保存失败'
      )
      await user.click(screen.getByTestId('appshots-play-sound-toggle'))
      expect(screen.getByTestId('appshots-play-sound-toggle')).toHaveAttribute(
        'aria-checked',
        'false'
      )
      expect(screen.queryByTestId('appshots-settings-error')).toBeNull()
      expect(getAppPreferencesMock).toHaveBeenCalledOnce()
    } finally {
      log.mockRestore()
    }
  })
})
