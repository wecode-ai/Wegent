interface SidebarPreferences {
  projectsExpanded: boolean
  chatsExpanded: boolean
  priorityShowPinned: boolean
  showOfflineDeviceItems: boolean
  expandedProjectIds: Set<number>
}

type Change<T> = T | ((current: T) => T)

function storageKey(scope: string, field: keyof SidebarPreferences) {
  return `wework.desktop.sidebar.${field}.${scope}`
}

function readBoolean(scope: string, field: keyof SidebarPreferences, fallback: boolean) {
  try {
    const value = window.localStorage.getItem(storageKey(scope, field))
    return value === null ? fallback : value === 'true'
  } catch {
    return fallback
  }
}

function readExpandedProjects(scope: string): Set<number> {
  try {
    const value = window.localStorage.getItem(storageKey(scope, 'expandedProjectIds'))
    if (!value) return new Set()
    const parsed = JSON.parse(value)
    return Array.isArray(parsed)
      ? new Set(parsed.filter((item): item is number => Number.isInteger(item) && item > 0))
      : new Set()
  } catch {
    return new Set()
  }
}

/** The account's actual sidebar choices are persisted by the commands that change them. */
export function createDesktopSidebarPreferences(scope: string) {
  let snapshot: SidebarPreferences = {
    projectsExpanded: readBoolean(scope, 'projectsExpanded', true),
    chatsExpanded: readBoolean(scope, 'chatsExpanded', true),
    priorityShowPinned: readBoolean(scope, 'priorityShowPinned', false),
    showOfflineDeviceItems: readBoolean(scope, 'showOfflineDeviceItems', true),
    expandedProjectIds: readExpandedProjects(scope),
  }
  const listeners = new Set<() => void>()
  const selectionListeners = new Set<() => void>()
  let selection: { projectId: number | null; key: string | null } = { projectId: null, key: null }
  let lastExpandedKey: string | null = null
  const change = <K extends keyof SidebarPreferences>(
    field: K,
    update: Change<SidebarPreferences[K]>
  ) => {
    const value = typeof update === 'function' ? update(snapshot[field]) : update
    if (Object.is(value, snapshot[field])) return
    snapshot = { ...snapshot, [field]: value }
    try {
      window.localStorage.setItem(
        storageKey(scope, field),
        value instanceof Set ? JSON.stringify([...value].sort((a, b) => a - b)) : String(value)
      )
    } catch {
      // Storage failure does not prevent changing the in-memory sidebar.
    }
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot: () => snapshot,
    getSelectionSnapshot: () => selection,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    subscribeSelection(
      listener: () => void,
      projectId: number | null,
      key: string | null,
      pinned: { taskPinned: boolean; projectPinned: boolean }
    ) {
      selectionListeners.add(listener)
      if (selection.projectId !== projectId || selection.key !== key) {
        selection = { projectId, key }
        if (projectId !== null && key && key !== lastExpandedKey) {
          lastExpandedKey = key
          if (!pinned.taskPinned) {
            if (!pinned.projectPinned) change('projectsExpanded', true)
            change('expandedProjectIds', current =>
              current.has(projectId) ? current : new Set([...current, projectId])
            )
          }
        }
        for (const observer of selectionListeners) observer()
      }
      return () => {
        selectionListeners.delete(listener)
      }
    },
    setProjectsExpanded: (value: Change<boolean>) => change('projectsExpanded', value),
    setChatsExpanded: (value: Change<boolean>) => change('chatsExpanded', value),
    setPriorityShowPinned: (value: Change<boolean>) => change('priorityShowPinned', value),
    setShowOfflineDeviceItems: (value: Change<boolean>) => change('showOfflineDeviceItems', value),
    setExpandedProjectIds: (value: Change<Set<number>>) => change('expandedProjectIds', value),
  }
}
