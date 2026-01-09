'use client'

import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import enCommon from './locales/en/common.json'
import zhCommon from './locales/zh-CN/common.json'

const resources = {
  en: {
    common: enCommon,
  },
  'zh-CN': {
    common: zhCommon,
  },
}

// Get initial language from localStorage or browser
const getInitialLanguage = () => {
  if (typeof window !== 'undefined') {
    const saved = localStorage.getItem('language')
    if (saved && (saved === 'en' || saved === 'zh-CN')) {
      return saved
    }
    // Check browser language
    const browserLang = navigator.language
    if (browserLang.startsWith('zh')) {
      return 'zh-CN'
    }
  }
  return 'en'
}

i18n.use(initReactI18next).init({
  resources,
  lng: getInitialLanguage(),
  fallbackLng: 'en',
  defaultNS: 'common',
  interpolation: {
    escapeValue: false,
  },
})

export default i18n
