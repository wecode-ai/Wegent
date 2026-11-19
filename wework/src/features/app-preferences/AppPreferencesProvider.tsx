import { useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { AppPreferencesContext } from './appPreferencesContext'
import { createAppPreferencesStore } from './appPreferencesStore'

export function AppPreferencesProvider({ children }: { children: ReactNode }) {
  const store = useMemo(() => createAppPreferencesStore(true), [])
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  return <AppPreferencesContext.Provider value={state}>{children}</AppPreferencesContext.Provider>
}
