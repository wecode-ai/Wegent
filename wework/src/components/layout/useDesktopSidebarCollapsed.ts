import { useEffect, useState } from 'react'

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'wework.desktop.sidebar.collapsed'
const SIDEBAR_COLLAPSED_EVENT = 'wework:desktop-sidebar-collapsed-change'
const SIDEBAR_TOGGLE_REQUEST_EVENT = 'wework:desktop-sidebar-toggle-request'

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

export function requestDesktopSidebarToggle(): boolean {
  if (typeof window === 'undefined') return false

  const event = new Event(SIDEBAR_TOGGLE_REQUEST_EVENT, { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

export function useDesktopSidebarToggleRequest(onToggleSidebar: () => void) {
  useEffect(() => {
    const handleToggleRequest = (event: Event) => {
      event.preventDefault()
      onToggleSidebar()
    }

    window.addEventListener(SIDEBAR_TOGGLE_REQUEST_EVENT, handleToggleRequest)
    return () => window.removeEventListener(SIDEBAR_TOGGLE_REQUEST_EVENT, handleToggleRequest)
  }, [onToggleSidebar])
}
