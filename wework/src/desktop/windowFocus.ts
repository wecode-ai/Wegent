export const WEWORK_MAIN_WINDOW_FOCUS_CHANGED_EVENT = 'wework-main-window-focus-changed'

const listeners = new Set<(focused: boolean) => void>()
let currentFocused = true
let initialized = false

function publishFocused(focused: boolean) {
  if (focused === currentFocused) return
  currentFocused = focused
  for (const listener of listeners) {
    listener(focused)
  }
}

function ensureListenerInstalled() {
  if (initialized) return
  initialized = true
  publishFocused(document.hasFocus())
  window.addEventListener('focus', handleFocus)
  window.addEventListener('blur', handleBlur)
}

function handleFocus() {
  publishFocused(true)
}

function handleBlur() {
  publishFocused(false)
}

export function isMainWindowFocused(): boolean {
  return currentFocused
}

export function subscribeMainWindowFocus(callback: (focused: boolean) => void): () => void {
  listeners.add(callback)
  ensureListenerInstalled()
  return () => {
    listeners.delete(callback)
    if (listeners.size === 0 && initialized) {
      window.removeEventListener('focus', handleFocus)
      window.removeEventListener('blur', handleBlur)
      initialized = false
    }
  }
}
