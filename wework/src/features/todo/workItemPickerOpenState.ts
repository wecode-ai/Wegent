import { useSyncExternalStore } from 'react'

// Picker open state lives outside the component tree so a pane remount
// (workspace-tab transfer, restore churn) re-renders an open picker instead
// of silently closing it. Keyed by binding target so distinct guides do not
// share menus. Module scope keeps this outside React lifecycle by design.
const openKeys = new Set<string>()
const listeners = new Set<() => void>()

function emitChange(): void {
  for (const listener of listeners) listener()
}

export function setWorkItemPickerOpen(key: string, open: boolean): void {
  const had = openKeys.has(key)
  if (had === open) return
  if (open) {
    openKeys.add(key)
  } else {
    openKeys.delete(key)
  }
  emitChange()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useWorkItemPickerOpen(
  key: string | null
): readonly [boolean, (open: boolean) => void] {
  const open = useSyncExternalStore(subscribe, () => key !== null && openKeys.has(key))
  return [
    open,
    next => {
      if (key !== null) setWorkItemPickerOpen(key, next)
    },
  ] as const
}

export function resetWorkItemPickerOpenStateForTests(): void {
  openKeys.clear()
  emitChange()
}
