import { applicationsPlugin } from './applications'
import { automationsPlugin } from './automations'
import { cloudWorkPlugin } from './cloud-work'
import { pluginCenterPlugin } from './plugin-center'
import { shellPlugin } from './shell'
import { coreAppsPlugin } from './core-apps'
import { coreSettingsPlugin } from './core-settings'

import type { Plugin } from '@deepseek-ai/cordis'
import type { WorkbenchPluginProfile, WorkbenchPluginProfileEntry } from '@/plugin-runtime/runtime'

function required(id: string, plugin: Plugin): WorkbenchPluginProfileEntry {
  return {
    id,
    plugin,
    required: true,
    clientVersion: __WEWORK_APP_VERSION__,
  }
}

export const baseWorkbenchProfile: WorkbenchPluginProfile = {
  id: 'wework-base',
  entries: [
    required('shell', shellPlugin),
    required('core-apps', coreAppsPlugin),
    required('core-settings', coreSettingsPlugin),
    required('plugin-center', pluginCenterPlugin),
    required('applications', applicationsPlugin),
    required('automations', automationsPlugin),
    required('cloud-work', cloudWorkPlugin),
  ],
}
