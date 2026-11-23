import { subscribeDesktopHostEvents, type DesktopHostEvent } from '@/api/dsh/desktopHost'
import type { WorkspaceTabsContextValue } from '@/features/workspace-tabs/workspaceTabsContextValue'
import { getDesktopWindowLabel } from '@/lib/runtime-environment'
import { isSettingsRoute, navigateTo } from '@/lib/navigation'
import { APPLICATION_MENU_WORK_ROUTES, reportApplicationMenuCapabilities } from './applicationMenu'
import {
  APPLICATION_MENU_ACTIONS,
  APPLICATION_MENU_CAPABILITIES,
  type ApplicationMenuCapabilityState,
} from './applicationMenuModel'

// Retain consumption across bridge remounts, including StrictMode's effect replay.
let lastWorkspaceMenuSequence = 0

function isPendingWorkspaceMenuEvent(event: DesktopHostEvent): boolean {
  return (
    event.type === 'application-menu.action' &&
    event.payload.windowLabel === getDesktopWindowLabel() &&
    event.sequence > lastWorkspaceMenuSequence
  )
}

export interface WorkspaceMenuInput {
  tabs: WorkspaceTabsContextValue
  pathname: string
}

/** The committed route owner keeps one host subscription across tab changes. */
export function createWorkspaceMenuService() {
  let input: WorkspaceMenuInput | null = null
  let unsubscribe: (() => void) | undefined
  let capabilitiesKey = ''
  return {
    observe(next: WorkspaceMenuInput) {
      input = next
      if (!unsubscribe)
        unsubscribe = subscribeDesktopHostEvents(
          event => {
            if (!isPendingWorkspaceMenuEvent(event)) return
            lastWorkspaceMenuSequence = event.sequence
            if (!input) return
            const { tabs: current, pathname: currentPathname } = input
            const action = event.payload.action
            console.debug('[application-menu] workspace action', {
              action,
              sequence: event.sequence,
              pathname: currentPathname,
            })
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
              const route = APPLICATION_MENU_WORK_ROUTES[action]
              navigateTo(route)
            }
          },
          { replay: isPendingWorkspaceMenuEvent }
        )
      const { tabs, pathname } = next
      const capabilities: ApplicationMenuCapabilityState = {
        [APPLICATION_MENU_CAPABILITIES.taskSurface]:
          !isSettingsRoute(pathname) &&
          (tabs.activeTab.kind === 'task' || tabs.activeTab.kind === 'board'),
        [APPLICATION_MENU_CAPABILITIES.canCloseTab]: !tabs.activeTab.fixed,
      }
      const nextKey = JSON.stringify(capabilities)
      if (nextKey === capabilitiesKey) return
      capabilitiesKey = nextKey
      void reportApplicationMenuCapabilities(capabilities as Record<string, boolean>).catch(error =>
        console.error('[application-menu] failed to update menu', error)
      )
    },
    disconnect() {
      input = null
      unsubscribe?.()
      unsubscribe = undefined
      capabilitiesKey = ''
    },
  }
}
