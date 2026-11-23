import { createDesktopPaneSurfacePort } from './desktopPaneSurfacePort'
import type { DesktopWorkbenchPaneProps } from './desktopWorkbenchMainHelpers'
import { useElementGeometry } from '@wegent/collaboration/dom-events'
import { useCallback, useMemo, useRef, useState } from 'react'
import type { WorkspaceFileOpenRequest } from '@/types/workspace-files'
import {
  type RightWorkspacePanelTab,
  type RightWorkspacePanelHandle,
} from './workspace-panels/RightWorkspacePanel'
import { isRightWorkspaceExtensionTab } from './workspace-panels/rightWorkspaceDshSidebar'
import {
  RIGHT_SPLIT_PANEL_MIN_WIDTH,
  RIGHT_WORKSPACE_COMPACT_PANEL_DEFAULT_WIDTH,
  useResizableRightSplitChat,
} from './workspace-panels/useResizableWorkspacePanel'
import { isDesktopRuntime } from '@/lib/runtime-environment'
import { useWorkbenchPaneEnvironment } from './useWorkbenchPaneEnvironment'
import type { RuntimeTaskAddress } from '@/types/api'
import {
  DOCKED_ENVIRONMENT_INFO_WIDTH,
  MIN_CHAT_COLUMN_WIDTH_FOR_DOCKED_ENVIRONMENT_INFO,
} from './desktopWorkbenchMainHelpers'
import type {
  DesktopPaneWorkspaceState,
  DesktopPaneWorkspaceSnapshot,
} from './desktopPaneWorkspaceState'
import type { Dispatch, SetStateAction } from 'react'
interface Input {
  workbenchVisible: DesktopWorkbenchPaneProps['workbenchVisible']
  sidebarResizing: DesktopWorkbenchPaneProps['sidebarResizing']
  sharedWorkbenchContentWidth: DesktopWorkbenchPaneProps['sharedWorkbenchContentWidth']
  onEnvironmentInfoVisibilityChange: DesktopWorkbenchPaneProps['onEnvironmentInfoVisibilityChange']
  activeLocalHarnessSession: DesktopWorkbenchPaneProps['activeLocalHarnessSession']
  paneActive: boolean
  paneVisible: boolean
  paneId: string
  splitMode: boolean
  environmentInfoPinned: boolean
  environmentInfoOverlayOpen: boolean
  currentRuntimeTask: RuntimeTaskAddress | null
  workItemContextAvailable: boolean
  workspaceProject: ReturnType<typeof useWorkbenchPaneEnvironment>['workspaceProject']
  workspaceTarget: ReturnType<typeof useWorkbenchPaneEnvironment>['workspaceTarget']
  supervisorDialogScopeKey: string
  setSupervisorDialogTaskKey: Dispatch<SetStateAction<string | null>>
  rightPanelOpen: boolean
  rightPanelExpanded: boolean
  rightPanelView: DesktopPaneWorkspaceSnapshot['rightPanelView']
  rightPanelTabs: DesktopPaneWorkspaceSnapshot['rightPanelTabs']
  selectedWorkspaceFile: DesktopPaneWorkspaceSnapshot['selectedWorkspaceFile']
  fileTabs: DesktopPaneWorkspaceSnapshot['fileTabs']
  setRightPanelOpen: DesktopPaneWorkspaceState['setRightPanelOpen']
  setRightPanelExpanded: DesktopPaneWorkspaceState['setRightPanelExpanded']
  openFileRequest: WorkspaceFileOpenRequest | null
}
export function useDesktopPaneLayout({
  workbenchVisible,
  sidebarResizing,
  sharedWorkbenchContentWidth,
  onEnvironmentInfoVisibilityChange,
  activeLocalHarnessSession,
  paneActive,
  paneVisible,
  paneId,
  splitMode,
  environmentInfoPinned,
  environmentInfoOverlayOpen,
  currentRuntimeTask,
  workItemContextAvailable,
  workspaceProject,
  workspaceTarget,
  supervisorDialogScopeKey,
  setSupervisorDialogTaskKey,
  rightPanelOpen,
  rightPanelExpanded,
  rightPanelView,
  rightPanelTabs,
  selectedWorkspaceFile,
  fileTabs,
  setRightPanelOpen,
  setRightPanelExpanded,
  openFileRequest,
}: Input) {
  const rightWorkspacePanelRef = useRef<RightWorkspacePanelHandle>(null)
  const isDesktop = isDesktopRuntime()
  const workbenchMainRef = useRef<HTMLElement | null>(null)
  const workbenchScrollRef = useRef<HTMLDivElement | null>(null)
  const workbenchScrollbarRef = useRef<HTMLDivElement | null>(null)
  const conversationSurfaceRef = useRef<HTMLDivElement | null>(null)
  const workbenchGeometry = useElementGeometry(
    [workbenchMainRef],
    paneActive && paneVisible && workbenchVisible
  )
  const measuredWorkbenchContentWidth = workbenchGeometry?.elements[0]?.width ?? 0
  const restoreSurfaceScope = useMemo(
    () =>
      createDesktopPaneSurfacePort(
        JSON.stringify([paneActive, paneVisible, activeLocalHarnessSession?.sessionId]),
        paneActive && paneVisible
      ),
    [paneActive, paneVisible, activeLocalHarnessSession?.sessionId]
  )
  const setWorkbenchMainRef = useCallback(
    (element: HTMLElement | null) => {
      workbenchMainRef.current = element
      restoreSurfaceScope(element)
    },
    [restoreSurfaceScope]
  )
  const workbenchContentWidth =
    !splitMode && sharedWorkbenchContentWidth > 0
      ? sharedWorkbenchContentWidth
      : measuredWorkbenchContentWidth
  const [environmentInfoPanelElement, setEnvironmentInfoPanelRef] = useState<HTMLElement | null>(
    null
  )
  const closeRightPanel = () => {
    setRightPanelExpanded(false)
    setRightPanelOpen(false)
  }
  const compactRightPanelOpen =
    rightPanelView === 'subagents' || isRightWorkspaceExtensionTab(rightPanelView)
  const {
    width: rightSplitChatWidth,
    resizing: rightSplitResizing,
    handleResizeStart: handleRightSplitResizeStart,
  } = useResizableRightSplitChat({
    containerRef: workbenchMainRef,
    onCollapse: closeRightPanel,
    defaultPanelWidth: compactRightPanelOpen
      ? RIGHT_WORKSPACE_COMPACT_PANEL_DEFAULT_WIDTH
      : undefined,
  })
  const rightPanelTransitionDisabled = splitMode || rightSplitResizing
  const chatColumnWidth = rightPanelOpen && !rightPanelExpanded ? rightSplitChatWidth : '100%'
  const chatColumnMaxWidth =
    rightPanelOpen && !rightPanelExpanded ? `calc(100% - ${RIGHT_SPLIT_PANEL_MIN_WIDTH}px)` : '100%'
  const availableChatColumnWidth = rightPanelOpen ? rightSplitChatWidth : workbenchContentWidth
  const environmentInfoDocked =
    Boolean(currentRuntimeTask) &&
    availableChatColumnWidth - DOCKED_ENVIRONMENT_INFO_WIDTH >=
      MIN_CHAT_COLUMN_WIDTH_FOR_DOCKED_ENVIRONMENT_INFO
  const environmentInfoOpen = environmentInfoDocked
    ? environmentInfoPinned
    : environmentInfoOverlayOpen
  const environmentInfoPanelExpanded = environmentInfoDocked && environmentInfoOpen
  const setEnvironmentInfoOpen = useCallback(
    (open: boolean) => {
      if (environmentInfoDocked) {
        onEnvironmentInfoVisibilityChange(paneId, { pinned: open })
        return
      }
      onEnvironmentInfoVisibilityChange(paneId, { overlayOpen: open })
    },
    [environmentInfoDocked, onEnvironmentInfoVisibilityChange, paneId]
  )
  const openSupervisorDialog = useCallback(() => {
    setSupervisorDialogTaskKey(supervisorDialogScopeKey)
    if (!environmentInfoDocked) {
      onEnvironmentInfoVisibilityChange(paneId, { overlayOpen: false })
    }
  }, [
    environmentInfoDocked,
    onEnvironmentInfoVisibilityChange,
    paneId,
    setSupervisorDialogTaskKey,
    supervisorDialogScopeKey,
  ])
  const paneTitleWidth = rightPanelOpen ? chatColumnWidth : '100%'
  const rightPanelWidth = rightPanelExpanded ? '100%' : `calc(100% - ${rightSplitChatWidth}px)`
  const rightPanelShellWidth = rightPanelOpen ? rightPanelWidth : '0px'
  const rightTitlebarActionsWidth = rightPanelOpen ? '7rem' : '5rem'
  const rightPanelTabBarWidth = rightPanelOpen
    ? `calc(${rightPanelWidth} - ${rightTitlebarActionsWidth})`
    : '0px'
  const temporaryChatAvailable = !activeLocalHarnessSession
  const canBrowseFiles = Boolean(
    workspaceProject ||
    workspaceTarget ||
    selectedWorkspaceFile?.target ||
    openFileRequest?.target ||
    openFileRequest?.attachment ||
    Object.keys(fileTabs).length
  )
  const effectiveRightPanelTabs = useMemo<RightWorkspacePanelTab[]>(() => {
    const availableContextTabs = workItemContextAvailable
      ? rightPanelTabs
      : rightPanelTabs.filter(tab => tab !== 'work-item')
    const workspaceTabs = canBrowseFiles
      ? availableContextTabs
      : availableContextTabs.filter(tab => tab !== 'files')
    const permittedTabs = temporaryChatAvailable
      ? workspaceTabs
      : workspaceTabs.filter(tab => !tab.startsWith('chat:'))
    if (
      rightPanelView === 'launcher' ||
      (!canBrowseFiles && rightPanelView === 'files') ||
      (!temporaryChatAvailable && rightPanelView.startsWith('chat:'))
    ) {
      return permittedTabs
    }
    return permittedTabs.includes(rightPanelView)
      ? permittedTabs
      : [...permittedTabs, rightPanelView]
  }, [
    canBrowseFiles,
    rightPanelTabs,
    rightPanelView,
    temporaryChatAvailable,
    workItemContextAvailable,
  ])
  const effectiveRightPanelView =
    (!temporaryChatAvailable && rightPanelView.startsWith('chat:')) ||
    (!workItemContextAvailable && rightPanelView === 'work-item')
      ? 'launcher'
      : rightPanelView
  const temporaryChatExpanded =
    temporaryChatAvailable && rightPanelExpanded && rightPanelView.startsWith('chat:')
  const shouldRenderRightPanel = rightPanelOpen || effectiveRightPanelTabs.length > 0
  const chatContentResizing = sidebarResizing || rightSplitResizing
  return {
    rightWorkspacePanelRef,
    isDesktop,
    workbenchScrollRef,
    workbenchScrollbarRef,
    conversationSurfaceRef,
    setWorkbenchMainRef,
    environmentInfoPanelElement,
    setEnvironmentInfoPanelRef,
    handleRightSplitResizeStart,
    rightPanelTransitionDisabled,
    chatColumnWidth,
    chatColumnMaxWidth,
    environmentInfoDocked,
    environmentInfoOpen,
    environmentInfoPanelExpanded,
    setEnvironmentInfoOpen,
    openSupervisorDialog,
    paneTitleWidth,
    rightPanelShellWidth,
    rightTitlebarActionsWidth,
    rightPanelTabBarWidth,
    temporaryChatAvailable,
    canBrowseFiles,
    effectiveRightPanelTabs,
    effectiveRightPanelView,
    temporaryChatExpanded,
    shouldRenderRightPanel,
    chatContentResizing,
  }
}
