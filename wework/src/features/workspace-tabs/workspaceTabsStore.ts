import type { WorkspaceTab } from './workspaceTabs'
import { synchronizeHarnessAppTabs } from '@/features/harness-apps/synchronizeHarnessAppTabs'

/** A provider session owns its window's tab transitions independently of React visibility. */
export function createWorkspaceTabsStore<State extends { tabs: WorkspaceTab[] }, Action>(
  initialState: State,
  reducer: (state: State, action: Action) => State,
  onChange?: (state: State) => void
) {
  let state = initialState
  const listeners = new Set<() => void>()
  const replaceState = (next: State) => {
    const previous = state
    if (next === previous) return
    state = next
    synchronizeHarnessAppTabs(previous.tabs, next.tabs)
    onChange?.(next)
    listeners.forEach(listener => listener())
  }
  return {
    getSnapshot: () => state,
    isObserved: () => listeners.size > 0,
    replaceState,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispatch: (action: Action) => replaceState(reducer(state, action)),
  }
}
