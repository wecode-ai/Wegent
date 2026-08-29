import { invokeDesktopHost, subscribeDesktopHostEvents } from '@/api/dsh/desktopHost'
import i18n from '@/i18n'
import { buildRuntimeTaskRoute, navigateTo } from '@/lib/navigation'
import { getDesktopWindowLabel } from '@/lib/runtime-environment'
import { EMPTY_TRAY_MENU_TASK_GROUPS, type TrayMenuTaskGroups } from './trayMenuState'
import { parseTrayTaskMenuId } from './trayTaskMenuId'

export const WEWORK_TRAY_OPEN_SETTINGS_EVENT = 'wework-tray-open-settings'
export const WEWORK_TRAY_OPEN_TASK_EVENT = 'wework-tray-open-task'
export const WEWORK_POPOUT_OPEN_TASK_EVENT = 'wework-popout-open-task'
export const SET_TRAY_MENU_STATE_COMMAND = 'set_tray_menu_state'

let trayLanguageSyncInstalled = false
let trayActionPollingInstalled = false
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

  void invokeDesktopHost('tray.setState', {
    state: getTrayMenuState(language),
  }).catch(error => {
    console.error('[Wework] Failed to sync tray menu state', error)
  })
}

export function installTraySettingsNavigation() {
  if (getDesktopWindowLabel() !== 'main') return

  if (!trayActionPollingInstalled) {
    trayActionPollingInstalled = true
    subscribeDesktopHostEvents(event => {
      if (event.type !== 'tray.action') return
      const action = event.payload
      if (action.type === 'open-settings') {
        navigateTo('/settings')
      } else if (action.type === 'open-task' && typeof action.taskId === 'string') {
        const address = parseTrayTaskMenuId(action.taskId)
        if (address) navigateTo(buildRuntimeTaskRoute(address))
      }
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
