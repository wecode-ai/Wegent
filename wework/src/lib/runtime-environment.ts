import { isTauri as isTauriApiRuntime } from '@tauri-apps/api/core'

function hasTauriGlobal(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  )
}

export function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') {
    return false
  }

  return isTauriApiRuntime() || hasTauriGlobal()
}
