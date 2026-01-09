'use client'

import { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import i18n from '@/i18n'

interface LanguageContextType {
  language: string
  setLanguage: (lang: string) => void
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined)

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState('en')

  useEffect(() => {
    // Get language from localStorage on mount
    const saved = localStorage.getItem('language')
    if (saved && (saved === 'en' || saved === 'zh-CN')) {
      setLanguageState(saved)
      i18n.changeLanguage(saved)
    } else {
      const browserLang = navigator.language
      const defaultLang = browserLang.startsWith('zh') ? 'zh-CN' : 'en'
      setLanguageState(defaultLang)
      i18n.changeLanguage(defaultLang)
    }
  }, [])

  const setLanguage = (lang: string) => {
    setLanguageState(lang)
    localStorage.setItem('language', lang)
    i18n.changeLanguage(lang)
  }

  return (
    <LanguageContext.Provider value={{ language, setLanguage }}>
      {children}
    </LanguageContext.Provider>
  )
}

export function useLanguage() {
  const context = useContext(LanguageContext)
  if (!context) {
    throw new Error('useLanguage must be used within a LanguageProvider')
  }
  return context
}
