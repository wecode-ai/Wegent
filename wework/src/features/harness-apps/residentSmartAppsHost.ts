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
import { stripAppBasePath } from '@/config/runtime'
