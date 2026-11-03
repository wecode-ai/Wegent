import { useEffect, useRef } from 'react'
import { subscribeDesktopHostEvents } from '@/api/dsh/desktopHost'
import { useWorkspaceTabs } from '@/features/workspace-tabs/workspaceTabsContextValue'
import { getDesktopWindowLabel } from '@/lib/runtime-environment'
import { isSettingsRoute, navigateTo } from '@/lib/navigation'
import { APPLICATION_MENU_WORK_ROUTES, reportApplicationMenuCapabilities } from './applicationMenu'
import {
  APPLICATION_MENU_ACTIONS,
  APPLICATION_MENU_CAPABILITIES,
  type ApplicationMenuCapabilityState,
} from './applicationMenuModel'

/**
 * Owns the application-menu actions that need the workspace tab context and
 * reports the capabilities that decide which menu items are visible.
 *
 * The capability state mirrors the UI: a menu item is only shown when the
 * corresponding UI action is actually available in the current surface.
 */
export function ApplicationMenuWorkspaceBridge({ pathname }: { pathname: string }) {
  const tabs = useWorkspaceTabs()
  const taskSurface =
    !isSettingsRoute(pathname) &&
    (tabs.activeTab.kind === 'task' || tabs.activeTab.kind === 'board')
  const canCloseTab = !tabs.activeTab.fixed

  // Handlers must run against the latest tab state. Reading from a ref keeps
  // the host subscription stable across tab changes: re-subscribing during
  // dispatch would let the same menu event reach a freshly added handler and
  // repeat the action until the renderer exhausts itself.
  const stateRef = useRef({ tabs, pathname })
  useEffect(() => {
    stateRef.current = { tabs, pathname }
  })

  useEffect(
    () =>
      subscribeDesktopHostEvents(event => {
        if (
          event.type !== 'application-menu.action' ||
          event.payload.windowLabel !== getDesktopWindowLabel()
        ) {
          return
        }
        const { tabs: current, pathname: currentPathname } = stateRef.current
        const action = event.payload.action
        if (action === APPLICATION_MENU_ACTIONS.newTaskTab) {
          current.openTab('task')
        } else if (action === APPLICATION_MENU_ACTIONS.newProjectSpaceTab) {
          current.openTab('board')
        } else if (action === APPLICATION_MENU_ACTIONS.closeTab) {
          if (!current.activeTab.fixed) current.closeTab(current.activeTabId)
        } else if (
          action === APPLICATION_MENU_ACTIONS.openTasks ||
          action === APPLICATION_MENU_ACTIONS.openProjectSpaces
        ) {
          const kind = action === APPLICATION_MENU_ACTIONS.openTasks ? 'task' : 'board'
          const existing = current.tabs.find(tab => tab.kind === kind)
          // Settings replaces the surface without changing the active tab, so
          // re-select it to restore its workspace route when leaving settings.
          if (existing) {
            if (existing.id !== current.activeTabId || isSettingsRoute(currentPathname)) {
              current.selectTab(existing.id)
            }
          } else {
            current.openTab(kind)
          }
        } else if (typeof action === 'string' && action in APPLICATION_MENU_WORK_ROUTES) {
          let route = APPLICATION_MENU_WORK_ROUTES[action]
          if (
            action === APPLICATION_MENU_ACTIONS.openAutomations &&
            currentPathname === '/stand-in'
          ) {
            const query = new URLSearchParams('view=scheduled')
            const currentQuery = new URLSearchParams(window.location.search)
            for (const key of ['profileId', 'deviceId']) {
              const value = currentQuery.get(key)
              if (value) query.set(key, value)
            }
            route = `/stand-in?${query.toString()}`
          }
          navigateTo(route)
        }
      }),
    []
  )

  useEffect(() => {
    const capabilities: ApplicationMenuCapabilityState = {
      [APPLICATION_MENU_CAPABILITIES.taskSurface]: taskSurface,
      [APPLICATION_MENU_CAPABILITIES.canCloseTab]: canCloseTab,
    }
    void reportApplicationMenuCapabilities(capabilities as Record<string, boolean>).catch(error =>
      console.error('[application-menu] failed to update menu', error)
    )
  }, [taskSurface, canCloseTab])

  return null
}
