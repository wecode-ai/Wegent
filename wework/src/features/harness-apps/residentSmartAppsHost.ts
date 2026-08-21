import { stripAppBasePath } from '@/config/runtime'

interface ResidentSmartAppsHostTab {
  id: string
  contentRoute: string
}

export function findResidentSmartAppsHostTabId(
  tabs: ResidentSmartAppsHostTab[],
  preferredTabId?: string
): string | undefined {
  const isProviderBacked = (tab: ResidentSmartAppsHostTab) => {
    const path = stripAppBasePath(new URL(tab.contentRoute, window.location.origin).pathname)
    return !path.startsWith('/app/')
  }
  const preferredTab = tabs.find(tab => tab.id === preferredTabId)
  if (preferredTab && isProviderBacked(preferredTab)) return preferredTab.id
  return tabs.find(isProviderBacked)?.id
}

export function retainResidentSmartAppsHostTabId(
  tabs: ResidentSmartAppsHostTab[],
  currentHostTabId: string | undefined,
  preferredTabId?: string
): string | undefined {
  if (
    currentHostTabId &&
    findResidentSmartAppsHostTabId(tabs, currentHostTabId) === currentHostTabId
  ) {
    return currentHostTabId
  }
  return findResidentSmartAppsHostTabId(tabs, preferredTabId)
}
