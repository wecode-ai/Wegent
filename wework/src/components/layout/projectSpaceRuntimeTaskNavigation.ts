import type { WorkspaceTabsContextValue } from '@/features/workspace-tabs/workspaceTabsContextValue'
import { buildRuntimeTaskRoute } from '@/lib/navigation'
import type { RuntimeTaskAddress } from '@/types/api'

export async function openProjectSpaceRuntimeTaskInTab(
  address: RuntimeTaskAddress,
  workspaceTabs: WorkspaceTabsContextValue | null,
  openRuntimeTask: (address: RuntimeTaskAddress) => Promise<void>
) {
  if (workspaceTabs) {
    const contentRoute = buildRuntimeTaskRoute(address)
    const taskTab = workspaceTabs.tabs.find(tab => tab.kind === 'task')
    if (taskTab) {
      workspaceTabs.selectTab(taskTab.id, { contentRoute })
    } else {
      workspaceTabs.openTab('task', { contentRoute })
    }
  }
  await openRuntimeTask(address)
}
