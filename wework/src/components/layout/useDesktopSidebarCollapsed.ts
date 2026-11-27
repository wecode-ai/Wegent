import { useSyncExternalStore } from 'react'
import { useDOMEvent } from '@wegent/collaboration/dom-events'

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

let snapshot = false
const listeners = new Set<() => void>()
const publish = (value: boolean) => {
  snapshot = value
  listeners.forEach(listener => listener())
}
const readSnapshot = () => (listeners.size ? snapshot : readStoredSidebarCollapsed())
const handleStorage = () => publish(readStoredSidebarCollapsed())
const handleChange = (event: Event) => {
  const collapsed = (event as CustomEvent<{ collapsed?: boolean }>).detail?.collapsed
  publish(typeof collapsed === 'boolean' ? collapsed : readStoredSidebarCollapsed())
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  if (listeners.size === 1) {
    snapshot = readStoredSidebarCollapsed()
    window.addEventListener('storage', handleStorage)
    window.addEventListener(SIDEBAR_COLLAPSED_EVENT, handleChange)
  }
  return () => {
    listeners.delete(listener)
    if (!listeners.size) {
      window.removeEventListener('storage', handleStorage)
      window.removeEventListener(SIDEBAR_COLLAPSED_EVENT, handleChange)
    }
  }
}

export function useDesktopSidebarCollapsed() {
  const sidebarCollapsed = useSyncExternalStore(subscribe, readSnapshot, () => false)
  return { sidebarCollapsed, setSidebarCollapsed: storeSidebarCollapsed }
}

export function requestDesktopSidebarToggle(): boolean {
  if (typeof window === 'undefined') return false

  const event = new Event(SIDEBAR_TOGGLE_REQUEST_EVENT, { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

export function useDesktopSidebarToggleRequest(onToggleSidebar: () => void) {
  useDOMEvent('window', SIDEBAR_TOGGLE_REQUEST_EVENT, event => {
    event.preventDefault()
    onToggleSidebar()
  })
}
