// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { useTranslation, languageNames } from '@/hooks/useTranslation'
import { ChevronDownIcon, LanguageIcon } from '@heroicons/react/24/outline'

interface LanguageSwitcherProps {
  className?: string
  showLabel?: boolean
}

export default function LanguageSwitcher({
  className = '',
  showLabel = true,
}: LanguageSwitcherProps) {
  const { changeLanguage, getCurrentLanguage, getSupportedLanguages } = useTranslation()
  const [isOpen, setIsOpen] = useState(false)

  const currentLanguage = getCurrentLanguage()
  const supportedLanguages = getSupportedLanguages()

  const handleLanguageChange = (language: string) => {
    changeLanguage(language)
    setIsOpen(false)
  }

  return (
    <div className={`relative ${className}`}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center space-x-2 px-3 py-2 text-sm font-medium text-text-primary bg-surface border border-border rounded-md hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
      >
        <LanguageIcon className="w-4 h-4" />
        {showLabel && <span>{languageNames[currentLanguage] || currentLanguage}</span>}
        <ChevronDownIcon className="w-4 h-4" />
      </button>

      {isOpen && (
        <>
          {/* Dropdown menu with higher z-index to ensure it's above the overlay */}
          <div
            className="absolute right-0 z-30 mt-2 w-48 bg-surface border border-border rounded-md shadow-lg max-h-60 overflow-y-auto"
            style={{ boxShadow: 'var(--shadow-popover)' }}
          >
            <div className="py-1">
              {supportedLanguages.map(language => (
                <button
                  key={language}
                  onClick={() => handleLanguageChange(language)}
                  className={`w-full text-left px-4 py-2 text-sm hover:bg-muted ${
                    currentLanguage === language
                      ? 'bg-primary/10 text-primary font-medium'
                      : 'text-text-primary'
                  }`}
                >
                  {languageNames[language] || language}
                  {currentLanguage === language && <span className="ml-2 text-primary">✓</span>}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
