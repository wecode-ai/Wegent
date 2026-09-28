import { useSyncExternalStore } from 'react'
import { LOCAL_WORKSPACE_OPENERS, type LocalWorkspaceOpenerId } from './local-workspace-openers'

const storageKey = 'wework.workspace-opener-preferences'
const changedEvent = 'wework:workspace-opener-preferences-changed'
interface OpenerPreferences {
  global?: LocalWorkspaceOpenerId
  perPath?: Record<string, LocalWorkspaceOpenerId>
}

function readPreferences(): OpenerPreferences {
  try {
    return JSON.parse(localStorage.getItem(storageKey) ?? '{}') ?? {}
  } catch {
    return {}
  }
}

export function getPreferredWorkspaceOpener(path?: string): LocalWorkspaceOpenerId | null {
  const preferences = readPreferences()
  const opener = preferences.perPath?.[path?.trim() ?? ''] ?? preferences.global
  return LOCAL_WORKSPACE_OPENERS.some(candidate => candidate.id === opener) ? opener! : null
}

export function setPreferredWorkspaceOpener(path: string, opener: LocalWorkspaceOpenerId): void {
  const preferences = readPreferences()
  localStorage.setItem(
    storageKey,
    JSON.stringify({
      global: opener,
      perPath: { ...preferences.perPath, [path.trim()]: opener },
    })
  )
  window.dispatchEvent(new Event(changedEvent))
}

export function resolveWorkspaceOpener(
  available: readonly LocalWorkspaceOpenerId[],
  preferred: LocalWorkspaceOpenerId | null
): LocalWorkspaceOpenerId | null {
  return preferred && available.includes(preferred) ? preferred : (available[0] ?? null)
}

function subscribe(listener: () => void): () => void {
  window.addEventListener(changedEvent, listener)
  window.addEventListener('storage', listener)
  return () => {
    window.removeEventListener(changedEvent, listener)
    window.removeEventListener('storage', listener)
  }
}

export function usePreferredWorkspaceOpener(path?: string): LocalWorkspaceOpenerId | null {
  return useSyncExternalStore(
    subscribe,
    () => getPreferredWorkspaceOpener(path),
    () => null
  )
}
