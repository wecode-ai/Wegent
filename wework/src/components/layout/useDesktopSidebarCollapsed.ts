import { useEffect, useState } from 'react'

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'wework.desktop.sidebar.collapsed'
const SIDEBAR_COLLAPSED_EVENT = 'wework:desktop-sidebar-collapsed-change'

function readStoredSidebarCollapsed(): boolean {
  if (typeof window === 'undefined') return false

  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

function storeSidebarCollapsed(collapsed: boolean) {
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed ? 'true' : 'false')
  } catch {
    // Keep the in-memory collapsed state when browser storage is unavailable.
  }

  window.dispatchEvent(
    new CustomEvent(SIDEBAR_COLLAPSED_EVENT, {
      detail: { collapsed },
    })
  )
}

export function useDesktopSidebarCollapsed() {
  const [sidebarCollapsed, setSidebarCollapsedState] = useState(readStoredSidebarCollapsed)

  useEffect(() => {
    const syncCollapsedState = () => setSidebarCollapsedState(readStoredSidebarCollapsed())
    window.addEventListener('storage', syncCollapsedState)
    window.addEventListener(SIDEBAR_COLLAPSED_EVENT, syncCollapsedState)

    return () => {
      window.removeEventListener('storage', syncCollapsedState)
      window.removeEventListener(SIDEBAR_COLLAPSED_EVENT, syncCollapsedState)
    }
  }, [])

  const setSidebarCollapsed = (nextCollapsed: boolean) => {
    setSidebarCollapsedState(nextCollapsed)
    storeSidebarCollapsed(nextCollapsed)
  }

  return {
    sidebarCollapsed,
    setSidebarCollapsed,
  }
}
