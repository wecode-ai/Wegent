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
  showLabel = true 
}: LanguageSwitcherProps) {
  const { t, changeLanguage, getCurrentLanguage, getSupportedLanguages } = useTranslation('common')
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
        className="flex items-center space-x-2 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
      >
        <LanguageIcon className="w-4 h-4" />
        {showLabel && (
          <span>{languageNames[currentLanguage] || currentLanguage}</span>
        )}
        <ChevronDownIcon className="w-4 h-4" />
      </button>
      
      {isOpen && (
        <>
          {/* 背景遮罩 */}
          <div 
            className="fixed inset-0 z-10" 
            onClick={() => setIsOpen(false)}
          />
          
          {/* 下拉菜单 */}
          <div className="absolute right-0 z-20 mt-2 w-48 bg-white border border-gray-200 rounded-md shadow-lg max-h-60 overflow-y-auto">
            <div className="py-1">
              {supportedLanguages.map((language) => (
                <button
                  key={language}
                  onClick={() => handleLanguageChange(language)}
                  className={`w-full text-left px-4 py-2 text-sm hover:bg-gray-100 ${
                    currentLanguage === language 
                      ? 'bg-indigo-50 text-indigo-700 font-medium' 
                      : 'text-gray-700'
                  }`}
                >
                  {languageNames[language] || language}
                  {currentLanguage === language && (
                    <span className="ml-2 text-indigo-500">✓</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}