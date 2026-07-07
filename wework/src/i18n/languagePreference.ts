import i18n from '@/i18n'
import type { AppLanguagePreference } from '@/tauri/appPreferences'

export const languagePreferenceOptions: Array<{
  value: AppLanguagePreference
  labelKey: string
  shortLabelKey: string
  descriptionKey: string
}> = [
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
]

export function resolvePreferredLanguage(
  preference: AppLanguagePreference,
  systemLanguage = getSystemLanguage()
): 'zh-CN' | 'en' {
  if (preference === 'en' || preference === 'zh-CN') {
    return preference
  }

  return systemLanguage.toLowerCase().startsWith('en') ? 'en' : 'zh-CN'
}

export async function applyLanguagePreference(preference: AppLanguagePreference) {
  const language = resolvePreferredLanguage(preference)
  if (i18n.resolvedLanguage === language || i18n.language === language) {
    return language
  }

  await i18n.changeLanguage(language)
  return language
}

function getSystemLanguage() {
  return navigator.languages?.[0] ?? navigator.language ?? 'zh-CN'
}
