import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import enCommon from './locales/en/common.json'
import zhCommon from './locales/zh-CN/common.json'
import enChat from './locales/en/chat.json'
import zhChat from './locales/zh-CN/chat.json'
import enLocalRuntime from './locales/en/localRuntime.json'
import zhLocalRuntime from './locales/zh-CN/localRuntime.json'
import enSites from './locales/en/sites.json'
import zhSites from './locales/zh-CN/sites.json'
import enHooks from './locales/en/hooks.json'
import zhHooks from './locales/zh-CN/hooks.json'
import { extensionI18nResources } from '@extensions/i18n'

const extensionNamespaces = Array.from(
  new Set(Object.values(extensionI18nResources).flatMap(resources => Object.keys(resources ?? {})))
)

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: {
        chat: enChat,
        common: enCommon,
        localRuntime: enLocalRuntime,
        sites: enSites,
        hooks: enHooks,
        ...(extensionI18nResources.en ?? {}),
      },
      'zh-CN': {
        chat: zhChat,
        common: zhCommon,
        localRuntime: zhLocalRuntime,
        sites: zhSites,
        hooks: zhHooks,
        ...(extensionI18nResources['zh-CN'] ?? {}),
      },
    },
    lng: 'zh-CN',
    fallbackLng: 'zh-CN',
    supportedLngs: ['zh-CN', 'en'],
    defaultNS: 'common',
    ns: ['common', 'chat', 'localRuntime', 'sites', 'hooks', ...extensionNamespaces],
    interpolation: { escapeValue: false },
  })

export default i18n
