import { getArchivedCleanupError } from '@/components/settings/archivedConversationsSettingsState'
import type { ProjectWithTasks, RuntimeIMNotificationSettingsResponse } from '@/types/api'
import { isSettingsRoute } from '@/lib/navigation'
import {
  type StandaloneRemoteDialogIntent,
  type StandaloneWorkspaceDialogMode,
} from '@/components/projects/StandaloneProjectDialogs'
import { type ProjectCreateRequestOptions } from './workbenchShellEvents'
import type { LocalHarnessWorkbenchSession } from './localHarnessWorkbench'
import type { SetStateAction } from 'react'
export const SIDEBAR_AUTO_COLLAPSE_WINDOW_WIDTH = 960
export interface DesktopLayoutSnapshot {
  archivedCleanupError: string | null
  currentPath: string
  taskView: 'workbench' | 'default-work-items'
  localHarnessSessions: LocalHarnessWorkbenchSession[]
  activeLocalHarnessSessionId: string | null
  sidebarAutoCollapsed: boolean
  sidebarPreviewOpen: boolean
  sidebarResizing: boolean
  settingsOpen: boolean
  autoOpenAddCloudDeviceDialog: boolean
  blankProjectDialogOpen: boolean
  standaloneWorkspaceDialogMode: StandaloneWorkspaceDialogMode | null
  standaloneRemoteDialogIntent: StandaloneRemoteDialogIntent
  standalonePreferNativeLocalPicker: boolean
  projectWorkEditProject: ProjectWithTasks | null
  searchOpen: boolean
  imNotificationSettings: RuntimeIMNotificationSettingsResponse | null
  notice: {
    message: string
    tone: 'success' | 'error'
  } | null
  projectCreateRequest: ProjectCreateRequestOptions | null
}
export function createDesktopLayoutState(initialPath: string) {
  let alive = true
  let harnessRevision = 0
  let snapshot: DesktopLayoutSnapshot = {
    archivedCleanupError: getArchivedCleanupError(),
    currentPath: initialPath,
    taskView: 'workbench',
    localHarnessSessions: [],
    activeLocalHarnessSessionId: null,
    sidebarAutoCollapsed: window.innerWidth <= SIDEBAR_AUTO_COLLAPSE_WINDOW_WIDTH,
    sidebarPreviewOpen: false,
    sidebarResizing: false,
    settingsOpen: isSettingsRoute(initialPath),
    autoOpenAddCloudDeviceDialog: false,
    blankProjectDialogOpen: false,
    standaloneWorkspaceDialogMode: null,
    standaloneRemoteDialogIntent: 'project',
    standalonePreferNativeLocalPicker: true,
    projectWorkEditProject: null,
    searchOpen: false,
    imNotificationSettings: null,
    notice: null,
    projectCreateRequest: null,
  }
  const listeners = new Set<() => void>()
  function update<K extends keyof DesktopLayoutSnapshot>(
    key: K,
    value: SetStateAction<DesktopLayoutSnapshot[K]>
  ) {
    if (!alive) return
    const next = typeof value === 'function' ? value(snapshot[key]) : value
    if (next === snapshot[key]) return
    snapshot = { ...snapshot, [key]: next }
    for (const listener of listeners) listener()
  }
  return {
    getHarnessRevision: () => harnessRevision,
    replaceRestoredHarnessSessions: (value: DesktopLayoutSnapshot['localHarnessSessions']) =>
      update('localHarnessSessions', value),
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    activate() {
      alive = true
    },
    retire() {
      alive = false
    },
    setArchivedCleanupError: (value: SetStateAction<string | null>) =>
      update('archivedCleanupError', value),
    setCurrentPath: (value: SetStateAction<DesktopLayoutSnapshot['currentPath']>) =>
      update('currentPath', value),
    setTaskView: (value: SetStateAction<DesktopLayoutSnapshot['taskView']>) =>
      update('taskView', value),
    setLocalHarnessSessions: (
      value: SetStateAction<DesktopLayoutSnapshot['localHarnessSessions']>
    ) => {
      harnessRevision += 1
      update('localHarnessSessions', value)
    },
    setActiveLocalHarnessSessionId: (
      value: SetStateAction<DesktopLayoutSnapshot['activeLocalHarnessSessionId']>
    ) => update('activeLocalHarnessSessionId', value),
    setSidebarAutoCollapsed: (
      value: SetStateAction<DesktopLayoutSnapshot['sidebarAutoCollapsed']>
    ) => update('sidebarAutoCollapsed', value),
    setSidebarPreviewOpen: (value: SetStateAction<DesktopLayoutSnapshot['sidebarPreviewOpen']>) =>
      update('sidebarPreviewOpen', value),
    setSidebarResizing: (value: SetStateAction<DesktopLayoutSnapshot['sidebarResizing']>) =>
      update('sidebarResizing', value),
    setSettingsOpen: (value: SetStateAction<DesktopLayoutSnapshot['settingsOpen']>) =>
      update('settingsOpen', value),
    setAutoOpenAddCloudDeviceDialog: (
      value: SetStateAction<DesktopLayoutSnapshot['autoOpenAddCloudDeviceDialog']>
    ) => update('autoOpenAddCloudDeviceDialog', value),
    setBlankProjectDialogOpen: (
      value: SetStateAction<DesktopLayoutSnapshot['blankProjectDialogOpen']>
    ) => update('blankProjectDialogOpen', value),
    setStandaloneWorkspaceDialogMode: (
      value: SetStateAction<DesktopLayoutSnapshot['standaloneWorkspaceDialogMode']>
    ) => update('standaloneWorkspaceDialogMode', value),
    setStandaloneRemoteDialogIntent: (
      value: SetStateAction<DesktopLayoutSnapshot['standaloneRemoteDialogIntent']>
    ) => update('standaloneRemoteDialogIntent', value),
    setStandalonePreferNativeLocalPicker: (
      value: SetStateAction<DesktopLayoutSnapshot['standalonePreferNativeLocalPicker']>
    ) => update('standalonePreferNativeLocalPicker', value),
    setProjectWorkEditProject: (
      value: SetStateAction<DesktopLayoutSnapshot['projectWorkEditProject']>
    ) => update('projectWorkEditProject', value),
    setSearchOpen: (value: SetStateAction<DesktopLayoutSnapshot['searchOpen']>) =>
      update('searchOpen', value),
    setImNotificationSettings: (
      value: SetStateAction<DesktopLayoutSnapshot['imNotificationSettings']>
    ) => update('imNotificationSettings', value),
    setNotice: (value: SetStateAction<DesktopLayoutSnapshot['notice']>) => update('notice', value),
    setProjectCreateRequest: (value: ProjectCreateRequestOptions | null) =>
      update('projectCreateRequest', value),
  }
}
export type DesktopLayoutState = ReturnType<typeof createDesktopLayoutState>
