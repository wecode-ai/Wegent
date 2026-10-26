import type { WorkspaceTabsContextValue } from '@/features/workspace-tabs/workspaceTabsContextValue'
import { openRuntimeTaskWorkspaceTab } from '@/features/workspace-tabs/runtimeTaskWorkspaceTab'
import type { RuntimeTaskAddress } from '@/types/api'

export async function openProjectSpaceRuntimeTaskInTab(
  address: RuntimeTaskAddress,
  workspaceTabs: WorkspaceTabsContextValue | null,
  openRuntimeTask: (address: RuntimeTaskAddress) => Promise<void>
) {
  if (workspaceTabs) {
    openRuntimeTaskWorkspaceTab(workspaceTabs, address)
  }
  await openRuntimeTask(address)
}
