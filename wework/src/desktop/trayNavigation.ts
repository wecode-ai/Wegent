import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import i18n from '@/i18n'
import { buildRuntimeTaskRoute, navigateTo } from '@/lib/navigation'
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
  if (!trayActionPollingInstalled) {
    trayActionPollingInstalled = true
    const pollingWindow = window
    const poll = async () => {
      try {
        const actions =
          await invokeDesktopHost<
            Array<
              | { type: 'open-settings' }
              | { type: 'open-task'; taskId: string }
              | { type: 'open-app' }
            >
          >('tray.takePendingActions')
        for (const action of actions) {
          if (action.type === 'open-settings') {
            navigateTo('/settings')
          } else if (action.type === 'open-task') {
            const address = parseTrayTaskMenuId(action.taskId)
            if (address) navigateTo(buildRuntimeTaskRoute(address))
          }
        }
      } catch (error) {
        console.debug('[Wework] Failed to poll Electron tray actions', error)
      } finally {
        pollingWindow.setTimeout(poll, 100)
      }
    }
    void poll()
  }

  if (!trayLanguageSyncInstalled) {
    trayLanguageSyncInstalled = true
    syncTrayMenuState()
    i18n.on('languageChanged', language => {
      syncTrayMenuState(latestTrayTaskGroups, language)
    })
  }
}
