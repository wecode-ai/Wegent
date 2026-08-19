import { useCallback, useMemo } from 'react'
import { stripAppBasePath } from '@/config/runtime'
import { navigateTo } from '@/lib/navigation'
import {
  getActiveWorkbenchAppRegistry,
  type WorkbenchAppContribution,
  useActiveWorkbenchApps,
} from '@/plugin-runtime/apps'
import { CORE_WORKBENCH_APPS } from '@/plugin-runtime/core-apps-data'

const DEFAULT_APP_KEY = 'wework'

export function useChromeTabs(currentPath: string) {
  const normalizedPath = stripAppBasePath(currentPath)
  const registeredTabs = useActiveWorkbenchApps()
  const tabs: readonly WorkbenchAppContribution[] =
    registeredTabs.length > 0 ? registeredTabs : CORE_WORKBENCH_APPS

  const activeAppKey = useMemo(() => {
    const match = normalizedPath.match(/^\/app\/([^/]+)/)
    if (match && tabs.some(t => t.key === match[1])) return match[1]

    const nativeMatch = tabs.find(
      tab => tab.mode === 'native' && tab.path && tab.path !== '/' && normalizedPath === tab.path
    )
    if (nativeMatch) return nativeMatch.key

    return DEFAULT_APP_KEY
  }, [normalizedPath, tabs])

  const activeTab = useMemo(
    () => tabs.find(t => t.key === activeAppKey) ?? null,
    [activeAppKey, tabs]
  )

  const isNativeApp = activeTab?.mode === 'native'

  const navigateToApp = useCallback((appKey: string) => {
    const tab = getActiveWorkbenchAppRegistry().resolve(appKey)
    if (!tab) return

    if (tab.mode === 'native') {
      navigateTo(tab.path || '/')
    } else {
      navigateTo(`/app/${appKey}`)
    }
  }, [])

  return {
    activeAppKey,
    activeTab,
    isNativeApp,
    navigateToApp,
    tabs: tabs.filter(tab => !tab.hidden),
  }
}
