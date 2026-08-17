import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { isTauriRuntime } from '@/lib/runtime-environment'
import { disposeTauriListener } from './disposeTauriListener'

export const WEWORK_SYSTEM_SESSION_LOCK_CHANGED_EVENT = 'wework-system-session-lock-changed'

const listeners = new Set<(locked: boolean) => void>()
let currentLocked = false
let initialized = false
let unlistenPromise: Promise<UnlistenFn> | null = null

function publishLocked(locked: boolean) {
  if (locked === currentLocked) return
  currentLocked = locked
  for (const listener of listeners) {
    listener(locked)
  }
}

function ensureListenerInstalled() {
  if (initialized || !isTauriRuntime()) return

  try {
    if (getCurrentWindow().label !== 'main') return
  } catch {
    return
  }

  initialized = true
  void invoke<boolean>('get_system_session_locked')
    .then(publishLocked)
    .catch(error => console.error('[Wework] Failed to read system session lock state', error))
  unlistenPromise = listen<boolean>(WEWORK_SYSTEM_SESSION_LOCK_CHANGED_EVENT, event => {
    publishLocked(event.payload)
  }).catch(error => {
    initialized = false
    console.error('[Wework] Failed to install system session lock listener', error)
    return () => {}
  })
}

export function isSystemSessionLocked(): boolean {
  return currentLocked
}

export function subscribeSystemSessionLock(callback: (locked: boolean) => void): () => void {
  listeners.add(callback)
  ensureListenerInstalled()
  return () => {
    listeners.delete(callback)
    if (listeners.size === 0 && unlistenPromise) {
      void unlistenPromise.then(unlisten => disposeTauriListener(unlisten, 'system session lock'))
      unlistenPromise = null
      initialized = false
    }
  }
}
