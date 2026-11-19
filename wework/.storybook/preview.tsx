import enModelConnections from '../src/i18n/locales/en/modelConnections.json'
import zhModelConnections from '../src/i18n/locales/zh-CN/modelConnections.json'
import enChat from '../src/i18n/locales/en/chat.json'
import zhChat from '../src/i18n/locales/zh-CN/chat.json'
import { CollaborationTheme } from '@wegent/collaboration/theme'
import '@wegent/collaboration/styles.css'
import { useLayoutEffect } from 'react'
import type { Preview } from '@storybook/react-vite'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { applyAppearance } from '../src/features/appearance/applyAppearance'
import { defaultAppearance } from '../src/features/appearance/presets'
import enCommon from '../src/i18n/locales/en/common.json'
import zhCommon from '../src/i18n/locales/zh-CN/common.json'
import enCatalog from '../src/i18n/locales/en/componentCatalog.json'
import zhCatalog from '../src/i18n/locales/zh-CN/componentCatalog.json'
import '../src/styles/globals.css'

// Preview localization is isolated from desktop preferences and native startup.
const i18n = createInstance()
void i18n.use(initReactI18next).init({
  resources: {
    en: {
      common: enCommon,
      chat: enChat,
      componentCatalog: enCatalog,
      modelConnections: enModelConnections,
    },
    'zh-CN': {
      common: zhCommon,
      chat: zhChat,
      componentCatalog: zhCatalog,
      modelConnections: zhModelConnections,
    },
  },
  lng: 'zh-CN',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
})

const preview: Preview = {
  tags: ['autodocs'],
  globalTypes: {
    theme: { toolbar: { icon: 'circlehollow', items: ['light', 'dark'], dynamicTitle: true } },
    locale: { toolbar: { icon: 'globe', items: ['zh-CN', 'en'], dynamicTitle: true } },
  },
  initialGlobals: { theme: 'light', locale: 'zh-CN' },
  decorators: [
    function PreviewSurface(Story, context) {
      const mode = context.globals.theme === 'dark' ? 'dark' : 'light'
      const locale = context.globals.locale === 'en' ? 'en' : 'zh-CN'
      useLayoutEffect(() => {
        applyAppearance({ ...defaultAppearance, mode }, mode)
        document.documentElement.lang = locale
        void i18n.changeLanguage(locale)
      }, [mode, locale])
      return (
        <I18nextProvider i18n={i18n}>
          <CollaborationTheme mode={mode}>
            <div className="min-h-48 bg-background p-5 text-text-primary">
              <Story />
            </div>
          </CollaborationTheme>
        </I18nextProvider>
      )
    },
  ],
  parameters: {
    layout: 'fullscreen',
    options: { storySort: { order: ['Foundations', 'Controls', 'Patterns', 'Shared'] } },
  },
}

export default preview
