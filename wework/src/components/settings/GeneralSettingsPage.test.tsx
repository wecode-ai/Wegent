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
  terminalContextInjectionEnabled: true,
  taskCompletionNotificationsEnabled: false,
  trayUnreadEnabled: true,
  trayRunningEnabled: true,
  trayUsageEnabled: true,
}

const getAppPreferencesMock = vi.hoisted(() => vi.fn())
const updateAppPreferencesMock = vi.hoisted(() => vi.fn())
const applyLanguagePreferenceMock = vi.hoisted(() => vi.fn())
const translateMock = vi.hoisted(() => (key: string, fallback?: string) => fallback ?? key)
const importExternalContentMock = vi.hoisted(() => vi.fn())

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
    terminalContextInjectionEnabled: true,
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

vi.mock('@/api/local/codexPlugins', () => ({
  createLocalCodexPluginApi: () => ({
    importExternalContent: importExternalContentMock,
  }),
}))

describe('GeneralSettingsPage', () => {
  beforeEach(() => {
    getAppPreferencesMock.mockReset()
    updateAppPreferencesMock.mockReset()
    applyLanguagePreferenceMock.mockReset()
    importExternalContentMock.mockReset()
    importExternalContentMock.mockResolvedValue({
      source: 'codex',
      sourcePath: '/Users/test/.codex',
      destinationPath: '/Users/test/.wegent-executor/codex',
      importedEntries: ['config.toml'],
    })
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

    const englishButton = await screen.findByTestId('general-language-en-button')
    await waitFor(() => expect(englishButton).toBeEnabled())
    fireEvent.click(englishButton)

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
    const englishButton = screen.getByTestId('general-language-en-button')
    await waitFor(() => expect(englishButton).toBeEnabled())
    fireEvent.click(englishButton)

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
      await screen.findByText('workbench.general_settings_tray_display_content')
    ).toBeInTheDocument()
    const notificationToggle = screen.getByTestId('general-task-completion-notifications-toggle')
    await waitFor(() => expect(notificationToggle).toBeEnabled())
    expect(notificationToggle).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByTestId('general-tray-unread-toggle')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('general-tray-running-toggle')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByTestId('general-tray-usage-toggle')).toHaveAttribute('aria-pressed', 'true')

    await userEvent.click(notificationToggle)
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

  test('imports compatible content from Codex and Claude Code', async () => {
    render(<GeneralSettingsPage />)

    await userEvent.click(await screen.findByTestId('general-external-content-import-button'))
    expect(screen.getByTestId('external-content-import-dialog')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('external-content-source-claude-code'))
    await userEvent.click(screen.getByTestId('external-content-import-confirm-button'))

    await waitFor(() => {
      expect(importExternalContentMock).toHaveBeenCalledWith('claude-code')
    })
    expect(screen.getByTestId('external-content-import-success')).toBeInTheDocument()
  })

  test('shows an import error and allows retrying', async () => {
    importExternalContentMock
      .mockRejectedValueOnce(new Error('No supported content was found'))
      .mockResolvedValueOnce({
        source: 'codex',
        sourcePath: '/Users/test/.codex',
        destinationPath: '/Users/test/.wegent-executor/codex',
        importedEntries: ['config.toml'],
      })
    render(<GeneralSettingsPage />)

    await userEvent.click(await screen.findByTestId('general-external-content-import-button'))
    await userEvent.click(screen.getByTestId('external-content-import-confirm-button'))
    expect(await screen.findByTestId('external-content-import-error')).toHaveTextContent(
      'No supported content was found'
    )

    await userEvent.click(screen.getByTestId('external-content-import-confirm-button'))
    expect(await screen.findByTestId('external-content-import-success')).toBeInTheDocument()
    expect(importExternalContentMock).toHaveBeenCalledTimes(2)
  })
})
