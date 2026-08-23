import { isTauri as isTauriApiRuntime } from '@tauri-apps/api/core'
import { getRuntimeConfig } from '@/config/runtime'

function hasTauriGlobal(): boolean {
  return typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
}

export function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') {
    return false
  }

  return isTauriApiRuntime() || hasTauriGlobal()
}

export function isElectronRuntime(): boolean {
  return typeof window !== 'undefined' && getRuntimeConfig().desktopHost === 'electron'
}

export function isDesktopRuntime(): boolean {
  return isTauriRuntime() || isElectronRuntime()
}

export function getDesktopWindowLabel(): string {
  if (isElectronRuntime()) return getRuntimeConfig().desktopWindowLabel
  return 'main'
}
