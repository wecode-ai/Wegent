import type { ExtensionI18nResources } from '@/extensions/i18n'
import enVnc from '@wecode/i18n/locales/en/vnc.json'
import zhVnc from '@wecode/i18n/locales/zh-CN/vnc.json'

export const extensionI18nResources: ExtensionI18nResources = {
  en: { vnc: enVnc },
  'zh-CN': { vnc: zhVnc },
}
