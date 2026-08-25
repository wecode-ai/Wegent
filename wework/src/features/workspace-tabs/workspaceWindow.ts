import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { toBrowserPath } from '@/lib/navigation'
import {
  persistWorkspaceTabs,
  workspaceTabRoute,
  workspaceTabsStorageKey,
  type WorkspaceTab,
} from './workspaceTabs'
import { clearStagedWorkspaceTabTransfer, stageWorkspaceTabTransfer } from './workspaceTabTransfer'

function endActiveEditingSession(): void {
  const activeElement = document.activeElement
  if (activeElement instanceof HTMLElement) activeElement.blur()
}

export async function openWorkspaceTabWindow(tab: WorkspaceTab): Promise<boolean> {
  const route = toBrowserPath(workspaceTabRoute(tab))
  const label = `workspace-${tab.id}-${Date.now()}`
  endActiveEditingSession()
  persistWorkspaceTabs(label, [tab], tab.id)
  stageWorkspaceTabTransfer(tab.id)
  try {
    await invokeDesktopHost('window.openWorkspace', { label, route, title: tab.title })
    return true
  } catch (error) {
    localStorage.removeItem(workspaceTabsStorageKey(label))
    clearStagedWorkspaceTabTransfer(tab.id)
    throw error
  }
}
