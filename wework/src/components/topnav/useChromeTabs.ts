import { useCallback, useMemo } from 'react'
import { APP_TABS, DEFAULT_APP_KEY } from '@/config/apps'
import { stripAppBasePath } from '@/config/runtime'
import { navigateTo } from '@/lib/navigation'

export function useChromeTabs(currentPath: string) {
  const normalizedPath = stripAppBasePath(currentPath)

  const activeAppKey = useMemo(() => {
    const match = normalizedPath.match(/^\/app\/([^/]+)/)
    if (match && APP_TABS.some(t => t.key === match[1])) return match[1]

    const nativeMatch = APP_TABS.find(
      tab => tab.mode === 'native' && tab.path && tab.path !== '/' && normalizedPath === tab.path,
    )
    if (nativeMatch) return nativeMatch.key

    return DEFAULT_APP_KEY
  }, [normalizedPath])

  const activeTab = useMemo(
    () => APP_TABS.find(t => t.key === activeAppKey) ?? null,
    [activeAppKey],
  )

  const isNativeApp = activeTab?.mode === 'native'

  const navigateToApp = useCallback((appKey: string) => {
    const tab = APP_TABS.find(item => item.key === appKey)
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
    tabs: APP_TABS.filter(tab => !tab.hidden),
  }
}
