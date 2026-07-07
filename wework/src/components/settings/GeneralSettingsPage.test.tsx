import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { GeneralSettingsPage } from './GeneralSettingsPage'
import type { AppPreferences } from '@/tauri/appPreferences'

const defaultPreferences: AppPreferences = {
  closeToTrayEnabled: true,
  showMainWindowOnLaunch: true,
  closeToTrayHintSeen: false,
  language: 'zh-CN',
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
})
