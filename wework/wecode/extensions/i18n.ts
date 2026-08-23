import type { ExtensionI18nResources } from '@/extensions/i18n'
import enRemoteDevice from '@wecode/i18n/locales/en/remoteDevice.json'
import enVnc from '@wecode/i18n/locales/en/vnc.json'
import zhRemoteDevice from '@wecode/i18n/locales/zh-CN/remoteDevice.json'
import zhVnc from '@wecode/i18n/locales/zh-CN/vnc.json'

export const extensionI18nResources: ExtensionI18nResources = {
  en: { remoteDevice: enRemoteDevice, vnc: enVnc },
  'zh-CN': { remoteDevice: zhRemoteDevice, vnc: zhVnc },
}
