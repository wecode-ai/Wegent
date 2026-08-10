import type {
  RightWorkspaceBrowserState,
  RightWorkspaceBrowserTab,
} from '@/components/layout/workspace-panels/RightWorkspacePanel'

const EMBEDDED_BROWSER_POPUP_DEDUP_WINDOW_MS = 500

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

export function isDuplicateBrowserPopupRequest(
  recentRequests: Map<string, number>,
  parentTab: RightWorkspaceBrowserTab,
  url: string,
  now = Date.now()
): boolean {
  const key = `${parentTab}\u0000${url}`
  const lastSeenAt = recentRequests.get(key)
  if (lastSeenAt !== undefined && now - lastSeenAt < EMBEDDED_BROWSER_POPUP_DEDUP_WINDOW_MS) {
    return true
  }

  recentRequests.set(key, now)
  for (const [seenKey, seenAt] of recentRequests) {
    if (now - seenAt >= EMBEDDED_BROWSER_POPUP_DEDUP_WINDOW_MS) {
      recentRequests.delete(seenKey)
    }
  }

  return false
}
