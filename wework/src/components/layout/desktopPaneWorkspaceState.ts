import { isMcpAppPanelTab } from '@/features/mcp-apps/workspacePanels'
import {
  normalizeRightWorkspacePanelView,
  normalizeRightWorkspacePanelTab,
} from './desktopWorkbenchMainHelpers'
import { type WorkspaceFileTabs } from './workspace-panels/workspaceFileTabs'
import {
  type RightWorkspaceBrowserState,
  type RightWorkspaceBrowserTab,
  type RightWorkspaceChatTab,
  type RightWorkspacePanelTab,
  type RightWorkspacePanelView,
} from './workspace-panels/RightWorkspacePanel'
import {
  type RightWorkspaceExtensionTab,
  type RightWorkspaceExtensionTabState,
} from './workspace-panels/rightWorkspaceDshSidebar'
import { type DesktopReviewState } from './desktopWorkbenchPaneTypes'
import type { RuntimeTaskAddress } from '@/types/api'
import {
  type SelectedAssistantPlan,
  type SubagentTranscriptState,
  type WorkbenchPaneWorkspaceState,
} from './desktopWorkbenchMainHelpers'
import type { SetStateAction } from 'react'
export interface DesktopPaneWorkspaceSnapshot {
  centralHarnessStarting: boolean
  centralHarnessError: string | null
  rightPanelOpen: boolean
  rightPanelExpanded: boolean
  rightPanelView: RightWorkspacePanelView
  rightPanelTabs: RightWorkspacePanelTab[]
  selectedAssistantPlan: SelectedAssistantPlan | null
  selectedSubagentConversationId: string | null
  subagentTranscripts: Record<string, SubagentTranscriptState>
  rightPanelExtensionTabs: Partial<
    Record<RightWorkspaceExtensionTab, RightWorkspaceExtensionTabState>
  >
  temporaryChatAddresses: Partial<Record<RightWorkspaceChatTab, RuntimeTaskAddress>>
  selectedFileWorkspaceTargetKey: string | null
  selectedWorkspaceFile: WorkbenchPaneWorkspaceState['selectedWorkspaceFile']
  fileTabs: WorkspaceFileTabs
  reviewState: DesktopReviewState
  fileWorkspaceDirty: boolean
  browserStates: Partial<Record<RightWorkspaceBrowserTab, RightWorkspaceBrowserState>>
}
export function createDesktopPaneWorkspaceState(initial: DesktopPaneWorkspaceSnapshot) {
  let snapshot = initial
  let alive = true
  const listeners = new Set<() => void>()
  const publish = () => {
    for (const listener of listeners) listener()
  }
  function update<K extends keyof DesktopPaneWorkspaceSnapshot>(
    key: K,
    value: SetStateAction<DesktopPaneWorkspaceSnapshot[K]>
  ) {
    if (!alive) return
    const next = typeof value === 'function' ? value(snapshot[key]) : value
    if (next === snapshot[key]) return
    snapshot = { ...snapshot, [key]: next }
    publish()
  }
  return {
    getSnapshot: () => snapshot,
    activate() {
      alive = true
    },
    retire() {
      alive = false
    },
    replaceSnapshot(next: DesktopPaneWorkspaceSnapshot) {
      if (!alive || next === snapshot) return
      snapshot = next
      publish()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    setCentralHarnessStarting: (value: SetStateAction<boolean>) =>
      update('centralHarnessStarting', value),
    setCentralHarnessError: (value: SetStateAction<string | null>) =>
      update('centralHarnessError', value),
    setRightPanelOpen: (value: SetStateAction<DesktopPaneWorkspaceSnapshot['rightPanelOpen']>) =>
      update('rightPanelOpen', value),
    setRightPanelExpanded: (
      value: SetStateAction<DesktopPaneWorkspaceSnapshot['rightPanelExpanded']>
    ) => update('rightPanelExpanded', value),
    setRightPanelView: (value: SetStateAction<DesktopPaneWorkspaceSnapshot['rightPanelView']>) =>
      update('rightPanelView', value),
    setRightPanelTabs: (value: SetStateAction<DesktopPaneWorkspaceSnapshot['rightPanelTabs']>) =>
      update('rightPanelTabs', value),
    setSelectedAssistantPlan: (
      value: SetStateAction<DesktopPaneWorkspaceSnapshot['selectedAssistantPlan']>
    ) => update('selectedAssistantPlan', value),
    setSelectedSubagentConversationId: (
      value: SetStateAction<DesktopPaneWorkspaceSnapshot['selectedSubagentConversationId']>
    ) => update('selectedSubagentConversationId', value),
    setSubagentTranscripts: (
      value: SetStateAction<DesktopPaneWorkspaceSnapshot['subagentTranscripts']>
    ) => update('subagentTranscripts', value),
    setRightPanelExtensionTabs: (
      value: SetStateAction<DesktopPaneWorkspaceSnapshot['rightPanelExtensionTabs']>
    ) => update('rightPanelExtensionTabs', value),
    setTemporaryChatAddresses: (
      value: SetStateAction<DesktopPaneWorkspaceSnapshot['temporaryChatAddresses']>
    ) => update('temporaryChatAddresses', value),
    setSelectedFileWorkspaceTargetKey: (
      value: SetStateAction<DesktopPaneWorkspaceSnapshot['selectedFileWorkspaceTargetKey']>
    ) => update('selectedFileWorkspaceTargetKey', value),
    setSelectedWorkspaceFile: (
      value: SetStateAction<DesktopPaneWorkspaceSnapshot['selectedWorkspaceFile']>
    ) => update('selectedWorkspaceFile', value),
    setFileTabs: (value: SetStateAction<DesktopPaneWorkspaceSnapshot['fileTabs']>) =>
      update('fileTabs', value),
    setReviewState: (value: SetStateAction<DesktopPaneWorkspaceSnapshot['reviewState']>) =>
      update('reviewState', value),
    setFileWorkspaceDirty: (
      value: SetStateAction<DesktopPaneWorkspaceSnapshot['fileWorkspaceDirty']>
    ) => update('fileWorkspaceDirty', value),
    setBrowserStates: (value: SetStateAction<DesktopPaneWorkspaceSnapshot['browserStates']>) =>
      update('browserStates', value),
  }
}
export type DesktopPaneWorkspaceState = ReturnType<typeof createDesktopPaneWorkspaceState>

export function createDesktopPaneWorkspaceStateForPane(
  initialWorkspaceState: WorkbenchPaneWorkspaceState | undefined,
  browserStates: DesktopPaneWorkspaceSnapshot['browserStates']
) {
  return createDesktopPaneWorkspaceState({
    centralHarnessStarting: false,
    centralHarnessError: null,
    rightPanelOpen: initialWorkspaceState?.rightPanelOpen ?? false,
    rightPanelExpanded: initialWorkspaceState?.rightPanelExpanded ?? false,
    rightPanelView: (() => {
      const restoredView = initialWorkspaceState?.rightPanelView ?? 'launcher'
      return normalizeRightWorkspacePanelView(
        restoredView as RightWorkspacePanelView | 'browser' | 'terminal'
      )
    })(),
    rightPanelTabs: (() => {
      const restoredTabs = (initialWorkspaceState?.rightPanelTabs ?? []) as Array<
        RightWorkspacePanelTab | 'browser' | 'terminal'
      >
      return restoredTabs.filter(tab => !isMcpAppPanelTab(tab)).map(normalizeRightWorkspacePanelTab)
    })(),
    selectedAssistantPlan: initialWorkspaceState?.selectedAssistantPlan ?? null,
    selectedSubagentConversationId: null,
    subagentTranscripts: {},
    rightPanelExtensionTabs: initialWorkspaceState?.rightPanelExtensionTabs ?? {},
    temporaryChatAddresses: initialWorkspaceState?.temporaryChatAddresses ?? {},
    selectedFileWorkspaceTargetKey: initialWorkspaceState?.selectedFileWorkspaceTargetKey ?? null,
    selectedWorkspaceFile: initialWorkspaceState?.selectedWorkspaceFile ?? null,
    fileTabs: initialWorkspaceState?.fileTabs ?? {},
    reviewState: initialWorkspaceState?.reviewState ?? {
      loading: false,
      diff: '',
    },
    fileWorkspaceDirty: false,
    browserStates: browserStates,
  })
}
