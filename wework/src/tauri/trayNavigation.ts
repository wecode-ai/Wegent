import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import i18n from '@/i18n'
import { buildRuntimeTaskRoute, navigateTo } from '@/lib/navigation'
import { isTauriRuntime } from '@/lib/runtime-environment'
import { EMPTY_TRAY_MENU_TASK_GROUPS, type TrayMenuTaskGroups } from './trayMenuState'
import { parseTrayTaskMenuId } from './trayTaskMenuId'

export const WEWORK_TRAY_OPEN_SETTINGS_EVENT = 'wework-tray-open-settings'
export const WEWORK_TRAY_OPEN_TASK_EVENT = 'wework-tray-open-task'
export const SET_TRAY_MENU_STATE_COMMAND = 'set_tray_menu_state'

let traySettingsNavigationListener: Promise<UnlistenFn> | null = null
let trayTaskNavigationListener: Promise<UnlistenFn> | null = null
let trayLanguageSyncInstalled = false
let latestTrayTaskGroups = EMPTY_TRAY_MENU_TASK_GROUPS
let latestUsageTitle: string | null = null
let latestUsageTooltip: string | null = null

function getTrayLanguage(language?: string): string {
  return language?.toLowerCase().startsWith('en') ? 'en' : 'zh-CN'
}

function getTrayMenuState(language = i18n.resolvedLanguage || i18n.language) {
  return {
    language: getTrayLanguage(language),
    usageTitle: latestUsageTitle,
    usageTooltip: latestUsageTooltip,
    ...latestTrayTaskGroups,
  }
}

export function syncTrayMenuState(
  taskGroups: TrayMenuTaskGroups = latestTrayTaskGroups,
  language = i18n.resolvedLanguage || i18n.language,
  usage?: { title: string | null; tooltip: string | null }
) {
  latestTrayTaskGroups = taskGroups
  if (usage) {
    latestUsageTitle = usage.title
    latestUsageTooltip = usage.tooltip
  }

  if (!isTauriRuntime()) {
    return
  }

  void invoke(SET_TRAY_MENU_STATE_COMMAND, {
    state: getTrayMenuState(language),
  }).catch(error => {
    console.error('[Wework] Failed to sync tray menu state', error)
  })
}

export function installTraySettingsNavigation() {
  if (!isTauriRuntime()) {
    return
  }

  if (!traySettingsNavigationListener) {
    traySettingsNavigationListener = listen(WEWORK_TRAY_OPEN_SETTINGS_EVENT, () => {
      navigateTo('/settings')
    }).catch(error => {
      traySettingsNavigationListener = null
      console.error('[Wework] Failed to install tray settings navigation listener', error)
      return () => {}
    })
  }

  if (!trayTaskNavigationListener) {
    trayTaskNavigationListener = listen<{ id: string }>(WEWORK_TRAY_OPEN_TASK_EVENT, event => {
      const address = parseTrayTaskMenuId(event.payload.id)
      if (!address) {
        return
      }
      navigateTo(buildRuntimeTaskRoute(address))
    }).catch(error => {
      trayTaskNavigationListener = null
      console.error('[Wework] Failed to install tray task navigation listener', error)
      return () => {}
    })
  }

  if (!trayLanguageSyncInstalled) {
    trayLanguageSyncInstalled = true
    syncTrayMenuState()
    i18n.on('languageChanged', language => {
      syncTrayMenuState(latestTrayTaskGroups, language)
    })
  }
}
