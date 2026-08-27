import { useCallback, useMemo } from 'react'
import { stripAppBasePath } from '@/config/runtime'
import { getDshApps, resolveDshApp, type WeworkDshApp } from '@/features/dsh-runtime/dshApps'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import { useDshSlotEntries } from '@/features/dsh-runtime/useDshSlotEntries'
import { navigateTo } from '@/lib/navigation'

const DEFAULT_APP_KEY = 'wework'

export function useChromeTabs(currentPath: string) {
  const normalizedPath = stripAppBasePath(currentPath)
  const tabs = useDshSlotEntries<WeworkDshApp>(WEWORK_DSH_SLOTS.app)

  const activeAppKey = useMemo(() => {
    const match = normalizedPath.match(/^\/app\/([^/]+)/)
    if (match && tabs.some(tab => tab.id === match[1])) return match[1]

    const nativeMatch = tabs.find(
      tab => tab.mode === 'native' && tab.path && tab.path !== '/' && normalizedPath === tab.path
    )
    if (nativeMatch) return nativeMatch.id

    return DEFAULT_APP_KEY
  }, [normalizedPath, tabs])

  const activeTab = useMemo(
    () => tabs.find(tab => tab.id === activeAppKey) ?? null,
    [activeAppKey, tabs]
  )

  const isNativeApp = activeTab?.mode === 'native'

  const navigateToApp = useCallback((appKey: string) => {
    const tab = resolveDshApp(appKey)
    if (!tab) return

    if (tab.mode === 'native') {
      navigateTo(tab.path || '/')
    } else {
      navigateTo(`/app/${encodeURIComponent(appKey)}`)
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

export function getChromeTabsSnapshot(): readonly WeworkDshApp[] {
  return getDshApps()
}
