import {
  attachRightWorkspaceSidebarController,
  isRightWorkspaceExtensionTab,
  type WeworkWorkspaceScope,
  type WeworkWorkspaceSidebarOpenTabSeed,
} from './workspace-panels/rightWorkspaceDshSidebar'
import type { RightWorkspacePanelTab } from './workspace-panels/RightWorkspacePanel'
import type { DesktopPaneWorkspaceState } from './desktopPaneWorkspaceState'

export interface DesktopPaneSidebarInput {
  active: boolean
  scope: WeworkWorkspaceScope
  openExtensionTab(seed: WeworkWorkspaceSidebarOpenTabSeed): void
  openTab(tab: RightWorkspacePanelTab): void
  closeTab(tab: RightWorkspacePanelTab): void
}
/** The extension controller reads and changes the actual right-panel state. */
export function createDesktopPaneSidebarService(state: DesktopPaneWorkspaceState) {
  let input: DesktopPaneSidebarInput | null = null
  let detach: (() => void) | null = null
  const find = (id: string) =>
    Object.values(state.getSnapshot().rightPanelExtensionTabs).find(row => row?.tab.id === id)
  return {
    reconcile(next: DesktopPaneSidebarInput) {
      input = next
      if (detach) return
      detach = attachRightWorkspaceSidebarController({
        active: () => Boolean(input?.active),
        openTab: seed => input?.openExtensionTab(seed),
        closeTab: id => {
          const row = find(id)
          if (row) input?.closeTab(row.internalId)
        },
        activateTab: id => {
          const row = find(id)
          if (row) input?.openTab(row.internalId)
        },
        updateTab: (id, patch) =>
          state.setRightPanelExtensionTabs(current => {
            const row = Object.values(current).find(candidate => candidate?.tab.id === id)
            return row
              ? { ...current, [row.internalId]: { ...row, tab: { ...row.tab, ...patch } } }
              : current
          }),
        snapshot: () => {
          const current = state.getSnapshot()
          return {
            sessionId: input?.scope.sessionId,
            state: {
              panelOpen: current.rightPanelOpen,
              tabs: Object.values(current.rightPanelExtensionTabs).flatMap(row =>
                row ? [row.tab] : []
              ),
              activeTabId: isRightWorkspaceExtensionTab(current.rightPanelView)
                ? (current.rightPanelExtensionTabs[current.rightPanelView]?.tab.id ?? null)
                : null,
            },
          }
        },
        subscribe: state.subscribe,
      })
    },
    suspend() {
      detach?.()
      detach = null
      input = null
    },
  }
}
