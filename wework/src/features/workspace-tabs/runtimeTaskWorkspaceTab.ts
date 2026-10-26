import { buildRuntimeTaskRoute } from '@/lib/navigation'
import type { RuntimeTaskAddress } from '@/types/api'
import type { WorkspaceTabsContextValue } from './workspaceTabsContextValue'

export function openRuntimeTaskWorkspaceTab(
  workspaceTabs: WorkspaceTabsContextValue,
  address: RuntimeTaskAddress
): void {
  const contentRoute = buildRuntimeTaskRoute(address)
  const taskTab =
    workspaceTabs.tabs.find(tab => tab.kind === 'task' && tab.contentRoute === contentRoute) ??
    workspaceTabs.tabs.find(tab => tab.kind === 'task')
  if (taskTab) {
    workspaceTabs.selectTab(taskTab.id, { contentRoute })
    return
  }
  workspaceTabs.openTab('task', { contentRoute })
}
