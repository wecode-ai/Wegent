import { invokeDesktopHost, subscribeDesktopHostEvents } from '@/api/dsh/desktopHost'
import { getDesktopWindowLabel } from '@/lib/runtime-environment'
import { navigateTo } from '@/lib/navigation'
import i18n from '@/i18n'
import { openDeveloperCommandMenu } from '@/lib/developerCommandMenu'
import { requestOpenTaskSearch } from '@/components/layout/workbenchShellEvents'
import {
  DECREASE_FONT_SIZE_COMMAND,
  INCREASE_FONT_SIZE_COMMAND,
  RESET_FONT_SIZE_COMMAND,
  dispatchBuiltinShortcutCommand,
  OPEN_TERMINAL_COMMAND,
  TOGGLE_SIDEBAR_COMMAND,
  TOGGLE_SIDE_PANEL_COMMAND,
} from '@/lib/keybindings'
import { APPLICATION_MENU_ACTIONS } from './applicationMenuModel'

/** Routes reachable from the Work menu; they reuse the workbench navigation. */
export const APPLICATION_MENU_WORK_ROUTES: Record<string, string> = {
  [APPLICATION_MENU_ACTIONS.openPlugins]: '/plugins',
  [APPLICATION_MENU_ACTIONS.openAutomations]: '/automations',
  [APPLICATION_MENU_ACTIONS.openApplications]: '/sites',
}

/**
 * Non-workspace-tab menu actions. Workspace-tab actions live in
 * ApplicationMenuWorkspaceBridge because they need the workspace tab context.
 */
export function installApplicationMenuNavigation(): () => void {
  return subscribeDesktopHostEvents(event => {
    if (event.type !== 'application-menu.action') return
    if (event.payload.windowLabel !== getDesktopWindowLabel()) return
    const action = event.payload.action
    if (action === APPLICATION_MENU_ACTIONS.openSettings) {
      navigateTo('/settings')
    } else if (action === APPLICATION_MENU_ACTIONS.developerCommands) {
      openDeveloperCommandMenu()
    } else if (action === APPLICATION_MENU_ACTIONS.openProcessExplorer) {
      void invokeDesktopHost('developer.openProcessExplorer').catch(error => {
        console.error('[application-menu] failed to open the process explorer', error)
      })
    } else if (action === APPLICATION_MENU_ACTIONS.openSearch) {
      requestOpenTaskSearch()
    } else if (action === APPLICATION_MENU_ACTIONS.openTerminal) {
      dispatchBuiltinShortcutCommand(OPEN_TERMINAL_COMMAND)
    } else if (action === APPLICATION_MENU_ACTIONS.toggleSidebar) {
      dispatchBuiltinShortcutCommand(TOGGLE_SIDEBAR_COMMAND)
    } else if (action === APPLICATION_MENU_ACTIONS.toggleSidePanel) {
      dispatchBuiltinShortcutCommand(TOGGLE_SIDE_PANEL_COMMAND)
    } else if (
      action === INCREASE_FONT_SIZE_COMMAND ||
      action === DECREASE_FONT_SIZE_COMMAND ||
      action === RESET_FONT_SIZE_COMMAND
    ) {
      dispatchBuiltinShortcutCommand(action)
    }
  })
}

/**
 * Applies the capabilities the host uses to hide unavailable menu items.
 * Called by the workspace bridge whenever the workbench state changes.
 */
export function reportApplicationMenuCapabilities(
  capabilities: Record<string, boolean>
): Promise<unknown> {
  return invokeDesktopHost('applicationMenu.setCapabilities', {
    windowLabel: getDesktopWindowLabel(),
    capabilities,
  })
}

/**
 * Sends the current Wework UI language to the host so the native menu follows
 * the in-app language preference instead of the operating-system locale.
 *
 * Mirrors the tray menu, which derives its language from i18n the same way.
 */
export function syncApplicationMenuLanguage(
  language = i18n.resolvedLanguage || i18n.language
): Promise<unknown> {
  return invokeDesktopHost('applicationMenu.setLanguage', { language })
}

/** Reports the current language and follows subsequent in-app changes. */
export function installApplicationMenuLanguageSync(): void {
  if (applicationMenuLanguageSyncInstalled) return
  applicationMenuLanguageSyncInstalled = true
  void syncApplicationMenuLanguage().catch(error =>
    console.error('[application-menu] failed to sync menu language', error)
  )
  i18n.on('languageChanged', language => {
    void syncApplicationMenuLanguage(language).catch(error =>
      console.error('[application-menu] failed to sync menu language', error)
    )
  })
}

let applicationMenuLanguageSyncInstalled = false
