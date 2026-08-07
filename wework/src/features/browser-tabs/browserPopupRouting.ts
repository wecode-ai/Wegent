import type {
  RightWorkspaceBrowserState,
  RightWorkspaceBrowserTab,
} from '@/components/layout/workspace-panels/RightWorkspacePanel'

export function findBrowserTabByPopupParent(
  states: Partial<Record<RightWorkspaceBrowserTab, RightWorkspaceBrowserState>>,
  parentLabel?: string | null,
  parentNativeLabel?: string | null
): RightWorkspaceBrowserTab | null {
  if (parentLabel) {
    const logicalEntry = Object.entries(states).find(([, state]) => state?.label === parentLabel)
    if (logicalEntry) return logicalEntry[0] as RightWorkspaceBrowserTab
  }
  if (!parentNativeLabel) return null
  const nativeEntry = Object.entries(states).find(
    ([, state]) => state?.nativeLabel === parentNativeLabel
  )
  return nativeEntry ? (nativeEntry[0] as RightWorkspaceBrowserTab) : null
}
