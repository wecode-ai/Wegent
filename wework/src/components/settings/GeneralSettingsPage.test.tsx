import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { AppPreferences } from '@/tauri/appPreferences'
import { GeneralSettingsPage } from './GeneralSettingsPage'

const defaultPreferences: AppPreferences = {
  closeToTrayEnabled: true,
  showMainWindowOnLaunch: true,
  closeToTrayHintSeen: false,
  language: 'zh-CN',
  taskCompletionNotificationsEnabled: false,
  trayUnreadEnabled: true,
  trayRunningEnabled: true,
  trayUsageEnabled: true,
}

const getAppPreferencesMock = vi.hoisted(() => vi.fn())
const updateAppPreferencesMock = vi.hoisted(() => vi.fn())
const applyLanguagePreferenceMock = vi.hoisted(() => vi.fn())
const translateMock = vi.hoisted(() => (key: string, fallback?: string) => fallback ?? key)

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: translateMock,
  }),
}))

vi.mock('@/tauri/appPreferences', () => ({
  defaultAppPreferences: {
    closeToTrayEnabled: true,
    showMainWindowOnLaunch: true,
    closeToTrayHintSeen: false,
    language: 'zh-CN',
    taskCompletionNotificationsEnabled: false,
    trayUnreadEnabled: true,
    trayRunningEnabled: true,
    trayUsageEnabled: true,
  },
  getAppPreferences: getAppPreferencesMock,
  updateAppPreferences: updateAppPreferencesMock,
}))

vi.mock('@/i18n/languagePreference', () => ({
  applyLanguagePreference: applyLanguagePreferenceMock,
  languagePreferenceOptions: [
    {
      value: 'system',
      labelKey: 'general_settings_language_system',
      shortLabelKey: 'general_settings_language_system_short',
      descriptionKey: 'general_settings_language_system_description',
    },
    {
      value: 'zh-CN',
      labelKey: 'general_settings_language_zh_cn',
      shortLabelKey: 'general_settings_language_zh_cn_short',
      descriptionKey: 'general_settings_language_zh_cn_description',
    },
    {
      value: 'en',
      labelKey: 'general_settings_language_en',
      shortLabelKey: 'general_settings_language_en_short',
      descriptionKey: 'general_settings_language_en_description',
    },
  ],
}))

describe('GeneralSettingsPage', () => {
  beforeEach(() => {
    getAppPreferencesMock.mockReset()
    updateAppPreferencesMock.mockReset()
    applyLanguagePreferenceMock.mockReset()
    getAppPreferencesMock.mockResolvedValue(defaultPreferences)
    updateAppPreferencesMock.mockImplementation(patch =>
      Promise.resolve({ ...defaultPreferences, ...patch })
    )
    applyLanguagePreferenceMock.mockResolvedValue('zh-CN')
  })

  test('renders language preference options', async () => {
    render(<GeneralSettingsPage />)

    expect(await screen.findByTestId('general-language-system-button')).toBeInTheDocument()
    expect(screen.getByTestId('general-language-zh-CN-button')).toBeInTheDocument()
    expect(screen.getByTestId('general-language-en-button')).toBeInTheDocument()
  })

  test('saves and applies the selected language', async () => {
    render(<GeneralSettingsPage />)

    fireEvent.click(await screen.findByTestId('general-language-en-button'))

    await waitFor(() => {
      expect(updateAppPreferencesMock).toHaveBeenCalledWith({ language: 'en' })
    })
    expect(applyLanguagePreferenceMock).toHaveBeenCalledWith('en')
  })

  test('rolls back language selection when saving fails', async () => {
    getAppPreferencesMock.mockResolvedValue({ ...defaultPreferences, language: 'zh-CN' })
    updateAppPreferencesMock.mockRejectedValue(new Error('save failed'))

    render(<GeneralSettingsPage />)

    const zhButton = await screen.findByTestId('general-language-zh-CN-button')
    fireEvent.click(screen.getByTestId('general-language-en-button'))

    await waitFor(() => {
      expect(screen.getByTestId('general-settings-status')).toHaveTextContent(
        'workbench.general_settings_save_failed'
      )
    })
    expect(zhButton).toHaveAttribute('aria-pressed', 'true')
    expect(zhButton.className).toContain('bg-text-primary')
    expect(applyLanguagePreferenceMock).not.toHaveBeenCalled()
  })

  test('shows system tray toggles and saves each tray display preference separately', async () => {
    render(<GeneralSettingsPage />)

    expect(
      await screen.findByText('workbench.general_settings_system_tray_title')
    ).toBeInTheDocument()
    expect(screen.getByTestId('general-task-completion-notifications-toggle')).not.toBeChecked()
    expect(screen.getByTestId('general-tray-unread-toggle')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('general-tray-running-toggle')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByTestId('general-tray-usage-toggle')).toHaveAttribute('aria-pressed', 'true')

    await userEvent.click(screen.getByTestId('general-task-completion-notifications-toggle'))
    await userEvent.click(screen.getByTestId('general-tray-unread-toggle'))
    await userEvent.click(screen.getByTestId('general-tray-running-toggle'))
    await userEvent.click(screen.getByTestId('general-tray-usage-toggle'))

    await waitFor(() => {
      expect(updateAppPreferencesMock).toHaveBeenCalledWith({
        taskCompletionNotificationsEnabled: true,
      })
      expect(updateAppPreferencesMock).toHaveBeenCalledWith({ trayUnreadEnabled: false })
      expect(updateAppPreferencesMock).toHaveBeenCalledWith({ trayRunningEnabled: false })
      expect(updateAppPreferencesMock).toHaveBeenCalledWith({ trayUsageEnabled: false })
    })
  })
})
