import { useSyncExternalStore } from 'react'
import { ACTIVE_KEYBINDINGS_CHANGED_EVENT, getActiveKeybinding } from '@/lib/keybindings'

function subscribe(listener: () => void): () => void {
  window.addEventListener(ACTIVE_KEYBINDINGS_CHANGED_EVENT, listener)
  return () => window.removeEventListener(ACTIVE_KEYBINDINGS_CHANGED_EVENT, listener)
}

export function useConfiguredKeybinding(command: string): string | null {
  return useSyncExternalStore(subscribe, () => getActiveKeybinding(command))
}
