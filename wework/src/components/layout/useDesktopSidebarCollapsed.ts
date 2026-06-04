import { useState } from 'react'

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'wework.desktop.sidebar.collapsed'

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
    window.localStorage.setItem(
      SIDEBAR_COLLAPSED_STORAGE_KEY,
      collapsed ? 'true' : 'false',
    )
  } catch {
    // Keep the in-memory collapsed state when browser storage is unavailable.
  }
}

export function useDesktopSidebarCollapsed() {
  const [sidebarCollapsed, setSidebarCollapsedState] = useState(
    readStoredSidebarCollapsed,
  )

  const setSidebarCollapsed = (nextCollapsed: boolean) => {
    setSidebarCollapsedState(nextCollapsed)
    storeSidebarCollapsed(nextCollapsed)
  }

  return {
    sidebarCollapsed,
    setSidebarCollapsed,
  }
}
