import { useState } from 'react'

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'wework.desktop.sidebar.collapsed'

function readStoredSidebarCollapsed(): boolean {
  if (typeof window === 'undefined') return false

  return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true'
}

function storeSidebarCollapsed(collapsed: boolean) {
  window.localStorage.setItem(
    SIDEBAR_COLLAPSED_STORAGE_KEY,
    collapsed ? 'true' : 'false',
  )
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
