// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useTranslation as useI18nextTranslation } from 'react-i18next'
import { supportedLanguages } from '@/i18n/setup'

export function useTranslation(namespace?: string | string[]) {
  const { t, i18n } = useI18nextTranslation(namespace)

  const changeLanguage = (language: string) => {
    if (supportedLanguages.includes(language)) {
      i18n.changeLanguage(language)
      // Save to localStorage
      localStorage.setItem('preferred-language', language)
    }
  }

  const getCurrentLanguage = () => i18n.language

  const getSupportedLanguages = () => supportedLanguages

  return {
    t,
    changeLanguage,
    getCurrentLanguage,
    getSupportedLanguages,
    i18n,
  }
}

// Language display name mapping
export const languageNames: Record<string, string> = {
  ca: 'Català',
  de: 'Deutsch',
  en: 'English',
  es: 'Español',
  fr: 'Français',
  hi: 'हिन्दी',
  id: 'Bahasa Indonesia',
  it: 'Italiano',
  ja: '日本語',
  ko: '한국어',
  nl: 'Nederlands',
  pl: 'Polski',
  'pt-BR': 'Português (Brasil)',
  ru: 'Русский',
  tr: 'Türkçe',
  vi: 'Tiếng Việt',
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
}
