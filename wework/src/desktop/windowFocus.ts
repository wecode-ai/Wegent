import { invokeDesktopHost } from '@/api/dsh/desktopHost'

export const WEWORK_MAIN_WINDOW_FOCUS_CHANGED_EVENT = 'wework-main-window-focus-changed'

const listeners = new Set<(focused: boolean) => void>()
let currentFocused = true
let initialized = false
let focusRevision = 0
let initializationGeneration = 0
let unsubscribeNativeFocus: (() => void) | null = null

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
  const generation = ++initializationGeneration
  publishFocused(document.hasFocus())
  window.addEventListener('focus', handleFocus)
  window.addEventListener('blur', handleBlur)
  const subscribeNativeFocus = window.weworkElectronLifecycle?.onWindowFocusChanged
  if (!subscribeNativeFocus) return
  unsubscribeNativeFocus = subscribeNativeFocus(focused => {
    focusRevision += 1
    publishFocused(focused)
  })
  const revision = focusRevision
  void invokeDesktopHost<{ focused?: boolean }>('window.getState')
    .then(state => {
      if (
        initialized &&
        generation === initializationGeneration &&
        revision === focusRevision &&
        typeof state.focused === 'boolean'
      ) {
        publishFocused(state.focused)
      }
    })
    .catch(() => undefined)
}

function handleFocus() {
  focusRevision += 1
  publishFocused(true)
}

function handleBlur() {
  focusRevision += 1
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
      unsubscribeNativeFocus?.()
      unsubscribeNativeFocus = null
      initialized = false
      initializationGeneration += 1
    }
  }
}
