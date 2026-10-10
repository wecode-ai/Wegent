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

export async function openWorkspaceTabWindow(
  tab: WorkspaceTab,
  options: { label?: string; transferState?: boolean } = {}
): Promise<boolean> {
  const route = toBrowserPath(workspaceTabRoute(tab))
  const label = options.label ?? `workspace-${tab.id}-${Date.now()}`
  endActiveEditingSession()
  persistWorkspaceTabs(label, [tab], tab.id)
  if (options.transferState !== false) stageWorkspaceTabTransfer(tab.id)
  try {
    await invokeDesktopHost('window.openWorkspace', { label, route, title: tab.title })
    return true
  } catch (error) {
    localStorage.removeItem(workspaceTabsStorageKey(label))
    if (options.transferState !== false) clearStagedWorkspaceTabTransfer(tab.id)
    throw error
  }
}
