// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'

// Supported languages list
export const supportedLanguages = ['en', 'zh-CN']

// Function to dynamically import translation resources
async function loadTranslations() {
  const resources: Record<string, Record<string, unknown>> = {}

  // Namespace list
  const namespaces = [
    'common',
    'chat',
    'settings',
    'history',
    'prompts',
    'tasks',
    'admin',
    'wizard',
    'groups',
    'knowledge',
    'shared-task',
    'promptTune',
    'projects',
  ]

  for (const lng of supportedLanguages) {
    resources[lng] = {}
    for (const ns of namespaces) {
      try {
        // Dynamically import JSON file with error handling
        const translationModule = await import(`./locales/${lng}/${ns}.json`)
        resources[lng][ns] = translationModule.default
      } catch (error) {
        // If file doesn't exist, use empty object
        console.warn(`Translation file not found: ./locales/${lng}/${ns}.json`, error)
        resources[lng][ns] = {}
      }
    }
  }

  return resources
}

// Initialize i18next
export async function initI18n() {
  const resources = await loadTranslations()

  await i18next.use(initReactI18next).init({
    lng: process.env.I18N_LNG || 'en', // default language is English
    fallbackLng: 'en', // fallback language is English
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resources: resources as any,
    interpolation: {
      escapeValue: false, // React already handles XSS protection
    },
    // Show debug info in development mode
    debug: process.env.NODE_ENV === 'development',
    // Namespace configuration
    defaultNS: 'common',
    ns: [
      'common',
      'chat',
      'settings',
      'history',
      'prompts',
      'tasks',
      'admin',
      'wizard',
      'groups',
      'knowledge',
      'shared-task',
      'promptTune',
      'projects',
    ],
  })

  return i18next
}

export default i18next
