import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { isTauriRuntime } from '@/lib/runtime-environment'
import { disposeTauriListener } from './disposeTauriListener'

export const WEWORK_MAIN_WINDOW_FOCUS_CHANGED_EVENT = 'wework-main-window-focus-changed'

const listeners = new Set<(focused: boolean) => void>()
let currentFocused = true
let initialized = false
let unlistenPromise: Promise<UnlistenFn> | null = null

function publishFocused(focused: boolean) {
  if (focused === currentFocused) return
  currentFocused = focused
  for (const listener of listeners) {
    listener(focused)
  }
}

function ensureListenerInstalled() {
  if (initialized || !isTauriRuntime()) {
    return
  }
  let currentWindow: ReturnType<typeof getCurrentWindow>
  try {
    currentWindow = getCurrentWindow()
  } catch {
    return
  }
  if (currentWindow.label !== 'main') {
    return
  }
  initialized = true
  void currentWindow
    .isFocused()
    .then(publishFocused)
    .catch(error => console.error('[Wework] Failed to read main window focus', error))
  unlistenPromise = listen<boolean>(WEWORK_MAIN_WINDOW_FOCUS_CHANGED_EVENT, event => {
    publishFocused(event.payload)
  }).catch(error => {
    initialized = false
    console.error('[Wework] Failed to install window focus listener', error)
    return () => {}
  })
}

export function isMainWindowFocused(): boolean {
  return currentFocused
}

export function subscribeMainWindowFocus(callback: (focused: boolean) => void): () => void {
  listeners.add(callback)
  ensureListenerInstalled()
  return () => {
    listeners.delete(callback)
    if (listeners.size === 0 && unlistenPromise) {
      void unlistenPromise.then(unlisten => disposeTauriListener(unlisten, 'window focus'))
      unlistenPromise = null
      initialized = false
    }
  }
}
