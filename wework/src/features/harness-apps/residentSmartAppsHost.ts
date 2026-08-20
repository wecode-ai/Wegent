interface ResidentSmartAppsHostTab {
  id: string
  contentRoute: string
}

export function findResidentSmartAppsHostTabId(
  tabs: ResidentSmartAppsHostTab[]
): string | undefined {
  return tabs.find(tab => {
    const path = stripAppBasePath(new URL(tab.contentRoute, window.location.origin).pathname)
    return !path.startsWith('/app/')
  })?.id
}
import { stripAppBasePath } from '@/config/runtime'
