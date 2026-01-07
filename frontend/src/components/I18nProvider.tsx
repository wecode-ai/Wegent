// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { I18nextProvider } from 'react-i18next'
import i18next, { initI18n, supportedLanguages } from '@/i18n/setup'

interface I18nProviderProps {
  children: React.ReactNode
}

export default function I18nProvider({ children }: I18nProviderProps) {
  const [isInitialized, setIsInitialized] = useState(false)

  useEffect(() => {
    const init = async () => {
      try {
        await initI18n()

        // Read user's language preference from localStorage
        const savedLanguage = localStorage.getItem('preferred-language')
        if (savedLanguage && supportedLanguages.includes(savedLanguage)) {
          await i18next.changeLanguage(savedLanguage)
        } else {
          // Try to detect browser language
          const browserLanguage = navigator.language
          const matchedLanguage = supportedLanguages.find(
            lang => browserLanguage.startsWith(lang) || browserLanguage === lang
          )

          if (matchedLanguage) {
            await i18next.changeLanguage(matchedLanguage)
          }
        }

        setIsInitialized(true)
      } catch (error) {
        console.error('Failed to initialize i18n:', error)
        // Even if initialization fails, set to true to avoid infinite loading
        setIsInitialized(true)
      }
    }

    init()
  }, [])

  if (!isInitialized) {
    return (
      <div className="flex items-center justify-center smart-h-screen box-border">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-gray-900"></div>
      </div>
    )
  }

  return <I18nextProvider i18n={i18next}>{children}</I18nextProvider>
}
